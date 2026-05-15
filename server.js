const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MESSAGE_TTL_MS = parseInt(process.env.MESSAGE_TTL_MS, 10) || 6 * 60 * 60 * 1000;
const ROOM_INACTIVITY_MS = parseInt(process.env.ROOM_INACTIVITY_MS, 10) || 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH, 10) || 1000;
const MAX_USERNAME_LENGTH = 24;
const MAX_MESSAGES_PER_ROOM = parseInt(process.env.MAX_MESSAGES_PER_ROOM, 10) || 500;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 15e6, // 15 MB — covers compressed images + short videos
});

app.use(express.static(path.join(__dirname, 'public')));

// rooms: Map<roomId, {
//   messages: [{id, user, text, ts}],
//   users: Map<socketId, username>,
//   readTimestamps: Map<socketId, {username, ts}>,  ← read receipts
//   lastActivity: number
// }>
const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  let s = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) s += input[i];
  }
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      messages: [],
      users: new Map(),
      readTimestamps: new Map(),
      ownerSocketId: null,   // first joiner becomes owner
      lastActivity: Date.now(),
    };
    rooms.set(roomId, room);
  }
  return room;
}

function serializeReads(room) {
  // Returns array of {username, ts} for all connected users
  return Array.from(room.readTimestamps.values());
}

app.post('/api/rooms', (req, res) => {
  const roomId = generateRoomId();
  getOrCreateRoom(roomId);
  res.json({ roomId });
});

app.get('/api/rooms/:roomId/exists', (req, res) => {
  const { roomId } = req.params;
  if (!/^[a-f0-9]{16}$/.test(roomId)) return res.json({ exists: false });
  res.json({ exists: rooms.has(roomId) });
});

