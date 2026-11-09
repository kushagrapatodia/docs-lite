'use strict';
// Throughput check: 40 writers (each saving to their own document) plus 20 readers, against an in-memory server.
const { openDb, seed } = require('../src/db');
const { createApp } = require('../src/app');
(async () => {
  const db = openDb(':memory:'); seed(db);
  const server = createApp(db, { apiRateLimit: 1e9 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'demo123' }) });
  const H = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0] };
  const docs = []; for (let i = 0; i < 40; i++) docs.push((await (await fetch(`${base}/api/documents`, { method: 'POST', headers: H, body: JSON.stringify({ title: `d${i}` }) })).json()));
  const lat = []; const t0 = Date.now(); let saves = 0, reads = 0;
  const writer = async (d) => { let v = d.version; for (let k = 0; k < 25; k++) { const t = performance.now(); const r = await fetch(`${base}/api/documents/${d.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ content: `<p>${'word '.repeat(200)}${k}</p>`, base_version: v }) }); const j = await r.json(); v = j.version; lat.push(performance.now() - t); saves++; } };
  const reader = async () => { for (let k = 0; k < 50; k++) { await fetch(`${base}/api/documents`, { headers: H }); reads++; } };
  await Promise.all([...docs.map(writer), ...Array.from({ length: 20 }, reader)]);
  const s = (Date.now() - t0) / 1000; lat.sort((a, b) => a - b);
  console.log(`${saves} saves + ${reads} list reads in ${s.toFixed(2)} s  =>  ${(saves / s).toFixed(0)} saves/s; save latency p50 ${lat[Math.floor(lat.length * .5)].toFixed(1)} ms, p99 ${lat[Math.floor(lat.length * .99)].toFixed(1)} ms`);
  server.close(); process.exit(0);
})();
