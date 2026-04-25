/**
 * Distributed Lock via Redis
 *
 * 跨機 deploy lock，用 Redis SET NX 實現。
 * Redis 不可用 → return true（graceful degradation，退化到單機模式）。
 */

const { getSharedClient, getMachineId } = require('./redis');

class DistributedLock {
  /**
   * 嘗試取得 lock
   * @param {string} key - lock key (e.g. 'deploy:my-app')
   * @param {number} ttl - TTL in seconds (default 1800 = 30 min)
   * @returns {Promise<boolean>} true = acquired, false = held by another
   */
  async acquire(key, ttl = 1800) {
    const redis = getSharedClient();
    if (!redis) return true; // Redis 不可用 → 單機模式，直接放行

    const machineId = getMachineId();
    const lockKey = `PIPEE:lock:${key}`;

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
      const acquired = await redis.eval(luaScript, 1, lockKey, machineId, ttl);
      return acquired === 1;
    } catch (err) {
      console.error(`[DistributedLock] acquire(${key}) error:`, err.message);
      return true; // Redis 錯誤 → 退化到單機模式
    }
  }

  /**
   * 釋放 lock（只有持有者能釋放）
   * @param {string} key - lock key
   */
  async release(key) {
    const redis = getSharedClient();
    if (!redis) return;

    const machineId = getMachineId();
    const lockKey = `PIPEE:lock:${key}`;

    try {
      // Lua script: 只刪自己的 lock
      const luaScript = `
        local current = redis.call('GET', KEYS[1])
        if current == ARGV[1] then
          redis.call('DEL', KEYS[1])
          return 1
        end
        return 0
      `;
      await redis.eval(luaScript, 1, lockKey, machineId);
    } catch (err) {
      console.error(`[DistributedLock] release(${key}) error:`, err.message);
    }
  }
}

module.exports = new DistributedLock();
