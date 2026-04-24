/**
 * Tunnel Watchdog
 *
 * 每 2 分鐘檢查 Cloudflare Tunnel 健康狀態：
 *   1. 快速檢查：connector count（本地，無網路）
 *   2. 深度檢查：外部 HTTP 探測（抓 stream 斷裂等問題）
 *   3. 連續 2 次失敗才重啟（避免誤殺）
 *   4. 3-tier escalation: never permanently gives up
 *      - Tier 1 (1-3): pm2 restart, 5 min cooldown
 *      - Tier 2 (4-6): pm2 delete+start, 15 min cooldown
 *      - Tier 3 (7+):  pm2 delete+start, 30 min cooldown, reset on success
 */

const { execSync } = require('child_process');
const path = require('path');
const { getTunnelInfo } = require('./tunnel-info');

const CHECK_INTERVAL = 2 * 60 * 1000;   // 2 分鐘
const PROBE_TIMEOUT = 10000;             // 外部探測 10 秒 timeout

let consecutiveFailures = 0;
let restartCount = 0;
let lastRestartAt = 0;
let lastNotifyAt = 0;
const NOTIFY_COOLDOWN = 60 * 60 * 1000;  // 最多 1 小時通知一次
let timer = null;

function getTier() {
  if (restartCount < 3) return 1;
  if (restartCount < 6) return 2;
  return 3;
}

function getCooldown() {
  const tier = getTier();
  if (tier === 1) return 5 * 60 * 1000;   // 5 min
  if (tier === 2) return 15 * 60 * 1000;  // 15 min
  return 30 * 60 * 1000;                   // 30 min
}

function isWatchdogNotifyEnabled() {
  try {
    const fs = require('fs');
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8')
    );
    return config.watchdogNotify !== false;
  } catch {}
  return true;
}

function getProbeUrl() {
  try {
    const fs = require('fs');
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8')
    );
    if (config.domain) return `https://${config.domain}/api/health`;
  } catch {}
  return '';
}

function getChatId() {
  try {
    const fs = require('fs');
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8')
    );
    return config.telegram?.chatId || '';
  } catch {}
  return '';
}

function notify(message) {
  if (!isWatchdogNotifyEnabled()) return;
  const now = Date.now();
  if (now - lastNotifyAt < NOTIFY_COOLDOWN) return;  // 1 小時內不重複
  lastNotifyAt = now;

  const chatId = getChatId();
  if (!chatId) return;
  try {
    const telegram = require('./telegram');
    telegram.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
  } catch {}
}

function restartTunnel(reason) {
  const now = Date.now();
  const cooldown = getCooldown();
  if (now - lastRestartAt < cooldown) return;

  lastRestartAt = now;
  restartCount++;
  consecutiveFailures = 0;
  const tier = getTier();

  console.log(`[tunnel-watchdog] Tier ${tier} restart (#${restartCount}): ${reason}`);

  try {
    if (tier === 1) {
      execSync('pm2 restart tunnel', { stdio: 'pipe', windowsHide: true });
    } else {
      // Tier 2/3: full delete + start for deeper recovery
      try { execSync('pm2 delete tunnel', { stdio: 'pipe', windowsHide: true }); } catch {}
      execSync('pm2 start ecosystem.config.js --only tunnel', {
        stdio: 'pipe',
        windowsHide: true,
        cwd: path.join(__dirname, '../..')
      });
    }
    console.log('[tunnel-watchdog] ✓ tunnel 已重啟');
  } catch (err) {
    console.error('[tunnel-watchdog] ✗ 重啟失敗:', err.message);
    notify(`🚨 <b>Tunnel Watchdog</b>\n${reason}\nTier ${tier} restart 失敗，需要人工處理`);
  }

  // Notification logic: notify on tier transitions and periodically in tier 3
  const shouldNotify =
    restartCount === 1 ||                    // First restart
    restartCount === 4 ||                    // Entering tier 2
    restartCount === 7 ||                    // Entering tier 3
    (tier === 3 && restartCount % 3 === 0);  // Every 3rd in tier 3

  if (shouldNotify) {
    notify(`⚠️ <b>Tunnel Watchdog</b>\nTier ${tier} 重啟 (#${restartCount})\n原因: ${reason}`);
  }
}

function markRecovered() {
  if (restartCount > 0) {
    console.log(`[tunnel-watchdog] ✓ tunnel 已恢復正常 (after ${restartCount} restarts)`);
    // Notify recovery if we were in tier 2+
    if (getTier() >= 2) {
      notify(`✅ <b>Tunnel Watchdog</b>\ntunnel 已恢復正常 (經過 ${restartCount} 次重啟)`);
    }
  }
  consecutiveFailures = 0;
  restartCount = 0;
}

function getState() {
  return {
    status: restartCount === 0 ? 'healthy' : 'recovering',
    tier: getTier(),
    restartCount,
    consecutiveFailures,
    lastRestartAt: lastRestartAt ? new Date(lastRestartAt).toISOString() : null,
  };
}

async function check() {
  // standby 模式時跳過
  try {
    const { getMode } = require('./tunnel-takeover');
    if (getMode() === 'standby') return;
  } catch {}

  // Phase 1: connector count（快速、本地）
  try {
    const info = getTunnelInfo();
    if (info.connectorCount === 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        restartTunnel('Connector count = 0');
      }
      return;
    }
  } catch {}

  // Phase 2: 外部 HTTP 探測（抓 stream 斷裂）
  const probeUrl = getProbeUrl();
  if (!probeUrl) {
    markRecovered();
    return;
  }

  try {
    const res = await fetch(probeUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      headers: { 'User-Agent': 'PIPEE-TunnelWatchdog/1.0' },
    });

    if (res.status === 502 || res.status === 503) {
      consecutiveFailures++;
      console.log(`[tunnel-watchdog] 探測失敗 (${res.status})，連續 ${consecutiveFailures} 次`);
      if (consecutiveFailures >= 2) {
        restartTunnel(`外部探測連續 ${consecutiveFailures} 次回傳 ${res.status}`);
      }
      return;
    }

    // 正常
    markRecovered();
  } catch (err) {
    consecutiveFailures++;
    console.log(`[tunnel-watchdog] 探測異常: ${err.message}，連續 ${consecutiveFailures} 次`);
    if (consecutiveFailures >= 2) {
      restartTunnel(`外部探測連續 ${consecutiveFailures} 次失敗: ${err.message}`);
    }
  }
}

function start() {
  if (timer) return;
  console.log('[tunnel-watchdog] 啟動（每 2 分鐘檢查）');
  timer = setInterval(check, CHECK_INTERVAL);
  setTimeout(check, 30000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[tunnel-watchdog] 已停止');
  }
}

module.exports = { start, stop, getState };
