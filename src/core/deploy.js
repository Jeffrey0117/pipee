/**
 * PIPEE 部署引擎
 *
 * 功能：
 * - 專案管理 (CRUD)
 * - Git 部署 (pull + pm2 reload)
 * - 上傳部署 (解壓 ZIP)
 * - 部署記錄
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const events = new EventEmitter();

// Per-project deploy locks (in-memory + distributed via Redis)
const deployLocks = new Map();
const distributedLock = require('./distributed-lock');

const db = require('./db');
const PIPEE_ROOT = path.join(__dirname, '../..');

// Cloudflare Tunnel 設定（從 config.json 讀取）
const CLOUDFLARED_CONFIG = path.join(__dirname, '../../cloudflared.yml');
function getCloudflared() {
  const config = getConfig();
  return {
    path: config.cloudflared?.path || 'cloudflared',
    tunnelId: config.cloudflared?.tunnelId || '',
  };
}

// Port 分配設定
const BASE_PORT = 4000;  // 起始 port

// 讀取 config.json
const CONFIG_PATH = path.join(__dirname, '../../config.json');
function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// 解析系統上可用的 Python 指令（Windows 上 python 不在 PATH，需用 py launcher）
function resolvePythonCommand() {
  // Windows py launcher (C:\Windows\py.exe) — most reliable on Windows
  try {
    const pyPath = execSync('where py', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim().split('\n')[0].trim();
    if (pyPath) return { python: pyPath, pip: `"${pyPath}" -m pip` };
  } catch {}
  // python3 (Linux/Mac)
  try {
    execSync('python3 --version', { stdio: 'pipe', windowsHide: true });
    return { python: 'python3', pip: 'pip3' };
  } catch {}
  // python (fallback)
  try {
    execSync('python --version', { stdio: 'pipe', windowsHide: true });
    return { python: 'python', pip: 'pip' };
  } catch {}
  return { python: 'python', pip: 'pip' };
}

// Cached Python command resolution
let _pythonCmd = null;
function getPythonCmd() {
  if (!_pythonCmd) _pythonCmd = resolvePythonCommand();
  return _pythonCmd;
}

// Inject shared PIPEE env vars into a project's PM2 env.
// Mirrors TELEGRAM_PROXY pattern: per-machine, per-OS resolved values
// so .env files stay portable across machines.
function injectSharedEnv(targetEnv) {
  const cfg = getConfig();

  // TELEGRAM_PROXY (centralised here, callers no longer need to do this themselves)
  if (cfg.telegramProxy && !targetEnv.TELEGRAM_PROXY) {
    targetEnv.TELEGRAM_PROXY = cfg.telegramProxy;
  }

  // Custom shared env vars from config
  const sharedEnv = cfg.sharedEnv || {};
  for (const [key, val] of Object.entries(sharedEnv)) {
    if (!targetEnv[key]) targetEnv[key] = val;
  }

  // PYTHON_PATH — cross-platform python executable
  if (!targetEnv.PYTHON_PATH) {
    targetEnv.PYTHON_PATH = getPythonCmd().python;
  }
}

// robocopy wrapper: handles non-standard exit codes (< 8 = success, >= 8 = error)
function robocopySync(src, dst, extraFlags = '') {
  try {
    execSync(`robocopy "${src}" "${dst}" /MIR ${extraFlags}`.trim(), {
      windowsHide: true, stdio: 'pipe'
    });
  } catch (err) {
    // robocopy exit codes: 0-7 = various success states, >= 8 = actual error
    if (err.status >= 8) throw err;
  }
}

// 檢查端口是否可用
function isPortAvailable(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

// 取得下一個可用 port（真正檢查端口是否被佔用）
async function getNextAvailablePort() {
  const projects = db.getAllProjects();
  const usedPorts = projects
    .filter(p => p.port)
    .map(p => p.port);

  let startPort = BASE_PORT + 1;
  if (usedPorts.length > 0) {
    startPort = Math.max(...usedPorts) + 1;
  }

  for (let port = startPort; port < startPort + 100; port++) {
    const available = await isPortAvailable(port);
    if (available) return port;
  }

  throw new Error(`在 ${startPort}-${startPort + 100} 範圍內找不到可用端口`);
}

// ==================== Install Helper ====================

/**
 * Get the fastest install command for a package manager.
 * Uses `ci` (clean install from lockfile) when lockfile exists — significantly faster.
 * Falls back to `install` when no lockfile is present.
 */
function getFastInstallCmd(pm, dir) {
  if (pm === 'pnpm') {
    return fs.existsSync(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm install --frozen-lockfile' : 'pnpm install';
  }
  if (pm === 'yarn') {
    return fs.existsSync(path.join(dir, 'yarn.lock')) ? 'yarn install --frozen-lockfile' : 'yarn install';
  }
  // npm: use ci when package-lock.json exists
  return fs.existsSync(path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install';
}

// ==================== 專案管理 ====================

function getProject(id) {
  return db.getProject(id);
}

function getAllProjects() {
  return db.getAllProjects();
}

async function createProject(data) {
  // 檢查 ID 是否已存在
  if (db.getProject(data.id)) {
    throw new Error(`專案 ID "${data.id}" 已存在`);
  }

  // Git 部署或 Node app 自動分配 port
  const deployMethod = data.deployMethod || 'manual';
  const needsPort = deployMethod === 'github' || deployMethod === 'git-url' || deployMethod === 'upload-app';
  const autoPort = needsPort ? await getNextAvailablePort() : null;

  const project = {
    id: data.id,
    name: data.name || data.id,
    description: data.description || '',
    deployMethod,
    repoUrl: data.repoUrl || '',
    branch: data.branch || 'main',
    directory: data.directory || `../projects/${data.id}`,
    entryFile: data.entryFile || 'index.js',
    port: data.port || autoPort,  // 自動分配或手動指定
    pm2Name: data.pm2Name || data.id,
    webhookSecret: data.webhookSecret || crypto.randomBytes(20).toString('hex'),
    envFile: data.envFile || '',
    buildCommand: data.buildCommand || '',
    buildSteps: data.buildSteps || [],
    createdAt: new Date().toISOString(),
    lastDeployAt: null,
    lastDeployStatus: null
  };

  db.createProject(project);
  invalidateRouterCache();

  // GitHub 專案自動設定 webhook
  if (deployMethod === 'github' && project.repoUrl) {
    const config = getConfig();
    const domain = config.domain || 'localhost';
    const subdomain = config.subdomain || 'epi';
    const webhookUrl = `https://${subdomain}.${domain}/webhook/${project.id}`;

    // 非同步設定，不阻塞 createProject
    setupGitHubWebhook(project.id, webhookUrl).then(result => {
      if (result.success) {
        console.log(`[deploy] 自動設定 webhook: ${project.id}`);
      }
    }).catch(err => {
      console.log(`[deploy] Webhook 設定失敗 (可稍後手動設定): ${err.message}`);
    });
  }

  return project;
}

function invalidateRouterCache() {
  try {
    const router = require('./router');
    if (router.invalidateRouteCache) router.invalidateRouteCache();
  } catch (e) {
    console.error(`[deploy] Router cache invalidation failed: ${e.message}`);
  }
}

function updateProject(id, data) {
  const result = db.updateProject(id, data);
  invalidateRouterCache();
  return result;
}

function deleteProject(id) {
  const result = db.deleteProject(id);
  invalidateRouterCache();
  return result;
}

// ==================== Cloudflare Tunnel Ingress ====================

/**
 * 更新 cloudflared.yml，加入專案的 ingress 規則
 * - 自動為含萬用字元 (*) 的 hostname 加上引號
 * - 重複 hostname 偵測
 * - 寫入前備份 + YAML 驗證
 */
function updateTunnelIngress(hostname, port) {
  const domain = (getConfig().domain || 'localhost');

  // Subdomains are covered by wildcard DNS — router.js resolves hostname→port
  if (hostname.endsWith('.' + domain)) {
    console.log(`[deploy] Routing via router.js: ${hostname} -> :${port} (no YAML change needed)`);
    return true;
  }

  // Custom domains: ensure cloudflared.yml has a catch-all entry pointing to :8787
  // (router.js handles the actual port resolution)
  try {
    if (!fs.existsSync(CLOUDFLARED_CONFIG)) {
      console.log(`[deploy] cloudflared.yml 不存在，跳過 ingress 更新`);
      return false;
    }

    let content = fs.readFileSync(CLOUDFLARED_CONFIG, 'utf8');

    // Check if hostname already in YAML
    const existingHostnames = (content.match(/hostname:\s*"?([^"\n]+)"?/g) || [])
      .map(m => m.replace(/hostname:\s*"?/, '').replace(/"?\s*$/, '').trim());
    if (existingHostnames.includes(hostname)) {
      console.log(`[deploy] Ingress 已存在: ${hostname}`);
      return true;
    }

    // Backup
    const backupPath = CLOUDFLARED_CONFIG + '.bak';
    fs.writeFileSync(backupPath, content);

    // Custom domains always point to :8787 (router.js resolves the actual port)
    const formattedHostname = hostname.includes('*') ? `"${hostname}"` : hostname;
    const newRule = `\n  - hostname: ${formattedHostname}\n    service: http://localhost:8787`;

    // Insert before fallback
    const fallbackPattern = /(\s*- service: http_status:404)/;
    if (fallbackPattern.test(content)) {
      content = content.replace(fallbackPattern, newRule + '$1');
    } else {
      content += newRule + '\n';
    }

    // Validate YAML
    try {
      const yaml = require('yaml');
      yaml.parse(content);
    } catch (yamlErr) {
      console.error(`[deploy] YAML 驗證失敗，還原備份: ${yamlErr.message}`);
      fs.writeFileSync(CLOUDFLARED_CONFIG, fs.readFileSync(backupPath, 'utf8'));
      return false;
    }

    fs.writeFileSync(CLOUDFLARED_CONFIG, content);
    console.log(`[deploy] Ingress 已新增 (custom domain): ${hostname} -> :8787`);

    // Validate with cloudflared
    const cfPath = getCloudflared().path;
    try {
      execSync(`"${cfPath}" tunnel --config "${CLOUDFLARED_CONFIG}" ingress validate`, {
        stdio: 'pipe', windowsHide: true, timeout: 10000
      });
    } catch (validateErr) {
      const stderr = validateErr.stderr ? validateErr.stderr.toString().trim() : validateErr.message;
      console.error(`[deploy] cloudflared ingress validate 失敗，還原備份: ${stderr}`);
      fs.writeFileSync(CLOUDFLARED_CONFIG, fs.readFileSync(backupPath, 'utf8'));
      return false;
    }

    // Restart tunnel only for custom domain additions (rare)
    try {
      execSync('pm2 restart tunnel', { stdio: 'pipe', windowsHide: true });
      console.log(`[deploy] Tunnel 已重啟`);
    } catch (e) {
      console.log(`[deploy] Tunnel 重啟失敗: ${e.message}`);
    }

    return true;
  } catch (e) {
    console.error(`[deploy] 更新 ingress 失敗:`, e.message);
    const backupPath = CLOUDFLARED_CONFIG + '.bak';
    if (fs.existsSync(backupPath)) {
      try {
        fs.writeFileSync(CLOUDFLARED_CONFIG, fs.readFileSync(backupPath, 'utf8'));
        console.log(`[deploy] 已從備份還原 cloudflared.yml`);
      } catch {}
    }
    return false;
  }
}

// ==================== Health Check ====================

/**
 * 執行 Health Check，確認服務啟動
 * @param {number} port - 服務 port
 * @param {string} endpoint - 檢查的 endpoint（預設 /health）
 * @param {function} log - log 函數
 * @param {number} retries - 重試次數（預設 3）
 * @param {number} delay - 重試間隔 ms（預設 2000）
 */
async function performHealthCheck(port, endpoint = '/health', log, retries = 5, delay = 3000) {
  const http = require('http');
  const url = `http://localhost:${port}${endpoint}`;

  for (let i = 0; i < retries; i++) {
    // 等待服務啟動
    await new Promise(r => setTimeout(r, delay));

    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 5000 }, (res) => {
          res.resume();
          // 5xx = 服務掛了；2xx/3xx/4xx = 服務活著（404/401 只是沒那個路由）
          if (res.statusCode >= 500) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve(true);
          }
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      });

      if (result) return true;
    } catch (e) {
      log(`Health Check 嘗試 ${i + 1}/${retries} 失敗: ${e.message}`);
    }
  }

  return false;
}

