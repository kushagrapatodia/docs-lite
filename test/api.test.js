'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');
const { htmlToDocx, readZip } = require('../src/docx');

test('health check is open and security headers are set on API and static responses', async () => {
  const { client, close } = await start();
  try {
    const c = client();
    const h = await c.call('GET', '/healthz');
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(h.headers.get('x-frame-options'), 'DENY');
    const page = await fetch(c.base + '/');
    assert.equal(page.status, 200);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/, 'no inline or remote scripts');
    assert.match(csp, /style-src 'self';/, 'no <style> elements or remote styles');
    assert.match(csp, /style-src-attr 'unsafe-inline'/, 'only style attributes (browser editing commands) are allowed inline');
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    assert.equal((await fetch(c.base + '/../server.js')).status, 404);
    assert.equal((await fetch(c.base + '/%2e%2e/server.js')).status, 404);
    assert.equal((await fetch(c.base + '/nope.txt')).status, 404);
    assert.equal((await fetch(c.base + '/qa/')).status, 200, 'directory URLs serve their index page');
    assert.equal((await fetch(c.base + '/css/')).status, 404, 'directories without an index are not listed');
    assert.equal((await fetch(c.base + '/js/main.js', { method: 'POST' })).status, 405);
    const etag = (await fetch(c.base + '/js/main.js')).headers.get('etag');
    assert.equal((await fetch(c.base + '/js/main.js', { headers: { 'If-None-Match': etag } })).status, 304);
  } finally { await close(); }
});

test('auth: login, wrong password, protected routes, logout invalidates the session', async () => {
  const { client, close } = await start();
  try {
    const c = client();
    assert.equal((await c.call('GET', '/api/documents')).status, 401);
    assert.equal((await c.call('POST', '/api/login', { username: 'alice', password: 'nope' })).status, 401);
    assert.equal((await c.call('POST', '/api/login', { username: 'ghost', password: 'demo123' })).status, 401);
    assert.equal(await c.login('alice'), 200);
    assert.equal((await c.call('GET', '/api/me')).body.username, 'alice');
    const cookieHeader = (await client().raw('POST', '/api/login', { username: 'alice', password: 'demo123' })).headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Lax/);
    await c.call('POST', '/api/logout');
    assert.equal((await c.call('GET', '/api/me')).status, 401);
  } finally { await close(); }
});

test('login is rate limited per address and username', async () => {
  const { client, close } = await start();
  try {
    const c = client();
    let last;
    for (let i = 0; i < 9; i++) last = await c.call('POST', '/api/login', { username: 'bob', password: 'wrong' });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    assert.equal((await c.call('POST', '/api/login', { username: 'bob', password: 'demo123' })).status, 429);
    // a different username is not affected
    assert.equal((await c.call('POST', '/api/login', { username: 'carol', password: 'demo123' })).status, 200);
  } finally { await close(); }
});

test('registration: validation, duplicate usernames, auto login, new user can be shared with', async () => {
  const { client, as, close } = await start();
  try {
    const c = client();
    const bad = [
      [{ username: 'ab', display_name: 'X', password: 'longenough' }, /3-24/],
      [{ username: 'Bad Name', display_name: 'X', password: 'longenough' }, /3-24/],
      [{ username: 'newuser', display_name: '', password: 'longenough' }, /Display name/],
      [{ username: 'newuser', display_name: 'N', password: 'short' }, /at least 8/],
    ];
    for (const [body, msg] of bad) { const r = await c.call('POST', '/api/register', body); assert.equal(r.status, 400); assert.match(r.body.error, msg); }
    const ok = await c.call('POST', '/api/register', { username: 'Dana_9', display_name: 'Dana Lee', password: 'correct horse' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.username, 'dana_9');
    assert.equal((await c.call('GET', '/api/me')).body.display_name, 'Dana Lee');
    assert.equal((await client().call('POST', '/api/register', { username: 'dana_9', display_name: 'Other', password: 'correct horse' })).status, 409);
    assert.equal((await client().call('POST', '/api/register', { username: 'alice', display_name: 'Other', password: 'correct horse' })).status, 409);
    const alice = await as('alice');
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'For Dana' });
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'dana_9', role: 'viewer' })).status, 200);
    assert.equal((await c.call('GET', `/api/documents/${doc.id}`)).body.role, 'viewer');
    const login = await client().call('POST', '/api/login', { username: 'dana_9', password: 'correct horse' });
    assert.equal(login.status, 200);
  } finally { await close(); }
});

test('create, rename, edit, reopen: content persists, version increments, content is sanitised', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const created = await alice.call('POST', '/api/documents', { title: '  Plan   one  ' });
    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Plan one');
    assert.equal(created.body.version, 1);
    const id = created.body.id;
    const patch = await alice.call('PATCH', `/api/documents/${id}`, { title: 'Plan v2', content: '<h1>Hi</h1><p onclick="x()">x<script>bad()</script></p>', base_version: 1 });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.version, 2);
    const again = (await alice.call('GET', `/api/documents/${id}`)).body;
    assert.equal(again.title, 'Plan v2');
    assert.equal(again.content, '<h1>Hi</h1><p>x</p>');
    assert.equal(again.version, 2);
    const noop = await alice.call('PATCH', `/api/documents/${id}`, { content: '<h1>Hi</h1><p>x</p>', base_version: 2 });
    assert.equal(noop.body.changed, false);
    assert.equal(noop.body.version, 2, 'saving identical content must not create a new version');
  } finally { await close(); }
});

test('validation: titles, content size, JSON shape, content type, bad ids', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'T' });
    assert.equal((await alice.call('PATCH', `/api/documents/${doc.id}`, { title: '   ', base_version: doc.version })).status, 400);
    assert.equal((await alice.call('PATCH', `/api/documents/${doc.id}`, { title: 'x'.repeat(201), base_version: doc.version })).status, 400);
    assert.equal((await alice.call('PATCH', `/api/documents/${doc.id}`, { title: 'no version' })).status, 428, 'changes must say which version they edit');
    assert.equal((await alice.call('PATCH', `/api/documents/${doc.id}`, { content: 123, base_version: doc.version })).status, 400);
    assert.equal((await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>' + 'a'.repeat(600000) + '</p>', base_version: doc.version })).status, 413);
    assert.equal((await alice.call('POST', '/api/documents', '{not json')).status, 400);
    assert.equal((await alice.call('POST', '/api/documents', '[1,2]')).status, 400);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await alice.call('GET', '/api/documents/abc')).status, 404);
    assert.equal((await alice.call('GET', '/api/documents/99999')).status, 404);
    assert.equal((await alice.call('GET', '/api/documents/99999999999999999999')).status, 404);
    assert.equal((await alice.call('GET', '/api/nothing-here')).status, 404);
  } finally { await close(); }
});

