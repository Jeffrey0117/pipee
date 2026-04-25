/**
 * MCP Auto-Discovery Engine
 * 掃描 PIPEE 專案，自動從 manifest.json / openapi.json 產生 MCP tools
 *
 * Discovery order per project:
 *   1. Local manifest: data/manifests/{projectId}.json
 *   2. HTTP manifest:  http://localhost:{port}/api/manifest.json
 *   3. HTTP OpenAPI:   http://localhost:{port}/openapi.json
 */

const { readFileSync, readdirSync } = require('fs')
const { join } = require('path')
const PIPEE = require('../sdk')

const FETCH_TIMEOUT = 5000
const MANIFESTS_DIR = join(__dirname, '..', 'data', 'manifests')

class McpDiscovery {
  constructor({ PIPEEUrl, PIPEEPassword }) {
    this.client = new PIPEE({ url: PIPEEUrl, password: PIPEEPassword })
    this.tools = []
  }

  /**
   * 掃描所有專案，回傳 discovered tools
   */
  async discoverAll() {
    this.tools = []

    let projects
    try {
      projects = await this.client.projects.list()
    } catch (err) {
      console.error('[discovery] Failed to fetch projects:', err.message)
      return this.tools
    }

    // Build a map of projectId → project for local manifest matching
    const projectMap = new Map()
    for (const p of projects) {
      if (p.port) projectMap.set(p.id, p)
    }

    // 1) Load local manifests from data/manifests/
    const localManifestIds = new Set()
    try {
      const files = readdirSync(MANIFESTS_DIR)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const projectId = file.replace('.json', '')
        const project = projectMap.get(projectId)
        if (!project) {
          console.error(`[discovery] ${projectId}: local manifest found but no matching project`)
          continue
        }

        try {
          const raw = readFileSync(join(MANIFESTS_DIR, file), 'utf-8')
          const manifest = JSON.parse(raw)
          if (manifest.endpoints) {
            const tools = this._parseManifest(project, manifest)
            this.tools.push(...tools)
            localManifestIds.add(projectId)
            console.error(`[discovery] ${projectId}: ${tools.length} tools from local manifest`)
          }
        } catch (err) {
          console.error(`[discovery] ${projectId}: failed to parse local manifest:`, err.message)
        }
      }
    } catch {
      // data/manifests/ doesn't exist yet — that's fine
    }

    // 2) For projects without local manifests, try HTTP discovery
    const httpProjects = [...projectMap.values()].filter(p => !localManifestIds.has(p.id))

