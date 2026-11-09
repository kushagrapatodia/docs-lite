'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, openEvents } = require('./helpers');
const { LIMITS } = require('../src/app');

const mk = async (c, title = 'Doc', content) => (await c.call('POST', '/api/documents', content === undefined ? { title } : { title, content })).body;

test('sharing: self-share, unknown user, bad role and duplicate share are handled; role upsert keeps one row; username is case-insensitive', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const d = await mk(alice);
    const url = `/api/documents/${d.id}/shares`;
    assert.equal((await alice.call('PUT', url, { username: 'alice', role: 'editor' })).status, 400);
    assert.equal((await alice.call('PUT', url, { username: 'nobody', role: 'editor' })).status, 404);
    assert.equal((await alice.call('PUT', url, { username: 'bob', role: 'owner' })).status, 400);
    assert.equal((await alice.call('PUT', url, { username: 'bob' })).status, 400);
    assert.equal((await alice.call('PUT', url, { role: 'viewer' })).status, 404);
    const a = await alice.call('PUT', url, { username: '  BOB ', role: 'viewer' });
    assert.equal(a.status, 200);
    const b = await alice.call('PUT', url, { username: 'bob', role: 'editor' });
    assert.equal(b.body.length, 1);
    assert.equal(b.body[0].role, 'editor');
  } finally { await s.close(); }
});

test('only the owner can share, unshare, link or manage a document; editors and viewers get 403, strangers 404', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob'), carol = await s.as('carol');
    const d = await mk(alice);
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'editor' });
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'carol', role: 'viewer' });
    const bobId = (await bob.call('GET', '/api/me')).body.id;
    const reqs = [['PUT', `/api/documents/${d.id}/shares`, { username: 'carol', role: 'editor' }], ['POST', `/api/documents/${d.id}/link`, {}], ['DELETE', `/api/documents/${d.id}/link`], ['DELETE', `/api/documents/${d.id}`], ['DELETE', `/api/documents/${d.id}/shares/${bobId}`]];
    for (const [m, u, b] of reqs) {
      assert.equal((await bob.call(m, u, b)).status, 403, `editor ${m} ${u}`);
      assert.equal((await carol.call(m, u, b)).status, 403, `viewer ${m} ${u}`);
    }
    const dave = await s.client();
    await dave.call('POST', '/api/register', { username: 'dave_x', display_name: 'Dave', password: 'password1' });
    for (const [m, u, b] of reqs) assert.equal((await dave.call(m, u, b)).status, 404, `stranger ${m} ${u}`);
  } finally { await s.close(); }
});

test('role changes mid-session take effect on the next request and are pushed over SSE; revoking ends the stream', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'Live', '<p>x</p>');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'editor' });
    const ev = await openEvents(bob, d.id);
    assert.equal((await ev.waitFor((e) => e.event === 'hello')).data.role, 'editor');
    assert.equal((await bob.call('PATCH', `/api/documents/${d.id}`, { title: 'T1', base_version: 1 })).status, 200);
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    assert.equal((await ev.waitFor((e) => e.event === 'role')).data.role, 'viewer');
    const denied = await bob.call('PATCH', `/api/documents/${d.id}`, { title: 'T2', base_version: 2 });
    assert.equal(denied.status, 403);
    const bobId = (await bob.call('GET', '/api/me')).body.id;
    await alice.call('DELETE', `/api/documents/${d.id}/shares/${bobId}`);
    const rev = await ev.waitFor((e) => e.event === 'revoked');
    assert.ok(rev && rev.data.reason);
    assert.equal((await bob.call('GET', `/api/documents/${d.id}`)).status, 404);
    ev.close();
  } finally { await s.close(); }
});

