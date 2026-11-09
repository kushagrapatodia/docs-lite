'use strict';
// Consistent online backup of the database (no downtime): node scripts/backup.js [out-file]
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const out = path.resolve(process.argv[2] || path.join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`));
const db = new DatabaseSync(path.join(dir, 'docs.sqlite'));
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`Backup written to ${out}`);
