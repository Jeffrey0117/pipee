/**
 * PIPEE Redis Singleton
 *
 * 兩個 client：
 *   getClient()       — 本機 Redis（redis.url），單機用途
 *   getSharedClient() — 跨機 Redis（redis.sharedUrl），多機協調專用
 *
 * 沒設 redis.url → getClient() 回傳 null，所有多機功能靜默停用。
 * sharedUrl 空 → fallback 用 url → 再 fallback null（單機模式）。
 */

const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config.json');

let client = null;
let sharedClient = null;
let initAttempted = false;
let sharedInitAttempted = false;

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function createRedisClient(redisUrl, label) {
  // Upstash 需要 TLS — 自動轉換 redis:// → rediss://
  if (redisUrl.includes('upstash.io') && redisUrl.startsWith('redis://')) {
    redisUrl = redisUrl.replace('redis://', 'rediss://');
  }

  try {
    const instance = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) return null;
        return Math.min(times * 500, 5000);
      },
      lazyConnect: false,
    });

    instance.on('connect', () => console.log(`[Redis:${label}] Connected`));
    instance.on('error', (err) => console.error(`[Redis:${label}] Error:`, err.message));

    return instance;
  } catch (err) {
    console.error(`[Redis:${label}] Failed to create client:`, err.message);
    return null;
  }
}

/**
 * 本機 Redis client（讀 redis.url）
 */
function getClient() {
  if (client) return client;
  if (initAttempted) return null;
  initAttempted = true;

  const config = getConfig();
  const redisUrl = config.redis?.url;

  if (!redisUrl) {
    console.log('[Redis] No redis.url configured, multi-machine features disabled');
    return null;
  }

  client = createRedisClient(redisUrl, 'local');
  return client;
}

/**
 * 跨機 Redis client（讀 redis.sharedUrl → fallback redis.url）
 * 所有跨機協調模組應使用此 client。
 */
function getSharedClient() {
  if (sharedClient) return sharedClient;
  if (sharedInitAttempted) return null;
  sharedInitAttempted = true;

  const config = getConfig();
  const sharedUrl = config.redis?.sharedUrl;
  const localUrl = config.redis?.url;
  const redisUrl = sharedUrl || localUrl;

  if (!redisUrl) {
    console.log('[Redis] No redis.sharedUrl or redis.url configured, cross-machine features disabled');
    return null;
  }

  // 如果 sharedUrl 和 localUrl 相同，共用同一個 client
  if (sharedUrl === localUrl || (!sharedUrl && localUrl)) {
    sharedClient = getClient();
    return sharedClient;
  }

  sharedClient = createRedisClient(redisUrl, 'shared');
  return sharedClient;
}

function getMachineId() {
  return getConfig().machineId || 'unknown';
}

async function shutdown() {
  const clients = new Set();
  if (client) clients.add(client);
  if (sharedClient && sharedClient !== client) clients.add(sharedClient);

  for (const c of clients) {
    try {
      await c.quit();
    } catch {
      // ignore
    }
  }

  client = null;
  sharedClient = null;
}

module.exports = { getClient, getSharedClient, getMachineId, shutdown };