test('SSE: settings changes reach other collaborators but not the sender; viewers cannot change settings', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice);
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    const evA = await openEvents(alice, d.id), evB = await openEvents(bob, d.id);
    await evA.waitFor((e) => e.event === 'hello'); await evB.waitFor((e) => e.event === 'hello');
    assert.equal((await bob.call('PUT', `/api/documents/${d.id}/settings`, { size: 'letter' })).status, 403);
    const r = await alice.call('PUT', `/api/documents/${d.id}/settings`, { size: 'legal', orientation: 'landscape' });
    assert.equal(r.status, 200);
    const got = await evB.waitFor((e) => e.event === 'settings');
    assert.equal(got.data.settings.size, 'legal');
    await new Promise((r2) => setTimeout(r2, 150));
    assert.equal(evA.events.some((e) => e.event === 'settings'), false);
    evA.close(); evB.close();
  } finally { await s.close(); }
});

test('settings validation: each field is checked, missing fields reset to defaults, unknown keys are dropped', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const d = await mk(alice);
    const put = (b) => alice.call('PUT', `/api/documents/${d.id}/settings`, b);
    for (const bad of [{ size: 'a0' }, { size: '__proto__' }, { orientation: 'sideways' }, { margins: 'huge' }, { header: 5 }, { footer: 'x'.repeat(121) }, { pageNumbers: 'yes' }]) assert.equal((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    const ok = await put({ header: ' Line\u0000one\n two ', evil: '<script>' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.header, 'Line one two');
    assert.equal(ok.body.size, 'a4');
    assert.equal('evil' in ok.body, false);
    assert.equal((await put({ footer: 'x'.repeat(120) })).status, 200);
    const again = await alice.call('GET', `/api/documents/${d.id}`);
    assert.equal(again.body.settings.header, '', 'a PUT replaces, it does not merge');
  } finally { await s.close(); }
});

test('trash: restoring brings back list, search and access for shares; erased documents 404 on restore; strangers cannot restore', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'Zebra plan', '<p>quokka budget</p>');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    await alice.call('DELETE', `/api/documents/${d.id}`);
    assert.equal((await alice.call('DELETE', `/api/documents/${d.id}`)).status, 404, 'a trashed document cannot be deleted again');
    assert.equal((await bob.call('GET', '/api/documents?q=quokka')).body.shared.length, 0);
    assert.equal((await bob.call('POST', `/api/trash/${d.id}/restore`)).status, 404);
    assert.equal((await bob.call('DELETE', `/api/trash/${d.id}`)).status, 404);
    assert.equal((await alice.call('GET', `/api/documents/${d.id}/comments`)).status, 404, 'trashed documents are closed to their owner too');
    const r = await alice.call('POST', `/api/trash/${d.id}/restore`);
    assert.equal(r.status, 200);
    assert.equal((await alice.call('POST', `/api/trash/${d.id}/restore`)).status, 404, 'restoring something not in the trash');
    assert.equal((await bob.call('GET', '/api/documents?q=quokka')).body.shared.length, 1);
    await alice.call('DELETE', `/api/documents/${d.id}`);
    assert.equal((await alice.call('DELETE', `/api/trash/${d.id}`)).status, 200);
    assert.equal((await alice.call('POST', `/api/trash/${d.id}/restore`)).status, 404);
    assert.equal((await alice.call('DELETE', `/api/trash/999999`)).status, 404);
    assert.equal((await alice.call('GET', '/api/documents?q=quokka')).body.owned.length, 0);
  } finally { await s.close(); }
});

