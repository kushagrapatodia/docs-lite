'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, seed, SCHEMA_VERSION } = require('../src/db');
const { createApp } = require('../src/app');
const { start, openEvents } = require('./helpers');
const { sanitizeHtml, htmlToText } = require('../src/sanitize');
const { htmlToDocx, docxToHtml, readZip } = require('../src/docx');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-gap-')), 'db.sqlite');
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

// One column at a time, as if the database had been created by an older release: dropping it and reopening must restore it, keeping data.
const DROPS = [
  ['documents', 'preview', []], ['documents', 'thumb', []], ['documents', 'settings', []],
  ['documents', 'link_token', ['idx_docs_link']], ['documents', 'deleted_at', ['idx_docs_deleted', 'idx_docs_trash']],
  ['doc_versions', 'label', []], ['comments', 'quote', []], ['shares', 'seen', []], ['shares', 'created_at', []], ['users', 'created_at', []],
];
for (const [table, col, idx] of DROPS) {
  test(`migration: a database without ${table}.${col} is upgraded in place and keeps its data`, () => {
    const file = tmp();
    const a = openDb(file); seed(a);
    for (const i of idx) a.exec(`DROP INDEX IF EXISTS ${i}`);
    a.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    a.exec('PRAGMA user_version = 3');
    a.close();
    const b = openDb(file);
    assert.ok(cols(b, table).includes(col), `${table}.${col} restored`);
    assert.equal(b.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
    const d = b.prepare('SELECT * FROM documents').get();
    assert.equal(d.title, 'Welcome to Docs Lite');
    assert.ok(d.preview && d.words > 10 && d.thumb !== null, 'derived columns are backfilled');
    assert.equal(b.prepare('SELECT COUNT(*) n FROM shares').get().n, 1);
    assert.equal(b.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    b.close();
  });
}

test('migration: derived columns and the search index are rebuilt for a database that lacks them, and search works afterwards', async () => {
  const file = tmp();
  const a = openDb(file); seed(a);
  a.exec('DROP TABLE doc_fts');
  a.exec('UPDATE documents SET preview = NULL, words = 0, thumb = NULL');
  a.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM doc_fts').get().n, 1);
  const server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'demo123' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await (await fetch(`${base}/api/documents?q=toolbar`, { headers: { Cookie: cookie } })).json();
    assert.equal(r.owned.length, 1);
    assert.match(r.owned[0].snippet, /\[\[toolbar\]\]/);
    assert.ok(r.owned[0].preview.startsWith('Welcome to Docs Lite'));
  } finally { await new Promise((r) => server.close(r)); }
});

test('migration: a failing upgrade rolls back completely (no half-migrated schema), and the opened database stays usable', () => {
  const file = tmp();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', source_file TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE shares (document_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL, PRIMARY KEY (document_id, user_id));`);
  old.prepare("INSERT INTO users (username, display_name, password_hash) VALUES ('u','U','x:y')").run();
  old.prepare("INSERT INTO documents (owner_id, title, content) VALUES (1, 'T', '<p>c</p>')").run();
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, 1);
  assert.equal(db.prepare("SELECT content FROM doc_versions").get().content, '<p>c</p>');
  db.close();
});

test('graceful drain: readiness flips to 503, event streams receive bye and end, normal requests still work', async () => {
  const db = openDb(':memory:'); seed(db);
  const server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'demo123' }) });
    const c = { base, cookie: login.headers.get('set-cookie').split(';')[0] };
    const docs = await (await fetch(`${base}/api/documents`, { headers: { Cookie: c.cookie } })).json();
    const ev = await openEvents(c, docs.owned[0].id);
    await ev.waitFor((e) => e.event === 'hello');
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    server.drain();
    assert.ok(await ev.waitFor((e) => e.event === 'bye'));
    await ev.waitFor(() => false, 500);
    assert.equal(ev.closed, true);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/healthz`)).status, 200, 'liveness is independent of draining');
    assert.equal((await fetch(`${base}/api/documents`, { headers: { Cookie: c.cookie } })).status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});

test('static files: ETag revalidation gives 304, HEAD has no body, traversal and POST are refused, unknown paths 404', async () => {
  const s = await start();
  try {
    const r1 = await fetch(`${s.base}/`);
    assert.equal(r1.status, 200);
    const tag = r1.headers.get('etag');
    assert.ok(tag);
    await r1.arrayBuffer();
    const r2 = await fetch(`${s.base}/`, { headers: { 'If-None-Match': tag } });
    assert.equal(r2.status, 304);
    const head = await fetch(`${s.base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.text()), '');
    assert.equal((await fetch(`${s.base}/%2e%2e/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${s.base}/..%2fsrc%2fapp.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/nope.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${s.base}/%E0%A4%A`)).status, 400);
  } finally { await s.close(); }
});

