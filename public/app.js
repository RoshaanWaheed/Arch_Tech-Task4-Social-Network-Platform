const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let token = localStorage.getItem('token');
let me = null, socket = null, unread = 0, current = { name: '', scope: '' };
const posts = new Map();
const online = new Set();

async function api(path, { method = 'GET', body, form } = {}) {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (form) opt.body = form;
  else if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opt);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) logout();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

function ago(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return new Date(d).toLocaleDateString();
}

const avatar = (u, cls = '') => u.avatar
  ? `<img class="av ${cls}" src="${esc(u.avatar)}" alt="">`
  : `<span class="av ${cls}" aria-hidden="true">${esc((u.name || '?')[0].toUpperCase())}</span>`;

const link = (u) => `<a href="#/u/${esc(u.username)}">${esc(u.name)}</a>`;

let mode = 'login';
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === b));
  $('.auth-card').classList.toggle('register', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#auth-error').textContent = '';
}));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const d = await api(mode === 'login' ? '/login' : '/register', { method: 'POST', body });
    token = d.token;
    localStorage.setItem('token', token);
    e.target.reset();
    boot();
  } catch (err) { $('#auth-error').textContent = err.message; }
});

function logout() {
  token = null; me = null;
  localStorage.removeItem('token');
  if (socket) socket.disconnect();
  $('#app').hidden = true;
  $('#auth').hidden = false;
}

/* ---------- boot & shell ---------- */
async function boot() {
  try {
    const d = await api('/me');
    me = d.user; unread = d.unread;
  } catch { return logout(); }
  $('#auth').hidden = true;
  $('#app').hidden = false;
  connect();
  renderNav();
  route();
}

function renderNav() {
  const items = [['feed', 'Feed'], ['discover', 'Discover'], ['friends', 'Friends'], ['notifications', 'Alerts'], ['u/' + me.username, 'Profile'], ['settings', 'Settings']];
  $('#nav').innerHTML = `<h1 class="brand"><i></i>Arch Circle</h1>` + items.map(([h, l]) =>
    `<a href="#/${h}" data-r="${h}">${l}${h === 'notifications' ? `<span class="badge" id="badge" ${unread ? '' : 'hidden'}>${unread}</span>` : ''}</a>`).join('') +
    `<div class="me-box">${avatar(me, 'sm')}<span>${esc(me.name)}</span><button class="btn small" data-act="logout">Sign out</button></div>`;
}

function setBadge() {
  const b = $('#badge');
  if (b) { b.textContent = unread; b.hidden = !unread; }
}

/* ---------- sockets ---------- */
function connect() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('notification', (n) => {
    const texts = { like: 'liked your post', comment: 'commented on your post', request: 'sent you a friend request', accepted: 'accepted your friend request' };
    toast(`${n.from.name} ${texts[n.type]}`);
    if (current.name === 'notifications') { api('/notifications/read', { method: 'POST' }); notificationsView(); }
    else { unread++; setBadge(); }
  });
  socket.on('post:new', (p) => {
    if (current.name !== 'feed' || posts.has(p.id)) return;
    posts.set(p.id, p);
    $('#posts')?.insertAdjacentHTML('afterbegin', postHTML(p, true));
    $('#posts .empty')?.remove();
  });
  socket.on('post:update', (u) => {
    const p = posts.get(u.id);
    if (!p) return;
    p.likes = u.likes; p.comments = u.comments;
    rerender(u.id);
  });
  socket.on('post:delete', ({ id }) => { posts.delete(id); document.querySelector(`[data-post="${id}"]`)?.remove(); });
  socket.on('presence', ({ id, online: on }) => {
    on ? online.add(id) : online.delete(id);
    if (current.name === 'friends') document.querySelector(`[data-uid="${id}"] .dot`)?.classList.toggle('on', on);
  });
  socket.on('friends:update', () => { if (current.name === 'friends') friendsView(); });
}