    const results = await Promise.allSettled(
      httpProjects.map(p => this._discoverProjectHttp(p))
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.length > 0) {
        this.tools.push(...result.value)
      }
    }

    console.error(`[discovery] Total: ${this.tools.length} tools from ${projects.length} projects`)
    return this.tools
  }

  /**
   * HTTP discovery for a single project: try manifest.json then openapi.json
   */
  async _discoverProjectHttp(project) {
    const baseUrl = `http://localhost:${project.port}`

    // Try /api/manifest.json
    const manifest = await this._fetchJson(`${baseUrl}/api/manifest.json`)
    if (manifest && manifest.endpoints) {
      const tools = this._parseManifest(project, manifest)
      console.error(`[discovery] ${project.id}: ${tools.length} tools from HTTP manifest`)
      return tools
    }

    // Fallback to /openapi.json
    const openapi = await this._fetchJson(`${baseUrl}/openapi.json`)
    if (openapi && openapi.paths) {
      const tools = this._parseOpenAPI(project, openapi)
      console.error(`[discovery] ${project.id}: ${tools.length} tools from openapi.json`)
      return tools
    }

    console.error(`[discovery] ${project.id}: no manifest or openapi found`)
    return []
  }

  /**
   * Fetch JSON with timeout, return null on failure
   */
  async _fetchJson(url) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  // --- Parsers ---

  /**
   * manifest.json → MCP tool definitions
   */
  _parseManifest(project, manifest) {
    return manifest.endpoints.map(ep => ({
      project: project.id,
      name: `${project.id}_${ep.name}`,
      description: `[${manifest.name || project.name}] ${ep.description}`,
      method: (ep.method || 'GET').toUpperCase(),
      path: ep.path,
      baseUrl: ep.baseUrl || manifest.baseUrl || `http://localhost:${project.port}`,
      auth: ep.auth || manifest.auth || 'none',
      parameters: ep.parameters || null,
      response: ep.response || null,
    }))
  }

  /**
   * OpenAPI spec → MCP tool definitions
   */
  _parseOpenAPI(project, openapi) {
    const tools = []
    const title = openapi.info?.title || project.name

    for (const [path, methods] of Object.entries(openapi.paths || {})) {
      for (const [method, spec] of Object.entries(methods)) {
        if (typeof spec !== 'object' || !spec) continue

        const opId = spec.operationId || this._pathToName(method, path)

        // Skip health/docs/internal endpoints
        if (this._shouldSkipEndpoint(opId, path)) continue

        tools.push({
          project: project.id,
          name: `${project.id}_${opId}`,
          description: `[${title}] ${spec.summary || spec.description || path}`,
          method: method.toUpperCase(),
          path,
          baseUrl: `http://localhost:${project.port}`,
          auth: this._detectAuth(spec, openapi),
          parameters: this._extractOpenAPIParams(spec, openapi),
          response: this._extractOpenAPIResponse(spec, openapi),
        })
      }
    }

    return tools
  }

  /**
   * Skip internal/utility endpoints
   */
  _shouldSkipEndpoint(opId, path) {
    const skipPatterns = ['health', 'openapi', 'docs', 'redoc', 'swagger', 'favicon']
    const lower = `${opId} ${path}`.toLowerCase()
    return skipPatterns.some(p => lower.includes(p))
  }

  /**
   * Generate operation name from method + path
   * e.g. GET /api/videos → get_videos
   */
  _pathToName(method, path) {
    const clean = path
      .replace(/^\/api\//, '')
      .replace(/\{[^}]+\}/g, 'by_id')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
    return `${method}_${clean}`.toLowerCase()
  }

  /**
   * Detect auth requirement from OpenAPI spec
   */
  _detectAuth(spec, openapi) {
    if (spec.security && spec.security.length > 0) return 'bearer'
    if (openapi.security && openapi.security.length > 0) return 'bearer'
    return 'none'
  }

  /**
   * Extract parameters from OpenAPI requestBody + query/path params
   */
  _extractOpenAPIParams(spec, openapi) {
    const properties = {}
    const required = []

    // Path & query parameters
    if (spec.parameters) {
      for (const param of spec.parameters) {
        const resolved = param.$ref ? this._resolveRef(param.$ref, openapi) : param
        if (!resolved) continue
        properties[resolved.name] = {
          type: resolved.schema?.type || 'string',
          description: resolved.description || resolved.name,
        }
        if (resolved.schema?.enum) {
          properties[resolved.name].enum = resolved.schema.enum
        }
        if (resolved.required) {
          required.push(resolved.name)
        }
      }
    }

    // Request body
    if (spec.requestBody) {
      const body = spec.requestBody.$ref
        ? this._resolveRef(spec.requestBody.$ref, openapi)
        : spec.requestBody
      const jsonSchema = body?.content?.['application/json']?.schema
      if (jsonSchema) {
        const resolved = jsonSchema.$ref ? this._resolveRef(jsonSchema.$ref, openapi) : jsonSchema
        if (resolved?.properties) {
          for (const [key, val] of Object.entries(resolved.properties)) {
            const prop = val.$ref ? this._resolveRef(val.$ref, openapi) : val
            properties[key] = {
              type: prop?.type || 'string',
              description: prop?.description || key,
            }
            if (prop?.enum) {
              properties[key].enum = prop.enum
            }
            if (prop?.default !== undefined) {
              properties[key].default = prop.default
            }
          }
          if (resolved.required) {
            required.push(...resolved.required)
          }
        }
      }
    }

    if (Object.keys(properties).length === 0) return null

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    }
  }

  /**
   * Extract response schema from OpenAPI
   */
  _extractOpenAPIResponse(spec, openapi) {
    const success = spec.responses?.['200'] || spec.responses?.['201']
    if (!success) return null
    const jsonSchema = success.content?.['application/json']?.schema
    if (!jsonSchema) return null
    return jsonSchema.$ref ? this._resolveRef(jsonSchema.$ref, openapi) : jsonSchema
  }

  /**
   * Resolve $ref in OpenAPI spec
   */
  _resolveRef(ref, openapi) {
    if (!ref || !ref.startsWith('#/')) return null
    const parts = ref.replace('#/', '').split('/')
    let current = openapi
    for (const part of parts) {
      current = current?.[part]
      if (!current) return null
    }
    return current
  }
}

module.exports = McpDiscovery
