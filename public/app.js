// Boardly - pastel Trello-style project manager (vanilla JS single page app)
const root = document.getElementById('app');
let token = localStorage.getItem('token');
let me = localStorage.getItem('username');

let view = { type: null, id: null, reload: null }; // current page (used by live updates)
let openTask = null;                                // task modal that is currently open
let notes = { items: [], unread: 0 };
let socket = null;
let liveOn = false;
let bellBadge = null;
let liveEl = null;

/* ================= Helpers ================= */

// Tiny DOM builder. Text is always inserted as text nodes (never HTML), which prevents XSS.
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

// Icons (static, trusted SVG strings only)
const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  comment: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m5 0V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) logout();
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function timeAgo(sqlDate) {
  const secs = Math.floor((Date.now() - new Date(sqlDate.replace(' ', 'T') + 'Z')) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

// Picks one of the 6 pastel colors from a name
function pick(key) {
  let n = 0;
  for (const ch of String(key)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return n % 6;
}

function avatar(name, size = '') {
  return h('span', { class: `avatar c${pick(name)} ${size}`, title: name }, name.charAt(0).toUpperCase());
}

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3000);
}

function openModal(content, { size = '', onClose } = {}) {
  const overlay = h('div', { class: 'overlay' });
  let closed = false;
  const box = h('div', { class: 'modal ' + size },
    h('button', { class: 'close', 'aria-label': 'Close', onclick: () => close() }, icon('x')),
    content);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  function onKey(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (!document.querySelector('.overlay')) document.body.classList.remove('lock');
    if (onClose) onClose();
  }
  document.addEventListener('keydown', onKey);
  document.body.classList.add('lock');
  document.body.append(overlay);
  return close;
}

function confirmDialog(title, text, label, onConfirm) {
  let close;
  const yes = h('button', { class: 'btn danger', onclick: async () => {
    yes.disabled = true;
    try { await onConfirm(); } catch (err) { toast(err.message); }
    close();
  } }, label);
  close = openModal(h('div', { class: 'dialog' },
    h('h3', {}, title),
    h('p', { class: 'muted' }, text),
    h('div', { class: 'row end' }, h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'), yes)));
}

function emptyState(emoji, title, child) {
  return h('div', { class: 'empty' }, h('div', { class: 'emoji' }, emoji), h('h3', {}, title), child);
}

/* ================= Session, live updates, notifications ================= */

function saveSession(data) {
  token = data.token;
  me = data.user.username;
  localStorage.setItem('token', token);
  localStorage.setItem('username', me);
}

function logout() {
  closeSocket();
  token = me = null;
  notes = { items: [], unread: 0 };
  localStorage.removeItem('token');
  localStorage.removeItem('username');
  location.hash = '';
  route();
}

function setLive(on) {
  liveOn = on;
  if (liveEl) liveEl.className = 'live' + (on ? ' on' : '');
}

// WebSocket: the server pushes a message whenever something changes
function connectSocket() {
  if (!token) return;
  closeSocket();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket = ws;
  ws.onopen = () => setLive(true);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleLive(msg);
  };
  ws.onclose = () => {
    setLive(false);
    if (socket === ws && token) setTimeout(() => { if (socket === ws && token) connectSocket(); }, 2000);
  };
}

function closeSocket() {
  if (socket) { const s = socket; socket = null; s.close(); }
  setLive(false);
}

function handleLive(msg) {
  if (msg.type === 'notification') {
    loadNotes();
    toast('🔔 ' + msg.message);
  } else if (msg.type === 'project') {
    if (view.type === 'board' && view.id === Number(msg.projectId)) {
      view.reload();
      if (openTask) openTask.refresh();
    } else if (view.type === 'dashboard') {
      view.reload();
    }
  }
}

async function loadNotes() {
  try { notes = await api('/notifications'); paintBell(); } catch { /* ignore */ }
}

function paintBell() {
  if (!bellBadge) return;
  bellBadge.textContent = notes.unread > 9 ? '9+' : String(notes.unread);
  bellBadge.classList.toggle('hidden', !notes.unread);
}

function renderNotes(panel) {
  panel.replaceChildren(
    h('h4', {}, 'Notifications'),
    ...(notes.items.length
      ? notes.items.map((n) => h('button', { class: 'note' + (n.is_read ? '' : ' unread'), onclick: () => {
          panel.classList.add('hidden');
          if (n.project_id) location.hash = '#/p/' + n.project_id;
        } }, n.message, h('span', { class: 'when' }, timeAgo(n.created_at))))
      : [h('p', { class: 'muted', style: 'padding:12px' }, 'Nothing yet. You will see assignments and comments here.')]));
}

function toggleNotes(panel) {
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (!opening) return;
  renderNotes(panel);
  if (notes.unread > 0) {
    api('/notifications/read', { method: 'POST' }).then(() => { notes.unread = 0; paintBell(); }).catch(() => {});
  }
}

document.addEventListener('click', (e) => {
  const panel = document.querySelector('.notes-panel');
  if (panel && !panel.classList.contains('hidden') && !e.target.closest('.bell-wrap')) panel.classList.add('hidden');
});

/* ================= Login / Sign up ================= */

function renderAuth(mode = 'login') {
  const isLogin = mode === 'login';
  const error = h('p', { class: 'error' });
  const username = h('input', { placeholder: 'Username', autocomplete: 'username' });
  const password = h('input', { type: 'password', placeholder: 'Password', autocomplete: isLogin ? 'current-password' : 'new-password' });
  const submit = h('button', { class: 'btn block' }, isLogin ? 'Log in' : 'Create account');

  const form = h('form', { class: 'auth-form', onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = '';
    submit.disabled = true;
    try {
      const data = await api('/auth/' + (isLogin ? 'login' : 'register'), {
        method: 'POST',
        body: { username: username.value, password: password.value },
      });
      saveSession(data);
      location.hash = '#/projects';
      route();
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  } }, username, password, error, submit);

  const floater = (cls, chip, prio, text) =>
    h('div', { class: `float ${cls}` }, h('span', { class: `chip p-${prio}` }, chip), h('div', {}, text));

  const hero = h('section', { class: 'hero' },
    h('div', { class: 'logo' }, h('span', { class: 'logo-mark' }, icon('grid')), h('span', {}, 'Boardly')),
    h('h1', {}, 'Plan together, ', h('span', { class: 'grad' }, 'ship together'), '.'),
    h('p', {}, 'Create projects with your team, assign tasks, chat inside every card and watch the board update live.'),
    h('div', { class: 'floaters' },
      floater('f1', 'high', 'high', 'Design the landing page 🎨'),
      floater('f2', 'medium', 'medium', 'Write the API docs 📝'),
      floater('f3', 'low', 'low', 'Ship v1.0 🚀')));

  const side = h('section', { class: 'auth-side' },
    h('div', { class: 'auth-card' },
      h('h2', {}, isLogin ? 'Welcome back 👋' : 'Create your account ✨'),
      h('p', { class: 'muted' }, isLogin ? 'Log in to open your boards.' : 'Start your first project in a minute.'),
      form,
      h('p', { class: 'switch' }, isLogin ? 'New here? ' : 'Already have an account? ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); renderAuth(isLogin ? 'register' : 'login'); } },
          isLogin ? 'Sign up' : 'Log in'))));

  root.replaceChildren(h('div', { class: 'auth-wrap' }, hero, side));
}

/* ================= Layout ================= */

function renderShell(content) {
  bellBadge = h('span', { class: 'badge hidden' });
  const panel = h('div', { class: 'notes-panel hidden' });
  const bell = h('div', { class: 'bell-wrap' },
    h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: () => toggleNotes(panel) }, icon('bell'), bellBadge),
    panel);
  liveEl = h('span', { class: 'live' + (liveOn ? ' on' : ''), title: 'Live updates' }, h('i'), 'Live');

  const header = h('header', { class: 'topbar' },
    h('a', { class: 'logo', href: '#/projects' }, h('span', { class: 'logo-mark' }, icon('grid')), h('span', { class: 'logo-text' }, 'Boardly')),
    h('div', { class: 'spacer' }),
    liveEl, bell,
    h('div', { class: 'me' }, avatar(me), h('span', { class: 'me-name' }, me)),
    h('button', { class: 'icon-btn', 'aria-label': 'Log out', onclick: logout }, icon('logout')));

  root.replaceChildren(header, h('main', { class: 'page' }, content));
  paintBell();
  window.scrollTo(0, 0);
}

