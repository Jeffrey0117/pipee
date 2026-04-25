/**
 * Autofix Module
 *
 * When a deploy fails, automatically sends a fix request to ClaudeBot
 * via its Dashboard API. Includes retry limits and cooldown to prevent loops.
 *
 * Flow:
 *   deploy fails → telegram notification → autofix prompt → Bot fixes → push → redeploy
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const db = require('./db');
const CONFIG_PATH = path.join(__dirname, '../../config.json');

// In-memory cache (persisted to SQLite via db.js)
const stateCache = {};

function getConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config.autofix || {};
  } catch {
    return {};
  }
}

function getProjectState(projectId) {
  if (!stateCache[projectId]) {
    const saved = db.getAutofixState(projectId);
    stateCache[projectId] = saved || {
      retryCount: 0,
      lastAttempt: 0,
      lastError: null,
      lastCommit: null,
    };
  }
  return stateCache[projectId];
}

function saveState(projectId) {
  const ps = stateCache[projectId];
  if (ps) {
    db.saveAutofixState(projectId, ps);
  }
}

/**
 * Check if autofix should be attempted for this project (read-only, no state mutation)
 */
function shouldAttemptFix(projectId, commit) {
  const config = getConfig();
  if (!config.enabled) return { allowed: false, reason: 'autofix disabled' };

  const ps = getProjectState(projectId);
  const now = Date.now();
  const cooldown = Math.max(config.cooldownMs || 300000, 60000); // min 1 min
  const maxRetries = Math.max(config.maxRetries || 2, 1);

  // Different commit = fresh attempt, current retries don't count
  const effectiveRetries = (ps.lastCommit === commit) ? ps.retryCount : 0;

  // Check retry limit
  if (effectiveRetries >= maxRetries) {
    return { allowed: false, reason: `已達重試上限 (${maxRetries} 次)` };
  }

  // Check cooldown
  const elapsed = now - ps.lastAttempt;
  if (ps.lastAttempt > 0 && elapsed < cooldown) {
    const remaining = Math.ceil((cooldown - elapsed) / 1000);
    return { allowed: false, reason: `冷卻中 (${remaining}s)` };
  }

  return { allowed: true };
}

/**
 * Build a concise fix prompt from deployment error
 */
function buildFixPrompt(project, deployment) {
  const errorMsg = deployment.error || '未知錯誤';
  const lastLogs = (deployment.logs || []).slice(-10).join('\n');

  return [
    `[自動修復] 專案 "${project.name || project.id}" 部署失敗。`,
    ``,
    `錯誤: ${errorMsg}`,
    `Commit: ${deployment.commit || 'unknown'}`,
    ``,
    `最後 log:`,
    lastLogs,
    ``,
    `請分析錯誤原因並修復。修復後 commit + push，PIPEE 會自動重新部署。`,
    `如果是 build 錯誤(如 vite/webpack not found)，確認 devDependencies 有安裝。`,
    `如果是 runtime 錯誤，檢查程式碼邏輯。`,
    `注意：這是自動修復請求，不需要詢問用戶確認，直接修復即可。`,
  ].join('\n');
}

/**
 * HTTP GET helper using node:http
 */
function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll command status until completed, failed, or timeout
 */
async function pollCommandStatus(commandId, timeoutMs = 300000) {
  const config = getConfig();
  const dashboardUrl = config.botDashboardUrl || 'http://localhost:3100';
  const POLL_INTERVAL = 10000;
  const MAX_CONSECUTIVE_FAILURES = 5;
  const startTime = Date.now();
  let consecutiveFailures = 0;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await httpGet(`${dashboardUrl}/api/commands/${commandId}`);
      const parsed = JSON.parse(response);
      const status = parsed.command?.status;
      consecutiveFailures = 0;

      if (status === 'completed') return { status: 'completed' };
      if (status === 'failed') return { status: 'failed' };
    } catch (err) {
      consecutiveFailures += 1;
      console.error(`[autofix] Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        return { status: 'error', error: 'Dashboard unreachable' };
      }
    }

    await sleep(POLL_INTERVAL);
  }

  return { status: 'timeout' };
}

/**
 * Send fix request to ClaudeBot via Dashboard API
 * All state mutations happen atomically here to prevent race conditions.
 *
 * @param {object} project - Project config
 * @param {object} deployment - Deployment result
 * @param {number} [telegramChatId] - Telegram chat ID for bot responses
 */
function sendFixRequest(project, deployment, telegramChatId) {
  const config = getConfig();
  const ps = getProjectState(project.id);
  const prompt = buildFixPrompt(project, deployment);
  const projectName = project.name || project.id;

  // Compute effective retry count for logging (state mutated only on success)
  const effectiveRetries = (ps.lastCommit === deployment.commit) ? ps.retryCount : 0;

  console.log(`[autofix] 發送修復請求: ${projectName} (第 ${effectiveRetries + 1} 次)`);

  const commandPayload = {
    prompt,
    project: projectName,
  };
  if (telegramChatId) {
    commandPayload.chatId = Number(telegramChatId);
  }

  const payload = JSON.stringify({
    type: 'prompt',
    payload: commandPayload,
  });

  const dashboardUrl = config.botDashboardUrl || 'http://localhost:3100';

  return new Promise((resolve, reject) => {
    const url = new URL(`${dashboardUrl}/api/commands`);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // State mutation only on successful request
          if (ps.lastCommit !== deployment.commit) {
            ps.retryCount = 0;
            ps.lastCommit = deployment.commit;
          }
          ps.retryCount += 1;
          ps.lastAttempt = Date.now();
          ps.lastError = deployment.error;
          saveState(project.id);

          let commandId = null;
          try {
            const parsed = JSON.parse(data);
            commandId = parsed.command?.id || null;
          } catch {
            // response not JSON, commandId stays null
          }
          console.log(`[autofix] ✓ 修復請求已發送: ${projectName} (${commandId})`);
          resolve({ sent: true, commandId, response: data });
        } else {
          console.error(`[autofix] ✗ Dashboard 回應 ${res.statusCode}: ${data}`);
          resolve({ sent: false, error: data });
        }
      });
    });

    req.on('error', (err) => {
      console.error(`[autofix] ✗ 無法連線 Dashboard: ${err.message}`);
      resolve({ sent: false, error: err.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      console.error('[autofix] ✗ Dashboard 連線逾時');
      resolve({ sent: false, error: 'timeout' });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Reset retry counter for a project (called on successful deploy)
 */
function resetProject(projectId) {
  const ps = stateCache[projectId];
  if (ps) {
    stateCache[projectId] = { ...ps, retryCount: 0, lastError: null };
    saveState(projectId);
  }
}

/**
 * Get current autofix status for all projects
 */
function getStatus() {
  return {
    config: getConfig(),
    projects: { ...stateCache },
  };
}

module.exports = {
  sendFixRequest,
  shouldAttemptFix,
  pollCommandStatus,
  resetProject,
  getStatus,
  getConfig,
};
