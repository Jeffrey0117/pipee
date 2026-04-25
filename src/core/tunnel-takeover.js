/**
 * Tunnel Takeover — Primary/Standby 模式
 *
 * 三種模式：
 *   shared   — 預設，不干預，允許所有 connector
 *   primary  — 每 60 秒清除非本機的 connector（用 machineId + Redis registry）
 *   standby  — 不啟動自己的 tunnel connector
 *
 * 改用 machineId + Redis connector registry 取代 IP 比對，解決 NAT 問題。
 */

const { execSync } = require('child_process');
const {
  getTunnelInfo,
  cleanupConnector,
  clearCache,
} = require('./tunnel-info');
const { getSharedClient, getMachineId } = require('./redis');

const ENFORCE_INTERVAL = 60 * 1000;
const CONNECTOR_REGISTRY_PREFIX = 'PIPEE:tunnel:connector:';
const CONNECTOR_TTL = 180;

let currentMode = 'shared';
let timer = null;
let lastEnforceAt = null;
let totalRemovedCount = 0;
let notifiedTakeover = false;
let enforcing = false;

const configWriter = require('./config-writer');

function getConfig() {
  return configWriter.readConfig();
}

function saveConfig(patch) {
  configWriter.updateConfig(patch).catch(err => {
    console.error('[tunnel-takeover] Config write failed:', err.message);
  });
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
 * 在 Redis 註冊自己的 connectorId（tunnel 啟動後呼叫）
 */
async function registerMyConnector() {
  const redis = getSharedClient();
  if (!redis) return;

  const machineId = getMachineId();

  // 從 tunnel info 找出自己的 connector
  clearCache();
  const info = getTunnelInfo();
  if (info.connectorCount === 0) return;

  // 把所有 connector 都註冊（正常只有一個）
  const connectorIds = info.connectors.map(c => c.id).filter(Boolean);
  if (connectorIds.length === 0) return;

  try {
    const key = CONNECTOR_REGISTRY_PREFIX + machineId;
    await redis.set(key, JSON.stringify(connectorIds), 'EX', CONNECTOR_TTL);
  } catch (err) {
    console.error('[tunnel-takeover] Failed to register connector:', err.message);
  }
}

/**
 * 從 Redis 讀取所有已註冊的 connectorId
 */
async function getRegisteredConnectors() {
  const redis = getSharedClient();
  if (!redis) return new Map();

  try {
    // SCAN for per-machine connector keys
    const result = new Map();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', CONNECTOR_REGISTRY_PREFIX + '*', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const mid = key.replace(CONNECTOR_REGISTRY_PREFIX, '');
        const val = await redis.get(key);
        if (val) {
          try {
            result.set(mid, JSON.parse(val));
          } catch {
            result.set(mid, [val]);
          }
        }
      }
    } while (cursor !== '0');
    return result;
  } catch {
    return new Map();
  }
}

/**
 * 執行一次清除：移除所有非本機 connector
 * 改用 machineId + Redis connector registry，不依賴 IP
 */
async function enforce() {
  if (enforcing) return { removed: 0, skipped: true };
  enforcing = true;

  try {
    const machineId = getMachineId();

    // 先註冊自己的 connector
    await registerMyConnector();

    // 清除 tunnel-info cache，確保拿到最新
    clearCache();

    const info = getTunnelInfo();
    lastEnforceAt = new Date().toISOString();

    if (info.connectorCount === 0) {
      return { removed: 0 };
    }

    // 從 Redis registry 取得所有已註冊的 connector
    const registry = await getRegisteredConnectors();
    const myConnectorIds = new Set(registry.get(machineId) || []);

    // 所有在 registry 中的 connectorId（任何機器的）
    const allRegistered = new Set();
    for (const ids of registry.values()) {
      for (const id of ids) {
        allRegistered.add(id);
      }
    }

    // 要清除的：不是自己的 connector
    const toRemove = info.connectors.filter(c => {
      if (!c.id) return false;
      // 保留自己的
      if (myConnectorIds.has(c.id)) return false;
      // 清除所有非自己的
      return true;
    });

    if (toRemove.length === 0) {
      return { removed: 0 };
    }

    let removed = 0;
    for (const conn of toRemove) {
      const ok = cleanupConnector(conn.id);
      if (ok) {
        removed++;
        totalRemovedCount++;
        console.log(`[tunnel-takeover] Cleaned up connector: ${conn.id}`);
      } else {
        console.log(`[tunnel-takeover] Failed to clean up: ${conn.id}`);
      }
    }

    // 首次搶成功時通知
    if (removed > 0 && !notifiedTakeover) {
      notifiedTakeover = true;
      notify(
        `🔒 <b>Tunnel Takeover</b>\n` +
        `<b>${machineId}</b> cleaned ${removed} foreign connector(s)`
      );
    }

    return { removed };
  } finally {
    enforcing = false;
  }
}

function startEnforceLoop() {
  stopEnforceLoop();
  enforce().catch(err => {
    console.error('[tunnel-takeover] enforce error:', err.message);
  });
  timer = setInterval(() => {
    enforce().catch(err => {
      console.error('[tunnel-takeover] enforce error:', err.message);
    });
  }, ENFORCE_INTERVAL);
}

function stopEnforceLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function stopTunnelProcess() {
  try {
    execSync('pm2 stop tunnel', { stdio: 'pipe', windowsHide: true });
    console.log('[tunnel-takeover] tunnel stopped (standby mode)');
  } catch (err) {
    console.error('[tunnel-takeover] Failed to stop tunnel:', err.message);
  }
}

/**
 * 啟動 takeover 模組
 * 從 config.json 讀取 tunnelMode，預設 shared
 */
function start() {
  const config = getConfig();
  currentMode = config.tunnelMode || 'shared';

  console.log(`[tunnel-takeover] Started, mode: ${currentMode}`);

  if (currentMode === 'primary') {
    startEnforceLoop();
  } else if (currentMode === 'standby') {
    stopTunnelProcess();
  }
}

function stop() {
  stopEnforceLoop();
  console.log('[tunnel-takeover] Stopped');
}

/**
 * 切換模式
 */
async function setMode(newMode) {
  if (!['shared', 'primary', 'standby'].includes(newMode)) {
    throw new Error(`Invalid mode: ${newMode}. Must be shared, primary, or standby.`);
  }

  const oldMode = currentMode;
  currentMode = newMode;

  saveConfig({ tunnelMode: newMode });

  console.log(`[tunnel-takeover] Mode changed: ${oldMode} -> ${newMode}`);

  notifiedTakeover = false;

  if (newMode === 'primary') {
    startEnforceLoop();
  } else if (newMode === 'shared') {
    stopEnforceLoop();
  } else if (newMode === 'standby') {
    stopEnforceLoop();
    stopTunnelProcess();
  }

  const machineId = getMachineId();
  notify(
    `⚙️ <b>Tunnel Mode Changed</b>\n` +
    `<b>${machineId}</b>: ${oldMode} -> ${newMode}`
  );

  return { oldMode, newMode };
}

/**
 * 取得目前狀態
 */
async function getStatus() {
  const info = getTunnelInfo();
  const registry = await getRegisteredConnectors();

  return {
    mode: currentMode,
    connectors: info.connectors,
    connectorCount: info.connectorCount,
    registry: Object.fromEntries(registry),
    lastEnforceAt,
    totalRemovedCount,
  };
}

/**
 * 取得目前模式
 */
function getMode() {
  return currentMode;
}

module.exports = {
  start,
  stop,
  enforce,
  setMode,
  getStatus,
  getMode,
  registerMyConnector,
  getRegisteredConnectors,
};
