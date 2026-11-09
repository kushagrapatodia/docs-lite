'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, openEvents } = require('./helpers');
const { LIMITS } = require('../src/app');

const mk = async (c, title = 'Doc', content) => (await c.call('POST', '/api/documents', content === undefined ? { title } : { title, content })).body;
const names = (r) => r.body.owned.map((d) => d.title);

test('PATCH: base_version is mandatory for content/title, a no-op save does not bump the version, sanitised content is echoed back', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const d = await mk(alice, 'Patch', '<p>a</p>');
    const url = `/api/documents/${d.id}`;
    assert.equal((await alice.call('PATCH', url, { content: '<p>b</p>' })).status, 428);
    assert.equal((await alice.call('PATCH', url, { title: 'T' })).status, 428);
    assert.equal((await alice.call('PATCH', url, { content: 5, base_version: 1 })).status, 400);
    assert.equal((await alice.call('PATCH', url, { title: 'x'.repeat(201), base_version: 1 })).status, 400);
    assert.equal((await alice.call('PATCH', url, { title: '   ', base_version: 1 })).status, 400);
    const same = await alice.call('PATCH', url, { content: '<p>a</p>', base_version: 1 });
    assert.equal(same.body.changed, false);
    assert.equal(same.body.version, 1);
    assert.equal((await alice.call('GET', url)).body.version, 1);
    const dirty = await alice.call('PATCH', url, { title: '  spaced \n out ', content: '<p onclick="x()">ok<script>bad()</script></p>', base_version: 1 });
    assert.equal(dirty.status, 200);
    assert.equal(dirty.body.version, 2);
    assert.equal(dirty.body.content, '<p>ok</p>', 'client is told what was actually stored');
    assert.equal((await alice.call('GET', url)).body.title, 'spaced out');
    const clean = await alice.call('PATCH', url, { content: '<p>ok2</p>', base_version: 2 });
    assert.equal(clean.body.content, undefined, 'nothing echoed when the content was stored as sent');
    // a stale version carries the current document so the client can merge
    const stale = await alice.call('PATCH', url, { content: '<p>z</p>', base_version: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.conflict.version, 3);
    assert.equal(stale.body.conflict.content, '<p>ok2</p>');
    // a base_version of the wrong type never silently overwrites
    assert.equal((await alice.call('PATCH', url, { content: '<p>z</p>', base_version: '3' })).status, 409);
  } finally { await s.close(); }
});

test('version history: edits by different authors, or after the coalescing window, or on a named version, make new entries', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'H', '<p>0</p>');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'editor' });
    const n = async () => (await alice.call('GET', `/api/documents/${d.id}/versions`)).body.length;
    const patch = (c, html, v) => c.call('PATCH', `/api/documents/${d.id}`, { content: html, base_version: v });
    await patch(alice, '<p>1</p>', 1); // v2: new row (last row is version 1)
    assert.equal(await n(), 2);
    await patch(alice, '<p>2</p>', 2); // v3 merges into v2's row
    assert.equal(await n(), 2);
    await patch(bob, '<p>3</p>', 3); // other author: new row
    assert.equal(await n(), 3);
    await patch(bob, '<p>4</p>', 4); // same author again: merged
    assert.equal(await n(), 3);
    // name the newest, then keep editing: the named row is frozen
    const top = (await alice.call('GET', `/api/documents/${d.id}/versions`)).body[0];
    await alice.call('PUT', `/api/documents/${d.id}/versions/${top.id}/label`, { label: 'Frozen' });
    await patch(bob, '<p>5</p>', 5);
    assert.equal(await n(), 4);
    const frozen = (await alice.call('GET', `/api/documents/${d.id}/versions/${top.id}`)).body;
    assert.match(frozen.content, /4/);
    // age the newest row beyond the window: the next save starts a new row
    s.db.prepare("UPDATE doc_versions SET updated_at = datetime('now', ?) WHERE id = (SELECT MAX(id) FROM doc_versions WHERE document_id = ?)").run(`-${LIMITS.versionCoalesceSeconds + 5} seconds`, d.id);
    await patch(bob, '<p>6</p>', 6);
    assert.equal(await n(), 5);
    const list = (await alice.call('GET', `/api/documents/${d.id}/versions`)).body;
    assert.equal(list[0].version, 7);
    assert.equal(list[0].author_name, 'Bob Chen');
  } finally { await s.close(); }
});

