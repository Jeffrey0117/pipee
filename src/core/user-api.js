/**
 * Pipee User API
 *
 * Handles user-facing endpoints for the public deploy platform.
 * Auth via LetMeUse JWT tokens.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { verifyUserRequest } = require('./user-auth');
const { checkUserDeployRateLimit, checkUserApiRateLimit } = require('./rate-limit');

const ROOT = path.join(__dirname, '../..');
const STATIC_DIR = path.join(ROOT, 'data', 'static');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_PER_SITE = 5000;

// Forbidden file extensions
const FORBIDDEN_EXTENSIONS = new Set(['.exe', '.dll', '.bat', '.ps1', '.cmd', '.com', '.scr', '.msi']);

function getStaticDomain() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config.staticDomain || 'pipee.tw';
  } catch {
    return 'pipee.tw';
  }
}

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

// ── Archive extraction (ZIP + tar.gz) ──

function detectArchiveType(buffer) {
  if (buffer.length < 2) return null;
  // ZIP: PK (0x50 0x4B)
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'zip';
  // gzip: 0x1F 0x8B
  if (buffer[0] === 0x1F && buffer[1] === 0x8B) return 'gzip';
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
    // Block path traversal
    const resolved = path.resolve(destDir, entryPath);
    if (!resolved.startsWith(normalizedDest)) continue;

    // Block forbidden extensions
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

async function extractTarGz(buffer, destDir) {
  const tar = require('tar');
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');

  fs.mkdirSync(destDir, { recursive: true });

  let fileCount = 0;

  await pipeline(
    Readable.from(buffer),
    tar.x({
      cwd: destDir,
      strip: 0,
      preserveOwner: false,
      noChmod: true,
      filter: (entryPath, entry) => {
        // Block symlinks
        if (entry.type === 'SymbolicLink' || entry.type === 'Link') return false;
        // Block path traversal
        const resolved = path.resolve(destDir, entryPath);
        if (!resolved.startsWith(path.resolve(destDir))) return false;
        // Block forbidden extensions
        const ext = path.extname(entryPath).toLowerCase();
        if (FORBIDDEN_EXTENSIONS.has(ext)) return false;

        fileCount++;
        if (fileCount > MAX_FILES_PER_SITE) return false;
        return true;
      },
    })
  );

  return getDirSize(destDir);
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

// ── Directory swap (reuse logic from static.js) ──

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

function getSiteUrl(req, slug, domain) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (isLocal) return `http://${host}/_sites/${slug}/`;
  return `https://${slug}.${domain}`;
}

// ── Slug validation (import from static.js) ──

const { validateSlug } = require('./static');

// ── Route handler ──

async function handle(req, res, pathname) {
  // POST /api/auth/login
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    return handleLogin(req, res);
  }

  // GET /api/auth/me
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    return handleMe(req, res);
  }

  // GET /api/user/sites
  if (req.method === 'GET' && pathname === '/api/user/sites') {
    return handleUserSites(req, res);
  }

  // POST /api/user/deploy?slug=xxx
  if (req.method === 'POST' && pathname === '/api/user/deploy') {
    return handleUserDeploy(req, res);
  }

  // DELETE /api/user/sites/:slug
  if (req.method === 'DELETE' && pathname.startsWith('/api/user/sites/')) {
    const slug = pathname.slice('/api/user/sites/'.length);
    return handleUserDeleteSite(req, res, slug);
  }

  return jsonErr(res, 'Not found', 'NOT_FOUND', 404);
}

// ── POST /api/auth/login ──

async function handleLogin(req, res) {
  let body;
  try {
    body = await collectBody(req, 8192);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  if (!data.token) {
    return jsonErr(res, 'token is required', 'BAD_REQUEST', 400);
  }

  const { decodeLetmeuseToken, resolveOrCreateUser } = require('./user-auth');
  const payload = decodeLetmeuseToken(data.token);
  if (!payload) {
    return jsonErr(res, 'Invalid token', 'INVALID_TOKEN', 401);
  }

  const user = resolveOrCreateUser(payload);

  return jsonOk(res, {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan,
      max_sites: user.max_sites,
    },
    deployToken: user.deploy_token,
  });
}

// ── GET /api/auth/me ──

function handleMe(req, res) {
  const result = verifyUserRequest(req);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const apiBlocked = checkUserApiRateLimit(user.id);
  if (apiBlocked) return jsonErr(res, 'Too many requests', 'RATE_LIMITED', 429);

  const siteCount = db.countSitesByToken(user.deploy_token);

  return jsonOk(res, {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan,
      max_sites: user.max_sites,
      site_count: siteCount,
    },
  });
}

// ── GET /api/user/sites ──

function handleUserSites(req, res) {
  const result = verifyUserRequest(req);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const apiBlocked = checkUserApiRateLimit(user.id);
  if (apiBlocked) return jsonErr(res, 'Too many requests', 'RATE_LIMITED', 429);

  const domain = getStaticDomain();
  const sites = db.listStaticSites(user.deploy_token).map(s => ({
    slug: s.slug,
    url: getSiteUrl(req, s.slug, domain),
    size: s.size,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  return jsonOk(res, {
    sites,
    quota: { used: sites.length, max: user.max_sites },
  });
}

// ── POST /api/user/deploy?slug=xxx ──

async function handleUserDeploy(req, res) {
  const result = verifyUserRequest(req);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  // Per-user rate limit
  const blocked = checkUserDeployRateLimit(user.id);
  if (blocked) {
    return jsonErr(res, 'Too many deploys. Try again later.', 'RATE_LIMITED', 429);
  }

  // Parse slug
  const url = new URL(req.url, 'http://localhost');
  const slug = url.searchParams.get('slug');
  const slugError = validateSlug(slug);
  if (slugError) return jsonErr(res, slugError, 'INVALID_SLUG', 400);

  // Ownership check
  const existingSite = db.getStaticSite(slug);
  if (existingSite && existingSite.token !== user.deploy_token) {
    return jsonErr(res, 'This slug is owned by another user', 'SLUG_TAKEN', 403);
  }

  // Quota check
  if (!existingSite) {
    const count = db.countSitesByToken(user.deploy_token);
    if (count >= user.max_sites) {
      return jsonErr(res, `Site limit reached (${user.max_sites}). Delete a site first.`, 'QUOTA_EXCEEDED', 402);
    }
  }

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
    return jsonErr(res, 'Unsupported format. Upload a ZIP or tar.gz file.', 'INVALID_FORMAT', 400);
  }

  // Extract to temp dir
  const tempDir = path.join(STATIC_DIR, `.tmp-${slug}-${Date.now()}`);
  let extractedSize;

  try {
    if (archiveType === 'zip') {
      extractedSize = await extractZip(body, tempDir);
    } else {
      extractedSize = await extractTarGz(body, tempDir);
    }
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
    console.error('[user-api] Extraction failed:', err.message);
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
    console.error('[user-api] Swap failed:', err.message);
    return jsonErr(res, 'Failed to deploy site', 'DEPLOY_FAILED', 500);
  }

  // Upsert DB
  if (existingSite) {
    db.updateStaticSite(slug, { size: extractedSize });
  } else {
    db.createStaticSite({ slug, token: user.deploy_token, size: extractedSize });
  }

  const domain = getStaticDomain();
  const siteUrl = getSiteUrl(req, slug, domain);

  console.error(`[user-api] Deployed ${slug} (${(extractedSize / 1024).toFixed(1)} KB) by user ${user.id.slice(0, 8)}...`);

  return jsonOk(res, {
    url: siteUrl,
    slug,
    size: extractedSize,
  });
}

// ── DELETE /api/user/sites/:slug ──

function handleUserDeleteSite(req, res, slug) {
  const result = verifyUserRequest(req);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getStaticSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.token !== user.deploy_token) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  // Delete files
  const siteDir = path.join(STATIC_DIR, slug);
  try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Delete DB record
  db.deleteStaticSite(slug);

  return jsonOk(res, { deleted: true });
}

module.exports = { handle };
