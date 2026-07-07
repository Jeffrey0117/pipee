/**
 * Pipee SQLite Data Layer
 *
 * Standalone version: users + sites only.
 * Uses better-sqlite3 for zero-dependency local storage.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/pipee-data.db');

// ── Plan configuration ──────────────────────

const MB = 1024 * 1024;
const GB = 1024 * MB;

const PLANS = {
  //                                                         total deployed bytes      bytes served per site per day   data records (BaaS)
  free:    { maxSites: 3,   aiEditsPerMonth: 0,   label: 'Free',    maxStorageBytes: 150 * MB, bandwidthPerDayBytes: 1 * GB,  maxDataRecords: 0 },
  pro:     { maxSites: 20,  aiEditsPerMonth: 200,  label: 'Pro',     maxStorageBytes: 2 * GB,   bandwidthPerDayBytes: 10 * GB, maxDataRecords: 10000 },
  creator: { maxSites: 100, aiEditsPerMonth: 9999, label: 'Creator', maxStorageBytes: 10 * GB,  bandwidthPerDayBytes: 50 * GB, maxDataRecords: 100000 },
};

// ── Plan resolution ──
// True when the user currently holds an active paid subscription period.
// A null expiry means the plan wasn't set by a time-bound subscription
// (e.g. the admin promotion, or a manual grant) and stays in effect.

function subscriptionActive(user) {
  if (!user.sub_expires_at) return user.plan !== 'free';
  return Date.parse(user.sub_expires_at) > Date.now();
}

// The plan whose entitlements actually apply right now. Falls back to free
// once a paid period has lapsed, so a missed `expired` webhook can't leave a
// user with elevated quotas indefinitely.
function effectivePlan(user) {
  return subscriptionActive(user) ? (user.plan || 'free') : 'free';
}

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
  // SQLite ignores declared FOREIGN KEYs unless this is on (per connection).
  // Deletes already clear child rows first (see deleteRecordsBySite), so this
  // is a safety net against orphaned site_data, not a behavior change.
  _db.pragma('foreign_keys = ON');

  initSchema(_db);
  migrateGitFields(_db);
  migrateAiFields(_db);
  migrateSubscriptionFields(_db);
  migrateDataFields(_db);
  promoteAdmin(_db);

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

// ── AI quota migration ──────────────────────

function migrateAiFields(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);

  if (!columns.includes('ai_edits_used')) {
    db.exec("ALTER TABLE users ADD COLUMN ai_edits_used INTEGER DEFAULT 0");
  }
  if (!columns.includes('ai_edits_reset_at')) {
    db.exec("ALTER TABLE users ADD COLUMN ai_edits_reset_at TEXT DEFAULT NULL");
  }
}

// ── Subscription field migration ─────────────
// email maps a local account to a PayGate subscription;
// sub_expires_at records the current paid period's end (ISO string, null = no active sub).

function migrateSubscriptionFields(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);

  if (!columns.includes('email')) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL");
  }
  if (!columns.includes('sub_expires_at')) {
    db.exec("ALTER TABLE users ADD COLUMN sub_expires_at TEXT DEFAULT NULL");
  }
  // Email ownership: an email only maps a subscription once verified.
  if (!columns.includes('email_verified')) {
    db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes('email_verify_token')) {
    db.exec("ALTER TABLE users ADD COLUMN email_verify_token TEXT DEFAULT NULL");
  }
  if (!columns.includes('email_verify_expires')) {
    db.exec("ALTER TABLE users ADD COLUMN email_verify_expires TEXT DEFAULT NULL");
  }
  // Uniqueness is enforced only among *verified* emails, so an unverified
  // pre-claim can't block the real owner from binding + verifying the address.
  db.exec("DROP INDEX IF EXISTS idx_users_email");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_verified " +
    "ON users(email COLLATE NOCASE) WHERE email IS NOT NULL AND email_verified = 1"
  );
}

// ── Git field migration ──────────────────────

function migrateGitFields(db) {
  const columns = db.prepare("PRAGMA table_info(sites)").all().map(c => c.name);

  if (!columns.includes('repo_url')) {
    db.exec("ALTER TABLE sites ADD COLUMN repo_url TEXT DEFAULT NULL");
  }
  if (!columns.includes('branch')) {
    db.exec("ALTER TABLE sites ADD COLUMN branch TEXT DEFAULT 'main'");
  }
  if (!columns.includes('last_commit')) {
    db.exec("ALTER TABLE sites ADD COLUMN last_commit TEXT DEFAULT NULL");
  }
  if (!columns.includes('deploy_method')) {
    db.exec("ALTER TABLE sites ADD COLUMN deploy_method TEXT DEFAULT 'upload'");
  }
}

// ── Data API (BaaS) migration ────────────────
// Per-site datastore for paid plans. `data_api_key` (null = disabled) is the
// public key visitors present; `data_rules` is the JSON per-collection
// read/write policy. Records live in a single `site_data` table keyed by slug.

function migrateDataFields(db) {
  const columns = db.prepare("PRAGMA table_info(sites)").all().map(c => c.name);

  if (!columns.includes('data_api_key')) {
    db.exec("ALTER TABLE sites ADD COLUMN data_api_key TEXT DEFAULT NULL");
  }
  if (!columns.includes('data_rules')) {
    db.exec("ALTER TABLE sites ADD COLUMN data_rules TEXT DEFAULT '{}'");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS site_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (slug) REFERENCES sites(slug)
    );

    CREATE INDEX IF NOT EXISTS idx_site_data
      ON site_data(slug, collection, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_site_data_rec
      ON site_data(slug, collection, record_id);
  `);
}

// ── Admin auto-promotion ──────────────────────
// First registered user (id=1) is always promoted to creator (admin)

function promoteAdmin(db) {
  const admin = db.prepare('SELECT id, plan FROM users WHERE id = 1').get();
  if (admin && admin.plan !== 'creator') {
    const creatorConfig = PLANS.creator;
    db.prepare('UPDATE users SET plan = ?, max_sites = ? WHERE id = 1')
      .run('creator', creatorConfig.maxSites);
  }
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

function getUserByEmail(email) {
  if (!email) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email) || null;
}

// The single account that has verified ownership of this email (if any).
function getVerifiedUserByEmail(email) {
  if (!email) return null;
  const db = getDb();
  return db.prepare(
    'SELECT * FROM users WHERE email = ? COLLATE NOCASE AND email_verified = 1'
  ).get(email) || null;
}

function getUserByVerifyToken(tokenHash) {
  if (!tokenHash) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE email_verify_token = ?').get(tokenHash) || null;
}

function createUser({ username, passwordHash, salt, token, email }) {
  const db = getDb();
  const result = db.prepare(
    'INSERT INTO users (username, password_hash, salt, token, email) VALUES (?, ?, ?, ?, ?)'
  ).run(username, passwordHash, salt, token || null, email || null);
  return getUserById(result.lastInsertRowid);
}

function updateUser(id, fields) {
  const db = getDb();
  const allowed = ['username', 'password_hash', 'salt', 'token', 'plan', 'max_sites', 'ai_edits_used', 'ai_edits_reset_at', 'email', 'sub_expires_at', 'email_verified', 'email_verify_token', 'email_verify_expires'];
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
  const allowed = ['config', 'size', 'repo_url', 'branch', 'last_commit', 'deploy_method', 'data_api_key', 'data_rules'];
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

// Total deployed bytes across all of a user's sites (account storage quota).
function sumSiteSizesByUser(userId) {
  const db = getDb();
  const row = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM sites WHERE user_id = ?').get(userId);
  return row.total;
}

// The owning user of a site, for plan-based limits during site serving.
function getSiteOwner(slug) {
  const db = getDb();
  return db.prepare(
    'SELECT u.* FROM users u JOIN sites s ON s.user_id = u.id WHERE s.slug = ?'
  ).get(slug) || null;
}

// ── Admin API ─────────────────────────────────
// Cross-tenant read used ONLY by the id=1 admin overview. Selects non-sensitive
// columns (no password_hash/salt/token) and nests each user's sites.

function listAllUsersWithSites() {
  const db = getDb();
  const users = db.prepare(
    `SELECT id, username, email, email_verified, plan, sub_expires_at, created_at
       FROM users ORDER BY id ASC`
  ).all();
  const sites = db.prepare(
    `SELECT slug, user_id, size, deploy_method, created_at, updated_at
       FROM sites ORDER BY created_at DESC`
  ).all();

  const byUser = new Map(users.map((u) => [u.id, { ...u, sites: [] }]));
  for (const s of sites) {
    const entry = byUser.get(s.user_id);
    if (entry) entry.sites = [...entry.sites, s];
  }
  return Array.from(byUser.values());
}

// ── Site data records (BaaS) ──────────────────
// JSON documents stored under (slug, collection, record_id). `data` is the
// JSON-stringified record body; rowToRecord parses it back for callers.

function rowToRecord(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch { /* keep {} on corruption */ }
  return { id: row.record_id, data, created_at: row.created_at, updated_at: row.updated_at };
}

