/**
 * PIPEE Static Hosting
 *
 * Serves static sites at {slug}.PIPEE.app
 * Handles deploy API at PIPEE.app/api/*
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const ROOT = path.join(__dirname, '../..');
const STATIC_DIR = path.join(ROOT, 'data', 'static');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// Load config once (staticDomain)
function getStaticDomain() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config.staticDomain || 'PIPEE.app';
  } catch {
    return 'PIPEE.app';
  }
}

// Ensure static dir exists
if (!fs.existsSync(STATIC_DIR)) {
  fs.mkdirSync(STATIC_DIR, { recursive: true });
}

// ── MIME types ──

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
};

// ── Slug validation ──

const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'app', 'dashboard', 'static', 'cdn',
  'mail', 'ftp', 'ssh', 'pipee', 'status', 'health',
  'login', 'signup', 'blog', 'docs',
  'console', 'billing', 'support', 'help', 'about',
  'ns1', 'ns2', 'dev', 'staging', 'test', 'demo', 'assets'
]);

function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') return 'Slug is required';
  if (slug.length < 3 || slug.length > 50) return 'Slug must be 3-50 characters';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) return 'Slug must be lowercase alphanumeric and hyphens, cannot start/end with hyphen';
  if (/--/.test(slug)) return 'Slug cannot contain consecutive hyphens';
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is a reserved name`;
  return null;
}

// ── Cache-Control helpers ──

const HASH_PATTERN = /[.-][a-f0-9]{8,}[.-]|[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpg|svg)$/;

function getCacheControl(filePath, ext) {
  const basename = path.basename(filePath);
  if (ext === '.html') return 'no-cache';
  if (HASH_PATTERN.test(basename)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}

// ── Serve static site ──

function handleSite(req, res, slug) {
  const siteDir = path.join(STATIC_DIR, slug);

  if (!fs.existsSync(siteDir)) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<h1>Site not found</h1>');
  }

  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const resolved = path.resolve(siteDir, '.' + urlPath);

  // Security: path traversal check (normalize for Windows backslash/case)
  const normalizedResolved = path.resolve(resolved);
  const normalizedSiteDir = path.resolve(siteDir);
  if (!normalizedResolved.startsWith(normalizedSiteDir + path.sep) && normalizedResolved !== normalizedSiteDir) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Forbidden' }));
  }

  // Try exact file
  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
      const ext = path.extname(resolved).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'content-type': contentType,
        'cache-control': getCacheControl(resolved, ext),
        'x-content-type-options': 'nosniff',
      });
      return fs.createReadStream(resolved).pipe(res);
    }
    // Directory: try index.html inside it
    if (stat.isDirectory()) {
      const dirIndex = path.join(resolved, 'index.html');
      if (fs.existsSync(dirIndex)) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        return fs.createReadStream(dirIndex).pipe(res);
      }
    }
  }

  // SPA fallback: only for paths WITHOUT file extension
  const ext = path.extname(urlPath);
  if (ext) {
    // Path has extension but file doesn't exist → 404
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<h1>File not found</h1>');
  }

  // No extension (e.g. /about, /dashboard) → SPA fallback to index.html
  const indexPath = path.join(siteDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    return fs.createReadStream(indexPath).pipe(res);
  }

  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  return res.end('<h1>Site not found</h1>');
}

// ── Auth helper ──

function getTokenFromRequest(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

// ── Rate limit for deploy (in-memory) ──

const { checkDeployRateLimit } = require('./rate-limit');

// ── Collect request body ──

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

// ── Extract tar.gz archive ──

const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024; // 50 MB

async function extractArchive(buffer, destDir) {
  const tar = require('tar');
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');

  fs.mkdirSync(destDir, { recursive: true });

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
        return true;
      },
    })
  );

  // Check extracted size
  const totalSize = getDirSize(destDir);
  if (totalSize > MAX_EXTRACTED_SIZE) {
    throw new Error('EXTRACTED_TOO_LARGE');
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

// ── Directory swap (best-effort on Windows) ──

function swapDirectory(slug, tempDir) {
  const targetDir = path.join(STATIC_DIR, slug);
  const oldDir = path.join(STATIC_DIR, `.old-${slug}-${Date.now()}`);

  if (fs.existsSync(targetDir)) {
    fs.renameSync(targetDir, oldDir);
  }

  try {
    fs.renameSync(tempDir, targetDir);
  } catch (err) {
    // Rollback: restore old directory
    if (fs.existsSync(oldDir)) {
      try { fs.renameSync(oldDir, targetDir); } catch { /* best effort */ }
    }
    throw err;
  }

  // Cleanup old dir in background
  if (fs.existsSync(oldDir)) {
    setTimeout(() => {
      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 1000);
  }
}

