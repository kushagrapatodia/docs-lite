'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { start } = require('./helpers');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];

// raw HTTP so we can send things fetch refuses to (bad paths, odd headers)
function raw(base, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const WEIRD_VALUES = [null, true, false, 0, -1, 1e308, NaN, 'x', '', ' ', '0', '1', '-1', '<script>', "' OR 1=1 --", '\u0000', '😀', 'a'.repeat(5000), [], {}, [1, 2], { a: 1 }, { $ne: null }, 'constructor', '__proto__', { __proto__: { admin: true } }];
const KEYS = ['title', 'content', 'base_version', 'username', 'display_name', 'password', 'role', 'body', 'quote', 'resolved', 'filename', 'content_base64', 'format', 'q', 'size', 'orientation', 'margins', 'header', 'footer', 'pageNumbers', 'label', 'parent_id', '__proto__', 'constructor'];

test('no request, however malformed, produces a 500 or kills the server (3000 random API calls)', async () => {
  const { as, client, close, base, db } = await start({ apiRateLimit: 1e9 });
  try {
    const alice = await as('alice');
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Target' });
    await alice.call('POST', `/api/documents/${doc.id}/comments`, { body: 'c' });
    const paths = [
      '/api/login', '/api/register', '/api/logout', '/api/session', '/api/me', '/api/users', '/api/documents', '/api/documents/import', '/api/convert', '/api/trash',
      `/api/documents/${doc.id}`, `/api/documents/${doc.id}/duplicate`, `/api/documents/${doc.id}/export`, `/api/documents/${doc.id}/versions`, `/api/documents/${doc.id}/versions/1`,
      `/api/documents/${doc.id}/versions/1/restore`, `/api/documents/${doc.id}/shares`, `/api/documents/${doc.id}/shares/2`, `/api/documents/${doc.id}/comments`, `/api/documents/${doc.id}/comments/1`,
      `/api/documents/${doc.id}/settings`, `/api/documents/${doc.id}/star`, `/api/documents/${doc.id}/link`, `/api/documents/${doc.id}/versions/1/label`, '/api/public/aaaaaaaaaaaaaaaaaaaaaaaa', '/api/public/%00', '/api/public/'+'a'.repeat(200),
      `/api/trash/${doc.id}`, `/api/trash/${doc.id}/restore`, '/api/documents/abc', '/api/documents/-1', '/api/documents/1.5', '/api/documents/1e3', '/api/documents/%00', '/api/nothing', '/healthz',
    ];
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
    const sessions = [alice, client()]; // signed in and anonymous
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const who = pick(r, sessions);
      const obj = {};
      for (let i = 0, n = Math.floor(r() * 5); i < n; i++) obj[pick(r, KEYS)] = pick(r, WEIRD_VALUES);
      let body = r() < 0.8 ? JSON.stringify(obj) : pick(r, ['{', '[', 'null', '"str"', '123', '{"a":', '\u0000', 'x'.repeat(1000)]);
      let path = pick(r, paths);
      if (r() < 0.15) path += pick(r, ['?q=' + encodeURIComponent("'; DROP TABLE users;--"), '?format=..%2f..%2fetc%2fpasswd', '?q=%zz', '?format=docx&format=md', '?' + 'a=1&'.repeat(200)]);
      const method = pick(r, methods);
      const headers = { 'Content-Type': r() < 0.9 ? 'application/json' : pick(r, ['text/plain', 'application/x-www-form-urlencoded', '', 'application/json; charset=utf-16']), Cookie: r() < 0.9 ? who.cookie : pick(r, ['sid=', 'sid=nonsense', 'sid=' + 'a'.repeat(5000), ';;;', 'sid==']) };
      if (method === 'GET' || method === 'HEAD') body = undefined; else headers['Content-Length'] = Buffer.byteLength(body ?? '');
      let res;
      try { res = await raw(base, { method, path, headers, body }); }
      catch (e) { assert.fail(`request threw (seed ${seed}): ${method} ${path} ${e.message}`); }
      assert.ok(res.status < 500, `HTTP ${res.status} for seed ${seed}: ${method} ${path} body=${String(body).slice(0, 120)}\n${res.body.slice(0, 200)}`);
    }
    assert.equal((await client().call('GET', '/healthz')).status, 200, 'server is still healthy');
    // the database is intact after SQL-injection style probes
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n >= 3, true);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").all().length, 1);
  } finally { await close(); }
});