/* ================= Dashboard ================= */

function newProjectModal() {
  const name = h('input', { placeholder: 'e.g. Website redesign', maxlength: '60' });
  const desc = h('textarea', { rows: '3', maxlength: '200', placeholder: 'What is this project about?' });
  const error = h('p', { class: 'error' });
  let close;
  const create = h('button', { class: 'btn', onclick: async () => {
    error.textContent = '';
    create.disabled = true;
    try {
      const r = await api('/projects', { method: 'POST', body: { name: name.value, description: desc.value } });
      close();
      toast('Project created 🎉');
      location.hash = '#/p/' + r.id;
    } catch (err) { error.textContent = err.message; create.disabled = false; }
  } }, 'Create project');
  close = openModal(h('div', { class: 'dialog' },
    h('h3', {}, 'New project'),
    h('p', { class: 'muted' }, 'Add teammates after you create it.'),
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    h('div', { class: 'field' }, h('label', {}, 'Description (optional)'), desc),
    error,
    h('div', { class: 'row end' }, create)));
  name.focus();
}

function renderProjects(grid, projects) {
  if (!projects.length) {
    grid.replaceChildren(emptyState('🌱', 'No projects yet',
      h('button', { class: 'btn', onclick: newProjectModal }, icon('plus'), 'Create your first project')));
    return;
  }
  grid.replaceChildren(...projects.map((p) => {
    const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
    return h('a', { class: `project-card c${pick(p.name)}`, href: '#/p/' + p.id },
      h('h3', {}, p.name),
      h('p', {}, p.description || 'No description'),
      h('div', { class: 'progress' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'meta' },
        h('span', {}, `${p.done_count}/${p.task_count} tasks done`),
        h('span', {}, `${p.member_count} member${p.member_count === 1 ? '' : 's'}`)));
  }));
}

