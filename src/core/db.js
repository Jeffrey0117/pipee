/**
 * Pipee SQLite Data Layer
 *
 * Standalone version: users + sites only.
 * Uses better-sqlite3 for zero-dependency local storage.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/pipee-data.db');

// ── Lazy singleton ──────────────────────────

let _db = null;

function getDb() {
  if (_db) return _db;

  const Database = require('better-sqlite3');

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  initSchema(_db);

  return _db;
}

// ── Schema ──────────────────────────────────

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      token TEXT UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      max_sites INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sites (
      slug TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sites_user
      ON sites(user_id);
  `);
}

// ── Users API ─────────────────────────────────

function getUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserByUsername(username) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function getUserByToken(token) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE token = ?').get(token) || null;
}

function createUser({ username, passwordHash, salt, token }) {
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, salt, token) VALUES (?, ?, ?, ?)'
  ).run(username, passwordHash, salt, token || null);
  return getUserById(result.lastInsertRowid);
}

function updateUser(id, fields) {
  const db = getDb();
  const allowed = ['username', 'password_hash', 'salt', 'token', 'plan', 'max_sites'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getUserById(id);

  values.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getUserById(id);
}

// ── Sites API ─────────────────────────────────

function getSite(slug) {
  const db = getDb();
  return db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug) || null;
}

function listSitesByUser(userId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function createSite({ slug, userId }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO sites (slug, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)'
  ).run(slug, userId, now, now);
  return getSite(slug);
}

function updateSite(slug, fields) {
  const db = getDb();
  const allowed = ['config', 'size'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getSite(slug);

  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(slug);
  db.prepare(`UPDATE sites SET ${sets.join(', ')} WHERE slug = ?`).run(...values);
  return getSite(slug);
}

function deleteSite(slug) {
  const db = getDb();
  const result = db.prepare('DELETE FROM sites WHERE slug = ?').run(slug);
  return result.changes > 0;
}

function countSitesByUser(userId) {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS count FROM sites WHERE user_id = ?').get(userId);
  return row.count;
}

// ── Lifecycle ───────────────────────────────

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getUserById,
  getUserByUsername,
  getUserByToken,
  createUser,
  updateUser,

  getSite,
  listSitesByUser,
  createSite,
  updateSite,
  deleteSite,
  countSitesByUser,

  close,
  DB_PATH,
};