test('search: ordered by most recently updated, case-insensitive, snippets mark the hit, FTS syntax in the query is inert, short terms still work', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const a = await mk(alice, 'Alpha notes', '<p>the Quarterly Budget review</p>');
    const b = await mk(alice, 'Beta notes', '<p>another budget line</p>');
    await alice.call('PATCH', `/api/documents/${a.id}`, { content: '<p>the Quarterly Budget review, revised</p>', base_version: 1 });
    s.db.prepare("UPDATE documents SET updated_at = datetime('now', '-1 hour') WHERE id = ?").run(b.id);
    const r = await alice.call('GET', '/api/documents?q=BUDGET');
    assert.deepEqual(names(r), ['Alpha notes', 'Beta notes']);
    assert.match(r.body.owned[0].snippet, /\[\[[Bb]udget\]\]/);
    // special characters and operators are searched literally and never produce an error
    for (const q of ['"', '""', 'budget*', 'NEAR(a b)', 'a OR b', '(', ')', 'title:alpha', "' OR 1=1 --", '%', '_', '\\', 'bud get']) {
      const x = await alice.call('GET', `/api/documents?q=${encodeURIComponent(q)}`);
      assert.equal(x.status, 200, q);
    }
    assert.equal(names(await alice.call('GET', `/api/documents?q=${encodeURIComponent('title:alpha')}`)).length, 0);
    assert.deepEqual(names(await alice.call('GET', '/api/documents?q=' + encodeURIComponent('%'))), [], 'LIKE wildcards are not interpreted');
    // title-only match, and a 2-character term falls back to the substring path
    assert.deepEqual(names(await alice.call('GET', '/api/documents?q=beta')), ['Beta notes']);
    assert.deepEqual(names(await alice.call('GET', '/api/documents?q=be')), ['Beta notes']);
    // blank query is the full list (the two new documents plus the seeded welcome document)
    assert.equal((await alice.call('GET', '/api/documents?q=%20%20')).body.owned.length, 3);
  } finally { await s.close(); }
});

test('search: only finds what the caller can open (other users, trash, revoked shares), and stays correct after edits and erase', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'Secret', '<p>unobtainium formula</p>');
    assert.equal((await bob.call('GET', '/api/documents?q=unobtainium')).body.shared.length, 0);
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    assert.equal((await bob.call('GET', '/api/documents?q=unobtainium')).body.shared.length, 1);
    await alice.call('PATCH', `/api/documents/${d.id}`, { content: '<p>handwavium formula</p>', base_version: 1 });
    assert.equal((await bob.call('GET', '/api/documents?q=unobtainium')).body.shared.length, 0, 'the index follows edits');
    assert.equal((await bob.call('GET', '/api/documents?q=handwavium')).body.shared.length, 1);
    const bobId = (await bob.call('GET', '/api/me')).body.id;
    await alice.call('DELETE', `/api/documents/${d.id}/shares/${bobId}`);
    assert.equal((await bob.call('GET', '/api/documents?q=handwavium')).body.shared.length, 0);
    assert.equal((await alice.call('GET', '/api/documents?q=handwavium')).body.owned.length, 1);
    await alice.call('DELETE', `/api/documents/${d.id}`);
    assert.equal((await alice.call('GET', '/api/documents?q=handwavium')).body.owned.length, 0);
    await alice.call('POST', `/api/trash/${d.id}/restore`);
    assert.equal((await alice.call('GET', '/api/documents?q=handwavium')).body.owned.length, 1);
  } finally { await s.close(); }
});

