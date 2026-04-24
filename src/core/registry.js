/**
 * 服務註冊中心
 * 統一管理所有服務的生命週期
 */

const fs = require('fs');
const path = require('path');

class ServiceRegistry {
  constructor() {
    this.services = [];
    this.servers = [];
    this.config = null;
    this.servicesDir = null;
  }

  /**
   * 載入設定
   */
  loadConfig(configPath) {
    this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return this.config;
  }

  /**
   * 掃描 services/ 目錄
   * 載入所有 .js 檔案（底線開頭的除外）
   */
  scanServices(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.servicesDir = dir;

    // 使用 router.js 作為主入口
    this.services.push({
      name: this.config.subdomain || 'api',
      entry: path.join(__dirname, 'router.js'),
      port: this.config.port,
      subdomain: this.config.subdomain,
      servicesDir: dir
    });
  }

  /**
   * 取得所有服務
   */
  getServices() {
    return this.services;
  }

  /**
   * 啟動所有服務
   */
  startAll() {
    if (this.services.length === 0) {
      console.log('[!] No services found');
      return false;
    }

    console.log(`[*] Starting ${this.services.length} service(s)...`);
    console.log('');

    this.services.forEach(service => {
      try {
        if (!fs.existsSync(service.entry)) {
          console.log(`[!] ${service.name}: Entry file not found: ${service.entry}`);
          return;
        }

        const createServer = require(service.entry);
        const server = createServer(service);

        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.error(`[!] ${service.name}: Port ${service.port} already in use`);
          } else {
            console.error(`[!] ${service.name}: Server error - ${err.message}`);
          }
        });

        server.listen(service.port, () => {
          console.log(`[OK] ${service.name}`);
          console.log(`     Type: ${service.type}`);
          console.log(`     Port: ${service.port}`);
          if (this.config.domain) {
            console.log(`     URL:  https://${service.subdomain}.${this.config.domain}`);
          }
          console.log('');
        });

        this.servers.push({ service, server });
      } catch (err) {
        console.log(`[!] ${service.name}: Failed to start - ${err.message}`);
      }
    });

    return true;
  }

  /**
   * 停止所有服務
   */
  stopAll() {
    this.servers.forEach(({ service, server }) => {
      if (server && server.listening) {
        server.close(() => {
          console.log(`[OK] ${service.name} stopped`);
        });
      }
    });
    this.servers = [];
  }

  /**
   * 取得服務狀態
   */
  getStatus() {
    return {
      total: this.services.length,
      running: this.servers.length,
      services: this.services.map(s => ({
        name: s.name,
        type: s.type,
        port: s.port,
        subdomain: s.subdomain
      }))
    };
  }
}

module.exports = ServiceRegistry;
