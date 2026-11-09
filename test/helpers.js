'use strict';
const { openDb, seed, SEED_PASSWORD } = require('../src/db');
const { createApp } = require('../src/app');

async function start(opts = {}) {
  const db = openDb(':memory:');
  seed(db);
  const server = createApp(db, opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    const c = { cookie: '', base };
    c.raw = async (method, url, body, headers = {}) => {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: c.cookie, ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    };
    c.call = async (method, url, body, headers) => {
      const res = await c.raw(method, url, body, headers);
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, headers: res.headers };
    };
    c.login = async (u) => (await c.call('POST', '/api/login', { username: u, password: SEED_PASSWORD })).status;
    return c;
  };
  const as = async (u) => { const c = client(); await c.login(u); return c; };
  return { client, as, db, base, close: () => new Promise((r) => server.close(r)) };
}

// Minimal SSE reader: collects events until you ask for them.
async function openEvents(c, docId) {
  const res = await fetch(`${c.base}/api/documents/${docId}/events`, { headers: { Cookie: c.cookie } });
  if (res.status !== 200) return { status: res.status, close() {} };
  const reader = res.body.getReader();
  const events = [];
  const waiters = [];
  let buf = '';
  let closed = false;
  (async () => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(chunk); const data = /^data: (.*)$/m.exec(chunk);
          if (ev && data) { events.push({ event: ev[1], data: JSON.parse(data[1]) }); waiters.splice(0).forEach((w) => w()); }
        }
      }
    } catch { /* aborted */ }
    closed = true; waiters.splice(0).forEach((w) => w());
  })();
  const waitFor = async (pred, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (closed || Date.now() > deadline) return null;
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  return { status: 200, events, waitFor, get closed() { return closed; }, close: () => reader.cancel().catch(() => {}) };
}

module.exports = { start, openEvents, SEED_PASSWORD };
