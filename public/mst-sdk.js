/**
 * MST - MySpeedTest SDK
 * 真正理解你網速的測速工具
 *
 * @version 1.0.0
 * @license MIT
 * @see https://myspeedtest.app
 *
 * @example
 * const mst = new MST();
 * mst.on('progress', ({ speed }) => console.log(speed.value, speed.unit));
 * const result = await mst.run();
 */

class MST {
  static VERSION = '1.0.0';
  static NAME = 'MySpeedTest';

  /**
   * 建立 MST 實例
   * @param {Object} options - 配置選項
   * @param {string} options.apiEndpoint - 後端 API 端點（預設: '/api/mst'）
   * @param {number} options.duration - 測速時間（毫秒，預設: 10000）
   * @param {number} options.maxConnections - 最大並行連線數（預設: 3）
   * @param {number} options.chunkSize - 下載區塊大小（預設: 524288 = 512KB）
   * @param {number} options.updateInterval - 更新間隔（毫秒，預設: 100）
   */
  constructor(options = {}) {
    this.config = {
      apiEndpoint: options.apiEndpoint || 'https://api.yourdomain.com/mst',
      duration: options.duration || 10000,
      maxConnections: options.maxConnections || 3,
      chunkSize: options.chunkSize || 524288,
      updateInterval: options.updateInterval || 100,
    };

    this._listeners = {};
    this._isRunning = false;
    this._abortController = null;
  }

  /**
   * 註冊事件監聽器
   * @param {string} event - 事件名稱 ('start' | 'progress' | 'complete' | 'error')
   * @param {Function} callback - 回調函數
   * @returns {MST} this（支援鏈式呼叫）
   */
  on(event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
    return this;
  }

  /**
   * 移除事件監聽器
   * @param {string} event - 事件名稱
   * @param {Function} callback - 要移除的回調函數
   * @returns {MST} this
   */
  off(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
    }
    return this;
  }

  /**
   * 觸發事件
   * @private
   */
  _emit(event, data) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(cb => cb(data));
    }
  }

  /**
   * 速度轉換（FAST 原版邏輯）
   * @param {number} speedBps - 速度（bits per second）
   * @returns {Object} { value: number, unit: string, raw: number }
   */
  static formatSpeed(speedBps) {
    let speedMbps = speedBps / 1e6 || 0;
    let unit = 'Mbps';

    if (speedMbps < 1) {
      speedMbps *= 1e3;
      unit = 'Kbps';
    } else if (speedMbps >= 995) {
      speedMbps /= 1e3;
      unit = 'Gbps';
    }

    const value = speedMbps < 9.95
      ? Math.round(speedMbps * 10) / 10
      : speedMbps < 100
        ? Math.round(speedMbps)
        : Math.round(speedMbps / 10) * 10;

    return { value, unit, raw: speedBps };
  }

  /**
   * 取得測速節點
   * @private
   */
  async _getTargets() {
    const response = await fetch(`${this.config.apiEndpoint}/targets`);
    if (!response.ok) {
      throw new Error(`無法取得測速節點: ${response.status}`);
    }
    const data = await response.json();
    if (!data.targets || data.targets.length === 0) {
      throw new Error('沒有可用的測速節點');
    }
    return data.targets;
  }

  /**
   * 單一連線下載迴圈
   * @private
   */
  async _downloadLoop(url, deadline, counter, signal) {
    const range = `bytes=0-${this.config.chunkSize - 1}`;

    while (performance.now() < deadline && !signal.aborted) {
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          headers: { Range: range },
          signal,
        });
        const buf = await res.arrayBuffer();
        counter.bytes += buf.byteLength;
      } catch (e) {
        if (e.name === 'AbortError') break;
        console.warn('下載區塊失敗:', e);
      }
    }
  }

  /**
   * 執行測速
   * @returns {Promise<SpeedTestResult>} 測速結果
   */
  async run() {
    if (this._isRunning) {
      throw new Error('測速正在進行中');
    }

    this._isRunning = true;
    this._abortController = new AbortController();
    const signal = this._abortController.signal;

    try {
      // 開始事件
      this._emit('start', { timestamp: Date.now() });

      // 取得節點
      const targets = await this._getTargets();
      const activeTargets = targets.slice(0, this.config.maxConnections);

      this._emit('targets', {
        targets: activeTargets,
        count: activeTargets.length,
      });

      // 準備計時
      const startTime = performance.now();
      const deadline = startTime + this.config.duration;
      const counter = { bytes: 0 };

      // 進度更新
      const progressInterval = setInterval(() => {
        const elapsed = (performance.now() - startTime) / 1000;
        const progress = Math.min(elapsed / (this.config.duration / 1000), 1);
        const speedBps = elapsed > 0 ? (counter.bytes * 8) / elapsed : 0;
        const formatted = MST.formatSpeed(speedBps);

        this._emit('progress', {
          progress,
          elapsed,
          bytes: counter.bytes,
          speed: formatted,
        });
      }, this.config.updateInterval);

      // 平行下載
      await Promise.all(
        activeTargets.map(t => this._downloadLoop(t.url, deadline, counter, signal))
      );

      clearInterval(progressInterval);

      // 計算最終結果
      const totalTime = (performance.now() - startTime) / 1000;
      const finalSpeedBps = (counter.bytes * 8) / totalTime;
      const result = {
        speed: MST.formatSpeed(finalSpeedBps),
        bytes: counter.bytes,
        duration: totalTime,
        targets: activeTargets,
        timestamp: Date.now(),
      };

      this._emit('complete', result);
      return result;

    } catch (error) {
      this._emit('error', { error, message: error.message });
      throw error;
    } finally {
      this._isRunning = false;
      this._abortController = null;
    }
  }

  /**
   * 停止測速
   */
  stop() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  /**
   * 是否正在測速
   * @returns {boolean}
   */
  get isRunning() {
    return this._isRunning;
  }
}

// UMD 導出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MST;
} else if (typeof window !== 'undefined') {
  window.MST = MST;
}
