/**
 * PIPEE Gateway Client
 *
 * Lightweight client for any sub-project to call Gateway tools.
 * Zero dependencies — uses built-in fetch.
 *
 * Usage:
 *   const gw = require('../../sdk/gateway')
 *   const result = await gw.call('meetube_search', { q: 'React' })
 *   const tools = await gw.tools()
 *   const result = await gw.pipe('youtube-to-flashcards', { query: 'React' })
 */

const { readFileSync } = require('fs')
const { join } = require('path')

const CONFIG_PATH = join(__dirname, '..', 'config.json')

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function createClient(opts = {}) {
  const config = loadConfig()
  const baseUrl = opts.url
    || process.env.PIPEE_URL
    || `http://localhost:${config.port || 8787}`
  const token = opts.serviceToken
    || process.env.PIPEE_TOKEN
    || config.serviceToken
    || ''

  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${token}`,
  }

  async function request(method, path, body, retries = 1) {
    const url = `${baseUrl}${path}`
    const fetchOpts = { method, headers }
    if (body !== undefined) {
      fetchOpts.body = JSON.stringify(body)
    }

    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, fetchOpts)
        const text = await res.text()

        let data
        try { data = JSON.parse(text) } catch { data = text }

        if (!res.ok) {
          // Don't retry client errors (4xx)
          if (res.status >= 400 && res.status < 500) {
            const err = new Error((data && data.error) || `HTTP ${res.status}`)
            err.status = res.status
            err.data = data
            throw err
          }
          // Server errors (5xx) — retry
          lastErr = new Error((data && data.error) || `HTTP ${res.status}`)
          lastErr.status = res.status
          lastErr.data = data
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
            continue
          }
          throw lastErr
        }

        return data
      } catch (err) {
        // Don't retry client errors
        if (err.status && err.status >= 400 && err.status < 500) throw err
        lastErr = err
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
      }
    }

    throw lastErr
  }

  return {
    /**
     * Call a gateway tool by name
     * @param {string} toolName - e.g. 'myapp_search', 'myapp_upload'
     * @param {object} params - tool parameters
     * @returns {Promise<{ok, status, data}>}
     */
    call(toolName, params = {}) {
      return request('POST', '/api/gateway/call', { tool: toolName, params })
    },

    /**
     * List all available gateway tools
     * @param {string} [project] - filter by project ID
     * @returns {Promise<{tools, total}>}
     */
    tools(project) {
      const qs = project ? `?project=${encodeURIComponent(project)}` : ''
      return request('GET', `/api/gateway/tools${qs}`)
    },

    /**
     * Execute a pipeline
     * @param {string} pipelineId - e.g. 'youtube-to-flashcards'
     * @param {object} input - pipeline input
     * @returns {Promise<{success, steps, result}>}
     */
    pipe(pipelineId, input = {}) {
      return request('POST', '/api/gateway/pipeline', { pipeline: pipelineId, input })
    },

    /**
     * List all available pipelines
     * @returns {Promise<{pipelines}>}
     */
    pipelines() {
      return request('GET', '/api/gateway/pipelines')
    },

    /**
     * Force refresh the gateway tool cache
     * @returns {Promise<{success, tools}>}
     */
    refresh() {
      return request('POST', '/api/gateway/refresh')
    },
  }
}

// Default singleton (auto-configured from config.json)
const defaultClient = createClient()

module.exports = defaultClient
module.exports.createClient = createClient
