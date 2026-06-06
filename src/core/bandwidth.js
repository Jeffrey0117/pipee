/**
 * Pipee Per-Site Bandwidth Accounting
 *
 * Tracks bytes served per site per UTC day in memory and enforces the
 * owner's plan cap (PLANS.bandwidthPerDayBytes). Counters reset at UTC
 * midnight and on process restart — acceptable for abuse mitigation;
 * this is a brake on runaway free CDN usage, not a billing meter.
 */

const db = require('./db');

// slug -> { day: 'YYYY-MM-DD', bytes }
const counters = new Map();

// slug -> { limit, expires } — avoids a users JOIN on every static request.
const LIMIT_CACHE_TTL_MS = 60 * 1000;
const limitCache = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Daily byte allowance for a site, from its owner's effective plan.
// Unknown slug (no DB row) gets the free cap rather than unlimited.
function getDailyLimit(slug) {
  const now = Date.now();
  const cached = limitCache.get(slug);
  if (cached && cached.expires > now) return cached.limit;

  let limit = db.PLANS.free.bandwidthPerDayBytes;
  try {
    const owner = db.getSiteOwner(slug);
    if (owner) {
      const plan = db.PLANS[db.effectivePlan(owner)] || db.PLANS.free;
      limit = plan.bandwidthPerDayBytes;
    }
  } catch (err) {
    console.error('[bandwidth] Plan lookup failed for', slug, err.message);
  }

  limitCache.set(slug, { limit, expires: now + LIMIT_CACHE_TTL_MS });
  if (limitCache.size > 10000) limitCache.clear();
  return limit;
}

function usedToday(slug) {
  const entry = counters.get(slug);
  if (!entry || entry.day !== todayKey()) return 0;
  return entry.bytes;
}

// True when the site has already served its daily allowance.
function isOverLimit(slug) {
  return usedToday(slug) >= getDailyLimit(slug);
}

// Record bytes served for a site (call after choosing the file to send).
function recordBytes(slug, bytes) {
  if (!bytes) return;
  const day = todayKey();
  const entry = counters.get(slug);
  if (!entry || entry.day !== day) {
    counters.set(slug, { day, bytes });
    if (counters.size > 10000) {
      // Drop stale days so the map stays bounded.
      for (const [key, value] of counters) {
        if (value.day !== day) counters.delete(key);
      }
    }
    return;
  }
  counters.set(slug, { day, bytes: entry.bytes + bytes });
}

// Seconds until UTC midnight — used as Retry-After on 503 responses.
function secondsUntilReset() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

module.exports = { isOverLimit, recordBytes, usedToday, secondsUntilReset };
