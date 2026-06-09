/**
 * Thin fetch wrapper over the live Pipee API (pipee.tw / cloudpipe core).
 * Auth is the long-lived deploy token sent as a Bearer credential.
 */
const config = require('./config');

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(method, pathname, { token, body, contentType } = {}) {
  const headers = {};
  if (token) headers['authorization'] = 'Bearer ' + token;
  if (contentType) headers['content-type'] = contentType;

  let res;
  try {
    res = await fetch(config.getApiBase() + pathname, { method, headers, body });
  } catch (err) {
    throw new ApiError(`Cannot reach ${config.getApiBase()} (${err.message})`, 'NETWORK', 0);
  }

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const msg = (json && json.error) || `HTTP ${res.status}`;
    const code = (json && json.code) || `HTTP_${res.status}`;
    throw new ApiError(msg, code, res.status);
  }
  return json;
}

function me(token) {
  return request('GET', '/api/auth/me', { token });
}

function sites(token) {
  return request('GET', '/api/user/sites', { token });
}

function deploy(token, slug, zipBuffer) {
  return request('POST', '/api/user/deploy?slug=' + encodeURIComponent(slug), {
    token,
    body: zipBuffer,
    contentType: 'application/zip',
  });
}

function deleteSite(token, slug) {
  return request('DELETE', '/api/user/sites/' + encodeURIComponent(slug), { token });
}

function dataInfo(token, slug) {
  return request('GET', '/api/user/sites/' + encodeURIComponent(slug) + '/data', { token });
}

function dataEnable(token, slug) {
  return request('POST', '/api/user/sites/' + encodeURIComponent(slug) + '/data/enable', { token });
}

module.exports = { ApiError, me, sites, deploy, deleteSite, dataInfo, dataEnable };