test('version labels: trimmed, whitespace collapsed, null clears, length limit, wrong type, viewers cannot, 30 named versions max', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'V', '<p>0</p>');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    const vid = (await alice.call('GET', `/api/documents/${d.id}/versions`)).body[0].id;
    const url = `/api/documents/${d.id}/versions/${vid}/label`;
    assert.equal((await bob.call('PUT', url, { label: 'x' })).status, 403);
    assert.equal((await alice.call('PUT', url, { label: 42 })).status, 400);
    assert.equal((await alice.call('PUT', url, { label: 'y'.repeat(LIMITS.versionLabel + 1) })).status, 400);
    assert.equal((await alice.call('PUT', url, { label: 'y'.repeat(LIMITS.versionLabel) })).status, 200);
    let r = await alice.call('PUT', url, { label: '  Sent   to\n legal ' });
    assert.equal(r.body[0].label, 'Sent to legal');
    r = await alice.call('PUT', url, { label: null });
    assert.equal(r.body[0].label, null);
    assert.equal((await alice.call('PUT', `/api/documents/${d.id}/versions/99999/label`, { label: 'a' })).status, 404);
    // another document's version id is not reachable through this document
    const other = await mk(alice, 'Other');
    const ovid = (await alice.call('GET', `/api/documents/${other.id}/versions`)).body[0].id;
    assert.equal((await alice.call('PUT', `/api/documents/${d.id}/versions/${ovid}/label`, { label: 'a' })).status, 404);
    assert.equal((await alice.call('GET', `/api/documents/${d.id}/versions/${ovid}`)).status, 404);
    // fill 30 labels via forced snapshots (restores)
    let ver = 1;
    for (let i = 0; i < LIMITS.namedVersions; i++) {
      const vs = (await alice.call('GET', `/api/documents/${d.id}/versions`)).body;
      const rr = await alice.call('PUT', `/api/documents/${d.id}/versions/${vs[0].id}/label`, { label: `n${i}` });
      assert.equal(rr.status, 200, `label ${i}`);
      const cur = (await alice.call('GET', `/api/documents/${d.id}`)).body.version;
      ver = (await alice.call('PATCH', `/api/documents/${d.id}`, { content: `<p>${i + 1}</p>`, base_version: cur })).body.version;
    }
    const vs = (await alice.call('GET', `/api/documents/${d.id}/versions`)).body;
    const unlabeled = vs.find((v) => !v.label);
    const over = await alice.call('PUT', `/api/documents/${d.id}/versions/${unlabeled.id}/label`, { label: 'one too many' });
    assert.equal(over.status, 409);
    // renaming an already-named version is still allowed at the cap
    const named = vs.find((v) => v.label);
    assert.equal((await alice.call('PUT', `/api/documents/${d.id}/versions/${named.id}/label`, { label: 'renamed' })).status, 200);
    assert.ok(ver > 1);
  } finally { await s.close(); }
});

test('version restore: creates a new version with a forced snapshot, notifies everyone including the restorer, viewers cannot', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d = await mk(alice, 'R', '<p>one</p>');
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'viewer' });
    await alice.call('PATCH', `/api/documents/${d.id}`, { content: '<p>two</p>', base_version: 1 });
    const vs = (await alice.call('GET', `/api/documents/${d.id}/versions`)).body;
    const first = vs[vs.length - 1];
    assert.equal((await bob.call('POST', `/api/documents/${d.id}/versions/${first.id}/restore`)).status, 403);
    const ev = await openEvents(alice, d.id);
    await ev.waitFor((e) => e.event === 'hello');
    const r = await alice.call('POST', `/api/documents/${d.id}/versions/${first.id}/restore`);
    assert.equal(r.status, 200);
    assert.match(r.body.content, /one/);
    assert.equal(r.body.version, 3);
    const upd = await ev.waitFor((e) => e.event === 'update');
    assert.equal(upd.data.version, 3, 'restorer is notified too (notifyAll)');
    const after = (await alice.call('GET', `/api/documents/${d.id}/versions`)).body;
    assert.equal(after.length, vs.length + 1, 'restore is its own history entry, never merged into the last one');
    ev.close();
  } finally { await s.close(); }
});

