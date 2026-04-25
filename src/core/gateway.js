/**
 * PIPEE Internal Gateway
 *
 * Lets any project call any other project's API through a single endpoint.
 * Uses MCP discovery to build a tool cache and exposes:
 *   GET  /api/gateway/tools      — list all available tools
 *   POST /api/gateway/call       — call a tool: { tool, params }
 *   GET  /api/gateway/pipelines  — list pipelines
 *   POST /api/gateway/pipeline   — run a pipeline: { pipeline, input }
 */

const path = require('path')
const McpDiscovery = require('../../mcp/discovery')
const { loadAuthConfig, callTool } = require('./gateway-fetch')
const auth = require('./auth')
const fs = require('fs')

const CONFIG_PATH = path.join(__dirname, '../../config.json')

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

// --- State ---
let toolCache = new Map()   // name → tool definition
let authConfig = {}
let initialized = false

// --- Call statistics ---
const callStats = new Map()  // toolName → { calls, errors, totalMs }
const statsStartedAt = Date.now()

function recordCallStat(toolName, durationMs, ok) {
  const stat = callStats.get(toolName) || { calls: 0, errors: 0, totalMs: 0 }
  callStats.set(toolName, {
    calls: stat.calls + 1,
    errors: ok ? stat.errors : stat.errors + 1,
    totalMs: stat.totalMs + durationMs,
  })
}

// --- Init / Refresh ---

async function refreshTools() {
  const config = getConfig()
  const PIPEEUrl = config.PIPEEUrl || `http://localhost:${config.port || 8787}`
  const PIPEEPassword = config.adminPassword || ''

  const discovery = new McpDiscovery({
    PIPEEUrl,
    PIPEEPassword,
  })

  try {
    const tools = await discovery.discoverAll()
    const newCache = new Map()
    for (const tool of tools) {
      newCache.set(tool.name, tool)
    }
    toolCache = newCache
    authConfig = loadAuthConfig()
    initialized = true
    console.log(`[gateway] Loaded ${toolCache.size} tools`)
  } catch (err) {
    console.error('[gateway] Failed to refresh tools:', err.message)
  }
}

// --- Auth helpers ---

function isAuthorized(req) {
  // Check serviceToken header
  const config = getConfig()
  const authHeader = req.headers['authorization'] || ''

  if (config.serviceToken && authHeader === `Bearer ${config.serviceToken}`) {
    return true
  }

  // Check admin JWT
  const payload = auth.verifyRequest(req)
  return payload !== null
}

// --- Internal API (for pipeline / telegram) ---

async function callToolByName(name, params) {
  if (!initialized) {
    await refreshTools()
  }

  const tool = toolCache.get(name)
  if (!tool) {
    return { ok: false, status: 404, data: { error: `Tool not found: ${name}` } }
  }

  const start = Date.now()
  const result = await callTool(tool, params || {}, authConfig)
  recordCallStat(name, Date.now() - start, result.ok)
  return result
}

function getTools() {
  return [...toolCache.values()]
}

function getTool(name) {
  return toolCache.get(name) || null
}

// --- HTTP handler (router integration) ---

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

const gateway = {
  match(req) {
    const url = (req.url || '').split('?')[0]
    return url.startsWith('/api/gateway')
  },

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname

    // Lazy init
    if (!initialized) {
      await refreshTools()
    }

    // --- GET /api/gateway/tools ---
    if (req.method === 'GET' && pathname === '/api/gateway/tools') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Unauthorized' }))
      }

      const project = url.searchParams.get('project')
      let tools = [...toolCache.values()]

      if (project) {
        tools = tools.filter(t => t.project === project)
      }

      const summary = tools.map(t => ({
        name: t.name,
        project: t.project,
        method: t.method,
        path: t.path,
        description: t.description,
      }))

      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ tools: summary, total: summary.length }))
    }

    // --- POST /api/gateway/call ---
    if (req.method === 'POST' && pathname === '/api/gateway/call') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Unauthorized' }))
      }

      try {
        const body = await parseJsonBody(req)
        const { tool: toolName, params, args } = body
        const toolParams = params || args

        if (!toolName) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Missing "tool" field' }))
        }

        const result = await callToolByName(toolName, toolParams || {})

        res.writeHead(result.ok ? 200 : result.status || 502, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: err.message }))
      }
    }

    // --- GET /api/gateway/pipelines ---
    if (req.method === 'GET' && pathname === '/api/gateway/pipelines') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Unauthorized' }))
      }

      try {
        const pipeline = require('./pipeline')
        const pipelines = pipeline.listPipelines()
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ pipelines }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: err.message }))
      }
    }

    // --- POST /api/gateway/pipeline ---
    if (req.method === 'POST' && pathname === '/api/gateway/pipeline') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Unauthorized' }))
      }

      try {
        const body = await parseJsonBody(req)
        const { pipeline: pipelineId, input } = body

        if (!pipelineId) {
          res.writeHead(400, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Missing "pipeline" field' }))
        }

        const pipelineModule = require('./pipeline')
        const pipelineDef = pipelineModule.getPipeline(pipelineId)
        if (!pipelineDef) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: `Pipeline not found: ${pipelineId}` }))
        }

        const result = await pipelineModule.execute(pipelineDef, input || {})

        res.writeHead(result.success ? 200 : 500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: err.message }))
      }
    }

    // --- GET /api/gateway/stats ---
    if (req.method === 'GET' && pathname === '/api/gateway/stats') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Unauthorized' }))
      }

      const stats = [...callStats.entries()]
        .map(([name, s]) => ({
          tool: name,
          calls: s.calls,
          errors: s.errors,
          avgMs: s.calls > 0 ? Math.round(s.totalMs / s.calls) : 0,
        }))
        .sort((a, b) => b.calls - a.calls)

      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        since: new Date(statsStartedAt).toISOString(),
        uptimeMinutes: Math.round((Date.now() - statsStartedAt) / 60000),
        totalCalls: stats.reduce((sum, s) => sum + s.calls, 0),
        totalErrors: stats.reduce((sum, s) => sum + s.errors, 0),
        tools: stats,
      }))
    }

    // --- POST /api/gateway/refresh ---
    if (req.method === 'POST' && pathname === '/api/gateway/refresh') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Unauthorized' }))
      }

      await refreshTools()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ success: true, tools: toolCache.size }))
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  },

  // Exposed for pipeline / telegram / server.js
  refreshTools,
  callToolByName,
  getTools,
  getTool,
}

module.exports = gateway
