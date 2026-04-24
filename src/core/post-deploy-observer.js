/**
 * Post-Deploy Observer
 *
 * Deploy 完成後持續觀察 5 分鐘，偵測新版本 crash → 自動 rollback。
 *
 * 流程：
 *   1. deploy 成功後，記錄 { projectId, commit, startTime }
 *   2. 30 秒後開始觀察（給 PM2 啟動時間）
 *   3. 每 30 秒檢查一次，持續 5 分鐘
 *   4. crash 偵測 → 自動 rollback 到前一個 commit
 *   5. 5 分鐘後無問題 → 清除 observer
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '../../config.json')
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}

const CHECK_INTERVAL = 30 * 1000       // 每 30 秒檢查
const OBSERVATION_WINDOW = 5 * 60 * 1000 // 觀察 5 分鐘
const STARTUP_DELAY = 30 * 1000         // 等 30 秒再開始觀察

// 活躍的 observers: Map<projectId, { commit, previousCommit, startTime, timer, initialRestarts }>
const observers = new Map()

function notify(message) {
  try {
    const config = getConfig()
    const chatId = config.telegram?.chatId
    if (!chatId) return
    const telegram = require('./telegram')
    telegram.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {})
  } catch {}
}

function getPm2Process(pm2Name) {
  try {
    const output = execSync('pm2 jlist', { windowsHide: true, timeout: 5000 }).toString()
    const processes = JSON.parse(output)
    return processes.find(p => p.name === pm2Name) || null
  } catch {
    return null
  }
}

async function checkHealth(project) {
  if (!project.healthEndpoint || !project.port) return true
  try {
    const url = `http://localhost:${project.port}${project.healthEndpoint}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return res.status >= 200 && res.status < 400
  } catch {
    return false
  }
}

async function observe(projectId) {
  const entry = observers.get(projectId)
  if (!entry) return

  const elapsed = Date.now() - entry.startTime

  // 觀察時間到 → 清除，新版本穩定
  if (elapsed >= OBSERVATION_WINDOW) {
    console.log(`[post-deploy] ✓ ${projectId} 穩定運行 5 分鐘，觀察結束`)
    clearObserver(projectId)
    return
  }

  const deploy = require('./deploy')
  const project = deploy.getProject(projectId)
  if (!project) {
    clearObserver(projectId)
    return
  }

  const pm2Name = project.pm2Name || project.id
  const proc = getPm2Process(pm2Name)

  let crashed = false
  let reason = ''

  // 檢查 1: PM2 status
  if (proc && proc.pm2_env?.status !== 'online') {
    crashed = true
    reason = `PM2 status: ${proc.pm2_env?.status || 'unknown'}`
  }

  // 檢查 2: restart count 增加（PM2 自動重啟 = 不穩定）
  if (!crashed && proc) {
    const currentRestarts = proc.pm2_env?.restart_time || 0
    if (currentRestarts > entry.initialRestarts + 2) {
      crashed = true
      reason = `restart count 增加 (${entry.initialRestarts} → ${currentRestarts})`
    }
  }

  // 檢查 3: HTTP health probe
  if (!crashed && project.healthEndpoint) {
    const healthy = await checkHealth(project)
    if (!healthy) {
      // 給一次重試機會
      await new Promise(r => setTimeout(r, 3000))
      const retry = await checkHealth(project)
      if (!retry) {
        crashed = true
        reason = `health probe 失敗 (${project.healthEndpoint})`
      }
    }
  }

  if (crashed) {
    console.log(`[post-deploy] ✗ ${projectId} crash 偵測: ${reason}`)
    clearObserver(projectId)
    await performRollback(project, entry, reason)
    return
  }

  // 繼續觀察
  entry.timer = setTimeout(() => observe(projectId), CHECK_INTERVAL)
}

async function performRollback(project, entry, reason) {
  const projectId = project.id
  const previousCommit = entry.previousCommit

  notify(
    `🔄 <b>Post-Deploy Observer</b>\n` +
    `<b>${project.name || projectId}</b> 新版本不穩定\n` +
    `原因: ${reason}\n` +
    `Commit: <code>${entry.commit?.slice(0, 7) || '?'}</code>\n` +
    `正在 rollback 到 <code>${previousCommit?.slice(0, 7) || 'previous'}</code>...`
  )

  try {
    const deploy = require('./deploy')
    const result = await deploy.rollback(projectId, previousCommit, { triggeredBy: 'post-deploy-observer' })

    if (result.status === 'success') {
      console.log(`[post-deploy] ✓ ${projectId} rollback 成功`)
      notify(
        `✅ <b>Post-Deploy Rollback</b>\n` +
        `<b>${project.name || projectId}</b> 已回滾到 <code>${previousCommit?.slice(0, 7) || 'previous'}</code>`
      )
    } else {
      console.error(`[post-deploy] ✗ ${projectId} rollback 失敗:`, result.error)
      notify(
        `❌ <b>Post-Deploy Rollback 失敗</b>\n` +
        `<b>${project.name || projectId}</b>\n` +
        `錯誤: ${result.error || '未知'}\n` +
        `需要人工介入`
      )
    }
  } catch (err) {
    console.error(`[post-deploy] ✗ ${projectId} rollback 錯誤:`, err.message)
    notify(`❌ <b>Post-Deploy Rollback 錯誤</b>\n${project.name || projectId}: ${err.message}`)
  }
}

function clearObserver(projectId) {
  const entry = observers.get(projectId)
  if (entry?.timer) clearTimeout(entry.timer)
  observers.delete(projectId)
}

/**
 * 開始觀察一個剛部署成功的項目
 */
