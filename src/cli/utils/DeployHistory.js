const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 部署歷史管理
 */
class DeployHistory {
  constructor() {
    this.configDir = path.join(os.homedir(), '.pipee');
    this.historyFile = path.join(this.configDir, 'history.json');

    // 確保目錄存在
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * 讀取歷史記錄
   */
  load() {
    if (!fs.existsSync(this.historyFile)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.historyFile, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      console.error('讀取歷史記錄失敗:', err);
      return [];
    }
  }

  /**
   * 儲存歷史記錄
   */
  save(history) {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(history, null, 2));
    } catch (err) {
      console.error('儲存歷史記錄失敗:', err);
    }
  }

  /**
   * 新增部署記錄
   */
  add(record) {
    const history = this.load();

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      timestamp: Date.now(),
      date: new Date().toISOString(),
      name: record.name,
      path: record.path,
      type: record.type,
      framework: record.framework,
      port: record.port,
      url: record.url,
      status: record.status || 'success',
      error: record.error || null
    };

    history.unshift(entry);

    // 只保留最近 100 筆
    if (history.length > 100) {
      history.splice(100);
    }

    this.save(history);
    return entry;
  }

  /**
   * 取得指定專案的歷史
   */
  getByName(name) {
    const history = this.load();
    return history.filter(entry => entry.name === name);
  }

  /**
   * 取得最近的部署
   */
  getRecent(limit = 10) {
    const history = this.load();
    return history.slice(0, limit);
  }

  /**
   * 取得指定部署記錄
   */
  getById(id) {
    const history = this.load();
    return history.find(entry => entry.id === id);
  }

  /**
   * 清除歷史
   */
  clear() {
    this.save([]);
  }

  /**
   * 取得統計資訊
   */
  getStats() {
    const history = this.load();

    const stats = {
      total: history.length,
      success: history.filter(e => e.status === 'success').length,
      failed: history.filter(e => e.status === 'failed').length,
      projects: {}
    };

    // 統計各專案部署次數
    for (const entry of history) {
      if (!stats.projects[entry.name]) {
        stats.projects[entry.name] = 0;
      }
      stats.projects[entry.name]++;
    }

    return stats;
  }
}

module.exports = DeployHistory;
