/**
 * PIPEE SQLite Data Layer
 *
 * Replaces projects.json / deployments.json with SQLite for atomic writes.
 * Uses JSON columns — SQLite value is in locking, not relational queries.
 *
 * Auto-migrates from JSON files on first use (if DB is empty and JSON exists).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data/deploy');
const DB_PATH = path.join(__dirname, '../../data/PIPEE.db');

// Legacy JSON paths (for auto-migration)
const PROJECTS_JSON = path.join(DATA_DIR, 'projects.json');
const DEPLOYMENTS_JSON = path.join(DATA_DIR, 'deployments.json');
const AUTOFIX_JSON = path.join(__dirname, '../../data/autofix-state.json');

// ── Lazy singleton ──────────────────────────

let _db = null;

function getDb() {
  if (_db) return _db;

  const Database = require('better-sqlite3');

  // Ensure data dir exists
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  initSchema(_db);
  autoMigrate(_db);

  return _db;
}

// ── Schema ──────────────────────────────────

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'building',
      started_at TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deployments_project
      ON deployments(project_id);

    CREATE INDEX IF NOT EXISTS idx_deployments_time
      ON deployments(started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_deployments_status
      ON deployments(status);

    CREATE TABLE IF NOT EXISTS autofix_state (
      project_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS migration_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      migrated INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS deploy_tokens (
      token TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      max_sites INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS static_sites (
      slug TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (token) REFERENCES deploy_tokens(token)
    );
  `);
}

// ── Auto-migration from JSON ────────────────

function autoMigrate(db) {
  // Migration lock: prevent concurrent migrations across processes
  db.prepare('INSERT OR IGNORE INTO migration_lock (id, migrated) VALUES (1, 0)').run();
  const lock = db.prepare('SELECT migrated FROM migration_lock WHERE id = 1').get();
  if (lock.migrated === 1) return; // Already migrated

  const count = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  if (count > 0) {
    // DB has data but lock wasn't set — mark as migrated
    db.prepare('UPDATE migration_lock SET migrated = 1 WHERE id = 1').run();
    return;
  }

  // Read JSON data before transaction (I/O outside transaction)
  let projects = [];
  let deployments = [];
  let autofixEntries = [];

  if (fs.existsSync(PROJECTS_JSON)) {
    try {
      const raw = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'));
      projects = raw.projects || [];
    } catch (err) {
      console.error('[db] Failed to read projects.json:', err.message);
    }
  }

  if (fs.existsSync(DEPLOYMENTS_JSON)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DEPLOYMENTS_JSON, 'utf8'));
      deployments = raw.deployments || [];
    } catch (err) {
      console.error('[db] Failed to read deployments.json:', err.message);
    }
  }

  if (fs.existsSync(AUTOFIX_JSON)) {
    try {
      const raw = JSON.parse(fs.readFileSync(AUTOFIX_JSON, 'utf8'));
      autofixEntries = Object.entries(raw.projects || {});
    } catch (err) {
      console.error('[db] Failed to read autofix-state.json:', err.message);
    }
  }

  if (projects.length === 0 && deployments.length === 0 && autofixEntries.length === 0) {
    db.prepare('UPDATE migration_lock SET migrated = 1 WHERE id = 1').run();
    return;
  }

  // Atomic migration: all-or-nothing
  const migrate = db.transaction(() => {
    // Re-check lock inside transaction (prevents race)
    const innerLock = db.prepare('SELECT migrated FROM migration_lock WHERE id = 1').get();
    if (innerLock.migrated === 1) return;

    const insertProject = db.prepare('INSERT OR IGNORE INTO projects (id, data) VALUES (?, ?)');
    for (const p of projects) {
      insertProject.run(p.id, JSON.stringify(p));
    }

    const insertDeployment = db.prepare(
      'INSERT OR IGNORE INTO deployments (id, project_id, status, started_at, data) VALUES (?, ?, ?, ?, ?)'
    );
    for (const d of deployments) {
      insertDeployment.run(
        d.id,
        d.projectId,
        d.status || 'unknown',
        d.startedAt || new Date().toISOString(),
        JSON.stringify(d)
      );
    }

    const insertAutofix = db.prepare('INSERT OR IGNORE INTO autofix_state (project_id, data) VALUES (?, ?)');
    for (const [pid, state] of autofixEntries) {
      insertAutofix.run(pid, JSON.stringify(state));
    }

    db.prepare('UPDATE migration_lock SET migrated = 1 WHERE id = 1').run();
  });

  try {
    migrate();
    if (projects.length > 0) console.log(`[db] Auto-migrated ${projects.length} projects from JSON`);
    if (deployments.length > 0) console.log(`[db] Auto-migrated ${deployments.length} deployments from JSON`);
    if (autofixEntries.length > 0) console.log(`[db] Auto-migrated ${autofixEntries.length} autofix entries`);
  } catch (err) {
    console.error('[db] Migration failed (rolled back):', err.message);
  }
}

// ── Projects API ────────────────────────────

function getAllProjects() {
  const db = getDb();
  const rows = db.prepare('SELECT data FROM projects').all();
  return rows.map(r => JSON.parse(r.data));
}

function getProject(id) {
  const db = getDb();
  const row = db.prepare('SELECT data FROM projects WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : undefined;
}

function createProject(project) {
  const db = getDb();
  db.prepare('INSERT INTO projects (id, data) VALUES (?, ?)').run(
    project.id,
    JSON.stringify(project)
  );
  return project;
}

function updateProject(id, patch) {
  const db = getDb();
  const row = db.prepare('SELECT data FROM projects WHERE id = ?').get(id);
  if (!row) {
    throw new Error(`Project "${id}" not found`);
  }
  const existing = JSON.parse(row.data);
  // Immutable update — never mutate existing
  const { id: _ignoreId, createdAt: _ignoreCreatedAt, ...safePatches } = patch;
  const updated = { ...existing, ...safePatches };
  db.prepare('UPDATE projects SET data = ? WHERE id = ?').run(
    JSON.stringify(updated),
    id
  );
  return updated;
}

function deleteProject(id) {
  const db = getDb();
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  if (result.changes === 0) {
    throw new Error(`Project "${id}" not found`);
  }
  return true;
}

// ── Deployments API ─────────────────────────

function getAllDeployments(projectId, limit) {
  const db = getDb();
  let rows;
  if (projectId) {
    rows = db.prepare(
      'SELECT data FROM deployments WHERE project_id = ? ORDER BY started_at DESC LIMIT ?'
    ).all(projectId, limit || 100);
  } else {
    rows = db.prepare(
      'SELECT data FROM deployments ORDER BY started_at DESC LIMIT ?'
    ).all(limit || 100);
  }
  return rows.map(r => JSON.parse(r.data));
}

function getDeployment(id) {
  const db = getDb();
  const row = db.prepare('SELECT data FROM deployments WHERE id = ?').get(id);
  return row ? JSON.parse(row.data) : undefined;
}

function createDeployment(deployment) {
  const db = getDb();
  db.prepare(
    'INSERT INTO deployments (id, project_id, status, started_at, data) VALUES (?, ?, ?, ?, ?)'
  ).run(
    deployment.id,
    deployment.projectId,
    deployment.status || 'building',
    deployment.startedAt || new Date().toISOString(),
    JSON.stringify(deployment)
  );
  return deployment;
}

function updateDeployment(id, patch) {
  const db = getDb();
  const row = db.prepare('SELECT data FROM deployments WHERE id = ?').get(id);
  if (!row) return null;
  const existing = JSON.parse(row.data);
  const updated = { ...existing, ...patch };
  db.prepare(
    'UPDATE deployments SET status = ?, data = ? WHERE id = ?'
  ).run(updated.status || existing.status, JSON.stringify(updated), id);
  return updated;
}

/**
 * Clean stale "building" deployments for a project (older than threshold).
 * Returns number of cleaned records.
 */