function watch(projectId, commit, previousCommit) {
  // 如果已經在觀察中，先清除舊的
  clearObserver(projectId)

  const pm2Name = (() => {
    try {
      const deploy = require('./deploy')
      const p = deploy.getProject(projectId)
      return p?.pm2Name || projectId
    } catch { return projectId }
  })()

  // 記錄初始 restart count
  const proc = getPm2Process(pm2Name)
  const initialRestarts = proc?.pm2_env?.restart_time || 0

  const entry = {
    commit,
    previousCommit,
    startTime: Date.now(),
    timer: null,
    initialRestarts,
  }
  observers.set(projectId, entry)

  console.log(`[post-deploy] 開始觀察 ${projectId} (commit: ${commit?.slice(0, 7) || '?'})`)

  // 延遲 30 秒後開始觀察
  entry.timer = setTimeout(() => observe(projectId), STARTUP_DELAY)
}

function onDeployComplete({ project, deployment }) {
  // 只觀察成功的部署（非 rollback 觸發的）
  if (deployment.status !== 'success') return
  if (deployment.triggeredBy === 'post-deploy-observer') return

  watch(project.id, deployment.commit, project.runningCommit)
}

function getState() {
  const active = []
  for (const [projectId, entry] of observers) {
    active.push({
      projectId,
      commit: entry.commit?.slice(0, 7) || '?',
      elapsed: Math.round((Date.now() - entry.startTime) / 1000),
      remainingSeconds: Math.max(0, Math.round((OBSERVATION_WINDOW - (Date.now() - entry.startTime)) / 1000)),
    })
  }
  return { activeObservers: active.length, observers: active }
}

function start() {
  const deploy = require('./deploy')
  deploy.events.on('deploy:complete', onDeployComplete)
  console.log('[post-deploy] Observer 已啟動')
}

function stop() {
  // 清除所有觀察者
  for (const projectId of observers.keys()) {
    clearObserver(projectId)
  }
  try {
    const deploy = require('./deploy')
    deploy.events.removeListener('deploy:complete', onDeployComplete)
  } catch {}
  console.log('[post-deploy] Observer 已停止')
}

module.exports = { start, stop, watch, getState }
