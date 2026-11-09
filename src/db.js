'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
// Async variants run scrypt on the libuv thread pool, so a burst of logins never freezes the event loop for everyone else.
const scryptAsync = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));
async function hashPasswordAsync(password, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${(await scryptAsync(password, salt)).toString('hex')}`; }
const DUMMY = `${'0'.repeat(32)}:${'0'.repeat(64)}`;
async function verifyPasswordAsync(password, stored) { // an unknown user costs the same time as a wrong password (no user enumeration by timing)
  const [salt, hash] = String(stored || DUMMY).split(':');
  const test = await scryptAsync(password, salt);
  return Boolean(stored) && crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  const test = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const SCHEMA_VERSION = 14;

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -20000;
    PRAGMA mmap_size = 268435456;
    PRAGMA journal_size_limit = 67108864;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      source_file TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS shares (
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('viewer','editor')),
      seen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (document_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS doc_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stars (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(document_id, id);
    CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(document_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
    CREATE INDEX IF NOT EXISTS idx_docs_owner ON documents(owner_id, updated_at DESC);
  `);
  // Lightweight migrations for databases created by an earlier version of the app.
  // All in one transaction: a crash half way leaves the previous schema, never a mixture.
  db.exec('BEGIN IMMEDIATE');
  try {
  const docCols = columns(db, 'documents');
  if (!docCols.includes('version')) db.exec('ALTER TABLE documents ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  if (!docCols.includes('deleted_at')) db.exec('ALTER TABLE documents ADD COLUMN deleted_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_deleted ON documents(deleted_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_stars_doc ON stars(document_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_docs_trash ON documents(owner_id, deleted_at DESC) WHERE deleted_at IS NOT NULL');
  if (!docCols.includes('preview')) db.exec('ALTER TABLE documents ADD COLUMN preview TEXT');
  const wordsAdded = !docCols.includes('words');
  if (wordsAdded) { db.exec('ALTER TABLE documents ADD COLUMN words INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE documents SET preview = NULL'); } // force the preview / word-count backfill below
  if (!docCols.includes('thumb')) db.exec('ALTER TABLE documents ADD COLUMN thumb TEXT'); // tiny pre-rendered excerpt for the card thumbnail
  { const { makeThumb } = require('./thumb'); const upT = db.prepare('UPDATE documents SET thumb = ? WHERE id = ?');
    const nextT = db.prepare('SELECT id, content FROM documents WHERE thumb IS NULL AND id > ? ORDER BY id LIMIT 300'); // in small batches: a big database must not load every document into memory at start
    for (let last = 0, rows; (rows = nextT.all(last)).length; last = rows[rows.length - 1].id) for (const r of rows) upT.run(makeThumb(r.content), r.id); }
  { // list views read these instead of every document's full content
    const { htmlToText } = require('./sanitize');
    const upd = db.prepare('UPDATE documents SET preview = ?, words = ? WHERE id = ?');
    const nextP = db.prepare('SELECT id, content FROM documents WHERE preview IS NULL AND id > ? ORDER BY id LIMIT 300');
    for (let last = 0, rows; (rows = nextP.all(last)).length; last = rows[rows.length - 1].id) for (const r of rows) { const t = htmlToText(r.content).replace(/\s+/g, ' ').trim(); upd.run(t.slice(0, 140) || (r.content.includes('<img ') ? '[Picture]' : ''), t ? t.split(' ').length : 0, r.id); }
  }
  { // full-text index (trigram: substring matches like "udget" -> "budget"); rows for deleted documents are ignored by the join
    const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'doc_fts'").get();
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(title, body, tokenize = 'trigram')");
    if (fresh) {
      const { htmlToText } = require('./sanitize');
      const ins = db.prepare('INSERT INTO doc_fts (rowid, title, body) VALUES (?, ?, ?)');
      for (const r of db.prepare('SELECT id, title, content FROM documents').all()) ins.run(r.id, r.title, htmlToText(r.content).slice(0, 200000));
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS idempotency (user_id INTEGER NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, body TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (user_id, key))`);
  if (!docCols.includes('settings')) db.exec('ALTER TABLE documents ADD COLUMN settings TEXT');
  if (!docCols.includes('link_token')) db.exec('ALTER TABLE documents ADD COLUMN link_token TEXT');
  if (!columns(db, 'doc_versions').includes('label')) db.exec('ALTER TABLE doc_versions ADD COLUMN label TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_link ON documents(link_token) WHERE link_token IS NOT NULL');
  if (!columns(db, 'comments').includes('quote')) db.exec('ALTER TABLE comments ADD COLUMN quote TEXT');
  if (!columns(db, 'comments').includes('parent_id')) db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE');
  if (!docCols.includes('updated_by')) db.exec('ALTER TABLE documents ADD COLUMN updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL');
  if (!columns(db, 'users').includes('created_at')) db.exec("ALTER TABLE users ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  if (!columns(db, 'shares').includes('seen')) { db.exec('ALTER TABLE shares ADD COLUMN seen INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE shares SET seen = 1'); } // existing shares are not "new"
  if (!columns(db, 'shares').includes('created_at')) db.exec("ALTER TABLE shares ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  // Documents created before version history existed get an initial snapshot so History is never empty.
  db.exec(`INSERT INTO doc_versions (document_id, version, title, content, author_id, created_at, updated_at)
           SELECT d.id, d.version, d.title, d.content, COALESCE(d.updated_by, d.owner_id), d.updated_at, d.updated_at
           FROM documents d WHERE NOT EXISTS (SELECT 1 FROM doc_versions v WHERE v.document_id = d.id)`);
  db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

const SEED_USERS = [
  ['alice', 'Alice Rivera'],
  ['bob', 'Bob Chen'],
  ['carol', 'Carol Okafor'],
];
const SEED_PASSWORD = 'demo123';

const WELCOME = `<h1>Welcome to Docs Lite</h1>
<p>This sample document is owned by <b>Alice</b> and shared with <b>Bob</b> as an editor. Open it in two browser windows (Alice and Bob) to see <i>live updates and presence</i>.</p>
<h2>Things to try</h2>
<ul><li>Format text with the toolbar: <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, links</li><li>Upload a <code>.txt</code>, <code>.md</code> or <code>.docx</code> file from the documents page</li><li>Share a document with someone and pick <i>Can edit</i> or <i>Can view</i></li><li>Open <b>History</b> to see earlier versions and restore one</li><li>Export to Word, Markdown, HTML or print to PDF</li></ul>
<blockquote>Everything you type is saved automatically.</blockquote>`;

function seed(db) {
  const exists = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (exists) return;
  const ins = db.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?,?,?)');
  for (const [u, n] of SEED_USERS) ins.run(u, n, hashPassword(SEED_PASSWORD));
  const id = (u) => db.prepare('SELECT id FROM users WHERE username = ?').get(u).id;
  const { htmlToText } = require('./sanitize');
  const plain = htmlToText(WELCOME).replace(/\s+/g, ' ').trim(); // the list reads these precomputed columns, never the content
  const docId = db
    .prepare('INSERT INTO documents (owner_id, title, content, updated_by, preview, words, thumb) VALUES (?,?,?,?,?,?,?) RETURNING id')
    .get(id('alice'), 'Welcome to Docs Lite', WELCOME, id('alice'), plain.slice(0, 140), plain ? plain.split(' ').length : 0, require('./thumb').makeThumb(WELCOME)).id;
  db.prepare('INSERT INTO shares (document_id, user_id, role) VALUES (?,?,?)').run(docId, id('bob'), 'editor');
  db.prepare('INSERT INTO doc_versions (document_id, version, title, content, author_id) VALUES (?,?,?,?,?)').run(docId, 1, 'Welcome to Docs Lite', WELCOME, id('alice'));
}

module.exports = { openDb, seed, hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync, SEED_PASSWORD, SCHEMA_VERSION };
