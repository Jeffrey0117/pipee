/**
 * Admin Tunnel Handlers
 *
 * Tunnel takeover status, mode switching, manual enforce.
 * Extracted from admin.js for maintainability.
 */

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

async function handleTunnelStatus(req, res) {
  try {
    const tunnelTakeover = require('../tunnel-takeover')
    const status = await tunnelTakeover.getStatus()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(status))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleTunnelMode(req, res) {
  try {
    const data = await parseJsonBody(req)
    if (!data.mode) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Missing mode field' }))
    }
    const tunnelTakeover = require('../tunnel-takeover')
    const result = await tunnelTakeover.setMode(data.mode)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, ...result }))
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

async function handleTunnelEnforce(req, res) {
  try {
    const tunnelTakeover = require('../tunnel-takeover')
    const result = await tunnelTakeover.enforce()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ success: true, ...result }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
}

module.exports = { handleTunnelStatus, handleTunnelMode, handleTunnelEnforce }