// ==================== 部署引擎 ====================

/**
 * 解析專案目錄路徑（統一處理絕對路徑和相對路徑）
 */
function resolveProjectDir(project) {
  if (path.isAbsolute(project.directory)) {
    return path.normalize(project.directory);
  } else {
    return path.join(PIPEE_ROOT, project.directory);
  }
}

function generateDeployId() {
  return 'deploy_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

function runBuildSteps(steps, projectDir, log) {
  const total = steps.length;
  for (let i = 0; i < total; i++) {
    const step = steps[i];
    const label = `[step ${i + 1}/${total}: ${step.name}]`;
    log(`${label} 執行: ${step.command}`);
    const start = Date.now();
    try {
      execSync(step.command, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
      log(`${label} 完成 (${Date.now() - start}ms)`);
    } catch (err) {
      const elapsed = Date.now() - start;
      if (step.optional) {
        const stderr = err.stderr ? err.stderr.toString().trim().slice(0, 200) : err.message;
        log(`${label} ⚠ 失敗 (${elapsed}ms, optional): ${stderr}`);
      } else {
        log(`${label} ✗ 失敗 (${elapsed}ms)`);
        throw err;
      }
    }
  }
}

/**
 * Shadow Directory Build for Prisma projects (zero-downtime on Windows).
 *
 * Strategy: build in a shadow copy (no DLL lock), start temp process,
 * swap traffic via router, kill old, sync artifacts back, start canonical.
 *
 * Returns true on success, false on failure (after cleanup).
 */
async function deployShadowBuild(project, projectDir, pm, log) {
  const shadowDir = projectDir + '.shadow';
  const tempPort = project.port + 10000;
  const tempName = `${project.pm2Name}-shadow`;
  let routerSwapped = false;

  try {
    // ── Phase 1: Create shadow directory ──
    log(`Shadow Build: 建立影子目錄...`);
    if (fs.existsSync(shadowDir)) {
      fs.rmSync(shadowDir, { recursive: true, force: true });
    }
    robocopySync(projectDir, shadowDir, '/XD .git node_modules .next /XF .pkg-hash');

    // Copy .env files to shadow (robocopy /XF won't exclude them since they're not in exclusion)
    // They're already copied by robocopy above (not excluded), so no extra step needed.

    // ── Phase 2: npm install in shadow ──
    const installCmd = getFastInstallCmd(pm, shadowDir);
    log(`Shadow Build: ${installCmd}...`);
    execSync(installCmd, {
      cwd: shadowDir, stdio: 'pipe', windowsHide: true,
      env: { ...process.env, NODE_ENV: 'development' }
    });

    // ── Phase 3: Build in shadow ──
    if (project.buildSteps?.length) {
      log(`Shadow Build: 執行 buildSteps...`);
      runBuildSteps(project.buildSteps, shadowDir, log);
    } else {
      let buildCmd = project.buildCommand;
      if (!buildCmd) {
        const shadowPkgPath = path.join(shadowDir, 'package.json');
        if (fs.existsSync(shadowPkgPath)) {
          const shadowPkg = JSON.parse(fs.readFileSync(shadowPkgPath, 'utf8'));
          if (shadowPkg.scripts?.build) {
            const pmRun = pm === 'pnpm' ? 'pnpm run' : pm === 'yarn' ? 'yarn' : 'npm run';
            buildCmd = `${pmRun} build`;
          }
        }
      }
      if (buildCmd) {
        log(`Shadow Build: ${buildCmd}`);
        execSync(buildCmd, { cwd: shadowDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
      }
    }
    log(`Shadow Build: build 完成`);

    // ── Phase 4: Detect framework + start command from shadow ──
    let shadowStartCommand = null;
    let shadowUseInterpreterNone = false;
    const shadowPkgPath = path.join(shadowDir, 'package.json');

    if (fs.existsSync(shadowPkgPath)) {
      const shadowPkg = JSON.parse(fs.readFileSync(shadowPkgPath, 'utf8'));
      const isNextjs = !!(shadowPkg.dependencies?.next || shadowPkg.devDependencies?.next);
      if (isNextjs) {
        const nextBin = path.join(shadowDir, 'node_modules', 'next', 'dist', 'bin', 'next');
        shadowStartCommand = { script: nextBin, args: 'start' };
      } else if (shadowPkg.scripts?.start) {
        const wrapperPath = path.join(shadowDir, '.pm2-start.cjs');
        fs.writeFileSync(wrapperPath, [
          `const { spawn } = require('child_process');`,
          `const child = spawn(${JSON.stringify(pm)}, ['start'], { stdio: 'inherit', cwd: __dirname, shell: true });`,
          `child.on('exit', (code) => process.exit(code || 0));`,
        ].join('\n'));
        shadowStartCommand = { script: wrapperPath, args: '' };
      }
    }

    // ── Phase 5: Load env vars from ORIGINAL dir ──
    const shadowPm2Env = {
      NODE_ENV: 'production',
      PORT: String(project.port)
    };
    for (const envFileName of ['.env', '.env.local']) {
      const envFilePath = path.join(projectDir, envFileName);
      if (fs.existsSync(envFilePath)) {
        const envContent = fs.readFileSync(envFilePath, 'utf8');
        envContent.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx);
            const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
            shadowPm2Env[key] = val;
          }
        });
      }
    }
    injectSharedEnv(shadowPm2Env);

    // ── Phase 6: Build PM2 configs ──
    let shadowPm2Script, shadowPm2Args;
    if (shadowStartCommand) {
      shadowPm2Script = shadowStartCommand.script;
      shadowPm2Args = shadowStartCommand.args || undefined;
    } else {
      shadowPm2Script = path.join(shadowDir, project.entryFile || 'index.js');
      shadowPm2Args = undefined;
    }

    const tempEcoConfig = {
      apps: [{
        name: tempName,
        script: shadowPm2Script,
        cwd: shadowDir,
        env: { ...shadowPm2Env, PORT: String(tempPort) },
        autorestart: false,
        ...(shadowPm2Args ? { args: shadowPm2Args } : {}),
        ...(shadowUseInterpreterNone ? { interpreter: 'none' } : {})
      }]
    };
    const tempEcoPath = path.join(shadowDir, '.pm2-shadow-ecosystem.json');
    fs.writeFileSync(tempEcoPath, JSON.stringify(tempEcoConfig, null, 2));

    // ── Phase 7: Start temp PM2 ──
    const tempPortFree = await isPortAvailable(tempPort);
    if (!tempPortFree) throw new Error(`臨時 port ${tempPort} 被佔用`);

    log(`Shadow Build: 啟動臨時服務 (port ${tempPort})...`);
    execSync(`pm2 start "${tempEcoPath}"`, { stdio: 'pipe', cwd: shadowDir, windowsHide: true });

    // ── Phase 8: Health check temp ──
    const healthEndpoint = project.healthEndpoint || '/';
    const shadowHcRetries = project.healthCheckRetries || 5;
    const shadowHcDelay = project.healthCheckDelay || 3000;
    const tempHealthOk = await performHealthCheck(tempPort, healthEndpoint, log, shadowHcRetries, shadowHcDelay);
    if (!tempHealthOk) throw new Error('Shadow 臨時服務 health check 失敗');
    log(`✓ Shadow 臨時服務啟動成功`);

    // ── Phase 9: Router swap ──
    const router = require('./router');
    router.setPortOverride(project.id, tempPort);
    routerSwapped = true;
    log(`✓ Router 切換到 shadow port ${tempPort}（零停機）`);

    // ── Phase 10: Kill old PM2 ──
    if (project.companions && Array.isArray(project.companions)) {
      for (const companion of project.companions) {
        try { execSync(`pm2 delete ${project.pm2Name}-${companion.name}`, { stdio: 'pipe', windowsHide: true }); } catch {}
      }
    }
    try { execSync(`pm2 delete ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true }); } catch {}
    log(`等待 DLL 鎖定釋放...`);
    await new Promise(r => setTimeout(r, 3000));

    // ── Phase 11: Sync artifacts from shadow → original ──
    log(`Shadow Build: 同步產物到原始目錄...`);

    // Clean old .prisma (now safe — old process is dead)
    const prismaPath = path.join(projectDir, 'node_modules', '.prisma');
    if (fs.existsSync(prismaPath)) {
      try { fs.rmSync(prismaPath, { recursive: true, force: true }); } catch {}
    }
    // Sync .prisma from shadow
    robocopySync(
      path.join(shadowDir, 'node_modules', '.prisma'),
      prismaPath
    );
    // Sync .next from shadow (only for Next.js projects)
    const shadowNextDir = path.join(shadowDir, '.next');
    if (fs.existsSync(shadowNextDir)) {
      robocopySync(shadowNextDir, path.join(projectDir, '.next'));
    }

    // If package deps changed, sync full node_modules
    const shadowHashFile = path.join(shadowDir, '.pkg-hash');
    const origHashFile = path.join(projectDir, '.pkg-hash');
    // Compute shadow hash (npm install in shadow didn't write .pkg-hash since we excluded it)
    const shadowPkgContent = fs.readFileSync(path.join(shadowDir, 'package.json'), 'utf8');
    const shadowLockFiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    const shadowLockPath = shadowLockFiles.map(f => path.join(shadowDir, f)).find(f => fs.existsSync(f));
    const shadowLockContent = shadowLockPath ? fs.readFileSync(shadowLockPath, 'utf8') : '';
    const shadowHash = crypto.createHash('md5').update(shadowPkgContent + shadowLockContent).digest('hex');

    const origHash = fs.existsSync(origHashFile) ? fs.readFileSync(origHashFile, 'utf8').trim() : '';
    if (shadowHash !== origHash) {
      log(`Shadow Build: 依賴變更，同步完整 node_modules...`);
      robocopySync(
        path.join(shadowDir, 'node_modules'),
        path.join(projectDir, 'node_modules')
      );
      fs.writeFileSync(origHashFile, shadowHash);
    }

    log(`✓ 產物同步完成`);

    // ── Phase 12: Start canonical PM2 ──
    // Compute canonical script path (original dir)
    let canonicalPm2Script, canonicalPm2Args;
    if (shadowStartCommand) {
      canonicalPm2Script = shadowPm2Script.replace(shadowDir, projectDir);
      canonicalPm2Args = shadowPm2Args;
    } else {
      canonicalPm2Script = path.join(projectDir, project.entryFile || 'index.js');
      canonicalPm2Args = undefined;
    }

    const effectiveCwd = project.startCwd ? path.join(projectDir, project.startCwd) : projectDir;
    const canonicalEcoConfig = {
      apps: [{
        name: project.pm2Name,
        script: canonicalPm2Script,
        cwd: effectiveCwd,
        env: shadowPm2Env,
        autorestart: true,
        max_restarts: 5,
        ...(canonicalPm2Args ? { args: canonicalPm2Args } : {}),
        ...(shadowUseInterpreterNone ? { interpreter: 'none' } : {})
      }]
    };
    const ecoPath = path.join(projectDir, '.pm2-ecosystem.json');
    fs.writeFileSync(ecoPath, JSON.stringify(canonicalEcoConfig, null, 2));

    let canonicalStarted = false;
    try {
      execSync(`pm2 start "${ecoPath}"`, { stdio: 'pipe', cwd: projectDir, windowsHide: true });
      log(`PM2 啟動完成 (port: ${project.port})`);

      const canonicalOk = await performHealthCheck(project.port, healthEndpoint, log, shadowHcRetries, shadowHcDelay);
      if (canonicalOk) {
        log(`✓ Shadow Build 完成：流量回到 port ${project.port}`);
        canonicalStarted = true;
      } else {
        log(`⚠ Canonical health check 失敗，但程序已啟動`);
        canonicalStarted = true; // process exists even if health check failed
      }
    } catch (canonicalErr) {
      log(`⚠ Canonical 啟動失敗: ${canonicalErr.message}`);
    }

    if (canonicalStarted) {
      // Success: clear router override, clean up temp + shadow
      router.clearPortOverride(project.id);
      routerSwapped = false;
      try { execSync(`pm2 delete ${tempName}`, { stdio: 'pipe', windowsHide: true }); } catch {}
      try { fs.rmSync(shadowDir, { recursive: true, force: true }); } catch {}
    } else {
      // Canonical failed: keep temp shadow process running as fallback
      log(`⚠ Canonical 啟動失敗，保留 shadow 臨時服務 (port ${tempPort}) 作為備用`);
      log(`⚠ 請手動排查後重新部署。Shadow 目錄: ${shadowDir}`);
      // Do NOT clear router override or kill temp — traffic still flows through temp
    }

    // Warn about companions (shadow build kills them but doesn't respawn)
    if (project.companions && Array.isArray(project.companions) && project.companions.length > 0) {
      log(`⚠ Shadow Build 不自動重啟 companion 進程，請手動重啟或觸發標準部署`);
    }

    return true;
  } catch (shadowErr) {
    log(`⚠ Shadow Build 失敗: ${shadowErr.message}`);
    log(`退回 kill-first 標準部署...`);

    // Cleanup
    try { execSync(`pm2 delete ${tempName}`, { stdio: 'pipe', windowsHide: true }); } catch {}
    if (routerSwapped) {
      try { require('./router').clearPortOverride(project.id); } catch {}
    }
    try { fs.rmSync(shadowDir, { recursive: true, force: true }); } catch {}

    return false;
  }
}

async function deploy(projectId, options = {}) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`專案 "${projectId}" 不存在`);
  }

  // ===== Deploy Lock: prevent concurrent deploys (local + distributed) =====
  const existingLock = deployLocks.get(projectId);
  if (existingLock) {
    const lockAge = Date.now() - existingLock;
    if (lockAge < 30 * 60 * 1000) {
      console.log(`[deploy:${projectId}] 已有部署正在進行（${Math.round(lockAge / 1000)}s ago），跳過`);
      return { id: null, status: 'skipped', error: 'Deploy already in progress' };
    }
    console.log(`[deploy:${projectId}] 偵測到 stale lock（${Math.round(lockAge / 60000)}min），強制清除`);
  }

  // 跨機 distributed lock
  const gotDistributedLock = await distributedLock.acquire(`deploy:${projectId}`);
  if (!gotDistributedLock) {
    console.log(`[deploy:${projectId}] 另一台機器正在部署，跳過`);
    return { id: null, status: 'skipped', error: 'Deploy in progress on another machine' };
  }

  deployLocks.set(projectId, Date.now());

  // ===== Clean up stale "building" records (older than 10 min) =====
  const STALE_THRESHOLD = 10 * 60 * 1000;
  db.cleanStaleDeployments(projectId, STALE_THRESHOLD);

  const deployId = generateDeployId();
  const startedAt = new Date().toISOString();
  const logs = [];

  const log = (msg) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${msg}`);
    console.log(`[deploy:${projectId}] ${msg}`);
  };

  // 建立部署記錄
  const deployment = {
    id: deployId,
    projectId,
    status: 'building',
    commit: null,
    commitMessage: null,
    branch: project.branch,
    startedAt,
    finishedAt: null,
    duration: null,
    logs: [],
    triggeredBy: options.triggeredBy || 'manual',
    error: null
  };

  db.createDeployment(deployment);

  try {
    const projectDir = resolveProjectDir(project);

    log(`開始部署專案: ${project.name}`);
    log(`專案目錄: ${projectDir}`);

    // 確保目錄存在
    if (!fs.existsSync(projectDir)) {
      if (project.deployMethod === 'github' || project.deployMethod === 'git-url') {
        // Clone repo（不指定 branch，自動用 repo 預設 branch）
        log(`目錄不存在，執行 git clone...`);
        const parentDir = path.dirname(projectDir);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        execSync(`git clone ${project.repoUrl} ${path.basename(projectDir)}`, {
          cwd: parentDir,
          stdio: 'pipe',
          windowsHide: true
        });
        // 自動偵測實際使用的 branch 並更新配置
        const actualBranch = execSync('git branch --show-current', { cwd: projectDir, windowsHide: true }).toString().trim();
        if (actualBranch && actualBranch !== project.branch) {
          log(`偵測到預設 branch: ${actualBranch}（原設定: ${project.branch}）`);
          updateProject(project.id, { branch: actualBranch });
          project.branch = actualBranch;
        }
        log(`Clone 完成 (branch: ${project.branch})`);
      } else {
        fs.mkdirSync(projectDir, { recursive: true });
        log(`建立目錄: ${projectDir}`);
      }
    }

    // Rollback state — declared at function scope so health check rollback can access them
    let backup = null;
    let envBackups = {};

    // Git 部署
    if (project.deployMethod === 'github' || project.deployMethod === 'git-url') {
      // Backup env files before git reset (they're not in git and would survive reset,
      // but git clean or other operations could remove them)
      const ENV_PATTERNS = ['.env', '.env.local', '.env.production', '.env.production.local'];
      envBackups = {};
      for (const envName of ENV_PATTERNS) {
        const envPath = path.join(projectDir, envName);
        if (fs.existsSync(envPath)) {
          envBackups[envName] = fs.readFileSync(envPath);
          log(`備份 ${envName}`);
        }
      }

      // Tag current commit for rollback backup
      backup = tagCurrentDeploy(projectDir, projectId);
      if (backup) {
        log(`Backup tag: ${backup.tagName} (commit: ${backup.commit})`);
      }

      log(`執行 git fetch...`);
      execSync(`git fetch origin`, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 60000 });

      log(`執行 git reset --hard...`);
      execSync(`git reset --hard origin/${project.branch}`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });

      // Restore env files
      for (const [envName, content] of Object.entries(envBackups)) {
        fs.writeFileSync(path.join(projectDir, envName), content);
        log(`還原 ${envName}`);
      }

      // 取得 commit 資訊
      const commitHash = execSync('git rev-parse --short HEAD', { cwd: projectDir, windowsHide: true }).toString().trim();
      const commitMessage = execSync('git log -1 --pretty=%B', { cwd: projectDir, windowsHide: true }).toString().trim();

      deployment.commit = commitHash;
      deployment.commitMessage = commitMessage;
      log(`Commit: ${commitHash} - ${commitMessage}`);
    }

    // Python 依賴安裝（runner: python）
    const isPython = project.runner === 'python';
    if (isPython) {
      const pyCmd = getPythonCmd();
      const reqPath = path.join(projectDir, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        log('安裝 Python 依賴...');
        try {
          execSync(`${pyCmd.pip} install -r "${reqPath}"`, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
          log('Python 依賴安裝完成');
        } catch (e) {
          log(`⚠ Python 依賴安裝失敗: ${e.message}`);
        }
      }
    }

    // 偵測 package manager
    const pkgPath = path.join(projectDir, 'package.json');
    const hasPnpmLock = fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'));
    const hasYarnLock = fs.existsSync(path.join(projectDir, 'yarn.lock'));
    const pm = hasPnpmLock ? 'pnpm' : hasYarnLock ? 'yarn' : 'npm';

    // === Detect Prisma (Windows DLL file lock requires killing process first) ===
    const hasPrisma = fs.existsSync(path.join(projectDir, 'node_modules', '.prisma'));

    // === Shadow Build: zero-downtime deploy for Prisma projects ===
    // Build in a shadow directory (no DLL lock), serve from temp port, swap artifacts.
    let shadowBuildCompleted = false;
    if (hasPrisma && project.port && project.pm2Name) {
      shadowBuildCompleted = await deployShadowBuild(project, projectDir, pm, log);
      if (shadowBuildCompleted) {
        log(`Shadow Build 成功，跳過標準 Prisma 部署流程`);
      }
    }

    // Build-first strategy: for non-Prisma projects, keep old process running during
    // npm install + build, then swap via pm2 delete/start (near-zero downtime ~1-2s).
    // Prisma projects must kill first due to Windows DLL file lock.
    // (Skipped if Shadow Build succeeded)
    let killedOldProcess = false;
    let portPid = null;
    if (!shadowBuildCompleted && hasPrisma && project.port) {
      try {
        log(`檢查 port ${project.port} 是否被佔用...`);
        const netstat = execSync(`netstat -ano | findstr :${project.port}`, { windowsHide: true }).toString();
        const lines = netstat.split('\n').filter(l => l.includes('LISTENING'));
        if (lines.length > 0) {
          portPid = lines[0].trim().split(/\s+/).pop();
          log(`Port ${project.port} 被 PID ${portPid} 佔用，嘗試關閉...`);
          try {
            execSync(`taskkill /F /PID ${portPid}`, { windowsHide: true });
            log(`✓ 已關閉 PID ${portPid}`);
            killedOldProcess = true;
            // 等待 3 秒讓 port 和 file handles 完全釋放
            log(`等待 3 秒讓檔案鎖定釋放...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          } catch (killErr) {
            log(`⚠ 無法關閉 PID ${portPid}: ${killErr.message}`);
          }
        } else {
          log(`Port ${project.port} 未被佔用`);
        }
      } catch (err) {
        // netstat 找不到表示 port 沒被佔用，繼續
        log(`Port ${project.port} 未被佔用`);
      }
    }

    // 清理 Prisma cache（在 npm install 之前，避免 EPERM 錯誤）
    // 4 層重試策略：kill port PID → 3s 等待 → pm2 stop → 5s 等待 → force kill port PID
    // (Skipped if Shadow Build succeeded)
    const prismaPath = path.join(projectDir, 'node_modules', '.prisma');
    if (!shadowBuildCompleted && fs.existsSync(prismaPath)) {
      log(`清理 Prisma cache...`);

      // 檢查 .dll.node 檔案鎖定
      const dllPath = path.join(prismaPath, 'client', 'query_engine-windows.dll.node');
      const isDllLocked = () => {
        if (!fs.existsSync(dllPath)) return false;
        try {
          fs.accessSync(dllPath, fs.constants.W_OK);
          return false;
        } catch {
          return true;
        }
      };

      try {
        if (isDllLocked()) {
          log(`⚠ Prisma DLL 仍被鎖定，等待額外 2 秒...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        fs.rmSync(prismaPath, { recursive: true, force: true });
        log(`✓ Prisma cache 已清理`);
      } catch (cleanErr) {
        log(`⚠ 清理 Prisma cache 失敗 (第 1 次): ${cleanErr.message}`);
        // 第 2 層：等待 3 秒後重試
        log(`等待 3 秒後重試清理...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          fs.rmSync(prismaPath, { recursive: true, force: true });
          log(`✓ Prisma cache 重試清理成功 (第 2 次)`);
        } catch (retryErr) {
          log(`⚠ Prisma cache 重試清理失敗 (第 2 次): ${retryErr.message}`);
          // 第 3 層：pm2 stop + 5 秒等待
          if (project.pm2Name) {
            log(`停止 PM2 進程 ${project.pm2Name}...`);
            try {
              execSync(`pm2 stop ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
            } catch (e) { log(`⚠ pm2 stop 失敗: ${e.message}`); }
            log(`等待 5 秒後重試清理...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            try {
              fs.rmSync(prismaPath, { recursive: true, force: true });
              log(`✓ Prisma cache 清理成功 (第 3 次，pm2 stop 後)`);
            } catch (thirdErr) {
              log(`⚠ 第 3 次清理失敗: ${thirdErr.message}`);
              // 第 4 層：重新檢查 port PID 並 force kill
              try {
                const netstat2 = execSync(`netstat -ano | findstr :${project.port}`, { windowsHide: true }).toString();
                const lines2 = netstat2.split('\n').filter(l => l.includes('LISTENING') || l.includes('ESTABLISHED'));
                const pids = [...new Set(lines2.map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
                for (const pid of pids) {
                  log(`強制結束 PID ${pid}...`);
                  try { execSync(`taskkill /F /PID ${pid}`, { windowsHide: true }); } catch {}
                }
                await new Promise(resolve => setTimeout(resolve, 3000));
                fs.rmSync(prismaPath, { recursive: true, force: true });
                log(`✓ Prisma cache 清理成功 (第 4 次，force kill 後)`);
              } catch (finalErr) {
                log(`❌ 所有 4 層清理嘗試均失敗，建議手動重啟伺服器: ${finalErr.message}`);
              }
            }
          } else {
            log(`⚠ 無法清理 Prisma cache，繼續執行 (可能導致 build 失敗)`);
          }
        }
      }
    }

    if (!hasPrisma && project.port) {
      log(`Build-first 模式（近零停機部署）`);
    }

    // 自動安裝依賴（如果有 package.json）
    // (Skipped if Shadow Build succeeded — shadow already installed deps)
    if (!shadowBuildCompleted && !isPython && fs.existsSync(pkgPath)) {
      const nodeModulesPath = path.join(projectDir, 'node_modules');
      const lockFiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
      const lockPath = lockFiles.map(f => path.join(projectDir, f)).find(f => fs.existsSync(f));
      const hashFile = path.join(projectDir, '.pkg-hash');

      // 計算 package.json + lock 的 hash
      const pkgContent = fs.readFileSync(pkgPath, 'utf8');
      const lockContent = lockPath ? fs.readFileSync(lockPath, 'utf8') : '';
      const currentHash = crypto.createHash('md5').update(pkgContent + lockContent).digest('hex');

      // 讀取上次安裝時的 hash
      let lastHash = '';
      if (fs.existsSync(hashFile)) {
        lastHash = fs.readFileSync(hashFile, 'utf8').trim();
      }

      // 檢查是否需要重新安裝
      const needInstall = !fs.existsSync(nodeModulesPath) || currentHash !== lastHash;

      if (needInstall) {
        if (currentHash !== lastHash && lastHash) {
          log(`偵測到依賴變更 (hash changed)，重新安裝...`);
        } else if (!fs.existsSync(nodeModulesPath)) {
          log(`node_modules 不存在，執行安裝...`);
        }
        const installCmd = getFastInstallCmd(pm, projectDir);
        log(`執行 ${installCmd}...`);
        // NODE_ENV=development 確保 devDependencies 也會安裝（build 工具通常在 devDeps）
        const installEnv = { ...process.env, NODE_ENV: 'development' };
        execSync(installCmd, { cwd: projectDir, stdio: 'pipe', windowsHide: true, env: installEnv });
        // 儲存 hash
        fs.writeFileSync(hashFile, currentHash);
        log(`依賴安裝完成`);
      }

      // Monorepo 偵測：檢查 build script 或 buildCommand 中的 cd <dir>，自動安裝子目錄依賴
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const buildScript = project.buildCommand || pkg.scripts?.build || '';
        const cdMatch = buildScript.match(/cd\s+([^\s&|;]+)/);
        if (cdMatch) {
          const subDir = cdMatch[1];
          const subDirPath = path.join(projectDir, subDir);
          const subPkgPath = path.join(subDirPath, 'package.json');
          const subNodeModules = path.join(subDirPath, 'node_modules');
          if (fs.existsSync(subPkgPath) && !fs.existsSync(subNodeModules)) {
            const subHasPnpmLock = fs.existsSync(path.join(subDirPath, 'pnpm-lock.yaml'));
            const subHasYarnLock = fs.existsSync(path.join(subDirPath, 'yarn.lock'));
            const subPm = subHasPnpmLock ? 'pnpm' : subHasYarnLock ? 'yarn' : 'npm';
            const subInstallCmd = getFastInstallCmd(subPm, subDirPath);
            log(`偵測到 monorepo 子目錄: ${subDir}/, 執行 ${subInstallCmd}...`);
            const subInstallEnv = { ...process.env, NODE_ENV: 'development' };
            execSync(subInstallCmd, { cwd: subDirPath, stdio: 'pipe', windowsHide: true, env: subInstallEnv });
            log(`${subDir}/ 依賴安裝完成`);
          }
        }
      } catch (e) {
        // ignore monorepo detection errors
      }
    }

    // 執行 build（buildSteps 優先，fallback 到 buildCommand）
    // (Skipped if Shadow Build succeeded — shadow already built)
    let buildCmd = null;  // hoisted for health check rollback access
    if (!shadowBuildCompleted && project.buildSteps?.length) {
      try {
        runBuildSteps(project.buildSteps, projectDir, log);
      } catch (buildErr) {
        const stderr = buildErr.stderr ? buildErr.stderr.toString().trim() : '';
        log(`Build stderr: ${stderr || buildErr.message}`);

        // Auto-rollback: restore to backup commit if we have one
        if (backup) {
          log(`⚠ Build 失敗，自動回滾到 ${backup.commit}...`);
          try {
            execSync(`git reset --hard ${backup.commit}`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });
            for (const [envName, content] of Object.entries(envBackups)) {
              fs.writeFileSync(path.join(projectDir, envName), content);
            }
            runBuildSteps(project.buildSteps, projectDir, log);
            log(`✓ 回滾 build 成功`);
            if (project.pm2Name) {
              try {
                execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
                log(`✓ 舊版本已重啟 (pm2 restart ${project.pm2Name})`);
              } catch (e) { log(`❌ 回滾後 pm2 restart 失敗: ${e.message}`); }
            }
          } catch (rollbackErr) {
            log(`⚠ 自動回滾也失敗: ${rollbackErr.message}`);
            if (project.pm2Name) {
              try {
                execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
              } catch (e) { log(`❌ 最後手段 pm2 restart 也失敗: ${e.message}`); }
            }
          }
        } else if (killedOldProcess && project.pm2Name) {
          log(`⚠ Build 失敗，嘗試重啟舊進程...`);
          try {
            execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
            log(`✓ 舊進程已重啟 (pm2 restart ${project.pm2Name})`);
          } catch (restartErr) {
            log(`⚠ 重啟舊進程失敗: ${restartErr.message}`);
          }
        }

        throw buildErr;
      }
      log(`Build 完成`);
    } else if (!shadowBuildCompleted) {
    buildCmd = project.buildCommand;
    if (!buildCmd && fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts?.build) {
          const pmRun = pm === 'pnpm' ? 'pnpm run' : pm === 'yarn' ? 'yarn' : 'npm run';
          buildCmd = `${pmRun} build`;
          log(`偵測到 build script，自動執行`);
        }
      } catch (e) {
        // ignore
      }
    }
    if (buildCmd) {
      // Run build command without NODE_ENV override — Next.js needs NODE_ENV=production
      // The NODE_ENV=development trick is only needed for `npm install` (devDependencies)
      log(`執行 build: ${buildCmd}`);
      try {
        execSync(buildCmd, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
      } catch (buildErr) {
        const stderr = buildErr.stderr ? buildErr.stderr.toString().trim() : '';
        log(`Build stderr: ${stderr || buildErr.message}`);

        // Auto-rollback: restore to backup commit if we have one
        if (backup) {
          log(`⚠ Build 失敗，自動回滾到 ${backup.commit}...`);
          try {
            execSync(`git reset --hard ${backup.commit}`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });
            // Restore env files again after rollback
            for (const [envName, content] of Object.entries(envBackups)) {
              fs.writeFileSync(path.join(projectDir, envName), content);
            }
            // Rebuild with old code
            execSync(buildCmd, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
            log(`✓ 回滾 build 成功`);
            if (project.pm2Name) {
              try {
                execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
                log(`✓ 舊版本已重啟 (pm2 restart ${project.pm2Name})`);
              } catch (e) { log(`❌ 回滾後 pm2 restart 失敗: ${e.message}`); }
            }
          } catch (rollbackErr) {
            log(`⚠ 自動回滾也失敗: ${rollbackErr.message}`);
            // Last resort: just try to restart PM2
            if (project.pm2Name) {
              try {
                execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
              } catch (e) { log(`❌ 最後手段 pm2 restart 也失敗: ${e.message}`); }
            }
          }
        } else if (killedOldProcess && project.pm2Name) {
          log(`⚠ Build 失敗，嘗試重啟舊進程...`);
          try {
            execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
            log(`✓ 舊進程已重啟 (pm2 restart ${project.pm2Name})`);
          } catch (restartErr) {
            log(`⚠ 重啟舊進程失敗: ${restartErr.message}`);
          }
        }

        throw buildErr;
      }
      log(`Build 完成`);
    }
    }

    // 自動偵測入口檔案或啟動指令 (Skipped if Shadow Build succeeded)
    let entryFile = project.entryFile;
    let startCommand = null;  // 框架專案用啟動指令代替入口檔案
    let useInterpreterNone = false;  // Python projects need interpreter: 'none'

    // Python runner: skip Node.js detection, use uvicorn
    if (isPython) {
      const pyCmd = getPythonCmd();
      startCommand = {
        script: pyCmd.python,
        args: `-m uvicorn ${entryFile} --host 0.0.0.0 --port ${project.port || 8000}`
      };
      useInterpreterNone = true;
      log(`Python 專案，使用 uvicorn: ${entryFile}`);
    } else if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.main) {
          entryFile = pkg.main;
          log(`從 package.json 偵測入口: ${entryFile}`);
        }
      } catch (e) {
        // ignore
      }
    }
    // Fallback: 檢查常見入口檔案（Node.js only）
    if (!isPython && !fs.existsSync(path.join(projectDir, entryFile))) {
      const candidates = ['server.js', 'app.js', 'index.js', 'main.js'];
      for (const c of candidates) {
        if (fs.existsSync(path.join(projectDir, c))) {
          log(`找到入口檔案: ${c}`);
          entryFile = c;
          break;
        }
      }
    }
    // TypeScript 入口：Node.js 無法直接執行 .ts，改用 scripts.start wrapper
    if (entryFile.endsWith('.ts') && fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts?.start) {
          const wrapperPath = path.join(projectDir, '.pm2-start.cjs');
          fs.writeFileSync(wrapperPath, [
            `const { spawn } = require('child_process');`,
            `const child = spawn(${JSON.stringify(pm)}, ['start'], { stdio: 'inherit', cwd: __dirname, shell: true });`,
            `child.on('exit', (code) => process.exit(code || 0));`,
          ].join('\n'));
          startCommand = { script: wrapperPath, args: '' };
          log(`TypeScript 入口 (${entryFile})，使用 ${pm} start (wrapper)`);
        }
      } catch (e) {
        // ignore
      }
    }
    // 框架偵測：如果仍找不到入口檔案，偵測框架啟動方式
    if (!startCommand && !fs.existsSync(path.join(projectDir, entryFile)) && fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const isNextjs = !!(pkg.dependencies?.next || pkg.devDependencies?.next);
        if (isNextjs) {
          // Next.js：直接用 next 的 JS 入口（Windows 上 .cmd 不能被 PM2 執行）
          const nextBin = path.join(projectDir, 'node_modules', 'next', 'dist', 'bin', 'next');
          startCommand = { script: nextBin, args: 'start' };
          log(`偵測到 Next.js 專案，使用 next start`);
        } else if (pkg.scripts?.start) {
          // 其他框架：建立 wrapper script 來呼叫 start
          const wrapperPath = path.join(projectDir, '.pm2-start.cjs');
          fs.writeFileSync(wrapperPath, [
            `const { spawn } = require('child_process');`,
            `const child = spawn(${JSON.stringify(pm)}, ['start'], { stdio: 'inherit', cwd: __dirname, shell: true });`,
            `child.on('exit', (code) => process.exit(code || 0));`,
          ].join('\n'));
          startCommand = { script: wrapperPath, args: '' };
          log(`偵測到 scripts.start，使用 ${pm} start (wrapper)`);
        }
      } catch (e) {
        // ignore
      }
    }
    // 靜態站偵測：有 build 產出但沒有入口檔案或啟動指令
    if (!startCommand && !fs.existsSync(path.join(projectDir, entryFile))) {
      const outputDirs = ['dist', 'build', 'out'];
      for (const dir of outputDirs) {
        const outputPath = path.join(projectDir, dir);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).isDirectory()) {
          // 安裝 serve（如果尚未安裝）
          const serveBin = path.join(projectDir, 'node_modules', '.bin', 'serve');
          if (!fs.existsSync(serveBin)) {
            log('安裝 serve 套件（靜態站託管）...');
            execSync(`npm install serve --save-dev`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });
          }
          // 建立 PM2 wrapper
          const wrapperPath = path.join(projectDir, '.pm2-static.cjs');
          fs.writeFileSync(wrapperPath, [
            `const { spawn } = require('child_process');`,
            `const port = process.env.PORT || ${project.port || 3000};`,
            `const child = spawn('npx', ['serve', '${dir}', '-s', '-l', String(port)], {`,
            `  stdio: 'inherit', cwd: __dirname, shell: true`,
            `});`,
            `child.on('exit', (code) => process.exit(code || 0));`,
          ].join('\n'));
          startCommand = { script: wrapperPath, args: '' };
          log(`偵測到靜態站 (${dir}/)，使用 serve 託管`);
          break;
        }
      }
    }

    // 自動標記 runner（供 ecosystem.config.js 冷啟動用）
    if (!project.runner) {
      if (startCommand && startCommand.script.includes('next')) {
        updateProject(project.id, { runner: 'next' });
      } else if (entryFile.endsWith('.ts')) {
        updateProject(project.id, { runner: 'tsx' });
      }
    }

    // 更新專案配置
    if (entryFile !== project.entryFile) {
      updateProject(project.id, { entryFile });
      project.entryFile = entryFile;
    }

    // PM2 重啟 (Skipped if Shadow Build succeeded — shadow handles PM2 lifecycle)
    if (!shadowBuildCompleted && project.pm2Name) {
      // 準備環境變數
      const pm2Env = {
        NODE_ENV: 'production',
        ...(project.port ? { PORT: String(project.port) } : {})
      };

      // Load .env files from project directory (.env first, .env.local overrides)
      for (const envFileName of ['.env', '.env.local']) {
        const envFilePath = path.join(projectDir, envFileName);
        if (fs.existsSync(envFilePath)) {
          const envContent = fs.readFileSync(envFilePath, 'utf8');
          envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
              const key = trimmed.slice(0, eqIdx);
              let val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
              pm2Env[key] = val;
            }
          });
          log(`${envFileName} 已載入`);
        }
      }
      log(`環境變數總計: ${Object.keys(pm2Env).length} 個`);

      // Inject shared PIPEE env vars (TELEGRAM_PROXY, MEEI_PATH, PYTHON_PATH)
      injectSharedEnv(pm2Env);

      // Build PM2 ecosystem config (needed by both Blue-Green and normal paths)
      let pm2Script, pm2Args;
      if (startCommand) {
        pm2Script = startCommand.script;
        pm2Args = startCommand.args || undefined;
        log(`啟動 PM2 (framework): ${path.basename(pm2Script)} ${pm2Args || ''}`);
      } else {
        const entryPath = path.join(projectDir, entryFile);
        if (!fs.existsSync(entryPath)) {
          throw new Error(`入口檔案不存在: ${entryFile}`);
        }
        pm2Script = entryPath;
        pm2Args = undefined;
        log(`啟動 PM2 (file): ${entryFile}`);
      }

      const effectiveCwd = project.startCwd ? path.join(projectDir, project.startCwd) : projectDir;
      const healthEndpoint = project.healthEndpoint || (startCommand ? '/' : '/health');
      const pm2EcoConfig = {
        apps: [{
          name: project.pm2Name,
          script: pm2Script,
          cwd: effectiveCwd,
          env: pm2Env,
          autorestart: true,
          max_restarts: 5,
          ...(pm2Args ? { args: pm2Args } : {}),
          ...(useInterpreterNone ? { interpreter: 'none' } : {})
        }]
      };
      const ecoPath = path.join(projectDir, '.pm2-ecosystem.json');

      // ========== Blue-Green Deployment (zero-downtime) ==========
      // Strategy: start new version on temp port → health check → router swap →
      // restart on canonical port → clear override → cleanup temp.
      // Old process serves traffic until router swap — zero dropped requests.
      let blueGreenCompleted = false;

      // Per-project health check config (slow-starting services need more time)
      const hcRetries = project.healthCheckRetries || 5;
      const hcDelay = project.healthCheckDelay || 3000;

      if (!killedOldProcess && project.port) {
        log(`→ 嘗試 Blue-Green 零停機部署...`);
        const tempPort = project.port + 10000;
        const tempName = `${project.pm2Name}-bg`;

        // Validate temp port is available
        const tempPortFree = await isPortAvailable(tempPort);
        if (!tempPortFree) {
          log(`⚠ 臨時 port ${tempPort} 已被佔用，退回標準部署`);
        } else {

        log(`Blue-Green: 啟動新版在臨時 port ${tempPort}...`);

        // Start temp process
        const tempEcoConfig = {
          apps: [{
            name: tempName,
            script: pm2Script,
            cwd: effectiveCwd,
            env: { ...pm2Env, PORT: String(tempPort) },
            autorestart: false,
            ...(pm2Args ? { args: pm2Args } : {}),
            ...(useInterpreterNone ? { interpreter: 'none' } : {})
          }]
        };
        const tempEcoPath = path.join(projectDir, '.pm2-bg-ecosystem.json');
        fs.writeFileSync(tempEcoPath, JSON.stringify(tempEcoConfig, null, 2));

        let tempStarted = false;
        try {
          execSync(`pm2 start "${tempEcoPath}"`, { stdio: 'pipe', cwd: projectDir, windowsHide: true });
          tempStarted = true;
        } catch (bgStartErr) {
          log(`⚠ Blue-Green 啟動失敗，退回標準部署: ${bgStartErr.message}`);
        }

        // Health check temp port (skip if temp didn't start)
        const tempHealthOk = tempStarted && await performHealthCheck(tempPort, healthEndpoint, log, hcRetries, hcDelay);

        if (tempHealthOk) {
          // Router swap — traffic instantly goes to temp port (zero downtime)
          const router = require('./router');
          router.setPortOverride(project.id, tempPort);
          log(`✓ Router 切換到 port ${tempPort}（零停機）`);

          // 整段包在 try/finally 裡，確保 override 一定被清除
          try {
            // Delete old process + companions (port freed, but traffic goes to temp)
            if (project.companions && Array.isArray(project.companions)) {
              for (const companion of project.companions) {
                try { execSync(`pm2 delete ${project.pm2Name}-${companion.name}`, { stdio: 'pipe', windowsHide: true }); } catch {}
              }
            }
            try { execSync(`pm2 delete ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true }); } catch {}
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Start canonical process on original port
            fs.writeFileSync(ecoPath, JSON.stringify(pm2EcoConfig, null, 2));
            execSync(`pm2 start "${ecoPath}"`, { stdio: 'pipe', cwd: projectDir, windowsHide: true });
            log(`PM2 啟動完成 (port: ${project.port})`);

            // Health check canonical port (use same per-project config as temp check)
            const canonicalOk = await performHealthCheck(project.port, healthEndpoint, log, hcRetries, hcDelay);

            if (canonicalOk) {
              log(`✓ Blue-Green 完成：流量回到 port ${project.port}`);
            } else {
              log(`⚠ 原始 port health check 失敗，但程序已啟動`);
            }
          } catch (canonicalErr) {
            log(`⚠ Blue-Green 原始 port 階段失敗: ${canonicalErr.message}`);
          } finally {
            // ALWAYS clear override and clean up temp — even on failure
            router.clearPortOverride(project.id);
            try { execSync(`pm2 delete ${tempName}`, { stdio: 'pipe', windowsHide: true }); } catch {}
            try { fs.unlinkSync(tempEcoPath); } catch {}
          }

          blueGreenCompleted = true;
        } else {
          // Clean up failed temp process, fall through to normal deploy
          try { execSync(`pm2 delete ${tempName}`, { stdio: 'pipe', windowsHide: true }); } catch {}
          try { fs.unlinkSync(tempEcoPath); } catch {}
          log(`⚠ Blue-Green health check 失敗，退回標準部署`);
        }

        } // end tempPortFree
      } else if (hasPrisma && project.port) {
        log(`Prisma 專案：跳過 Blue-Green（Windows DLL 鎖定需先關閉舊程序，已改用 Shadow Build）`);
      }

      // ========== Normal Deploy Path (Prisma projects or Blue-Green fallback) ==========
      if (!blueGreenCompleted) {
        log(`→ 使用標準部署（kill-restart）...`);
        // 先刪除舊的（如果有）
        if (project.companions && Array.isArray(project.companions)) {
          for (const companion of project.companions) {
            try {
              execSync(`pm2 delete ${project.pm2Name}-${companion.name}`, { stdio: 'pipe', windowsHide: true });
            } catch {}
          }
        }
        try {
          execSync(`pm2 delete ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
          if (!killedOldProcess) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        } catch (delErr) {
          // 忽略刪除錯誤
        }

        fs.writeFileSync(ecoPath, JSON.stringify(pm2EcoConfig, null, 2));
        execSync(`pm2 start "${ecoPath}"`, { stdio: 'pipe', cwd: projectDir, windowsHide: true });
        log(`PM2 啟動完成 (port: ${project.port || 'default'})`);

        // Health Check
        if (project.port) {
          log(`執行 Health Check (port: ${project.port})...`);
          const healthCheckPassed = await performHealthCheck(project.port, healthEndpoint, log, hcRetries, hcDelay);
          if (!healthCheckPassed) {
            if (backup) {
              log(`⚠ Health Check 失敗，自動回滾到 ${backup.commit}...`);
              try {
                execSync(`git reset --hard ${backup.commit}`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });
                for (const [envName, content] of Object.entries(envBackups)) {
                  fs.writeFileSync(path.join(projectDir, envName), content);
                }
                if (buildCmd) {
                  execSync(buildCmd, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
                }
                execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
                log(`✓ 自動回滾完成，舊版本已恢復`);
              } catch (rollbackErr) {
                log(`⚠ 自動回滾失敗: ${rollbackErr.message}`);
              }
            }
            throw new Error(`Health Check 失敗：服務未能在 port ${project.port} 啟動`);
          }
          log(`Health Check 通過`);
        }
      }

      // Spawn companion processes (bots, workers, etc.)
      if (project.companions && Array.isArray(project.companions)) {
        for (const companion of project.companions) {
          const compName = `${project.pm2Name}-${companion.name}`;
          const compCwd = companion.cwd
            ? path.join(projectDir, companion.cwd)
            : projectDir;

          // Auto-install Python dependencies if requirements.txt exists
          const isCompPython = companion.command === 'python' || companion.command === 'python3';
          if (isCompPython) {
            const pyCmd = getPythonCmd();
            const reqFile = path.join(compCwd, 'requirements.txt');
            if (!fs.existsSync(reqFile)) {
              // Also check parent project dir
              const parentReq = path.join(projectDir, 'requirements.txt');
              if (fs.existsSync(parentReq)) {
                try {
                  log(`安裝 Python 依賴 (${parentReq})...`);
                  execSync(`${pyCmd.pip} install -r "${parentReq}"`, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
                  log('Python 依賴安裝完成');
                } catch (e) {
                  log(`Python 依賴安裝失敗: ${e.message}`);
                }
              }
            } else {
              try {
                log(`安裝 Python 依賴 (${reqFile})...`);
                execSync(`${pyCmd.pip} install -r "${reqFile}"`, { cwd: compCwd, stdio: 'pipe', windowsHide: true, timeout: 300000 });
                log('Python 依賴安裝完成');
              } catch (e) {
                log(`Python 依賴安裝失敗: ${e.message}`);
              }
            }
          }

          if (companion.delay) {
            log(`等待 ${companion.delay}s 後啟動 ${compName}...`);
            await new Promise(r => setTimeout(r, companion.delay * 1000));
          }

          const compArgs = companion.args ? companion.args.join(' ') : '';
          log(`啟動 companion: ${compName} (${companion.command} ${compArgs})`);

          // Resolve actual command (python → full path on Windows)
          const compScript = isCompPython ? getPythonCmd().python : companion.command;
          const compEcoConfig = {
            apps: [{
              name: compName,
              script: compScript,
              cwd: compCwd,
              interpreter: isCompPython ? 'none' : undefined,
              env: pm2Env,
              autorestart: true,
              max_restarts: 5,
              ...(compArgs ? { args: compArgs } : {})
            }]
          };
          const compEcoPath = path.join(projectDir, `.pm2-companion-${companion.name}.json`);
          fs.writeFileSync(compEcoPath, JSON.stringify(compEcoConfig, null, 2));
          execSync(`pm2 start "${compEcoPath}"`, { stdio: 'pipe', windowsHide: true });
          log(`Companion ${compName} 已啟動`);
        }
      }
    }

    // 自動建立 DNS (Cloudflare Tunnel)
    const config = getConfig();
    const hostname = `${project.id}.${config.domain || 'localhost'}`;
    const cf = getCloudflared();
    if (cf.tunnelId) {
      try {
        execSync(`"${cf.path}" tunnel route dns ${cf.tunnelId} ${hostname}`, { stdio: 'ignore', windowsHide: true });
        log(`DNS 已建立: ${hostname}`);
      } catch (e) {
        log(`DNS 建立失敗（可能已存在）: ${e.message}`);
      }
    } else {
      log(`跳過 DNS 建立（未設定 cloudflared.tunnelId）`);
    }

    // 更新 Tunnel Ingress 規則
    if (project.port) {
      log(`更新 Tunnel Ingress: ${hostname} -> localhost:${project.port}`);
      updateTunnelIngress(hostname, project.port);
    }

    // Handle custom domains
    if (project.customDomains && Array.isArray(project.customDomains)) {
      for (const customDomain of project.customDomains) {
        log(`設定自訂網域: ${customDomain} -> localhost:${project.port}`);
        updateTunnelIngress(customDomain, project.port);
        // DNS route for custom domain
        if (cf.tunnelId) {
          try {
            execSync(`"${cf.path}" tunnel route dns ${cf.tunnelId} ${customDomain}`, { stdio: 'ignore', windowsHide: true });
            log(`DNS 已建立: ${customDomain}`);
          } catch (e) {
            log(`DNS 建立失敗（可能已存在）: ${e.message}`);
          }
        }
      }
    }

    // 更新部署狀態
    const finishedAt = new Date().toISOString();
    deployment.status = 'success';
    deployment.finishedAt = finishedAt;
    deployment.duration = new Date(finishedAt) - new Date(startedAt);
    deployment.logs = logs;

    log(`部署成功！耗時 ${deployment.duration}ms`);

    // Clean old backup tags (keep 5)
    cleanOldBackupTags(projectDir, projectId, 5);

  } catch (error) {
    const finishedAt = new Date().toISOString();
    deployment.status = 'failed';
    deployment.finishedAt = finishedAt;
    deployment.duration = new Date(finishedAt) - new Date(startedAt);
    deployment.error = error.message;
    log(`部署失敗: ${error.message}`);
    deployment.logs = logs;
  } finally {
    // Always release both locks
    deployLocks.delete(projectId);
    await distributedLock.release(`deploy:${projectId}`);
  }

  // 更新部署記錄
  db.updateDeployment(deployId, deployment);

  // 更新專案最後部署時間
  const projectUpdate = {
    lastDeployAt: deployment.finishedAt,
    lastDeployStatus: deployment.status,
    lastDeployCommit: deployment.commit // 嘗試部署的 commit
  };
  // 只有成功才更新 runningCommit
  if (deployment.status === 'success') {
    projectUpdate.runningCommit = deployment.commit;
  }
  updateProject(projectId, projectUpdate);

  // Emit deploy event for notifications (Telegram bot etc.)
  events.emit('deploy:complete', { project, deployment });

  // 通知其他機器有新部署（Redis sync）
  if (deployment.status === 'success') {
    try {
      const redis = require('./redis').getSharedClient();
      if (redis) {
        const syncKey = `PIPEE:deploy:${projectId}`;
        await redis.hset(syncKey, {
          commit: deployment.commit || '',
          machineId: require('./redis').getMachineId(),
          timestamp: new Date().toISOString(),
          triggeredBy: deployment.triggeredBy || 'unknown',
        });
        await redis.expire(syncKey, 600);
        log(`[sync] Redis 已通知其他機器`);
      }
    } catch (err) {
      log(`[sync] Redis 通知失敗: ${err.message}`);
    }
  }

  return deployment;
}

// ==================== 部署記錄 ====================

function getDeployments(projectId, limit = 20) {
  return db.getAllDeployments(projectId, limit);
}

function getDeployment(deployId) {
  return db.getDeployment(deployId);
}

// ==================== Webhook 驗證 ====================

function verifyGitHubWebhook(payload, signature, secret) {
  if (!signature || !secret) return false;
  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

// ==================== GitHub Webhook 自動設定 ====================

// 從 repoUrl 解析 owner/repo
function parseGitHubRepo(repoUrl) {
  // 支援格式：
  // https://github.com/owner/repo.git
  // https://github.com/owner/repo
  // git@github.com:owner/repo.git
  const httpsMatch = repoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  const sshMatch = repoUrl.match(/github\.com:([^\/]+)\/([^\/\.]+)/);
  const match = httpsMatch || sshMatch;
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace('.git', '') };
}

// 設定 GitHub Webhook
async function setupGitHubWebhook(projectId, webhookUrl) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`專案 "${projectId}" 不存在`);
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) {
    throw new Error(`無法解析 GitHub repo URL: ${project.repoUrl}`);
  }

  const { owner, repo } = parsed;
  const secret = project.webhookSecret;

  console.log(`[deploy] 設定 GitHub Webhook: ${owner}/${repo}`);

  try {
    // 使用 gh CLI 建立 webhook
    const webhookConfig = JSON.stringify({
      name: 'web',
      active: true,
      events: ['push'],
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret: secret,
        insecure_ssl: '0'
      }
    });

    const result = execSync(
      `gh api repos/${owner}/${repo}/hooks --method POST --input -`,
      {
        input: webhookConfig,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
    );

    const hookData = JSON.parse(result);
    console.log(`[deploy] Webhook 已建立: ID ${hookData.id}`);

    // 更新專案記錄
    updateProject(projectId, { webhookId: hookData.id });

    return { success: true, webhookId: hookData.id };
  } catch (error) {
    // 檢查是否是 webhook 已存在 (錯誤訊息可能在 stderr 或 message 中)
    const errorOutput = (error.stderr?.toString() || '') + (error.message || '');
    if (errorOutput.includes('Hook already exists') || errorOutput.includes('already exists')) {
      console.log(`[deploy] Webhook 已存在，跳過建立`);
      return { success: true, alreadyExists: true };
    }
    console.error(`[deploy] Webhook 設定失敗:`, errorOutput || error);
    throw new Error(errorOutput || error.message);
  }
}

// 刪除 GitHub Webhook
async function removeGitHubWebhook(projectId) {
  const project = getProject(projectId);
  if (!project || !project.webhookId) {
    return { success: false, error: '無 webhook 記錄' };
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) {
    return { success: false, error: '無法解析 repo URL' };
  }

  const { owner, repo } = parsed;

  try {
    execSync(
      `gh api repos/${owner}/${repo}/hooks/${project.webhookId} --method DELETE`,
      { stdio: 'pipe', windowsHide: true }
    );
    console.log(`[deploy] Webhook 已刪除: ID ${project.webhookId}`);
    updateProject(projectId, { webhookId: null });
    return { success: true };
  } catch (error) {
    console.error(`[deploy] Webhook 刪除失敗:`, error.message);
    return { success: false, error: error.message };
  }
}

// 列出專案的 GitHub Webhooks
function listGitHubWebhooks(projectId) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`專案 "${projectId}" 不存在`);
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) {
    throw new Error(`無法解析 GitHub repo URL`);
  }

  const { owner, repo } = parsed;

  try {
    const result = execSync(
      `gh api repos/${owner}/${repo}/hooks`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    return JSON.parse(result);
  } catch (error) {
    console.error(`[deploy] 取得 webhooks 失敗:`, error.message);
    return [];
  }
}

// ==================== GitHub 輪詢（Backup 機制）====================

/**
 * 檢查 GitHub 最新 commit（使用 gh CLI）
 */
function getGitHubLatestCommit(owner, repo, branch) {
  try {
    const result = execSync(
      `gh api repos/${owner}/${repo}/commits/${branch} --jq ".sha"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    return result.trim().substring(0, 7);
  } catch (e) {
    console.error(`[poll] 無法取得 ${owner}/${repo} 最新 commit:`, e.message);
    return null;
  }
}

/**
 * 檢查單一專案是否需要部署
 */
async function checkProjectForUpdates(project) {
  if (project.deployMethod !== 'github' && project.deployMethod !== 'git-url') {
    return null;
  }

  const parsed = parseGitHubRepo(project.repoUrl);
  if (!parsed) return null;

  const { owner, repo } = parsed;
  const remoteCommit = getGitHubLatestCommit(owner, repo, project.branch);

  if (!remoteCommit) return null;

  // 比較 remote 與已知 commit（runningCommit 或 lastDeployCommit）
  // runningCommit = 上次成功部署的 commit
  // lastDeployCommit = 上次嘗試部署的 commit（成功或失敗皆記錄）
  // 兩者都比較，避免失敗的部署被無限重試
  const deployedCommit = project.runningCommit || null;
  const lastAttempted = project.lastDeployCommit || null;

  if (remoteCommit !== deployedCommit && remoteCommit !== lastAttempted) {
    console.log(`[poll] Remote 有新 commit: ${project.id} (running: ${deployedCommit || 'none'}, lastAttempt: ${lastAttempted || 'none'}, remote: ${remoteCommit})`);
    return { project, localCommit: deployedCommit, remoteCommit };
  }

  return null;
}

/**
 * 輪詢所有專案檢查更新
 */
async function pollAllProjects() {
  const projects = getAllProjects();
  console.log(`[poll] 開始輪詢 ${projects.length} 個專案...`);

  for (const project of projects) {
    try {
      const update = await checkProjectForUpdates(project);
      if (update) {
        console.log(`[poll] 觸發部署: ${project.id}`);
        await deploy(project.id, { triggeredBy: 'poll' });
      }
    } catch (e) {
      console.error(`[poll] 檢查 ${project.id} 失敗:`, e.message);
    }
  }

  console.log(`[poll] 輪詢完成`);
}

// 輪詢定時器
let pollInterval = null;
let redisSyncInterval = null;

/**
 * Redis Sync Check — 檢查其他機器是否有新部署（每 30 秒）
 */
async function pollRedisSync() {
  let redis, machineId;
  try {
    redis = require('./redis').getSharedClient();
    machineId = require('./redis').getMachineId();
  } catch {
    return;
  }
  if (!redis) return;

  const projects = getAllProjects();

  for (const project of projects) {
    try {
      const syncKey = `PIPEE:deploy:${project.id}`;
      const syncData = await redis.hgetall(syncKey);

      if (!syncData || !syncData.commit) continue;
      if (syncData.machineId === machineId) continue; // 自己部署的，跳過

      // 檢查是否比本機新
      if (syncData.commit !== project.runningCommit) {
        console.log(`[sync] ${project.id}: ${syncData.machineId} deployed ${syncData.commit} (local: ${project.runningCommit || 'none'})`);
        await deploy(project.id, { triggeredBy: `sync:${syncData.machineId}` });
      }
    } catch (e) {
      console.error(`[sync] ${project.id} check failed:`, e.message);
    }
  }
}

/**
 * 啟動定時輪詢（GitHub 每 5 分鐘 + Redis sync 每 30 秒）
 */
function startPolling(intervalMs = 5 * 60 * 1000) {
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  console.log(`[poll] 啟動定時輪詢 (GitHub: ${intervalMs / 1000}s)`);

  // GitHub 輪詢
  setTimeout(() => pollAllProjects(), 10000);
  pollInterval = setInterval(pollAllProjects, intervalMs);

  // Redis sync（每 30 秒，輕量級）
  try {
    const redis = require('./redis').getSharedClient();
    if (redis) {
      redisSyncInterval = setInterval(pollRedisSync, 120000);
      console.log('[poll] Redis sync check every 120s');
    }
  } catch {
    // redis 未設定
  }
}

/**
 * 停止定時輪詢
 */
function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (redisSyncInterval) {
    clearInterval(redisSyncInterval);
    redisSyncInterval = null;
  }
  console.log(`[poll] 已停止定時輪詢`);
}

// ==================== Rollback ====================

/**
 * Tag current commit before deploy (for rollback)
 */
function tagCurrentDeploy(projectDir, projectId) {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: projectDir, windowsHide: true }).toString().trim();
    const tagName = `deploy-backup-${projectId}-${Date.now()}`;
    execSync(`git tag ${tagName}`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });
    return { tagName, commit };
  } catch {
    return null;
  }
}