test('comments: replies must belong to the same document, cannot be nested, drop quotes; replies cannot be resolved; viewers cannot resolve', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const d1 = await mk(alice, 'A'), d2 = await mk(alice, 'B');
    await alice.call('PUT', `/api/documents/${d1.id}/shares`, { username: 'bob', role: 'viewer' });
    const top = (await alice.call('POST', `/api/documents/${d1.id}/comments`, { body: 'top', quote: 'quoted' })).body;
    const elsewhere = (await alice.call('POST', `/api/documents/${d2.id}/comments`, { body: 'x' })).body;
    assert.equal((await alice.call('POST', `/api/documents/${d1.id}/comments`, { body: 'r', parent_id: elsewhere.id })).status, 404);
    for (const bad of ['1', 1.5, -1, 0, {}, [], true]) assert.equal((await alice.call('POST', `/api/documents/${d1.id}/comments`, { body: 'r', parent_id: bad })).status, 404, JSON.stringify(bad));
    const reply = await bob.call('POST', `/api/documents/${d1.id}/comments`, { body: 'reply', quote: 'ignored', parent_id: top.id });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.quote, null);
    assert.equal(reply.body.parent_id, top.id);
    assert.equal((await alice.call('POST', `/api/documents/${d1.id}/comments`, { body: 'nest', parent_id: reply.body.id })).status, 400);
    assert.equal((await alice.call('PATCH', `/api/documents/${d1.id}/comments/${reply.body.id}`, { resolved: true })).status, 400);
    assert.equal((await bob.call('PATCH', `/api/documents/${d1.id}/comments/${top.id}`, { resolved: true })).status, 403);
    assert.equal((await alice.call('PATCH', `/api/documents/${d1.id}/comments/${top.id}`, { resolved: 'true' })).status, 400);
    const res = await alice.call('PATCH', `/api/documents/${d1.id}/comments/${top.id}`, { resolved: true });
    assert.equal(res.body.resolved, true);
    // a comment id from another document is not addressable
    assert.equal((await alice.call('DELETE', `/api/documents/${d1.id}/comments/${elsewhere.id}`)).status, 404);
  } finally { await s.close(); }
});

test('comments: CRLF is normalised, whitespace-only rejected, body is stored as text (not interpreted)', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const d = await mk(alice);
    const url = `/api/documents/${d.id}/comments`;
    assert.equal((await alice.call('POST', url, { body: ' \n\t ' })).status, 400);
    assert.equal((await alice.call('POST', url, { body: 'a'.repeat(LIMITS.commentLength + 1) })).status, 400);
    const c = await alice.call('POST', url, { body: 'line1\r\nline2 <img src=x onerror=alert(1)>', quote: 'q'.repeat(LIMITS.quoteLength) });
    assert.equal(c.status, 201);
    assert.equal(c.body.body, 'line1\nline2 <img src=x onerror=alert(1)>');
    assert.equal((await alice.call('POST', url, { body: 'x', quote: 'q'.repeat(LIMITS.quoteLength + 1) })).status, 400);
  } finally { await s.close(); }
});