test('cross-origin writes are rejected, same-origin and missing Origin are accepted', async () => {
  const { as, close, base } = await start();
  try {
    const alice = await as('alice');
    const evil = await alice.call('POST', '/api/documents', { title: 'x' }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'x' }, { Origin: base })).status, 201);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'x' })).status, 201);
  } finally { await close(); }
});

test('sharing: owner vs shared lists, viewer is read-only, editor can edit, strangers get 404, revoke works', async () => {
  const { as, close } = await start();
  try {
    const [alice, bob, carol] = [await as('alice'), await as('bob'), await as('carol')];
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Secret' });
    for (const c of [bob, carol]) {
      assert.equal((await c.call('GET', `/api/documents/${doc.id}`)).status, 404);
      assert.equal((await c.call('PATCH', `/api/documents/${doc.id}`, { title: 'x' })).status, 404);
      assert.equal((await c.call('GET', `/api/documents/${doc.id}/export?format=md`)).status, 404);
      assert.equal((await c.call('GET', `/api/documents/${doc.id}/versions`)).status, 404);
    }
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'viewer' })).status, 200);
    const bobList = (await bob.call('GET', '/api/documents')).body;
    assert.ok(bobList.shared.some((d) => d.id === doc.id && d.role === 'viewer'));
    assert.ok(!bobList.owned.some((d) => d.id === doc.id));
    assert.equal((await bob.call('PATCH', `/api/documents/${doc.id}`, { title: 'hack' })).status, 403);
    assert.equal((await bob.call('POST', `/api/documents/${doc.id}/versions/1/restore`)).status, 403);
    assert.equal((await bob.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'editor' })).status, 403);
    assert.equal((await bob.call('DELETE', `/api/documents/${doc.id}`)).status, 403);
    assert.equal((await bob.call('GET', `/api/documents/${doc.id}`)).body.shares, undefined, 'only the owner sees the share list');

    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
    assert.equal((await bob.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>from bob</p>', base_version: (await bob.call('GET', `/api/documents/${doc.id}`)).body.version })).status, 200);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}`)).body.updated_by_name, 'Bob Chen');
    assert.equal((await bob.call('DELETE', `/api/documents/${doc.id}`)).status, 403, 'editors still cannot delete');

    const bobShare = (await alice.call('GET', `/api/documents/${doc.id}`)).body.shares.find((s) => s.username === 'bob');
    await alice.call('DELETE', `/api/documents/${doc.id}/shares/${bobShare.user_id}`);
    assert.equal((await bob.call('GET', `/api/documents/${doc.id}`)).status, 404);
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'alice', role: 'viewer' })).status, 400);
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'ghost', role: 'viewer' })).status, 404);
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'admin' })).status, 400);
  } finally { await close(); }
});

test('optimistic concurrency: a stale save gets 409 with the current version; saving on top of it works', async () => {
  const { as, close } = await start();
  try {
    const [alice, bob] = [await as('alice'), await as('bob')];
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Race' });
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
    assert.equal((await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>alice</p>', base_version: 1 })).status, 200);
    const stale = await bob.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>bob</p>', base_version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.conflict.version, 2);
    assert.equal(stale.body.conflict.content, '<p>alice</p>');
    assert.equal(stale.body.conflict.updated_by_name, 'Alice Rivera');
    assert.ok(Number.isInteger(stale.body.conflict.updated_by_id), 'conflict says who changed it so the client can tell "you in another tab"');
    assert.match(stale.body.error, /Alice Rivera changed this document/);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}`)).body.content, '<p>alice</p>', 'the stale write must not have been applied');
    const retry = await bob.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>bob</p>', base_version: 2 });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.version, 3);
  } finally { await close(); }
});

test('concurrent saves with the same base version: exactly one wins', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Burst' });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => alice.call('PATCH', `/api/documents/${doc.id}`, { content: `<p>${i}</p>`, base_version: 1 })));
    const codes = results.map((r) => r.status).sort();
    assert.equal(codes.filter((c) => c === 200).length, 1, `got ${codes}`);
    assert.equal(codes.filter((c) => c === 409).length, 7);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}`)).body.version, 2);
  } finally { await close(); }
});

