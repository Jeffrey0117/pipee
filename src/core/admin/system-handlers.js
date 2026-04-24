/**
 * Admin System Handlers
 *
 * System status, machines, env bundle, setup bundle, config, Telegram settings.
 * Extracted from admin.js for maintainability.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execSync } = require('child_process')
const deploy = require('../deploy')

const ROOT = path.join(__dirname, '../../..')
const CONFIG_PATH = path.join(ROOT, 'config.json')

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function handleStatus(res) {
  const os = require('os')
  const projects = deploy.getAllProjects()

  let pm2Processes = []
  try {
    const raw = execSync('pm2 jlist', { windowsHide: true, timeout: 5000 }).toString()
    pm2Processes = JSON.parse(raw).map(p => ({
      name: p.name,
      status: p.pm2_env?.status || 'unknown',
      cpu: p.monit?.cpu || 0,
      memory: p.monit?.memory || 0,
      uptime: p.pm2_env?.pm_uptime || 0,
      restarts: p.pm2_env?.restart_time || 0,
    }))
  } catch {}

  const totalMem = os.totalmem()
  const freeMem = os.freemem()

  const status = {
    platform: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      uptime: Math.round(os.uptime()),
      processUptime: Math.round(process.uptime()),
    },
    memory: {
      total: Math.round(totalMem / 1048576),
      free: Math.round(freeMem / 1048576),
      usedPercent: Math.round((1 - freeMem / totalMem) * 100),
    },
    cpuLoad: os.loadavg(),
    projects: {
      total: projects.length,
      deployed: projects.filter(p => p.lastDeployStatus === 'success').length,
      failed: projects.filter(p => p.lastDeployStatus === 'failed').length,
    },
    pm2: pm2Processes,
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(status))
}

async function handleMachines(req, res) {
  try {
    const { getAllMachines } = require('../heartbeat')
    const { getTunnelInfo } = require('../tunnel-info')
    const redisMod = require('../redis')

    const machines = await getAllMachines()
    const tunnel = getTunnelInfo()
    const currentMachineId = redisMod.getMachineId()

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ machines, currentMachineId, tunnel }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleSystemInfo(req, res) {
  try {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ uptime: process.uptime() }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function collectEnvBundle() {
  const envBundle = {}

  try {
    const db = require('../db')
    const projects = db.getAllProjects()

    for (const project of projects) {
      const projectDir = path.resolve(ROOT, project.directory)
      const envPath = path.join(projectDir, '.env')
      if (fs.existsSync(envPath)) {
        envBundle[project.id] = fs.readFileSync(envPath, 'utf8')
      }
    }
  } catch {}

  return envBundle
}

async function handleGenerateEnvToken(req, res) {
  try {
    const redis = require('../redis').getClient()
    if (!redis) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Redis not configured' }))
    }

    const token = crypto.randomBytes(32).toString('hex')
    const key = `PIPEE:envtoken:${token}`

    await redis.set(key, 'valid', 'EX', 300)

    const config = getConfig()
    const domain = config.domain || 'localhost'
    const downloadUrl = `https://${config.subdomain || 'epi'}.${domain}/api/_admin/env-bundle/download?token=${token}`

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token, downloadUrl, expiresIn: 300 }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleDownloadEnvBundle(req, res, url) {
  try {
    const token = url.searchParams.get('token')
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Invalid token' }))
    }

    const redis = require('../redis').getClient()
    if (!redis) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Redis not configured' }))
    }

    const key = `PIPEE:envtoken:${token}`
    const value = await redis.get(key)

    if (!value) {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Token expired or already used' }))
    }

    await redis.del(key)

    const envBundle = collectEnvBundle()

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ envBundle, downloadedAt: new Date().toISOString() }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function handleDirectEnvBundle(req, res) {
  try {
    const envBundle = collectEnvBundle()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ envBundle, downloadedAt: new Date().toISOString() }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function handleSetupBundle(req, res) {
  try {
    const config = getConfig()
    const credPath = config.cloudflared?.credentialsFile || ''
    let tunnelCredentials = null

    if (credPath && fs.existsSync(credPath)) {
      tunnelCredentials = JSON.parse(fs.readFileSync(credPath, 'utf8'))
    }

    // 計算 B 機要用的 sharedUrl（A 的內網 Redis 地址）
    const redisBundle = { url: '' }
    if (config.redis?.sharedUrl) {
      redisBundle.sharedUrl = config.redis.sharedUrl
    } else if (config.redis?.url) {
      // 沒設 sharedUrl → 把 url 當 sharedUrl 給 B 機
      redisBundle.sharedUrl = config.redis.url
    }

    const bundle = {
      machineId: '',
      redis: redisBundle,
      domain: config.domain || '',
      port: config.port || 8787,
      subdomain: config.subdomain || 'epi',
      adminPassword: config.adminPassword || '',
      jwtSecret: config.jwtSecret || '',
      serviceToken: config.serviceToken || '',
      telegramProxy: config.telegramProxy || '',
      tunnelId: config.cloudflared?.tunnelId || '',
      tunnelCredentials,
      telegram: {
        ...(config.telegram || {}),
        polling: false,
      },
      projects: deploy.getAllProjects(),
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(bundle))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

function handleHealthDetail(req, res) {
  try {
    const result = {}

    // Service Health Watchdog
    try {
      const serviceWatchdog = require('../service-health-watchdog')
      result.services = serviceWatchdog.getState().services
    } catch {
      result.services = []
    }

    // Tunnel Watchdog
    try {
      const tunnelWatchdog = require('../tunnel-watchdog')
      result.tunnel = tunnelWatchdog.getState()
    } catch {
      result.tunnel = { status: 'unknown' }
    }

    // Memory Watchdog
    try {
      const memoryWatchdog = require('../memory-watchdog')
      result.memory = memoryWatchdog.getState().processes
    } catch {
      result.memory = {}
    }

    // Cleanup
    try {
      const cleanup = require('../cleanup')
      result.cleanup = cleanup.getState()
    } catch {
      result.cleanup = { lastRun: null, nextRun: null }
    }

    // Post-Deploy Observer
    try {
      const postDeploy = require('../post-deploy-observer')
      result.postDeploy = postDeploy.getState()
    } catch {
      result.postDeploy = { activeObservers: 0 }
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleUpdateTelegram(req, res) {
  let body = ''
  req.on('data', chunk => body += chunk)
  req.on('end', async () => {
    try {
      const { enabled, botToken, chatId } = JSON.parse(body)
      const configWriter = require('../config-writer')
      const telegramConfig = {
        enabled: Boolean(enabled),
        botToken: botToken || '',
        chatId: chatId || ''
      }
      await configWriter.updateConfig({ telegram: telegramConfig })

      try {
        const telegram = require('../telegram')
        telegram.stopBot()
        if (telegramConfig.enabled) {
          telegram.startBot()
        }
      } catch (e) {
        console.error('[admin] Telegram bot restart failed:', e.message)
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
  })
}

module.exports = {
  handleStatus,
  handleMachines,
  handleSystemInfo,
  handleHealthDetail,
  handleGenerateEnvToken,
  handleDownloadEnvBundle,
  handleDirectEnvBundle,
  handleSetupBundle,
  handleUpdateTelegram,
}
