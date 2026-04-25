/**
 * PIPEE JWT Authentication Module
 * Unified authentication for inter-service communication
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../../config.json');

// 讀取設定
function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

// JWT Secret — no fallback; missing config = auth disabled
function getJwtSecret() {
  const secret = getConfig().jwtSecret
  if (!secret) {
    throw new Error('jwtSecret not configured in config.json — admin auth is disabled until set')
  }
  return secret
}

// 密碼
function getPassword() {
  const pw = getConfig().adminPassword
  if (!pw) {
    throw new Error('adminPassword not configured in config.json — admin login is disabled until set')
  }
  return pw
}

/**
 * 產生 JWT Token
 * @param {Object} payload - Token 內容
 * @param {string} expiresIn - 過期時間 (預設 24h)
 */
function generateToken(payload = {}, expiresIn = '24h') {
  return jwt.sign(
    {
      ...payload,
      iat: Math.floor(Date.now() / 1000)
    },
    getJwtSecret(),
    { expiresIn }
  );
}

/**
 * 驗證 JWT Token
 * @param {string} token - JWT Token
 * @returns {Object|null} - 解碼後的 payload，或 null
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (e) {
    return null;
  }
}

/**
 * 產生 Admin Token (登入後使用)
 */
function generateAdminToken() {
  return generateToken({
    role: 'admin',
    service: 'PIPEE'
  }, '7d');
}

/**
 * 產生 Service Token (內部服務通訊用)
 * For inter-service authenticated requests
 */
function generateServiceToken(serviceName = 'PIPEE') {
  return generateToken({
    role: 'service',
    service: serviceName
  }, '1h');
}

/**
 * 從 Request 取得 Token
 */
function getTokenFromRequest(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

/**
 * 驗證 Request 的 Token
 * @returns {Object|null} - 解碼後的 payload，或 null
 */
function verifyRequest(req) {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  return verifyToken(token);
}

/**
 * 驗證密碼是否正確
 */
function verifyPassword(password) {
  return password === getPassword();
}

module.exports = {
  getJwtSecret,
  getPassword,
  generateToken,
  verifyToken,
  generateAdminToken,
  generateServiceToken,
  getTokenFromRequest,
  verifyRequest,
  verifyPassword
};