function createRecord({ slug, collection, recordId, data }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO site_data (slug, collection, record_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(slug, collection, recordId, JSON.stringify(data ?? null), now, now);
  return getRecord(slug, collection, recordId);
}

function getRecord(slug, collection, recordId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM site_data WHERE slug = ? AND collection = ? AND record_id = ?'
  ).get(slug, collection, recordId);
  return row ? rowToRecord(row) : null;
}

function listRecords(slug, collection, { limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM site_data WHERE slug = ? AND collection = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
  ).all(slug, collection, limit, offset);
  return rows.map(rowToRecord);
}

function updateRecord(slug, collection, recordId, data) {
  const db = getDb();
  const result = db.prepare(
    'UPDATE site_data SET data = ?, updated_at = ? WHERE slug = ? AND collection = ? AND record_id = ?'
  ).run(JSON.stringify(data ?? null), new Date().toISOString(), slug, collection, recordId);
  return result.changes > 0 ? getRecord(slug, collection, recordId) : null;
}

function deleteRecord(slug, collection, recordId) {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM site_data WHERE slug = ? AND collection = ? AND record_id = ?'
  ).run(slug, collection, recordId);
  return result.changes > 0;
}

// Account-wide record count, used to enforce the plan's maxDataRecords quota.
function countRecordsByUser(userId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM site_data sd JOIN sites s ON s.slug = sd.slug WHERE s.user_id = ?'
  ).get(userId);
  return row.c;
}

// Drop every record for a slug (used when a site is deleted).
function deleteRecordsBySite(slug) {
  const db = getDb();
  return db.prepare('DELETE FROM site_data WHERE slug = ?').run(slug).changes;
}

// ── Lifecycle ───────────────────────────────

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  PLANS,
  subscriptionActive,
  effectivePlan,

  getUserById,
  getUserByUsername,
  getUserByToken,
  getUserByEmail,
  getVerifiedUserByEmail,
  getUserByVerifyToken,
  createUser,
  updateUser,

  getSite,
  listSitesByUser,
  createSite,
  updateSite,
  deleteSite,
  countSitesByUser,
  sumSiteSizesByUser,
  getSiteOwner,
  listAllUsersWithSites,

  createRecord,
  getRecord,
  listRecords,
  updateRecord,
  deleteRecord,
  countRecordsByUser,
  deleteRecordsBySite,

  close,
  DB_PATH,
};
