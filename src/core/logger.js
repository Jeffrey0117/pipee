/**
 * Centralized Access Logger
 *
 * JSON-lines access log → logs/access-YYYY-MM-DD.log + stdout.
 * Auto-rotates on date change, cleans up files older than 30 days hourly.
 */

const fs = require('fs')
const path = require('path')

const LOGS_DIR = path.join(__dirname, '../../logs')
const RETENTION_DAYS = 30

let currentDate = ''
let stream = null
let cleanupTimer = null

function today() {
  return new Date().toISOString().slice(0, 10)
}

function logFilePath(date) {
  return path.join(LOGS_DIR, `access-${date}.log`)
}

function ensureStream() {
  const date = today()
  if (date === currentDate && stream) return

  if (stream) {
    stream.end()
  }

  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
  }

  currentDate = date
  stream = fs.createWriteStream(logFilePath(date), { flags: 'a' })
  stream.on('error', (err) => {
    console.error('[logger] Write stream error:', err.message)
    stream = null
  })
}

/**
 * Extract real client IP from request headers.
 * Priority: cf-connecting-ip → x-forwarded-for (first) → socket.remoteAddress → 'unknown'
 */
function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip']
  if (cfIp) return cfIp

  const xff = req.headers['x-forwarded-for']
  if (xff) return xff.split(',')[0].trim()

  const remote = req.socket?.remoteAddress
  if (remote) return remote.replace(/^::ffff:/, '')

  return 'unknown'
}

/**
 * Write a structured access log entry (JSON line).
 * @param {{ ts: string, ip: string, method: string, url: string, status: number, ms: number, sub: string, host: string }} entry
 */
function log(entry) {
  const line = JSON.stringify(entry)

  ensureStream()
  if (stream) {
    stream.write(line + '\n')
  }
}

/**
 * Remove access log files older than RETENTION_DAYS.
 */
function cleanup() {
  try {
    if (!fs.existsSync(LOGS_DIR)) return

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files = fs.readdirSync(LOGS_DIR)

    for (const file of files) {
      if (!file.startsWith('access-') || !file.endsWith('.log')) continue

      const filePath = path.join(LOGS_DIR, file)
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath)
      }
    }
  } catch (err) {
    console.error('[logger] Cleanup error:', err.message)
  }
}

// Run cleanup every hour
cleanupTimer = setInterval(cleanup, 60 * 60 * 1000)
if (cleanupTimer.unref) cleanupTimer.unref()

// Initial cleanup on load
cleanup()

module.exports = { getClientIp, log, cleanup }
