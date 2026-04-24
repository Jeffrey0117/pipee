const chalk = require('chalk');
const ora = require('ora');
const ServiceManager = require('../utils/ServiceManager');

module.exports = async function stop(name) {
  const spinner = ora(`停止專案: ${chalk.cyan(name)}`).start();

  try {
    const serviceManager = new ServiceManager();
    await serviceManager.stop(name);

    spinner.succeed(`已停止: ${chalk.cyan(name)}`);
  } catch (error) {
    spinner.fail('停止失敗');
    console.error(chalk.red('✗ 錯誤:'), error.message);
    process.exit(1);
  }
};