app.get('/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  if (!/^[a-f0-9]{16}$/.test(roomId)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

io.on('connection', (socket) => {
  let joinedRoom = null;
  let username = null;

  socket.on('join', (payload, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const { roomId, name } = payload || {};
    if (!/^[a-f0-9]{16}$/.test(roomId || '')) return cb({ ok: false, error: 'Invalid room' });
    const cleanName = sanitizeText(name, MAX_USERNAME_LENGTH);
    if (!cleanName) return cb({ ok: false, error: 'Invalid username' });

    const room = getOrCreateRoom(roomId);
    joinedRoom = roomId;
    username = cleanName;
    // First person to join owns the room
    if (!room.ownerSocketId) room.ownerSocketId = socket.id;
    const isOwner = room.ownerSocketId === socket.id;
    room.users.set(socket.id, username);
    room.readTimestamps.set(socket.id, { username, ts: Date.now() });
    room.lastActivity = Date.now();
    socket.join(roomId);

    cb({
      ok: true,
      messages: room.messages,
      users: Array.from(room.users.values()),
      reads: serializeReads(room),
      isOwner,
    });

    socket.to(roomId).emit('user-joined', { user: username });
    io.to(roomId).emit('users', Array.from(room.users.values()));
    io.to(roomId).emit('read-update', serializeReads(room));
  });

  socket.on('message', (text) => {
    if (!joinedRoom || !username) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const clean = sanitizeText(text, MAX_MESSAGE_LENGTH);
    if (!clean) return;

    const msg = {
      id: crypto.randomBytes(6).toString('hex'),
      user: username,
      text: clean,
      ts: Date.now(),
    };
    room.messages.push(msg);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    }
    room.lastActivity = Date.now();
    io.to(joinedRoom).emit('message', msg);
  });

  // Images and short videos
  socket.on('media', (payload) => {
    if (!joinedRoom || !username) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    if (!payload || typeof payload.data !== 'string') return;

    const isImage = payload.mediaType === 'image';
    const isVideo = payload.mediaType === 'video';
    if (!isImage && !isVideo) return;

    const MAX_BYTES = isImage ? 3_500_000 : 10_000_000; // base64 chars ≈ bytes
    if (payload.data.length > MAX_BYTES) return;

    const mimeType = typeof payload.mimeType === 'string'
      ? payload.mimeType.slice(0, 60) : 'application/octet-stream';

    const msg = {
      id: crypto.randomBytes(6).toString('hex'),
      user: username,
      type: payload.mediaType,
      data: payload.data,
      mimeType,
      ts: Date.now(),
    };
    if (isVideo && typeof payload.duration === 'number') {
      msg.duration = Math.min(Math.max(payload.duration, 0), 60);
    }
    room.messages.push(msg);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    }
    room.lastActivity = Date.now();
    io.to(joinedRoom).emit('message', msg);
  });

  socket.on('voice', (payload) => {
    if (!joinedRoom || !username) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    if (!payload || typeof payload.audio !== 'string') return;
    // base64 audio — cap at ~6 MB encoded (~4.5 MB raw, ~2 min at 32 kbps)
    if (payload.audio.length > 6_000_000) return;
    const duration = typeof payload.duration === 'number'
      ? Math.min(Math.max(payload.duration, 0), 300)
      : 0;
    const mimeType = typeof payload.mimeType === 'string'
      ? payload.mimeType.slice(0, 60)
      : 'audio/webm';
    const msg = {
      id: crypto.randomBytes(6).toString('hex'),
      user: username,
      type: 'voice',
      audio: payload.audio,
      mimeType,
      duration,
      ts: Date.now(),
    };
    room.messages.push(msg);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.splice(0, room.messages.length - MAX_MESSAGES_PER_ROOM);
    }
    room.lastActivity = Date.now();
    io.to(joinedRoom).emit('message', msg);
  });

  // Client emits this when the window is focused / user is actively reading
  socket.on('read', (ts) => {
    if (!joinedRoom || !username) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const readTs = typeof ts === 'number' ? ts : Date.now();
    room.readTimestamps.set(socket.id, { username, ts: readTs });
    // Broadcast updated read state to everyone in the room
    io.to(joinedRoom).emit('read-update', serializeReads(room));
  });

  socket.on('typing', (isTyping) => {
    if (!joinedRoom || !username) return;
    socket.to(joinedRoom).emit('typing', { user: username, isTyping: !!isTyping });
  });

  socket.on('edit-msg', ({ msgId, text }) => {
    if (!joinedRoom || !username) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const msg = room.messages.find((m) => m.id === msgId && m.user === username && m.type == null);
    if (!msg) return;
    const clean = sanitizeText(text, MAX_MESSAGE_LENGTH);
    if (!clean) return;
    msg.text   = clean;
    msg.edited = true;
    io.to(joinedRoom).emit('msg-edited', { msgId, text: clean });
  });

  socket.on('delete-msg', ({ msgId }) => {
    if (!joinedRoom || !username) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const idx = room.messages.findIndex((m) => m.id === msgId && m.user === username);
    if (idx === -1) return;
    // Replace with tombstone so late joiners also see the ghost
    const { ts } = room.messages[idx];
    room.messages[idx] = { id: msgId, user: username, type: 'deleted', ts };
    io.to(joinedRoom).emit('msg-deleted', { msgId });
  });

  // Only the room owner can burn
  socket.on('burn', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || room.ownerSocketId !== socket.id) return;
    room.messages = [];
    room.lastActivity = Date.now();
    // Tell everyone — they play the animation then wipe their UI
    io.to(joinedRoom).emit('burned', { by: username });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.users.delete(socket.id);
    room.readTimestamps.delete(socket.id);
    room.lastActivity = Date.now();

    // Transfer ownership so burn is never lost
    if (room.ownerSocketId === socket.id) {
      if (room.users.size > 0) {
        const nextId = room.users.keys().next().value;
        room.ownerSocketId = nextId;
        io.to(nextId).emit('you-are-owner');
      } else {
        // Room empty — next joiner gets it via the join handler
        room.ownerSocketId = null;
      }
    }

    socket.to(joinedRoom).emit('user-left', { user: username });
    io.to(joinedRoom).emit('users', Array.from(room.users.values()));
    io.to(joinedRoom).emit('read-update', serializeReads(room));
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    room.messages = room.messages.filter((m) => now - m.ts < MESSAGE_TTL_MS);
    if (room.users.size === 0 && now - room.lastActivity > ROOM_INACTIVITY_MS) {
      rooms.delete(roomId);
    }
  }
}, CLEANUP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Ephemeral chat listening on port ${PORT}`);
});
