const chalk = require('chalk');
const ServiceManager = require('../utils/ServiceManager');

module.exports = async function logs(name, options) {
  console.log(chalk.cyan(`📜 查看日誌: ${chalk.bold(name)}\n`));

  try {
    const serviceManager = new ServiceManager();
    await serviceManager.logs(name, {
      follow: options.follow,
      lines: parseInt(options.lines) || 50
    });
  } catch (error) {
    console.error(chalk.red('✗ 錯誤:'), error.message);
    process.exit(1);
  }
};
