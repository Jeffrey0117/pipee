const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const ServiceManager = require('../utils/ServiceManager');
const TunnelManager = require('../utils/TunnelManager');

module.exports = async function remove(name) {
  // 確認刪除
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: `確定要移除 ${chalk.cyan(name)} 嗎？`,
      default: false
    }
  ]);

  if (!confirm) {
    console.log(chalk.yellow('已取消'));
    return;
  }

  const spinner = ora(`移除專案: ${chalk.cyan(name)}`).start();

  try {
    // 停止服務
    const serviceManager = new ServiceManager();
    await serviceManager.remove(name);

    // 移除 tunnel
    const tunnelManager = new TunnelManager();
    await tunnelManager.remove(name);

    spinner.succeed(`已移除: ${chalk.cyan(name)}`);
  } catch (error) {
    spinner.fail('移除失敗');
    console.error(chalk.red('✗ 錯誤:'), error.message);
    process.exit(1);
  }
};
