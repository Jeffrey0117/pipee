/**
 * Atomic Config Writer
 *
 * Centralizes config.json read/write to prevent race conditions
 * when multiple modules (admin, tunnel-takeover) write concurrently.
 *
 * Uses write-to-tmp + renameSync for atomic filesystem operations
 * and an in-process mutex to serialize concurrent writes.
 */

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '../../config.json')

let writing = false
const writeQueue = []

/**
 * Read current config.json (always fresh from disk).
 */
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Atomically update config.json with a shallow merge.
 * - Reads current config
 * - Merges patch (shallow)
 * - Writes to .tmp file
 * - Renames .tmp → config.json (atomic on same filesystem)
 * - Serialized via in-process mutex
 *
 * @param {object} patch - Key-value pairs to merge into config
 * @returns {Promise<object>} The merged config
 */
function updateConfig(patch) {
  return new Promise((resolve, reject) => {
    writeQueue.push({ patch, resolve, reject })
    if (!writing) {
      processQueue()
    }
  })
}

function processQueue() {
  if (writeQueue.length === 0) {
    writing = false
    return
  }

  writing = true
  const { patch, resolve, reject } = writeQueue.shift()

  try {
    const config = readConfig()
    const merged = { ...config, ...patch }
    const tmpPath = CONFIG_PATH + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2))
    fs.renameSync(tmpPath, CONFIG_PATH)
    resolve(merged)
  } catch (err) {
    reject(err)
  }

  // Process next in queue (via microtask to avoid stack overflow)
  Promise.resolve().then(processQueue)
}

module.exports = { readConfig, updateConfig }
