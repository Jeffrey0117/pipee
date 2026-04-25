/**
 * 管理 API - PIPEE Dashboard 後端
 * 路徑：/api/_admin/*
 *
 * Routing dispatcher only. Handlers live in ./admin/ subdirectory.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const hotloader = require('./hotloader');
const deploy = require('./deploy');
const auth = require('./auth');

// Handler modules
const deployHandlers = require('./admin/deploy-handlers');
const webhookHandler = require('./admin/webhook-handler');
const tunnelHandlers = require('./admin/tunnel-handlers');
const systemHandlers = require('./admin/system-handlers');

// 目錄路徑
const ROOT = path.join(__dirname, '..', '..');
const SERVICES_DIR = path.join(ROOT, 'services');
const APPS_DIR = path.join(ROOT, 'apps');
const CONFIG_PATH = path.join(ROOT, 'config.json');

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getCloudflared() {
  const config = getConfig();
  return {
    path: config.cloudflared?.path || 'cloudflared',
    tunnelId: config.cloudflared?.tunnelId || '',
  };
}

function requireAuth(req) {
  const payload = auth.verifyRequest(req);
  return payload !== null;
}

if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

module.exports = {
  match(req) {
    return req.url.startsWith('/api/_admin') || req.url.startsWith('/webhook/');
  },

  handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // ===== Webhook =====
    if (req.method === 'POST' && pathname.startsWith('/webhook/')) {
      return webhookHandler.handleWebhook(req, res, pathname);
    }

    // POST /api/_admin/login
    if (req.method === 'POST' && pathname === '/api/_admin/login') {
      return handleLogin(req, res);
    }

    // GET /api/_admin/verify
    if (req.method === 'GET' && pathname === '/api/_admin/verify') {
      if (requireAuth(req)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ valid: true }));
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // GET /api/_admin/env-bundle/download (no JWT needed)
    if (req.method === 'GET' && pathname === '/api/_admin/env-bundle/download') {
      const dlUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      return systemHandlers.handleDownloadEnvBundle(req, res, dlUrl);
    }

    // ===== Auth required =====
    if (!requireAuth(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // ===== System =====
    if (req.method === 'GET' && pathname === '/api/_admin/status') {
      return systemHandlers.handleStatus(res);
    }

    if (req.method === 'GET' && pathname === '/api/_admin/health-detail') {
      return systemHandlers.handleHealthDetail(req, res);
    }

    // ===== Deploy API =====
    if (req.method === 'GET' && pathname === '/api/_admin/deploy/projects') {
      const projects = deploy.getAllProjects();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ projects }));
    }

    if (req.method === 'POST' && pathname === '/api/_admin/deploy/projects') {
      return deployHandlers.handleCreateProject(req, res);
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+$/)) {
      const id = pathname.split('/').pop();
      const project = deploy.getProject(id);
      if (!project) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: '專案不存在' }));
      }
      const deployments = deploy.getDeployments(id, 10);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ project, deployments }));
    }

    if (req.method === 'PUT' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+$/)) {
      return deployHandlers.handleUpdateProject(req, res, pathname.split('/').pop());
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+$/)) {
      const id = pathname.split('/').pop();
      try {
        deploy.deleteProject(id);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/deploy$/)) {
      return deployHandlers.handleManualDeploy(req, res, pathname.split('/')[5]);
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/restart$/)) {
      return deployHandlers.handleRestartProject(req, res, pathname.split('/')[5]);
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/rollback$/)) {
      return deployHandlers.handleRollback(req, res, pathname.split('/')[5]);
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/init-repo$/)) {
      return deployHandlers.handleInitRepoRoute(req, res, pathname.split('/')[5]);
    }

    if (req.method === 'POST' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/webhook$/)) {
      return deployHandlers.handleSetupWebhook(req, res, pathname.split('/')[5]);
    }

    if (req.method === 'DELETE' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/webhook$/)) {
      return deployHandlers.handleRemoveWebhook(req, res, pathname.split('/')[5]);
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/projects\/[^/]+\/webhooks$/)) {
      return deployHandlers.handleListWebhooks(req, res, pathname.split('/')[5]);
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/logs\/[^/]+$/)) {
      return deployHandlers.handleGetPM2Logs(req, res, pathname.split('/').pop());
    }

    if (req.method === 'GET' && pathname === '/api/_admin/deploy/deployments') {
      const deployments = deploy.getDeployments(null, 50);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ deployments }));
    }

    if (req.method === 'GET' && pathname.match(/^\/api\/_admin\/deploy\/deployments\/[^/]+$/)) {
      const id = pathname.split('/').pop();
      const deployment = deploy.getDeployment(id);
      if (!deployment) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: '部署記錄不存在' }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ deployment }));
    }

    // ===== Legacy API =====
    if (req.method === 'GET' && pathname === '/api/_admin/services') {
      return listServices(req, res);
    }

    if (req.method === 'POST' && pathname === '/api/_admin/upload/service') {
      return uploadService(req, res);
    }

    if (req.method === 'POST' && pathname === '/api/_admin/upload/app') {
      return uploadApp(req, res);
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/_admin/service/')) {
      return deleteService(pathname.split('/').pop(), res);
    }

    if (req.method === 'DELETE' && pathname.startsWith('/api/_admin/app/')) {
      return deleteApp(pathname.split('/').pop(), res);
    }

    // ===== System & Config =====
    if (req.method === 'GET' && pathname === '/api/_admin/machines') {
      return systemHandlers.handleMachines(req, res);
    }

    if (req.method === 'GET' && pathname === '/api/_admin/system') {
      return systemHandlers.handleSystemInfo(req, res);
    }

    if (req.method === 'GET' && pathname === '/api/_admin/config') {
      const cfg = getConfig();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        domain: cfg.domain || '',
        subdomain: cfg.subdomain || 'epi',
        telegram: cfg.telegram || { enabled: false, botToken: '', chatId: '' }
      }));
    }

    if (req.method === 'POST' && pathname === '/api/_admin/env-bundle/generate') {
      return systemHandlers.handleGenerateEnvToken(req, res);
    }

    if (req.method === 'GET' && pathname === '/api/_admin/setup-bundle') {
      return systemHandlers.handleSetupBundle(req, res);
    }

    if (req.method === 'GET' && pathname === '/api/_admin/env-bundle/direct') {
      return systemHandlers.handleDirectEnvBundle(req, res);
    }

    if (req.method === 'PUT' && pathname === '/api/_admin/config/telegram') {
      return systemHandlers.handleUpdateTelegram(req, res);
    }

    // ===== Tunnel =====
    if (req.method === 'GET' && pathname === '/api/_admin/tunnel/status') {
      return tunnelHandlers.handleTunnelStatus(req, res);
    }

    if (req.method === 'POST' && pathname === '/api/_admin/tunnel/mode') {
      return tunnelHandlers.handleTunnelMode(req, res);
    }

    if (req.method === 'POST' && pathname === '/api/_admin/tunnel/enforce') {
      return tunnelHandlers.handleTunnelEnforce(req, res);
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};

// ===== Local handlers (login, services, apps — kept here) =====

const _loginAttempts = new Map();
const LOGIN_MAX = 5;
const LOGIN_WINDOW = 15 * 60 * 1000;

function checkLoginRateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (_loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW);
  if (attempts.length >= LOGIN_MAX) return false;
  attempts.push(now);
  _loginAttempts.set(ip, attempts);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of _loginAttempts) {
    const valid = attempts.filter(t => now - t < LOGIN_WINDOW);
    if (valid.length === 0) _loginAttempts.delete(ip);
    else _loginAttempts.set(ip, valid);
  }
}, 30 * 60 * 1000).unref();

function handleLogin(req, res) {
  if (!checkLoginRateLimit(req)) {
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: '登入嘗試過多，請 15 分鐘後再試' }));
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { password } = JSON.parse(body);
      if (auth.verifyPassword(password)) {
        const token = auth.generateAdminToken();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, token }));
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '密碼錯誤' }));
      }
    } catch (err) {
      const status = err.message.includes('not configured') ? 503 : 400;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function listServices(req, res) {
  const cfg = getConfig();
  const services = [];
  const apps = [];

  if (fs.existsSync(SERVICES_DIR)) {
    fs.readdirSync(SERVICES_DIR)
      .filter(f => f.endsWith('.js') && !f.startsWith('_'))
      .forEach(file => {
        const name = path.basename(file, '.js');
        services.push({
          name,
          url: `https://${cfg.subdomain || 'epi'}.${cfg.domain || 'localhost'}/${name}`,
          status: 'running'
        });
      });
  }

  if (fs.existsSync(APPS_DIR)) {
    fs.readdirSync(APPS_DIR)
      .filter(d => fs.statSync(path.join(APPS_DIR, d)).isDirectory())
      .forEach(dir => {
        apps.push({
          name: dir,
          url: `https://${dir}.${cfg.domain || 'localhost'}`,
          status: 'running'
        });
      });
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ services, apps }));
}

function uploadService(req, res) {
  parseMultipart(req, (err, fields, files) => {
    if (err || !files.file) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '上傳失敗' }));
    }

    const file = files.file;
    if (!file.filename.endsWith('.js')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '只接受 .js 檔案' }));
    }

    const name = fields.name;
    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '無效的名稱' }));
    }

    const destPath = path.join(SERVICES_DIR, `${name}.js`);
    if (fs.existsSync(destPath)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '名稱已被使用' }));
    }

    fs.writeFileSync(destPath, file.data);
    console.log(`[admin] 服務已建立: ${name}`);
    hotloader.loadService(destPath);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      name,
      url: `https://${getConfig().subdomain || 'epi'}.${getConfig().domain || 'localhost'}/${name}`
    }));
  });
}

function uploadApp(req, res) {
  parseMultipart(req, async (err, fields, files) => {
    if (err || !files.file) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '上傳失敗' }));
    }

    const name = fields.name;
    if (!name || !/^[a-z0-9-]+$/.test(name)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '無效的子域名' }));
    }

    const appDir = path.join(APPS_DIR, name);
    if (fs.existsSync(appDir)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: '名稱已被使用' }));
    }

    fs.mkdirSync(appDir, { recursive: true });
    const zipPath = path.join(appDir, 'upload.zip');
    fs.writeFileSync(zipPath, files.file.data);

    try {
      execSync(`tar -xf "${zipPath}" -C "${appDir}"`, { stdio: 'ignore', windowsHide: true });
      fs.unlinkSync(zipPath);
    } catch (e) {
      console.error('[admin] 解壓失敗:', e.message);
    }

    const pkgPath = path.join(appDir, 'package.json');
    let assignedPort = null;

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const isNextjs = !!(pkg.dependencies?.next || pkg.devDependencies?.next);
        const hasPnpmLock = fs.existsSync(path.join(appDir, 'pnpm-lock.yaml'));
        const hasYarnLock = fs.existsSync(path.join(appDir, 'yarn.lock'));
        const pm = hasPnpmLock ? 'pnpm' : hasYarnLock ? 'yarn' : 'npm';
        const pmInstall = pm === 'pnpm' ? 'pnpm install' : pm === 'yarn' ? 'yarn install' : 'npm install';
        const pmRun = pm === 'pnpm' ? 'pnpm run' : pm === 'yarn' ? 'yarn' : 'npm run';

        assignedPort = await deploy.getNextAvailablePort();
        execSync(pmInstall, { cwd: appDir, stdio: 'pipe', windowsHide: true });

        if (pkg.scripts?.build) {
          execSync(`${pmRun} build`, { cwd: appDir, stdio: 'pipe', windowsHide: true });
        }

        const startCommand = isNextjs
          ? 'npx next start'
          : (pkg.scripts?.start ? `${pm} start` : null);

        if (startCommand) {
          await deploy.createProject({
            id: name, name, deployMethod: 'upload-app',
            port: assignedPort, pm2Name: name,
            directory: `apps/${name}`, entryFile: startCommand,
          });

          const [cmd, ...args] = startCommand.split(' ');
          const pm2Name = `pipee-${name}`;
          try { execSync(`pm2 delete ${pm2Name}`, { stdio: 'pipe', windowsHide: true }); } catch {}
          execSync(
            `pm2 start "${cmd}" --name ${pm2Name} -- ${args.join(' ')}`,
            { cwd: appDir, env: { ...process.env, PORT: String(assignedPort), NODE_ENV: 'production' }, stdio: 'pipe', windowsHide: true }
          );
          console.log(`[admin] PM2 已啟動: ${pm2Name} (port: ${assignedPort})`);
        }
      } catch (e) {
        console.error('[admin] Node.js 專案啟動失敗:', e.message);
      }
    }

    try {
      const cf = getCloudflared();
      const hostname = `${name}.${getConfig().domain || 'localhost'}`;
      if (cf.tunnelId) {
        execSync(`"${cf.path}" tunnel route dns ${cf.tunnelId} ${hostname}`, { stdio: 'ignore', windowsHide: true });
      }
    } catch (e) {
      console.error('[admin] DNS 建立失敗:', e.message);
    }

    const result = { success: true, name, url: `https://${name}.${getConfig().domain || 'localhost'}` };
    if (assignedPort) result.port = assignedPort;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
}

function deleteService(name, res) {
  const filePath = path.join(SERVICES_DIR, `${name}.js`);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: '服務不存在' }));
  }
  hotloader.unloadService(name);
  fs.unlinkSync(filePath);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

function deleteApp(name, res) {
  const appDir = path.join(APPS_DIR, name);
  if (!fs.existsSync(appDir)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: '專案不存在' }));
  }
  fs.rmSync(appDir, { recursive: true });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true }));
}

function parseMultipart(req, callback) {
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.split('boundary=')[1];
  if (!boundary) return callback(new Error('No boundary'));

  let body = Buffer.alloc(0);
  req.on('data', chunk => { body = Buffer.concat([body, chunk]); });
  req.on('end', () => {
    try {
      const fields = {};
      const files = {};
      const parts = body.toString('binary').split('--' + boundary);
      parts.forEach(part => {
        if (part.includes('Content-Disposition')) {
          const headerEnd = part.indexOf('\r\n\r\n');
          const header = part.substring(0, headerEnd);
          const content = part.substring(headerEnd + 4).replace(/\r\n--$/, '').replace(/\r\n$/, '');
          const nameMatch = header.match(/name="([^"]+)"/);
          const filenameMatch = header.match(/filename="([^"]+)"/);
          if (nameMatch) {
            if (filenameMatch) {
              files[nameMatch[1]] = { filename: filenameMatch[1], data: Buffer.from(content, 'binary') };
            } else {
              fields[nameMatch[1]] = content;
            }
          }
        }
      });
      callback(null, fields, files);
    } catch (err) {
      callback(err);
    }
  });
}
