/**
 * PIPEE Scheduler
 *
 * Runs pipelines and tools on cron schedules.
 * Leader election via Redis (independent from telegram leader).
 * No Redis → runs locally as single-machine scheduler.
 *
 * Schedule files live in data/schedules/*.json
 */

const fs = require('fs')
const path = require('path')
const cron = require('node-cron')

const SCHEDULES_DIR = path.join(__dirname, '../../data/schedules')
const LEADER_KEY = 'PIPEE:scheduler:leader'
const LEADER_TTL = 120
const LEADER_REFRESH = 60000

// --- State ---

let schedules = new Map()     // id → { def, job }
let history = []              // last 50 execution records
let leaderInterval = null
let isLeader = false
let started = false

const MAX_HISTORY = 50

// --- Schedule loading ---

function loadSchedules() {
  const loaded = new Map()

  try {
    if (!fs.existsSync(SCHEDULES_DIR)) {
      fs.mkdirSync(SCHEDULES_DIR, { recursive: true })
    }

    const files = fs.readdirSync(SCHEDULES_DIR)
    for (const file of files) {
      if (!file.endsWith('.json')) continue

      try {
        const raw = fs.readFileSync(path.join(SCHEDULES_DIR, file), 'utf-8')
        const def = JSON.parse(raw)
        if (def.id) {
          loaded.set(def.id, { def, job: null })
        }
      } catch (err) {
        console.error(`[Scheduler] Failed to load ${file}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[Scheduler] Failed to read schedules dir:', err.message)
  }

  return loaded
}

// --- Cron management ---

function startCronJobs() {
  for (const [id, entry] of schedules) {
    if (entry.job) {
      entry.job.stop()
      entry.job = null
    }

    if (!entry.def.enabled) continue

    const cronExpr = entry.def.cron
    if (!cron.validate(cronExpr)) {
      console.error(`[Scheduler] Invalid cron for ${id}: ${cronExpr}`)
      continue
    }

    const options = {
      timezone: entry.def.timezone || 'Asia/Taipei',
    }

    entry.job = cron.schedule(cronExpr, () => {
      executeSchedule(id).catch(err => {
        console.error(`[Scheduler] Cron execution error for ${id}:`, err.message)
      })
    }, options)
  }
}

function stopCronJobs() {
  for (const [, entry] of schedules) {
    if (entry.job) {
      entry.job.stop()
      entry.job = null
    }
  }
}

// --- Execution ---

async function executeSchedule(id) {
  const entry = schedules.get(id)
  if (!entry) {
    return { success: false, error: `Schedule not found: ${id}` }
  }

  const { def } = entry
  const startTime = Date.now()
  const maxAttempts = (def.retries || 0) + 1
  let lastError = null
  let result = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (def.type === 'pipeline') {
        const pipeline = require('./pipeline')
        const pipelineDef = pipeline.getPipeline(def.pipeline)
        if (!pipelineDef) {
          throw new Error(`Pipeline not found: ${def.pipeline}`)
        }
        result = await pipeline.execute(pipelineDef, def.input || {})
      } else if (def.type === 'tool') {
        const gateway = require('./gateway')
        const toolResult = await gateway.callToolByName(def.tool, def.params || {})
        result = { success: toolResult.ok, data: toolResult.data, status: toolResult.status }
      } else {
        throw new Error(`Unknown schedule type: ${def.type}`)
      }

      if (result.success !== false) {
        lastError = null
        break
      }

      lastError = result.error || `Failed at step ${result.failedAt || 'unknown'}`
      if (attempt < maxAttempts) {
        console.log(`[Scheduler] ${id} attempt ${attempt} failed, retrying...`)
      }
    } catch (err) {
      lastError = err.message
      if (attempt < maxAttempts) {
        console.log(`[Scheduler] ${id} attempt ${attempt} threw, retrying...`)
      }
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  const success = lastError === null
  const typeLabel = def.type === 'pipeline' ? def.pipeline : def.tool

  const record = {
    id,
    name: def.name,
    type: def.type,
    target: typeLabel,
    success,
    error: lastError,
    duration: `${duration}s`,
    executedAt: new Date().toISOString(),
  }

  // Update last run on the def (in-memory only, for display)
  entry.def._lastRun = record.executedAt
  entry.def._lastSuccess = success

  // Add to history
  history = [record, ...history].slice(0, MAX_HISTORY)

  // Notify via Telegram
  if (success && def.notify) {
    notifyTelegram(`✅ [Scheduler] ${def.name}\nType: ${def.type} | Duration: ${duration}s`)
  } else if (!success && def.notifyOnFailure) {
    notifyTelegram(`❌ [Scheduler] ${def.name} failed\nError: ${lastError}\nDuration: ${duration}s`)
  }

  console.log(`[Scheduler] ${id} ${success ? 'succeeded' : 'failed'} (${duration}s)`)

  return { ...record, result }
}

// --- Telegram notification ---

function notifyTelegram(text) {
  try {
    const telegram = require('./telegram')
    const config = telegram.getConfig()
    if (config.chatId && config.botToken) {
      telegram.sendMessage(config.chatId, text).catch(err => {
        console.error('[Scheduler] Telegram notify error:', err.message)
      })
    }
  } catch {
    // telegram module not available
  }
}

// --- Leader election ---

async function tryAcquireLeadership() {
  let redis
  try {
    redis = require('./redis').getSharedClient()
  } catch {
    return false
  }

  if (!redis) return false

  const machineId = require('./redis').getMachineId()

  try {
    // Lua script: atomic SET NX + 可重入續期
    const luaScript = `
      local result = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
      if result then return 1 end
      local current = redis.call('GET', KEYS[1])
      if current == ARGV[1] then
        redis.call('EXPIRE', KEYS[1], ARGV[2])
        return 1
      end
      return 0
    `
    const acquired = await redis.eval(luaScript, 1, LEADER_KEY, machineId, LEADER_TTL)
    return acquired === 1
  } catch (err) {
    console.error('[Scheduler] Leader election error:', err.message)
    return false
  }
}

async function releaseLeadership() {
  try {
    const redis = require('./redis').getSharedClient()
    const machineId = require('./redis').getMachineId()
    if (redis) {
      const current = await redis.get(LEADER_KEY)
      if (current === machineId) {
        await redis.del(LEADER_KEY)
      }
    }
  } catch {
    // ignore
  }
}

// --- Public API ---

async function start() {
  if (started) return

  schedules = loadSchedules()
  if (schedules.size === 0) {
    console.log('[Scheduler] No schedules found')
    return
  }

  console.log(`[Scheduler] Loaded ${schedules.size} schedules`)

  // Check Redis for leader election
  let hasRedis = false
  try {
    hasRedis = !!require('./redis').getSharedClient()
  } catch {
    // no redis
  }

  if (hasRedis) {
    const gotLeadership = await tryAcquireLeadership()
    isLeader = gotLeadership

    if (isLeader) {
      console.log('[Scheduler] This machine is the scheduler leader')
      startCronJobs()
    } else {
      console.log('[Scheduler] Another machine is scheduler leader, standby')
    }

    // Refresh leadership every 30s
    leaderInterval = setInterval(async () => {
      const wasLeader = isLeader
      isLeader = await tryAcquireLeadership()

      if (!wasLeader && isLeader) {
        console.log('[Scheduler] Acquired scheduler leadership')
        startCronJobs()
      } else if (wasLeader && !isLeader) {
        console.log('[Scheduler] Lost scheduler leadership, stopping crons')
        stopCronJobs()
      }
    }, LEADER_REFRESH)
  } else {
    // No Redis → single machine, just run
    isLeader = true
    startCronJobs()
    console.log('[Scheduler] Running locally (no Redis)')
  }

  started = true
}

function stop() {
  if (!started) return

  stopCronJobs()

  if (leaderInterval) {
    clearInterval(leaderInterval)
    leaderInterval = null
  }

  releaseLeadership().catch(() => {})

  isLeader = false
  started = false
  console.log('[Scheduler] Stopped')
}

function listSchedules() {
  const result = []
  for (const [id, entry] of schedules) {
    const { def } = entry
    result.push({
      id,
      name: def.name,
      description: def.description,
      cron: def.cron,
      timezone: def.timezone || 'Asia/Taipei',
      type: def.type,
      target: def.type === 'pipeline' ? def.pipeline : def.tool,
      enabled: def.enabled,
      lastRun: def._lastRun || null,
      lastSuccess: def._lastSuccess !== undefined ? def._lastSuccess : null,
    })
  }
  return result
}

async function runSchedule(id) {
  return executeSchedule(id)
}

function toggleSchedule(id) {
  const entry = schedules.get(id)
  if (!entry) {
    return { error: `Schedule not found: ${id}` }
  }

  const newEnabled = !entry.def.enabled
  entry.def.enabled = newEnabled

  // Persist to disk
  try {
    const filePath = path.join(SCHEDULES_DIR, `${id}.json`)
    const raw = fs.readFileSync(filePath, 'utf-8')
    const onDisk = JSON.parse(raw)
    const updated = { ...onDisk, enabled: newEnabled }
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
  } catch (err) {
    console.error(`[Scheduler] Failed to persist toggle for ${id}:`, err.message)
  }

  // Update cron job
  if (isLeader) {
    if (entry.job) {
      entry.job.stop()
      entry.job = null
    }

    if (newEnabled && cron.validate(entry.def.cron)) {
      entry.job = cron.schedule(entry.def.cron, () => {
        executeSchedule(id).catch(err => {
          console.error(`[Scheduler] Cron execution error for ${id}:`, err.message)
        })
      }, { timezone: entry.def.timezone || 'Asia/Taipei' })
    }
  }

  return { id, enabled: newEnabled }
}

function getHistory(scheduleId) {
  if (scheduleId) {
    return history.filter(h => h.id === scheduleId)
  }
  return history
}

module.exports = {
  start,
  stop,
  listSchedules,
  runSchedule,
  toggleSchedule,
  getHistory,
}
