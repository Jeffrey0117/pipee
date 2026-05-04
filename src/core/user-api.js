/**
 * Pipee User API
 *
 * Handles user registration, login, and site management.
 * Auth via local JWT (username/password).
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { hashPassword, verifyPassword, generateToken, verifyUserRequest } = require('./user-auth');
const { validateSlug, STATIC_DIR } = require('./static');

const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_PER_SITE = 5000;

// Forbidden file extensions
const FORBIDDEN_EXTENSIONS = new Set(['.exe', '.dll', '.bat', '.ps1', '.cmd', '.com', '.scr', '.msi']);

// ── JSON helpers ──

function jsonOk(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(data));
}

function jsonErr(res, error, code, status) {
  res.writeHead(status, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ error, code }));
}

// ── Body collection ──

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Archive extraction (ZIP only for standalone) ──

function detectArchiveType(buffer) {
  if (buffer.length < 2) return null;
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'zip';
  return null;
}

async function extractZip(buffer, destDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  fs.mkdirSync(destDir, { recursive: true });

  let fileCount = 0;
  let totalSize = 0;

  const normalizedDest = path.resolve(destDir) + path.sep;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryPath = entry.entryName;
    const resolved = path.resolve(destDir, entryPath);
    if (!resolved.startsWith(normalizedDest)) continue;

    const ext = path.extname(entryPath).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      throw new Error(`FORBIDDEN_FILE:${ext}`);
    }

    fileCount++;
    if (fileCount > MAX_FILES_PER_SITE) {
      throw new Error('TOO_MANY_FILES');
    }

    totalSize += entry.header.size;
    if (totalSize > MAX_EXTRACTED_SIZE) {
      throw new Error('EXTRACTED_TOO_LARGE');
    }

    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, entry.getData());
  }

  return totalSize;
}

function getDirSize(dir) {
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      size += fs.statSync(fullPath).size;
    } else if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    }
  }
  return size;
}

// ── Directory swap ──

function swapDirectory(slug, tempDir) {
  const targetDir = path.join(STATIC_DIR, slug);
  const oldDir = path.join(STATIC_DIR, `.old-${slug}-${Date.now()}`);

  if (fs.existsSync(targetDir)) {
    fs.renameSync(targetDir, oldDir);
  }

  try {
    fs.renameSync(tempDir, targetDir);
  } catch (err) {
    if (fs.existsSync(oldDir)) {
      try { fs.renameSync(oldDir, targetDir); } catch { /* best effort */ }
    }
    throw err;
  }

  if (fs.existsSync(oldDir)) {
    setTimeout(() => {
      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 1000);
  }
}

// ── URL helper ──

function getSiteUrl(req, slug, config) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (isLocal) return `http://${host}/_sites/${slug}/`;
  return `https://${slug}.${config.domain}`;
}

// ── Route handler ──

async function handle(req, res, pathname, config) {
  // POST /api/auth/register
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    return handleRegister(req, res, config);
  }

  // POST /api/auth/login
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    return handleLogin(req, res, config);
  }

  // GET /api/user/me
  if (req.method === 'GET' && pathname === '/api/user/me') {
    return handleMe(req, res, config);
  }

  // GET /api/user/sites
  if (req.method === 'GET' && pathname === '/api/user/sites') {
    return handleUserSites(req, res, config);
  }

  // POST /api/user/sites
  if (req.method === 'POST' && pathname === '/api/user/sites') {
    return handleCreateSite(req, res, config);
  }

  // POST /api/user/sites/:slug/deploy
  const deployMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/deploy$/);
  if (req.method === 'POST' && deployMatch) {
    return handleDeploy(req, res, deployMatch[1], config);
  }

  // PUT /api/user/sites/:slug/settings
  const settingsMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/settings$/);
  if (req.method === 'PUT' && settingsMatch) {
    return handleUpdateSettings(req, res, settingsMatch[1], config);
  }

  // DELETE /api/user/sites/:slug
  if (req.method === 'DELETE' && pathname.startsWith('/api/user/sites/')) {
    const slug = pathname.slice('/api/user/sites/'.length);
    return handleDeleteSite(req, res, slug, config);
  }

  return jsonErr(res, 'Not found', 'NOT_FOUND', 404);
}

// ── POST /api/auth/register ──

async function handleRegister(req, res, config) {
  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  if (!data.username || typeof data.username !== 'string' || data.username.trim().length < 3) {
    return jsonErr(res, 'Username must be at least 3 characters', 'BAD_REQUEST', 400);
  }
  if (!data.password || typeof data.password !== 'string' || data.password.length < 6) {
    return jsonErr(res, 'Password must be at least 6 characters', 'BAD_REQUEST', 400);
  }

  const username = data.username.trim().toLowerCase();

  if (!/^[a-z0-9_-]+$/.test(username)) {
    return jsonErr(res, 'Username can only contain lowercase letters, numbers, hyphens, and underscores', 'BAD_REQUEST', 400);
  }

  // Check if username already exists
  const existing = db.getUserByUsername(username);
  if (existing) {
    return jsonErr(res, 'Username already taken', 'CONFLICT', 409);
  }

  const { hash, salt } = hashPassword(data.password);

  let user;
  try {
    user = db.createUser({ username, passwordHash: hash, salt });
  } catch (err) {
    // Race condition: username was taken between check and insert
    if (err.message && err.message.includes('UNIQUE')) {
      return jsonErr(res, 'Username already taken', 'CONFLICT', 409);
    }
    throw err;
  }

  const token = generateToken(user.id, config.jwtSecret);

  return jsonOk(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      plan: user.plan,
      max_sites: user.max_sites,
    },
  }, 201);
}

