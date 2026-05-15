(() => {
  const roomId = location.pathname.split('/').pop();

  // ── DOM refs ─────────────────────────────────────────────
  const nameModal    = document.getElementById('nameModal');
  const nameInput    = document.getElementById('nameInput');
  const joinBtn      = document.getElementById('joinBtn');
  const nameError    = document.getElementById('nameError');
  const app          = document.getElementById('app');
  const messages     = document.getElementById('messages');
  const composer     = document.getElementById('composer');
  const msgInput     = document.getElementById('msgInput');
  const sendBtn      = document.getElementById('sendBtn');
  const inputWrap    = document.getElementById('inputWrap');
  const recordingBar = document.getElementById('recordingBar');
  const recTimer     = document.getElementById('recTimer');
  const recCancelBtn = document.getElementById('recCancelBtn');
  const micBtn       = document.getElementById('micBtn');
  const attachBtn    = document.getElementById('attachBtn');
  const attachMenu   = document.getElementById('attachMenu');
  const attachPhoto  = document.getElementById('attachPhoto');
  const attachVideo  = document.getElementById('attachVideo');
  const photoInput   = document.getElementById('photoInput');
  const videoInput   = document.getElementById('videoInput');
  const copyBtn      = document.getElementById('copyBtn');
  const usersBtn     = document.getElementById('usersBtn');
  const usersPanel   = document.getElementById('usersPanel');
  const userList     = document.getElementById('userList');
  const userCount    = document.getElementById('userCount');
  const roomIdLabel  = document.getElementById('roomIdLabel');
  const typingDots   = document.getElementById('typingDots');
  const typingText   = document.getElementById('typingText');
  const burnBtn      = document.getElementById('burnBtn');

  // ── State ─────────────────────────────────────────────────
  let socket       = null;
  let myName       = null;
  let amOwner      = false;
  let allUsers     = [];
  let readMap      = {};
  const typingUsers = new Set();
  let typingTimeout = null;
  let isTypingSent  = false;
  let lastMsgUser   = null;
  let lastMsgTime   = 0;
  const msgNodes    = new Map();

  roomIdLabel.textContent = roomId.slice(0, 8) + '…';
  const savedName = sessionStorage.getItem('chat-name-' + roomId);
  if (savedName) {
    nameInput.value = savedName;
    // Auto-rejoin on refresh — skip the modal entirely
    tryJoin();
  }

  // ── Keyboard / viewport fix ───────────────────────────────
  // On mobile the OS keyboard shrinks visualViewport but not window.
  // We track it and push the fixed app container up so the composer
  // always sits just above the keyboard.
  function applyViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    // vv.offsetTop > 0 when the page is scrolled (e.g. iOS Safari)
    app.style.top    = vv.offsetTop + 'px';
    app.style.height = vv.height    + 'px';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', applyViewport);
    window.visualViewport.addEventListener('scroll', applyViewport);
  }

  // ── Audio context ─────────────────────────────────────────
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  document.addEventListener('touchstart', ensureAudio, { once: true, passive: true });
  document.addEventListener('click',      ensureAudio, { once: true });

  function playNotification() {
    try {
      ensureAudio();
      [1046.5, 1318.5].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const t = audioCtx.currentTime + i * 0.09;
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.18, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        osc.start(t); osc.stop(t + 0.3);
      });
    } catch (_) {}
  }

  function playBurnSound() {
    try {
      ensureAudio();
      const buf  = audioCtx.createBuffer(1, audioCtx.sampleRate * 1.2, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 1.2);
      }
      const src    = audioCtx.createBufferSource();
      const filter = audioCtx.createBiquadFilter();
      const gain   = audioCtx.createGain();
      src.buffer = buf;
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(500, audioCtx.currentTime);
      filter.frequency.linearRampToValueAtTime(60, audioCtx.currentTime + 1.2);
      gain.gain.setValueAtTime(0.55, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.2);
      src.connect(filter); filter.connect(gain); gain.connect(audioCtx.destination);
      src.start();
      [0, 0.08, 0.2, 0.38, 0.6, 0.9].forEach((t) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        const st = audioCtx.currentTime + t;
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(60 + Math.random() * 100, st);
        g.gain.setValueAtTime(0.14, st);
        g.gain.exponentialRampToValueAtTime(0.001, st + 0.1);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(st); o.stop(st + 0.11);
      });
    } catch (_) {}
  }

  // ── Send button ────────────────────────────────────────────
  msgInput.addEventListener('input', () => {
    sendBtn.disabled = msgInput.value.trim() === '';
  });

  function showError(msg) { nameError.textContent = msg || ''; }

  // ── Join ──────────────────────────────────────────────────
  function tryJoin() {
    const name = nameInput.value.trim();
    if (!name)         { showError('Please enter a name'); return; }
    if (name.length > 24) { showError('Name too long'); return; }
    showError('');
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';

    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('join', { roomId, name }, (res) => {
        if (!res?.ok) {
          showError(res?.error || 'Failed to join');
          joinBtn.disabled = false;
          joinBtn.textContent = 'Enter the room →';
          socket.disconnect();
          return;
        }
        myName  = name;
        amOwner = !!res.isOwner;
        sessionStorage.setItem('chat-name-' + roomId, name);
        nameModal.classList.add('hidden');
        app.classList.remove('hidden');
        if (amOwner) burnBtn.classList.remove('hidden');
        msgInput.focus();
        updateReadMap(res.reads || []);
        renderUsers(res.users || []);
        for (const m of res.messages) addMessage(m, false);
        scrollToBottom();
        emitRead();
      });
    });

    socket.on('connect_error', () => {
      showError('Connection failed — retrying…');
      joinBtn.disabled = false;
      joinBtn.textContent = 'Enter the room →';
    });

    socket.on('message', (m) => {
      const atBottom = isAtBottom();
      addMessage(m, true);
      if (atBottom) scrollToBottom();
      if (m.user !== myName) playNotification();
      if (document.hasFocus()) emitRead();
    });

    socket.on('users', renderUsers);
    socket.on('user-joined', ({ user }) => addSystem(`${user} joined`));
    socket.on('user-left',   ({ user }) => {
      typingUsers.delete(user); renderTyping(); addSystem(`${user} left`);
    });
    socket.on('read-update', (reads) => { updateReadMap(reads); refreshAllTicks(); });
    socket.on('typing', ({ user, isTyping }) => {
      if (isTyping) typingUsers.add(user); else typingUsers.delete(user);
      renderTyping();
    });
    socket.on('disconnect', () => addSystem('Connection lost. Reconnecting…'));
    socket.on('reconnect',  () => addSystem('Reconnected.'));
    socket.on('burned',     ({ by }) => playBurnAnimation(by));
    socket.on('you-are-owner', () => { amOwner = true; burnBtn.classList.remove('hidden'); });

    socket.on('msg-edited', ({ msgId, text }) => {
      const node = msgNodes.get(msgId);
      if (!node) return;
      const m = node._msgData;
      if (m) { m.text = text; m.edited = true; }
      applyEditedText(node, text);
    });

    socket.on('msg-deleted', ({ msgId }) => {
      const node = msgNodes.get(msgId);
      if (node) { node.remove(); msgNodes.delete(msgId); }
    });
  }

  joinBtn.addEventListener('click', tryJoin);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryJoin(); } });

  // ── Text send ─────────────────────────────────────────────
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text || !socket) return;
    socket.emit('message', text.slice(0, 1000));
    msgInput.value = '';
    sendBtn.disabled = true;
    sendTyping(false);
    msgInput.focus();
  });

  msgInput.addEventListener('input', () => {
    if (!socket) return;
    if (msgInput.value.trim()) {
      sendTyping(true);
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => sendTyping(false), 1800);
    } else {
      sendTyping(false);
    }
  });

  function sendTyping(state) {
    if (!socket || state === isTypingSent) return;
    isTypingSent = state;
    socket.emit('typing', state);
  }

  // ── Read receipts ─────────────────────────────────────────
  function emitRead() { if (socket) socket.emit('read', Date.now()); }
  function updateReadMap(reads) {
    for (const { username, ts } of reads) {
      if (!readMap[username] || ts > readMap[username]) readMap[username] = ts;
    }
  }
  function tickState(msg) {
    if (msg.user !== myName) return null;
    const others = allUsers.filter((u) => u !== myName);
    if (!others.length) return 'delivered';
    return others.some((u) => readMap[u] && readMap[u] >= msg.ts) ? 'read' : 'delivered';
  }
  function renderTicks(state) {
    const wrap = document.createElement('span');
    wrap.className = 'ticks' + (state === 'read' ? ' read' : '');
    wrap.innerHTML = state === 'sent'
      ? '<span class="tick">✓</span>'
      : '<span class="tick">✓</span><span class="tick">✓</span>';
    return wrap;
  }
  function refreshAllTicks() {
    for (const [, node] of msgNodes) {
      const m = node._msgData;
      if (!m || m.user !== myName) continue;
      const container = node.querySelector('.ticks');
      if (!container) continue;
      const next = renderTicks(tickState(m));
      if (container.className !== next.className) container.replaceWith(next);
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && socket) emitRead(); });
  window.addEventListener('focus', () => { if (socket) emitRead(); });
  messages.addEventListener('scroll', () => { if (isAtBottom() && socket) emitRead(); });

  // ── Render messages ───────────────────────────────────────
  function addMessage(m, animate) {
    const GAP    = 90_000;
    const isSelf = m.user === myName;
    const grouped = m.user === lastMsgUser && (m.ts - lastMsgTime) < GAP;
    lastMsgUser = m.user; lastMsgTime = m.ts;

    const row = document.createElement('div');
    row.className = 'msg ' + (isSelf ? 'self' : 'other') + (grouped ? ' same-sender' : '');
    if (!animate) row.style.animation = 'none';
    row._msgData = m;
    msgNodes.set(m.id, row);

    // Text messages: tap to reveal edit + delete action pill
    if (isSelf && m.type == null) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button, a, .edit-form')) return;
        if (row.classList.contains('editing')) return;
        toggleMsgActions(row, m);
      });
    }

    if (!grouped) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (!isSelf) {
        const ns = document.createElement('strong'); ns.textContent = m.user;
        meta.appendChild(ns);
        meta.appendChild(document.createTextNode(' · ' + time));
      } else {
        meta.textContent = time;
      }
      row.appendChild(meta);
    }

    if      (m.type === 'voice') row.appendChild(buildVoiceBubble(m, isSelf));
    else if (m.type === 'image') row.appendChild(buildImageBubble(m, isSelf));
    else if (m.type === 'video') row.appendChild(buildVideoBubble(m, isSelf));
    else {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.text;
      if (isSelf) bubble.appendChild(renderTicks(tickState(m)));
      row.appendChild(bubble);
    }

    messages.appendChild(row);
  }

  // ── Message actions ───────────────────────────────────────
  let activeActionRow = null;

  function toggleMsgActions(row, m) {
    // Dismiss if tapping the already-open row
    if (activeActionRow === row) { dismissActions(); return; }
    dismissActions();
    activeActionRow = row;

    const bar = document.createElement('div');
    bar.className = 'msg-actions';

    // Flip below if the row is near the top of the scroll area
    const rowTop = row.getBoundingClientRect().top;
    if (rowTop < 80) bar.classList.add('below');

    // Edit — only for text messages
    if (m.type == null) {
      const editBtn = document.createElement('button');
      editBtn.className = 'msg-action-btn'; editBtn.title = 'Edit';
      editBtn.textContent = '✏️';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissActions();
        startEdit(row, m);
      });
      bar.appendChild(editBtn);
    }

    // Delete — all own message types
    const delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn delete'; delBtn.title = 'Delete';
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissActions();
      confirmDelete(m.id);
    });
    bar.appendChild(delBtn);

    row.appendChild(bar);
  }

  function dismissActions() {
    if (!activeActionRow) return;
    activeActionRow.querySelector('.msg-actions')?.remove();
    activeActionRow = null;
  }

  // Dismiss on tap outside any message
  messages.addEventListener('click', (e) => {
    if (!e.target.closest('.msg')) dismissActions();
  });

  // ── Inline edit ───────────────────────────────────────────
  function startEdit(row, m) {
    row.classList.add('editing');

    const form = document.createElement('div');
    form.className = 'edit-form';

    const ta = document.createElement('textarea');
    ta.className = 'edit-textarea';
    ta.value = m.text;
    ta.rows = 1;

    const acts = document.createElement('div');
    acts.className = 'edit-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn'; cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => cancelEdit(row));

    const saveBtn = document.createElement('button');
    saveBtn.className = 'edit-save-btn'; saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const text = ta.value.trim();
      if (!text || text === m.text) { cancelEdit(row); return; }
      if (socket) socket.emit('edit-msg', { msgId: m.id, text });
      // Optimistic update
      m.text = text; m.edited = true;
      applyEditedText(row, text);
      cancelEdit(row);
    });

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') cancelEdit(row);
    });

    acts.appendChild(cancelBtn); acts.appendChild(saveBtn);
    form.appendChild(ta); form.appendChild(acts);
    row.appendChild(form);

    // Focus and place cursor at end
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function cancelEdit(row) {
    row.classList.remove('editing');
    row.querySelector('.edit-form')?.remove();
  }

  function applyEditedText(row, text) {
    const bubble = row.querySelector('.bubble');
    if (!bubble) return;
    // Replace text node content
    const tn = bubble.childNodes[0];
    if (tn && tn.nodeType === Node.TEXT_NODE) tn.textContent = text;
    else bubble.insertBefore(document.createTextNode(text), bubble.firstChild);
    // Add "(edited)" label if not already there
    if (!bubble.querySelector('.edited-label')) {
      const label = document.createElement('span');
      label.className = 'edited-label'; label.textContent = 'edited';
      // Insert before ticks
      const ticks = bubble.querySelector('.ticks');
      if (ticks) bubble.insertBefore(label, ticks);
      else bubble.appendChild(label);
    }
  }

  // ── Delete confirmation ───────────────────────────────────
  function confirmDelete(msgId) {
    const overlay = document.createElement('div');
    overlay.className = 'burn-confirm'; // reuse the bottom-sheet style
    overlay.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="burn-sheet">
        <h3>Delete message?</h3>
        <p>This message will be removed for everyone in the room.</p>
        <div class="burn-actions">
          <button class="btn-cancel" id="dCancelBtn">Cancel</button>
          <button class="delete-confirm-btn" id="dConfirmBtn">Delete</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#dCancelBtn').addEventListener('click',     () => overlay.remove());
    overlay.querySelector('.modal-backdrop').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#dConfirmBtn').addEventListener('click', () => {
      overlay.remove();
      if (socket) socket.emit('delete-msg', { msgId });
      // Optimistic: remove from DOM immediately
      const node = msgNodes.get(msgId);
      if (node) { node.remove(); msgNodes.delete(msgId); }
    });
  }

  function addSystem(text) {
    const row = document.createElement('div');
    row.className = 'msg system';
    const b = document.createElement('div');
    b.className = 'bubble'; b.textContent = text;
    row.appendChild(b); messages.appendChild(b);
    if (isAtBottom()) scrollToBottom();
  }

  // ── Media delete button (voice / image / video) ──────────
  function makeMediaDeleteBtn(msgId) {
    const btn = document.createElement('button');
    btn.className = 'media-delete-btn';
    btn.type = 'button';
    btn.title = 'Delete';
    btn.textContent = '🗑️';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDelete(msgId);
    });
    return btn;
  }

  // ── Voice bubble (real waveform) ──────────────────────────
  const BAR_COUNT = 30;

  function buildVoiceBubble(m, isSelf) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble voice-bubble';

    const playBtn = document.createElement('button');
    playBtn.className = 'voice-play-btn'; playBtn.type = 'button'; playBtn.textContent = '▶';

    // Waveform — use real amplitude data if present, else flat fallback
    const waveform = document.createElement('div');
    waveform.className = 'voice-waveform';
    const amplitudes = Array.isArray(m.waveform) && m.waveform.length
      ? normaliseWaveform(m.waveform, BAR_COUNT)
      : flatFallback(m.id, BAR_COUNT);

    const bars = amplitudes.map((amp) => {
      const bar = document.createElement('span');
      bar.style.height = Math.max(3, Math.round(amp * 28)) + 'px';
      waveform.appendChild(bar);
      return bar;
    });

    const dur = document.createElement('span');
    dur.className = 'voice-duration';
    dur.textContent = formatDur(m.duration || 0);

    // Playback
    let audioEl = null, isPlaying = false, ticker = null;
    try {
      const blob = b64ToBlob(m.audio, m.mimeType || 'audio/webm');
      audioEl = new Audio(URL.createObjectURL(blob));

      audioEl.addEventListener('ended', () => {
        isPlaying = false; playBtn.textContent = '▶';
        waveform.classList.remove('playing');
        bars.forEach((b) => b.classList.remove('played', 'active'));
        dur.textContent = formatDur(m.duration || 0);
        clearInterval(ticker);
      });

      playBtn.addEventListener('click', () => {
        if (isPlaying) {
          audioEl.pause(); isPlaying = false;
          playBtn.textContent = '▶'; waveform.classList.remove('playing');
          clearInterval(ticker);
        } else {
          audioEl.currentTime = 0; audioEl.play().catch(() => {});
          isPlaying = true; playBtn.textContent = '⏸';
          waveform.classList.add('playing');
          bars.forEach((b) => b.classList.remove('played', 'active'));
          const total = m.duration || 1;
          ticker = setInterval(() => {
            const p = audioEl.currentTime / total;
            const activeIdx = Math.floor(p * bars.length);
            bars.forEach((b, i) => {
              b.classList.toggle('played', i < activeIdx);
              b.classList.toggle('active', i === activeIdx);
            });
            dur.textContent = formatDur(audioEl.currentTime);
          }, 80);
        }
      });
    } catch (_) { playBtn.disabled = true; playBtn.textContent = '✕'; }

    bubble.appendChild(playBtn);
    bubble.appendChild(waveform);
    bubble.appendChild(dur);
    if (isSelf) {
      bubble.appendChild(renderTicks(tickState(m)));
      bubble.appendChild(makeMediaDeleteBtn(m.id));
    }
    return bubble;
  }

  function normaliseWaveform(raw, count) {
    // Downsample or upsample to exactly `count` bars, normalise 0–1
    const max = Math.max(...raw, 0.001);
    const out = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.floor((i / count) * raw.length);
      out.push((raw[idx] || 0) / max);
    }
    return out;
  }

  // Deterministic-looking fallback when no waveform data
  function flatFallback(id, count) {
    const seed = parseInt((id || '0').slice(0, 4), 16) || 1;
    return Array.from({ length: count }, (_, i) => {
      const h = (seed * (i + 7) * 2654435761) >>> 0;
      return 0.15 + (h % 1000) / 1000 * 0.75;
    });
  }

  // ── Image bubble ──────────────────────────────────────────
  function buildImageBubble(m, isSelf) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble media-bubble';

    // blob: URL instead of data: URI — browser can GC under memory pressure
    const blobUrl = URL.createObjectURL(b64ToBlob(m.data, m.mimeType));

    const img = document.createElement('img');
    img.alt = 'photo';
    img.src = blobUrl;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(blobUrl));
    wrap.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeSpan = document.createElement('span'); timeSpan.textContent = time;
    meta.appendChild(timeSpan);
    if (isSelf) {
      meta.appendChild(renderTicks(tickState(m)));
      meta.appendChild(makeMediaDeleteBtn(m.id));
    }
    wrap.appendChild(meta);
    return wrap;
  }

  // ── Video bubble ──────────────────────────────────────────
  function buildVideoBubble(m, isSelf) {
    const wrap = document.createElement('div');
    wrap.className = 'bubble media-bubble';

    const videoWrap = document.createElement('div');
    videoWrap.className = 'video-wrap';

    const video = document.createElement('video');
    video.src = URL.createObjectURL(b64ToBlob(m.data, m.mimeType));
    video.playsInline = true;
    video.loop = false;
    video.muted = false;
    video.preload = 'metadata';

    const overlay = document.createElement('div');
    overlay.className = 'video-play-overlay';
    overlay.innerHTML = '<div class="play-circle">▶</div>';

    overlay.addEventListener('click', () => {
      if (video.paused) {
        video.play().catch(() => {});
        videoWrap.classList.add('playing');
      } else {
        video.pause();
        videoWrap.classList.remove('playing');
      }
    });
    video.addEventListener('ended', () => videoWrap.classList.remove('playing'));
    video.addEventListener('pause', () => videoWrap.classList.remove('playing'));

    videoWrap.appendChild(video);
    videoWrap.appendChild(overlay);
    wrap.appendChild(videoWrap);

    const meta = document.createElement('div');
    meta.className = 'media-meta';
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timeSpan = document.createElement('span'); timeSpan.textContent = time;
    if (m.duration) {
      const ds = document.createElement('span'); ds.textContent = formatDur(m.duration);
      meta.appendChild(ds);
    }
    meta.appendChild(timeSpan);
    if (isSelf) {
      meta.appendChild(renderTicks(tickState(m)));
      meta.appendChild(makeMediaDeleteBtn(m.id));
    }
    wrap.appendChild(meta);
    return wrap;
  }

  // ── Lightbox ──────────────────────────────────────────────
  function openLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    const img = document.createElement('img'); img.src = src;
    const close = document.createElement('button');
    close.className = 'lightbox-close'; close.textContent = '✕';
    const dismiss = () => lb.remove();
    lb.addEventListener('click', dismiss);
    close.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
    img.addEventListener('click', (e) => e.stopPropagation());
    lb.appendChild(img); lb.appendChild(close);
    document.body.appendChild(lb);
  }

  // ── Attach menu ───────────────────────────────────────────
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachMenu.classList.toggle('hidden');
    attachBtn.classList.toggle('open');
  });
  document.addEventListener('click', () => {
    if (!attachMenu.classList.contains('hidden')) {
      attachMenu.classList.add('hidden');
      attachBtn.classList.remove('open');
    }
  });

  attachPhoto.addEventListener('click', () => { photoInput.click(); closeAttachMenu(); });
  attachVideo.addEventListener('click', () => { videoInput.click(); closeAttachMenu(); });
  function closeAttachMenu() {
    attachMenu.classList.add('hidden'); attachBtn.classList.remove('open');
  }

  // ── Image upload ──────────────────────────────────────────
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0]; photoInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Not an image'); return; }

    const pill = showProgress('Compressing…');
    try {
      const { b64, mimeType } = await compressImage(file, 960, 0.72);
      pill.remove();
      if (socket) socket.emit('media', { mediaType: 'image', data: b64, mimeType });
    } catch (_) { pill.remove(); toast('Failed to process image'); }
  });

  async function compressImage(file, maxPx, quality) {
    const bitmap = await createImageBitmap(file);
    let { width: w, height: h } = bitmap;
    if (w > maxPx || h > maxPx) {
      const r = Math.min(maxPx / w, maxPx / h);
      w = Math.round(w * r); h = Math.round(h * r);
    }
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('toBlob failed')); return; }
        const reader = new FileReader();
        reader.onloadend = () => resolve({ b64: reader.result.split(',')[1], mimeType: 'image/jpeg' });
        reader.readAsDataURL(blob);
      }, 'image/jpeg', quality);
    });
  }

  // ── Video upload — trim to 7 s + compress ─────────────────
  videoInput.addEventListener('change', async () => {
    const file = videoInput.files[0]; videoInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('video/')) { toast('Not a video'); return; }

    const pill = showProgress('Trimming & compressing…');
    try {
      const { blob, duration } = await trimAndEncodeVideo(file, 7);
      const b64 = await blobToB64(blob);
      pill.remove();
      if (socket) socket.emit('media', { mediaType: 'video', data: b64, mimeType: blob.type, duration });
    } catch (_) { pill.remove(); toast('Failed to process video'); }
  });

  // Re-encodes any video to ≤7 s at 480p / 500 kbps via canvas + MediaRecorder
  function trimAndEncodeVideo(file, maxSecs) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.playsInline = true;
      video.muted = true;
      const objUrl = URL.createObjectURL(file);
      video.src = objUrl;

      video.addEventListener('loadedmetadata', async () => {
        const trimDur = Math.min(video.duration, maxSecs);

        // Scale to max 480 px on the longer edge
        const MAX_DIM = 480;
        const scale = Math.min(MAX_DIM / (video.videoWidth || 480), MAX_DIM / (video.videoHeight || 270), 1);
        const w = Math.max(2, Math.round((video.videoWidth  || 480) * scale));
        const h = Math.max(2, Math.round((video.videoHeight || 270) * scale));

        const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
        const ctx = canvas.getContext('2d');
        const canvasStream = canvas.captureStream(24);

        // Attempt to also capture audio via Web Audio
        let recordStream = canvasStream;
        try {
          ensureAudio();
          const audioSrc  = audioCtx.createMediaElementSource(video);
          const audioDest = audioCtx.createMediaStreamDestination();
          audioSrc.connect(audioDest);
          video.muted = false;
          recordStream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...audioDest.stream.getAudioTracks(),
          ]);
        } catch (_) { /* audio capture unavailable — video only */ }

        const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm']
          .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

        const recorder = new MediaRecorder(recordStream, {
          mimeType, videoBitsPerSecond: 500_000,
        });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          canvasStream.getTracks().forEach((t) => t.stop());
          URL.revokeObjectURL(objUrl);
          resolve({ blob: new Blob(chunks, { type: recorder.mimeType }), duration: trimDur });
        };

        video.currentTime = 0;
        try { await video.play(); } catch (_) {}
        recorder.start(100);

        let animId;
        const draw = () => {
          ctx.drawImage(video, 0, 0, w, h);
          animId = requestAnimationFrame(draw);
        };
        draw();

        const stop = () => {
          cancelAnimationFrame(animId);
          video.pause();
          if (recorder.state !== 'inactive') recorder.stop();
        };
        const t = setTimeout(stop, trimDur * 1000 + 300);
        video.addEventListener('ended', () => { clearTimeout(t); stop(); });
      });

      video.addEventListener('error', () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error('Video load failed'));
      });
    });
  }

  function showProgress(text) {
    const pill = document.createElement('div');
    pill.className = 'upload-progress';
    pill.textContent = text;
    composer.style.position = 'relative';
    composer.appendChild(pill);
    return pill;
  }

  // ── Voice recording (real waveform via AnalyserNode) ──────
  let mediaRecorder   = null;
  let audioChunks     = [];
  let recordingStart  = null;
  let recTimerHandle  = null;
  let cancelled       = false;
  let waveformSamples = [];   // raw RMS amplitude values collected during recording
  let analyserHandle  = null; // setInterval id for sampling
  const MAX_REC_SECS  = 120;

  function startRecording() {
    if (mediaRecorder) return;
    cancelled = false;
    waveformSamples = [];

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

      // Set up analyser to capture real amplitude
      ensureAudio();
      const source   = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const timeDomain = new Uint8Array(analyser.frequencyBinCount);

      // Sample RMS every 80 ms
      analyserHandle = setInterval(() => {
        analyser.getByteTimeDomainData(timeDomain);
        let sum = 0;
        for (let i = 0; i < timeDomain.length; i++) {
          const v = (timeDomain[i] - 128) / 128;
          sum += v * v;
        }
        waveformSamples.push(Math.sqrt(sum / timeDomain.length));
      }, 80);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';

      mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunks   = [];

      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        clearInterval(analyserHandle);
        stream.getTracks().forEach((t) => t.stop());
        if (cancelled) { mediaRecorder = null; return; }
        const duration = (Date.now() - recordingStart) / 1000;
        if (duration < 0.5) { mediaRecorder = null; return; }

        const blob = new Blob(audioChunks, { type: mimeType });
        blobToB64(blob).then((audio) => {
          if (socket) socket.emit('voice', {
            audio,
            duration,
            mimeType,
            waveform: waveformSamples, // real amplitude data
          });
        });
        mediaRecorder = null;
      };

      mediaRecorder.start(200);
      recordingStart = Date.now();

      // Show recording UI
      inputWrap.classList.add('hidden');
      sendBtn.classList.add('hidden');
      recordingBar.classList.remove('hidden');
      micBtn.classList.add('recording');

      let secs = 0;
      recTimer.textContent = '0:00';
      recTimerHandle = setInterval(() => {
        secs++;
        recTimer.textContent = formatDur(secs);
        if (secs >= MAX_REC_SECS) stopRecording(false);
      }, 1000);
    }).catch(() => toast('Microphone access denied'));
  }

  function stopRecording(cancel) {
    cancelled = cancel;
    clearInterval(recTimerHandle); clearInterval(analyserHandle);
    recTimerHandle = null; analyserHandle = null;
    inputWrap.classList.remove('hidden');
    sendBtn.classList.remove('hidden');
    recordingBar.classList.add('hidden');
    micBtn.classList.remove('recording');
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    else mediaRecorder = null;
  }

  // Hold-to-record bindings
  micBtn.addEventListener('mousedown',   (e) => { e.preventDefault(); startRecording(); });
  document.addEventListener('mouseup',   ()  => { if (mediaRecorder) stopRecording(false); });
  micBtn.addEventListener('touchstart',  (e) => { e.preventDefault(); startRecording(); }, { passive: false });
  micBtn.addEventListener('touchend',    (e) => { e.preventDefault(); stopRecording(false); }, { passive: false });
  micBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); stopRecording(true);  }, { passive: false });
  recCancelBtn.addEventListener('click',    () => stopRecording(true));
  recCancelBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(true); });

  // ── Burn ──────────────────────────────────────────────────
  burnBtn.addEventListener('click', showBurnConfirm);

  function showBurnConfirm() {
    const overlay = document.createElement('div');
    overlay.className = 'burn-confirm';
    overlay.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="burn-sheet">
        <h3>🔥 Burn this chat?</h3>
        <p>Every message disappears for <em>everyone</em> in the room — permanently. This cannot be undone.</p>
        <div class="burn-actions">
          <button class="btn-cancel" id="bCancelBtn">Cancel</button>
          <button class="btn-burn-confirm" id="bConfirmBtn">Burn it</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#bCancelBtn').addEventListener('click',     () => overlay.remove());
    overlay.querySelector('.modal-backdrop').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#bConfirmBtn').addEventListener('click', () => {
      overlay.remove();
      if (socket) socket.emit('burn');
    });
  }

  // ── Matrix burn animation ─────────────────────────────────
  function playBurnAnimation(by) {
    msgInput.disabled = true; sendBtn.disabled = true;
    if (amOwner) burnBtn.disabled = true;
    playBurnSound();
    app.classList.add('shaking');
    setTimeout(() => app.classList.remove('shaking'), 500);

    // Canvas Matrix rain
    const canvas = document.createElement('canvas');
    canvas.id = 'matrixCanvas';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx    = canvas.getContext('2d');
    const CHARS  = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF<>[]{}!@#';
    const COL_W  = 16;
    const cols   = Math.ceil(canvas.width / COL_W);
    const drops  = Array.from({ length: cols }, () => Math.random() * -60);
    const speeds = Array.from({ length: cols }, () => 0.3 + Math.random() * 0.5);
    const RAIN_DUR = 5500;
    let rainStart = null;

    function drawRain(ts) {
      if (!rainStart) rainStart = ts;
      const p = Math.min((ts - rainStart) / RAIN_DUR, 1);
      const alpha = p < 0.12 ? p / 0.12 : p < 0.78 ? 1 : 1 - (p - 0.78) / 0.22;
      canvas.style.opacity = (alpha * 0.88).toFixed(3);
      ctx.fillStyle = 'rgba(0,0,0,0.055)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${COL_W - 2}px monospace`;
      for (let i = 0; i < cols; i++) {
        const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
        const x = i * COL_W, y = drops[i] * COL_W;
        ctx.fillStyle = '#ffffff'; ctx.fillText(ch, x, y);
        ctx.fillStyle = '#39ff14'; ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], x, y - COL_W);
        ctx.fillStyle = '#00cc44'; ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], x, y - COL_W * 2);
        if (y > canvas.height + COL_W && Math.random() > 0.97) drops[i] = 0;
        drops[i] += speeds[i];
      }
      if (p < 1) requestAnimationFrame(drawRain); else canvas.remove();
    }
    requestAnimationFrame(drawRain);

    // Text scramble on each bubble
    const MCHARS = '0123456789ABCDEFアイウエオカキクケコ<>{}[]!@#$%^&*';
    const rows = Array.from(messages.querySelectorAll('.msg:not(.system)'));
    rows.slice().reverse().forEach((row, i) => {
      const delay = i * 180, dur = 2200;
      const bubble = row.querySelector('.bubble');
      if (!bubble) return;

      setTimeout(() => {
        // Media bubbles: just tint + fade
        if (row.querySelector('.media-bubble, .voice-bubble')) {
          bubble.style.transition = `opacity ${dur}ms ease, filter ${dur}ms ease`;
          bubble.style.filter  = 'hue-rotate(80deg) saturate(4) brightness(1.5)';
          bubble.style.opacity = '0';
          return;
        }

        row.classList.add('matrix-scramble');
        const original = bubble.childNodes[0]?.nodeType === Node.TEXT_NODE
          ? bubble.childNodes[0].textContent
          : bubble.textContent;
        const startTs = performance.now();
        let frame;

        const textNode = bubble.childNodes[0]?.nodeType === Node.TEXT_NODE
          ? bubble.childNodes[0]
          : (() => {
              const t = document.createTextNode(original);
              bubble.insertBefore(t, bubble.firstChild);
              return t;
            })();

        function scrambleFrame(now) {
          const p    = Math.min((now - startTs) / dur, 1);
          const keep = Math.floor(original.length * (1 - p));
          let out = '';
          for (let ci = 0; ci < original.length; ci++) {
            if (original[ci] === ' ' || original[ci] === '\n') out += original[ci];
            else if (ci < keep) out += original[ci];
            else out += MCHARS[Math.floor(Math.random() * MCHARS.length)];
          }
          textNode.textContent = out;
          if (p < 0.5) {
            bubble.style.color = `rgba(0,${Math.round(180 + 75 * p)},${Math.round(60 * p)},1)`;
          } else {
            bubble.style.color = `rgba(0,200,60,${(1 - (p - 0.5) / 0.5).toFixed(3)})`;
          }
          if (p < 1) frame = requestAnimationFrame(scrambleFrame);
          else { cancelAnimationFrame(frame); bubble.style.opacity = '0'; }
        }
        frame = requestAnimationFrame(scrambleFrame);
      }, delay);
    });

    const clearDelay = rows.length * 180 + 2400;
    setTimeout(() => {
      messages.innerHTML = '';
      msgNodes.clear();
      lastMsgUser = null; lastMsgTime = 0;
      addSystem(by ? `${by} burned this chat.` : 'This chat was burned.');
      msgInput.disabled = false;
      sendBtn.disabled  = msgInput.value.trim() === '';
      if (amOwner) burnBtn.disabled = false;
    }, clearDelay);
  }

  // ── Users ─────────────────────────────────────────────────
  function renderUsers(users) {
    allUsers = users;
    userList.innerHTML = '';
    users.forEach((u) => {
      const li = document.createElement('li');
      li.textContent = u + (u === myName ? ' (you)' : '');
      userList.appendChild(li);
    });
    userCount.textContent = users.length;
    refreshAllTicks();
  }

  // ── Typing ────────────────────────────────────────────────
  function renderTyping() {
    const others = Array.from(typingUsers).filter((u) => u !== myName);
    if (!others.length) {
      typingText.textContent = ''; typingDots.classList.add('hidden'); return;
    }
    typingDots.classList.remove('hidden');
    typingText.textContent = others.length === 1
      ? `${others[0]} is typing`
      : others.length === 2 ? `${others[0]} & ${others[1]} are typing`
      : 'Several people are typing';
  }

  // ── Scroll ────────────────────────────────────────────────
  function isAtBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
  }
  function scrollToBottom() { messages.scrollTop = messages.scrollHeight; }

  // ── Utilities ─────────────────────────────────────────────
  function formatDur(secs) {
    const s = Math.floor(secs);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function b64ToBlob(b64, mime) {
    const bin   = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  function blobToB64(blob) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onloadend = () => res(r.result.split(',')[1]);
      r.readAsDataURL(blob);
    });
  }

  // ── Copy link ─────────────────────────────────────────────
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied ✓'); }
    catch {
      const ta = Object.assign(document.createElement('textarea'), {
        value: location.href, style: 'position:fixed;opacity:0',
      });
      document.body.appendChild(ta); ta.focus(); ta.select();
      document.execCommand('copy'); ta.remove();
      toast('Link copied ✓');
    }
  });

  // ── Users panel ───────────────────────────────────────────
  usersBtn.addEventListener('click', (e) => {
    e.stopPropagation(); usersPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!usersPanel.classList.contains('hidden') &&
        !usersPanel.contains(e.target) && e.target !== usersBtn) {
      usersPanel.classList.add('hidden');
    }
  });

  // ── Toast ─────────────────────────────────────────────────
  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s'; el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 1700);
  }

  nameInput.focus();
})();