window.addEventListener('hashchange', route);
async function route() {
  if (!me) return;
  const [name, arg] = (location.hash.slice(2) || 'feed').split('/');
  current = { name, scope: arg || '' };
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === (name === 'u' ? 'u/' + arg : name)));
  const views = { feed: () => feedView('feed'), discover: () => feedView('discover'), friends: friendsView, notifications: notificationsView, settings: settingsView, u: () => profileView(arg) };
  try { await (views[name] || views.feed)(); }
  catch (e) { $('#view').innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
}

function postHTML(p, fresh) {
  const m = p.media;
  const media = !m ? '' : m.type === 'image' ? `<img class="media" src="${esc(m.url)}" alt="Photo shared by ${esc(p.author.name)}">`
    : m.type === 'video' ? `<video class="media" src="${esc(m.url)}" controls preload="metadata"></video>`
    : `<audio class="media" src="${esc(m.url)}" controls preload="metadata"></audio>`;
  return `<article class="card post ${fresh ? 'fresh' : ''}" data-post="${p.id}">
    <div class="head">${avatar(p.author)}<div>${link(p.author)}<span class="vis">${p.visibility === 'friends' ? 'Friends only' : 'Public'}</span>
      <small>@${esc(p.author.username)}, ${ago(p.createdAt)}</small></div></div>
    ${p.text ? `<p class="text">${esc(p.text)}</p>` : ''}${media}
    <div class="actions">
      <button class="btn small ${p.liked ? 'liked' : ''}" data-act="like" data-id="${p.id}" aria-pressed="${p.liked}">${p.liked ? 'Liked' : 'Like'} (${p.likes})</button>
      <span class="btn small" style="cursor:default">Comments (${p.comments.length})</span>
      ${p.author.id === me.id ? `<button class="btn small danger" data-act="delete" data-id="${p.id}" style="margin-left:auto">Delete</button>` : ''}
    </div>
    <div class="comments">${p.comments.map((c) => `<div class="comment">${avatar(c.author, 'sm')}<div class="bubble"><b>${esc(c.author.name)}</b> ${esc(c.text)}</div></div>`).join('')}</div>
    <form class="comment-form" data-id="${p.id}"><input name="text" placeholder="Write a comment" maxlength="500" aria-label="Write a comment"><button class="btn small">Send</button></form>
  </article>`;
}

function rerender(id) {
  const el = document.querySelector(`[data-post="${id}"]`);
  if (!el) return;
  const draft = $('.comment-form input', el).value;
  const focused = document.activeElement === $('.comment-form input', el);
  el.outerHTML = postHTML(posts.get(id));
  const input = $(`[data-post="${id}"] .comment-form input`);
  input.value = draft;
  if (focused) input.focus();
}

function postList(list) {
  list.forEach((p) => posts.set(p.id, p));
  return list.length ? list.map((p) => postHTML(p)).join('') : '<p class="empty">No posts yet.</p>';
}

