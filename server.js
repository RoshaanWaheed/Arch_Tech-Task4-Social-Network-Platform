require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const UPLOADS = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const { ObjectId } = mongoose.Schema.Types;
const ref = (m) => [{ type: ObjectId, ref: m }];

const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9_]{3,20}$/ },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  password: { type: String, required: true },
  bio: { type: String, default: '', maxlength: 200 },
  avatar: { type: String, default: '' },
  privacy: {
    profile: { type: String, enum: ['public', 'friends'], default: 'public' },
    allowRequests: { type: Boolean, default: true },
  },
  friends: ref('User'),
  incoming: ref('User'),
  outgoing: ref('User'),
}, { timestamps: true }));

const Post = mongoose.model('Post', new mongoose.Schema({
  author: { type: ObjectId, ref: 'User', required: true },
  text: { type: String, default: '', maxlength: 1000 },
  media: { url: String, type: { type: String, enum: ['image', 'video', 'audio'] } },
  visibility: { type: String, enum: ['public', 'friends'], default: 'public' },
  likes: ref('User'),
  comments: [{
    author: { type: ObjectId, ref: 'User' },
    text: { type: String, maxlength: 500 },
    createdAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true }));

const Notification = mongoose.model('Notification', new mongoose.Schema({
  user: { type: ObjectId, ref: 'User', index: true },
  from: { type: ObjectId, ref: 'User' },
  type: { type: String, enum: ['like', 'comment', 'request', 'accepted'] },
  post: { type: ObjectId, ref: 'Post' },
  read: { type: Boolean, default: false },
}, { timestamps: true }));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const fail = (status, message) => Object.assign(new Error(message), { status });
const sign = (u) => jwt.sign({ id: u._id }, SECRET, { expiresIn: '7d' });
const brief = (u) => u && ({ id: u._id, username: u.username, name: u.name, avatar: u.avatar });
const full = (u) => ({ ...brief(u), bio: u.bio, privacy: u.privacy });
const has = (list, id) => list.some((x) => String(x._id || x) === String(id));
const relation = (me, id) =>
  String(me._id) === String(id) ? 'self'
  : has(me.friends, id) ? 'friends'
  : has(me.outgoing, id) ? 'sent'
  : has(me.incoming, id) ? 'received' : 'none';

const populatePost = (q) => q.populate('author', 'username name avatar').populate('comments.author', 'username name avatar');
const commentView = (c) => ({ id: c._id, author: brief(c.author), text: c.text, createdAt: c.createdAt });
const postView = (p, uid) => ({
  id: p._id, author: brief(p.author), text: p.text, media: p.media && p.media.url ? p.media : null,
  visibility: p.visibility, likes: p.likes.length, liked: has(p.likes, uid),
  comments: p.comments.map(commentView), createdAt: p.createdAt,
});

async function audience(authorId, extra) {
  const a = await User.findById(authorId).select('friends');
  return new Set([String(authorId), ...a.friends.map(String), ...(extra ? [String(extra)] : [])]);
}
const emitTo = (ids, event, data) => ids.forEach((id) => io.to(String(id)).emit(event, data));

async function notify(userId, type, from, post) {
  if (String(userId) === String(from._id)) return;
  const n = await Notification.create({ user: userId, from: from._id, type, post: post && post._id });
  io.to(String(userId)).emit('notification', {
    id: n._id, type, from: brief(from), post: n.post, read: false, createdAt: n.createdAt,
  });
}

async function canSee(post, viewer) {
  if (String(post.author._id || post.author) === String(viewer._id)) return true;
  if (has(viewer.friends, post.author._id || post.author)) return true;
  const a = await User.findById(post.author._id || post.author).select('privacy');
  return post.visibility === 'public' && a.privacy.profile === 'public';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video|audio)\//.test(file.mimetype)),
});

const auth = wrap(async (req, res, next) => {
  let id;
  try { id = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET).id; }
  catch { throw fail(401, 'Please sign in again'); }
  req.user = await User.findById(id);
  if (!req.user) throw fail(401, 'Please sign in again');
  next();
});

app.use(express.json());
app.use('/uploads', express.static(UPLOADS));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/register', wrap(async (req, res) => {
  const { username = '', name = '', password = '' } = req.body;
  if (password.length < 6) throw fail(400, 'Password must be at least 6 characters');
  if (await User.exists({ username: username.toLowerCase() })) throw fail(409, 'That username is taken');
  const u = await User.create({ username, name, password: await bcrypt.hash(password, 10) });
  res.json({ token: sign(u), user: full(u) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const u = await User.findOne({ username: String(req.body.username || '').toLowerCase() });
  if (!u || !(await bcrypt.compare(req.body.password || '', u.password))) throw fail(401, 'Wrong username or password');
  res.json({ token: sign(u), user: full(u) });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const unread = await Notification.countDocuments({ user: req.user._id, read: false });
  res.json({ user: full(req.user), unread });
}));

