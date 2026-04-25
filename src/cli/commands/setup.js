const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const chalk = require('chalk')
const inquirer = require('inquirer')

const ROOT = path.join(__dirname, '..', '..', '..')
const CONFIG_PATH = path.join(ROOT, 'config.json')
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json')

function randomToken(len = 32) {
  return crypto.randomBytes(len).toString('hex')
}

function banner() {
  console.log('')
  console.log(chalk.cyan('╔══════════════════════════════════════╗'))
  console.log(chalk.cyan('║') + chalk.bold('     PIPEE Setup Wizard          ') + chalk.cyan('║'))
  console.log(chalk.cyan('╚══════════════════════════════════════╝'))
  console.log('')
}

function checkPrereqs() {
  console.log(chalk.bold('Checking prerequisites...\n'))

  const checks = [
    { name: 'Node.js', cmd: 'node', test: () => process.version, required: true },
    { name: 'PM2', cmd: 'pm2', test: () => { try { require('pm2'); return 'installed' } catch { return null } }, required: true },
    { name: 'Git', cmd: 'git', test: () => { try { return require('child_process').execSync('git --version', { encoding: 'utf8' }).trim() } catch { return null } }, required: true },
  ]

  let allGood = true
  for (const check of checks) {
    const result = check.test()
    if (result) {
      console.log(chalk.green(`  ✓ ${check.name}`) + chalk.dim(` (${result})`))
    } else {
      const icon = check.required ? chalk.red('  ✗') : chalk.yellow('  -')
      console.log(`${icon} ${check.name}` + chalk.dim(` (not found)`))
      if (check.required) allGood = false
    }
  }
  console.log('')
  return allGood
}

module.exports = async function setup(options) {
  banner()

  const isForce = options?.force
  if (fs.existsSync(CONFIG_PATH) && !isForce) {
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: 'config.json already exists. Overwrite?',
      default: false,
    }])
    if (!overwrite) {
      console.log(chalk.yellow('Cancelled.'))
      return
    }
  }

  const prereqOk = checkPrereqs()
  if (!prereqOk) {
    console.log(chalk.red('Missing required tools. Please install them first.\n'))
    return
  }

  // Step 1: Basic config
  console.log(chalk.bold('Step 1: Server Configuration\n'))

  const basic = await inquirer.prompt([
    {
      type: 'number',
      name: 'port',
      message: 'Server port:',
      default: 8787,
    },
    {
      type: 'password',
      name: 'adminPassword',
      message: 'Admin password:',
      mask: '*',
      validate: (v) => v.length >= 4 ? true : 'At least 4 characters',
    },
  ])

  // Step 2: Domain (optional)
  console.log('')
  console.log(chalk.bold('Step 2: Domain (optional)\n'))

  const domain = await inquirer.prompt([
    {
      type: 'input',
      name: 'domain',
      message: 'Your domain (leave empty to skip):',
      default: '',
    },
    {
      type: 'input',
      name: 'subdomain',
      message: 'API subdomain:',
      default: 'api',
      when: (answers) => answers.domain !== '',
    },
  ])

  // Step 3: Telegram (optional)
  console.log('')
  console.log(chalk.bold('Step 3: Telegram Bot (optional)\n'))

  const tg = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'enabled',
      message: 'Enable Telegram bot?',
      default: false,
    },
    {
      type: 'input',
      name: 'botToken',
      message: 'Bot token (from @BotFather):',
      when: (a) => a.enabled,
      validate: (v) => /^\d+:[A-Za-z0-9_-]+$/.test(v) ? true : 'Invalid token format',
    },
    {
      type: 'input',
      name: 'chatId',
      message: 'Your Telegram chat ID:',
      when: (a) => a.enabled,
      validate: (v) => /^\d+$/.test(v) ? true : 'Must be a number',
    },
  ])

  // Build config
  const config = {
    domain: domain.domain || 'localhost',
    port: basic.port,
    subdomain: domain.subdomain || 'api',
    adminPassword: basic.adminPassword,
    jwtSecret: randomToken(32),
    serviceToken: randomToken(24),
    supabase: {
      url: '',
      anonKey: '',
      serviceRoleKey: '',
      logRequests: false,
    },
    cloudflared: {
      path: 'cloudflared',
      tunnelId: '',
      credentialsFile: '',
    },
    telegram: {
      enabled: tg.enabled || false,
      botToken: tg.botToken || '',
      chatId: tg.chatId || '',
      polling: true,
    },
    bots: [],
  }

  // Write config
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))

  console.log('')
  console.log(chalk.green('✓ config.json generated\n'))
  console.log(chalk.bold('Config summary:'))
  console.log(`  Port:       ${chalk.cyan(config.port)}`)
  console.log(`  Domain:     ${chalk.cyan(config.domain)}`)
  console.log(`  Telegram:   ${config.telegram.enabled ? chalk.green('enabled') : chalk.dim('disabled')}`)
  console.log(`  JWT Secret: ${chalk.dim(config.jwtSecret.slice(0, 8) + '...')}`)
  console.log(`  Service Token: ${chalk.dim(config.serviceToken.slice(0, 8) + '...')}`)
  console.log('')
  console.log(chalk.bold('Next steps:'))
  console.log(`  ${chalk.cyan('PIPEE start')}          Start the server`)
  console.log(`  ${chalk.cyan('PIPEE deploy ./app')}   Deploy a project`)
  console.log('')
}