test('version history: snapshots, coalescing of rapid saves, read, restore (as a new version), permissions', async () => {
  const { as, close, db } = await start();
  try {
    const [alice, bob, carol] = [await as('alice'), await as('bob'), await as('carol')];
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'History' });
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'viewer' });
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>draft 1</p>', base_version: 1 });
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>draft 2</p>', base_version: 2 });
    let list = (await alice.call('GET', `/api/documents/${doc.id}/versions`)).body;
    assert.equal(list.length, 2, 'rapid saves by the same author coalesce into one snapshot (plus the initial one)');
    assert.equal(list[0].version, 3);
    assert.equal(list[0].author_name, 'Alice Rivera');
    await bob.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>bob edit</p>', base_version: 3 });
    list = (await carol.call('GET', `/api/documents/${doc.id}/versions`)).body;
    assert.equal(list.length, 3, 'a different author always gets their own snapshot; viewers can read history');
    const first = list[list.length - 1];
    const v = (await carol.call('GET', `/api/documents/${doc.id}/versions/${first.id}`)).body;
    assert.equal(v.content, '<p><br></p>');
    assert.equal((await carol.call('POST', `/api/documents/${doc.id}/versions/${first.id}/restore`)).status, 403);
    // restore the first version as alice
    const restored = await alice.call('POST', `/api/documents/${doc.id}/versions/${first.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.content, '<p><br></p>');
    assert.equal(restored.body.version, 5, 'restore creates a new version instead of rewriting history');
    list = (await alice.call('GET', `/api/documents/${doc.id}/versions`)).body;
    assert.equal(list[0].version, 5);
    assert.ok(list.length >= 4);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}/versions/999999`)).status, 404);
    // versions are scoped to their document
    const { body: other } = await alice.call('POST', '/api/documents', { title: 'Other' });
    assert.equal((await alice.call('GET', `/api/documents/${other.id}/versions/${first.id}`)).status, 404);
    // deleting the document moves it to the trash; erasing it from there removes its history
    await alice.call('DELETE', `/api/documents/${doc.id}`);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE document_id = ?').get(doc.id).n > 0, 'history survives while in the trash');
    await alice.call('DELETE', `/api/trash/${doc.id}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE document_id = ?').get(doc.id).n, 0);
  } finally { await close(); }
});

test('history is capped per document', async () => {
  const { as, close, db } = await start();
  try {
    const [alice, bob] = [await as('alice'), await as('bob')];
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Cap' });
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
    let version = 1;
    for (let i = 0; i < 110; i++) {
      const who = i % 2 ? alice : bob; // alternate authors so snapshots are not coalesced
      const r = await who.call('PATCH', `/api/documents/${doc.id}`, { content: `<p>${i}</p>`, base_version: version });
      version = r.body.version;
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE document_id = ?').get(doc.id).n, 100);
  } finally { await close(); }
});

test('search finds documents by title or body across owned and shared lists', async () => {
  const { as, close } = await start();
  try {
    const [alice, bob] = [await as('alice'), await as('bob')];
    const { body: a } = await alice.call('POST', '/api/documents', { title: 'Roadmap' });
    await alice.call('PATCH', `/api/documents/${a.id}`, { content: '<p>Quarterly zebra plan</p>', base_version: 1 });
    await alice.call('POST', '/api/documents', { title: 'Groceries' });
    const byBody = (await alice.call('GET', '/api/documents?q=ZEBRA')).body;
    assert.deepEqual(byBody.owned.map((d) => d.title), ['Roadmap']);
    assert.match(byBody.owned[0].preview, /Quarterly zebra plan/);
    assert.equal(byBody.owned[0].words, 3);
    const byTitle = (await alice.call('GET', '/api/documents?q=grocer')).body;
    assert.deepEqual(byTitle.owned.map((d) => d.title), ['Groceries']);
    assert.equal((await alice.call('GET', '/api/documents?q=nomatch')).body.owned.length, 0);
    const shared = (await bob.call('GET', '/api/documents?q=welcome')).body;
    assert.equal(shared.shared.length, 1);
    assert.equal(shared.shared[0].updated_by_name, 'Alice Rivera');
  } finally { await close(); }
});

test('duplicate: viewers can make their own editable copy', async () => {
  const { as, close } = await start();
  try {
    const [alice, carol] = [await as('alice'), await as('carol')];
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Template' });
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<h1>Hello</h1>', base_version: 1 });
    assert.equal((await carol.call('POST', `/api/documents/${doc.id}/duplicate`)).status, 404);
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'viewer' });
    const copy = await carol.call('POST', `/api/documents/${doc.id}/duplicate`);
    assert.equal(copy.status, 201);
    assert.equal(copy.body.title, 'Copy of Template');
    assert.equal(copy.body.role, 'owner');
    assert.equal(copy.body.content, '<h1>Hello</h1>');
    assert.equal((await carol.call('PATCH', `/api/documents/${copy.body.id}`, { title: 'Mine', base_version: copy.body.version })).status, 200);
  } finally { await close(); }
});

test('file upload: .md, .txt and .docx become editable documents; bad input is rejected', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const md = await alice.call('POST', '/api/documents/import', { filename: 'notes.md', content: '# Notes\n\n- a\n- b' });
    assert.equal(md.status, 201);
    assert.equal(md.body.title, 'notes');
    assert.equal(md.body.source_file, 'notes.md');
    assert.match(md.body.content, /<h1>Notes<\/h1>/);
    const txt = await alice.call('POST', '/api/documents/import', { filename: 'a.txt', content: 'one\n\ntwo' });
    assert.equal(txt.body.content, '<p>one</p>\n<p>two</p>');

    const docx = htmlToDocx('<h1>From Word</h1><p>Some <b>bold</b> text</p><ul><li>point</li></ul>', 'x');
    const w = await alice.call('POST', '/api/documents/import', { filename: 'Report.DOCX', content_base64: docx.toString('base64') });
    assert.equal(w.status, 201);
    assert.equal(w.body.title, 'Report');
    assert.match(w.body.content, /<h1>From Word<\/h1>/);
    assert.match(w.body.content, /<b>bold<\/b>/);

    const bad = [
      [{ filename: 'a.exe', content: 'x' }, 400, /Unsupported/],
      [{ filename: 'noext', content: 'x' }, 400, /Unsupported/],
      [{ filename: 'a.txt', content: '   ' }, 400, /empty/],
      [{ filename: 'a.txt' }, 400, /empty/],
      [{ filename: 'a.docx' }, 400, /empty/],
      [{ filename: 'a.docx', content_base64: Buffer.from('not a zip').toString('base64') }, 400, /valid/],
      [{ filename: 'a.txt', content: 'x'.repeat(1_100_000) }, 413, /too large/],
      [{ filename: 'a.docx', content_base64: Buffer.alloc(2_100_000).toString('base64') }, 413, /too large/],
    ];
    for (const [body, status, msg] of bad) {
      const r = await alice.call('POST', '/api/documents/import', body);
      assert.equal(r.status, status, JSON.stringify(body).slice(0, 60));
      assert.match(r.body.error, msg);
    }
    const hostile = await alice.call('POST', '/api/documents/import', { filename: 'x.md', content: '<script>alert(1)</script>\n\n[x](javascript:alert(1))' });
    assert.doesNotMatch(hostile.body.content, /<script|href="javascript/i);
  } finally { await close(); }
});

test('export: docx, md, html and txt downloads with safe filenames; unknown formats rejected', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Q4 / "Plan": v2?' });
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<h1>Goals</h1><p>Ship <b>it</b></p><ul><li>a</li></ul>', base_version: 1 });
    const docx = await alice.raw('GET', `/api/documents/${doc.id}/export?format=docx`);
    assert.equal(docx.status, 200);
    assert.match(docx.headers.get('content-type'), /wordprocessingml/);
    assert.match(docx.headers.get('content-disposition'), /^attachment; filename="Q4-Plan-v2\.docx"$/);
    const zip = readZip(Buffer.from(await docx.arrayBuffer()));
    assert.match(zip.read('word/document.xml').toString(), /Goals/);
    const md = await (await alice.raw('GET', `/api/documents/${doc.id}/export?format=md`)).text();
    assert.match(md, /^# Q4 \/ "Plan": v2\?\n\n# Goals/);
    assert.match(md, /Ship \*\*it\*\*/);
    const html = await (await alice.raw('GET', `/api/documents/${doc.id}/export?format=html`)).text();
    assert.match(html, /<!doctype html>/);
    const txt = await alice.raw('GET', `/api/documents/${doc.id}/export?format=txt`);
    assert.match(txt.headers.get('content-type'), /text\/plain/);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}/export?format=exe`)).status, 400);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}/export`)).status, 200);
  } finally { await close(); }
});

test('delete removes the document and its shares for everyone', async () => {
  const { as, close } = await start();
  try {
    const [alice, bob] = [await as('alice'), await as('bob')];
    const list = (await bob.call('GET', '/api/documents')).body;
    const id = list.shared[0].id;
    assert.equal((await alice.call('DELETE', `/api/documents/${id}`)).status, 200);
    assert.equal((await bob.call('GET', `/api/documents/${id}`)).status, 404);
    assert.equal((await bob.call('GET', '/api/documents')).body.shared.some((d) => d.id === doc.id), false);
    assert.equal((await alice.call('DELETE', `/api/documents/${id}`)).status, 404);
  } finally { await close(); }
});

test('seed data: Bob sees the welcome document as shared with him, with history', async () => {
  const { as, close } = await start();
  try {
    const bob = await as('bob');
    const list = (await bob.call('GET', '/api/documents')).body;
    assert.equal(list.owned.length, 0);
    assert.equal(list.shared.length, 1);
    assert.equal(list.shared[0].role, 'editor');
    assert.equal((await bob.call('GET', `/api/documents/${list.shared[0].id}/versions`)).body.length, 1);
  } finally { await close(); }
});

test('sessions expire after seven days', async () => {
  const { client, close, db } = await start();
  try {
    const c = client(); await c.login('alice');
    assert.equal((await c.call('GET', '/api/me')).status, 200);
    db.exec("UPDATE sessions SET created_at = datetime('now', '-8 days')");
    assert.equal((await c.call('GET', '/api/me')).status, 401);
  } finally { await close(); }
});

test('convert: turns an uploaded file into editor HTML without saving anything, with the same limits as import', async () => {
  const { as, client, close, db } = await start();
  try {
    const alice = await as('alice');
    const before = db.prepare('SELECT COUNT(*) n FROM documents').get().n;
    const md = await alice.call('POST', '/api/convert', { filename: 'n.md', content: '## Hi\n\n- a' });
    assert.equal(md.status, 200);
    assert.match(md.body.html, /<h2>Hi<\/h2>/);
    const docx = await alice.call('POST', '/api/convert', { filename: 'w.docx', content_base64: htmlToDocx('<p>from <b>word</b></p>', 'x').toString('base64') });
    assert.match(docx.body.html, /<b>word<\/b>/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, before, 'nothing is created');
    assert.equal((await alice.call('POST', '/api/convert', { filename: 'x.exe', content: 'x' })).status, 400);
    assert.equal((await alice.call('POST', '/api/convert', { filename: 'x.txt', content: '' })).status, 400);
    assert.equal((await client().call('POST', '/api/convert', { filename: 'x.txt', content: 'x' })).status, 401);
    const hostile = await alice.call('POST', '/api/convert', { filename: 'x.md', content: '<script>alert(1)</script>[x](javascript:alert(1))' });
    assert.doesNotMatch(hostile.body.html, /<script|href="javascript/i);
  } finally { await close(); }
});

test('a general per-address rate limit protects the API (health checks and event streams are exempt)', async () => {
  const { as, client, close } = await start({ apiRateLimit: 25 });
  try {
    const alice = await as('alice');
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) { const r = await alice.call('GET', '/api/documents'); if (r.status === 429) limited = r; }
    assert.ok(limited, 'expected a 429 after the limit');
    assert.match(limited.body.error, /slow down/);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await client().call('GET', '/healthz')).status, 200, 'health checks are never throttled');
    assert.equal((await fetch(alice.base + '/')).status, 200, 'static files are not counted');
  } finally { await close(); }
});

test('responses are gzip-compressed when accepted, and identical once decoded', async () => {
  const { as, close, base } = await start();
  try {
    const js = await fetch(base + '/js/views/editor.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(js.headers.get('content-encoding'), 'gzip');
    assert.equal(js.headers.get('vary'), 'Accept-Encoding');
    const plain = await fetch(base + '/js/views/editor.js', { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(await js.text(), await plain.text(), 'node fetch transparently decodes; contents must match');
    // a big API response
    const alice = await as('alice');
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Big' });
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>' + 'word '.repeat(2000) + '</p>', base_version: 1 });
    const res = await fetch(`${base}/api/documents/${doc.id}`, { headers: { Cookie: alice.cookie, 'Accept-Encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.equal((await res.json()).title, 'Big');
    const small = await fetch(`${base}/api/me`, { headers: { Cookie: alice.cookie, 'Accept-Encoding': 'gzip' } });
    assert.equal(small.headers.get('content-encoding'), null, 'tiny responses are not compressed');
  } finally { await close(); }
});

test('trash: delete is reversible, hidden from everyone else, owner-only, and erasing is permanent', async () => {
  const { as, close, db } = await start();
  try {
    const [alice, bob, carol] = [await as('alice'), await as('bob'), await as('carol')];
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Oops' });
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>precious</p>', base_version: 1 });
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
    await alice.call('POST', `/api/documents/${doc.id}/comments`, { body: 'a comment' });

    assert.equal((await alice.call('DELETE', `/api/documents/${doc.id}`)).body.trashed, true);
    // invisible everywhere except the owner's trash
    for (const who of [alice, bob]) {
      assert.equal((await who.call('GET', `/api/documents/${doc.id}`)).status, 404);
      assert.equal((await who.call('PATCH', `/api/documents/${doc.id}`, { title: 'x' })).status, 404);
      assert.equal((await who.call('GET', `/api/documents/${doc.id}/export?format=md`)).status, 404);
      assert.equal((await who.call('GET', `/api/documents/${doc.id}/comments`)).status, 404);
      assert.ok(!(await who.call('GET', '/api/documents')).body.owned.some((d) => d.id === doc.id));
      assert.ok(!(await who.call('GET', '/api/documents')).body.shared.some((d) => d.id === doc.id));
      assert.equal((await who.call('GET', '/api/documents?q=precious')).body.owned.length, 0);
    }
    const trash = (await alice.call('GET', '/api/trash')).body;
    assert.deepEqual(trash.map((d) => d.title), ['Oops']);
    assert.equal(trash[0].days_left, 30);
    assert.equal((await bob.call('GET', '/api/trash')).body.length, 0, 'trash is private to the owner');
    for (const who of [bob, carol]) {
      assert.equal((await who.call('POST', `/api/trash/${doc.id}/restore`)).status, 404);
      assert.equal((await who.call('DELETE', `/api/trash/${doc.id}`)).status, 404);
    }
    assert.equal((await alice.call('DELETE', `/api/documents/${doc.id}`)).status, 404, 'cannot delete twice');

    // restore: content, shares, comments and history all come back
    const back = await alice.call('POST', `/api/trash/${doc.id}/restore`);
    assert.equal(back.status, 200);
    assert.equal(back.body.content, '<p>precious</p>');
    assert.equal((await bob.call('GET', `/api/documents/${doc.id}`)).body.role, 'editor');
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}/comments`)).body.length, 1);
    assert.equal((await alice.call('GET', '/api/trash')).body.length, 0);
    assert.equal((await alice.call('POST', `/api/trash/${doc.id}/restore`)).status, 404, 'a live document is not in the trash');
    assert.equal((await alice.call('DELETE', `/api/trash/${doc.id}`)).status, 404, 'a live document cannot be erased from the trash route');

    // erase forever
    await alice.call('DELETE', `/api/documents/${doc.id}`);
    assert.equal((await alice.call('DELETE', `/api/trash/${doc.id}`)).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM documents WHERE id = ?').get(doc.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comments WHERE document_id = ?').get(doc.id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM shares WHERE document_id = ?').get(doc.id).n, 0);
  } finally { await close(); }
});

