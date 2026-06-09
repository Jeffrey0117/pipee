/**
 * Pipee Data API (BaaS)
 *
 * A lightweight per-site datastore for paid plans. Static sites read and write
 * JSON records over a public REST API, gated by a per-site API key and
 * per-collection access rules. Backed by pipee's own SQLite — no external
 * service, mirroring the self-contained design of the rest of pipee.
 *
 * Routes (all under /api/db):
 *   POST   /api/db/{slug}/{collection}        create a record (write rule)
 *   GET    /api/db/{slug}/{collection}        list records   (read rule)
 *   GET    /api/db/{slug}/{collection}/{id}   get one record (read rule)
 *   PATCH  /api/db/{slug}/{collection}/{id}   update a record (write rule)
 *   DELETE /api/db/{slug}/{collection}/{id}   delete a record (write rule)
 *
 * Auth:
 *   - Visitors present `x-pipee-key`, which must equal the site's data_api_key.
 *     Access is then governed by the collection's read/write rule.
 *   - The site owner (a Pipee JWT Bearer token whose user owns the site)
 *     bypasses all rules for dashboard use.
 *
 * CORS is `*` because auth is header-based (x-pipee-key / authorization), not
 * cookie-based — browsers never auto-attach those, so wildcard leaks nothing.
 */

const crypto = require('crypto');
const { URL } = require('url');
const db = require('./db');
const { verifyToken } = require('./user-auth');
const { getClientIp, rateLimit } = require('./rate-limit');

// Plans whose owners may use the Data API at all.
const DATA_PLANS = new Set(['pro', 'creator']);

const MAX_BODY = 64 * 1024;   // 64 KB per record
const MAX_LIST_LIMIT = 100;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const COLLECTION_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Separate read/write budgets, keyed per slug + client IP.
const RATE = {
  read:  { max: 120, windowMs: 60 * 1000 },
  write: { max: 30,  windowMs: 60 * 1000 },
  // The public key lives in front-end JS by design, so it can be harvested.
  // This per-site aggregate write cap (IP-independent) is the flood backstop:
  // distributed spam can't burn the whole record quota in seconds.
  siteWrite: { max: 300, windowMs: 60 * 1000 },
};

// ── HTTP helpers ──

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-pipee-key,authorization',
    'access-control-max-age': '86400',
  };
}

function json(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...corsHeaders(), ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function collectJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('BAD_JSON')); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Path + rules ──

// /api/db/{slug}/{collection}[/{id}] → { slug, collection, recordId }
function parsePath(pathname) {
  const m = pathname.match(/^\/api\/db\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!m) return null;
  return { slug: m[1], collection: m[2], recordId: m[3] || null };
}

// A collection's effective access. Unlisted collections fall back to
// `_default`, which is deny-all unless the owner opens it.
function resolveRule(rulesJson, collection) {
  let rules = {};
  try { rules = JSON.parse(rulesJson || '{}'); } catch { /* deny-all on corruption */ }
  const r = (rules && (rules[collection] || rules._default)) || { read: 'none', write: 'none' };
  return { read: r.read === 'public', write: r.write === 'public' };
}

// True when the request carries a valid Pipee JWT for the site's owner.
function isOwner(req, site, config) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return false;
  const payload = verifyToken(authHeader.slice(7), config.jwtSecret);
  return !!(payload && payload.userId === site.user_id);
}

// ── Main handler ──

