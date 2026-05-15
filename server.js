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
  maxHttpBufferSize: 1e5,
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomId() {
  return crypto.randomBytes(8).toString('hex');
}

function sanitizeText(input, maxLen) {
  if (typeof input !== 'string') return '';
  let s = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) {
      s += input[i];
    }
  }
  s = s.trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { messages: [], users: new Map(), lastActivity: Date.now() };
    rooms.set(roomId, room);
  }
  return room;
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
    room.users.set(socket.id, username);
    room.lastActivity = Date.now();
    socket.join(roomId);

    cb({
      ok: true,
      messages: room.messages,
      users: Array.from(room.users.values()),
    });

    socket.to(roomId).emit('user-joined', { user: username });
    io.to(roomId).emit('users', Array.from(room.users.values()));
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

  socket.on('typing', (isTyping) => {
    if (!joinedRoom || !username) return;
    socket.to(joinedRoom).emit('typing', { user: username, isTyping: !!isTyping });
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.users.delete(socket.id);
    room.lastActivity = Date.now();
    socket.to(joinedRoom).emit('user-left', { user: username });
    io.to(joinedRoom).emit('users', Array.from(room.users.values()));
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