test('quota: the 500-document cap counts trashed documents and applies to create, import and duplicate', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const me = (await alice.call('GET', '/api/me')).body.id;
    const have = s.db.prepare('SELECT COUNT(*) n FROM documents WHERE owner_id = ?').get(me).n;
    const ins = s.db.prepare("INSERT INTO documents (owner_id, title, content, preview, words, thumb, deleted_at) VALUES (?, 'filler', '<p>x</p>', 'x', 1, '', datetime('now'))");
    for (let i = have; i < LIMITS.docsPerUser - 1; i++) ins.run(me);
    const first = await alice.call('POST', '/api/documents', { title: 'last one' });
    assert.equal(first.status, 201, 'the 500th document is allowed');
    assert.equal((await alice.call('POST', '/api/documents', { title: 'over' })).status, 409);
    assert.equal((await alice.call('POST', '/api/documents/import', { filename: 'a.txt', content: 'hello' })).status, 409);
    assert.equal((await alice.call('POST', `/api/documents/${first.body.id}/duplicate`)).status, 409);
    // another user is unaffected
    assert.equal((await (await s.as('bob')).call('POST', '/api/documents', { title: 'fine' })).status, 201);
    // erasing from the trash frees a slot
    const trashId = s.db.prepare('SELECT id FROM documents WHERE owner_id = ? AND deleted_at IS NOT NULL LIMIT 1').get(me).id;
    assert.equal((await alice.call('DELETE', `/api/trash/${trashId}`)).status, 200);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'again' })).status, 201);
  } finally { await s.close(); }
});

test('quota: byte usage counts every document of the owner (including trash) and is not affected by other users', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const me = (await alice.call('GET', '/api/me')).body.id;
    const before = s.db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM documents WHERE owner_id = ?').get(me).n;
    const d = await mk(alice, 'sized', `<p>${'x'.repeat(1000)}</p>`);
    await alice.call('DELETE', `/api/documents/${d.id}`);
    const after = s.db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM documents WHERE owner_id = ?').get(me).n;
    assert.ok(after - before >= 1000, 'a trashed document still occupies quota');
    assert.equal((await alice.call('POST', '/api/documents', { title: 'ok', content: `<p>${'y'.repeat(100_000)}</p>` })).status, 201);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'big', content: `<p>${'y'.repeat(LIMITS.content)}</p>` })).status, 413, 'a single document over the size limit is refused first');
  } finally { await s.close(); }
});

test('import: extension rules, size limit, title derivation, source file recorded, empty and unreadable files', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const imp = (b) => alice.call('POST', '/api/documents/import', b);
    assert.equal((await imp({ filename: 'x.pdf', content: 'a' })).status, 400);
    assert.equal((await imp({ filename: 'noext', content: 'a' })).status, 400);
    assert.equal((await imp({ filename: '', content: 'a' })).status, 400);
    assert.equal((await imp({ content: 'a' })).status, 400);
    assert.equal((await imp({ filename: 'x.txt', content: '   \n ' })).status, 400);
    assert.equal((await imp({ filename: 'x.txt', content: 12 })).status, 400);
    assert.equal((await imp({ filename: 'x.docx', content: 'text, not base64 field' })).status, 400);
    assert.equal((await imp({ filename: 'x.docx', content_base64: Buffer.from('not a zip').toString('base64') })).status, 400);
    assert.equal((await imp({ filename: 'big.txt', content: 'a'.repeat(1_000_001) })).status, 413);
    const upper = await imp({ filename: 'Notes.MD', content: '# Heading\n\ntext' });
    assert.equal(upper.status, 201);
    assert.equal(upper.body.title, 'Notes');
    assert.equal(upper.body.source_file, 'Notes.MD');
    assert.match(upper.body.content, /<h1>Heading<\/h1>/);
    const mdl = await imp({ filename: 'a.b.markdown', content: '**b**' });
    assert.equal(mdl.body.title, 'a.b');
    const dir = await imp({ filename: 'C:\\x/y/report.txt', content: 'line one\n\nline <b>two</b>' });
    assert.ok(dir.body.title.endsWith('report') && !dir.body.title.includes('.txt'));
    assert.ok(!dir.body.content.includes('<b>'), 'text files are escaped, never interpreted as HTML');
    assert.match(dir.body.content, /&lt;b&gt;two&lt;\/b&gt;/);
    const long = await imp({ filename: `${'n'.repeat(300)}.txt`, content: 'x' });
    assert.equal(long.status, 201);
    assert.ok(long.body.title.length <= LIMITS.title);
    assert.ok(long.body.source_file.length <= 255);
    const evil = await imp({ filename: 'e.md', content: '[x](javascript:alert(1)) <script>alert(1)</script> ![i](javascript:evil)' });
    assert.ok(!/<script|<a |<img|href=|src=/i.test(evil.body.content), 'no live markup or link target comes out of hostile Markdown');
    // converting needs a session and saves nothing
    const before = (await alice.call('GET', '/api/documents')).body.owned.length;
    const conv = await alice.call('POST', '/api/convert', { filename: 'c.md', content: '# C' });
    assert.equal(conv.status, 200);
    assert.equal((await alice.call('GET', '/api/documents')).body.owned.length, before);
    assert.equal((await s.client().call('POST', '/api/convert', { filename: 'c.md', content: '# C' })).status, 401);
  } finally { await s.close(); }
});

