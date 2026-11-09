'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { verifyPasswordAsync, hashPasswordAsync } = require('./db');
const { sanitizeHtml, markdownToHtml, textToHtml, htmlToText } = require('./sanitize');
const { docxToHtml, htmlToDocx } = require('./docx');
const { toMarkdown, toText, toStandaloneHtml } = require('./export');
const { normalizeSettings, parseStored, pageCss } = require('./pagesetup');
const { makeThumb } = require('./thumb');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const LIMITS = {
  body: 4_500_000, // bytes of JSON
  content: 500_000, // chars of HTML per document, not counting embedded pictures
  contentWithImages: 3_000_000, // total including pictures
  images: 20, // pictures per document
  importText: 1_000_000, // chars of an uploaded text file
  importDocx: 2_000_000, // bytes of an uploaded .docx
  title: 200,
  versionsPerDoc: 100,
  namedVersions: 30, // versions with a name are kept forever (up to this many per document)
  versionLabel: 80,
  docsPerUser: 500, // including the trash
  bytesPerUser: 200_000_000, // total document content per user
  pushContent: 150_000, // larger documents (pictures) are fetched by collaborators instead of pushed to each of them on every save
  versionCoalesceSeconds: 120,
  sessionDays: 7,
  trashDays: 30,
  streamsPerUser: 30,
  commentLength: 2000,
  quoteLength: 300,
  commentsPerDoc: 500,
};
const IMPORT_TYPES = ['.txt', '.md', '.markdown', '.docx'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

class RateLimiter {
  constructor() { this.hits = new Map(); }
  // returns seconds to wait, or 0 when allowed
  hit(key, limit, windowMs) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + windowMs }; this.hits.set(key, e); }
    e.count += 1;
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    return e.count > limit ? Math.ceil((e.reset - now) / 1000) : 0;
  }
  clear(key) { this.hits.delete(key); }
  state(key, limit) { const e = this.hits.get(key); return { limit, remaining: e ? Math.max(0, limit - e.count) : limit, reset: e ? Math.max(0, Math.ceil((e.reset - Date.now()) / 1000)) : 0 }; }
}

