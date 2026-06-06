/**
 * Pipee Rate Limiting
 *
 * In-memory sliding-window rate limiter + real client IP extraction.
 * No Redis or external store; a Map of recent hit timestamps per key,
 * which is enough for a single-process server.
 */

// Longest window any caller uses; idle keys older than this get swept.
const MAX_WINDOW_MS = 60 * 60 * 1000;
const SWEEP_EVERY_CALLS = 500;

// key -> number[] (hit timestamps, ascending)
const hits = new Map();
let callsSinceSweep = 0;

// ── Client IP ──
// In production pipee sits behind Cloudflare (or another reverse proxy), so
// the socket address is the proxy's — the real client arrives in headers.
// Preference order: CF-Connecting-IP (set by Cloudflare, can't be spoofed
// through CF) > X-Real-IP > leftmost X-Forwarded-For entry > socket address.
// If the server is ever exposed directly, set `trustProxy: false` in
// config.json so spoofed headers can't rotate identities.

function getClientIp(req, trustProxy = true) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();

    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();

    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ── Sliding window limiter ──
// Returns { allowed, remaining, retryAfterSec }. Callers respond 429 with
// Retry-After when !allowed. Keys should be namespaced, e.g. `register:1.2.3.4`.

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = (hits.get(key) || []).filter((t) => t > cutoff);

  maybeSweep(now);

  if (recent.length >= max) {
    // Oldest relevant hit decides when a slot frees up.
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    hits.set(key, recent);
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  hits.set(key, [...recent, now]);
  return { allowed: true, remaining: max - recent.length - 1, retryAfterSec: 0 };
}

// Drop keys whose newest hit is older than any window we support, so the map
// can't grow unboundedly from one-off visitors.
function maybeSweep(now) {
  callsSinceSweep += 1;
  if (callsSinceSweep < SWEEP_EVERY_CALLS) return;
  callsSinceSweep = 0;

  const cutoff = now - MAX_WINDOW_MS;
  for (const [key, stamps] of hits) {
    if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) {
      hits.delete(key);
    }
  }
}

module.exports = { getClientIp, rateLimit };