test('trash: items older than 30 days are purged automatically on startup', async () => {
  const { openDb, seed } = require('../src/db');
  const { createApp } = require('../src/app');
  const db = openDb(':memory:');
  seed(db);
  const ins = db.prepare("INSERT INTO documents (owner_id, title, content, deleted_at) VALUES (1, ?, '<p>x</p>', datetime('now', ?))");
  ins.run('old', '-31 days'); ins.run('recent', '-29 days');
  const server = createApp(db); // startup runs the purge
  await new Promise((r) => server.listen(0, r));
  try {
    assert.deepEqual(db.prepare("SELECT title FROM documents WHERE deleted_at IS NOT NULL").all().map((d) => d.title), ['recent']);
  } finally { await new Promise((r) => server.close(r)); }
});

test('deleting a document you are viewing ends the stream for everyone (soft delete)', async () => {
  const { as, close } = await start();
  try {
    const [alice, bob] = [await as('alice'), await as('bob')];
    const id = (await bob.call('GET', '/api/documents')).body.shared[0].id;
    const { openEvents } = require('./helpers');
    const stream = await openEvents(bob, id);
    await stream.waitFor((e) => e.event === 'hello');
    await alice.call('DELETE', `/api/documents/${id}`);
    assert.match((await stream.waitFor((e) => e.event === 'revoked')).data.reason, /deleted/i);
  } finally { await close(); }
});

