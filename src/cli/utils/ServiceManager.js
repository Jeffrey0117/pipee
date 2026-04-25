const pm2 = require('pm2');
const path = require('path');

/**
 * PM2 服務管理器
 */
class ServiceManager {
  constructor() {
    this.connected = false;
  }

  /**
   * 連接 PM2
   */
  async connect() {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) {
          reject(err);
        } else {
          this.connected = true;
          resolve();
        }
      });
    });
  }

  /**
   * 斷開 PM2
   */
  disconnect() {
    if (this.connected) {
      pm2.disconnect();
      this.connected = false;
    }
  }

  /**
   * 啟動服務
   */
  async start(config) {
    // 驗證必要參數
    if (!config.name) throw new Error('專案名稱不能為空');
    if (!config.script) throw new Error('啟動指令不能為空');
    if (!config.cwd) throw new Error('專案路徑不能為空');
    if (!config.port) throw new Error('端口不能為空');

    await this.connect();

    try {
      // 檢查服務是否已存在
      const exists = await this.exists(config.name);
      if (exists) {
        throw new Error(`服務 '${config.name}' 已存在，請先停止或移除`);
      }

      // 確保 logs 目錄存在
      const logsDir = path.join(config.cwd, 'logs');
      if (!require('fs').existsSync(logsDir)) {
        require('fs').mkdirSync(logsDir, { recursive: true });
      }

      return new Promise((resolve, reject) => {
        // 解析啟動指令
        const [command, ...args] = config.script.split(' ');

        const pm2Config = {
          name: `PIPEE-${config.name}`,
          cwd: config.cwd,
          script: command,
          args: args.join(' '),
          env: {
            ...process.env,
            ...config.env,
            PORT: config.port
          },
          autorestart: true,
          max_restarts: 10,
          min_uptime: '10s',
          error_file: path.join(config.cwd, `logs/${config.name}-error.log`),
          out_file: path.join(config.cwd, `logs/${config.name}-out.log`),
          merge_logs: true
        };

        pm2.start(pm2Config, (err, apps) => {
          if (err) {
            reject(this.formatError(err, '啟動服務失敗'));
          } else {
            resolve({
              name: config.name,
              port: config.port,
              pid: apps[0].pm2_env.pm_id
            });
          }
        });
      });
    } catch (err) {
      throw err;
    }
  }

  /**
   * 檢查服務是否存在
   */
  async exists(name) {
    try {
      const services = await this.list();
      return services.some(s => s.name === name);
    } catch (err) {
      return false;
    }
  }

  /**
   * 停止服務
   */
  async stop(name) {
    await this.connect();

    try {
      // 檢查服務是否存在
      const exists = await this.exists(name);
      if (!exists) {
        throw new Error(`服務 '${name}' 不存在或未運行\n提示: 使用 'PIPEE list' 查看所有部署`);
      }

      return new Promise((resolve, reject) => {
        pm2.stop(`PIPEE-${name}`, (err) => {
          if (err) {
            reject(this.formatError(err, '停止服務失敗'));
          } else {
            resolve();
          }
        });
      });
    } catch (err) {
      throw err;
    }
  }

  /**
   * 重啟服務
   */
  async restart(name) {
    await this.connect();

    return new Promise((resolve, reject) => {
      pm2.restart(`PIPEE-${name}`, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * 移除服務
   */
  async remove(name) {
    await this.connect();

    try {
      // 檢查服務是否存在
      const exists = await this.exists(name);
      if (!exists) {
        throw new Error(`服務 '${name}' 不存在\n提示: 使用 'PIPEE list' 查看所有部署`);
      }

      return new Promise((resolve, reject) => {
        pm2.delete(`PIPEE-${name}`, (err) => {
          if (err) {
            reject(this.formatError(err, '移除服務失敗'));
          } else {
            resolve();
          }
        });
      });
    } catch (err) {
      throw err;
    }
  }

  /**
   * 列出所有服務
   */
  async list() {
    await this.connect();

    return new Promise((resolve, reject) => {
      pm2.list((err, list) => {
        if (err) {
          reject(err);
        } else {
          // 過濾出 PIPEE 的服務
          const services = list
            .filter(proc => proc.name.startsWith('PIPEE-'))
            .map(proc => ({
              name: proc.name.replace('PIPEE-', ''),
              status: proc.pm2_env.status,
              pid: proc.pid,
              port: proc.pm2_env.env.PORT,
              uptime: this.formatUptime(proc.pm2_env.pm_uptime),
              restarts: proc.pm2_env.restart_time
            }));

          resolve(services);
        }
      });
    });
  }

  /**
   * 查看日誌
   */
  async logs(name, options = {}) {
    const { spawn } = require('child_process');

    const args = ['logs', `PIPEE-${name}`];
    if (!options.follow) {
      args.push('--nostream');
      args.push('--lines', options.lines || 50);
    }

    const child = spawn('pm2', args, {
      stdio: 'inherit'
    });

    return new Promise((resolve, reject) => {
      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pm2 logs exited with code ${code}`));
        }
      });
    });
  }

  /**
   * 格式化運行時間
   */
  formatUptime(timestamp) {
    if (!timestamp) return 'N/A';

    const now = Date.now();
    const uptime = now - timestamp;
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  /**
   * 格式化錯誤訊息
   */
  formatError(err, context) {
    let message = context || '操作失敗';

    if (err.message) {
      // 提取有用的錯誤訊息
      if (err.message.includes('EADDRINUSE')) {
        const port = err.message.match(/:\d+/)?.[0]?.substring(1);
        message += `\n端口 ${port} 已被佔用，請嘗試:\n  1. 使用不同的端口: --port <其他端口>\n  2. 停止佔用端口的程序`;
      } else if (err.message.includes('ENOENT')) {
        message += `\n指令或檔案不存在，請檢查:\n  1. 是否已安裝相關依賴 (npm install)\n  2. package.json 中的 scripts 是否正確`;
      } else if (err.message.includes('EACCES')) {
        message += `\n權限不足，請嘗試:\n  1. 使用管理員權限運行\n  2. 檢查檔案權限`;
      } else {
        message += `\n${err.message}`;
      }
    }

    return new Error(message);
  }
}

module.exports = ServiceManager;
