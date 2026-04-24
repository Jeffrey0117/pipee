/**
 * 核心路由器
 * 支援兩種模式：
 * 1. api.yourdomain.com → Dashboard + services/
 * 2. xxx.yourdomain.com → apps/xxx/
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('./admin');
const gateway = require('./gateway');
const hotloader = require('./hotloader');
const deploy = require('./deploy');
const db = require('./db');
const logger = require('./logger');

// ── Rate limiting (in-memory fixed-window) ──

const { checkRateLimit } = require('./rate-limit')

// ── Circuit Breaker (prevents repeated ECONNREFUSED to dead ports) ──

const circuitBreaker = new Map() // port → { failures, openUntil, isProbe }
const CB_THRESHOLD = 3
const CB_COOLDOWN = 300000 // 5 minutes (dead ports rarely come back fast)

function cbCheck(port) {
  const cb = circuitBreaker.get(port)
  if (!cb) return false // closed → allow
  if (cb.failures < CB_THRESHOLD) return false // under threshold
  if (Date.now() >= cb.openUntil) {
    // Half-open: allow one probe request (silently)
    cb.failures = CB_THRESHOLD - 1
    cb.isProbe = true
    return false
  }
  return true // open → block
}

function cbIsProbe(port) {
  const cb = circuitBreaker.get(port)
  return cb?.isProbe || false
}

function cbRecordFailure(port) {
  const cb = circuitBreaker.get(port) || { failures: 0, openUntil: 0, isProbe: false }
  cb.failures++
  cb.isProbe = false
  cb.openUntil = Date.now() + CB_COOLDOWN
  circuitBreaker.set(port, cb)
}

function cbRecordSuccess(port) {
  circuitBreaker.delete(port)
}

// ── CORS origin whitelist ──

function isAllowedOrigin(origin) {
  if (!origin) return false
  try {
    const { hostname } = new URL(origin)
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true
    // Allow configured domain and its subdomains
    const config = getConfig();
    const domain = config.domain || '';
    if (domain && (hostname.endsWith('.' + domain) || hostname === domain)) return true
    return false
  } catch {
    return false
  }
}

// ── hostname → port resolution (30s TTL cache) ──

let routeCache = new Map();
let routeCacheTime = 0;
const ROUTE_CACHE_TTL = 30000;

// ── Blue-Green deployment: temporary port overrides ──
// During deploy, traffic is routed to a temp port while the canonical
// process restarts. This gives true zero-downtime deployments.
const portOverrides = new Map(); // projectId → { port, ts }
const PORT_OVERRIDE_TTL = 5 * 60 * 1000; // 5 minutes — auto-expire if deploy crashes

function setPortOverride(projectId, tempPort) {
  portOverrides.set(projectId, { port: tempPort, ts: Date.now() });
}

function clearPortOverride(projectId) {
  portOverrides.delete(projectId);
}

/** Force cache rebuild on next request (call after project port changes) */
function invalidateRouteCache() {
  routeCacheTime = 0;
}

function buildRouteCache(domain) {
  const cache = new Map();
  const projects = db.getAllProjects();

  for (const p of projects) {
    if (!p.port) continue;
    cache.set(`${p.id}.${domain}`, p.port);
    for (const cd of (p.customDomains || [])) {
      cache.set(cd, p.port);
    }
  }
  return cache;
}