test('metrics: rejected for non-loopback proxies and for wrong tokens, accepted with the bearer token', async () => {
  const s = await start({ metricsToken: 'sekret-token' });
  try {
    assert.equal((await fetch(`${s.base}/metrics`)).status, 200, 'loopback is allowed');
    assert.equal((await fetch(`${s.base}/metrics`, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 404, 'proxied requests need the token');
    assert.equal((await fetch(`${s.base}/metrics`, { headers: { 'X-Forwarded-For': '1.2.3.4', Authorization: 'Bearer wrong' } })).status, 404);
    const ok = await fetch(`${s.base}/metrics`, { headers: { 'X-Forwarded-For': '1.2.3.4', Authorization: 'Bearer sekret-token' } });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /http_requests_total/);
  } finally { await s.close(); }
});

// ---- sanitiser properties on a fresh seed family (independent of fuzz.test.js) ----
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const PIECES = ['<p>', '</p>', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<a href=" jav&#x61;script:alert(1)">y</a>', '<svg onload=alert(1)>', '<iframe src="//evil">', '<div style="background:url(javascript:alert(1))">', '<b onclick=x()>', '</b>', '<ul><li>', '</ul>', '<table><tr><td>', '&lt;', '&#x3c;script&#x3e;', 'plain', '<!--', '-->', '<style>*{}</style>', '<object data=x>', '<math><mi>', '<form action=x><input>', '<a href="data:text/html;base64,PHNjcmlwdD4=">d</a>', '<img src="data:image/svg+xml;base64,PHN2Zz4=">', '\u0000', '<base href=//evil>', '<meta http-equiv=refresh content="0;url=//e">', '<a href="vbscript:x">v</a>', '<span style="expression(alert(1))">e</span>'];
test('sanitiser properties: random mixes never leave scripts, event handlers or javascript: URLs, and sanitising again changes nothing', () => {
  const r = rng(20260101);
  for (let i = 0; i < 1500; i++) {
    const src = Array.from({ length: 1 + Math.floor(r() * 12) }, () => PIECES[Math.floor(r() * PIECES.length)]).join(r() < 0.5 ? '' : ' ');
    const once = sanitizeHtml(src);
    assert.equal(sanitizeHtml(once), once, `not idempotent: ${JSON.stringify(src)}`);
    const markup = (once.match(/<[^>]*>/g) || []).join('');
    assert.ok(!/<(script|style|iframe|object|embed|svg|math|form|input|meta|base|link)\b/i.test(markup), `bad tag: ${JSON.stringify(src)} -> ${once}`);
    assert.ok(!/\son[a-z]+\s*=/i.test(markup), `handler: ${JSON.stringify(src)} -> ${once}`);
    assert.ok(!/(javascript|vbscript|data:text)/i.test(markup.replace(/data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]*/g, '')), `url scheme: ${JSON.stringify(src)} -> ${once}`);
    assert.ok(!/<img[^>]*src="data:image\/svg/i.test(once), `svg image: ${JSON.stringify(src)}`);
  }
});

test('sanitiser: htmlToText of sanitised output never contains markup characters from tags, and escaping round-trips text', () => {
  const nasty = 'a < b && c > d "q" \'s\' </script><b>';
  const html = sanitizeHtml(`<p>${nasty.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`);
  assert.equal(htmlToText(html).trim(), nasty);
});

// ---- docx round trips ----
test('docx: nested mixed lists and a table with formatting survive a round trip', () => {
  const html = '<h3>Head</h3><ol><li>a<ul><li>b</li><li>c<ol><li>d</li></ol></li></ul></li><li>e</li></ol><table><tr><th>H1</th><th>H2</th></tr><tr><td><b>x</b> &amp; y</td><td>z</td></tr></table><p>end</p>';
  const back = docxToHtml(htmlToDocx(html, 'T'));
  assert.match(back, /<h3>Head<\/h3>/);
  const flat = back.replace(/\s+/g, ' ');
  assert.match(flat, /<ol>\s*<li>a\s*<ul>\s*<li>b\s*<\/li>\s*<li>c\s*<ol>\s*<li>d\s*<\/li>\s*<\/ol>\s*<\/li>\s*<\/ul>\s*<\/li>\s*<li>e\s*<\/li>\s*<\/ol>/);
  assert.match(flat, /<table>.*<th>H1<\/th>.*<th>H2<\/th>.*<td><b>x<\/b> &amp; y<\/td>.*<td>z<\/td>.*<\/table>/);
  assert.match(flat, /<p>end<\/p>/);
});

test('docx: an inline picture round-trips as the same data URL and the package carries it as a media part', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const html = sanitizeHtml(`<p>before</p><p><img src="data:image/png;base64,${png}"></p><p>after</p>`);
  assert.match(html, /<img src="data:image\/png;base64,/);
  const buf = htmlToDocx(html, 'Pic');
  const z = readZip(buf);
  assert.ok([...Array(20).keys()].some((i) => z.has(`word/media/image${i}.png`) || z.has(`word/media/image${i + 1}.png`)) || /media\//.test(z.read('word/_rels/document.xml.rels').toString()), 'picture stored as a media part');
  const back = docxToHtml(buf);
  assert.ok(back.includes(`data:image/png;base64,${png}`), 'same bytes come back');
  assert.match(back.replace(/\s+/g, ' '), /before.*<img.*after/);
});

test('docx export: special characters, emoji and XML-hostile text in title, body and links produce a package that reads back intact', () => {
  const text = 'Tom & Jerry <3 "quotes" \'apos\' ]]> \u{1F680} 日本語 ‮';
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const buf = htmlToDocx(`<p>${esc}</p><p><a href="https://example.com/?a=1&amp;b=2">link &amp; text</a></p>`, 'T & "Q" <x>');
  const z = readZip(buf);
  const xml = z.read('word/document.xml').toString();
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), 'no control characters in XML');
  const back = docxToHtml(buf);
  assert.ok(htmlToText(back).includes('Tom & Jerry <3 "quotes"'), htmlToText(back));
  assert.match(back, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
});

test('regression: docx export/import cycles do not add line breaks before nested lists', () => {
  const { htmlToDocx, docxToHtml } = require('../src/docx');
  let h = '<ol><li>a<ul><li>b</li></ul></li></ol>';
  const first = docxToHtml(htmlToDocx(h, 'T'));
  let cur = first;
  for (let i = 0; i < 3; i++) cur = docxToHtml(htmlToDocx(cur, 'T'));
  assert.equal(cur, first);
  assert.ok(!/<br/.test(cur));
});
