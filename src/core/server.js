/**
 * PIPEE - API Tunnel Service
 * 主程式入口
 */

const path = require('path');
const ServiceRegistry = require('./registry');
const deploy = require('./deploy');
const gateway = require('./gateway');
const telegram = require('./telegram');
const heartbeat = require('./heartbeat');
const scheduler = require('./scheduler');
const tunnelWatchdog = require('./tunnel-watchdog');
const tunnelTakeover = require('./tunnel-takeover');
const tunnelElection = require('./tunnel-primary-election');
const redis = require('./redis');
const serviceHealthWatchdog = require('./service-health-watchdog');
const postDeployObserver = require('./post-deploy-observer');
const memoryWatchdog = require('./memory-watchdog');
const cleanup = require('./cleanup');

// 專案根目錄
const rootDir = path.join(__dirname, '..', '..');

// 建立服務註冊中心
const registry = new ServiceRegistry();

// 載入設定
const configPath = path.join(rootDir, 'config.json');
registry.loadConfig(configPath);

console.log('');
console.log('========================================');
console.log('  Pipee - Local Deploy Gateway');
console.log('========================================');
console.log('');

// 多機設定提示
const _cfg = registry.config || {};
if (!_cfg.machineId || !_cfg.redis?.url) {
  console.log('⚠️  多機功能未設定！請在 config.json 加入：');
  if (!_cfg.machineId) {
    console.log('   "machineId": "my-pc"        ← 給這台電腦取個名字');
  }
  if (!_cfg.redis?.url) {
    console.log('   "redis": { "url": "rediss://...@xxx.upstash.io:6379" }');
  }
  console.log('   設定後重啟即可啟用心跳、同步、Bot 選舉等功能');
  console.log('');
}

// 掃描服務 (services/*.js)
const servicesDir = path.join(rootDir, 'services');
registry.scanServices(servicesDir);

// 啟動所有服務
if (!registry.startAll()) {
  console.log('    Drop a .js file in services/ directory');
  process.exit(1);
}

// 啟動 Heartbeat（多機監控）
heartbeat.startHeartbeat();

// 啟動 GitHub 輪詢 + Redis sync（每 5 分鐘 GitHub / 每 30 秒 Redis）
deploy.startPolling(5 * 60 * 1000);

// 部署完成後重新載入 gateway tool cache
deploy.events.on('deploy:complete', () => {
  gateway.refreshTools().catch(err => {
    console.error('[gateway] Failed to refresh after deploy:', err.message);
  });
});

// 啟動 Telegram Bot（有 Redis → leader election / 沒有 → 看 config）
const redisClient = redis.getSharedClient();
const tgConfig = telegram.getConfig();
if (redisClient && tgConfig.enabled) {
  telegram.startWithLeaderElection();
} else if (tgConfig.polling !== false) {
  telegram.startBot();
} else {
  console.log('[Telegram] polling=false, notification-only mode');
  telegram.startNotificationsOnly();
}

// Custom bots: optional loading from config
const customBots = [];
const botsConfig = Array.isArray(registry.config?.bots) ? registry.config.bots : [];
for (const botCfg of botsConfig) {
  if (botCfg.enabled && botCfg.botPath) {
    try {
      const bot = require(botCfg.botPath);
      bot.startBot({ ...botCfg, telegramProxy: registry.config?.telegramProxy });
      customBots.push(bot);
    } catch (e) {
      console.log(`[Bot:${botCfg.name || 'unknown'}] Not found, skipping:`, e.message);
    }
  }
}

// 啟動 Scheduler（排程任務）
scheduler.start();

// 啟動 Tunnel Watchdog（每 2 分鐘檢查 tunnel 健康）
tunnelWatchdog.start();

// 啟動 Tunnel Primary Election（有 Redis → 自動 election / 沒有 → fallback config）
tunnelElection.start();

// 註冊 heartbeat 離線回呼 → 加速 tunnel failover
heartbeat.onMachineOffline((offlineId) => {
  tunnelElection.onMachineOffline(offlineId);
});

// 啟動 Service Health Watchdog（每 2 分鐘探測 health endpoint）
serviceHealthWatchdog.start();

// 啟動 Post-Deploy Observer（deploy 後觀察 5 分鐘）
postDeployObserver.start();

// 啟動 Memory Watchdog（每 5 分鐘監控記憶體趨勢）
memoryWatchdog.start();

// 啟動 Periodic Cleanup（每 6 小時清理）
cleanup.start();

// Graceful shutdown
const shutdown = async () => {
  console.log('');
  console.log('[*] Shutting down...');

  try {
    await heartbeat.stopHeartbeat();
    deploy.stopPolling();
    scheduler.stop();
    tunnelWatchdog.stop();
    serviceHealthWatchdog.stop();
    postDeployObserver.stop();
    memoryWatchdog.stop();
    cleanup.stop();
    await tunnelElection.stop();
    telegram.stopBot();
    for (const bot of customBots) bot.stopBot?.();

    // 等待伺服器完全關閉（給 3 秒時間）
    registry.stopAll();

    await redis.shutdown();
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('[*] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[*] Shutdown error:', err);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught exceptions to prevent crash loops
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  // Don't exit immediately, let the process continue
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit immediately, let the process continue
});

console.log('----------------------------------------');
console.log('Press Ctrl+C to stop all services');
console.log('----------------------------------------');
console.log('');

// Export for external use
module.exports = registry;
