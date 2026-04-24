const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');

/**
 * 環境變數管理
 */
class EnvManager {
  constructor(projectPath) {
    this.projectPath = projectPath || process.cwd();
    this.envFilePath = path.join(this.projectPath, '.env');
    this.PIPEEEnvPath = path.join(this.projectPath, '.PIPEE.env');
  }

  /**
   * 讀取環境變數
   */
  load() {
    const vars = {};

    // 讀取 .env
    if (fs.existsSync(this.envFilePath)) {
      const content = fs.readFileSync(this.envFilePath, 'utf8');
      this.parseEnvFile(content, vars);
    }

    // 讀取 .PIPEE.env（優先權更高）
    if (fs.existsSync(this.PIPEEEnvPath)) {
      const content = fs.readFileSync(this.PIPEEEnvPath, 'utf8');
      this.parseEnvFile(content, vars);
    }

    return vars;
  }

  /**
   * 解析 .env 檔案
   */
  parseEnvFile(content, vars) {
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length) {
        const value = valueParts.join('=').trim();
        // 移除引號
        vars[key.trim()] = value.replace(/^["']|["']$/g, '');
      }
    }
  }

  /**
   * 設定環境變數
   */
  set(key, value) {
    const vars = this.load();
    vars[key] = value;
    this.save(vars);
  }

  /**
   * 移除環境變數
   */
  remove(key) {
    const vars = this.load();
    delete vars[key];
    this.save(vars);
  }

  /**
   * 儲存環境變數
   */
  save(vars) {
    const lines = [];
    lines.push('# PIPEE Environment Variables');
    lines.push(`# Updated: ${new Date().toISOString()}`);
    lines.push('');

    for (const [key, value] of Object.entries(vars)) {
      // 如果值包含空格或特殊字元，加上引號
      const needsQuotes = /[\s#"']/.test(value);
      const formattedValue = needsQuotes ? `"${value}"` : value;
      lines.push(`${key}=${formattedValue}`);
    }

    fs.writeFileSync(this.PIPEEEnvPath, lines.join('\n'));
  }

  /**
   * 列出所有環境變數
   */
  list() {
    return this.load();
  }
}

/**
 * PIPEE env set 指令
 */
async function envSet(keyValue, options) {
  const manager = new EnvManager();

  if (!keyValue) {
    // 互動式設定
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'key',
        message: '變數名稱:',
        validate: (input) => input.length > 0 || '請輸入變數名稱'
      },
      {
        type: 'input',
        name: 'value',
        message: '變數值:'
      }
    ]);

    manager.set(answers.key, answers.value);
    console.log(chalk.green(`✓ 已設定: ${answers.key}=${answers.value}`));
  } else {
    // KEY=VALUE 格式
    const [key, ...valueParts] = keyValue.split('=');
    if (!key || valueParts.length === 0) {
      console.error(chalk.red('✗ 格式錯誤，請使用: KEY=VALUE'));
      process.exit(1);
    }

    const value = valueParts.join('=');
    manager.set(key, value);
    console.log(chalk.green(`✓ 已設定: ${key}=${value}`));
  }
}

/**
 * PIPEE env list 指令
 */
function envList() {
  const manager = new EnvManager();
  const vars = manager.list();

  if (Object.keys(vars).length === 0) {
    console.log(chalk.yellow('沒有設定任何環境變數'));
    console.log(chalk.dim('\n使用 PIPEE env set KEY=VALUE 新增'));
    return;
  }

  console.log(chalk.cyan('環境變數：\n'));
  for (const [key, value] of Object.entries(vars)) {
    // 遮蔽敏感值（如果包含 secret, password, token 等關鍵字）
    const isSensitive = /secret|password|token|key|api/i.test(key);
    const displayValue = isSensitive ? '***' : value;
    console.log(`  ${chalk.bold(key)} = ${chalk.dim(displayValue)}`);
  }
  console.log('');
}

/**
 * PIPEE env remove 指令
 */
async function envRemove(key) {
  if (!key) {
    console.error(chalk.red('✗ 請指定要移除的變數名稱'));
    process.exit(1);
  }

  const manager = new EnvManager();
  const vars = manager.list();

  if (!vars[key]) {
    console.error(chalk.red(`✗ 變數 ${key} 不存在`));
    process.exit(1);
  }

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `確定要移除 ${chalk.cyan(key)} 嗎？`,
      default: false
    }
  ]);

  if (!confirm) {
    console.log(chalk.yellow('已取消'));
    return;
  }

  manager.remove(key);
  console.log(chalk.green(`✓ 已移除: ${key}`));
}

module.exports = {
  EnvManager,
  envSet,
  envList,
  envRemove
};