app.put('/api/me', auth, wrap(async (req, res) => {
  const { name, bio, privacy = {} } = req.body;
  if (name) req.user.name = name;
  if (typeof bio === 'string') req.user.bio = bio;
  if (['public', 'friends'].includes(privacy.profile)) req.user.privacy.profile = privacy.profile;
  if (typeof privacy.allowRequests === 'boolean') req.user.privacy.allowRequests = privacy.allowRequests;
  await req.user.save();
  res.json({ user: full(req.user) });
}));

app.post('/api/me/avatar', auth, upload.single('avatar'), wrap(async (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) throw fail(400, 'Choose an image file');
  req.user.avatar = '/uploads/' + req.file.filename;
  await req.user.save();
  res.json({ user: full(req.user) });
}));

app.get('/api/users', auth, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!q) return res.json([]);
  const users = await User.find({ _id: { $ne: req.user._id }, $or: [{ username: new RegExp(q, 'i') }, { name: new RegExp(q, 'i') }] }).limit(20);
  res.json(users.map((u) => ({ ...brief(u), relation: relation(req.user, u._id) })));
}));

app.get('/api/users/:username', auth, wrap(async (req, res) => {
  const u = await User.findOne({ username: req.params.username.toLowerCase() });
  if (!u) throw fail(404, 'User not found');
  const rel = relation(req.user, u._id);
  const open = rel === 'self' || rel === 'friends';
  if (!open && u.privacy.profile === 'friends') {
    return res.json({ user: brief(u), relation: rel, locked: true, posts: [] });
  }
  const filter = { author: u._id, ...(open ? {} : { visibility: 'public' }) };
  const posts = await populatePost(Post.find(filter).sort('-createdAt').limit(50));
  res.json({
    user: { ...brief(u), bio: u.bio, friendCount: u.friends.length },
    relation: rel, locked: false, posts: posts.map((p) => postView(p, req.user._id)),
  });
}));

app.get('/api/friends', auth, wrap(async (req, res) => {
  await req.user.populate('friends incoming outgoing', 'username name avatar');
  res.json({
    friends: req.user.friends.map((f) => ({ ...brief(f), online: onlineCount.has(String(f._id)) })),
    incoming: req.user.incoming.map(brief),
    outgoing: req.user.outgoing.map(brief),
  });
}));

const pull = (list, id) => { const i = list.findIndex((x) => String(x) === String(id)); if (i > -1) list.splice(i, 1); };
const refresh = (...ids) => emitTo(ids, 'friends:update', {});

async function befriend(a, b) {
  [[a, b], [b, a]].forEach(([x, y]) => {
    pull(x.incoming, y._id); pull(x.outgoing, y._id);
    if (!has(x.friends, y._id)) x.friends.push(y._id);
  });
  await Promise.all([a.save(), b.save()]);
}

app.post('/api/friends/request/:id', auth, wrap(async (req, res) => {
  const me = req.user, other = await User.findById(req.params.id);
  if (!other || String(other._id) === String(me._id)) throw fail(400, 'You can’t add this person');
  const rel = relation(me, other._id);
  if (rel === 'friends' || rel === 'sent') throw fail(400, 'Request already sent or you are already friends');
  if (rel === 'received') {
    await befriend(me, other);
    await notify(other._id, 'accepted', me);
  } else {
    if (!other.privacy.allowRequests) throw fail(403, 'This person isn’t accepting friend requests');
    me.outgoing.push(other._id); other.incoming.push(me._id);
    await Promise.all([me.save(), other.save()]);
    await notify(other._id, 'request', me);
  }
  refresh(me._id, other._id);
  res.json({ relation: relation(me, other._id) });
}));

app.post('/api/friends/accept/:id', auth, wrap(async (req, res) => {
  const me = req.user, other = await User.findById(req.params.id);
  if (!other || !has(me.incoming, other._id)) throw fail(400, 'No request from this person');
  await befriend(me, other);
  await notify(other._id, 'accepted', me);
  refresh(me._id, other._id);
  res.json({ relation: 'friends' });
}));

app.delete('/api/friends/:id', auth, wrap(async (req, res) => {
  const me = req.user, other = await User.findById(req.params.id);
  if (!other) throw fail(404, 'User not found');
  [[me, other], [other, me]].forEach(([x, y]) => { pull(x.friends, y._id); pull(x.incoming, y._id); pull(x.outgoing, y._id); });
  await Promise.all([me.save(), other.save()]);
  refresh(me._id, other._id);
  res.json({ relation: 'none' });
}));

