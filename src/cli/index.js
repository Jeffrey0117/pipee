#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Command } = require('commander');
const chalk = require('chalk');
const packageJson = require('../../package.json');

const program = new Command();

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// 設定 CLI 基本資訊
program
  .name('pipee')
  .description('Zero-config deployment tool for full-stack apps')
  .version(packageJson.version);

// 載入指令
const initCommand = require('./commands/init');
const deployCommand = require('./commands/deploy');
const listCommand = require('./commands/list');
const stopCommand = require('./commands/stop');
const removeCommand = require('./commands/remove');
const logsCommand = require('./commands/logs');
const { envSet, envList, envRemove } = require('./commands/env');
const historyCommand = require('./commands/history');
const setupCommand = require('./commands/setup');

// Setup wizard
program
  .command('setup')
  .description('Interactive setup wizard (first-time configuration)')
  .option('-f, --force', 'Overwrite existing config')
  .action(setupCommand);

// Start server
program
  .command('start')
  .description('Start PIPEE server')
  .action(() => {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log(chalk.yellow('No config.json found. Run "pipee setup" first.\n'));
      return;
    }
    require('../../index.js');
  });

// 註冊指令
program
  .command('init')
  .description('Scan project and generate deploy config')
  .option('-f, --force', 'Overwrite existing config')
  .action(initCommand);

program
  .command('deploy [path]')
  .description('Deploy a project')
  .option('-n, --name <name>', 'Project name')
  .option('-p, --port <port>', 'Port number')
  .option('--no-tunnel', 'Skip Cloudflare tunnel')
  .option('-w, --watch', 'Watch for file changes')
  .action(deployCommand);

program
  .command('list')
  .alias('ls')
  .description('List all deployed projects')
  .action(listCommand);

program
  .command('stop <name>')
  .description('Stop a project')
  .action(stopCommand);

program
  .command('remove <name>')
  .alias('rm')
  .description('Remove a project')
  .action(removeCommand);

program
  .command('logs <name>')
  .description('View project logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines', '50')
  .action(logsCommand);

// Environment variable management
const envCommand = program.command('env <action> [key]');
envCommand.description('Manage environment variables');

envCommand
  .command('set [keyValue]')
  .description('Set env var (KEY=VALUE)')
  .action(envSet);

envCommand
  .command('list')
  .alias('ls')
  .description('List all env vars')
  .action(envList);

envCommand
  .command('remove <key>')
  .alias('rm')
  .description('Remove an env var')
  .action(envRemove);

program
  .command('history')
  .description('View deployment history')
  .option('-l, --limit <number>', 'Number of entries', '10')
  .action(historyCommand);

// 自訂 help
program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log('  $ pipee setup             # First-time setup wizard');
  console.log('  $ pipee start             # Start the server');
  console.log('  $ pipee deploy ./my-app   # Deploy a project');
  console.log('  $ pipee list              # List all deployments');
  console.log('  $ pipee logs my-app -f    # Tail logs');
  console.log('');
});

// 解析參數
program.parse(process.argv);

// No args: detect first run or show help
if (!process.argv.slice(2).length) {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(chalk.cyan('\nWelcome to Pipee!\n'));
    console.log('No configuration found. Running setup wizard...\n');
    setupCommand({});
  } else {
    program.outputHelp();
  }
}
