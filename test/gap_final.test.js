'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helpers');

test('concurrent sign-ups for one name: one 201, the others 409 (never 500)', async () => {
  const { client, close } = await start({ registerRateLimit: 1e9 });
  try {
    const calls = await Promise.all([1, 2, 3].map(() => client().call('POST', '/api/register', { username: 'racer', display_name: 'Racer', password: 'longenough1' })));
    const codes = calls.map((r) => r.status).sort();
    assert.deepEqual(codes, [201, 409, 409]);
  } finally { await close(); }
});

test('a title that is not text is rejected instead of stored as "[object Object]"', async () => {
  const { as, close } = await start();
  try {
    const a = await as('alice');
    const r = await a.call('POST', '/api/documents', { title: { a: 1 } });
    assert.equal(r.status, 400);
  } finally { await close(); }
});

test('login attempts are limited per address across many usernames', async () => {
  const { client, close } = await start();
  try {
    const c = client();
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await c.call('POST', '/api/login', { username: `ghost${i}`, password: 'nope' })).status;
    assert.equal(last, 429);
  } finally { await close(); }
});

test('a declared oversized body is refused before it is read', async () => {
  const { as, close } = await start();
  try {
    const a = await as('alice');
    const r = await a.raw('POST', '/api/documents', 'x'.repeat(10), { 'Content-Length': String(50_000_000) }).catch(() => ({ status: 413 }));
    assert.ok([413, 400].includes(r.status));
  } finally { await close(); }
});

test('idempotency applies only to routes that create something (no stored body for /api/convert)', async () => {
  const { as, close, db } = await start();
  try {
    const a = await as('alice');
    const before = db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n;
    const r = await a.call('POST', '/api/convert', { filename: 'a.txt', content: 'hello' }, { 'Idempotency-Key': 'abcdefgh12' });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM idempotency').get().n, before);
  } finally { await close(); }
});

test('duplicate works with an Idempotency-Key and an empty JSON body, and replays', async () => {
  const { as, close } = await start();
  try {
    const a = await as('alice');
    const d = (await a.call('POST', '/api/documents', { title: 'orig' })).body;
    const r1 = await a.call('POST', `/api/documents/${d.id}/duplicate`, {}, { 'Idempotency-Key': 'dupkey1234' });
    const r2 = await a.call('POST', `/api/documents/${d.id}/duplicate`, {}, { 'Idempotency-Key': 'dupkey1234' });
    assert.equal(r1.status, 201);
    assert.equal(r2.body.id, r1.body.id);
  } finally { await close(); }
});

test('an oversized document made of many tiny tags is refused', async () => {
  const { as, close } = await start();
  try {
    const a = await as('alice');
    const d = (await a.call('POST', '/api/documents', { title: 'big' })).body;
    const r = await a.call('PATCH', `/api/documents/${d.id}`, { content: '<li>'.repeat(400_000), base_version: d.version });
    assert.equal(r.status, 413);
  } finally { await close(); }
});

test('link targets with spaces or brackets are dropped by the sanitiser', () => {
  const { sanitizeHtml } = require('../src/sanitize');
  assert.ok(!/href=/.test(sanitizeHtml('<a href="https://ok.com/a) [x](https://evil.example/x">t</a>')));
  assert.match(sanitizeHtml('<a href="https://ok.com/a">t</a>'), /href="https:\/\/ok\.com\/a"/);
});
