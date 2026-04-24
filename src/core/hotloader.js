/**
 * 熱載入管理器
 * 讓 services 可以在運行時動態載入/更新
 */

const fs = require('fs');
const path = require('path');

// 儲存所有 routes（全局共享）
const routes = [];

/**
 * 載入單一服務
 */
function loadService(filePath) {
  const name = path.basename(filePath, '.js');

  // 清除 require cache
  delete require.cache[require.resolve(filePath)];

  try {
    const handler = require(filePath);

    // 檢查是否已存在，存在就更新
    const existingIndex = routes.findIndex(r => r.name === name);
    if (existingIndex >= 0) {
      routes[existingIndex].handler = handler;
      console.log(`[hotloader] 更新服務: ${name}`);
    } else {
      routes.push({ name, handler, filePath });
      console.log(`[hotloader] 載入服務: ${name}`);
    }

    return true;
  } catch (err) {
    console.error(`[hotloader] 載入失敗: ${name} - ${err.message}`);
    return false;
  }
}

/**
 * 移除服務
 */
function unloadService(name) {
  const index = routes.findIndex(r => r.name === name);
  if (index >= 0) {
    const route = routes[index];
    delete require.cache[require.resolve(route.filePath)];
    routes.splice(index, 1);
    console.log(`[hotloader] 移除服務: ${name}`);
    return true;
  }
  return false;
}

/**
 * 掃描並載入所有服務
 */
function loadAllServices(servicesDir) {
  if (!fs.existsSync(servicesDir)) return;

  fs.readdirSync(servicesDir)
    .filter(f => f.endsWith('.js') && !f.startsWith('_'))
    .forEach(file => {
      loadService(path.join(servicesDir, file));
    });
}

/**
 * 取得所有 routes
 */
function getRoutes() {
  return routes;
}

module.exports = {
  loadService,
  unloadService,
  loadAllServices,
  getRoutes
};
