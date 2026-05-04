/**
 * Pipee Standalone HTTP Server
 *
 * Simple server for static site hosting.
 * No PM2, Redis, gateway, tunnel, or external services.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleSite, MIME } = require('./static');
const userApi = require('./user-api');

const ROOT = path.join(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ── Load config ──

function loadConfig() {
  const configPath = path.join(ROOT, 'config.json');
  const examplePath = path.join(ROOT, 'config.example.json');

  let config;
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (fs.existsSync(examplePath)) {
    config = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  } else {
    config = {};
  }

  const port = config.port || parseInt(process.env.PORT, 10) || 3939;
  const domain = config.domain || 'localhost';
  const isLocal = domain === 'localhost' || domain === '127.0.0.1';
  const externalUrl = isLocal
    ? `http://localhost:${port}`
    : `https://${domain}`;

  return {
    port,
    domain,
    externalUrl,
    jwtSecret: config.jwtSecret || 'change-this-to-a-random-string',
    maxSites: config.maxSites || 10,
    maxSiteSize: config.maxSiteSize || 52428800,
    anthropicApiKey: config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || '',
    gitea: config.gitea || {},
  };
}

const config = loadConfig();

// ── Serve public file ──

function servePublicFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'content-type': contentType });
    return fs.createReadStream(filePath).pipe(res);
  }

  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  return res.end('<h1>Not found</h1>');
}

// ── Request handler ──

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const host = req.headers.host || '';
  const hostname = host.split(':')[0];

  // ── Subdomain-based site serving ──
  // Check if request is for {slug}.{domain}
  if (config.domain !== 'localhost' && hostname.endsWith('.' + config.domain)) {
    const slug = hostname.slice(0, -(config.domain.length + 1));
    if (slug && !slug.includes('.')) {
      return handleSite(req, res, slug);
    }
  }

  // ── Path-based site serving (for localhost development) ──
  // /_sites/{slug}/path → serve site
  if (pathname.startsWith('/_sites/')) {
    const rest = pathname.slice('/_sites/'.length);
    const slashIdx = rest.indexOf('/');
    const slug = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    if (slug) {
      // Rewrite req.url to be the path within the site
      const sitePath = slashIdx === -1 ? '/' : rest.slice(slashIdx);
      req.url = sitePath;
      return handleSite(req, res, slug);
    }
  }

  // ── API routes ──
  if (pathname.startsWith('/api/')) {
    return userApi.handle(req, res, pathname, config);
  }

  // ── Console ──
  if (pathname === '/console' || pathname === '/console/') {
    return servePublicFile(res, path.join(PUBLIC_DIR, 'console.html'));
  }

  // ── Landing page ──
  if (pathname === '/' || pathname === '') {
    return servePublicFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }

  // ── Static assets from public/ ──
  if (req.method === 'GET') {
    const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
    const normalizedPublic = path.resolve(PUBLIC_DIR);

    // Security: path traversal check
    if (filePath.startsWith(normalizedPublic + path.sep) || filePath === normalizedPublic) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return servePublicFile(res, filePath);
      }
    }
  }

  // ── 404 ──
  res.writeHead(404, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ error: 'Not found' }));
}

// ── Start server ──

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('[pipee] Request error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(config.port, () => {
  console.log(`[pipee] Server running on http://localhost:${config.port}`);
  console.log(`[pipee] Console: http://localhost:${config.port}/console`);
  if (config.domain !== 'localhost') {
    console.log(`[pipee] Sites served at: https://{slug}.${config.domain}`);
  } else {
    console.log(`[pipee] Sites served at: http://localhost:${config.port}/_sites/{slug}/`);
  }
});

// ── Graceful shutdown ──

function shutdown() {
  console.log('\n[pipee] Shutting down...');
  const db = require('./db');
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = server;
