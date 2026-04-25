const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora');
const ProjectDetector = require('../utils/ProjectDetector');
const ServiceManager = require('../utils/ServiceManager');
const TunnelManager = require('../utils/TunnelManager');
const { EnvManager } = require('./env');
const DeployHistory = require('../utils/DeployHistory');
const { findAvailablePort } = require('../utils/validators');

module.exports = async function deploy(projectPath, options) {
  const targetPath = path.resolve(process.cwd(), projectPath || '.');
  const configPath = path.join(targetPath, 'PIPEE.json');

  // 驗證專案路徑
  if (!fs.existsSync(targetPath)) {
    console.error(chalk.red('✗ 專案路徑不存在:'), targetPath);
    process.exit(1);
  }

  // 檢查是否在 node_modules 中
  if (targetPath.includes('node_modules')) {
    console.error(chalk.red('✗ 無法部署 node_modules 中的專案'));
    console.error(chalk.dim('請確認專案路徑正確'));
    process.exit(1);
  }

  console.log(chalk.cyan(`🚀 部署專案: ${chalk.bold(path.basename(targetPath))}\n`));

  let config;
  let spinner;

  try {
    // 1. 讀取或自動偵測配置
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (options.port) config.port = options.port;
      const resolvedPort = await findAvailablePort(config.port || 3000);
      if (resolvedPort !== config.port) {
        console.log(chalk.yellow(`⚠️  端口 ${config.port} 已被佔用，自動切換到 ${resolvedPort}`));
      }
      config.port = resolvedPort;
      console.log(chalk.dim('使用配置: PIPEE.json\n'));
    } else {
      spinner = ora('自動偵測專案類型...').start();
      const detector = new ProjectDetector(targetPath);
      const projectInfo = await detector.detect();

      // 載入環境變數
      const envManager = new EnvManager(targetPath);
      const envVars = envManager.load();

      const preferredPort = options.port || projectInfo.port;

      config = {
        name: options.name || path.basename(targetPath),
        type: projectInfo.type,
        framework: projectInfo.framework,
        buildCommand: projectInfo.buildCommand,
        startCommand: projectInfo.startCommand,
        port: preferredPort,
        env: envVars,
        tunnel: {
          enabled: options.tunnel !== false
        }
      };

      spinner.succeed(`偵測到: ${chalk.cyan(projectInfo.type)}`);

      // 自動尋找可用端口（避免衝突）
      const resolvedPort = await findAvailablePort(preferredPort);
      if (resolvedPort !== preferredPort) {
        console.log(chalk.yellow(`⚠️  端口 ${preferredPort} 已被佔用，自動切換到 ${resolvedPort}`));
      }
      config.port = resolvedPort;
      console.log('');
    }

    // 2. 執行建置（如果有）
    if (config.buildCommand) {
      spinner = ora('執行建置...').start();
      const { exec } = require('child_process');
      await new Promise((resolve, reject) => {
        exec(config.buildCommand, { cwd: targetPath }, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
      spinner.succeed('建置完成');
    }

    // 3. 啟動服務
    spinner = ora('啟動服務...').start();
    const serviceManager = new ServiceManager();
    const service = await serviceManager.start({
      name: config.name,
      cwd: targetPath,
      script: config.startCommand,
      port: config.port,
      env: config.env
    });
    spinner.succeed(`服務已啟動 (Port: ${chalk.yellow(config.port)})`);

    // 4. 建立 Tunnel（如果啟用）
    let publicUrl = `http://localhost:${config.port}`;

    if (config.tunnel && config.tunnel.enabled) {
      spinner = ora('建立 Cloudflare Tunnel...').start();
      const tunnelManager = new TunnelManager();
      const tunnel = await tunnelManager.create(config.name, config.port);
      publicUrl = tunnel.url;
      spinner.succeed(`Tunnel 已建立`);
    }

    // 5. 啟動檔案監控（如果啟用）
    if (options.watch) {
      const FileWatcher = require('../utils/FileWatcher');
      const watcher = new FileWatcher(targetPath);

      console.log('');
      watcher.start(async (event, filePath) => {
        console.log(chalk.cyan('\n🔄 偵測到檔案變動，重新載入...'));

        try {
          // 重新建置（如果有）
          if (config.buildCommand) {
            console.log(chalk.dim('   執行建置...'));
            const { exec } = require('child_process');
            await new Promise((resolve, reject) => {
              exec(config.buildCommand, { cwd: targetPath }, (error) => {
                if (error) reject(error);
                else resolve();
              });
            });
          }

          // 重啟服務
          console.log(chalk.dim('   重啟服務...'));
          await serviceManager.restart(config.name);

          console.log(chalk.green('   ✓ 重新載入完成\n'));
        } catch (err) {
          console.error(chalk.red('   ✗ 重新載入失敗:'), err.message);
        }
      });

      // 攔截 Ctrl+C，優雅退出
      process.on('SIGINT', async () => {
        console.log('');
        await watcher.stop();
        process.exit(0);
      });
    }

    // 6. 完成
    console.log('');
    console.log(chalk.green.bold('✓ 部署成功！\n'));
    console.log(chalk.bold('專案資訊：'));
    console.log(`  名稱: ${chalk.cyan(config.name)}`);
    console.log(`  本地: ${chalk.yellow(`http://localhost:${config.port}`)}`);
    if (publicUrl !== `http://localhost:${config.port}`) {
      console.log(`  公開: ${chalk.green(publicUrl)}`);
    }
    console.log('');
    console.log(chalk.dim('管理指令：'));
    console.log(chalk.dim(`  PIPEE logs ${config.name}     # 查看日誌`));
    console.log(chalk.dim(`  PIPEE stop ${config.name}     # 停止服務`));
    console.log(chalk.dim(`  PIPEE remove ${config.name}   # 移除部署`));
    console.log('');

    if (options.watch) {
      console.log(chalk.yellow('⏳ 監控模式啟動中... (按 Ctrl+C 退出)'));
      console.log('');
    }

    // 7. 記錄部署歷史
    const deployHistory = new DeployHistory();
    deployHistory.add({
      name: config.name,
      path: targetPath,
      type: config.type,
      framework: config.framework,
      port: config.port,
      url: publicUrl,
      status: 'success'
    });

  } catch (error) {
    if (spinner) spinner.fail('部署失敗');
    console.error(chalk.red('✗ 錯誤:'), error.message);

    // 提供除錯建議
    console.log('');
    console.log(chalk.yellow('除錯建議:'));
    console.log(chalk.dim('  1. 檢查專案配置: PIPEE init'));
    console.log(chalk.dim('  2. 查看服務日誌: PIPEE logs <name>'));
    console.log(chalk.dim('  3. 列出所有服務: PIPEE list'));
    console.log(chalk.dim('  4. 檢查端口佔用: netstat -ano | findstr :<port>'));
    console.log('');

    // 記錄失敗
    try {
      const deployHistory = new DeployHistory();
      deployHistory.add({
        name: config?.name || path.basename(targetPath),
        path: targetPath,
        status: 'failed',
        error: error.message
      });
    } catch (historyErr) {
      // 忽略歷史記錄錯誤
    }

    process.exit(1);
  }
};