test('sign-up is rate limited per address', async () => {
  const { client, close } = await start({ registerRateLimit: 3 });
  try {
    const c = client();
    for (let i = 0; i < 3; i++) assert.equal((await c.call('POST', '/api/register', { username: `rl_user${i}`, display_name: 'R', password: 'password123' })).status, 201);
    const blocked = await c.call('POST', '/api/register', { username: 'rl_user9', display_name: 'R', password: 'password123' });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  } finally { await close(); }
});

test('shared documents are marked New for the recipient until they open them', async () => {
  const { as, close } = await start();
  try {
    const [alice, carol] = [await as('alice'), await as('carol')];
    const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Fresh share' });
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'viewer' });
    const find = async (who) => (await who.call('GET', '/api/documents')).body.shared.find((d) => d.id === doc.id);
    assert.equal((await find(carol)).unseen, true);
    assert.equal((await alice.call('GET', '/api/documents')).body.owned.find((d) => d.id === doc.id).unseen, false, 'owners never see the marker');
    await carol.call('GET', `/api/documents/${doc.id}`);
    assert.equal((await find(carol)).unseen, false, 'opening clears it');
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'editor' });
    assert.equal((await find(carol)).unseen, false, 'a role change is not a new share');
    const carolShare = (await alice.call('GET', `/api/documents/${doc.id}`)).body.shares[0];
    await alice.call('DELETE', `/api/documents/${doc.id}/shares/${carolShare.user_id}`);
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'viewer' });
    assert.equal((await find(carol)).unseen, true, 're-sharing after removal is new again');
  } finally { await close(); }
});

test('pictures: stored inline, round-tripped through export, bounded by count and size', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const img = `<img src="data:image/png;base64,${PNG}" alt="dot" width="120">`;
    const created = (await alice.call('POST', '/api/documents', { title: 'Pics' })).body;
    const saved = await alice.call('PATCH', `/api/documents/${created.id}`, { content: `<p>a ${img} b</p><p><img src="https://evil.example/x.png" onerror="x()"></p>`, base_version: created.version });
    assert.equal(saved.status, 200);
    const doc = { id: created.id, version: saved.body.version, content: saved.body.content };
    assert.ok(doc.content.includes(`<p>a ${img} b</p>`) && !doc.content.includes('evil'));
    const docx = await alice.raw('GET', `/api/documents/${doc.id}/export?format=docx`);
    assert.ok(readZip(Buffer.from(await docx.arrayBuffer())).has('word/media/image1.png'));
    assert.match(await (await alice.raw('GET', `/api/documents/${doc.id}/export?format=md`)).text(), /\[Image: dot\]/);
    // too many pictures
    const many = (await alice.call('PATCH', `/api/documents/${doc.id}`, { content: `<p>${img.repeat(21)}</p>`, base_version: doc.version }));
    assert.equal(many.status, 413);
    // a huge picture counts against the larger total, plain text keeps its own limit
    const big = `<img src="data:image/png;base64,${'A'.repeat(1_400_000)}">`;
    const ok = await alice.call('PATCH', `/api/documents/${doc.id}`, { content: `<p>${big}</p>`, base_version: doc.version });
    assert.equal(ok.status, 200);
    const tooBig = await alice.call('PATCH', `/api/documents/${doc.id}`, { content: `<p>${big}${big}${big}</p>`, base_version: ok.body.version });
    assert.equal(tooBig.status, 413);
    const text = await alice.call('PATCH', `/api/documents/${doc.id}`, { content: `<p>${'x'.repeat(600_000)}</p>`, base_version: ok.body.version });
    assert.equal(text.status, 413);
  } finally { await close(); }
});

