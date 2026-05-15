(() => {
  const roomId = location.pathname.split('/').pop();
  document.getElementById('roomIdLabel').textContent = roomId.slice(0, 8) + '…';

  const nameModal = document.getElementById('nameModal');
  const nameInput = document.getElementById('nameInput');
  const joinBtn = document.getElementById('joinBtn');
  const nameError = document.getElementById('nameError');
  const app = document.getElementById('app');
  const messages = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const msgInput = document.getElementById('msgInput');
  const copyBtn = document.getElementById('copyBtn');
  const usersBtn = document.getElementById('usersBtn');
  const usersPanel = document.getElementById('usersPanel');
  const userList = document.getElementById('userList');
  const userCount = document.getElementById('userCount');
  const typingIndicator = document.getElementById('typingIndicator');

  let socket = null;
  let myName = null;
  const typingUsers = new Set();
  let typingTimeout = null;
  let isTypingSent = false;

  // Restore previously-used name within this session
  const savedName = sessionStorage.getItem('chat-name-' + roomId);
  if (savedName) nameInput.value = savedName;
  nameInput.focus();

  function showError(msg) { nameError.textContent = msg || ''; }

  function tryJoin() {
    const name = nameInput.value.trim();
    if (!name) { showError('Please enter a username'); return; }
    if (name.length > 24) { showError('Username too long'); return; }
    showError('');
    joinBtn.disabled = true;

    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      socket.emit('join', { roomId, name }, (res) => {
        if (!res || !res.ok) {
          showError((res && res.error) || 'Failed to join');
          joinBtn.disabled = false;
          socket.disconnect();
          return;
        }
        myName = name;
        sessionStorage.setItem('chat-name-' + roomId, name);
        nameModal.classList.add('hidden');
        app.classList.remove('hidden');
        msgInput.focus();
        renderUsers(res.users);
        for (const m of res.messages) addMessage(m, false);
        scrollToBottom();
      });
    });

    socket.on('connect_error', () => {
      showError('Connection failed');
      joinBtn.disabled = false;
    });

    socket.on('message', (m) => {
      const atBottom = isAtBottom();
      addMessage(m, true);
      if (atBottom) scrollToBottom();
    });

    socket.on('users', (users) => renderUsers(users));

    socket.on('user-joined', ({ user }) => {
      addSystem(`${user} joined`);
    });

    socket.on('user-left', ({ user }) => {
      typingUsers.delete(user);
      renderTyping();
      addSystem(`${user} left`);
    });

    socket.on('typing', ({ user, isTyping }) => {
      if (isTyping) typingUsers.add(user);
      else typingUsers.delete(user);
      renderTyping();
    });

    socket.on('disconnect', () => {
      addSystem('Disconnected. Trying to reconnect…');
    });
  }

  joinBtn.addEventListener('click', tryJoin);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryJoin(); });

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text || !socket) return;
    socket.emit('message', text.slice(0, 1000));
    msgInput.value = '';
    sendTyping(false);
  });

  msgInput.addEventListener('input', () => {
    if (!socket) return;
    sendTyping(true);
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => sendTyping(false), 1500);
  });

  function sendTyping(state) {
    if (!socket) return;
    if (state === isTypingSent) return;
    isTypingSent = state;
    socket.emit('typing', state);
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Invite link copied');
    } catch {
      toast('Copy failed');
    }
  });

  usersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    usersPanel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!usersPanel.classList.contains('hidden') &&
        !usersPanel.contains(e.target) && e.target !== usersBtn) {
      usersPanel.classList.add('hidden');
    }
  });

  function addMessage(m, animate) {
    const row = document.createElement('div');
    row.className = 'msg ' + (m.user === myName ? 'self' : 'other');
    if (!animate) row.style.animation = 'none';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.textContent = `${m.user} · ${time}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.text; // textContent prevents XSS

    row.appendChild(meta);
    row.appendChild(bubble);
    messages.appendChild(row);
  }

  function addSystem(text) {
    const row = document.createElement('div');
    row.className = 'msg system';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    messages.appendChild(row);
    if (isAtBottom()) scrollToBottom();
  }

  function renderUsers(users) {
    userList.innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');
      li.textContent = u + (u === myName ? ' (you)' : '');
      userList.appendChild(li);
    }
    userCount.textContent = users.length;
  }

  function renderTyping() {
    const list = Array.from(typingUsers).filter((u) => u !== myName);
    if (list.length === 0) { typingIndicator.textContent = ''; return; }
    if (list.length === 1) typingIndicator.textContent = `${list[0]} is typing…`;
    else if (list.length === 2) typingIndicator.textContent = `${list[0]} and ${list[1]} are typing…`;
    else typingIndicator.textContent = 'Several people are typing…';
  }

  function isAtBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  }
  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }
})();