function cleanStaleDeployments(projectId, thresholdMs) {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, data FROM deployments WHERE project_id = ? AND status = ?'
  ).all(projectId, 'building');

  let cleaned = 0;
  const now = Date.now();

  for (const row of rows) {
    const d = JSON.parse(row.data);
    const age = now - new Date(d.startedAt).getTime();
    if (age > thresholdMs) {
      const updated = {
        ...d,
        status: 'failed',
        error: 'Stale build (auto-cleaned after 10min)',
        finishedAt: new Date().toISOString(),
        duration: age,
      };
      db.prepare('UPDATE deployments SET status = ?, data = ? WHERE id = ?').run(
        'failed', JSON.stringify(updated), row.id
      );
      cleaned++;
    }
  }

  return cleaned;
}

// ── Autofix State API ───────────────────────

function getAutofixState(projectId) {
  const db = getDb();
  const row = db.prepare('SELECT data FROM autofix_state WHERE project_id = ?').get(projectId);
  return row ? JSON.parse(row.data) : null;
}

function saveAutofixState(projectId, state) {
  const db = getDb();
  db.prepare(
    'INSERT OR REPLACE INTO autofix_state (project_id, data) VALUES (?, ?)'
  ).run(projectId, JSON.stringify(state));
}

// ── Deploy Tokens API ─────────────────────────

function getDeployToken(token) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM deploy_tokens WHERE token = ?').get(token);
  return row || null;
}

function createDeployToken({ name, email, max_sites }) {
  const crypto = require('crypto');
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO deploy_tokens (token, name, email, max_sites, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(token, name, email || null, max_sites || 3, now);
  return { token, name, email: email || null, max_sites: max_sites || 3, created_at: now };
}

function listDeployTokens() {
  const db = getDb();
  return db.prepare('SELECT * FROM deploy_tokens').all();
}

function deleteDeployToken(token) {
  const db = getDb();
  const result = db.prepare('DELETE FROM deploy_tokens WHERE token = ?').run(token);
  return result.changes > 0;
}

// ── Static Sites API ──────────────────────────

function getStaticSite(slug) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM static_sites WHERE slug = ?').get(slug);
  return row || null;
}

function listStaticSites(token) {
  const db = getDb();
  return db.prepare('SELECT * FROM static_sites WHERE token = ?').all(token);
}

function createStaticSite({ slug, token, size }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO static_sites (slug, token, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(slug, token, size || 0, now, now);
  return { slug, token, size: size || 0, created_at: now, updated_at: now };
}

function updateStaticSite(slug, { size }) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE static_sites SET size = ?, updated_at = ? WHERE slug = ?'
  ).run(size, now, slug);
}

function deleteStaticSite(slug) {
  const db = getDb();
  const result = db.prepare('DELETE FROM static_sites WHERE slug = ?').run(slug);
  return result.changes > 0;
}

function countSitesByToken(token) {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) AS count FROM static_sites WHERE token = ?').get(token);
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
  getAllProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,

  getAllDeployments,
  getDeployment,
  createDeployment,
  updateDeployment,
  cleanStaleDeployments,

  getAutofixState,
  saveAutofixState,

  getDeployToken,
  createDeployToken,
  listDeployTokens,
  deleteDeployToken,

  getStaticSite,
  listStaticSites,
  createStaticSite,
  updateStaticSite,
  deleteStaticSite,
  countSitesByToken,

  close,

  // Exposed for ecosystem.config.js and scripts that need raw DB path
  DB_PATH,
};
