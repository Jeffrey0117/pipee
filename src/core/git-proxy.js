/**
 * Pipee Git HTTP Proxy
 *
 * Proxies Git Smart HTTP requests to Gitea.
 * Users authenticate with Pipee credentials — they never touch Gitea directly.
 *
 * Routes:
 *   /git/{slug}.git/info/refs?service=...   — ref discovery
 *   /git/{slug}.git/git-upload-pack          — clone/fetch
 *   /git/{slug}.git/git-receive-pack         — push
 *   /git/{slug}.git/HEAD                     — HEAD ref
 */

const http = require('http');
const { URL } = require('url');
const db = require('./db');
const { verifyPassword } = require('./user-auth');
const gitea = require('./gitea');

/**
 * Parse a git proxy path into { slug, gitPath }.
 * /git/my-blog.git/info/refs → { slug: 'my-blog', gitPath: '/info/refs' }
 */
function parseGitPath(pathname) {
  const match = pathname.match(/^\/git\/([a-z0-9][a-z0-9-]*[a-z0-9])\.git(\/.*)?$/);
  if (!match) return null;
  return { slug: match[1], gitPath: match[2] || '/' };
}

/**
 * Authenticate via HTTP Basic Auth using Pipee credentials.
 * Returns user object or null.
 */
function authenticateBasic(req) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return null;

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return null;

  const username = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);

  const user = db.getUserByUsername(username);
  if (!user) return null;

  if (!verifyPassword(password, user.password_hash, user.salt)) return null;

  return user;
}

/**
 * Send 401 with WWW-Authenticate header to trigger git credential prompt.
 */
function sendAuthRequired(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Pipee Git"',
    'Content-Type': 'text/plain',
  });
  res.end('Authentication required\n');
}

/**
 * Proxy a request to Gitea, streaming both directions.
 */
function proxyToGitea(req, res, slug, gitPath, query) {
  const cfg = gitea.isEnabled() ? { url: getGiteaUrl(), token: getGiteaToken() } : null;
  if (!cfg) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('Git service not available\n');
  }

  const owner = gitea.getOwner();
  const targetUrl = new URL(`${cfg.url}/${owner}/${slug}.git${gitPath}`);
  if (query) targetUrl.search = query;

  const parsed = new URL(targetUrl.toString());

  const options = {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers: {
      ...filterHeaders(req.headers),
      'Authorization': `Basic ${Buffer.from(`pipee-admin:${cfg.token}`).toString('base64')}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, filterHeaders(proxyRes.headers));
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[git-proxy] Proxy error for ${slug}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Git proxy error\n');
    }
  });

  req.pipe(proxyReq);
}

/**
 * Filter headers — remove hop-by-hop and host headers.
 */
function filterHeaders(headers) {
  const filtered = {};
  const skip = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding',
    'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);
  for (const [key, value] of Object.entries(headers)) {
    if (!skip.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Read Gitea config helpers (avoid re-reading for every request).
 */
function getGiteaUrl() {
  const fs = require('fs');
  const path = require('path');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8'));
    return (cfg.gitea && cfg.gitea.url) || '';
  } catch { return ''; }
}

function getGiteaToken() {
  const fs = require('fs');
  const path = require('path');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8'));
    return (cfg.gitea && cfg.gitea.token) || '';
  } catch { return ''; }
}

/**
 * Main handler for /git/* routes.
 */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parsed = parseGitPath(url.pathname);

  if (!parsed) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found\n');
  }

  const { slug, gitPath } = parsed;

  // Verify site exists
  const site = db.getSite(slug);
  if (!site || !site.repo_url) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Repository not found\n');
  }

  // Determine if this is a push (receive-pack) or clone (upload-pack)
  const service = url.searchParams.get('service') || '';
  const isPush = service === 'git-receive-pack' || gitPath === '/git-receive-pack';

  // Push requires authentication + ownership
  if (isPush) {
    const user = authenticateBasic(req);
    if (!user) return sendAuthRequired(res);
    if (site.user_id !== user.id) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Permission denied\n');
    }
  }

  // Proxy to Gitea
  proxyToGitea(req, res, slug, gitPath, url.search);
}

module.exports = { handle, parseGitPath };