function pageDashboard() {
  const grid = h('div', { class: 'project-grid' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  async function load() {
    try { renderProjects(grid, await api('/projects')); }
    catch (err) { grid.textContent = err.message; }
  }
  view = { type: 'dashboard', id: null, reload: load };
  renderShell(h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', { class: 'page-title' }, `Hi ${me} 👋`), h('p', { class: 'page-sub' }, 'Pick a project or start a new one.')),
      h('button', { class: 'btn', onclick: newProjectModal }, icon('plus'), 'New project')),
    grid));
  load();
}

/* ================= Board ================= */

const COLUMNS = [
  { key: 'todo', label: 'To Do', emoji: '📝', cls: 'c0' },
  { key: 'doing', label: 'In Progress', emoji: '🚀', cls: 'c4' },
  { key: 'done', label: 'Done', emoji: '✅', cls: 'c3' },
];

function selectBox(options, value) {
  const s = h('select', {}, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  return s;
}

function membersModal(data, reload) {
  const list = h('div', {}, data.members.map((m) =>
    h('div', { class: 'member-row' }, avatar(m.username), h('span', {}, m.username), h('span', { class: 'role' }, m.role))));
  const parts = [h('h3', {}, 'Team members'), h('p', { class: 'muted' }, `${data.members.length} in this project`), list];

  let close;
  if (data.is_owner) {
    const input = h('input', { placeholder: 'Username to add' });
    const error = h('p', { class: 'error' });
    const form = h('form', { class: 'comment-form', style: 'margin-top:14px', onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api(`/projects/${data.id}/members`, { method: 'POST', body: { username: input.value } });
        toast(`${input.value.trim()} added ✨`);
        close();
        reload();
      } catch (err) { error.textContent = err.message; }
    } }, input, h('button', { class: 'btn small' }, 'Add'));
    parts.push(form, error);
  }
  close = openModal(h('div', { class: 'dialog' }, parts));
}