// ── POST /api/auth/login ──

async function handleLogin(req, res, config) {
  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  if (!data.username || !data.password) {
    return jsonErr(res, 'Username and password are required', 'BAD_REQUEST', 400);
  }

  const username = data.username.trim().toLowerCase();
  const user = db.getUserByUsername(username);

  if (!user || !verifyPassword(data.password, user.password_hash, user.salt)) {
    return jsonErr(res, 'Invalid username or password', 'UNAUTHORIZED', 401);
  }

  const token = generateToken(user.id, config.jwtSecret);

  return jsonOk(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      plan: user.plan,
      max_sites: user.max_sites,
    },
  });
}

// ── GET /api/user/me ──

function handleMe(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const siteCount = db.countSitesByUser(user.id);

  return jsonOk(res, {
    user: {
      id: user.id,
      username: user.username,
      plan: user.plan,
      max_sites: user.max_sites,
      site_count: siteCount,
    },
  });
}

// ── GET /api/user/sites ──

function handleUserSites(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const sites = db.listSitesByUser(user.id).map(s => ({
    slug: s.slug,
    url: getSiteUrl(req, s.slug, config),
    size: s.size,
    config: JSON.parse(s.config || '{}'),
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  return jsonOk(res, {
    sites,
    quota: { used: sites.length, max: user.max_sites },
  });
}

// ── POST /api/user/sites ──

async function handleCreateSite(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const slug = (data.slug || '').trim().toLowerCase();
  const slugError = validateSlug(slug);
  if (slugError) return jsonErr(res, slugError, 'INVALID_SLUG', 400);

  const { user } = result;

  // Check if slug already exists
  const existing = db.getSite(slug);
  if (existing) {
    return jsonErr(res, 'This slug is already taken', 'SLUG_TAKEN', 409);
  }

  // Quota check
  const count = db.countSitesByUser(user.id);
  if (count >= user.max_sites) {
    return jsonErr(res, `Site limit reached (${user.max_sites}). Delete a site first.`, 'QUOTA_EXCEEDED', 402);
  }

  const site = db.createSite({ slug, userId: user.id });

  // Create the directory
  const siteDir = path.join(STATIC_DIR, slug);
  if (!fs.existsSync(siteDir)) {
    fs.mkdirSync(siteDir, { recursive: true });
  }

  return jsonOk(res, {
    slug: site.slug,
    url: getSiteUrl(req, slug, config),
  }, 201);
}

// ── POST /api/user/sites/:slug/deploy ──

async function handleDeploy(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  // Ownership check
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  // Collect body
  let body;
  try {
    body = await collectBody(req, MAX_ARCHIVE_SIZE);
  } catch (err) {
    if (err.message === 'BODY_TOO_LARGE') {
      return jsonErr(res, 'Archive exceeds 50 MB limit', 'ARCHIVE_TOO_LARGE', 413);
    }
    return jsonErr(res, 'Failed to read request body', 'DEPLOY_FAILED', 500);
  }

  if (body.length === 0) {
    return jsonErr(res, 'Empty request body', 'DEPLOY_FAILED', 400);
  }

  // Detect archive type
  const archiveType = detectArchiveType(body);
  if (!archiveType) {
    return jsonErr(res, 'Unsupported format. Upload a ZIP file.', 'INVALID_FORMAT', 400);
  }

  // Extract to temp dir
  const tempDir = path.join(STATIC_DIR, `.tmp-${slug}-${Date.now()}`);
  let extractedSize;

  try {
    extractedSize = await extractZip(body, tempDir);
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

    if (err.message === 'EXTRACTED_TOO_LARGE') {
      return jsonErr(res, 'Extracted content exceeds 50 MB limit', 'ARCHIVE_TOO_LARGE', 413);
    }
    if (err.message === 'TOO_MANY_FILES') {
      return jsonErr(res, `Site exceeds ${MAX_FILES_PER_SITE} file limit`, 'TOO_MANY_FILES', 400);
    }
    if (err.message.startsWith('FORBIDDEN_FILE:')) {
      const ext = err.message.split(':')[1];
      return jsonErr(res, `${ext} files are not allowed`, 'FORBIDDEN_FILE', 400);
    }
    return jsonErr(res, 'Failed to extract archive', 'EXTRACTION_FAILED', 400);
  }

  // Validate: must have index.html
  if (!fs.existsSync(path.join(tempDir, 'index.html'))) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return jsonErr(res, 'Archive must contain index.html at the root', 'NO_INDEX_HTML', 400);
  }

  // Swap directories
  try {
    swapDirectory(slug, tempDir);
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return jsonErr(res, 'Failed to deploy site', 'DEPLOY_FAILED', 500);
  }

  // Update DB
  db.updateSite(slug, { size: extractedSize });

  const siteUrl = getSiteUrl(req, slug, config);

  return jsonOk(res, {
    url: siteUrl,
    slug,
    size: extractedSize,
  });
}

// ── PUT /api/user/sites/:slug/settings ──

async function handleUpdateSettings(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  // Merge settings into existing config
  const existingConfig = JSON.parse(site.config || '{}');
  const newConfig = { ...existingConfig, ...data };

  db.updateSite(slug, { config: JSON.stringify(newConfig) });

  return jsonOk(res, { slug, config: newConfig });
}

// ── DELETE /api/user/sites/:slug ──

function handleDeleteSite(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  // Delete files
  const siteDir = path.join(STATIC_DIR, slug);
  try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Delete DB record
  db.deleteSite(slug);

  return jsonOk(res, { deleted: true });
}

module.exports = { handle };
