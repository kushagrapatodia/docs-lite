'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, openEvents } = require('./helpers');

async function setup() {
  const env = await start();
  const [alice, bob, carol] = [await env.as('alice'), await env.as('bob'), await env.as('carol')];
  const { body: doc } = await alice.call('POST', '/api/documents', { title: 'Live' });
  await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'bob', role: 'editor' });
  await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'viewer' });
  return { ...env, alice, bob, carol, doc };
}

test('events: requires login and access', async () => {
  const { client, as, close, doc } = await setup();
  try {
    assert.equal((await openEvents(client(), doc.id)).status, 401);
    const dana = client();
    await dana.call('POST', '/api/register', { username: 'dana', display_name: 'Dana', password: 'password123' });
    assert.equal((await openEvents(dana, doc.id)).status, 404);
    const alice = await as('alice');
    const ok = await openEvents(alice, doc.id);
    assert.equal(ok.status, 200);
    ok.close();
  } finally { await close(); }
});

test('presence: hello lists who is here; joins and leaves are broadcast', async () => {
  const { close, alice, bob, doc } = await setup();
  try {
    const a = await openEvents(alice, doc.id);
    const hello = await a.waitFor((e) => e.event === 'hello');
    assert.equal(hello.data.role, 'owner');
    assert.deepEqual(hello.data.users.map((u) => u.name), ['Alice Rivera']);
    const b = await openEvents(bob, doc.id);
    const joined = await a.waitFor((e) => e.event === 'presence' && e.data.users.length === 2);
    assert.deepEqual(joined.data.users.map((u) => u.name).sort(), ['Alice Rivera', 'Bob Chen']);
    // a second tab for the same person does not duplicate them
    const b2 = await openEvents(bob, doc.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(a.events.filter((e) => e.event === 'presence').at(-1).data.users.length, 2);
    b2.close();
    b.close();
    const left = await a.waitFor((e) => e.event === 'presence' && e.data.users.length === 1 && a.events.indexOf(e) > 1);
    assert.ok(left, 'leave should be broadcast once the last tab closes');
    a.close();
  } finally { await close(); }
});

test('update: edits are pushed to the other collaborators (including viewers) but not echoed to the author', async () => {
  const { close, alice, bob, carol, doc } = await setup();
  try {
    const [a, b, c] = [await openEvents(alice, doc.id), await openEvents(bob, doc.id), await openEvents(carol, doc.id)];
    await b.waitFor((e) => e.event === 'hello');
    const save = await bob.call('PATCH', `/api/documents/${doc.id}`, { title: 'Live v2', content: '<p>hello <b>team</b></p>', base_version: 1 });
    assert.equal(save.status, 200);
    for (const viewer of [a, c]) {
      const up = await viewer.waitFor((e) => e.event === 'update');
      assert.ok(up, 'collaborator should receive the update');
      assert.equal(up.data.version, 2);
      assert.equal(up.data.title, 'Live v2');
      assert.equal(up.data.content, '<p>hello <b>team</b></p>');
      assert.equal(up.data.updated_by_name, 'Bob Chen');
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(b.events.filter((e) => e.event === 'update').length, 0, 'the author does not get their own edit back');
    [a, b, c].forEach((s) => s.close());
  } finally { await close(); }
});

test('restoring a version notifies everyone, including the person who restored it', async () => {
  const { close, alice, bob, doc } = await setup();
  try {
    await alice.call('PATCH', `/api/documents/${doc.id}`, { content: '<p>changed</p>', base_version: 1 });
    const versions = (await alice.call('GET', `/api/documents/${doc.id}/versions`)).body;
    const first = versions.at(-1);
    const [a, b] = [await openEvents(alice, doc.id), await openEvents(bob, doc.id)];
    await b.waitFor((e) => e.event === 'hello');
    await alice.call('POST', `/api/documents/${doc.id}/versions/${first.id}/restore`);
    for (const s of [a, b]) assert.ok(await s.waitFor((e) => e.event === 'update' && e.data.version === 3));
    [a, b].forEach((s) => s.close());
  } finally { await close(); }
});

test('revoking access ends that person\'s stream and tells them why; others are unaffected', async () => {
  const { close, alice, bob, carol, doc } = await setup();
  try {
    const [b, c] = [await openEvents(bob, doc.id), await openEvents(carol, doc.id)];
    await b.waitFor((e) => e.event === 'hello');
    const bobId = (await alice.call('GET', `/api/documents/${doc.id}`)).body.shares.find((s) => s.username === 'bob').user_id;
    await alice.call('DELETE', `/api/documents/${doc.id}/shares/${bobId}`);
    const revoked = await b.waitFor((e) => e.event === 'revoked');
    assert.match(revoked.data.reason, /access/i);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(b.closed, true);
    assert.equal(c.closed, false);
    c.close();
  } finally { await close(); }
});

test('role changes are pushed live, and deleting a document ends every stream', async () => {
  const { close, alice, bob, carol, doc } = await setup();
  try {
    const [b, c] = [await openEvents(bob, doc.id), await openEvents(carol, doc.id)];
    await c.waitFor((e) => e.event === 'hello');
    await alice.call('PUT', `/api/documents/${doc.id}/shares`, { username: 'carol', role: 'editor' });
    const role = await c.waitFor((e) => e.event === 'role');
    assert.equal(role.data.role, 'editor');
    await alice.call('DELETE', `/api/documents/${doc.id}`);
    for (const s of [b, c]) assert.match((await s.waitFor((e) => e.event === 'revoked')).data.reason, /deleted/i);
  } finally { await close(); }
});

test('update: very large documents are announced without their content (collaborators fetch it)', async () => {
  const { close, alice, bob, doc } = await setup();
  try {
    const a = await openEvents(alice, doc.id);
    await a.waitFor((e) => e.event === 'hello');
    const big = `<p><img src="data:image/png;base64,${'A'.repeat(300_000)}"></p>`;
    assert.equal((await bob.call('PATCH', `/api/documents/${doc.id}`, { content: big, base_version: 1 })).status, 200);
    const up = await a.waitFor((e) => e.event === 'update');
    assert.equal(up.data.refetch, true);
    assert.equal(up.data.content, undefined);
    assert.equal(up.data.version, 2);
    assert.equal((await alice.call('GET', `/api/documents/${doc.id}`)).body.content, big);
    a.close();
  } finally { await close(); }
});

test('live selections: relayed to others (not echoed), validated, cleared, never stored', async () => {
  const { close, alice, bob, doc } = await setup();
  try {
    const [a, b] = [await openEvents(alice, doc.id), await openEvents(bob, doc.id)];
    await b.waitFor((e) => e.event === 'hello');
    const pos = (n) => ({ path: [0, 0], offset: n });
    assert.equal((await alice.call('POST', `/api/documents/${doc.id}/cursor`, { anchor: pos(1), focus: pos(4) })).status, 200);
    const got = await b.waitFor((e) => e.event === 'cursor');
    assert.deepEqual(got.data.focus, pos(4));
    assert.equal(got.data.name, 'Alice Rivera');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.events.filter((e) => e.event === 'cursor').length, 0, 'not echoed to the sender');
    for (const bad of [{}, { anchor: pos(1) }, { anchor: { path: [-1], offset: 0 }, focus: pos(1) }, { anchor: { path: new Array(60).fill(0), offset: 0 }, focus: pos(1) }, { anchor: { path: [0], offset: 1.5 }, focus: pos(1) }, { anchor: { path: ['x'], offset: 0 }, focus: pos(1) }]) {
      assert.equal((await alice.call('POST', `/api/documents/${doc.id}/cursor`, bad)).status, 400, JSON.stringify(bad));
    }
    await alice.call('POST', `/api/documents/${doc.id}/cursor`, { clear: true });
    assert.ok(await b.waitFor((e) => e.event === 'cursor' && e.data.clear === true));
    const stored = (await alice.call('GET', `/api/documents/${doc.id}`)).body;
    assert.equal(stored.version, 1, 'selections never change the document');
    a.close(); b.close();
  } finally { await close(); }
});
