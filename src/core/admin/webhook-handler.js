/**
 * Admin Webhook Handler
 *
 * GitHub webhook receive + logging + cross-machine dedup via Redis.
 * Extracted from admin.js for maintainability.
 */

const fs = require('fs')
const path = require('path')
const deploy = require('../deploy')
const { getSharedClient, getMachineId } = require('../redis')

const WEBHOOK_LOG_FILE = path.join(__dirname, '../../../data/deploy/webhook-logs.json')

function logWebhook(projectId, event, data = {}) {
  const log = {
    id: `wh_${Date.now().toString(36)}`,
    projectId,
    event,
    timestamp: new Date().toISOString(),
    ...data
  }

  let logs = []
  try {
    logs = JSON.parse(fs.readFileSync(WEBHOOK_LOG_FILE, 'utf8')).logs || []
  } catch {}

  logs.unshift(log)
  logs = logs.slice(0, 100)

  fs.writeFileSync(WEBHOOK_LOG_FILE, JSON.stringify({ logs }, null, 2))
  console.log(`[webhook] ${event}: ${projectId}`, data.commit || data.reason || '')
}

async function handleWebhook(req, res, pathname) {
  const projectId = pathname.replace('/webhook/', '')

  const project = deploy.getProject(projectId)
  if (!project) {
    logWebhook(projectId, 'rejected', { reason: '專案不存在' })
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: '專案不存在' }))
  }

  let body = ''
  req.on('data', chunk => body += chunk)
  req.on('end', async () => {
    try {
      if (project.webhookSecret) {
        const signature = req.headers['x-hub-signature-256']
        if (!deploy.verifyGitHubWebhook(body, signature, project.webhookSecret)) {
          logWebhook(projectId, 'rejected', { reason: '簽名驗證失敗' })
          res.writeHead(401, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Invalid signature' }))
        }
      }

      const payload = JSON.parse(body)

      const ref = payload.ref || ''
      const branch = ref.replace('refs/heads/', '')
      const commit = payload.after ? payload.after.substring(0, 7) : null
      const commitMessage = payload.head_commit?.message || ''

      if (branch !== project.branch) {
        logWebhook(projectId, 'ignored', { reason: `非目標 branch: ${branch}`, branch })
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ignored: true, reason: 'Wrong branch' }))
      }

      logWebhook(projectId, 'received', { branch, commit, commitMessage: commitMessage.substring(0, 50) })

      // 跨機 webhook 去重：用 X-GitHub-Delivery header
      const deliveryId = req.headers['x-github-delivery']
      if (deliveryId) {
        const redis = getSharedClient()
        if (redis) {
          try {
            const dedupKey = `PIPEE:webhook:${deliveryId}`
            const result = await redis.set(dedupKey, getMachineId(), 'EX', 600, 'NX')
            if (result !== 'OK') {
              logWebhook(projectId, 'deduped', { deliveryId, reason: 'Already processed by another machine' })
              res.writeHead(200, { 'content-type': 'application/json' })
              return res.end(JSON.stringify({ success: true, deduped: true, message: 'Already processed' }))
            }
          } catch (err) {
            // Redis 不可用 → 照常處理（graceful degradation）
            console.error('[webhook] Dedup check failed:', err.message)
          }
        }
      }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: '部署已觸發' }))

      deploy.deploy(projectId, { triggeredBy: 'webhook' }).catch(err => {
        console.error(`[webhook] 部署失敗: ${err.message}`)
      })
    } catch (err) {
      logWebhook(projectId, 'error', { reason: err.message })
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    }
  })
}

module.exports = { handleWebhook }