function resolveHostnameToPort(hostname, domain) {
  if (Date.now() - routeCacheTime > ROUTE_CACHE_TTL) {
    routeCache = buildRouteCache(domain);
    routeCacheTime = Date.now();
  }

  // Blue-Green override: projectId is the subdomain part
  const sub = hostname.endsWith('.' + domain) ? hostname.slice(0, -(domain.length + 1)) : null;
  if (sub && portOverrides.has(sub)) {
    const override = portOverrides.get(sub);
    if (Date.now() - override.ts > PORT_OVERRIDE_TTL) {
      // Stale override — deploy likely crashed mid-swap, auto-clear
      portOverrides.delete(sub);
      console.error(`[router] Auto-expired stale port override for ${sub} (age: ${Math.round((Date.now() - override.ts) / 1000)}s)`);
    } else {
      return override.port;
    }
  }

  // Exact match
  if (routeCache.has(hostname)) return routeCache.get(hostname);

  // Wildcard match (*.domain.com → domain's port)
  const dotIdx = hostname.indexOf('.');
  if (dotIdx > 0) {
    const wildcard = '*' + hostname.slice(dotIdx);
    if (routeCache.has(wildcard)) return routeCache.get(wildcard);
  }

  return null;
}

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

const createRouter = function(config) {
  const servicesDir = config.servicesDir;
  const rootDir = path.join(servicesDir, '..');
  const publicDir = path.join(rootDir, 'public');
  const appsDir = path.join(rootDir, 'apps');
  const mainSubdomain = config.subdomain || 'epi';

  // 確保 apps 目錄存在
  if (!fs.existsSync(appsDir)) {
    fs.mkdirSync(appsDir, { recursive: true });
  }

  // 載入 services/（使用 hotloader）
  hotloader.loadAllServices(servicesDir);

  const server = http.createServer(async (req, res) => {
    try {

    // CORS (origin whitelist)
    const origin = req.headers.origin
    if (isAllowedOrigin(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-credentials', 'true')
    }
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type, authorization')
    res.setHeader('vary', 'Origin')

    // Security headers
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'SAMEORIGIN')
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin')

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    // 解析 hostname
    const host = req.headers.host || '';
    const hostname = host.split(':')[0];
    const subdomain = hostname.split('.')[0];
    const domain = config.domain || 'localhost';

    // Request logging
    const startTime = Date.now()
    const clientIp = logger.getClientIp(req)

    res.on('finish', () => {
      logger.log({
        ts: new Date().toISOString(),
        ip: clientIp,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        ms: Date.now() - startTime,
        sub: subdomain,
        host: hostname
      })
    })

    // Rate limiting (skip OPTIONS, health checks, and LurlHub capture)
    const urlPath0 = req.url.split('?')[0]
    if (req.method !== 'OPTIONS' && urlPath0 !== '/health' && !urlPath0.endsWith('/api/health') && !urlPath0.startsWith('/lurl/')) {
      const blocked = await checkRateLimit(clientIp, req.method)
      if (blocked) {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': String(blocked.retryAfter)
        })
        return res.end(JSON.stringify({ error: 'Too many requests', retryAfter: blocked.retryAfter }))
      }
    }

    // ========== Static Hosting (PIPEE.app) ==========
    const staticDomain = config.staticDomain
    if (staticDomain && (hostname === staticDomain || hostname.endsWith('.' + staticDomain))) {
      const staticHost = require('./static')

      if (hostname === staticDomain) {
        return staticHost.handleAPI(req, res)
      }

      const slug = hostname.split('.')[0]
      return staticHost.handleSite(req, res, slug)
    }

    // ========== Main domain (api.yourdomain.com) ==========
    if (subdomain === mainSubdomain || hostname === 'localhost') {
      return handleMainDomain(req, res, { publicDir });
    }

    // ========== hostname → port 全域解析 (涵蓋子域名 + 自訂域名) ==========
    const port = resolveHostnameToPort(hostname, domain);
    if (port) {
      return proxyToPort(req, res, port);
    }

    // ========== Fallback: apps/ 目錄靜態檔案 ==========
    return handleAppDomain(req, res, { subdomain, appsDir });

    } catch (err) {
      console.error('[router] Unhandled error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  });

  // 處理主域名
  function handleMainDomain(req, res, { publicDir }) {
    const routes = hotloader.getRoutes();
    const urlPath = req.url.split('?')[0];

    // /_sites/:slug/* → static hosting (localhost path-based access)
    if (urlPath.startsWith('/_sites/')) {
      const staticHost = require('./static')
      const rest = urlPath.slice('/_sites/'.length)
      const slashIdx = rest.indexOf('/')
      const slug = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
      if (slug) {
        const filePath = slashIdx === -1 ? '/' : rest.slice(slashIdx)
        const qs = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''
        req.url = filePath + qs
        return staticHost.handleSite(req, res, slug)
      }
    }

    // Static hosting API on main domain (localhost access)
    if (urlPath === '/api/deploy/static' || urlPath.startsWith('/api/sites') || urlPath === '/api/auth/token') {
      const staticHost = require('./static')
      return staticHost.handleAPI(req, res)
    }

    // /_admin → admin.html
    if (urlPath === '/_admin' || urlPath === '/_admin/') {
      const adminFile = path.join(publicDir, 'admin.html');
      if (fs.existsSync(adminFile)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(adminFile));
      }
    }

    // /_admin/lurlhub → redirect to /lurl/admin (獨立專案)
    if (urlPath === '/_admin/lurlhub' || urlPath === '/_admin/lurlhub/') {
      res.writeHead(302, { location: '/lurl/admin' });
      return res.end();
    }

    // /_admin/xxx → admin-xxx.html (服務後台頁面)
    if (urlPath.startsWith('/_admin/')) {
      const serviceName = urlPath.replace('/_admin/', '').replace(/\/$/, '');
      const adminFile = path.join(publicDir, `admin-${serviceName}.html`);
      if (fs.existsSync(adminFile)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(adminFile));
      }
    }

    // /_example.js → services/_example.js (範例檔案)
    if (urlPath === '/_example.js') {
      const exampleFile = path.join(servicesDir, '_example.js');
      if (fs.existsSync(exampleFile)) {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(exampleFile));
      }
    }

    // 靜態檔案 (public/)
    let staticFile = urlPath === '/' ? '/index.html' : urlPath;
    let filePath = path.resolve(publicDir, '.' + staticFile);
    let ext = path.extname(filePath);

    // Path traversal 防護：確保解析後的路徑在 publicDir 內
    const resolvedPublicDir = path.resolve(publicDir);
    if (!filePath.startsWith(resolvedPublicDir + path.sep) && filePath !== resolvedPublicDir) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden');
    }

    // 目錄請求：嘗試 index.html
    if (!ext && fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      staticFile = path.join(staticFile, 'index.html');
      filePath = path.resolve(publicDir, '.' + staticFile);
      ext = '.html';
    }

    if (ext && MIME[ext] && fs.existsSync(filePath)) {
      res.writeHead(200, { 'content-type': MIME[ext] });
      return res.end(fs.readFileSync(filePath));
    }

    // Gateway API
    if (gateway.match(req)) {
      return gateway.handle(req, res);
    }

    // Admin API
    if (admin.match(req)) {
      return admin.handle(req, res);
    }

    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        routes: routes.map(r => r.name),
        timestamp: new Date().toISOString()
      }));
    }

    // LurlHub path proxy (獨立專案，port 4017)
    if (urlPath.startsWith('/lurl/') || urlPath === '/lurl') {
      return proxyToPort(req, res, 4017);
    }

    // PayGate path proxy (port 4019)
    if (urlPath.startsWith('/paygate/')) {
      req.url = req.url.replace('/paygate', '');
      return proxyToPort(req, res, 4019);
    }

    // Services 路由
    for (const route of routes) {
      if (typeof route.handler === 'function') {
        const handled = route.handler(req, res);
        if (handled) return;
      } else if (route.handler.match && route.handler.handle) {
        if (route.handler.match(req)) {
          return route.handler.handle(req, res);
        }
      }
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  // 處理 App 子域名
  function handleAppDomain(req, res, { subdomain, appsDir }) {
    // 先檢查是否有 Git 部署專案（有 port 配置則代理）
    const project = deploy.getProject(subdomain);
    if (project && project.port) {
      return proxyToPort(req, res, project.port);
    }

    // 先檢查 apps/ 目錄
    let appDir = path.join(appsDir, subdomain);

    // 如果 apps/ 沒有，檢查專案目錄（Git 部署）
    if (!fs.existsSync(appDir) && project && project.directory) {
      const projDir = path.resolve(__dirname, '../..', project.directory);
      if (fs.existsSync(projDir)) {
        appDir = projDir;
      }
    }

    // 檢查 app 是否存在
    if (!fs.existsSync(appDir)) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<h1>App not found: ${subdomain}</h1>`);
    }

    const urlPath = req.url.split('?')[0];

    // 檢查是否有 server.js (後端應用)
    const serverPath = path.join(appDir, 'server.js');
    if (fs.existsSync(serverPath)) {
      try {
        const appHandler = require(serverPath);
        if (typeof appHandler === 'function') {
          return appHandler(req, res);
        } else if (appHandler.handle) {
          return appHandler.handle(req, res);
        }
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 靜態檔案服務 (public/ → dist/ → 根目錄)
    const appPublicDir = fs.existsSync(path.join(appDir, 'public'))
      ? path.join(appDir, 'public')
      : fs.existsSync(path.join(appDir, 'dist'))
        ? path.join(appDir, 'dist')
        : appDir;

    const staticFile = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.resolve(appPublicDir, '.' + staticFile);
    const ext = path.extname(filePath);

    // Path traversal 防護
    const resolvedAppDir = path.resolve(appPublicDir);
    if (!filePath.startsWith(resolvedAppDir + path.sep) && filePath !== resolvedAppDir) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const contentType = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      return res.end(fs.readFileSync(filePath));
    }

    // SPA fallback - 嘗試返回 index.html
    const indexPath = path.join(appPublicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(indexPath));
    }

    // 404
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h1>File not found: ${urlPath}</h1>`);
  }

  // 代理到備援機器（本地 port 連不上時）
  function proxyToFallback(req, res, fallbackOrigin, bodyChunks) {
    const parsed = new URL(fallbackOrigin);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 8787,
      path: req.url,
      method: req.method,
      headers: { ...req.headers },
    };
    let fbResponded = false;
    const fbReq = http.request(options, (fbRes) => {
      fbResponded = true;
      res.writeHead(fbRes.statusCode, fbRes.headers);
      fbRes.pipe(res);
      fbRes.on('error', () => { res.end(); });
    });
    fbReq.on('error', () => {
      if (fbResponded) return;
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Service unavailable</h1><p>本地 + 備援機器皆無法連線</p>');
    });
    res.on('close', () => { fbReq.destroy(); });
    // Replay buffered body
    for (const chunk of bodyChunks) fbReq.write(chunk);
    fbReq.end();
  }

  // 代理到指定 port（with circuit breaker）
  function proxyToPort(req, res, port) {
    // Circuit breaker: fast-reject if port is known dead
    if (cbCheck(port)) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Service unavailable', port }));
    }

    const ip = logger.getClientIp(req)
    const existingXff = req.headers['x-forwarded-for']
    const options = {
      hostname: 'localhost',
      port: port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        'x-forwarded-for': existingXff ? `${ip}, ${existingXff}` : ip,
        'x-real-ip': ip,
        'x-forwarded-proto': 'https'
      }
    };

    // Buffer body for potential fallback replay
    const bodyChunks = [];
    const hasFallback = !!config.fallbackOrigin;
    if (hasFallback) {
      req.on('data', (chunk) => bodyChunks.push(chunk));
    }

    let responded = false;
    const proxyReq = http.request(options, (proxyRes) => {
      responded = true;
      cbRecordSuccess(port);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on('error', () => { res.end(); });
    });

    proxyReq.on('error', (err) => {
      if (responded) return;
      const wasProbe = cbIsProbe(port);
      if (err.code === 'ECONNREFUSED') {
        cbRecordFailure(port);
      }
      const fallback = config.fallbackOrigin;
      if (fallback && err.code === 'ECONNREFUSED') {
        if (!wasProbe) console.log(`[proxy] Port ${port} down, fallback → ${fallback}`);
        return proxyToFallback(req, res, fallback, bodyChunks);
      }
      if (!wasProbe) console.error(`[proxy] Error proxying to port ${port}:`, err.message);
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>Service unavailable</h1><p>無法連接到後端服務 (port ${port})</p>`);
    });

    req.on('error', () => { proxyReq.destroy(); });
    res.on('close', () => { proxyReq.destroy(); });
    req.pipe(proxyReq);
  }

  // ── WebSocket upgrade proxy ──
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host || '';
    const hostname = host.split(':')[0];
    const domain = config.domain || 'localhost';
    const port = resolveHostnameToPort(hostname, domain);

    if (!port) {
      socket.destroy();
      return;
    }

    const ip = logger.getClientIp(req);
    const existingXff = req.headers['x-forwarded-for'];
    const headers = {
      ...req.headers,
      'x-forwarded-for': existingXff ? `${ip}, ${existingXff}` : ip,
      'x-real-ip': ip,
      'x-forwarded-proto': 'https',
    };

    const proxyReq = http.request({
      hostname: 'localhost',
      port,
      path: req.url,
      method: req.method,
      headers,
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // Build raw HTTP 101 response
      let rawResponse = `HTTP/1.1 101 Switching Protocols\r\n`;
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        rawResponse += `${key}: ${value}\r\n`;
      }
      rawResponse += '\r\n';
      socket.write(rawResponse);

      if (proxyHead.length > 0) socket.write(proxyHead);
      if (head.length > 0) proxySocket.write(head);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      proxySocket.on('error', () => socket.destroy());
      socket.on('error', () => proxySocket.destroy());
      proxySocket.on('close', () => socket.destroy());
      socket.on('close', () => proxySocket.destroy());
    });

    proxyReq.on('error', (err) => {
      const fallback = config.fallbackOrigin;
      if (fallback && err.code === 'ECONNREFUSED') {
        console.log(`[ws-proxy] Port ${port} down, WS fallback → ${fallback}`);
        const parsed = new URL(fallback);
        const fbReq = http.request({
          hostname: parsed.hostname,
          port: parsed.port || 8787,
          path: req.url,
          method: req.method,
          headers,
        });
        fbReq.on('upgrade', (fbRes, fbSocket, fbHead) => {
          let rawResponse = `HTTP/1.1 101 Switching Protocols\r\n`;
          for (const [key, value] of Object.entries(fbRes.headers)) {
            rawResponse += `${key}: ${value}\r\n`;
          }
          rawResponse += '\r\n';
          socket.write(rawResponse);
          if (fbHead.length > 0) socket.write(fbHead);
          if (head.length > 0) fbSocket.write(head);
          fbSocket.pipe(socket);
          socket.pipe(fbSocket);
          fbSocket.on('error', () => socket.destroy());
          socket.on('error', () => fbSocket.destroy());
          fbSocket.on('close', () => socket.destroy());
          socket.on('close', () => fbSocket.destroy());
        });
        fbReq.on('error', () => {
          console.error(`[ws-proxy] Fallback also failed for port ${port}`);
          socket.destroy();
        });
        fbReq.end();
        return;
      }
      console.error(`[ws-proxy] Error proxying WS to port ${port}:`, err.message);
      socket.destroy();
    });

    proxyReq.end();
  });

  return server;
};

createRouter.invalidateRouteCache = invalidateRouteCache;
createRouter.setPortOverride = setPortOverride;
createRouter.clearPortOverride = clearPortOverride;
module.exports = createRouter;
