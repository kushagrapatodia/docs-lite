'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { openDb, seed } = require('./src/db');
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = openDb(path.join(DATA_DIR, 'docs.sqlite'));
if (process.env.SEED_DEMO !== '0') seed(db); // demo accounts (alice, bob, carol); set SEED_DEMO=0 to switch them off

const server = createApp(db, {
  log: process.env.LOG !== 'off',
  trustProxy: process.env.TRUST_PROXY === '1' || Boolean(process.env.RENDER || process.env.FLY_APP_NAME || process.env.RAILWAY_ENVIRONMENT),
});
server.listen(PORT, '0.0.0.0', () => console.log(`Docs Lite running on http://localhost:${PORT} (data: ${DATA_DIR})`));

// last line of defence: log and keep serving rather than letting one bad request end the process
process.on('unhandledRejection', (e) => console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'unhandledRejection', message: String(e && e.message || e) })));
process.on('uncaughtException', (e) => console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'uncaughtException', message: String(e && e.message || e) })));

function shutdown(signal) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown', signal }));
  if (server.drain) server.drain(); // readiness -> 503 and event streams are closed so the port frees quickly
  server.close(() => { try { db.close(); } catch { /* already closed */ } process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
