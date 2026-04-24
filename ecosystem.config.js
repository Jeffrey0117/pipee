const fs = require('fs');
const path = require('path');

// ── Shared env from config.json ──
let sharedEnv = {};
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  if (config.telegramProxy) {
    sharedEnv.TELEGRAM_PROXY = config.telegramProxy;
  }
} catch {}

// ── Auto-inject PYTHON_PATH (cross-platform) ──
try {
  const { execSync } = require('child_process');
  let pythonExec = null;
  try {
    pythonExec = execSync('where py', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim().split('\n')[0].trim();
  } catch {}
  if (!pythonExec) {
    try {
      execSync('python3 --version', { stdio: 'pipe', windowsHide: true });
      pythonExec = 'python3';
    } catch {}
  }
  if (!pythonExec) pythonExec = 'python';
  sharedEnv.PYTHON_PATH = pythonExec;
} catch {}

// ── Load .env file for a project directory ──
function loadEnv(relativeDir) {
  const envPath = path.join(__dirname, relativeDir, '.env');
  const env = {};
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx);
        const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, '');
        env[key] = val;
      }
    }
  } catch {}
  return env;
}

// ── PM2 defaults for sub-projects ──
const LOGS_DIR = path.join(__dirname, 'logs');

function projectDefaults(name, opts = {}) {
  return {
    autorestart: true,
    max_restarts: 5,
    min_uptime: opts.min_uptime || '5s',
    error_file: path.join(LOGS_DIR, `${name}-error.log`),
    out_file: path.join(LOGS_DIR, `${name}-out.log`),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true
  };
}

// ── Resolve Python path (cross-platform) ──
function resolvePython() {
  const { execSync } = require('child_process');
  try {
    return execSync('where py', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }).trim().split('\n')[0].trim();
  } catch {}
  try {
    execSync('python3 --version', { stdio: 'pipe', windowsHide: true });
    return 'python3';
  } catch {}
  return 'python';
}

let _pythonPath = null;

// ── Resolve runner to PM2 script/args ──
function resolveRunner(project) {
  const runner = project.runner || 'node';

  switch (runner) {
    case 'next':
      return {
        script: 'node_modules/next/dist/bin/next',
        args: `start -p ${project.port}`,
      };
    case 'tsx':
      return {
        script: 'node_modules/tsx/dist/cli.mjs',
        args: project.entryFile,
      };
    case 'python': {
      if (!_pythonPath) _pythonPath = resolvePython();
      return {
        script: _pythonPath,
        args: `-m uvicorn ${project.entryFile} --host 0.0.0.0 --port ${project.port}`,
        interpreter: 'none',
      };
    }
    case 'node':
    default:
      return {
        script: `./${project.entryFile || 'server.js'}`,
        args: undefined,
      };
  }
}

// ── Build apps list dynamically ──
const apps = [
  // ── Pipee (core) ──
  {
    name: 'pipee',
    script: './index.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    max_memory_restart: '500M',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    kill_timeout: 8000,
    wait_ready: false,
    listen_timeout: 15000,
    restart_delay: 5000,
    env: {
      NODE_ENV: 'production',
      ...sharedEnv
    }
  }
];

// ── Read projects from SQLite ──
try {
  const db = require('./src/core/db');
  const projects = db.getAllProjects();

  for (const project of projects) {
    const projectDir = path.resolve(__dirname, project.directory);

    // Skip projects that haven't been cloned yet
    if (!fs.existsSync(projectDir)) continue;

    // Skip library-only projects (no PM2 process needed)
    if (project.noServer) continue;

    const { script, args, interpreter } = resolveRunner(project);

    // Skip if entry script doesn't exist
    const scriptPath = path.resolve(projectDir, project.startCwd || '', script);
    if (!fs.existsSync(scriptPath)) continue;

    const effectiveCwd = project.startCwd ? path.join(projectDir, project.startCwd) : projectDir;

    const entry = {
      name: project.pm2Name || project.id,
      script,
      cwd: effectiveCwd,
      ...projectDefaults(project.pm2Name || project.id),
      env: {
        NODE_ENV: 'production',
        PORT: project.port,
        ...sharedEnv,
        ...loadEnv(project.directory)
      }
    };

    if (args) entry.args = args;
    if (interpreter) entry.interpreter = interpreter;

    apps.push(entry);

    // ── Companion processes ──
    if (Array.isArray(project.companions)) {
      for (const comp of project.companions) {
        const compCwd = comp.cwd ? path.join(projectDir, comp.cwd) : projectDir;
        const compName = `${project.id}-${comp.name}`;

        const isCompPython = comp.command === 'python' || comp.command === 'python3';
        let compScript = comp.command;
        let compInterpreter;
        if (isCompPython) {
          if (!_pythonPath) _pythonPath = resolvePython();
          compScript = _pythonPath;
          compInterpreter = 'none';
        }

        const compEntry = {
          name: compName,
          script: compScript,
          args: comp.args,
          cwd: compCwd,
          ...projectDefaults(compName),
          env: {
            NODE_ENV: 'production',
            PORT: project.port,
            ...sharedEnv,
            ...loadEnv(project.directory),
            ...(comp.cwd ? loadEnv(path.join(project.directory, comp.cwd)) : {})
          }
        };
        if (compInterpreter) compEntry.interpreter = compInterpreter;
        apps.push(compEntry);
      }
    }
  }
} catch (err) {
  console.error('[ecosystem] Failed to load projects:', err.message);
}

module.exports = { apps };

// ── Cloudflared Tunnel (conditional) ──
try {
  const cfConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const cfPath = cfConfig.cloudflared?.path || 'cloudflared';
  const cfYml = path.join(__dirname, 'cloudflared.yml');
  if (fs.existsSync(cfYml)) {
    module.exports.apps.push({
      name: 'tunnel',
      script: cfPath,
      args: `tunnel --config ${cfYml} run`,
      interpreter: 'none',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
      error_file: 'logs/tunnel-error.log',
      out_file: 'logs/tunnel-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    });
  }
} catch {}
