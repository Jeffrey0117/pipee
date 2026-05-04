/**
 * AI Session Store
 *
 * Stores Claude CLI session IDs per user+slug combination.
 * Sessions auto-expire after 4 hours of inactivity.
 */

const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours
const MAX_SESSIONS = 200; // Prevent unbounded memory growth

// Map<"userId:slug", { sessionId, lastUsed }>
const sessions = new Map();

function getSessionKey(userId, slug) {
  return `${userId}:${slug}`;
}

function getSessionId(userId, slug) {
  const key = getSessionKey(userId, slug);
  const entry = sessions.get(key);
  if (!entry) return null;

  if (Date.now() - entry.lastUsed > SESSION_TTL) {
    sessions.delete(key);
    return null;
  }

  entry.lastUsed = Date.now();
  return entry.sessionId;
}

function setSessionId(userId, slug, sessionId) {
  const key = getSessionKey(userId, slug);
  sessions.set(key, { sessionId, lastUsed: Date.now() });

  // Evict oldest sessions if over limit
  if (sessions.size > MAX_SESSIONS) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, entry] of sessions) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) sessions.delete(oldestKey);
  }
}

function clearSession(userId, slug) {
  const key = getSessionKey(userId, slug);
  sessions.delete(key);
}

// Periodic cleanup of expired sessions (every 30 min)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastUsed > SESSION_TTL) {
      sessions.delete(key);
    }
  }
}, 30 * 60 * 1000).unref();

module.exports = { getSessionId, setSessionId, clearSession };