test('malformed URLs, oversized headers and odd cookies are rejected cleanly', async () => {
  const { close, base, client } = await start();
  try {
    for (const path of ['/%', '/%zz', '/..%2f..%2fserver.js', '/js/%2e%2e/%2e%2e/server.js', '/\u0000', '//evil.example/x', '/api/documents/%2f', '/js/main.js/..', '/%c0%af', '/api/%']) {
      const r = await raw(base, { path: path.replace(/[\u0000]/g, '%00') });
      assert.ok(r.status === 400 || r.status === 404 || r.status === 401 || r.status === 200, `${path} -> ${r.status}`);
      assert.doesNotMatch(r.body, /require\(|process\.env|node:sqlite/, `${path} leaked source`);
    }
    const bigCookie = await raw(base, { path: '/api/session', headers: { Cookie: 'sid=' + 'x'.repeat(9000) } });
    assert.ok([200, 400, 431].includes(bigCookie.status), `${bigCookie.status}`);
    assert.equal((await client().call('GET', '/healthz')).status, 200);
  } finally { await close(); }
});

test('SQL injection probes are inert: usernames, search, ids and bodies', async () => {
  const { as, client, close, db } = await start();
  try {
    const alice = await as('alice');
    const probes = ["' OR '1'='1", '"; DROP TABLE documents; --', "alice'--", '1; DELETE FROM users', "%' UNION SELECT password_hash FROM users --", '\\'];
    for (const p of probes) {
      assert.equal((await client().call('POST', '/api/login', { username: p, password: p })).status, 401);
      const s = await alice.call('GET', `/api/documents?q=${encodeURIComponent(p)}`);
      assert.equal(s.status, 200);
      assert.equal((await alice.call('POST', '/api/documents', { title: p })).status, 201, 'stored as a plain title');
      assert.equal((await alice.call('PUT', '/api/documents/1/shares', { username: p, role: 'viewer' })).status, 404);
    }
    const listed = (await alice.call('GET', '/api/documents')).body.owned.map((d) => d.title);
    for (const p of probes) assert.ok(listed.includes(p), 'titles round-trip byte for byte');
    for (const t of ['users', 'documents', 'shares', 'sessions', 'doc_versions', 'comments']) assert.ok(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n >= 0, t);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
  } finally { await close(); }
});

test('prototype pollution payloads do not change server behaviour', async () => {
  const { as, client, close } = await start();
  try {
    const alice = await as('alice');
    await alice.call('POST', '/api/documents', '{"title":"x","__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}}}');
    await client().call('POST', '/api/register', '{"username":"pp_user","display_name":"P","password":"password123","__proto__":{"polluted":1}}');
    assert.equal(({}).admin, undefined);
    assert.equal(({}).polluted, undefined);
  } finally { await close(); }
});

test('concurrency stress: 40 users hammering create / edit / comment / share in parallel with no failures', async () => {
  const { client, as, close } = await start({ apiRateLimit: 1e9, registerRateLimit: 1e9 });
  try {
    const owner = await as('alice');
    const { body: shared } = await owner.call('POST', '/api/documents', { title: 'Shared hot doc' });
    const users = await Promise.all(Array.from({ length: 40 }, async (_, i) => {
      const c = client();
      const r = await c.call('POST', '/api/register', { username: `stress${i}`, display_name: `Stress ${i}`, password: 'password123' });
      assert.equal(r.status, 201);
      await owner.call('PUT', `/api/documents/${shared.id}/shares`, { username: `stress${i}`, role: 'editor' });
      return c;
    }));
    const statuses = [];
    await Promise.all(users.map(async (c, i) => {
      const own = await c.call('POST', '/api/documents', { title: `Doc ${i}` });
      statuses.push(own.status);
      for (let k = 0; k < 5; k++) {
        const cur = await c.call('GET', `/api/documents/${shared.id}`);
        const patch = await c.call('PATCH', `/api/documents/${shared.id}`, { content: `<p>user ${i} round ${k}</p>`, base_version: cur.body.version });
        statuses.push(patch.status);
        statuses.push((await c.call('POST', `/api/documents/${shared.id}/comments`, { body: `c ${i}.${k}` })).status);
        statuses.push((await c.call('PATCH', `/api/documents/${own.body.id}`, { content: `<p>mine ${k}</p>`, base_version: k + 1 })).status);
      }
    }));
    const bad = statuses.filter((s) => ![200, 201, 409].includes(s));
    assert.deepEqual(bad, [], 'only success or a clean 409 conflict is acceptable');
    assert.ok(statuses.filter((s) => s === 200).length > 100, 'many saves succeed');
    const final = await owner.call('GET', `/api/documents/${shared.id}`);
    assert.equal(final.status, 200);
    assert.match(final.body.content, /^<p>user \d+ round \d<\/p>$/, 'the document is one writer\'s clean content, never interleaved');
    assert.equal((await owner.call('GET', `/api/documents/${shared.id}/comments`)).body.length, 200);
    const versions = (await owner.call('GET', `/api/documents/${shared.id}/versions`)).body;
    assert.ok(versions.length > 1 && versions.length <= 100);
  } finally { await close(); }
});

test('scale: listing 3,000 large documents stays fast because it never reads their content', async () => {
  const { as, db, close } = await start();
  try {
    const alice = await as('alice');
    const owner = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
    const body = `<p>${'lorem ipsum dolor sit amet '.repeat(4000)}</p>`; // ~108 KB each
    const ins = db.prepare('INSERT INTO documents (owner_id, title, content, preview, words) VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i = 0; i < 3000; i++) ins.run(owner, `Doc ${i}`, body, 'lorem ipsum dolor', 20000);
    db.exec('COMMIT');
    const t0 = Date.now();
    const r = await alice.call('GET', '/api/documents');
    const ms = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.body.owned.length, 1000, 'the list is capped');
    assert.equal(r.body.owned[0].words, 20000);
    assert.ok(ms < 1500, `listing took ${ms} ms`);
  } finally { await close(); }
});

test('hostile input stays fast: sanitiser and docx reader are linear on unclosed openers', async () => {
  const { sanitizeHtml } = require('../src/sanitize');
  const { docxToHtml, writeZip } = require('../src/docx');
  for (const piece of ['<svg', '<![CDATA[', '<!--', '<a ', '<?', '<!x ', '<script ', '<style']) {
    const t0 = Date.now();
    sanitizeHtml(piece.repeat(Math.ceil(400_000 / piece.length)));
    assert.ok(Date.now() - t0 < 1000, `${piece} took ${Date.now() - t0} ms`);
  }
  for (const piece of ['<w:del ', '<w:tbl ', '<mc:Fallback ']) {
    const xml = `<?xml version="1.0"?><w:document><w:body>${piece.repeat(200_000)}</w:body></w:document>`;
    const t0 = Date.now();
    try { docxToHtml(writeZip([['word/document.xml', xml]])); } catch { /* a refusal is fine, slowness is not */ }
    assert.ok(Date.now() - t0 < 2000, `${piece} took ${Date.now() - t0} ms`);
  }
});

test('rate limiter keys cannot be inflated and X-Forwarded-For cannot be spoofed to escape limits', async () => {
  const { client, close } = await start({ trustProxy: true });
  try {
    const c = client();
    const big = 'x'.repeat(500_000);
    for (let i = 0; i < 3; i++) await c.call('POST', '/api/login', { username: big, password: 'p' });
    let limited = 0;
    for (let i = 0; i < 12; i++) { // the proxy appends the real address on the right; the leftmost part is attacker-controlled
      const r = await c.call('POST', '/api/login', { username: 'alice', password: 'wrong' }, { 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 3, `spoofed leftmost addresses must not reset the limiter (limited ${limited})`);
  } finally { await close(); }
});

test('markdown conversion stays linear on unclosed inline openers', () => {
  const { markdownToHtml } = require('../src/sanitize');
  for (const piece of [' _a', '[a', ' *a', '**a', '~~a', '`a', ' __a', '[a](http://x']) {
    const md = piece.repeat(Math.ceil(300_000 / piece.length));
    const t0 = Date.now();
    markdownToHtml(md);
    markdownToHtml(`${md}\n`.repeat(3));
    assert.ok(Date.now() - t0 < 1500, `${JSON.stringify(piece)} took ${Date.now() - t0} ms`);
  }
  // normal formatting still works
  assert.equal(markdownToHtml('a *b* **c** [d](https://e.com) `f`'), '<p>a <i>b</i> <b>c</b> <a href="https://e.com">d</a> <code>f</code></p>');
});

test('docx import rejects unbalanced XML quickly (no quadratic regex scans)', () => {
  const { docxToHtml, writeZip } = require('../src/docx');
  const bad = (name, xml) => writeZip([[name, xml]]);
  for (const [part, xml] of [['word/document.xml', `<w:document><w:body>${'<w:p>'.repeat(100_000)}</w:body></w:document>`], ['word/document.xml', `<w:document><w:body><w:p>${'<w:r>'.repeat(100_000)}</w:p></w:body></w:document>`]]) {
    const zip = writeZip([['word/document.xml', xml]]);
    const t0 = Date.now();
    assert.throws(() => docxToHtml(zip), /damaged|valid|too/);
    assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  }
  const numbering = writeZip([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>'], ['word/numbering.xml', `<w:numbering>${'<w:abstractNum w:abstractNumId="1">'.repeat(20_000)}</w:numbering>`]]);
  const t1 = Date.now();
  assert.throws(() => docxToHtml(numbering), /damaged/);
  assert.ok(Date.now() - t1 < 1500);
  // a healthy file still imports
  const ok = writeZip([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p><w:p/></w:body></w:document>']]);
  assert.match(docxToHtml(ok), /hello/);
});

test('a malformed request line cannot crash the server', async () => {
  const { base, close } = await start();
  try {
    const net = require('node:net');
    const port = Number(new URL(base).port);
    for (const target of ['//', '//[', '//a:b', '///:', '*', 'x']) {
      const reply = await new Promise((resolve) => { const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)); let d = ''; s.on('data', (c) => { d += c; }); s.on('close', () => resolve(d)); s.on('error', () => resolve(d)); });
      assert.match(reply, /^HTTP\/1\.1 (400|404)/, `${target}: ${reply.slice(0, 40)}`);
    }
    assert.equal((await fetch(`${base}/healthz`)).status, 200, 'still serving');
  } finally { await close(); }
});

test('docx import: closers-before-openers and other mis-nested XML is rejected in linear time', () => {
  const { docxToHtml, writeZip } = require('../src/docx');
  const doc = (body) => `<w:document><w:body>${body}</w:body></w:document>`;
  const cases = [
    ['word/document.xml', doc('</w:p>'.repeat(40000) + '<w:p>'.repeat(40000))],
    ['word/document.xml', doc('</w:r>'.repeat(40000) + '<w:r>'.repeat(40000))],
    ['word/document.xml', doc('</w:tc>'.repeat(40000) + '<w:tc>'.repeat(40000))],
    ['word/document.xml', doc(`<w:p><w:r>${'<w:t>'.repeat(60000)}</w:r></w:p>`)],
    ['word/numbering.xml', '</w:abstractNum>'.repeat(40000) + '<w:abstractNum w:abstractNumId="1">'.repeat(40000)],
    ['word/styles.xml', '</w:style>'.repeat(40000) + '<w:style w:styleId="a">'.repeat(40000)],
  ];
  for (const [part, xml] of cases) {
    const parts = [['word/document.xml', doc('<w:p><w:r><w:t>x</w:t></w:r></w:p>')]];
    if (part !== 'word/document.xml') parts.push([part, xml]); else parts[0] = [part, xml];
    const zip = writeZip(parts);
    const t0 = Date.now();
    assert.throws(() => docxToHtml(zip), /damaged|complex|too/, part);
    assert.ok(Date.now() - t0 < 1000, `${part}: ${Date.now() - t0} ms`);
  }
});

test('docx import: repeated references to one big entry are inflated once and drawings are budgeted', () => {
  const { docxToHtml, writeZip } = require('../src/docx');
  const drawing = '<w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><a:graphic><a:blip r:embed="rId9"/></a:graphic></wp:inline></w:drawing></w:r>';
  const parts = [['word/document.xml', `<w:document><w:body><w:p>${drawing.repeat(4000)}<w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>`],
    ['word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.bin"/></Relationships>'],
    ['word/media/a.bin', Buffer.alloc(3_900_000)]];
  const t0 = Date.now();
  try { docxToHtml(writeZip(parts)); } catch { /* refusing is fine */ }
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});

test('logging out ends the live event streams of that user', async () => {
  const { as, close } = await start();
  try {
    const bob = await as('bob'); const alice = await as('alice');
    const doc = (await alice.call('POST', '/api/documents', { title: 'Live' })).body;
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'viewer' });
    const { openEvents } = require('./helpers');
    const s = await openEvents(bob, doc.id);
    await s.waitFor((e) => e.event === 'hello');
    await bob.call('POST', '/api/logout');
    await new Promise((r) => setTimeout(r, 200));
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>SECRET-AFTER-LOGOUT</p>', base_version: doc.version });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.events.some((e) => JSON.stringify(e).includes('SECRET-AFTER-LOGOUT')), false);
    s.close();
  } finally { await close(); }
});