// ── URL helpers ──

function getSiteUrl(req, slug, domain) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (isLocal) {
    return `http://${host}/_sites/${slug}/`;
  }
  return `https://${slug}.${domain}`;
}

// ── JSON response helpers ──

function jsonOk(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(data));
}

function jsonErr(res, error, code, status) {
  res.writeHead(status, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ error, code }));
}

// ── Parse JSON body ──

function parseJsonBody(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

// ── API Router ──

async function handleAPI(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // User API routes (LetMeUse auth)
  if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/user/')) {
    // /api/auth/token stays admin-only
    if (req.method === 'POST' && pathname === '/api/auth/token') {
      return handleCreateToken(req, res);
    }
    const userApi = require('./user-api');
    return userApi.handle(req, res, pathname);
  }

  // PUT /api/deploy/static?slug=xxx — deploy a static site (CLI token auth)
  if (req.method === 'PUT' && pathname === '/api/deploy/static') {
    return handleDeploy(req, res, url);
  }

  // GET /api/sites — list user's sites (CLI token auth)
  if (req.method === 'GET' && pathname === '/api/sites') {
    return handleListSites(req, res);
  }

  // DELETE /api/sites/:slug — delete a site (CLI token auth)
  if (req.method === 'DELETE' && pathname.startsWith('/api/sites/')) {
    const slug = pathname.slice('/api/sites/'.length);
    return handleDeleteSite(req, res, slug);
  }

  // GET /console — serve user dashboard
  if (req.method === 'GET' && (pathname === '/console' || pathname === '/console/')) {
    const consolePath = path.join(ROOT, 'public', 'console.html');
    if (fs.existsSync(consolePath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(consolePath));
    }
  }

  // Fallback: serve landing page
  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    const indexPath = path.join(ROOT, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(indexPath));
    }
  }

  // Serve static assets from public/
  if (req.method === 'GET') {
    const publicDir = path.join(ROOT, 'public');
    const filePath = path.resolve(publicDir, '.' + pathname);
    const resolvedPublic = path.resolve(publicDir);
    if (filePath.startsWith(resolvedPublic + path.sep) || filePath === resolvedPublic) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext && MIME[ext] && fs.existsSync(filePath)) {
        res.writeHead(200, { 'content-type': MIME[ext] });
        return res.end(fs.readFileSync(filePath));
      }
    }
  }

  return jsonErr(res, 'Not found', 'NOT_FOUND', 404);
}

// ── Deploy handler ──

const logger = require('./logger');

