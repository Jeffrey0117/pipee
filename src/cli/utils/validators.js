const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

/**
 * 常用驗證函式
 */

/**
 * 驗證專案名稱
 */
function validateProjectName(name) {
  if (!name || name.trim() === '') {
    throw new Error('專案名稱不能為空');
  }

  if (!/^[a-zA-Z0-9-_]+$/.test(name)) {
    throw new Error(
      '專案名稱只能包含字母、數字、連字號(-)和底線(_)\n' +
      `無效名稱: ${name}`
    );
  }

  if (name.length > 50) {
    throw new Error('專案名稱不能超過 50 個字元');
  }

  return true;
}

/**
 * 驗證端口
 */
function validatePort(port) {
  const portNum = parseInt(port);

  if (isNaN(portNum)) {
    throw new Error(`無效的端口號: ${port}`);
  }

  if (portNum < 1 || portNum > 65535) {
    throw new Error(
      `端口號必須在 1-65535 之間\n` +
      `提供的值: ${port}`
    );
  }

  // 檢查常見的保留端口
  const reservedPorts = [22, 80, 443, 3306, 5432, 27017];
  if (reservedPorts.includes(portNum)) {
    console.log(chalk.yellow(`⚠️  警告: 端口 ${portNum} 通常被系統服務佔用`));
  }

  return portNum;
}

/**
 * 驗證路徑
 */
function validatePath(filePath, options = {}) {
  const { mustExist = false, mustBeDir = false, mustBeFile = false } = options;

  if (!filePath || filePath.trim() === '') {
    throw new Error('路徑不能為空');
  }

  const absPath = path.resolve(filePath);

  if (mustExist && !fs.existsSync(absPath)) {
    throw new Error(
      `路徑不存在: ${absPath}\n` +
      '請檢查路徑是否正確'
    );
  }

  if (fs.existsSync(absPath)) {
    const stats = fs.statSync(absPath);

    if (mustBeDir && !stats.isDirectory()) {
      throw new Error(`路徑必須是目錄: ${absPath}`);
    }

    if (mustBeFile && !stats.isFile()) {
      throw new Error(`路徑必須是檔案: ${absPath}`);
    }
  }

  return absPath;
}

/**
 * 驗證環境變數名稱
 */
function validateEnvKey(key) {
  if (!key || key.trim() === '') {
    throw new Error('環境變數名稱不能為空');
  }

  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(
      '環境變數名稱只能包含大寫字母、數字和底線，且必須以字母或底線開頭\n' +
      `無效名稱: ${key}\n` +
      `建議格式: API_KEY, DATABASE_URL, PORT`
    );
  }

  return true;
}

/**
 * 顯示驗證錯誤
 */
function showValidationError(error, context = '') {
  console.error(chalk.red('✗ 驗證錯誤:'), context);
  console.error(chalk.dim(error.message));
  console.log('');
}

/**
 * 確認操作
 */
async function confirmAction(message, defaultValue = false) {
  const inquirer = require('inquirer');
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message,
      default: defaultValue
    }
  ]);
  return confirm;
}

/**
 * 檢查指定端口是否可用
 */
function isPortAvailable(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * 從指定端口開始，自動找到第一個可用的端口
 */
async function findAvailablePort(startPort = 3000) {
  let port = startPort;
  const maxAttempts = 100;

  for (let i = 0; i < maxAttempts; i++) {
    const available = await isPortAvailable(port);
    if (available) return port;
    port++;
  }

  throw new Error(`在 ${startPort}-${startPort + maxAttempts} 範圍內找不到可用端口`);
}

module.exports = {
  validateProjectName,
  validatePort,
  validatePath,
  validateEnvKey,
  showValidationError,
  confirmAction,
  isPortAvailable,
  findAvailablePort
};
