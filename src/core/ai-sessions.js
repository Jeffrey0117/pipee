/**
 * AI Session Store
 *
 * Manages Claude CLI session IDs per user+slug combination.
 * Sessions auto-expire after 4 hours of inactivity.
 */

const SESSION_TTL = 4 * 60 * 60 * 1000; // 4 hours

// Map<"userId:slug", { sessionId, lastUsed }>
const sessions = new Map();

function getSessionKey(userId, slug) {
  return `${userId}:${slug}`;
}

function getSession(userId, slug) {
  const key = getSessionKey(userId, slug);
  const entry = sessions.get(key);
  if (!entry) return null;

  if (Date.now() - entry.lastUsed > SESSION_TTL) {
    sessions.delete(key);
    return null;
  }

  return entry.sessionId;
}

function setSession(userId, slug, sessionId) {
  const key = getSessionKey(userId, slug);
  sessions.set(key, { sessionId, lastUsed: Date.now() });
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

module.exports = { getSession, setSession };
