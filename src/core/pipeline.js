/**
 * PIPEE Pipeline Engine
 *
 * Chains multiple gateway calls into a workflow.
 * Each step's output flows into the next step's input via template syntax:
 *   {{input.query}}           — pipeline input
 *   {{steps.search.data[0].title}} — previous step result
 */

const fs = require('fs')
const path = require('path')

const PIPELINES_DIR = path.join(__dirname, '../../data/pipelines')

// --- Template resolution ---

/**
 * Resolve {{...}} templates in a value using context
 * Supports dot notation and bracket indexing: steps.search.data[0].title
 */
function resolveTemplate(value, context) {
  if (typeof value !== 'string') return value

  // If entire string is a single template, return raw value (preserve type)
  const singleMatch = value.match(/^\{\{([^}]+)\}\}$/)
  if (singleMatch) {
    return getNestedValue(context, singleMatch[1].trim())
  }

  // String interpolation mode
  return value.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    const resolved = getNestedValue(context, expr.trim())
    return resolved !== undefined ? String(resolved) : ''
  })
}

function getNestedValue(obj, pathStr) {
  // Handle bracket notation: data[0].title → data.0.title
  const normalized = pathStr.replace(/\[(\d+)\]/g, '.$1')
  const parts = normalized.split('.')

  let current = obj
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      return undefined
    }
    if (current === null || current === undefined) return undefined
    current = current[part]
  }
  return current
}

/**
 * Deep-resolve all template strings in an object
 */
function resolveParams(params, context) {
  if (typeof params === 'string') {
    return resolveTemplate(params, context)
  }

  if (Array.isArray(params)) {
    return params.map(item => resolveParams(item, context))
  }

  if (params && typeof params === 'object') {
    const resolved = {}
    for (const [key, val] of Object.entries(params)) {
      resolved[key] = resolveParams(val, context)
    }
    return resolved
  }

  return params
}

// --- Pipeline CRUD ---

function listPipelines() {
  try {
    const files = fs.readdirSync(PIPELINES_DIR)
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const raw = fs.readFileSync(path.join(PIPELINES_DIR, f), 'utf-8')
          const def = JSON.parse(raw)
          return {
            id: def.id,
            name: def.name,
            description: def.description,
            inputSchema: def.input || null,
            steps: (def.steps || []).length,
          }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function getPipeline(id) {
  try {
    const filePath = path.join(PIPELINES_DIR, `${id}.json`)
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// --- Execution ---

const MAX_PIPELINE_DEPTH = 5
const _executionStack = new Set()

async function execute(pipelineDef, input) {
  const gateway = require('./gateway')

  // 循環偵測：防止 pipeline A → pipeline B → pipeline A 無限遞迴
  const pipelineId = pipelineDef.id || 'anonymous'
  if (_executionStack.has(pipelineId)) {
    return { success: false, error: `Circular pipeline detected: ${pipelineId}`, steps: {} }
  }
  if (_executionStack.size >= MAX_PIPELINE_DEPTH) {
    return { success: false, error: `Pipeline depth exceeded (max ${MAX_PIPELINE_DEPTH})`, steps: {} }
  }
  _executionStack.add(pipelineId)

  try {
    return await _executeInner(pipelineDef, input, gateway)
  } finally {
    _executionStack.delete(pipelineId)
  }
}

async function _executeInner(pipelineDef, input, gateway) {
  // Validate required inputs
  if (pipelineDef.input) {
    for (const [key, spec] of Object.entries(pipelineDef.input)) {
      if (spec.required && (input[key] === undefined || input[key] === '')) {
        return { success: false, error: `Missing required input: ${key}`, steps: {} }
      }
    }
  }

  const steps = pipelineDef.steps || []
  const context = { input, steps: {} }
  const results = {}
  let lastResult = null

  for (const step of steps) {
    const resolvedParams = resolveParams(step.params || {}, context)

    try {
      const result = await gateway.callToolByName(step.tool, resolvedParams)

      results[step.id] = {
        tool: step.tool,
        params: resolvedParams,
        ok: result.ok,
        status: result.status,
        data: result.data,
      }

      // Make step result available to subsequent steps
      context.steps[step.id] = { data: result.data, ok: result.ok, status: result.status }
      lastResult = result

      if (!result.ok && !step.continueOnError) {
        return {
          success: false,
          failedAt: step.id,
          error: `Step "${step.id}" failed: HTTP ${result.status}`,
          steps: results,
          result: result.data,
        }
      }
    } catch (err) {
      results[step.id] = {
        tool: step.tool,
        params: resolvedParams,
        ok: false,
        error: err.message,
      }

      if (!step.continueOnError) {
        return {
          success: false,
          failedAt: step.id,
          error: `Step "${step.id}" threw: ${err.message}`,
          steps: results,
        }
      }

      context.steps[step.id] = { data: null, ok: false, error: err.message }
    }
  }

  return {
    success: true,
    steps: results,
    result: lastResult ? lastResult.data : null,
  }
}

module.exports = {
  listPipelines,
  getPipeline,
  execute,
}