test('public view link: owner-only, unauthenticated read, rotation, revocation, trash', async () => {
  const { as, client, close } = await start();
  try {
    const alice = await as('alice');
    const bob = await as('bob');
    const doc = (await alice.call('POST', '/api/documents', { title: 'Open doc' })).body;
    const saved = await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>hello <b>world</b></p>', base_version: doc.version });
    const anon = client();
    // nothing is public until the owner turns it on
    assert.equal((await anon.call('GET', '/api/public/aaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
    assert.equal((await bob.call('POST', `/api/documents/${doc.id}/link`)).status, 404, 'a stranger cannot create a link');
    const t1 = (await alice.call('POST', `/api/documents/${doc.id}/link`)).body.link_token;
    assert.match(t1, /^[A-Za-z0-9_-]{24}$/);
    const open = await anon.call('GET', `/api/public/${t1}`);
    assert.equal(open.status, 200);
    assert.deepEqual(Object.keys(open.body).sort(), ['content', 'owner_name', 'settings', 'title', 'updated_at'], 'no ids, emails or shares leak');
    assert.equal(open.body.content, '<p>hello <b>world</b></p>');
    assert.equal(open.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal((await anon.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>x</p>' })).status, 401, 'the link never grants editing');
    // shared viewers cannot manage the link; the owner sees the token
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
    assert.equal((await bob.call('POST', `/api/documents/${doc.id}/link`)).status, 403);
    assert.equal((await bob.call('GET', `/api/documents/${doc.id}`)).body.link_token, undefined);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}`)).body.link_token, t1);
    // rotating replaces the token
    const t2 = (await alice.call('POST', `/api/documents/${doc.id}/link`)).body.link_token;
    assert.notEqual(t1, t2);
    assert.equal((await anon.call('GET', `/api/public/${t1}`)).status, 404);
    assert.equal((await anon.call('GET', `/api/public/${t2}`)).status, 200);
    // the trash hides it, restoring brings it back, turning it off revokes it
    await alice.call('DELETE', `/api/documents/${doc.id}`);
    assert.equal((await anon.call('GET', `/api/public/${t2}`)).status, 404);
    await alice.call('POST', `/api/trash/${doc.id}/restore`);
    assert.equal((await anon.call('GET', `/api/public/${t2}`)).status, 200);
    assert.equal((await alice.call('DELETE', `/api/documents/${doc.id}/link`)).status, 200);
    assert.equal((await anon.call('GET', `/api/public/${t2}`)).status, 404);
    // malformed tokens and edits made after sharing
    assert.equal((await anon.call('GET', '/api/public/short')).status, 404);
    assert.equal((await anon.call('GET', '/api/public/..%2f..%2fetc')).status, 404);
    void saved;
  } finally { await close(); }
});

test('named versions: editors can name, names survive coalescing and pruning, viewers cannot', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const bob = await as('bob');
    const doc = (await alice.call('POST', '/api/documents', { title: 'Named' })).body;
    let v = doc.version;
    const save = async (text) => { const r = await alice.call('PATCH', `/api/documents/${doc.id}`, { content: `<p>${text}</p>`, base_version: v }); v = r.body.version; return r; };
    await save('one');
    let list = (await alice.call('GET', `/api/documents/${doc.id}/versions`)).body;
    const target = list[0];
    const named = await alice.call('PUT', `/api/documents/${doc.id}/versions/${target.id}/label`, { label: '  Sent   to legal ' });
    assert.equal(named.status, 200);
    assert.equal(named.body[0].label, 'Sent to legal');
    await save('two'); // would normally be merged into the same row: a named version must stay as it was
    list = (await alice.call('GET', `/api/documents/${doc.id}/versions`)).body;
    assert.equal(list.length, 3);
    const old = (await alice.call('GET', `/api/documents/${doc.id}/versions/${target.id}`)).body;
    assert.equal(old.label, 'Sent to legal');
    assert.match(old.content, /one/);
    // validation and permissions
    const url = `/api/documents/${doc.id}/versions/${target.id}/label`;
    assert.equal((await alice.call('PUT', url, { label: 'x'.repeat(81) })).status, 400);
    assert.equal((await alice.call('PUT', url, { label: 5 })).status, 400);
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/versions/999999/label`, { label: 'a' })).status, 404);
    assert.equal((await bob.call('PUT', url, { label: 'hack' })).status, 404);
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'viewer' });
    assert.equal((await bob.call('PUT', url, { label: 'hack' })).status, 403);
    // clearing the name
    assert.equal((await alice.call('PUT', url, { label: '' })).body.find((x) => x.id === target.id).label, null);
  } finally { await close(); }
});

