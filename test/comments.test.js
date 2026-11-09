'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, openEvents } = require('./helpers');

async function setup() {
  const env = await start();
  const [alice, bob, carol] = [await env.as('alice'), await env.as('bob'), await env.as('carol')];
  const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Commented' });
  await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
  await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'viewer' });
  return { ...env, alice, bob, carol, doc };
}

test('comments: everyone with access can read and add, strangers cannot', async () => {
  const { close, alice, bob, carol, doc, client } = await setup();
  try {
    for (const who of [alice, bob, carol]) {
      const r = await who.call('POST', `/api/documents/${doc.id}/comments`, { body: `hello from ${who === alice ? 'alice' : who === bob ? 'bob' : 'carol'}` });
      assert.equal(r.status, 201);
      assert.equal(r.body.resolved, false);
    }
    const list = (await carol.call('GET', `/api/documents/${doc.id}/comments`)).body;
    assert.deepEqual(list.map((c) => c.author_name), ['Alice Rivera', 'Bob Chen', 'Carol Okafor']);
    const dana = client();
    await dana.call('POST', '/api/register', { username: 'dana', display_name: 'Dana', password: 'password123' });
    assert.equal((await dana.call('GET', `/api/documents/${doc.id}/comments`)).status, 404);
    assert.equal((await dana.call('POST', `/api/documents/${doc.id}/comments`, { body: 'x' })).status, 404);
    assert.equal((await client().call('GET', `/api/documents/${doc.id}/comments`)).status, 401);
  } finally { await close(); }
});

test('comments: validation and limits', async () => {
  const { close, alice, doc } = await setup();
  try {
    const url = `/api/documents/${doc.id}/comments`;
    assert.equal((await alice.call('POST', url, { body: '   ' })).status, 400);
    assert.equal((await alice.call('POST', url, {})).status, 400);
    assert.equal((await alice.call('POST', url, { body: 'x'.repeat(2001) })).status, 400);
    const ok = await alice.call('POST', url, { body: 'x'.repeat(2000) });
    assert.equal(ok.status, 201);
    const html = await alice.call('POST', url, { body: '<img src=x onerror=alert(1)> & "quotes"' });
    assert.equal(html.body.body, '<img src=x onerror=alert(1)> & "quotes"', 'stored as plain text; the client renders it with textContent');
    assert.equal((await alice.call('POST', url, { body: 'multi\r\nline\n\ntext' })).body.body, 'multi\nline\n\ntext');
  } finally { await close(); }
});