test('duplicate: copy has the caller as owner, no shares, no public link, copied page setup, its own history, and a title within the limit', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'x'.repeat(LIMITS.title), '<p>content</p>');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    await alice.call('POST', `/api/documents/${d.id}/link`);
    await alice.call('PUT', `/api/documents/${d.id}/settings`, { size: 'legal', footer: 'F' });
    const c = (await bob.call('POST', `/api/documents/${d.id}/duplicate`)).body;
    assert.equal(c.role, 'owner');
    assert.equal(c.owner_name, 'Bob Chen');
    assert.ok(c.title.length <= LIMITS.title && c.title.startsWith('Copy of '));
    assert.deepEqual(c.shares, []);
    assert.equal(c.link_token, null);
    assert.equal(c.settings.size, 'legal');
    assert.equal(c.settings.footer, 'F');
    assert.equal((await bob.call('GET', `/api/documents/${c.id}/versions`)).body.length, 1);
    const stranger = await s.as('carol');
    assert.equal((await stranger.call('POST', `/api/documents/${d.id}/duplicate`)).status, 404);
  } finally { await s.close(); }
});

test('cursor relay: viewers may broadcast, positions are validated, clear is relayed, the sender never hears itself', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'C', '<p>hello</p>');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    const evA = await openEvents(alice, d.id), evB = await openEvents(bob, d.id);
    await evA.waitFor((e) => e.event === 'hello'); await evB.waitFor((e) => e.event === 'hello');
    const pos = (o) => ({ path: [0, 0], offset: o });
    const post = (c, b) => c.call('POST', `/api/documents/${d.id}/cursor`, b);
    for (const bad of [{}, { anchor: pos(0) }, { anchor: pos(-1), focus: pos(0) }, { anchor: { path: [-1], offset: 0 }, focus: pos(0) }, { anchor: { path: new Array(49).fill(0), offset: 0 }, focus: pos(0) }, { anchor: pos(1.5), focus: pos(0) }, { anchor: { path: ['0'], offset: 0 }, focus: pos(0) }, { anchor: pos(10_000_000), focus: pos(0) }]) assert.equal((await post(bob, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    assert.equal((await post(bob, { anchor: pos(1), focus: pos(3) })).status, 200);
    const got = await evA.waitFor((e) => e.event === 'cursor' && !e.data.clear);
    assert.equal(got.data.name, 'Bob Chen');
    assert.equal(got.data.focus.offset, 3);
    assert.equal((await post(bob, { clear: true })).status, 200);
    assert.ok(await evA.waitFor((e) => e.event === 'cursor' && e.data.clear === true));
    assert.equal(evB.events.some((e) => e.event === 'cursor'), false);
    assert.equal((await post(await s.as('carol'), { clear: true })).status, 404);
    evA.close(); evB.close();
  } finally { await s.close(); }
});

test('event streams: capped per user, and the slot is released when a stream closes', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const d = await mk(alice);
    const open = [];
    for (let i = 0; i < LIMITS.streamsPerUser; i++) open.push(await openEvents(alice, d.id));
    assert.ok(open.every((e) => e.status === 200));
    const over = await openEvents(alice, d.id);
    assert.equal(over.status, 429);
    open[0].close();
    let again;
    for (let i = 0; i < 20; i++) { // the server notices the closed socket asynchronously
      await new Promise((r) => setTimeout(r, 50));
      again = await openEvents(alice, d.id);
      if (again.status === 200) break;
    }
    assert.equal(again.status, 200);
    again.close(); open.forEach((e) => e.close());
  } finally { await s.close(); }
});