async function handleDeploy(req, res, url) {
  const ip = logger.getClientIp(req);

  // Rate limit
  const blocked = await checkDeployRateLimit(ip);
  if (blocked) {
    return jsonErr(res, 'Too many deploys. Try again later.', 'RATE_LIMITED', 429);
  }

  // Auth
  const token = getTokenFromRequest(req);
  if (!token) return jsonErr(res, 'Missing Authorization header', 'INVALID_TOKEN', 401);

  const tokenRecord = db.getDeployToken(token);
  if (!tokenRecord) return jsonErr(res, 'Invalid deploy token', 'INVALID_TOKEN', 401);

  // Slug
  const slug = url.searchParams.get('slug');
  const slugError = validateSlug(slug);
  if (slugError) return jsonErr(res, slugError, 'INVALID_SLUG', 400);

  // Ownership check
  const existingSite = db.getStaticSite(slug);
  if (existingSite && existingSite.token !== token) {
    return jsonErr(res, 'This slug is owned by another user', 'SLUG_TAKEN', 403);
  }

  // Quota check
  if (!existingSite) {
    const count = db.countSitesByToken(token);
    if (count >= tokenRecord.max_sites) {
      return jsonErr(res, `Site limit reached (${tokenRecord.max_sites}). Delete a site or upgrade.`, 'QUOTA_EXCEEDED', 402);
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

  // Extract to temp dir
  const tempDir = path.join(STATIC_DIR, `.tmp-${slug}-${Date.now()}`);
  let extractedSize;

  try {
    extractedSize = await extractArchive(body, tempDir);
  } catch (err) {
    // Cleanup temp dir
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

    if (err.message === 'EXTRACTED_TOO_LARGE') {
      return jsonErr(res, 'Extracted content exceeds 50 MB limit', 'ARCHIVE_TOO_LARGE', 413);
    }
    console.error('[static] Extraction failed:', err.message);
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
    console.error('[static] Swap failed:', err.message);
    return jsonErr(res, 'Failed to deploy site', 'DEPLOY_FAILED', 500);
  }

  // Upsert DB
  if (existingSite) {
    db.updateStaticSite(slug, { size: extractedSize });
  } else {
    db.createStaticSite({ slug, token, size: extractedSize });
  }

  const domain = getStaticDomain();
  const siteUrl = getSiteUrl(req, slug, domain);

  console.error(`[static] Deployed ${slug} (${(extractedSize / 1024).toFixed(1)} KB) by token ${token.slice(0, 8)}...`);

  return jsonOk(res, {
    url: siteUrl,
    slug,
    size: extractedSize,
  });
}

// ── List sites ──

function handleListSites(req, res) {
  const token = getTokenFromRequest(req);
  if (!token) return jsonErr(res, 'Missing Authorization header', 'INVALID_TOKEN', 401);

  const tokenRecord = db.getDeployToken(token);
  if (!tokenRecord) return jsonErr(res, 'Invalid deploy token', 'INVALID_TOKEN', 401);

  const domain = getStaticDomain();

  const sites = db.listStaticSites(token).map(s => ({
    slug: s.slug,
    url: getSiteUrl(req, s.slug, domain),
    size: s.size,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  return jsonOk(res, { sites });
}

// ── Delete site ──

function handleDeleteSite(req, res, slug) {
  const token = getTokenFromRequest(req);
  if (!token) return jsonErr(res, 'Missing Authorization header', 'INVALID_TOKEN', 401);

  const tokenRecord = db.getDeployToken(token);
  if (!tokenRecord) return jsonErr(res, 'Invalid deploy token', 'INVALID_TOKEN', 401);

  const site = db.getStaticSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.token !== token) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  // Delete files
  const siteDir = path.join(STATIC_DIR, slug);
  try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Delete DB record
  db.deleteStaticSite(slug);

  return jsonOk(res, { deleted: true });
}

// ── Create token (admin only) ──

async function handleCreateToken(req, res) {
  const auth = require('./auth');
  const payload = auth.verifyRequest(req);
  if (!payload) return jsonErr(res, 'Admin authentication required', 'FORBIDDEN', 403);

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'DEPLOY_FAILED', 400);
  }

  const data = parseJsonBody(body);
  if (!data || !data.name) {
    return jsonErr(res, 'name is required', 'INVALID_SLUG', 400);
  }

  const record = db.createDeployToken({
    name: data.name,
    email: data.email,
    max_sites: data.max_sites,
  });

  return jsonOk(res, record, 201);
}

module.exports = { handleSite, handleAPI, validateSlug, STATIC_DIR };