test('comments: only the author or the owner can delete; editors resolve, viewers cannot', async () => {
  const { close, alice, bob, carol, doc } = await setup();
  try {
    const url = `/api/documents/${doc.id}/comments`;
    const byBob = (await bob.call('POST', url, { body: 'bob says' })).body;
    const byCarol = (await carol.call('POST', url, { body: 'carol says' })).body;
    assert.equal((await carol.call('DELETE', `${url}/${byBob.id}`)).status, 403, 'a viewer cannot delete someone else\'s comment');
    assert.equal((await bob.call('DELETE', `${url}/${byCarol.id}`)).status, 403, 'an editor cannot delete someone else\'s comment either');
    assert.equal((await carol.call('DELETE', `${url}/${byCarol.id}`)).status, 200, 'authors can delete their own');
    assert.equal((await alice.call('DELETE', `${url}/${byBob.id}`)).status, 200, 'the owner can delete any comment');
    assert.equal((await alice.call('DELETE', `${url}/${byBob.id}`)).status, 404);

    const c = (await alice.call('POST', url, { body: 'to resolve' })).body;
    assert.equal((await carol.call('PATCH', `${url}/${c.id}`, { resolved: true })).status, 403, 'viewers cannot resolve');
    const r = await bob.call('PATCH', `${url}/${c.id}`, { resolved: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.resolved, true);
    assert.equal((await bob.call('PATCH', `${url}/${c.id}`, { resolved: 'yes' })).status, 400);
    assert.equal((await bob.call('PATCH', `${url}/${c.id}`, { resolved: false })).body.resolved, false);
    assert.equal((await bob.call('PATCH', `${url}/999999`, { resolved: true })).status, 404);
  } finally { await close(); }
});

test('comments are scoped to their document and removed with it', async () => {
  const { close, alice, doc, db } = await setup();
  try {
    const { body: other } = await alice.call('POST', '/api/documents', { title: 'Other' });
    const c = (await alice.call('POST', `/api/documents/${doc.id}/comments`, { body: 'one' })).body;
    assert.equal((await alice.call('DELETE', `/api/documents/${other.id}/comments/${c.id}`)).status, 404, 'cannot reach a comment through another document');
    assert.equal((await alice.call('GET', `/api/documents/${other.id}/comments`)).body.length, 0);
    await alice.call('DELETE', `/api/documents/${doc.id}`);
    await alice.call('DELETE', `/api/trash/${doc.id}`); // erase from the trash
    assert.equal(db.prepare('SELECT COUNT(*) n FROM comments').get().n, 0);
  } finally { await close(); }
});

test('comments: live events reach other collaborators but not the author', async () => {
  const { close, alice, bob, carol, doc } = await setup();
  try {
    const [a, b] = [await openEvents(alice, doc.id), await openEvents(bob, doc.id)];
    await b.waitFor((e) => e.event === 'hello');
    const c = (await carol.call('POST', `/api/documents/${doc.id}/comments`, { body: 'live one' })).body;
    for (const s of [a, b]) {
      const ev = await s.waitFor((e) => e.event === 'comment' && e.data.type === 'added');
      assert.equal(ev.data.comment.body, 'live one');
    }
    await bob.call('PATCH', `/api/documents/${doc.id}/comments/${c.id}`, { resolved: true });
    assert.ok(await a.waitFor((e) => e.event === 'comment' && e.data.type === 'updated' && e.data.comment.resolved === true));
    await alice.call('DELETE', `/api/documents/${doc.id}/comments/${c.id}`);
    assert.ok(await b.waitFor((e) => e.event === 'comment' && e.data.type === 'deleted' && e.data.comment.id === c.id));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(a.events.filter((e) => e.event === 'comment' && e.data.type === 'deleted').length, 0, 'the deleter is not notified of their own action');
    [a, b].forEach((s) => s.close());
  } finally { await close(); }
});

test('comment limit per document', async () => {
  const { close, alice, doc, db } = await setup();
  try {
    const ins = db.prepare('INSERT INTO comments (document_id, author_id, body) VALUES (?,?,?)');
    for (let i = 0; i < 500; i++) ins.run(doc.id, 1, `c${i}`);
    const r = await alice.call('POST', `/api/documents/${doc.id}/comments`, { body: 'one too many' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /limit/);
  } finally { await close(); }
});

test('comments can quote the text they refer to (stored as plain text, trimmed and limited)', async () => {
  const { close, alice, carol, doc } = await setup();
  try {
    const url = `/api/documents/${doc.id}/comments`;
    const r = await carol.call('POST', url, { body: 'Is this right?', quote: '  the quoted\n  passage  ' });
    assert.equal(r.status, 201);
    assert.equal(r.body.quote, 'the quoted passage');
    assert.equal((await alice.call('POST', url, { body: 'no quote' })).body.quote, null);
    assert.equal((await alice.call('POST', url, { body: 'blank quote', quote: '   ' })).body.quote, null);
    assert.equal((await alice.call('POST', url, { body: 'too long', quote: 'q'.repeat(301) })).status, 400);
    assert.equal((await alice.call('POST', url, { body: 'ok at the limit', quote: 'q'.repeat(300) })).status, 201);
    const listed = (await alice.call('GET', url)).body;
    assert.equal(listed[0].quote, 'the quoted passage');
    const html = (await alice.call('POST', url, { body: 'x', quote: '<script>alert(1)</script>' })).body;
    assert.equal(html.quote, '<script>alert(1)</script>', 'plain text; the client renders it with textContent');
  } finally { await close(); }
});

test('comment replies: threaded, one level deep, cascade on delete, resolve applies to the thread', async () => {
  const { close, alice, bob, carol, doc, client } = await setup();
  try {
    const base = `/api/documents/${doc.id}/comments`;
    const root = (await alice.call('POST', base, { body: 'Is this right?', quote: 'the plan' })).body;
    const r1 = await carol.call('POST', base, { body: 'Looks fine', parent_id: root.id, quote: 'ignored' });
    assert.equal(r1.status, 201);
    assert.equal(r1.body.parent_id, root.id);
    assert.equal(r1.body.quote, null, 'replies never carry their own quote');
    const r2 = await bob.call('POST', base, { body: 'Agreed', parent_id: root.id });
    assert.equal(r2.status, 201);
    // validation
    assert.equal((await bob.call('POST', base, { body: 'x', parent_id: r1.body.id })).body.error, 'Replies cannot be nested');
    assert.equal((await bob.call('POST', base, { body: 'x', parent_id: 999999 })).status, 404);
    assert.equal((await bob.call('POST', base, { body: 'x', parent_id: 'abc' })).status, 404);
    const other = (await alice.call('POST', '/api/documents', { title: 'Other' })).body;
    const foreign = (await alice.call('POST', `/api/documents/${other.id}/comments`, { body: 'elsewhere' })).body;
    assert.equal((await bob.call('POST', base, { body: 'x', parent_id: foreign.id })).status, 404, 'cannot reply across documents');
    assert.equal((await alice.call('PATCH', `${base}/${r1.body.id}`, { resolved: true })).status, 400, 'a reply cannot be resolved on its own');
    // the list carries parent_id; resolving the thread works
    const list = (await alice.call('GET', base)).body;
    assert.deepEqual(list.map((c) => c.parent_id), [null, root.id, root.id]);
    assert.equal((await bob.call('PATCH', `${base}/${root.id}`, { resolved: true })).body.resolved, true);
    // a viewer may delete their own reply; deleting the root removes the whole thread
    assert.equal((await carol.call('DELETE', `${base}/${r1.body.id}`)).status, 200);
    assert.equal((await alice.call('GET', base)).body.length, 2);
    assert.equal((await alice.call('DELETE', `${base}/${root.id}`)).status, 200);
    assert.equal((await alice.call('GET', base)).body.length, 0, 'replies disappear with their thread');
    void client;
  } finally { await close(); }
});