test('stars: strangers cannot star, repeated stars are idempotent, a viewer star is private, unstar of a never-starred document is fine', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob'), carol = await s.as('carol');
    const d = await mk(alice, 'Starry');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    assert.equal((await carol.call('PUT', `/api/documents/${d.id}/star`)).status, 404);
    assert.equal((await bob.call('PUT', `/api/documents/${d.id}/star`)).status, 200);
    assert.equal((await bob.call('PUT', `/api/documents/${d.id}/star`)).status, 200);
    assert.equal((await bob.call('GET', '/api/documents')).body.shared[0].starred, true);
    assert.equal((await alice.call('GET', '/api/documents')).body.owned.find((x) => x.id === d.id).starred, false);
    assert.equal((await alice.call('DELETE', `/api/documents/${d.id}/star`)).status, 200);
    assert.equal((await bob.call('DELETE', `/api/documents/${d.id}/star`)).body.starred, false);
  } finally { await s.close(); }
});

test('shared-with-me flags: New clears only for the recipient who opens it, and an upgraded share re-flags as New', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob'), carol = await s.as('carol');
    const d = await mk(alice, 'Flag');
    for (const u of ['bob', 'carol']) await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: u, role: 'viewer' });
    const flag = async (c) => (await c.call('GET', '/api/documents')).body.shared.find((x) => x.id === d.id).unseen;
    assert.equal(await flag(bob), true); assert.equal(await flag(carol), true);
    await bob.call('GET', `/api/documents/${d.id}`);
    assert.equal(await flag(bob), false); assert.equal(await flag(carol), true);
    await alice.call('GET', `/api/documents/${d.id}`);
    assert.equal(await flag(carol), true, 'owner opening it does not clear anyone else');
  } finally { await s.close(); }
});

test('registration: usernames are normalised to lowercase and collide case-insensitively; password and display-name bounds', async () => {
  const s = await start({ registerRateLimit: 100 });
  try {
    const reg = (b) => s.client().call('POST', '/api/register', b);
    const ok = await reg({ username: 'New_User1', display_name: '  New   User ', password: 'x'.repeat(200) });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.username, 'new_user1');
    assert.equal(ok.body.display_name, 'New User');
    assert.equal(ok.body.password_hash, undefined, 'hash never leaves the server');
    assert.equal((await reg({ username: 'NEW_USER1', display_name: 'x', password: 'password1' })).status, 409);
    assert.equal((await reg({ username: 'ALICE', display_name: 'x', password: 'password1' })).status, 409);
    assert.equal((await reg({ username: 'okname', display_name: 'x', password: 'x'.repeat(201) })).status, 400);
    assert.equal((await reg({ username: 'okname', display_name: 'x', password: 'x'.repeat(7) })).status, 400);
    assert.equal((await reg({ username: 'okname', display_name: 'n'.repeat(61), password: 'password1' })).status, 400);
    assert.equal((await reg({ username: 'okname', display_name: '   ', password: 'password1' })).status, 400);
    for (const u of ['ab', 'a'.repeat(25), 'has space', 'dash-ed', 'ünï', '']) assert.equal((await reg({ username: u, display_name: 'x', password: 'password1' })).status, 400, u);
    const c = s.client();
    await c.call('POST', '/api/register', { username: 'cookie_u', display_name: 'C', password: 'password1' });
    assert.equal((await c.call('GET', '/api/me')).status, 200);
  } finally { await s.close(); }
});

test('sessions are independent: logging out one browser leaves the same user signed in on another; bad cookies are anonymous', async () => {
  const s = await start();
  try {
    const one = await s.as('alice'), two = await s.as('alice');
    assert.notEqual(one.cookie, two.cookie);
    await one.call('POST', '/api/logout');
    assert.equal((await one.call('GET', '/api/me')).status, 401);
    assert.equal((await two.call('GET', '/api/me')).status, 200);
    const forged = s.client(); forged.cookie = 'sid=' + 'a'.repeat(48);
    assert.equal((await forged.call('GET', '/api/me')).status, 401);
    assert.equal((await forged.call('GET', '/api/session')).body.user, null);
    const users = (await two.call('GET', '/api/users')).body;
    assert.ok(!users.some((u) => u.username === 'alice'), 'the user list excludes the caller');
    assert.ok(users.every((u) => !('password_hash' in u)));
  } finally { await s.close(); }
});
