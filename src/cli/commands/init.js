const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');
const ProjectDetector = require('../utils/ProjectDetector');

module.exports = async function init(options) {
  console.log(chalk.cyan('🔍 掃描專案中...\n'));

  const cwd = process.cwd();
  const configPath = path.join(cwd, 'PIPEE.json');

  // 檢查是否已有配置
  if (fs.existsSync(configPath) && !options.force) {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'PIPEE.json 已存在，是否覆寫？',
        default: false
      }
    ]);

    if (!confirm) {
      console.log(chalk.yellow('已取消'));
      return;
    }
  }

  try {
    // 偵測專案類型
    const detector = new ProjectDetector(cwd);
    const projectInfo = await detector.detect();

    console.log(chalk.green('✓ 偵測完成\n'));
    console.log(chalk.bold('專案資訊：'));
    console.log(`  類型: ${chalk.cyan(projectInfo.type)}`);
    console.log(`  框架: ${chalk.cyan(projectInfo.framework || 'N/A')}`);
    console.log(`  建置指令: ${chalk.yellow(projectInfo.buildCommand || '無')}`);
    console.log(`  啟動指令: ${chalk.yellow(projectInfo.startCommand)}`);
    console.log(`  預設端口: ${chalk.yellow(projectInfo.port)}`);
    console.log('');

    // 詢問使用者確認
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: '是否產生配置檔？',
        default: true
      }
    ]);

    if (!confirm) {
      console.log(chalk.yellow('已取消'));
      return;
    }

    // 產生配置檔
    const config = {
      name: path.basename(cwd),
      type: projectInfo.type,
      framework: projectInfo.framework,
      buildCommand: projectInfo.buildCommand,
      startCommand: projectInfo.startCommand,
      port: projectInfo.port,
      env: {},
      tunnel: {
        enabled: true
      }
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log(chalk.green('✓ 已產生 PIPEE.json\n'));
    console.log(chalk.dim('下一步：'));
    console.log(chalk.dim('  PIPEE deploy  # 部署專案'));
    console.log('');

  } catch (error) {
    console.error(chalk.red('✗ 偵測失敗:'), error.message);
    process.exit(1);
  }
};
