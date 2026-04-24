/**
 * Periodic Cleanup — 每 6 小時執行例行清理
 *
 * - Flush PM2 logs
 * - 清理 >7 天的 deploy 備份
 * - 清理 Redis 裡殘留的 deploy lock（安全網）
 * - 清理 >1 天的暫存檔
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PIPEE_ROOT = path.join(__dirname, '../..');
const INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const BACKUP_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const TMP_MAX_AGE = 24 * 60 * 60 * 1000; // 1 day

let timer = null;
let lastRunAt = null;
let lastResult = null;

function cleanOldEntries(dir, maxAge) {
  if (!fs.existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAge;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtime.getTime() < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch { /* skip entries we can't stat/remove */ }
  }
  return removed;
}

async function runOnce() {
  const results = { startedAt: new Date().toISOString(), tasks: {} };

  // 1. Flush PM2 logs
  try {
    execSync('pm2 flush', { stdio: 'pipe', windowsHide: true });
    results.tasks.pm2Flush = { success: true };
    console.log('[cleanup] PM2 logs flushed');
  } catch (err) {
    results.tasks.pm2Flush = { success: false, error: err.message };
  }

  // 2. Clean old backups (> 7 days)
  try {
    const removed = cleanOldEntries(path.join(PIPEE_ROOT, 'backups'), BACKUP_MAX_AGE);
    results.tasks.backups = { success: true, removed };
    if (removed) console.log(`[cleanup] Removed ${removed} old backup(s)`);
  } catch (err) {
    results.tasks.backups = { success: false, error: err.message };
  }

  // 3. Clean stale Redis deploy locks（安全網，TTL 本應處理）
  try {
    const redis = require('./redis').getClient();
    if (redis) {
      const keys = await redis.keys('PIPEE:lock:deploy:*');
      if (keys.length) {
        await redis.del(...keys);
        console.log(`[cleanup] Removed ${keys.length} stale deploy lock(s)`);
      }
      results.tasks.redisLocks = { success: true, removed: keys.length };
    } else {
      results.tasks.redisLocks = { success: true, skipped: 'no redis' };
    }
  } catch (err) {
    results.tasks.redisLocks = { success: false, error: err.message };
  }

  // 4. Clean temp files (> 1 day)
  try {
    const removed = cleanOldEntries(path.join(PIPEE_ROOT, 'tmp'), TMP_MAX_AGE);
    results.tasks.tmpFiles = { success: true, removed };
    if (removed) console.log(`[cleanup] Removed ${removed} old temp file(s)`);
  } catch (err) {
    results.tasks.tmpFiles = { success: false, error: err.message };
  }

  results.finishedAt = new Date().toISOString();
  lastRunAt = results.finishedAt;
  lastResult = results;
  console.log('[cleanup] Cleanup complete:', JSON.stringify(results.tasks));
  return results;
}

function getState() {
  return {
    lastRun: lastRunAt,
    nextRun: timer ? new Date(Date.now() + INTERVAL).toISOString() : null,
    lastResult,
  };
}

function start() {
  if (timer) return;
  console.log('[cleanup] 啟動（每 6 小時清理）');
  timer = setInterval(runOnce, INTERVAL);
  // 啟動後 5 分鐘才跑第一次，避免干擾啟動流程
  setTimeout(runOnce, 5 * 60 * 1000);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[cleanup] 已停止');
  }
}

module.exports = { start, stop, runOnce, getState };
