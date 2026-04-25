/**
 * Tunnel Primary Election
 *
 * 用 Redis SET NX 做 primary election，自動協調哪台機器跑 tunnel。
 *
 * 算法：
 *   KEY = "PIPEE:tunnel:primary"
 *   TTL = 90s, REFRESH = 45s
 *
 *   每 45 秒：
 *     1. SET NX PIPEE:tunnel:primary {machineId} EX 90
 *     2. 成功 → 我是 primary：啟動 tunnel + enforce loop
 *     3. 失敗 → GET 看誰是 primary：
 *        - 是自己 → EXPIRE 續期
 *        - 是別人 → 切到 standby
 *
 * Failover 時間線：
 *   T=0:   A 掛了
 *   T=90s: A 的 Redis key 過期
 *   T=90~135s: B 的 SET NX 成功
 *   總 failover: ~90-135 秒（加速版 ~60 秒）
 */

const { execSync } = require('child_process');
const { getSharedClient, getMachineId } = require('./redis');
const tunnelTakeover = require('./tunnel-takeover');

const PRIMARY_KEY = 'PIPEE:tunnel:primary';
const PRIMARY_TTL = 90;
const REFRESH_INTERVAL = 45000;

let timer = null;
let isPrimary = false;
let notifiedPrimary = false;
let started = false;

function getConfig() {
  const configWriter = require('./config-writer');
  return configWriter.readConfig();
}

function getChatId() {
  return getConfig().telegram?.chatId || '';
}

function notify(message) {
  const chatId = getChatId();
  if (!chatId) return;
  try {
    const telegram = require('./telegram');
    telegram.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
  } catch {}
}

/**
 * 嘗試取得 / 續期 primary 資格
 */
async function tryAcquirePrimary() {
  const redis = getSharedClient();
  if (!redis) return false;

  const machineId = getMachineId();

  try {
    // Lua script: atomic SET NX + 可重入續期
    const luaScript = `
      local result = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
      if result then return 1 end
      local current = redis.call('GET', KEYS[1])
      if current == ARGV[1] then
        redis.call('EXPIRE', KEYS[1], ARGV[2])
        return 1
      end
      return 0
    `;
    const acquired = await redis.eval(luaScript, 1, PRIMARY_KEY, machineId, PRIMARY_TTL);
    return acquired === 1;
  } catch (err) {
    console.error('[tunnel-election] Election error:', err.message);
    return false;
  }
}

/**
 * 釋放 primary 資格
 */
async function releasePrimary() {
  const redis = getSharedClient();
  if (!redis) return;

  const machineId = getMachineId();
  try {
    const current = await redis.get(PRIMARY_KEY);
    if (current === machineId) {
      await redis.del(PRIMARY_KEY);
    }
  } catch {}
}

/**
 * 切換到 primary 模式
 */
function becomePrimary() {
  if (isPrimary) return;
  isPrimary = true;

  const machineId = getMachineId();
  console.log(`[tunnel-election] ${machineId} is now PRIMARY`);

  // 啟動 tunnel process（如果沒在跑）
  try {
    const output = execSync('pm2 jlist', { windowsHide: true, timeout: 5000 }).toString();
    const processes = JSON.parse(output);
    const tunnel = processes.find(p => p.name === 'tunnel');
    if (tunnel && tunnel.pm2_env?.status === 'stopped') {
      execSync('pm2 start tunnel', { stdio: 'pipe', windowsHide: true });
      console.log('[tunnel-election] tunnel process started');
    }
  } catch {}

  // 啟動 takeover enforce loop
  tunnelTakeover.setMode('primary').catch(err => {
    console.error('[tunnel-election] setMode(primary) failed:', err.message);
  });

  // 首次通知
  if (!notifiedPrimary) {
    notifiedPrimary = true;
    notify(
      `👑 <b>Tunnel Primary Election</b>\n` +
      `<b>${machineId}</b> elected as tunnel primary`
    );
  }
}

/**
 * 切換到 standby 模式
 */
function becomeStandby() {
  if (!isPrimary) return;
  isPrimary = false;
  notifiedPrimary = false;

  const machineId = getMachineId();
  console.log(`[tunnel-election] ${machineId} is now STANDBY`);

  tunnelTakeover.setMode('standby').catch(err => {
    console.error('[tunnel-election] setMode(standby) failed:', err.message);
  });
}

/**
 * Election loop：每 45 秒跑一次
 */
async function electionLoop() {
  const wasPrimary = isPrimary;
  const gotPrimary = await tryAcquirePrimary();

  if (gotPrimary) {
    becomePrimary();
  } else if (wasPrimary) {
    // 失去 primary 資格
    becomeStandby();
  }
  // 如果本來就不是 primary 且沒取得，維持 standby 不動
}

/**
 * 取得目前 primary 是誰
 */
async function getCurrentPrimary() {
  const redis = getSharedClient();
  if (!redis) return null;

  try {
    return await redis.get(PRIMARY_KEY);
  } catch {
    return null;
  }
}

/**
 * 加速 failover：heartbeat 偵測到機器離線時呼叫
 * 用 Lua script 確保只刪掉該機器的 primary key
 */
async function onMachineOffline(offlineMachineId) {
  const redis = getSharedClient();
  if (!redis) return;

  try {
    const luaScript = `
      local current = redis.call('GET', KEYS[1])
      if current == ARGV[1] then
        redis.call('DEL', KEYS[1])
        return 1
      end
      return 0
    `;
    const result = await redis.eval(luaScript, 1, PRIMARY_KEY, offlineMachineId);
    if (result === 1) {
      console.log(`[tunnel-election] Cleared stale primary key for offline machine: ${offlineMachineId}`);
      // 立即跑一次 election
      await electionLoop();
    }
  } catch (err) {
    console.error('[tunnel-election] onMachineOffline error:', err.message);
  }
}

/**
 * 啟動 election 模組
 */
function start() {
  if (started) return;

  const redis = getSharedClient();
  if (!redis) {
    console.log('[tunnel-election] No shared Redis, falling back to config-based tunnel mode');
    started = true;
    tunnelTakeover.start();
    return;
  }

  started = true;

  const machineId = getMachineId();
  console.log(`[tunnel-election] Started (${machineId}, refresh every ${REFRESH_INTERVAL / 1000}s)`);

  // 立即跑第一次
  electionLoop().catch(err => {
    console.error('[tunnel-election] Initial election error:', err.message);
  });

  timer = setInterval(() => {
    electionLoop().catch(err => {
      console.error('[tunnel-election] Election loop error:', err.message);
    });
  }, REFRESH_INTERVAL);
}

/**
 * 停止 election 模組
 */
async function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (isPrimary) {
    await releasePrimary();
  }

  tunnelTakeover.stop();
  started = false;
  isPrimary = false;
  console.log('[tunnel-election] Stopped');
}

/**
 * 取得狀態
 */
async function getStatus() {
  const currentPrimary = await getCurrentPrimary();
  return {
    isPrimary,
    currentPrimary,
    machineId: getMachineId(),
    started,
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  getCurrentPrimary,
  onMachineOffline,
  isPrimary: () => isPrimary,
};
