/**
 * PIPEE SDK
 * 用 fetch() 呼叫 PIPEE Admin API
 */

class Pipee {
  constructor({ url, password, token } = {}) {
    if (!url) throw new Error('url is required')
    this.url = url.replace(/\/$/, '')
    this._password = password
    this._token = token || null

    this.projects = {
      list: () => this._get('/api/_admin/deploy/projects').then(r => r.projects),
      get: (id) => this._get(`/api/_admin/deploy/projects/${enc(id)}`),
      create: (data) => this._post('/api/_admin/deploy/projects', data),
      update: (id, data) => this._put(`/api/_admin/deploy/projects/${enc(id)}`, data),
      delete: (id) => this._delete(`/api/_admin/deploy/projects/${enc(id)}`),
    }

    this.deployments = {
      list: () => this._get('/api/_admin/deploy/deployments').then(r => r.deployments),
      get: (id) => this._get(`/api/_admin/deploy/deployments/${enc(id)}`),
    }

    this.services = {
      list: () => this._get('/api/_admin/services'),
    }
  }

  deploy(id) {
    return this._post(`/api/_admin/deploy/projects/${enc(id)}/deploy`)
  }

  restart(id) {
    return this._post(`/api/_admin/deploy/projects/${enc(id)}/restart`)
  }

  rollback(id, commit) {
    const body = commit ? { commit } : undefined
    return this._post(`/api/_admin/deploy/projects/${enc(id)}/rollback`, body)
  }

  initRepo(id, options) {
    return this._post(`/api/_admin/deploy/projects/${enc(id)}/init-repo`, options)
  }

  status() {
    return this._get('/api/_admin/deploy/projects').then(r => r.projects)
  }

  system() {
    return this._get('/api/_admin/system')
  }

  machines() {
    return this._get('/api/_admin/machines')
  }

  logs(pm2Name) {
    return this._get(`/api/_admin/deploy/logs/${enc(pm2Name)}`)
  }

  // --- internal ---

  async _ensureToken() {
    if (this._token) return
    if (!this._password) throw new Error('No token or password provided')

    const res = await fetch(`${this.url}/api/_admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: this._password }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Login failed (${res.status})`)
    }

    const data = await res.json()
    this._token = data.token
  }

  async _request(method, path, body) {
    await this._ensureToken()

    const opts = {
      method,
      headers: {
        'authorization': `Bearer ${this._token}`,
        'content-type': 'application/json',
      },
    }
    if (body !== undefined) {
      opts.body = JSON.stringify(body)
    }

    const res = await fetch(`${this.url}${path}`, opts)

    // Token expired — re-login once and retry
    if (res.status === 401 && this._password) {
      this._token = null
      await this._ensureToken()
      opts.headers.authorization = `Bearer ${this._token}`
      const retry = await fetch(`${this.url}${path}`, opts)
      return handleResponse(retry)
    }

    return handleResponse(res)
  }

  _get(path) { return this._request('GET', path) }
  _post(path, body) { return this._request('POST', path, body) }
  _put(path, body) { return this._request('PUT', path, body) }
  _delete(path) { return this._request('DELETE', path) }
}

function enc(s) {
  return encodeURIComponent(s)
}

async function handleResponse(res) {
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }

  if (!res.ok) {
    const msg = (data && data.error) || `HTTP ${res.status}`
    const err = new Error(msg)
    err.status = res.status
    err.data = data
    throw err
  }

  return data
}

module.exports = Pipee
module.exports.Pipee = Pipee
module.exports.gateway = require('./gateway')
module.exports.telegram = require('./telegram')
