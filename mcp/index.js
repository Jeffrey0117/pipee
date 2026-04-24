/**
 * PIPEE MCP Server
 * Core tools + auto-discovered project tools
 */

const { readFileSync } = require('fs')
const { join } = require('path')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')
const Pipee = require('../sdk')
const { registerCoreTools } = require('./core-tools')
const McpDiscovery = require('./discovery')
const { loadAuthConfig, getAuthToken, resolvePath, buildFetchOptions } = require('../src/core/gateway-fetch')

const PIPEE_URL = process.env.PIPEE_URL
const PIPEE_PASSWORD = process.env.PIPEE_PASSWORD

if (!PIPEE_URL || !PIPEE_PASSWORD) {
  console.error('PIPEE_URL and PIPEE_PASSWORD env vars are required')
  process.exit(1)
}

const client = new Pipee({ url: PIPEE_URL, password: PIPEE_PASSWORD })

const server = new McpServer({
  name: 'pipee',
  version: '2.0.0',
})

// --- Register core platform tools ---
registerCoreTools(server, client)

// --- Build Zod schema from JSON Schema parameters ---
function buildZodSchema(params) {
  if (!params || !params.properties) return {}

  const schema = {}
  const required = new Set(params.required || [])

  for (const [key, prop] of Object.entries(params.properties)) {
    let field

    switch (prop.type) {
      case 'number':
      case 'integer':
        field = z.number()
        break
      case 'boolean':
        field = z.boolean()
        break
      case 'array':
        field = z.array(z.any())
        break
      case 'object':
        field = z.object({}).passthrough()
        break
      default:
        field = z.string()
    }

    if (prop.enum) {
      field = z.enum(prop.enum)
    }

    if (prop.description) {
      field = field.describe(prop.description)
    }

    if (!required.has(key)) {
      field = field.optional()
    }

    schema[key] = field
  }

  return schema
}

// --- Auth config (shared via gateway-fetch) ---
const authConfig = loadAuthConfig()

// --- Register auto-discovered project tools ---
async function registerDiscoveredTools() {
  const discovery = new McpDiscovery({
    PIPEEUrl: PIPEE_URL,
    PIPEEPassword: PIPEE_PASSWORD,
  })

  const tools = await discovery.discoverAll()

  for (const tool of tools) {
    const zodSchema = buildZodSchema(tool.parameters)
    const hasParams = Object.keys(zodSchema).length > 0

    const handler = async (params) => {
      try {
        const path = resolvePath(tool.path, params || {})
        const url = `${tool.baseUrl}${path}`
        const opts = buildFetchOptions(tool, params || {}, authConfig)

        // Add query params for GET requests
        let fetchUrl = url
        if (tool.method === 'GET' && params && Object.keys(params).length > 0) {
          const pathParamNames = (tool.path.match(/\{(\w+)\}/g) || []).map(p => p.slice(1, -1))
          const queryEntries = Object.entries(params).filter(([k]) => !pathParamNames.includes(k))
          if (queryEntries.length > 0) {
            const qs = new URLSearchParams(queryEntries).toString()
            fetchUrl = `${url}?${qs}`
          }
        }

        const res = await fetch(fetchUrl, { ...opts, signal: AbortSignal.timeout(15000) })
        const text = await res.text()

        let formatted
        try {
          formatted = JSON.stringify(JSON.parse(text), null, 2)
        } catch {
          formatted = text
        }

        if (!res.ok) {
          return { content: [{ type: 'text', text: `HTTP ${res.status}: ${formatted}` }], isError: true }
        }

        return { content: [{ type: 'text', text: formatted }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
      }
    }

    if (hasParams) {
      server.tool(tool.name, tool.description, zodSchema, handler)
    } else {
      server.tool(tool.name, tool.description, handler)
    }
  }

  return tools.length
}

// --- Register pipeline tools ---
function registerPipelineTools() {
  let pipelineModule
  try {
    pipelineModule = require('../src/core/pipeline')
  } catch {
    console.error('[mcp] Pipeline module not found, skipping pipeline tools')
    return 0
  }

  const pipelines = pipelineModule.listPipelines()
  let count = 0

  for (const p of pipelines) {
    const toolName = `pipeline_${p.id}`
    const description = `[Pipeline] ${p.name}: ${p.description}`

    // Build Zod schema from pipeline input definition
    let pipelineDef
    try {
      pipelineDef = pipelineModule.getPipeline(p.id)
    } catch {
      continue
    }
    if (!pipelineDef) continue

    const zodSchema = {}
    if (pipelineDef.input) {
      for (const [key, spec] of Object.entries(pipelineDef.input)) {
        let field = z.string()
        if (spec.description) field = field.describe(spec.description)
        if (!spec.required) field = field.optional()
        zodSchema[key] = field
      }
    }

    const handler = async (params) => {
      try {
        const gateway = require('../src/core/gateway')
        // Ensure gateway is initialized
        if (gateway.getTools().length === 0) {
          await gateway.refreshTools()
        }
        const result = await pipelineModule.execute(pipelineDef, params || {})
        const formatted = JSON.stringify(result, null, 2)
        if (!result.success) {
          return { content: [{ type: 'text', text: `Pipeline failed: ${formatted}` }], isError: true }
        }
        return { content: [{ type: 'text', text: formatted }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Pipeline error: ${err.message}` }], isError: true }
      }
    }

    if (Object.keys(zodSchema).length > 0) {
      server.tool(toolName, description, zodSchema, handler)
    } else {
      server.tool(toolName, description, handler)
    }
    count++
  }

  return count
}

// --- Start ---
async function main() {
  const discoveredCount = await registerDiscoveredTools()
  const pipelineCount = registerPipelineTools()

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`PIPEE MCP server started (8 core + ${discoveredCount} discovered + ${pipelineCount} pipeline tools)`)
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err)
  process.exit(1)
})
