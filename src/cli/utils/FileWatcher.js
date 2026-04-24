const chokidar = require('chokidar');
const path = require('path');
const chalk = require('chalk');

/**
 * 檔案監控器
 */
class FileWatcher {
  constructor(projectPath, options = {}) {
    this.projectPath = projectPath;
    this.options = {
      ignored: options.ignored || [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/out/**',
        '**/.cache/**',
        '**/logs/**',
        '**/*.log'
      ],
      ignoreInitial: true,
      persistent: true,
      ...options
    };
    this.watcher = null;
    this.onChangeCallback = null;
    this.debounceTimer = null;
    this.debounceDelay = options.debounceDelay || 1000;
  }

  /**
   * 開始監控
   */
  start(onChange) {
    // 驗證專案路徑
    if (!require('fs').existsSync(this.projectPath)) {
      throw new Error(`專案路徑不存在: ${this.projectPath}`);
    }

    this.onChangeCallback = onChange;

    try {
      this.watcher = chokidar.watch(this.projectPath, this.options);

      this.watcher
        .on('change', (filePath) => this.handleChange('changed', filePath))
        .on('add', (filePath) => this.handleChange('added', filePath))
        .on('unlink', (filePath) => this.handleChange('removed', filePath))
        .on('error', (error) => {
          console.error(chalk.red('監控錯誤:'), error.message);
          console.error(chalk.dim('提示: 檔案監控可能受到權限或系統限制影響'));
        })
        .on('ready', () => {
          console.log(chalk.dim('👀 檔案監控已啟動'));
          console.log(chalk.dim(`   監控目錄: ${this.projectPath}`));
          console.log('');
        });

      return this;
    } catch (err) {
      throw new Error(`啟動檔案監控失敗: ${err.message}`);
    }
  }

  /**
   * 處理檔案變動（帶 debounce）
   */
  handleChange(event, filePath) {
    const relativePath = path.relative(this.projectPath, filePath);

    // 清除舊的 timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // 設定新的 timer
    this.debounceTimer = setTimeout(() => {
      const eventColors = {
        changed: chalk.yellow,
        added: chalk.green,
        removed: chalk.red
      };

      const color = eventColors[event] || chalk.white;
      console.log(color(`  ⚡ ${event}: ${relativePath}`));

      if (this.onChangeCallback) {
        this.onChangeCallback(event, filePath, relativePath);
      }
    }, this.debounceDelay);
  }

  /**
   * 停止監控
   */
  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      console.log(chalk.dim('\n👋 檔案監控已停止'));
    }
  }

  /**
   * 取得監控狀態
   */
  isWatching() {
    return this.watcher !== null;
  }
}

module.exports = FileWatcher;