async function handle(req, res, pathname, config) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  const parsed = parsePath(pathname);
  if (!parsed) return json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });

  const { slug, collection, recordId } = parsed;
  if (!SLUG_RE.test(slug) || !COLLECTION_RE.test(collection)) {
    return json(res, 400, { error: 'Invalid path', code: 'BAD_PATH' });
  }
  if (recordId && !RECORD_ID_RE.test(recordId)) {
    return json(res, 400, { error: 'Invalid record id', code: 'BAD_ID' });
  }

  const site = db.getSite(slug);
  if (!site) return json(res, 404, { error: 'Site not found', code: 'NO_SITE' });

  // Feature gate: the owner must currently hold an active Pro+ plan.
  const owner = db.getUserById(site.user_id);
  if (!owner || !DATA_PLANS.has(db.effectivePlan(owner))) {
    return json(res, 403, { error: 'Data API not available on this plan', code: 'PLAN_REQUIRED' });
  }

  // The Data API must be explicitly enabled (a key provisioned) for the site.
  if (!site.data_api_key) {
    return json(res, 404, { error: 'Data API not enabled for this site', code: 'NOT_ENABLED' });
  }

  const ownerReq = isOwner(req, site, config);

  // Visitors must present the site's public key; owners may skip it.
  if (!ownerReq) {
    const key = req.headers['x-pipee-key'] || '';
    if (!safeEqual(key, site.data_api_key)) {
      return json(res, 401, { error: 'Invalid or missing API key', code: 'BAD_KEY' });
    }
  }

  const isWrite = req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE';

  // Rate limit per client IP, with separate read/write budgets per site.
  const ip = getClientIp(req, config.trustProxy);
  const policy = isWrite ? RATE.write : RATE.read;
  const rl = rateLimit(`db:${isWrite ? 'w' : 'r'}:${slug}:${ip}`, policy.max, policy.windowMs);
  if (!rl.allowed) {
    return json(res, 429, { error: 'Too many requests', code: 'RATE_LIMITED' }, { 'retry-after': String(rl.retryAfterSec) });
  }

  // Per-site aggregate write flood backstop (IP-independent).
  if (isWrite) {
    const sl = rateLimit(`db:wsite:${slug}`, RATE.siteWrite.max, RATE.siteWrite.windowMs);
    if (!sl.allowed) {
      return json(res, 429, { error: 'This site is receiving too many writes. Try again shortly.', code: 'SITE_RATE_LIMITED' }, { 'retry-after': String(sl.retryAfterSec) });
    }
  }

  const rule = resolveRule(site.data_rules, collection);
  const canRead = ownerReq || rule.read;
  const canWrite = ownerReq || rule.write;

  try {
    if (req.method === 'POST' && !recordId) {
      if (!canWrite) return forbidden(res, 'write');
      return await createRecord(req, res, site, owner, collection);
    }
    if (req.method === 'GET' && !recordId) {
      if (!canRead) return forbidden(res, 'read');
      return listRecords(req, res, slug, collection);
    }
    if (req.method === 'GET' && recordId) {
      if (!canRead) return forbidden(res, 'read');
      const rec = db.getRecord(slug, collection, recordId);
      return rec ? json(res, 200, { record: rec }) : notFound(res);
    }
    if (req.method === 'PATCH' && recordId) {
      if (!canWrite) return forbidden(res, 'write');
      const body = await collectJson(req, MAX_BODY);
      const rec = db.updateRecord(slug, collection, recordId, body);
      return rec ? json(res, 200, { record: rec }) : notFound(res);
    }
    if (req.method === 'DELETE' && recordId) {
      if (!canWrite) return forbidden(res, 'write');
      return db.deleteRecord(slug, collection, recordId)
        ? json(res, 200, { ok: true })
        : notFound(res);
    }
    return json(res, 405, { error: 'Method not allowed', code: 'BAD_METHOD' });
  } catch (err) {
    if (err.message === 'BODY_TOO_LARGE') return json(res, 413, { error: 'Record too large', code: 'TOO_LARGE' });
    if (err.message === 'BAD_JSON') return json(res, 400, { error: 'Invalid JSON', code: 'BAD_JSON' });
    console.error(`[data-api] ${slug}/${collection}:`, err.message);
    return json(res, 500, { error: 'Internal error', code: 'INTERNAL' });
  }
}

function forbidden(res, kind) {
  return json(res, 403, { error: `${kind === 'write' ? 'Writes' : 'Reads'} not allowed for this collection`, code: 'FORBIDDEN' });
}

function notFound(res) {
  return json(res, 404, { error: 'Record not found', code: 'NO_RECORD' });
}

async function createRecord(req, res, site, owner, collection) {
  // Account-wide record quota.
  const plan = db.PLANS[db.effectivePlan(owner)] || db.PLANS.free;
  if (db.countRecordsByUser(owner.id) >= (plan.maxDataRecords || 0)) {
    return json(res, 403, { error: 'Record quota reached for your plan', code: 'QUOTA' });
  }
  const data = await collectJson(req, MAX_BODY);
  const recordId = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const rec = db.createRecord({ slug: site.slug, collection, recordId, data });
  return json(res, 201, { record: rec });
}

function listRecords(req, res, slug, collection) {
  const url = new URL(req.url, 'http://internal');
  let limit = parseInt(url.searchParams.get('limit'), 10);
  let offset = parseInt(url.searchParams.get('offset'), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > MAX_LIST_LIMIT) limit = MAX_LIST_LIMIT;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const records = db.listRecords(slug, collection, { limit, offset });
  return json(res, 200, { records, limit, offset });
}

module.exports = { handle, parsePath };