async function feedView(scope) {
  const list = await api('/feed?scope=' + (scope === 'discover' ? 'discover' : 'feed'));
  posts.clear();
  $('#view').innerHTML = `<h2 class="page-title">${scope === 'discover' ? 'Discover' : 'Your feed'}</h2>
    <form class="card composer" id="composer">
      <textarea name="text" placeholder="What’s happening?" maxlength="1000" aria-label="Post text"></textarea>
      <div class="row">
        <input type="file" name="media" accept="image/*,video/*,audio/*" aria-label="Attach a photo, video or audio file">
        <select name="visibility" aria-label="Who can see this post"><option value="public">Public</option><option value="friends">Friends only</option></select>
        <button class="btn primary">Post</button>
      </div></form>
    <div id="posts">${postList(list)}</div>`;
  if (scope === 'discover') $('#posts .empty')?.replaceWith(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No public posts yet.' }));
  else if (!list.length) $('#posts .empty').textContent = 'Your feed is empty. Post something or add friends to see their updates.';
}

function relButton(u, rel) {
  const b = (act, label, cls = '') => `<button class="btn small ${cls}" data-act="${act}" data-id="${u.id}">${label}</button>`;
  return { none: b('request', 'Add friend', 'primary'), sent: b('remove', 'Cancel request'), received: b('accept', 'Accept', 'primary'), friends: b('remove', 'Unfriend', 'danger'), self: '' }[rel] || '';
}

async function friendsView() {
  const d = await api('/friends');
  d.friends.forEach((f) => (f.online ? online.add(f.id) : online.delete(f.id)));
  const person = (u, actions) => `<div class="person" data-uid="${u.id}">${avatar(u)}<div class="grow"><span class="dot ${online.has(u.id) ? 'on' : ''}"></span>${link(u)}<small class="muted"> @${esc(u.username)}</small></div>${actions}</div>`;
  const section = (title, list, fn) => list.length ? `<div class="card"><h3>${title} (${list.length})</h3>${list.map(fn).join('')}</div>` : '';
  const search = $('#people-q')?.value || '';
  $('#view').innerHTML = `<h2 class="page-title">Friends</h2>
    <div class="card"><label>Find people<input id="people-q" type="search" placeholder="Search by name or username" value="${esc(search)}"></label><div id="people"></div></div>
    ${section('Friend requests', d.incoming, (u) => person(u, relButton(u, 'received') + `<button class="btn small" data-act="remove" data-id="${u.id}">Decline</button>`))}
    ${section('Your friends', d.friends, (u) => person(u, relButton(u, 'friends')))}
    ${section('Requests you sent', d.outgoing, (u) => person(u, relButton(u, 'sent')))}
    ${!d.friends.length && !d.incoming.length ? '<p class="empty">Search for people above to send your first friend request.</p>' : ''}`;
  if (search) searchPeople(search);
}

let timer;
async function searchPeople(q) {
  const box = $('#people');
  if (!q.trim()) { box.innerHTML = ''; return; }
  const list = await api('/users?q=' + encodeURIComponent(q));
  box.innerHTML = list.length ? list.map((u) => `<div class="person" data-uid="${u.id}">${avatar(u)}<div class="grow">${link(u)}<small class="muted"> @${esc(u.username)}</small></div>${relButton(u, u.relation)}</div>`).join('') : '<p class="empty">No one found.</p>';
}
document.addEventListener('input', (e) => {
  if (e.target.id !== 'people-q') return;
  clearTimeout(timer);
  timer = setTimeout(() => searchPeople(e.target.value).catch((err) => toast(err.message)), 250);
});

async function notificationsView() {
  const list = await api('/notifications');
  const texts = { like: 'liked your post', comment: 'commented on your post', request: 'sent you a friend request', accepted: 'accepted your friend request' };
  $('#view').innerHTML = `<h2 class="page-title">Notifications</h2><div class="card">${list.length
    ? list.map((n) => `<div class="notif ${n.read ? '' : 'unread'}">${avatar(n.from, 'sm')}<span>${link(n.from)} ${texts[n.type]}. <small class="muted">${ago(n.createdAt)}</small></span>${n.type === 'request' ? '<a class="btn small" style="margin-left:auto;text-decoration:none" href="#/friends">View</a>' : ''}</div>`).join('')
    : '<p class="empty">Nothing new. Likes, comments and friend requests show up here.</p>'}</div>`;
  if (unread) { unread = 0; setBadge(); api('/notifications/read', { method: 'POST' }); }
}

async function profileView(username) {
  const d = await api('/users/' + encodeURIComponent(username));
  const u = d.user;
  posts.clear();
  $('#view').innerHTML = `<div class="card profile-head">${avatar(u, 'lg')}<div class="grow"><h2>${esc(u.name)}</h2><span class="muted">@${esc(u.username)}${u.friendCount != null ? `, ${u.friendCount} friend${u.friendCount === 1 ? '' : 's'}` : ''}</span>${u.bio ? `<p>${esc(u.bio)}</p>` : ''}</div>
    ${d.relation === 'self' ? '<a class="btn" style="text-decoration:none" href="#/settings">Edit profile</a>' : relButton(u, d.relation)}</div>
    ${d.locked ? '<p class="empty">This profile is visible to friends only. Send a friend request to see their posts.</p>' : `<div id="posts">${postList(d.posts)}</div>`}`;
}

async function settingsView() {
  const p = me.privacy;
  $('#view').innerHTML = `<h2 class="page-title">Settings</h2>
    <form class="card" id="avatar-form"><h3>Profile photo</h3><div class="head" style="margin-top:.6rem">${avatar(me, 'lg')}<input type="file" name="avatar" accept="image/*" aria-label="Choose a profile photo"></div></form>
    <form class="card" id="settings-form"><h3 style="margin-bottom:.8rem">Profile and privacy</h3>
      <label>Name<input name="name" value="${esc(me.name)}" maxlength="60" required></label>
      <label>Bio<textarea name="bio" maxlength="200">${esc(me.bio)}</textarea></label>
      <label>Who can see your profile and posts
        <select name="profile"><option value="public" ${p.profile === 'public' ? 'selected' : ''}>Everyone</option><option value="friends" ${p.profile === 'friends' ? 'selected' : ''}>Friends only</option></select></label>
      <label class="check"><input type="checkbox" name="allowRequests" ${p.allowRequests ? 'checked' : ''}> Let people send me friend requests</label>
      <button class="btn primary">Save changes</button></form>`;
}

document.addEventListener('submit', async (e) => {
  const f = e.target;
  try {
    if (f.id === 'composer') {
      e.preventDefault();
      const p = await api('/posts', { method: 'POST', form: new FormData(f) });
      posts.set(p.id, p);
      f.reset();
      $('#posts .empty')?.remove();
      $('#posts').insertAdjacentHTML('afterbegin', postHTML(p, true));
    } else if (f.classList.contains('comment-form')) {
      e.preventDefault();
      const text = f.text.value.trim();
      if (!text) return;
      const p = await api(`/posts/${f.dataset.id}/comments`, { method: 'POST', body: { text } });
      posts.set(p.id, p);
      f.text.value = '';
      rerender(p.id);
    } else if (f.id === 'settings-form') {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      const d = await api('/me', { method: 'PUT', body: { name: v.name, bio: v.bio, privacy: { profile: v.profile, allowRequests: !!v.allowRequests } } });
      me = d.user; renderNav(); route(); toast('Settings saved');
    }
  } catch (err) { toast(err.message); }
});

document.addEventListener('change', async (e) => {
  if (e.target.closest('#avatar-form') && e.target.files[0]) {
    try {
      const form = new FormData(); form.append('avatar', e.target.files[0]);
      me = (await api('/me/avatar', { method: 'POST', form })).user;
      renderNav(); settingsView(); toast('Profile photo updated');
    } catch (err) { toast(err.message); }
  }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  try {
    if (act === 'logout') return logout();
    if (act === 'like') { const p = await api(`/posts/${id}/like`, { method: 'POST' }); posts.set(p.id, p); return rerender(p.id); }
    if (act === 'delete') { if (confirm('Delete this post?')) await api('/posts/' + id, { method: 'DELETE' }); return; }
    const calls = { request: ['/friends/request/' + id, 'POST'], accept: ['/friends/accept/' + id, 'POST'], remove: ['/friends/' + id, 'DELETE'] };
    if (calls[act]) { await api(calls[act][0], { method: calls[act][1] }); route(); }
  } catch (err) { toast(err.message); }
});

if (token) boot(); else $('#auth').hidden = false;