app.post('/api/posts', auth, upload.single('media'), wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text && !req.file) throw fail(400, 'Write something or attach a photo, video or audio file');
  const post = await Post.create({
    author: req.user._id, text,
    visibility: req.body.visibility === 'friends' ? 'friends' : 'public',
    media: req.file ? { url: '/uploads/' + req.file.filename, type: req.file.mimetype.split('/')[0] } : undefined,
  });
  const p = await populatePost(Post.findById(post._id));
  emitTo(req.user.friends, 'post:new', postView(p, null));
  res.json(postView(p, req.user._id));
}));

app.get('/api/feed', auth, wrap(async (req, res) => {
  let filter;
  if (req.query.scope === 'discover') {
    const open = await User.find({ 'privacy.profile': 'public' }).distinct('_id');
    filter = { visibility: 'public', author: { $in: open } };
  } else {
    filter = { author: { $in: [req.user._id, ...req.user.friends] } };
  }
  const posts = await populatePost(Post.find(filter).sort('-createdAt').limit(50));
  res.json(posts.map((p) => postView(p, req.user._id)));
}));

async function loadVisible(req) {
  const p = await populatePost(Post.findById(req.params.id));
  if (!p || !(await canSee(p, req.user))) throw fail(404, 'Post not found');
  return p;
}
async function broadcastUpdate(p, me) {
  const ids = await audience(p.author._id, me._id);
  emitTo(ids, 'post:update', { id: p._id, likes: p.likes.length, comments: p.comments.map(commentView) });
}

app.post('/api/posts/:id/like', auth, wrap(async (req, res) => {
  const p = await loadVisible(req);
  const liked = has(p.likes, req.user._id);
  if (liked) pull(p.likes, req.user._id); else p.likes.push(req.user._id);
  await p.save();
  if (!liked) await notify(p.author._id, 'like', req.user, p);
  await broadcastUpdate(p, req.user);
  res.json(postView(p, req.user._id));
}));

app.post('/api/posts/:id/comments', auth, wrap(async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) throw fail(400, 'Write a comment first');
  const p = await loadVisible(req);
  p.comments.push({ author: req.user._id, text });
  await p.save();
  await p.populate('comments.author', 'username name avatar');
  await notify(p.author._id, 'comment', req.user, p);
  await broadcastUpdate(p, req.user);
  res.json(postView(p, req.user._id));
}));

app.delete('/api/posts/:id', auth, wrap(async (req, res) => {
  const p = await Post.findById(req.params.id);
  if (!p || String(p.author) !== String(req.user._id)) throw fail(404, 'Post not found');
  const ids = await audience(p.author);
  await p.deleteOne();
  if (p.media && p.media.url) fs.unlink(path.join(__dirname, p.media.url), () => {});
  emitTo(ids, 'post:delete', { id: p._id });
  res.json({ ok: true });
}));

app.get('/api/notifications', auth, wrap(async (req, res) => {
  const list = await Notification.find({ user: req.user._id }).sort('-createdAt').limit(40).populate('from', 'username name avatar');
  res.json(list.map((n) => ({ id: n._id, type: n.type, from: brief(n.from), post: n.post, read: n.read, createdAt: n.createdAt })));
}));

app.post('/api/notifications/read', auth, wrap(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  if (err.name === 'ValidationError') err = fail(400, 'Check your details: usernames use 3 to 20 letters, numbers or underscores');
  if (err.code === 'LIMIT_FILE_SIZE') err = fail(400, 'Files can be up to 25 MB');
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const onlineCount = new Map();

io.use((socket, next) => {
  try { socket.userId = jwt.verify(socket.handshake.auth.token, SECRET).id; next(); }
  catch { next(new Error('unauthorized')); }
});

async function presence(userId, online) {
  const u = await User.findById(userId).select('friends');
  if (u) emitTo(u.friends, 'presence', { id: userId, online });
}

io.on('connection', (socket) => {
  const id = String(socket.userId);
  socket.join(id);
  onlineCount.set(id, (onlineCount.get(id) || 0) + 1);
  if (onlineCount.get(id) === 1) presence(id, true);
  socket.on('disconnect', () => {
    const left = (onlineCount.get(id) || 1) - 1;
    if (left <= 0) { onlineCount.delete(id); presence(id, false); } else onlineCount.set(id, left);
  });
});

mongoose
  .connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/arch_circle')
  .then(() => server.listen(PORT, () => console.log(`Arch Circle running at http://localhost:${PORT}`)))
  .catch((e) => { console.error('Could not connect to MongoDB:', e.message); process.exit(1); });