test('stars: private per user, any role may star, listed with the flag, removed with the document', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const bob = await as('bob');
    const doc = (await alice.call('POST', '/api/documents', { title: 'Starry' })).body;
    assert.equal((await bob.call('PUT', `/api/documents/${doc.id}/star`)).status, 404, 'strangers cannot star what they cannot open');
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/star`)).body.starred, true);
    assert.equal((await alice.call('PUT', `/api/documents/${doc.id}/star`)).status, 200, 'starring twice is harmless');
    const mine = (await alice.call('GET', '/api/documents')).body.owned.find((d) => d.id === doc.id);
    assert.equal(mine.starred, true);
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'viewer' });
    assert.equal((await bob.call('GET', '/api/documents')).body.shared.find((d) => d.id === doc.id).starred, false, 'bob has not starred it');
    assert.equal((await bob.call('PUT', `/api/documents/${doc.id}/star`)).status, 200, 'a viewer can star');
    assert.equal((await alice.call('DELETE', `/api/documents/${doc.id}/star`)).body.starred, false);
    assert.equal((await alice.call('GET', '/api/documents')).body.owned.find((d) => d.id === doc.id).starred, false);
    assert.equal((await bob.call('GET', '/api/documents')).body.shared.find((d) => d.id === doc.id).starred, true, 'unstarring is per user');
    await alice.call('DELETE', `/api/documents/${doc.id}`);
    await alice.call('DELETE', `/api/trash/${doc.id}`);
    assert.equal((await bob.call('GET', '/api/documents')).body.shared.some((d) => d.id === doc.id), false);
  } finally { await close(); }
});

test('new document with starter content: sanitised, validated, snapshot holds the content', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const r = await alice.call('POST', '/api/documents', { title: 'From template', content: '<h1>Plan</h1><ul data-type="check"><li data-checked="true">done</li></ul><script>x()</script>' });
    assert.equal(r.status, 201);
    assert.equal(r.body.content, '<h1>Plan</h1><ul data-type="check"><li data-checked="true">done</li></ul>');
    const versions = (await alice.call('GET', `/api/documents/${r.body.id}/versions`)).body;
    assert.equal(versions.length, 1);
    assert.match((await alice.call('GET', `/api/documents/${r.body.id}/versions/${versions[0].id}`)).body.content, /<h1>Plan<\/h1>/);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'x', content: 5 })).status, 400);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'x', content: '' })).body.content, '<p><br></p>');
    assert.equal((await alice.call('POST', '/api/documents', { title: 'x', content: 'x'.repeat(600_000) })).status, 413);
  } finally { await close(); }
});

test('page setup: validated, editor-only, exported to .docx (size, orientation, header, footer, page numbers) and copied', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const bob = await as('bob');
    const doc = (await alice.call('POST', '/api/documents', { title: 'Paged' })).body;
    assert.deepEqual(doc.settings, { size: 'a4', orientation: 'portrait', margins: 'normal', header: '', footer: '', pageNumbers: false });
    const url = `/api/documents/${doc.id}/settings`;
    const good = { size: 'letter', orientation: 'landscape', margins: 'narrow', header: 'Acme <Confidential> & Co', footer: '  Draft\u0000 v1 ', pageNumbers: true };
    const saved = await alice.call('PUT', url, good);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.footer, 'Draft v1');
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}`)).body.settings.size, 'letter');
    for (const bad of [{ size: 'a0' }, { size: '__proto__' }, { orientation: 'diagonal' }, { margins: 'huge' }, { header: 'x'.repeat(121) }, { header: 5 }, { pageNumbers: 'yes' }, [], null, 'text']) {
      assert.equal((await alice.call('PUT', url, bad)).status, 400, JSON.stringify(bad));
    }
    // a viewer cannot change it, a stranger cannot see the document
    assert.equal((await bob.call('PUT', url, good)).status, 404);
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'viewer' });
    assert.equal((await bob.call('PUT', url, good)).status, 403);
    assert.equal((await bob.call('GET', `/api/documents/${doc.id}`)).body.settings.orientation, 'landscape');
    // docx carries the setup
    const zip = readZip(Buffer.from(await (await alice.raw('GET', `/api/documents/${doc.id}/export?format=docx`)).arrayBuffer()));
    const body = zip.read('word/document.xml').toString();
    assert.match(body, /<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"\/>/);
    assert.match(body, /w:top="720" w:right="720"/);
    assert.match(zip.read('word/header1.xml').toString(), /Acme &lt;Confidential&gt; &amp; Co/);
    const footer = zip.read('word/footer1.xml').toString();
    assert.match(footer, /Draft v1/);
    assert.match(footer, /instrText[^>]*> PAGE </);
    // html export prints with the same @page rule
    const exported = await (await alice.raw('GET', `/api/documents/${doc.id}/export?format=html`)).text();
    assert.ok(exported.includes('@page{size:letter landscape;margin:0.5in 0.5in;@top-center{content:"Acme \\3c Confidential\\3e  \\26  Co"'), 'angle brackets are CSS-escaped');
    assert.ok(!exported.includes('<Confidential>'), 'the header text can never close the <style> element');
    // defaults produce no header or footer parts
    const plain = (await alice.call('POST', '/api/documents', { title: 'Plain' })).body;
    const plainZip = readZip(Buffer.from(await (await alice.raw('GET', `/api/documents/${plain.id}/export?format=docx`)).arrayBuffer()));
    assert.equal(plainZip.has('word/header1.xml'), false);
    assert.equal(plainZip.has('word/footer1.xml'), false);
    // a copy keeps the page setup
    const copy = (await alice.call('POST', `/api/documents/${doc.id}/duplicate`)).body;
    assert.equal(copy.settings.size, 'letter');
  } finally { await close(); }
});

test('list preview: a document that only holds a picture is not shown as empty', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const d = (await alice.call('POST', '/api/documents', { title: 'Only a picture', content: `<p><img src="data:image/png;base64,${PNG}"></p>` })).body;
    const item = (await alice.call('GET', '/api/documents')).body.owned.find((x) => x.id === d.id);
    assert.equal(item.preview, '[Picture]');
    assert.equal(item.words, 0);
  } finally { await close(); }
});