/**
 * Clean old backup tags, keeping the most recent N
 */
function cleanOldBackupTags(projectDir, projectId, keep = 5) {
  try {
    const prefix = `deploy-backup-${projectId}-`;
    const output = execSync('git tag', { cwd: projectDir, windowsHide: true }).toString().trim();
    const tags = output.split('\n')
      .filter(t => t.startsWith(prefix))
      .sort(); // lexicographic = chronological (timestamp suffix)

    if (tags.length <= keep) return;

    const toDelete = tags.slice(0, tags.length - keep);
    for (const tag of toDelete) {
      try {
        execSync(`git tag -d ${tag}`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });
      } catch {}
    }
  } catch {}
}

/**
 * Rollback a project to a specific commit (or previous running commit)
 *
 * @param {string} projectId - Project ID
 * @param {string} [targetCommit] - Target commit hash (defaults to last runningCommit)
 * @param {object} [options] - Options
 * @param {string} [options.triggeredBy] - Who triggered the rollback
 * @returns {Promise<object>} Deployment result
 */
async function rollback(projectId, targetCommit, options = {}) {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found`);
  }

  const projectDir = resolveProjectDir(project);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`Project directory not found: ${projectDir}`);
  }

  // Determine target commit
  if (!targetCommit) {
    targetCommit = project.runningCommit;
  }
  if (!targetCommit) {
    throw new Error(`No target commit for rollback (no runningCommit recorded)`);
  }

  // Deploy lock (local + distributed)
  if (deployLocks.get(projectId)) {
    throw new Error('Deploy already in progress');
  }
  const gotDistributedLock = await distributedLock.acquire(`deploy:${projectId}`);
  if (!gotDistributedLock) {
    throw new Error('Deploy in progress on another machine');
  }
  deployLocks.set(projectId, Date.now());

  const deployId = generateDeployId();
  const startedAt = new Date().toISOString();
  const logs = [];
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    logs.push(`[${timestamp}] ${msg}`);
    console.log(`[rollback:${projectId}] ${msg}`);
  };

  const deployment = {
    id: deployId,
    projectId,
    status: 'building',
    commit: targetCommit,
    commitMessage: `Rollback to ${targetCommit}`,
    branch: project.branch,
    startedAt,
    finishedAt: null,
    duration: null,
    logs: [],
    triggeredBy: options.triggeredBy || 'rollback',
    error: null,
  };

  db.createDeployment(deployment);

  try {
    log(`Rolling back to commit: ${targetCommit}`);

    // Backup env files
    const ENV_PATTERNS = ['.env', '.env.local', '.env.production', '.env.production.local'];
    const envBackups = {};
    for (const envName of ENV_PATTERNS) {
      const envPath = path.join(projectDir, envName);
      if (fs.existsSync(envPath)) {
        envBackups[envName] = fs.readFileSync(envPath);
      }
    }

    // Reset to target commit
    execSync(`git fetch origin`, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 60000 });
    execSync(`git reset --hard ${targetCommit}`, { cwd: projectDir, stdio: 'pipe', windowsHide: true });
    log(`Git reset to ${targetCommit}`);

    // Restore env files
    for (const [envName, content] of Object.entries(envBackups)) {
      fs.writeFileSync(path.join(projectDir, envName), content);
    }

    // Detect package manager
    const pkgPath = path.join(projectDir, 'package.json');
    const hasPnpmLock = fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'));
    const hasYarnLock = fs.existsSync(path.join(projectDir, 'yarn.lock'));
    const pm = hasPnpmLock ? 'pnpm' : hasYarnLock ? 'yarn' : 'npm';

    // Clean Prisma cache before npm install (prevents EPERM on Windows)
    const prismaPath = path.join(projectDir, 'node_modules', '.prisma');
    if (fs.existsSync(prismaPath)) {
      log('Cleaning Prisma cache...');
      const dllPath = path.join(prismaPath, 'client', 'query_engine-windows.dll.node');
      const isDllLocked = () => {
        if (!fs.existsSync(dllPath)) return false;
        try { fs.accessSync(dllPath, fs.constants.W_OK); return false; } catch { return true; }
      };
      try {
        if (isDllLocked()) {
          log('Prisma DLL locked, waiting 2s...');
          await new Promise(r => setTimeout(r, 2000));
        }
        fs.rmSync(prismaPath, { recursive: true, force: true });
        log('Prisma cache cleaned');
      } catch (e1) {
        log(`Prisma cleanup failed (attempt 1): ${e1.message}`);
        await new Promise(r => setTimeout(r, 3000));
        try {
          fs.rmSync(prismaPath, { recursive: true, force: true });
          log('Prisma cache cleaned (attempt 2)');
        } catch (e2) {
          log(`Prisma cleanup failed (attempt 2): ${e2.message}, continuing...`);
        }
      }
    }

    // npm install
    if (fs.existsSync(pkgPath)) {
      const installCmd = getFastInstallCmd(pm, projectDir);
      log(`Running ${installCmd}...`);
      const installEnv = { ...process.env, NODE_ENV: 'development' };
      execSync(installCmd, { cwd: projectDir, stdio: 'pipe', windowsHide: true, env: installEnv });
      log('Dependencies installed');
    }

    // Build（buildSteps 優先，fallback 到 buildCommand）
    if (project.buildSteps?.length) {
      runBuildSteps(project.buildSteps, projectDir, log);
      log('Build complete');
    } else {
      let buildCmd = project.buildCommand;
      if (!buildCmd && fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts?.build) {
            const pmRun = pm === 'pnpm' ? 'pnpm run' : pm === 'yarn' ? 'yarn' : 'npm run';
            buildCmd = `${pmRun} build`;
          }
        } catch {}
      }
      if (buildCmd) {
        log(`Running build: ${buildCmd}`);
        execSync(buildCmd, { cwd: projectDir, stdio: 'pipe', windowsHide: true, timeout: 300000 });
        log('Build complete');
      }
    }

    // PM2 restart
    if (project.pm2Name) {
      try {
        execSync(`pm2 restart ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
        log(`PM2 restarted: ${project.pm2Name}`);
      } catch {
        execSync(`pm2 start ${project.pm2Name}`, { stdio: 'pipe', windowsHide: true });
        log(`PM2 started: ${project.pm2Name}`);
      }

      // Health check
      if (project.port) {
        log(`Health check on port ${project.port}...`);
        const healthEndpoint = project.healthEndpoint || '/health';
        const healthOk = await performHealthCheck(project.port, healthEndpoint, log);
        if (!healthOk) {
          throw new Error(`Health check failed on port ${project.port}`);
        }
        log('Health check passed');
      }

      // Restart companion processes
      if (project.companions && Array.isArray(project.companions)) {
        for (const companion of project.companions) {
          const compName = `${project.pm2Name}-${companion.name}`;
          try {
            execSync(`pm2 restart ${compName}`, { stdio: 'pipe', windowsHide: true });
            log(`Companion restarted: ${compName}`);
          } catch {
            log(`Companion ${compName} not running, skipping`);
          }
        }
      }
    }

    // Success
    const finishedAt = new Date().toISOString();
    deployment.status = 'success';
    deployment.finishedAt = finishedAt;
    deployment.duration = new Date(finishedAt) - new Date(startedAt);
    deployment.logs = logs;
    log(`Rollback successful (${deployment.duration}ms)`);

  } catch (error) {
    const finishedAt = new Date().toISOString();
    deployment.status = 'failed';
    deployment.finishedAt = finishedAt;
    deployment.duration = new Date(finishedAt) - new Date(startedAt);
    deployment.error = error.message;
    deployment.logs = logs;
    log(`Rollback failed: ${error.message}`);
  } finally {
    deployLocks.delete(projectId);
    await distributedLock.release(`deploy:${projectId}`);
  }

  db.updateDeployment(deployId, deployment);

  // Update project status
  const projectUpdate = {
    lastDeployAt: deployment.finishedAt,
    lastDeployStatus: deployment.status,
    lastDeployCommit: deployment.commit,
  };
  if (deployment.status === 'success') {
    projectUpdate.runningCommit = deployment.commit;
  }
  updateProject(projectId, projectUpdate);

  events.emit('deploy:complete', { project, deployment });

  return deployment;
}

// ==================== 匯出 ====================

module.exports = {
  // 專案管理
  getProject,
  getAllProjects,
  createProject,
  updateProject,
  deleteProject,

  // 部署
  deploy,
  getDeployments,
  getDeployment,

  // Webhook
  verifyGitHubWebhook,
  setupGitHubWebhook,
  removeGitHubWebhook,
  listGitHubWebhooks,
  parseGitHubRepo,

  // Port
  getNextAvailablePort,

  // 輪詢
  startPolling,
  stopPolling,
  pollAllProjects,
  checkProjectForUpdates,

  // Rollback
  rollback,

  // Events
  events
};
