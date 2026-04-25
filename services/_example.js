/**
 * 範例 API 服務
 *
 * PIPEE 的 services 可以做任何事，不只是轉發！
 * 你可以直接在 handle() 裡處理業務邏輯。
 *
 * 上傳這個 .js 檔案到 PIPEE，就會得到一個公網 API。
 * e.g.: api.yourdomain.com/hello
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  /**
   * 匹配規則 - 決定哪些請求由此服務處理
   * 通常用 req.url.startsWith('/你的路徑')
   */
  match(req) {
    return req.url.startsWith('/hello');
  },

  /**
   * 處理請求 - 你的業務邏輯都寫在這裡
   *
   * 可以做的事：
   * - 回傳 JSON
   * - 讀寫檔案
   * - 下載遠端資源
   * - 呼叫其他 API
   * - 存資料庫（sqlite、jsonl...）
   *
   * @param {http.IncomingMessage} req - Node.js 原生請求物件
   * @param {http.ServerResponse} res - Node.js 原生回應物件
   */
  handle(req, res) {
    // 去掉前綴，取得實際路徑
    const urlPath = req.url.replace(/^\/hello/, '') || '/';

    // CORS（如果需要跨域）
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    };

    // GET /hello - 簡單回應
    if (req.method === 'GET' && urlPath === '/') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ message: 'Hello World!' }));
      return;
    }

    // GET /hello/time - 回傳時間
    if (req.method === 'GET' && urlPath === '/time') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ time: new Date().toISOString() }));
      return;
    }

    // POST /hello/echo - 回傳收到的資料
    if (req.method === 'POST' && urlPath === '/echo') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ received: JSON.parse(body) }));
      });
      return;
    }

    // 404
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
};