function openTaskModal(taskId, data, reload) {
  const t = data.tasks.find((x) => x.id === taskId);
  if (!t) return;

  const title = h('input', { class: 'title-input', maxlength: '100' });
  title.value = t.title;
  const desc = h('textarea', { rows: '4', maxlength: '1000', placeholder: 'Add more details...' });
  desc.value = t.description || '';
  const status = selectBox(COLUMNS.map((c) => [c.key, c.label]), t.status);
  const priority = selectBox([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], t.priority);
  const assignee = selectBox([['', 'Unassigned'], ...data.members.map((m) => [m.username, m.username])], t.assignee || '');

  let close;
  const save = h('button', { class: 'btn', onclick: async () => {
    save.disabled = true;
    try {
      await api('/tasks/' + t.id, { method: 'PUT', body: {
        title: title.value, description: desc.value, status: status.value, priority: priority.value, assignee: assignee.value,
      } });
      toast('Saved ✅');
      close();
      reload();
    } catch (err) { toast(err.message); save.disabled = false; }
  } }, 'Save changes');

  const buttons = [save];
  if (data.is_owner || t.creator === me) {
    buttons.unshift(h('button', { class: 'btn line', onclick: () => {
      confirmDialog('Delete this task?', "This can't be undone.", 'Delete', async () => {
        await api('/tasks/' + t.id, { method: 'DELETE' });
        toast('Task deleted');
        close();
        reload();
      });
    } }, icon('trash'), 'Delete'));
  }

  // Comments inside the task
  const list = h('div', { class: 'comment-list' }, h('p', { class: 'muted' }, 'Loading...'));
  const input = h('input', { placeholder: 'Write a comment...', maxlength: '300' });
  const commentRow = (c) => h('div', { class: 'comment' }, avatar(c.username),
    h('div', { class: 'bubble' }, h('b', {}, c.username), c.content, h('span', { class: 'when' }, timeAgo(c.created_at))));

  async function loadComments() {
    try {
      const comments = await api(`/tasks/${t.id}/comments`);
      list.replaceChildren(...(comments.length ? comments.map(commentRow) : [h('p', { class: 'muted' }, 'No comments yet. Start the conversation 💬')]));
      list.scrollTop = list.scrollHeight;
    } catch (err) { list.textContent = err.message; }
  }
  const commentForm = h('form', { class: 'comment-form', onsubmit: async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      await api(`/tasks/${t.id}/comments`, { method: 'POST', body: { content: text } });
      input.value = '';
      loadComments();
    } catch (err) { toast(err.message); }
  } }, input, h('button', { class: 'btn small' }, 'Send'));

  openTask = { id: t.id, refresh: loadComments };
  close = openModal(h('div', { class: 'dialog' },
    h('div', { class: 'field' }, title),
    h('div', { class: 'field' }, h('label', {}, 'Description'), desc),
    h('div', { class: 'fields' },
      h('div', { class: 'field' }, h('label', {}, 'Status'), status),
      h('div', { class: 'field' }, h('label', {}, 'Priority'), priority),
      h('div', { class: 'field' }, h('label', {}, 'Assigned to'), assignee)),
    h('div', { class: 'row end gap' }, buttons),
    h('div', { class: 'section-title' }, 'Comments'),
    list, commentForm), { size: 'md', onClose: () => { openTask = null; } });
  loadComments();
}

