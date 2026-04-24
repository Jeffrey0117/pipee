/**
 * Memory Watchdog
 *
 * 每 5 分鐘記錄 PM2 進程記憶體用量，保留最近 6 筆（30 分鐘趨勢窗口）。
 * 若記憶體持續上升且超過 max_memory_restart 的 80% → 搶先優雅重啟，
 * 避免 PM2 硬殺造成請求中斷。
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config.json');
const DEFAULT_MAX_MEMORY = 524288000; // 500MB
const RESTART_COOLDOWN = 10 * 60 * 1000; // 10 分鐘冷卻

// Map<processName, { samples: number[], maxMemory: number, lastRestartAt: number }>
const processMemory = new Map();
let timer = null;

function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

function getWatchdogConfig() {
  const cfg = getConfig().memoryWatchdog || {};
  return {
    enabled: cfg.enabled !== false,
    intervalMs: cfg.intervalMs || 300000,
    warningThresholdPercent: cfg.warningThresholdPercent || 80,
    sampleCount: cfg.sampleCount || 6,
  };
}

function notify(message) {
  try {
    const config = getConfig();
    const chatId = config.telegram?.chatId;
    if (!chatId) return;
    const telegram = require('./telegram');
    telegram.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
  } catch {}
}

function isTrendingUp(samples) {
  if (samples.length < 4) return false;
  const mid = Math.floor(samples.length / 2);
  const firstHalf = samples.slice(0, mid);
  const secondHalf = samples.slice(mid);
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  return avgSecond > avgFirst * 1.1; // 10% 增長視為上升趨勢
}

function formatMB(bytes) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

function collect() {
  const { warningThresholdPercent, sampleCount } = getWatchdogConfig();

  let processes;
  try {
    processes = JSON.parse(execSync('pm2 jlist', { windowsHide: true }).toString());
  } catch (err) {
    console.log('[memory-watchdog] pm2 jlist 失敗:', err.message);
    return;
  }

  for (const proc of processes) {
    const name = proc.name;
    const memBytes = proc.monit?.memory || 0;
    const maxMem = proc.pm2_env?.max_memory_restart || DEFAULT_MAX_MEMORY;

    if (!processMemory.has(name)) {
      processMemory.set(name, { samples: [], maxMemory: maxMem, lastRestartAt: 0 });
    }

    const entry = processMemory.get(name);
    entry.maxMemory = maxMem;
    entry.samples.push(memBytes);
    // 保留最近 sampleCount 筆
    if (entry.samples.length > sampleCount) {
      entry.samples = entry.samples.slice(-sampleCount);
    }

    const trending = isTrendingUp(entry.samples);
    const thresholdBytes = maxMem * (warningThresholdPercent / 100);

    if (trending && memBytes > thresholdBytes) {
      const now = Date.now();
      if (now - entry.lastRestartAt < RESTART_COOLDOWN) continue; // 冷卻中

      console.log(`[memory-watchdog] ${name} 記憶體上升趨勢 ${formatMB(memBytes)}/${formatMB(maxMem)}，搶先重啟`);
      try {
        execSync(`pm2 restart ${name}`, { windowsHide: true });
        entry.lastRestartAt = now;
        entry.samples = [];
        notify(
          `⚠️ <b>Memory Watchdog</b>\n` +
          `<b>${name}</b> 搶先重啟\n` +
          `用量: ${formatMB(memBytes)} / ${formatMB(maxMem)} (${warningThresholdPercent}%)\n` +
          `趨勢: 持續上升`
        );
      } catch (err) {
        console.log(`[memory-watchdog] ${name} 重啟失敗:`, err.message);
      }
    }
  }
}

function getState() {
  const result = {};
  for (const [name, entry] of processMemory) {
    const current = entry.samples[entry.samples.length - 1] || 0;
    result[name] = {
      current: formatMB(current),
      trend: isTrendingUp(entry.samples) ? 'rising' : 'stable',
      samples: entry.samples.length,
      maxMemory: formatMB(entry.maxMemory),
    };
  }
  return { processes: result };
}

function start() {
  if (timer) return;
  const { enabled, intervalMs } = getWatchdogConfig();
  if (!enabled) {
    console.log('[memory-watchdog] 已停用（config.memoryWatchdog.enabled = false）');
    return;
  }
  console.log(`[memory-watchdog] 啟動（每 ${intervalMs / 1000}s 取樣）`);
  timer = setInterval(collect, intervalMs);
  setTimeout(collect, 10000); // 10 秒後首次取樣
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[memory-watchdog] 已停止');
  }
}

module.exports = { start, stop, getState };