test('public link: rotation invalidates the old token, revocation and trash hide it, restore revives the same token, responses are not cacheable', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), anon = s.client();
    const d = await mk(alice, 'Public', '<p>hello</p>');
    const t1 = (await alice.call('POST', `/api/documents/${d.id}/link`)).body.link_token;
    assert.match(t1, /^[A-Za-z0-9_-]{24}$/);
    const t2 = (await alice.call('POST', `/api/documents/${d.id}/link`)).body.link_token;
    assert.notEqual(t1, t2);
    assert.equal((await anon.call('GET', `/api/public/${t1}`)).status, 404);
    const pub = await anon.call('GET', `/api/public/${t2}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(pub.headers.get('cache-control'), 'no-store');
    assert.equal(pub.body.owner_name, 'Alice Rivera');
    assert.ok(!('id' in pub.body) && !('shares' in pub.body) && !('link_token' in pub.body), 'no internals leak');
    assert.equal((await anon.call('GET', '/api/public/short')).status, 404);
    await alice.call('DELETE', `/api/documents/${d.id}`);
    assert.equal((await anon.call('GET', `/api/public/${t2}`)).status, 404);
    await alice.call('POST', `/api/trash/${d.id}/restore`);
    assert.equal((await anon.call('GET', `/api/public/${t2}`)).status, 200, 'link survives trash/restore');
    await alice.call('DELETE', `/api/documents/${d.id}/link`);
    assert.equal((await anon.call('GET', `/api/public/${t2}`)).status, 404);
    // a public link grants no write or private-API access
    assert.equal((await anon.call('GET', `/api/documents/${d.id}`)).status, 401);
    // a collaborator never sees the token
    await alice.call('PUT', `/api/documents/${d.id}/shares`, { username: 'bob', role: 'editor' });
    const bob = await s.as('bob');
    await alice.call('POST', `/api/documents/${d.id}/link`);
    assert.equal((await bob.call('GET', `/api/documents/${d.id}`)).body.link_token, undefined);
  } finally { await s.close(); }
});

test('ETag: document reads validate with If-None-Match (304) until the content, role or title changes; lists likewise', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const d = await mk(alice, 'Tagged', '<p>a</p>');
    const url = `/api/documents/${d.id}`;
    const r1 = await alice.call('GET', url);
    const tag = r1.headers.get('etag');
    assert.ok(tag);
    assert.equal(r1.headers.get('cache-control'), 'private, no-cache');
    const hit = await alice.call('GET', url, undefined, { 'If-None-Match': tag });
    assert.equal(hit.status, 304);
    assert.equal(hit.body, '');
    assert.equal((await alice.call('GET', url, undefined, { 'If-None-Match': `"zzz", ${tag}` })).status, 304, 'list of validators');
    assert.equal((await alice.call('GET', url, undefined, { 'If-None-Match': '"other"' })).status, 200);
    await alice.call('PATCH', url, { title: 'Tagged 2', base_version: 1 });
    const r2 = await alice.call('GET', url, undefined, { 'If-None-Match': tag });
    assert.equal(r2.status, 200);
    assert.notEqual(r2.headers.get('etag'), tag);
    const l1 = await alice.call('GET', '/api/documents');
    assert.equal((await alice.call('GET', '/api/documents', undefined, { 'If-None-Match': l1.headers.get('etag') })).status, 304);
    await alice.call('PUT', `${url}/star`);
    assert.equal((await alice.call('GET', '/api/documents', undefined, { 'If-None-Match': l1.headers.get('etag') })).status, 200, 'starring changes the list');
    // errors and writes never carry validators
    const w = await alice.call('PATCH', url, { title: 'x', base_version: 2 });
    assert.equal(w.headers.get('etag'), null);
  } finally { await s.close(); }
});

test('export: Content-Disposition filename is sanitised for every format; content types are right; default format is docx; case-insensitive', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const types = { docx: /wordprocessingml/, md: /^text\/markdown/, html: /^text\/html/, txt: /^text\/plain/ };
    const cases = [['Q1/Q2: "Plan"!', 'Q1Q2-Plan'], ['日本語', 'document'], ['a  b\tc', 'a-b-c'], ['x'.repeat(150), 'x'.repeat(80)], ['../../etc/passwd', 'etcpasswd']];
    for (const [title, want] of cases) {
      const d = await mk(alice, title, '<p>body</p>');
      for (const f of Object.keys(types)) {
        const res = await alice.raw('GET', `/api/documents/${d.id}/export?format=${f}`);
        assert.equal(res.status, 200, f);
        assert.match(res.headers.get('content-type'), types[f]);
        assert.equal(res.headers.get('content-disposition'), `attachment; filename="${want}.${f}"`, `${title} ${f}`);
        await res.arrayBuffer();
      }
    }
    const d = await mk(alice, 'Def', '<p>b</p>');
    assert.match((await alice.raw('GET', `/api/documents/${d.id}/export`)).headers.get('content-disposition'), /Def\.docx/);
    assert.match((await alice.raw('GET', `/api/documents/${d.id}/export?format=MD`)).headers.get('content-disposition'), /Def\.md/);
    for (const bad of ['pdf', '', 'constructor', '__proto__', 'toString']) {
      const e = await alice.call('GET', `/api/documents/${d.id}/export?format=${bad}`);
      assert.equal(e.status, bad === '' ? 200 : 400, bad); // empty means default
    }
  } finally { await s.close(); }
});

test('export: md/txt/html contain the title and the content; html export embeds page setup and escapes the title', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const d = await mk(alice, 'A <b>&</b> B', '<h2>Head</h2><p>para <b>bold</b></p>');
    await alice.call('PUT', `/api/documents/${d.id}/settings`, { size: 'letter', orientation: 'landscape', header: '</style><script>alert(1)</script>', pageNumbers: true });
    const get = async (f) => (await alice.call('GET', `/api/documents/${d.id}/export?format=${f}`)).body;
    const md = await get('md'); assert.match(md, /^# A <b>&<\/b> B\n/); assert.match(md, /## Head/); assert.match(md, /\*\*bold\*\*/);
    const txt = await get('txt'); assert.match(txt, /^A <b>&<\/b> B\n\n/); assert.ok(!txt.includes('<h2>'));
    const html = await get('html');
    assert.ok(!html.includes('<script>alert(1)'), 'header text cannot inject a script');
    assert.ok(!/<\/style><script/i.test(html));
    assert.match(html, /@page\{size:letter landscape/);
    assert.match(html, /<title>A &lt;b&gt;&amp;&lt;\/b&gt; B<\/title>/);
  } finally { await s.close(); }
});

test('idempotency: replay is per user, key shape is enforced, failures are not remembered, replay carries the original status', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice'), bob = await s.as('bob');
    const key = 'abcdefgh-1234';
    const a = await alice.call('POST', '/api/documents', { title: 'One' }, { 'Idempotency-Key': key });
    const b = await bob.call('POST', '/api/documents', { title: 'One' }, { 'Idempotency-Key': key });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    assert.notEqual(a.body.id, b.body.id, 'same key, different users: independent');
    const again = await alice.call('POST', '/api/documents', { title: 'One' }, { 'Idempotency-Key': key });
    assert.equal(again.status, 201, 'replay keeps the original status');
    assert.equal(again.body.id, a.body.id);
    // too-short key is ignored (no dedupe)
    const x = await alice.call('POST', '/api/documents', { title: 'S' }, { 'Idempotency-Key': 'short' });
    const y = await alice.call('POST', '/api/documents', { title: 'S' }, { 'Idempotency-Key': 'short' });
    assert.notEqual(x.body.id, y.body.id);
    // a failed request (400) does not poison the key
    const k2 = 'failkey-0001';
    assert.equal((await alice.call('POST', '/api/documents', { title: '' }, { 'Idempotency-Key': k2 })).status, 400);
    assert.equal((await alice.call('POST', '/api/documents', { title: '' }, { 'Idempotency-Key': k2 })).status, 400);
    assert.equal((await alice.call('POST', '/api/documents', { title: 'fine' }, { 'Idempotency-Key': k2 })).status, 201, 'the key is free again, so a corrected request goes through');
  } finally { await s.close(); }
});

test('idempotency: concurrent duplicates never create two documents', async () => {
  const s = await start();
  try {
    const alice = await s.as('alice');
    const key = 'concurrent-key-1';
    const rs = await Promise.all(Array.from({ length: 6 }, () => alice.call('POST', '/api/documents', { title: 'Racy' }, { 'Idempotency-Key': key })));
    for (const r of rs) assert.ok([201, 409].includes(r.status), `status ${r.status}`);
    assert.ok(rs.some((r) => r.status === 201));
    const list = (await alice.call('GET', '/api/documents')).body.owned.filter((d) => d.title === 'Racy');
    assert.equal(list.length, 1);
  } finally { await s.close(); }
});
