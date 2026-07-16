/**
 * Pipee Static Hosting
 *
 * Serves static sites from data/static/{slug}/
 * Handles MIME types, cache control, SPA fallback, and security.
 */

const fs = require('fs');
const path = require('path');
const bandwidth = require('./bandwidth');

const ROOT = path.join(__dirname, '../..');
const STATIC_DIR = path.join(ROOT, 'data', 'static');

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
  'ns1', 'ns2', 'dev', 'staging', 'test', 'demo', 'assets',
  // Security / identity / payment words — reserved so nobody can squat a
  // trust-bearing subdomain (e.g. auth.<your-domain>) and host a login/console
  // lookalike as phishing bait on your own apex.
  'auth', 'oauth', 'sso', 'signin', 'signout', 'logout', 'register',
  'account', 'accounts', 'user', 'users', 'me', 'profile', 'settings',
  'secure', 'security', 'verify', 'verification', 'password', 'reset',
  'token', 'session', 'sessions',
  'pay', 'payment', 'payments', 'checkout', 'wallet', 'subscribe', 'subscription',
]);

function isValidSlug(slug) {
  return validateSlug(slug) === null;
}

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

  // Anti-abuse: per-site daily bandwidth cap (owner's plan). Stops a site
  // from being used as a free CDN; resets at UTC midnight.
  if (bandwidth.isOverLimit(slug)) {
    res.writeHead(503, {
      'content-type': 'text/html; charset=utf-8',
      'retry-after': String(bandwidth.secondsUntilReset()),
      'cache-control': 'no-store',
    });
    return res.end('<h1>503 — Daily bandwidth limit reached</h1><p>This site has served its daily traffic allowance. Try again tomorrow.</p>');
  }

  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const resolved = path.resolve(siteDir, '.' + urlPath);

  // Security: path traversal check
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
      bandwidth.recordBytes(slug, stat.size);
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
        bandwidth.recordBytes(slug, fs.statSync(dirIndex).size);
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
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<h1>File not found</h1>');
  }

  // No extension (e.g. /about, /dashboard) -> SPA fallback to index.html
  const indexPath = path.join(siteDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    bandwidth.recordBytes(slug, fs.statSync(indexPath).size);
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

module.exports = { handleSite, validateSlug, isValidSlug, RESERVED_SLUGS, STATIC_DIR, MIME };
