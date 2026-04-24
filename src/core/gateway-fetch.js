/**
 * Gateway Fetch — shared HTTP call logic for MCP + Gateway
 *
 * Extracted from mcp/index.js so both the MCP server and
 * the internal gateway can call project APIs without duplication.
 */

const { readFileSync } = require('fs')
const { join } = require('path')

const AUTH_CONFIG_PATH = join(__dirname, '..', '..', 'data', 'manifests', 'auth.json')
const ROOT_DIR = join(__dirname, '..', '..')
const PROJECTS_DIR = join(ROOT_DIR, 'projects')

// --- .env loader (reads sub-project .env files for token resolution) ---

const _envCache = new Map()
const ENV_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function loadProjectEnv(projectId, envDir) {
  const cacheKey = envDir || projectId
  const cached = _envCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < ENV_CACHE_TTL) return cached.env

  let dir
  if (envDir) {
    dir = require('path').isAbsolute(envDir) ? envDir : join(ROOT_DIR, envDir)
  } else {
    dir = join(PROJECTS_DIR, projectId)
  }
  const envPath = join(dir, '.env')

  const env = {}
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx)
        const val = trimmed.slice(eqIdx + 1).replace(/^["']|["']$/g, '')
        env[key] = val
      }
    }
  } catch {}
  _envCache.set(cacheKey, { env, ts: Date.now() })
  return env
}

// --- Auth config ---

function loadAuthConfig() {
  try {
    const raw = readFileSync(AUTH_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function getAuthToken(projectId, authConfig) {
  const config = authConfig[projectId]
  if (!config || config.type === 'none') return null
  if (config.env) {
    // 1. Check process env first (for vars set in ecosystem/system)
    if (process.env[config.env]) return process.env[config.env]
    // 2. Load from sub-project's .env file
    const projectEnv = loadProjectEnv(projectId, config.envDir)
    if (projectEnv[config.env]) return projectEnv[config.env]
  }
  // 3. Fallback to hardcoded token (legacy, should be migrated)
  if (config.token) return config.token
  return null
}

// --- Path resolution ---

function resolvePath(pathTemplate, params) {
  return pathTemplate.replace(/\{(\w+)\}/g, (_, key) => {
    const val = params[key]
    return val !== undefined ? encodeURIComponent(val) : `{${key}}`
  })
}

// --- Build fetch options ---

function buildFetchOptions(tool, params, authConfig) {
  const headers = { 'content-type': 'application/json' }

  if (tool.auth === 'bearer' || tool.auth === 'supabase') {
    const token = getAuthToken(tool.project, authConfig)
    if (token) {
      headers['authorization'] = `Bearer ${token}`
      if (tool.auth === 'supabase') {
        headers['apikey'] = token
      }
    }
  }

  const opts = { method: tool.method, headers }

  if (tool.method === 'POST' || tool.method === 'PUT' || tool.method === 'PATCH') {
    const pathParamNames = (tool.path.match(/\{(\w+)\}/g) || []).map(p => p.slice(1, -1))
    const bodyParams = {}
    for (const [key, val] of Object.entries(params)) {
      if (!pathParamNames.includes(key)) {
        bodyParams[key] = val
      }
    }
    opts.body = JSON.stringify(bodyParams)
  }

  return opts
}

// --- Full HTTP call ---

async function callTool(tool, params, authConfig) {
  const safeParams = params || {}
  const path = resolvePath(tool.path, safeParams)
  const url = `${tool.baseUrl}${path}`
  const opts = buildFetchOptions(tool, safeParams, authConfig)

  let fetchUrl = url
  if (tool.method === 'GET' && Object.keys(safeParams).length > 0) {
    const pathParamNames = (tool.path.match(/\{(\w+)\}/g) || []).map(p => p.slice(1, -1))
    const queryEntries = Object.entries(safeParams).filter(([k]) => !pathParamNames.includes(k))
    if (queryEntries.length > 0) {
      const qs = new URLSearchParams(queryEntries).toString()
      fetchUrl = `${url}?${qs}`
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  let res
  try {
    res = await fetch(fetchUrl, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
  const text = await res.text()

  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }

  return { status: res.status, ok: res.ok, data }
}

module.exports = {
  loadAuthConfig,
  getAuthToken,
  resolvePath,
  buildFetchOptions,
  callTool
}