test('observability: request ids, readiness, metrics (loopback or token), drain closes event streams', async () => {
  const { as, client, base, close } = await start({ metricsToken: 'secret-token-123' });
  try {
    const alice = await as('alice');
    const r = await alice.call('GET', '/api/documents');
    assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    const echoed = await fetch(`${base}/healthz`, { headers: { 'X-Request-Id': 'trace-abc-12345' } });
    assert.equal(echoed.headers.get('x-request-id'), 'trace-abc-12345');
    const bad = await fetch(`${base}/healthz`, { headers: { 'X-Request-Id': 'bad id\twith spaces' } });
    assert.notEqual(bad.headers.get('x-request-id'), 'bad id\twith spaces');
    assert.equal((await client().call('GET', '/readyz')).body.ready, true);
    const doc = (await alice.call('POST', '/api/documents', { title: 'm' })).body;
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>x</p>', base_version: doc.version });
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>y</p>', base_version: 1 }); // stale: conflict
    const m = await (await fetch(`${base}/metrics`)).text(); // loopback in tests
    assert.match(m, /http_requests_total\{route="\/api\/documents",status="200"\}/);
    assert.match(m, /http_requests_total\{route="\/api\/documents\/:id",status="409"\} 1/);
    assert.match(m, /doc_saves_total 1/);
    assert.match(m, /doc_conflicts_total 1/);
    assert.match(m, /http_request_duration_seconds_bucket\{route="\/healthz",le="\+Inf"\}/);
    assert.match(m, /sse_clients 0/);
    assert.ok(!m.includes('/api/public/'), 'tokens never appear in labels');
    assert.equal((await fetch(`${base}/metrics`, { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 404, 'proxied requests are not loopback');
    assert.equal((await fetch(`${base}/metrics`, { headers: { 'X-Forwarded-For': '8.8.8.8', Authorization: 'Bearer secret-token-123' } })).status, 200);
    assert.equal((await fetch(`${base}/metrics`, { headers: { 'X-Forwarded-For': '8.8.8.8', Authorization: 'Bearer wrong-token-xxx' } })).status, 404);
  } finally { await close(); }
});

test('search: substring matches across the body, highlighted, access-safe, trash and revocation respected', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const bob = await as('bob');
    const d = (await alice.call('POST', '/api/documents', { title: 'Quarterly report', content: '<p>The marketing budget increased by ten percent.</p>' })).body;
    const find = async (who, q) => (await who.call('GET', `/api/documents?q=${encodeURIComponent(q)}`)).body;
    let r = await find(alice, 'udget');
    assert.equal(r.owned.length, 1);
    assert.match(r.owned[0].snippet, /\[\[udget\]\]/);
    assert.equal((await find(alice, 'QUARTERLY')).owned.length, 1, 'case-insensitive, title too');
    assert.equal((await find(alice, 'nothing-like-this')).owned.length, 0);
    assert.equal((await find(bob, 'budget')).shared.length, 0, 'strangers never find it');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    assert.equal((await find(bob, 'budget')).shared.length, 1);
    await alice.call('DELETE', `/api/documents/${d.id}/shares/${(await alice.call('GET', `/api/documents/${d.id}`)).body.shares[0].user_id}`);
    assert.equal((await find(bob, 'budget')).shared.length, 0, 'revoked access ends search visibility');
    await alice.call('PATCH', `/api/documents/${d.id}`, { content: '<p>Now about invoices.</p>', base_version: d.version });
    assert.equal((await find(alice, 'budget')).owned.length, 0, 'the index follows edits');
    assert.equal((await find(alice, 'invoices')).owned.length, 1);
    await alice.call('DELETE', `/api/documents/${d.id}`);
    assert.equal((await find(alice, 'invoices')).owned.length, 0, 'trashed documents are not searchable');
    assert.equal((await find(alice, '"; DROP TABLE documents;--')).owned.length, 0, 'query text is data, not FTS syntax');
    assert.equal((await alice.call('GET', '/api/documents')).status, 200);
  } finally { await close(); }
});

test('idempotency: a retried POST returns the first response and creates nothing twice', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const key = 'create-doc-0001-abcd';
    const first = await alice.call('POST', '/api/documents', { title: 'Once' }, { 'Idempotency-Key': key });
    assert.equal(first.status, 201);
    const again = await alice.call('POST', '/api/documents', { title: 'Once' }, { 'Idempotency-Key': key });
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(again.body.id, first.body.id, 'same document, not a duplicate');
    const mine = (await alice.call('GET', '/api/documents')).body.owned.filter((d) => d.title === 'Once');
    assert.equal(mine.length, 1);
    // same key, different request: refused
    assert.equal((await alice.call('POST', '/api/documents/import', { filename: 'a.txt', content: 'hello' }, { 'Idempotency-Key': key })).status, 422);
    // keys are per user
    const bob = await as('bob');
    assert.equal((await bob.call('POST', '/api/documents', { title: 'Bob' }, { 'Idempotency-Key': key })).headers.get('idempotent-replayed'), null);
    // failures are not remembered, so the client can fix and retry with the same key
    const bad = await alice.call('POST', '/api/documents', { title: 'x'.repeat(300) }, { 'Idempotency-Key': 'retry-after-fail-1' });
    assert.equal(bad.status, 400);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'x'.repeat(30) }, { 'Idempotency-Key': 'retry-after-fail-1' })).status, 201);
    // malformed keys are ignored, no key means normal behaviour
    assert.equal((await alice.call('POST', '/api/documents', { title: 'n1' }, { 'Idempotency-Key': 'short' })).status, 201);
    // 20 parallel retries with one key create exactly one document
    const key2 = 'parallel-key-000001';
    const rs = await Promise.all(Array.from({ length: 20 }, () => alice.call('POST', '/api/documents', { title: 'Parallel' }, { 'Idempotency-Key': key2 })));
    assert.ok(rs.every((r) => [201, 409].includes(r.status)), rs.map((r) => r.status).join());
    assert.equal((await alice.call('GET', '/api/documents')).body.owned.filter((d) => d.title === 'Parallel').length, 1);
  } finally { await close(); }
});

test('a fresh database lists the seeded welcome document with a real preview and word count', async () => {
  const { as, close } = await start();
  try {
    const alice = await as('alice');
    const welcome = (await alice.call('GET', '/api/documents')).body.owned.find((d) => d.title === 'Welcome to Docs Lite');
    assert.ok(welcome);
    assert.notEqual(welcome.preview, undefined);
    assert.ok(welcome.preview.length > 20 && !/undefined/.test(welcome.preview), welcome.preview);
    assert.ok(welcome.words > 20, `words: ${welcome.words}`);
  } finally { await close(); }
});

test('quota: a user cannot create unlimited documents; export format lookup ignores the prototype chain; unknown users cost the same as wrong passwords', async () => {
  const { as, client, db, close } = await start();
  try {
    const alice = await as('alice');
    const owner = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
    const ins = db.prepare('INSERT INTO documents (owner_id, title, content) VALUES (?,?,?)');
    db.exec('BEGIN'); for (let i = 0; i < 500; i++) ins.run(owner, `d${i}`, '<p>x</p>'); db.exec('COMMIT');
    const r = await alice.call('POST', '/api/documents', { title: 'one too many' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /limit of 500 documents/);
    const doc = (await alice.call('GET', '/api/documents')).body.owned[0];
    for (const f of ['constructor', '__proto__', 'toString']) assert.equal((await alice.call('GET', `/api/documents/${doc.id}/export?format=${f}`)).status, 400, f);
    // login: unknown and known users both pay for a password check
    const c = client();
    const t = async (u) => { const t0 = process.hrtime.bigint(); await c.call('POST', '/api/login', { username: u, password: 'wrong-password' }); return Number(process.hrtime.bigint() - t0) / 1e6; };
    await t('nobody1'); await t('alice');
    const unknown = Math.min(await t('nobody2'), await t('nobody3')), known = Math.min(await t('alice'), await t('alice'));
    assert.ok(unknown > known * 0.3, `unknown ${unknown.toFixed(1)} ms vs known ${known.toFixed(1)} ms`);
  } finally { await close(); }
});

test('saving is rate limited per user (autosave stays far below the budget)', async () => {
  const { as, close } = await start({ writeRateLimit: 5 });
  try {
    const a = await as('alice');
    const d = (await a.call('POST', '/api/documents', { title: 'rl' })).body;
    let v = d.version, last = 0;
    for (let i = 0; i < 8; i++) { const r = await a.call('PATCH', `/api/documents/${d.id}`, { content: `<p>${i}</p>`, base_version: v }); last = r.status; if (r.status === 200) v = r.body.version; }
    assert.equal(last, 429);
  } finally { await close(); }
});
