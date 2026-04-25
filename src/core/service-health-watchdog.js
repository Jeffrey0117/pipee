/**
 * Service Health Watchdog
 *
 * 每 2 分鐘探測所有 PM2 online 專案的 healthEndpoint：
 *   1. HTTP GET localhost:{port}{healthEndpoint}
 *   2. 連續 3 次失敗 → 自動 pm2 restart
 *   3. 累計重啟 5 次 → 放棄自動修復，只通知
 *   4. 每次重啟後 5 分鐘冷卻期
 *   5. Telegram 通知（重啟 / 放棄）
 *   6. 暴露 getState() 給 dashboard API
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config.json');
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function getDefaults() {
  const cfg = getConfig().serviceWatchdog || {};
  return {
    enabled:        cfg.enabled !== false,
    intervalMs:     cfg.intervalMs     || 120000,
    failThreshold:  cfg.failThreshold  || 3,
    maxRestarts:    cfg.maxRestarts    || 5,
    cooldownMs:     cfg.cooldownMs     || 300000,
    timeoutMs:      cfg.timeoutMs      || 10000,
  };
}

// Per-project health tracking
const projectHealth = new Map();

function getEntry(id) {
  if (!projectHealth.has(id)) {
    projectHealth.set(id, {
      failCount: 0,
      restartCount: 0,
      lastRestartAt: 0,
      lastCheckAt: 0,
      status: 'healthy',
    });
  }
  return projectHealth.get(id);
}

// PM2 status map: { name: 'online' | 'stopped' | ... }
function getPm2StatusMap() {
  try {
    const output = execSync('pm2 jlist', { windowsHide: true }).toString();
    const processes = JSON.parse(output);
    const map = {};
    for (const proc of processes) {
      map[proc.name] = proc.pm2_env?.status || 'unknown';
    }
    return map;
  } catch {
    return {};
  }
}

// Telegram 通知
function notify(message) {
  const config = getConfig();
  const chatId = config.telegram?.chatId;
  if (!chatId) return;
  try {
    const telegram = require('./telegram');
    telegram.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
  } catch {}
}

// HTTP 探測單一專案
async function checkProject(project, pm2Status) {
  const settings = getDefaults();
  const pm2Name = project.pm2Name || project.id;
  const entry = getEntry(project.id);

  // 只探測 PM2 online 的專案
  if (pm2Status[pm2Name] !== 'online') return;

  // 已放棄的專案不再檢查
  if (entry.status === 'gave-up') return;

  // 冷卻期內跳過
  const now = Date.now();
  if (now - entry.lastRestartAt < settings.cooldownMs) return;

  const url = `http://localhost:${project.port}${project.healthEndpoint}`;
  let ok = false;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(settings.timeoutMs),
      headers: { 'User-Agent': 'PIPEE-ServiceWatchdog/1.0' },
    });
    // 任何非 5xx 回應都視為「服務活著」（401/403 = 有回應只是沒授權）
    ok = res.status < 500;
  } catch {
    ok = false;
  }

  const updated = { ...entry, lastCheckAt: now };

  if (ok) {
    // 恢復健康
    projectHealth.set(project.id, { ...updated, failCount: 0, status: 'healthy' });
    return;
  }

  // 探測失敗
  const newFailCount = updated.failCount + 1;
  console.log(`[service-watchdog] ${project.id} 探測失敗 (${newFailCount}/${settings.failThreshold})`);

  if (newFailCount < settings.failThreshold) {
    projectHealth.set(project.id, { ...updated, failCount: newFailCount, status: 'degraded' });
    return;
  }

  // 達到閾值 → 嘗試重啟
  if (updated.restartCount >= settings.maxRestarts) {
    // 只在首次進入 gave-up 時通知一次
    const wasGaveUp = updated.status === 'gave-up';
    projectHealth.set(project.id, { ...updated, failCount: newFailCount, status: 'gave-up' });
    if (!wasGaveUp) {
      console.log(`[service-watchdog] ${project.id} 已重啟 ${settings.maxRestarts} 次，放棄自動修復`);
      notify(
        `🚨 <b>Service Watchdog</b>\n` +
        `<b>${project.name || project.id}</b> 連續探測失敗\n` +
        `已重啟 ${settings.maxRestarts} 次仍未恢復，需要人工檢查`
      );
    }
    return;
  }

  restartProject(project, updated);
}

function restartProject(project, entry) {
  const pm2Name = project.pm2Name || project.id;
  const newRestartCount = entry.restartCount + 1;
  const now = Date.now();

  console.log(`[service-watchdog] 重啟 ${project.id} (${newRestartCount}/${getDefaults().maxRestarts})`);

  try {
    execSync(`pm2 restart ${pm2Name}`, { stdio: 'pipe', windowsHide: true });
    console.log(`[service-watchdog] ✓ ${project.id} 已重啟`);
  } catch (err) {
    console.error(`[service-watchdog] ✗ ${project.id} 重啟失敗:`, err.message);
  }

  projectHealth.set(project.id, {
    ...entry,
    failCount: 0,
    restartCount: newRestartCount,
    lastRestartAt: now,
    status: 'restarting',
  });

  // 只在第 1 次和最後 1 次重啟時通知，避免洗頻
  const maxR = getDefaults().maxRestarts;
  if (newRestartCount === 1 || newRestartCount === maxR) {
    notify(
      `⚠️ <b>Service Watchdog</b>\n` +
      `<b>${project.name || project.id}</b> 連續探測失敗，已自動重啟\n` +
      `重啟次數: ${newRestartCount}/${maxR}`
    );
  }
}

// 主迴圈：檢查所有有 healthEndpoint 的專案
async function checkAll() {
  const deploy = require('./deploy');
  const projects = deploy.getAllProjects().filter(p => p.healthEndpoint && p.port);
  const pm2Status = getPm2StatusMap();

  for (const project of projects) {
    try {
      await checkProject(project, pm2Status);
    } catch (err) {
      console.error(`[service-watchdog] ${project.id} 檢查異常:`, err.message);
    }
  }
}

// Dashboard API 用
function getState() {
  const deploy = require('./deploy');
  const projects = deploy.getAllProjects().filter(p => p.healthEndpoint && p.port);

  return {
    services: projects.map(p => {
      const entry = projectHealth.get(p.id) || {
        failCount: 0, restartCount: 0, lastCheckAt: 0, status: 'healthy',
      };
      return {
        name: p.id,
        status: entry.status,
        lastCheck: entry.lastCheckAt ? new Date(entry.lastCheckAt).toISOString() : null,
        failCount: entry.failCount,
        restartCount: entry.restartCount,
      };
    }),
  };
}

// 生命週期
let timer = null;

function start() {
  const settings = getDefaults();
  if (!settings.enabled) {
    console.log('[service-watchdog] 未啟用 (config.serviceWatchdog.enabled = false)');
    return;
  }
  if (timer) return;
  console.log(`[service-watchdog] 啟動（每 ${settings.intervalMs / 1000}s 檢查）`);
  timer = setInterval(checkAll, settings.intervalMs);
  // 首次延遲 30 秒，等專案啟動完
  setTimeout(checkAll, 30000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[service-watchdog] 已停止');
  }
}

module.exports = { start, stop, getState };