async function pageBoard(rawId) {
  const id = Number(rawId);
  let data = null;
  const head = h('div', { class: 'board-head' });
  const board = h('div', { class: 'board' });

  function taskCard(t) {
    const card = h('div', { class: 'task', draggable: 'true' },
      h('span', { class: `chip p-${t.priority}` }, t.priority),
      h('p', { class: 'task-title' }, t.title),
      h('div', { class: 'task-foot' },
        t.assignee ? h('span', { class: 'assignee' }, avatar(t.assignee, 'sm'), t.assignee) : h('span', {}, 'Unassigned'),
        t.comment_count ? h('span', { class: 'cmt' }, icon('comment'), String(t.comment_count)) : null));
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(t.id));
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => openTaskModal(t.id, data, load));
    return card;
  }

  function paintBoard() {
    board.replaceChildren(...COLUMNS.map((c) => {
      const tasks = data.tasks.filter((t) => t.status === c.key);
      const col = h('div', { class: `column ${c.cls}` },
        h('div', { class: 'col-head' }, h('b', {}, `${c.emoji} ${c.label}`), h('span', { class: 'count' }, String(tasks.length))),
        h('div', { class: 'tasks' }, tasks.map(taskCard)));

      const input = h('input', { placeholder: '+ Add a task', maxlength: '100' });
      col.append(h('form', { class: 'quick-add', onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        try {
          await api(`/projects/${id}/tasks`, { method: 'POST', body: { title: text, status: c.key } });
          input.value = '';
          load();
        } catch (err) { toast(err.message); }
      } }, input));

      // Drag and drop between columns
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('over'); });
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        col.classList.remove('over');
        const taskId = Number(e.dataTransfer.getData('text/plain'));
        const t = data.tasks.find((x) => x.id === taskId);
        if (!t || t.status === c.key) return;
        t.status = c.key;
        paintBoard();
        try { await api('/tasks/' + taskId, { method: 'PUT', body: { status: c.key } }); }
        catch (err) { toast(err.message); load(); }
      });
      return col;
    }));
  }

  function paintHead() {
    const done = data.tasks.filter((t) => t.status === 'done').length;
    const actions = h('div', { class: 'actions' },
      h('div', { class: 'avatars' }, data.members.slice(0, 5).map((m) => avatar(m.username))),
      h('button', { class: 'btn ghost small', onclick: () => membersModal(data, load) }, icon('users'),
        data.is_owner ? 'Team / Add member' : `Team (${data.members.length})`));
    if (data.is_owner) {
      actions.append(h('button', { class: 'btn line small', onclick: () => {
        confirmDialog('Delete this project?', 'All tasks and comments will be removed for everyone.', 'Delete project', async () => {
          await api('/projects/' + id, { method: 'DELETE' });
          toast('Project deleted');
          location.hash = '#/projects';
        });
      } }, icon('trash'), 'Delete'));
    }
    head.replaceChildren(
      h('a', { class: 'back', href: '#/projects' }, icon('back'), 'All projects'),
      h('div', { class: 'top' },
        h('div', {},
          h('h1', {}, data.name),
          h('p', { class: 'muted' }, (data.description ? data.description + ' · ' : '') + `${done}/${data.tasks.length} tasks done`)),
        actions));
  }

  async function load() {
    try {
      data = await api('/projects/' + id);
      paintHead();
      paintBoard();
    } catch (err) {
      if (err.status === 403 || err.status === 404) { toast('That project is not available.'); location.hash = '#/projects'; }
      else toast(err.message);
    }
  }

  view = { type: 'board', id, reload: load };
  renderShell(h('div', {}, head, board));
  load();
}

/* ================= Router ================= */

function route() {
  // Close any open popup when the page changes
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  document.body.classList.remove('lock');
  openTask = null;

  if (!token) { closeSocket(); view = { type: 'auth' }; return renderAuth('login'); }
  if (!socket) connectSocket();
  loadNotes();

  const [, page, arg] = location.hash.split('/');
  if (page === 'p' && arg) return pageBoard(arg);
  return pageDashboard();
}

window.addEventListener('hashchange', route);
route();