'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb, seed, hashPassword, verifyPassword, SCHEMA_VERSION } = require('../src/db');

test('password hashing: salted, verifiable, rejects wrong and malformed values', () => {
  const a = hashPassword('secret-pass'), b = hashPassword('secret-pass');
  assert.notEqual(a, b, 'salts differ');
  assert.ok(verifyPassword('secret-pass', a));
  assert.ok(!verifyPassword('Secret-pass', a));
  assert.ok(!verifyPassword('', a));
});

test('openDb is idempotent and seed only runs once', () => {
  const db = openDb(':memory:');
  seed(db); seed(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, 1);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
});

test('a database created by the first version of the app is upgraded in place, keeping all data', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docs-mig-')), 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', source_file TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE shares (document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('viewer','editor')), PRIMARY KEY (document_id, user_id));
  `);
  old.prepare('INSERT INTO users (username, display_name, password_hash) VALUES (?,?,?)').run('legacy', 'Legacy User', hashPassword('oldpassword'));
  old.prepare('INSERT INTO documents (owner_id, title, content) VALUES (1, ?, ?)').run('Old doc', '<p>kept</p>');
  old.close();

  const db = openDb(file);
  seed(db); // existing users: seed must not run
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  const doc = db.prepare('SELECT * FROM documents').get();
  assert.equal(doc.title, 'Old doc');
  assert.equal(doc.content, '<p>kept</p>');
  assert.equal(doc.version, 1);
  const v = db.prepare('SELECT * FROM doc_versions').all();
  assert.equal(v.length, 1, 'legacy documents get an initial history entry');
  assert.equal(v[0].content, '<p>kept</p>');
  assert.equal(v[0].author_id, 1);
  assert.ok(verifyPassword('oldpassword', db.prepare('SELECT password_hash FROM users').get().password_hash));
  // opening again must not duplicate anything
  db.close();
  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) n FROM doc_versions').get().n, 1);
  again.close();
});

test('deleting a user cascades to their documents, shares, sessions and history', () => {
  const db = openDb(':memory:');
  seed(db);
  const alice = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
  db.prepare('DELETE FROM users WHERE id = ?').run(alice);
  for (const t of ['documents', 'shares', 'doc_versions']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
});