function createApp(db, opts = {}) {
  const log = opts.log ? (...a) => console.log(...a) : () => {};
  // ---- observability: counters and a latency histogram, exposed in Prometheus text format at /metrics ----
  const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];
  const counters = new Map(); // "name{labels}" -> number
  const inc = (name, labels = '', by = 1) => { const k = `${name}${labels ? `{${labels}}` : ''}`; counters.set(k, (counters.get(k) || 0) + by); };
  const hist = new Map(); // route -> { counts[], sum, n }
  const observe = (route, seconds) => {
    let h = hist.get(route); if (!h) { h = { counts: BUCKETS.map(() => 0), sum: 0, n: 0 }; hist.set(route, h); }
    h.n++; h.sum += seconds; BUCKETS.forEach((b, i) => { if (seconds <= b) h.counts[i]++; });
  };
  let draining = false;
  const startedAt = Date.now();
  const limiter = new RateLimiter();
  const streams = new Map(); // documentId -> Set<client>

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, display_name FROM users WHERE id = ?'),
    users: db.prepare('SELECT id, username, display_name FROM users ORDER BY display_name'),
    insUser: db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?,?,?) RETURNING id'),
    newSession: db.prepare('INSERT INTO sessions (token, user_id) VALUES (?,?)'),
    session: db.prepare(`SELECT user_id FROM sessions WHERE token = ? AND created_at > datetime('now', '-${LIMITS.sessionDays} days')`),
    delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    purgeSessions: db.prepare(`DELETE FROM sessions WHERE created_at <= datetime('now', '-${LIMITS.sessionDays} days')`),
    owned: db.prepare(`SELECT d.id, d.title, d.preview, d.words, d.thumb, d.updated_at, d.source_file, d.version, u.display_name AS owner_name, ub.display_name AS updated_by_name FROM documents d JOIN users u ON u.id = d.owner_id LEFT JOIN users ub ON ub.id = d.updated_by WHERE d.owner_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id DESC LIMIT 1000`),
    shared: db.prepare(`SELECT d.id, d.title, d.preview, d.words, d.thumb, d.updated_at, d.source_file, d.version, u.display_name AS owner_name, ub.display_name AS updated_by_name, s.role, s.seen FROM shares s JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = d.owner_id LEFT JOIN users ub ON ub.id = d.updated_by WHERE s.user_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id DESC LIMIT 1000`),
    ownedFull: db.prepare(`SELECT d.id, d.title, d.content, d.updated_at, d.source_file, d.version, u.display_name AS owner_name, ub.display_name AS updated_by_name FROM documents d JOIN users u ON u.id = d.owner_id LEFT JOIN users ub ON ub.id = d.updated_by WHERE d.owner_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id DESC LIMIT 1000`),
    sharedFull: db.prepare(`SELECT d.id, d.title, d.content, d.updated_at, d.source_file, d.version, u.display_name AS owner_name, ub.display_name AS updated_by_name, s.role, s.seen FROM shares s JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = d.owner_id LEFT JOIN users ub ON ub.id = d.updated_by WHERE s.user_id = ? AND d.deleted_at IS NULL ORDER BY d.updated_at DESC, d.id DESC LIMIT 1000`),
    doc: db.prepare('SELECT d.*, u.display_name AS owner_name, ub.display_name AS updated_by_name FROM documents d JOIN users u ON u.id = d.owner_id LEFT JOIN users ub ON ub.id = d.updated_by WHERE d.id = ?'),
    shareRole: db.prepare('SELECT role FROM shares WHERE document_id = ? AND user_id = ?'),
    shareList: db.prepare('SELECT s.user_id, s.role, u.username, u.display_name FROM shares s JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY u.display_name'),
    insDoc: db.prepare('INSERT INTO documents (owner_id, title, content, source_file, updated_by, preview, words, thumb) VALUES (?,?,?,?,?,?,?,?) RETURNING id'),
    updDoc: db.prepare("UPDATE documents SET title = ?, content = ?, preview = ?, words = ?, thumb = ?, version = version + 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?"),
    delDoc: db.prepare('DELETE FROM documents WHERE id = ?'),
    byToken: db.prepare('SELECT d.id, d.title, d.content, d.settings, d.updated_at, u.display_name AS owner_name FROM documents d JOIN users u ON u.id = d.owner_id WHERE d.link_token = ? AND d.deleted_at IS NULL'),
    starred: db.prepare('SELECT document_id FROM stars WHERE user_id = ?'),
    star: db.prepare('INSERT OR IGNORE INTO stars (user_id, document_id) VALUES (?, ?)'),
    unstar: db.prepare('DELETE FROM stars WHERE user_id = ? AND document_id = ?'),
    ftsDel: db.prepare('DELETE FROM doc_fts WHERE rowid = ?'),
    ftsIns: db.prepare('INSERT INTO doc_fts (rowid, title, body) VALUES (?, ?, ?)'),
    // Search restricts to the user's own and shared rowids BEFORE ranking (a global MATCH ranked every user's matches: ~300 ms at 50k documents),
    // then drops trashed rows and computes snippets for the few survivors only.
    searchIds: db.prepare(`SELECT rowid AS id FROM doc_fts WHERE doc_fts MATCH ? AND rowid IN (SELECT id FROM documents WHERE owner_id = ? UNION ALL SELECT document_id FROM shares WHERE user_id = ?) LIMIT 300`),
    liveIds: db.prepare('SELECT id FROM documents WHERE deleted_at IS NULL AND id IN (SELECT value FROM json_each(?))'),
    snippets: db.prepare(`SELECT rowid AS id, snippet(doc_fts, 1, '[[', ']]', '…', 14) AS snip FROM doc_fts WHERE doc_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`),
    idemGet: db.prepare('SELECT fingerprint, state, status, body FROM idempotency WHERE user_id = ? AND key = ?'),
    idemClaim: db.prepare("INSERT OR IGNORE INTO idempotency (user_id, key, fingerprint, state) VALUES (?, ?, ?, 'running')"),
    idemDone: db.prepare("UPDATE idempotency SET state = 'done', status = ?, body = ? WHERE user_id = ? AND key = ?"),
    idemDrop: db.prepare('DELETE FROM idempotency WHERE user_id = ? AND key = ?'),
    idemPurge: db.prepare("DELETE FROM idempotency WHERE created_at <= datetime('now', '-1 hour')"),
    quota: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(content)), 0) AS bytes FROM documents WHERE owner_id = ?'),
    setSettings: db.prepare('UPDATE documents SET settings = ? WHERE id = ?'),
    setToken: db.prepare('UPDATE documents SET link_token = ? WHERE id = ?'),
    softDel: db.prepare("UPDATE documents SET deleted_at = datetime('now') WHERE id = ?"),
    undelete: db.prepare('UPDATE documents SET deleted_at = NULL WHERE id = ?'),
    trash: db.prepare('SELECT d.id, d.title, d.preview, d.words, d.deleted_at, d.source_file FROM documents d WHERE d.owner_id = ? AND d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC, d.id DESC LIMIT 1000'),
    purgeTrash: db.prepare(`DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-${LIMITS.trashDays} days')`),
    upsertShare: db.prepare('INSERT INTO shares (document_id, user_id, role, seen) VALUES (?,?,?,0) ON CONFLICT(document_id, user_id) DO UPDATE SET role = excluded.role'),
    markSeen: db.prepare('UPDATE shares SET seen = 1 WHERE document_id = ? AND user_id = ? AND seen = 0'),
    delShare: db.prepare('DELETE FROM shares WHERE document_id = ? AND user_id = ?'),
    lastVersion: db.prepare('SELECT id, version, author_id, label, (strftime(\'%s\',\'now\') - strftime(\'%s\', updated_at)) AS age FROM doc_versions WHERE document_id = ? ORDER BY id DESC LIMIT 1'),
    insVersion: db.prepare('INSERT INTO doc_versions (document_id, version, title, content, author_id) VALUES (?,?,?,?,?)'),
    setLabel: db.prepare('UPDATE doc_versions SET label = ? WHERE id = ? AND document_id = ?'),
    countLabels: db.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE document_id = ? AND label IS NOT NULL'),
    updVersion: db.prepare("UPDATE doc_versions SET version = ?, title = ?, content = ?, updated_at = datetime('now') WHERE id = ?"),
    pruneVersions: db.prepare(`DELETE FROM doc_versions WHERE document_id = ? AND label IS NULL AND id NOT IN (SELECT id FROM doc_versions WHERE document_id = ? ORDER BY id DESC LIMIT ${LIMITS.versionsPerDoc})`),
    versions: db.prepare('SELECT v.id, v.version, v.title, v.label, v.updated_at, u.display_name AS author_name FROM doc_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.document_id = ? ORDER BY v.id DESC'),
    version: db.prepare('SELECT v.*, u.display_name AS author_name FROM doc_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.id = ? AND v.document_id = ?'),
    comments: db.prepare('SELECT c.id, c.body, c.quote, c.parent_id, c.resolved, c.created_at, c.author_id, u.display_name AS author_name FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.document_id = ? ORDER BY c.id'),
    comment: db.prepare('SELECT c.id, c.body, c.quote, c.parent_id, c.resolved, c.created_at, c.author_id, c.document_id, u.display_name AS author_name FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ? AND c.document_id = ?'),
    commentCount: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE document_id = ?'),
    insComment: db.prepare('INSERT INTO comments (document_id, author_id, body, quote, parent_id) VALUES (?,?,?,?,?) RETURNING id'),
    setResolved: db.prepare('UPDATE comments SET resolved = ? WHERE id = ?'),
    delComment: db.prepare('DELETE FROM comments WHERE id = ?'),
  };
  const purgeExpired = () => {
    try {
      db.prepare(`DELETE FROM doc_fts WHERE rowid IN (SELECT id FROM documents WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', '-${LIMITS.trashDays} days'))`).run(); // purged text must leave the search index too
      q.purgeSessions.run(); q.purgeTrash.run();
    } catch (e) { if (!/closed|not open/i.test(String(e && e.message))) console.error(JSON.stringify({ level: 'error', msg: 'purge failed', error: String(e && e.message) })); }
  };
  purgeExpired();
  const purgeTimer = setInterval(() => { purgeExpired(); try { q.idemPurge.run(); } catch { /* closing */ } }, 3600 * 1000); // trash after 30 days, idempotency keys after an hour
  purgeTimer.unref();

  // ---- helpers -------------------------------------------------------------------
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
  const currentUser = (req) => {
    const token = cookies(req).sid;
    if (!token) return null;
    const s = q.session.get(token);
    return s ? q.userById.get(s.user_id) : null;
  };
  const requireUser = (req) => {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Please sign in');
    return u;
  };
  // IPv6 clients are limited per /64 (a single subscriber owns that whole range, so rotating addresses must not reset a limiter)
  const prefix64 = (ip) => (ip.includes(':') && !ip.startsWith('::ffff:') ? ip.split(':').slice(0, 4).join(':') : ip);
  const clientIp = (req) => prefix64((opts.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '') || req.socket.remoteAddress || 'unknown');
  const isHttps = (req) => opts.secureCookies ?? (req.headers['x-forwarded-proto'] === 'https');
  const cookieHeader = (req, token, maxAge) => `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

  function roleFor(doc, user) {
    if (doc.owner_id === user.id) return 'owner';
    const s = q.shareRole.get(doc.id, user.id);
    return s ? s.role : null;
  }
  const RANK = { viewer: 1, editor: 2, owner: 3 };
  function loadDoc(idStr, user, need = 'viewer') {
    const id = Number(idStr);
    let doc = Number.isSafeInteger(id) ? q.doc.get(id) : null;
    if (doc && doc.deleted_at) doc = null; // documents in the trash are invisible to everyone but the owner's Trash view
    const role = doc ? roleFor(doc, user) : null;
    if (!doc || !role) throw new HttpError(404, 'Document not found');
    if (RANK[role] < RANK[need]) throw new HttpError(403, need === 'owner' ? 'Only the owner can do that' : 'You have view-only access to this document');
    return { doc, role };
  }
  const cleanTitle = (t) => {
    if (t !== undefined && t !== null && typeof t !== 'string') throw new HttpError(400, 'Title must be text');
    const title = String(t ?? '').replace(/\s+/g, ' ').trim();
    if (!title) throw new HttpError(400, 'Title is required');
    if (title.length > LIMITS.title) throw new HttpError(400, `Title must be ${LIMITS.title} characters or fewer`);
    return title;
  };
  // Pictures are stored inline as data URLs: they count towards a larger total, text towards the usual limit.
  const checkSize = (html, message) => {
    const pics = html.match(/<img src="data:[^"]*"/g) || [];
    if (pics.length > LIMITS.images) throw new HttpError(413, `A document can hold up to ${LIMITS.images} pictures`);
    const textLen = html.length - pics.reduce((n, p) => n + p.length, 0);
    if (textLen > LIMITS.content || html.length > LIMITS.contentWithImages) throw new HttpError(413, message);
    return html;
  };
  // A self-registered user cannot fill the disk: bounded document count and total size per user.
  const checkQuota = (userId, addBytes = 0) => {
    const u = q.quota.get(userId);
    if (u.n >= LIMITS.docsPerUser) throw new HttpError(409, `You have reached the limit of ${LIMITS.docsPerUser} documents. Delete some (and empty the trash) to create more.`);
    if (u.bytes + addBytes > LIMITS.bytesPerUser) throw new HttpError(409, 'You have reached your storage limit. Delete some documents (and empty the trash) first.');
  };
  const cleanContent = (c) => {
    if (typeof c !== 'string') throw new HttpError(400, 'Content must be text');
    if (c.length > LIMITS.contentWithImages + 600_000) throw new HttpError(413, 'Document is too large');
    if (c.length > LIMITS.content * 2 && c.replace(/<img\b[^>]{0,2000000}>/gi, '').length > LIMITS.content * 2) throw new HttpError(413, 'Document is too large'); // refuse before the expensive sanitising pass
    return checkSize(sanitizeHtml(c), 'Document is too large');
  };
  const indexDoc = (id, title, content) => { q.ftsDel.run(id); q.ftsIns.run(id, title, htmlToText(content).slice(0, 200000)); };
  const wordCount = (html) => { const t = htmlToText(html).trim(); return t ? t.split(/\s+/).length : 0; };
  const preview = (html) => htmlToText(html).replace(/\s+/g, ' ').trim().slice(0, 140) || (html.includes('<img ') ? '[Picture]' : '');
  const listItem = (d, role) => ({ unseen: role !== 'owner' && !d.seen, id: d.id, title: d.title, updated_at: d.updated_at, source_file: d.source_file, owner_name: d.owner_name, updated_by_name: d.updated_by_name, role, preview: d.preview ?? (d.content ? preview(d.content) : ''), words: d.words ?? (d.content ? wordCount(d.content) : 0), thumb: d.thumb || '' });
  const publicDoc = (doc, role) => ({
    id: doc.id, title: doc.title, content: doc.content, role, owner_name: doc.owner_name, source_file: doc.source_file,
    version: doc.version, updated_at: doc.updated_at, updated_by_name: doc.updated_by_name, words: wordCount(doc.content),
    shares: role === 'owner' ? q.shareList.all(doc.id) : undefined,
    link_token: role === 'owner' ? doc.link_token : undefined,
    settings: parseStored(doc.settings),
  });

  // ---- live updates (server-sent events) ------------------------------------------
  const userStreams = new Map(); // userId -> open stream count (O(1) per-user cap)
  const MAX_BACKLOG = 1024 * 1024; // a client that has not read 1 MB is dropped; EventSource reconnects and refetches
  const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const sseSend = (c, frame) => {
    try {
      if (c.res.writableLength > MAX_BACKLOG) { c.res.destroy(); return; }
      c.res.write(frame);
    } catch { /* closed */ }
  };
  const sseWrite = (c, event, data) => sseSend(c, sseFrame(event, data));
  function presenceOf(docId) {
    const seen = new Map();
    for (const c of streams.get(docId) || []) seen.set(c.user.id, { id: c.user.id, name: c.user.display_name });
    return [...seen.values()];
  }
  function broadcast(docId, event, data, { exceptUserId } = {}) {
    const frame = sseFrame(event, data); // serialised once, written to every client
    for (const c of streams.get(docId) || []) if (c.user.id !== exceptUserId) sseSend(c, frame);
  }
  // Large documents are announced with `refetch`; viewers then download the whole document, so announcements are
  // limited to one per second per document (the latest one wins) to avoid a thundering herd of downloads.
  const refetchGate = new Map(); // docId -> { timer, pending }
  function sendRefetch(docId, upd, except) {
    const g = refetchGate.get(docId);
    if (g) { g.pending = [upd, except]; return; }
    broadcast(docId, 'update', upd, except);
    const gate = { pending: null, timer: null };
    gate.timer = setTimeout(() => {
      refetchGate.delete(docId);
      if (gate.pending) sendRefetch(docId, ...gate.pending);
    }, 1000);
    gate.timer.unref?.();
    refetchGate.set(docId, gate);
  }
  const presenceTimers = new Map(); // coalesce bursts of joins and leaves into one broadcast
  function broadcastPresence(docId) {
    if (presenceTimers.has(docId)) return;
    const t = setTimeout(() => { presenceTimers.delete(docId); if (streams.has(docId)) broadcast(docId, 'presence', { users: presenceOf(docId) }); }, 120);
    t.unref?.();
    presenceTimers.set(docId, t);
  }
  function kick(docId, userId, reason) {
    for (const c of [...(streams.get(docId) || [])]) if (c.user.id === userId) { sseWrite(c, 'revoked', { reason }); c.res.end(); }
  }

  function saveVersionSnapshot(doc, user, { force = false } = {}) {
    const last = q.lastVersion.get(doc.id);
    if (!force && last && last.version > 1 && last.author_id === user.id && !last.label && Number(last.age) < LIMITS.versionCoalesceSeconds) q.updVersion.run(doc.version, doc.title, doc.content, last.id);
    else q.insVersion.run(doc.id, doc.version, doc.title, doc.content, user.id);
    q.pruneVersions.run(doc.id, doc.id);
  }
  function applyChange(doc, user, title, content, { forceSnapshot = false, notifyAll = false } = {}) {
    if (title === doc.title && content === doc.content) return { changed: false, doc };
    db.exec('BEGIN IMMEDIATE');
    try {
      q.updDoc.run(title, content, preview(content), wordCount(content), makeThumb(content), user.id, doc.id);
      indexDoc(doc.id, title, content);
      const fresh = q.doc.get(doc.id);
      saveVersionSnapshot(fresh, user, { force: forceSnapshot });
      inc('doc_saves_total');
      db.exec('COMMIT');
      const upd = { version: fresh.version, title: fresh.title, ...(fresh.content.length > LIMITS.pushContent ? { refetch: true } : { content: fresh.content }), updated_by_id: user.id, updated_by_name: user.display_name, updated_at: fresh.updated_at, words: wordCount(fresh.content) };
      const except = { exceptUserId: notifyAll ? undefined : user.id };
      if (!upd.refetch) broadcast(doc.id, 'update', upd, except);
      else sendRefetch(doc.id, upd, except);
      return { changed: true, doc: fresh };
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // ---- body parsing --------------------------------------------------------------
  async function readJson(req) {
    if (req.parsedJson !== undefined) return req.parsedJson;
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (Number(req.headers['content-length']) > LIMITS.body) throw new HttpError(413, 'Request is too large');
    if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > LIMITS.body) throw new HttpError(413, 'Request is too large');
      chunks.push(c);
    }
    if (!size) { req.parsedJson = {}; return {}; }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Expected a JSON object');
    req.parsedJson = parsed;
    return parsed;
  }

  // ---- routes ----------------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler, status) => routes.push({ method, pattern: pattern.replace(/\(\\d\+\)/g, ':id').replace(/\(\[A-Za-z0-9_-\]\{16,64\}\)/, ':token'), re: new RegExp(`^${pattern}$`), handler, status });

  route('GET', '/healthz', async () => ({ ok: true, uptime: Math.round(process.uptime()) }));
  // readiness: can we reach the database, and are we still accepting work (503 once shutdown has begun)
  route('GET', '/readyz', async () => {
    if (draining) throw new HttpError(503, 'Shutting down');
    try { db.prepare('SELECT 1').get(); } catch { throw new HttpError(503, 'Database unavailable'); }
    return { ready: true };
  });
  route('GET', '/metrics', async (req, res) => {
    // loopback only, or a bearer token (METRICS_TOKEN) so a scraper can reach it without exposing it to users
    const ip = req.socket.remoteAddress || '';
    const token = opts.metricsToken || process.env.METRICS_TOKEN;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const local = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip) && !req.headers['x-forwarded-for'];
    const okToken = Boolean(token) && crypto.timingSafeEqual(crypto.createHash('sha256').update(bearer).digest(), crypto.createHash('sha256').update(token).digest());
    if (!local && !okToken) throw new HttpError(404, 'Not found');
    let sse = 0; for (const set of streams.values()) sse += set.size;
    const lines = ['# TYPE http_requests_total counter', ...[...counters].filter(([k]) => k.startsWith('http_requests_total')).map(([k, v]) => `${k} ${v}`),
      '# TYPE docs_events_total counter', ...[...counters].filter(([k]) => !k.startsWith('http_requests_total')).map(([k, v]) => `${k} ${v}`),
      '# TYPE http_request_duration_seconds histogram'];
    for (const [r, h] of hist) {
      BUCKETS.forEach((b, i) => lines.push(`http_request_duration_seconds_bucket{route="${r}",le="${b}"} ${h.counts[i]}`));
      lines.push(`http_request_duration_seconds_bucket{route="${r}",le="+Inf"} ${h.n}`, `http_request_duration_seconds_sum{route="${r}"} ${h.sum.toFixed(6)}`, `http_request_duration_seconds_count{route="${r}"} ${h.n}`);
    }
    const mem = process.memoryUsage();
    lines.push('# TYPE sse_clients gauge', `sse_clients ${sse}`, `sse_documents ${streams.size}`, '# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`, `process_heap_used_bytes ${mem.heapUsed}`,
      '# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
    return { raw: Buffer.from(`${lines.join('\n')}\n`), type: 'text/plain; version=0.0.4; charset=utf-8' };
  });

  const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
  const startSession = (req, res, user) => {
    const token = crypto.randomBytes(24).toString('hex');
    q.newSession.run(token, user.id);
    res.setHeader('Set-Cookie', cookieHeader(req, token, LIMITS.sessionDays * 86400));
  };
  route('POST', '/api/login', async (req, res) => {
    const { username, password } = await readJson(req);
    const name = String(username || '').toLowerCase().trim().slice(0, 40); // never let a request choose the size of a limiter key
    if (limiter.hit(`loginip:${clientIp(req)}`, 60, 10 * 60 * 1000)) throw new HttpError(429, 'Too many attempts from this address. Try again later.', { retryAfter: 600 }); // spraying many usernames from one address
    const key = `login:${clientIp(req)}:${name}`;
    const wait = limiter.hit(key, 8, 10 * 60 * 1000);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, { retryAfter: wait });
    const u = q.userByName.get(name);
    if (!(await verifyPasswordAsync(String(password || ''), u && u.password_hash)) || !u) throw new HttpError(401, 'Wrong username or password');
    limiter.clear(key);
    startSession(req, res, u);
    return { id: u.id, username: u.username, display_name: u.display_name };
  }, 200);
  route('POST', '/api/register', async (req, res) => {
    const { username, display_name, password } = await readJson(req);
    const wait = limiter.hit(`register:${clientIp(req)}`, opts.registerRateLimit ?? 10, 60 * 60 * 1000);
    if (wait) throw new HttpError(429, 'Too many sign-ups from this address. Try again later.', { retryAfter: wait });
    const name = String(username || '').toLowerCase().trim();
    if (!USERNAME_RE.test(name)) throw new HttpError(400, 'Username must be 3-24 characters: lowercase letters, numbers or underscore');
    const display = String(display_name || '').replace(/\s+/g, ' ').trim();
    if (!display || display.length > 60) throw new HttpError(400, 'Display name is required (60 characters max)');
    const pw = String(password || '');
    if (pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (pw.length > 200) throw new HttpError(400, 'Password is too long');
    if (q.userByName.get(name)) throw new HttpError(409, 'That username is taken');
    const hash = await hashPasswordAsync(pw);
    let id;
    try { ({ id } = q.insUser.get(name, display, hash)); } catch (e) { if (/UNIQUE/i.test(String(e && e.message))) throw new HttpError(409, 'That username is taken'); throw e; } // two sign-ups racing for one name
    const user = q.userById.get(id);
    startSession(req, res, user);
    return user;
  }, 201);
  route('POST', '/api/logout', async (req, res) => {
    const t = cookies(req).sid;
    if (t) { const u = currentUser(req); q.delSession.run(t); if (u) for (const set of streams.values()) for (const c of [...set]) if (c.user.id === u.id) { try { c.res.end(); } catch { /* closed */ } set.delete(c); } } // live streams must not outlive the session
    res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
    return { ok: true };
  }, 200);
  route('GET', '/api/me', async (req) => requireUser(req));
  // Same as /api/me but answers 200 with { user: null } when signed out, so the page load never logs a 401.
  route('GET', '/api/session', async (req) => ({ user: currentUser(req) }));
  route('GET', '/api/users', async (req) => { const me = requireUser(req); return q.users.all().filter((u) => u.id !== me.id); });

  route('GET', '/api/documents', async (req) => {
    const me = requireUser(req);
    const term = String(new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
    const match = (d) => !term || d.title.toLowerCase().includes(term) || String(d.preview || '').toLowerCase().includes(term) || htmlToText(d.content || '').toLowerCase().includes(term);
    let hits = null; // id -> highlighted snippet, from the full-text index (needs 3+ characters)
    if (term.length >= 3) { try { const match = `"${term.replace(/"/g, '""')}"`; const ids = q.searchIds.all(match, me.id, me.id).map((r) => r.id); const live = ids.length ? q.liveIds.all(JSON.stringify(ids)).map((r) => r.id) : []; hits = new Map((live.length ? q.snippets.all(match, JSON.stringify(live)) : []).map((r) => [r.id, r.snip])); } catch { hits = null; } }
    const stars = new Set(q.starred.all(me.id).map((r) => r.document_id));
    const mark = (item) => ({ ...item, starred: stars.has(item.id), ...(hits && hits.get(item.id) ? { snippet: hits.get(item.id) } : {}) });
    const keep = (d) => (hits ? hits.has(d.id) || d.title.toLowerCase().includes(term) : match(d));
    return {
      owned: q.owned.all(me.id).filter(keep).map((d) => mark(listItem(d, 'owner'))),
      shared: q.shared.all(me.id).filter(keep).map((d) => mark(listItem(d, d.role))),
    };
  });
  route('POST', '/api/documents', async (req) => {
    const me = requireUser(req);
    const body = await readJson(req);
    const title = cleanTitle(body.title ?? 'Untitled document');
    const content = body.content === undefined ? '<p><br></p>' : cleanContent(body.content) || '<p><br></p>';
    checkQuota(me.id, content.length); // optional starter content (templates)
    const { id } = q.insDoc.get(me.id, title, content, null, me.id, preview(content), wordCount(content), makeThumb(content));
    indexDoc(id, title, content);
    const doc = q.doc.get(id);
    q.insVersion.run(id, 1, doc.title, doc.content, me.id);
    return publicDoc(doc, 'owner');
  }, 201);
  // Shared by "import as new document" and "insert into this document".
  function convertUpload({ filename, content, content_base64: b64 }) {
    const name = String(filename || '').trim();
    const ext = path.extname(name).toLowerCase();
    if (!IMPORT_TYPES.includes(ext)) throw new HttpError(400, `Unsupported file type. Upload ${IMPORT_TYPES.join(', ')}`);
    let html;
    if (ext === '.docx') {
      if (typeof b64 !== 'string' || !b64) throw new HttpError(400, 'The file is empty');
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > LIMITS.importDocx) throw new HttpError(413, 'File is too large (2 MB max)');
      try { html = docxToHtml(buf); } catch (e) { throw new HttpError(400, e.message || 'Could not read that .docx file'); }
    } else {
      if (typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'The file is empty');
      if (content.length > LIMITS.importText) throw new HttpError(413, 'File is too large (1 MB max)');
      html = sanitizeHtml(ext === '.txt' ? textToHtml(content) : markdownToHtml(content));
    }
    if (!htmlToText(html).trim() && !html.includes('<img ')) throw new HttpError(400, 'No readable text was found in that file');
    checkSize(html, 'The converted document is too large');
    return { html, name, ext };
  }
  route('POST', '/api/documents/import', async (req) => {
    const me = requireUser(req);
    const { html, name, ext } = convertUpload(await readJson(req));
    const title = cleanTitle(path.basename(name).slice(0, -ext.length).slice(0, LIMITS.title) || 'Imported document');
    checkQuota(me.id, html.length);
    const { id } = q.insDoc.get(me.id, title, html, name.slice(0, 255), me.id, preview(html), wordCount(html), makeThumb(html));
    indexDoc(id, title, html);
    const doc = q.doc.get(id);
    q.insVersion.run(id, 1, doc.title, doc.content, me.id);
    return publicDoc(doc, 'owner');
  }, 201);
  // Convert an uploaded file to editor HTML without saving anything (used to insert a file into an open document).
  route('POST', '/api/convert', async (req) => {
    requireUser(req);
    const { html, name } = convertUpload(await readJson(req));
    return { html, filename: name };
  }, 200);

  route('GET', '/api/documents/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    const { doc, role } = loadDoc(m[1], me);
    if (role !== 'owner') q.markSeen.run(doc.id, me.id); // opening a shared document clears its "New" marker
    return publicDoc(doc, role);
  });
  route('PATCH', '/api/documents/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    loadDoc(m[1], me, 'editor'); // reject early
    const wwait = limiter.hit(`write:${me.id}`, opts.writeRateLimit ?? 300, 60 * 1000); // autosave is about 85 a minute, so this only stops abuse (large bodies are costly to sanitise)
    if (wwait) throw new HttpError(429, 'You are saving too fast. Please wait a moment.', { retryAfter: wwait });
    const body = await readJson(req);
    const { doc } = loadDoc(m[1], me, 'editor'); // read AFTER the upload: the version and access are checked and used in the same tick
    if ((body.content !== undefined || body.title !== undefined) && body.base_version === undefined) throw new HttpError(428, 'base_version is required: send the version you are editing, so concurrent changes are never overwritten silently');
    if (body.base_version !== undefined && body.base_version !== doc.version) {
      inc('doc_conflicts_total');
      throw new HttpError(409, `${doc.updated_by_name || 'Someone'} changed this document since you opened it`, {
        conflict: { version: doc.version, title: doc.title, content: doc.content, updated_by_id: doc.updated_by, updated_by_name: doc.updated_by_name, updated_at: doc.updated_at },
      });
    }
    const title = body.title === undefined ? doc.title : cleanTitle(body.title);
    const content = body.content === undefined ? doc.content : cleanContent(body.content);
    const { doc: saved, changed } = applyChange(doc, me, title, content);
    return { ok: true, changed, version: saved.version, updated_at: saved.updated_at, words: wordCount(saved.content), content: changed && content !== body.content ? saved.content : undefined };
  });
  route('DELETE', '/api/documents/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'owner');
    for (const c of [...(streams.get(doc.id) || [])]) { sseWrite(c, 'revoked', { reason: 'This document was deleted' }); c.res.end(); }
    q.softDel.run(doc.id);
    return { ok: true, trashed: true };
  });
  // ---- trash: deleting moves a document here for 30 days; only its owner can see, restore or erase it ----
  const trashed = (idStr, user) => {
    const id = Number(idStr);
    const doc = Number.isSafeInteger(id) ? q.doc.get(id) : null;
    if (!doc || !doc.deleted_at || doc.owner_id !== user.id) throw new HttpError(404, 'Document not found in the trash');
    return doc;
  };
  route('GET', '/api/trash', async (req) => {
    const me = requireUser(req);
    return q.trash.all(me.id).map((d) => ({ id: d.id, title: d.title, deleted_at: d.deleted_at, source_file: d.source_file, preview: d.preview, words: d.words, days_left: LIMITS.trashDays }));
  });
  route('POST', '/api/trash/(\\d+)/restore', async (req, res, m) => {
    const me = requireUser(req);
    const doc = trashed(m[1], me);
    q.undelete.run(doc.id);
    return publicDoc(q.doc.get(doc.id), 'owner');
  });
  route('DELETE', '/api/trash/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    const doc = trashed(m[1], me);
    q.delDoc.run(doc.id);
    q.ftsDel.run(doc.id); // erased means gone, including from the search index
    return { ok: true };
  });

  route('POST', '/api/documents/(\\d+)/duplicate', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    checkQuota(me.id, doc.content.length);
    const { id } = q.insDoc.get(me.id, `Copy of ${doc.title}`.slice(0, LIMITS.title), doc.content, doc.source_file, me.id, doc.preview, doc.words, doc.thumb);
    indexDoc(id, `Copy of ${doc.title}`.slice(0, LIMITS.title), doc.content);
    if (doc.settings) q.setSettings.run(doc.settings, id);
    const copy = q.doc.get(id);
    q.insVersion.run(id, 1, copy.title, copy.content, me.id);
    return publicDoc(copy, 'owner');
  }, 201);

  const EXPORTS = {
    docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', render: (d) => htmlToDocx(d.content, d.title, parseStored(d.settings)) },
    md: { type: 'text/markdown; charset=utf-8', render: (d) => `# ${d.title}\n\n${toMarkdown(d.content)}` },
    html: { type: 'text/html; charset=utf-8', render: (d) => toStandaloneHtml(d.title, d.content, pageCss(parseStored(d.settings))) },
    txt: { type: 'text/plain; charset=utf-8', render: (d) => `${d.title}\n\n${toText(d.content)}` },
  };
  route('GET', '/api/documents/(\\d+)/export', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    const format = String(new URL(req.url, 'http://x').searchParams.get('format') || 'docx').toLowerCase();
    const ex = Object.hasOwn(EXPORTS, format) ? EXPORTS[format] : null; // not the prototype chain ("constructor", "__proto__")
    if (!ex) throw new HttpError(400, `Unknown format. Use ${Object.keys(EXPORTS).join(', ')}`);
    const base = (doc.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80)) || 'document';
    return { raw: Buffer.from(ex.render(doc)), type: ex.type, headers: { 'Content-Disposition': `attachment; filename="${base}.${format}"` } };
  });

  route('GET', '/api/documents/(\\d+)/versions', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    return q.versions.all(doc.id);
  });
  route('GET', '/api/documents/(\\d+)/versions/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    const v = q.version.get(Number(m[2]), doc.id);
    if (!v) throw new HttpError(404, 'Version not found');
    return { id: v.id, version: v.version, title: v.title, label: v.label, content: v.content, author_name: v.author_name, updated_at: v.updated_at };
  });
  // Name a version ("Sent to legal"): named versions are never merged with later edits and never pruned.
  route('PUT', '/api/documents/(\\d+)/versions/(\\d+)/label', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'editor');
    const v = q.version.get(Number(m[2]), doc.id);
    if (!v) throw new HttpError(404, 'Version not found');
    const body = await readJson(req);
    const label = body.label === null || body.label === undefined ? '' : body.label;
    if (typeof label !== 'string') throw new HttpError(400, 'The name must be text');
    const name = label.replace(/\s+/g, ' ').trim();
    if (name.length > LIMITS.versionLabel) throw new HttpError(400, `Names are limited to ${LIMITS.versionLabel} characters`);
    if (name && !v.label && q.countLabels.get(doc.id).n >= LIMITS.namedVersions) throw new HttpError(409, `A document can have up to ${LIMITS.namedVersions} named versions`);
    q.setLabel.run(name || null, v.id, doc.id);
    return q.versions.all(doc.id);
  });
  route('POST', '/api/documents/(\\d+)/versions/(\\d+)/restore', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'editor');
    const v = q.version.get(Number(m[2]), doc.id);
    if (!v) throw new HttpError(404, 'Version not found');
    const { doc: saved } = applyChange(doc, me, v.title, cleanContent(v.content), { forceSnapshot: true, notifyAll: true }); // old rows may predate today's sanitiser
    return publicDoc(saved, roleFor(saved, me));
  }, 200);

  // ---- comments: anyone who can open the document can read and add; the author or owner can delete; editors can resolve ----
  const publicComment = (c) => ({ id: c.id, body: c.body, quote: c.quote || null, parent_id: c.parent_id || null, resolved: Boolean(c.resolved), created_at: c.created_at, author_id: c.author_id, author_name: c.author_name || 'Deleted user' });
  route('GET', '/api/documents/(\\d+)/comments', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    return q.comments.all(doc.id).map(publicComment);
  });
  route('POST', '/api/documents/(\\d+)/comments', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    const { body, quote, parent_id: parentRaw } = await readJson(req);
    const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) throw new HttpError(400, 'Write something first');
    if (text.length > LIMITS.commentLength) throw new HttpError(400, `Comments are limited to ${LIMITS.commentLength} characters`);
    if (q.commentCount.get(doc.id).n >= LIMITS.commentsPerDoc) throw new HttpError(409, 'This document has reached its comment limit');
    const q1 = quote === undefined || quote === null ? '' : String(quote).replace(/\s+/g, ' ').trim();
    if (q1.length > LIMITS.quoteLength) throw new HttpError(400, `The quoted text is limited to ${LIMITS.quoteLength} characters`);
    let parentId = null;
    if (parentRaw !== undefined && parentRaw !== null) { // a reply: the parent must be a top-level comment of this document
      const parent = Number.isSafeInteger(parentRaw) ? q.comment.get(parentRaw, doc.id) : null;
      if (!parent) throw new HttpError(404, 'The comment you are replying to no longer exists');
      if (parent.parent_id) throw new HttpError(400, 'Replies cannot be nested');
      parentId = parent.id;
    }
    const { id } = q.insComment.get(doc.id, me.id, text, parentId ? null : q1 || null, parentId);
    const comment = publicComment(q.comment.get(id, doc.id));
    broadcast(doc.id, 'comment', { type: 'added', comment }, { exceptUserId: me.id });
    return comment;
  }, 201);
  route('PATCH', '/api/documents/(\\d+)/comments/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'editor');
    const c = q.comment.get(Number(m[2]), doc.id);
    if (!c) throw new HttpError(404, 'Comment not found');
    const { resolved } = await readJson(req);
    if (typeof resolved !== 'boolean') throw new HttpError(400, 'resolved must be true or false');
    if (c.parent_id) throw new HttpError(400, 'Resolve the whole conversation, not a single reply');
    q.setResolved.run(resolved ? 1 : 0, c.id);
    const comment = publicComment(q.comment.get(c.id, doc.id));
    broadcast(doc.id, 'comment', { type: 'updated', comment }, { exceptUserId: me.id });
    return comment;
  });
  route('DELETE', '/api/documents/(\\d+)/comments/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    const { doc, role } = loadDoc(m[1], me);
    const c = q.comment.get(Number(m[2]), doc.id);
    if (!c) throw new HttpError(404, 'Comment not found');
    if (c.author_id !== me.id && role !== 'owner') throw new HttpError(403, 'Only the author or the document owner can delete a comment');
    q.delComment.run(c.id);
    broadcast(doc.id, 'comment', { type: 'deleted', comment: { id: c.id } }, { exceptUserId: me.id });
    return { ok: true };
  });

  route('PUT', '/api/documents/(\\d+)/shares', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'owner');
    const { username, role } = await readJson(req);
    if (!['viewer', 'editor'].includes(role)) throw new HttpError(400, 'Role must be viewer or editor');
    const target = q.userByName.get(String(username || '').toLowerCase().trim());
    if (!target) throw new HttpError(404, 'No user with that username');
    if (target.id === me.id) throw new HttpError(400, 'You already own this document');
    q.upsertShare.run(doc.id, target.id, role);
    for (const c of streams.get(doc.id) || []) if (c.user.id === target.id) sseWrite(c, 'role', { role });
    return q.shareList.all(doc.id);
  });
  // Page setup (paper size, orientation, margins, header / footer, page numbers). It is a document property, not content:
  // it does not create a version, but collaborators see the change straight away.
  route('PUT', '/api/documents/(\\d+)/settings', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'editor');
    const body = await readJson(req);
    let settings;
    try { settings = normalizeSettings(body); } catch (e) { throw new HttpError(400, e.message); }
    q.setSettings.run(JSON.stringify(settings), doc.id);
    broadcast(doc.id, 'settings', { settings }, { exceptUserId: me.id });
    return settings;
  });
  // Live selections: relayed to the other people in the document, never stored. A position is a path of child
  // indexes from the editor root plus a character offset; anything malformed is rejected here.
  const goodPos = (p) => p && Array.isArray(p.path) && p.path.length <= 48 && p.path.every((n) => Number.isInteger(n) && n >= 0 && n < 100000) && Number.isInteger(p.offset) && p.offset >= 0 && p.offset < 10_000_000;
  route('POST', '/api/documents/(\\d+)/cursor', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    const body = await readJson(req);
    if (body.clear === true) { broadcast(doc.id, 'cursor', { user_id: me.id, clear: true }, { exceptUserId: me.id }); return { ok: true }; }
    if (!goodPos(body.anchor) || !goodPos(body.focus)) throw new HttpError(400, 'Invalid selection');
    broadcast(doc.id, 'cursor', { user_id: me.id, name: me.display_name, anchor: body.anchor, focus: body.focus }, { exceptUserId: me.id });
    return { ok: true };
  });
  // Stars are private to each user (anyone who can open a document may star it).
  route('PUT', '/api/documents/(\\d+)/star', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    q.star.run(me.id, doc.id);
    return { starred: true };
  });
  route('DELETE', '/api/documents/(\\d+)/star', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me);
    q.unstar.run(me.id, doc.id);
    return { starred: false };
  });
  // "Anyone with the link can view": an unguessable token (144 bits) that grants read-only access to one document.
  route('POST', '/api/documents/(\\d+)/link', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'owner');
    const token = crypto.randomBytes(18).toString('base64url'); // creating again rotates (revokes) the old link
    q.setToken.run(token, doc.id);
    return { link_token: token };
  });
  route('DELETE', '/api/documents/(\\d+)/link', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'owner');
    q.setToken.run(null, doc.id);
    return { link_token: null };
  });
  route('GET', '/api/public/([A-Za-z0-9_-]{16,64})', async (req, res, m) => {
    const doc = q.byToken.get(m[1]);
    if (!doc) throw new HttpError(404, 'This link is no longer available');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return { title: doc.title, content: doc.content, owner_name: doc.owner_name, updated_at: doc.updated_at, settings: parseStored(doc.settings) };
  });
  route('DELETE', '/api/documents/(\\d+)/shares/(\\d+)', async (req, res, m) => {
    const me = requireUser(req);
    const { doc } = loadDoc(m[1], me, 'owner');
    q.delShare.run(doc.id, Number(m[2]));
    kick(doc.id, Number(m[2]), 'Your access to this document was removed');
    return q.shareList.all(doc.id);
  });

  route('GET', '/api/documents/(\\d+)/events', async (req, res, m) => {
    const me = requireUser(req);
    const { doc, role } = loadDoc(m[1], me);
    if ((userStreams.get(me.id) || 0) >= LIMITS.streamsPerUser) throw new HttpError(429, 'Too many open connections');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
    res.write('retry: 3000\n\n');
    const client = { res, user: me };
    if (!streams.has(doc.id)) streams.set(doc.id, new Set());
    streams.get(doc.id).add(client);
    userStreams.set(me.id, (userStreams.get(me.id) || 0) + 1);
    sseWrite(client, 'hello', { role, version: doc.version, users: presenceOf(doc.id) });
    broadcastPresence(doc.id);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
    const cleanup = () => {
      clearInterval(beat);
      if (client.gone) return;
      client.gone = true;
      const n = (userStreams.get(me.id) || 1) - 1;
      if (n > 0) userStreams.set(me.id, n); else userStreams.delete(me.id);
      const set = streams.get(doc.id);
      if (set) { set.delete(client); if (!set.size) streams.delete(doc.id); else broadcastPresence(doc.id); }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return { stream: true };
  });

  // gzip text responses when the client accepts it (static assets are cached compressed by ETag)
  const wantsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const gzipCache = new Map(); // file path -> { etag, buf }

  // ---- static files ----------------------------------------------------------------
  function serveStatic(req, res) {
    const url = new URL(req.url, 'http://x');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end('Bad request'); return; }
    if (rel.endsWith('/')) rel += 'index.html'; // '/' and '/qa/' serve their index page
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }); res.end('Not found'); return;
    }
    const st = fs.statSync(file);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': /\.(png|svg)$/.test(file) ? 'public, max-age=86400' : 'no-cache', ETag: etag, ...SECURITY_HEADERS };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    const compressible = /^(text\/|application\/json|image\/svg)/.test(headers['Content-Type']);
    if (compressible && wantsGzip(req) && st.size > 512) {
      let hit = gzipCache.get(file);
      if (!hit || hit.etag !== etag) { hit = { etag, buf: zlib.gzipSync(fs.readFileSync(file)) }; gzipCache.set(file, hit); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': hit.buf.length });
      res.end(req.method === 'HEAD' ? undefined : hit.buf);
      return;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    require('node:stream').pipeline(fs.createReadStream(file), res, () => {}); // destroys the file stream if the client goes away
  }

  // ---- server ----------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname;
    try { // a malformed request line ("GET // HTTP/1.1") must get a 400, never an unhandled rejection that ends the process
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('bad target');
      pathname = new URL(req.url, 'http://x').pathname;
    } catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }); res.end('Bad request'); return; }
    const incoming = String(req.headers['x-request-id'] || '');
    const requestId = /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID(); // correlate a user's error with a log line
    res.setHeader('X-Request-Id', requestId);
    res.on('finish', () => {
      const ms = Date.now() - started;
      const label = res.routeLabel || (pathname.startsWith('/api/') ? 'unmatched' : 'static');
      if (label !== '/metrics') { inc('http_requests_total', `route="${label}",status="${res.statusCode}"`); observe(label, ms / 1000); }
      if (opts.log) log(JSON.stringify({ ts: new Date().toISOString(), id: requestId, method: req.method, path: pathname.replace(/^\/api\/public\/.*/, '/api/public/[token]'), route: label, status: res.statusCode, ms }));
    });
    if (pathname !== '/healthz' && pathname !== '/readyz' && pathname !== '/metrics' && !pathname.startsWith('/api/')) {
      if (/^\/qa/i.test((() => { try { return decodeURIComponent(pathname); } catch { return pathname; } })()) && process.env.NODE_ENV === 'production' && process.env.QA_PAGE !== '1') { res.writeHead(404); res.end(); return; } // the in-browser test page is for development
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      return serveStatic(req, res);
    }
    const send = (status, body, extra = {}) => {
      const payload = Buffer.from(JSON.stringify(body));
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra };
      // Document reads carry a strong validator: an unchanged (possibly picture-heavy) document costs a 304, not megabytes.
      if (status === 200 && req.method === 'GET' && (res.routeLabel === '/api/documents/:id' || res.routeLabel === '/api/public/:token' || res.routeLabel === '/api/documents')) {
        const etag = `"${crypto.createHash('sha1').update(payload).digest('base64url')}"`;
        headers.ETag = etag; headers['Cache-Control'] = res.routeLabel === '/api/public/:token' ? 'no-store' : 'private, no-cache'; // a revoked public link must not linger in caches
        if (String(req.headers['if-none-match'] || '').split(',').some((t) => t.trim() === etag)) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache', ...SECURITY_HEADERS }); res.end(); return; }
      }
      if (payload.length > 64 * 1024 && wantsGzip(req)) { // big lists: compress on the thread pool, never on the event loop
        zlib.gzip(payload, { level: 3 }, (err, zipped) => {
          if (err || res.destroyed) { if (!res.destroyed) { res.writeHead(status, { ...headers, 'Content-Length': payload.length }); res.end(payload); } return; }
          res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': zipped.length }); res.end(zipped);
        });
      } else if (payload.length > 1024 && wantsGzip(req)) {
        const zipped = zlib.gzipSync(payload);
        res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': zipped.length });
        res.end(zipped);
      } else { res.writeHead(status, { ...headers, 'Content-Length': payload.length }); res.end(payload); }
    };
    try {
      // CSRF defence in depth (cookies are also SameSite=Lax and bodies must be JSON): reject cross-origin writes.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
          let ok = false;
          try { ok = new URL(origin).host === req.headers.host; } catch { /* bad origin */ }
          if (!ok) throw new HttpError(403, 'Cross-origin request blocked');
        }
      }
      // Blanket protection against a single address hammering the API (SSE streams are long-lived, so exempt).
      if (/\/cursor$/.test(pathname)) { // selections are frequent: a separate, generous budget so they never starve real requests
        if (limiter.hit(`cursor:${clientIp(req)}`, 1200, 60 * 1000)) throw new HttpError(429, 'Too many requests. Please slow down.');
      } else if (!/\/events$/.test(pathname) && pathname !== '/healthz' && pathname !== '/readyz' && pathname !== '/metrics') {
        const wait = limiter.hit(`api:${clientIp(req)}`, opts.apiRateLimit ?? 2400, 60 * 1000);
        const rl = limiter.state(`api:${clientIp(req)}`, opts.apiRateLimit ?? 2400);
        res.setHeader('RateLimit-Limit', String(rl.limit)); res.setHeader('RateLimit-Remaining', String(rl.remaining)); res.setHeader('RateLimit-Reset', String(rl.reset)); // IETF draft headers
        if (wait) inc('rate_limited_total');
        if (wait) throw new HttpError(429, 'Too many requests. Please slow down.', { retryAfter: wait });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        res.routeLabel = r.pattern;
        // Idempotency-Key: a retried POST (double click, timeout, offline replay) returns the first response instead of repeating the work.
        const key = req.method === 'POST' ? String(req.headers['idempotency-key'] || '') : '';
        const idemUser = /^[\w-]{8,64}$/.test(key) && /^\/api\/documents(\/import|\/\d+\/duplicate|\/\d+\/comments)?$/.test(pathname) ? currentUser(req) : null; // only routes that create something
        let fp = `${req.method} ${pathname}`;
        if (idemUser) {
          const bodyForKey = await readJson(req); // cached for the handler
          fp += ` ${crypto.createHash('sha256').update(JSON.stringify(bodyForKey)).digest('base64url')}`;
          const prev = q.idemGet.get(idemUser.id, key);
          if (prev) {
            if (prev.fingerprint !== fp) throw new HttpError(422, 'This Idempotency-Key was already used for a different request');
            if (prev.state === 'running') throw new HttpError(409, 'The original request is still being processed');
            inc('idempotent_replays_total');
            return send(prev.status, JSON.parse(prev.body), { 'Idempotent-Replayed': 'true' });
          }
          q.idemClaim.run(idemUser.id, key, fp);
        }
        let out;
        try { out = await r.handler(req, res, m); }
        catch (e) { if (idemUser) q.idemDrop.run(idemUser.id, key); throw e; } // failures are not remembered: the client may retry
        if (idemUser) { { const stored = out && !out.stream && !out.raw ? JSON.stringify(out) : null; if (stored === null || stored.length > 100_000) q.idemDrop.run(idemUser.id, key); else q.idemDone.run(r.status || 200, stored, idemUser.id, key); } }
        if (out && out.stream) return; // SSE handler owns the response
        if (out && out.raw) {
          res.writeHead(200, { 'Content-Type': out.type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...(out.headers || {}) });
          res.end(out.raw);
          return;
        }
        return send(r.status || 200, out);
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message, ...(e.extra || {}) }, e.extra && e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : {});
      console.error(e);
      if (!res.headersSent) send(500, { error: 'Something went wrong' }); else res.end();
    }
  });
  // Begin shutdown: readiness turns 503, event streams are told to reconnect elsewhere and closed.
  server.drain = () => {
    draining = true;
    for (const set of streams.values()) for (const c of set) { sseWrite(c, 'bye', { retry: 2000 }); try { c.res.end(); } catch { /* closed */ } }
    streams.clear();
  };
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000; // longer than a typical load balancer's idle timeout, so it never reuses a closed socket
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    clearInterval(purgeTimer);
    for (const set of streams.values()) for (const c of set) { try { c.res.end(); } catch { /* closed */ } }
    streams.clear();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return origClose(cb);
  };
  return server;
}

module.exports = { createApp, LIMITS };
