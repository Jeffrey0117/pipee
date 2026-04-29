/**
 * In-Memory Rate Limiter
 *
 * Replaces Redis-based rate limiting (INCR/EXPIRE) with a local
 * fixed-window Map. Single-machine deployment doesn't need cross-machine
 * coordination, and this eliminates ~97% of Redis operations.
 */

const RATE_LIMIT_GLOBAL = 200  // req/min per IP
const RATE_LIMIT_WRITE = 60    // write req/min per IP
const DEPLOY_LIMIT = 10        // deploys/min per IP
const USER_DEPLOY_LIMIT = 5    // deploys/min per user
const USER_API_LIMIT = 30      // API req/min per user

// Map<string, { count: number, resetAt: number }>
const globalBuckets = new Map()
const writeBuckets = new Map()
const deployBuckets = new Map()
const userDeployBuckets = new Map()
const userApiBuckets = new Map()

/**
 * Check a fixed-window bucket for a given key.
 * Returns null if allowed, or { retryAfter } if blocked.
 */
function checkBucket(buckets, key, limit) {
  const now = Date.now()
  const entry = buckets.get(key)

  if (!entry || now >= entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60000 })
    return null
  }

  entry.count++
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
    return { limit, remaining: 0, retryAfter }
  }

  return null
}

/**
 * Check rate limit for an HTTP request.
 * @param {string} ip - Client IP
 * @param {string} method - HTTP method
 * @returns {{ limit: number, remaining: number, retryAfter: number } | null}
 */
function checkRateLimit(ip, method) {
  // Global limit
  const globalBlocked = checkBucket(globalBuckets, ip, RATE_LIMIT_GLOBAL)
  if (globalBlocked) return globalBlocked

  // Write limit (POST/PUT/DELETE)
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const writeBlocked = checkBucket(writeBuckets, ip, RATE_LIMIT_WRITE)
    if (writeBlocked) return writeBlocked
  }

  return null
}

/**
 * Check deploy-specific rate limit.
 * @param {string} ip - Client IP
 * @returns {{ retryAfter: number } | null}
 */
function checkDeployRateLimit(ip) {
  return checkBucket(deployBuckets, ip, DEPLOY_LIMIT)
}

/**
 * Check per-user deploy rate limit.
 * @param {string} userId - User ID
 * @returns {{ retryAfter: number } | null}
 */
function checkUserDeployRateLimit(userId) {
  return checkBucket(userDeployBuckets, userId, USER_DEPLOY_LIMIT)
}

/**
 * Check per-user API rate limit.
 * @param {string} userId - User ID
 * @returns {{ retryAfter: number } | null}
 */
function checkUserApiRateLimit(userId) {
  return checkBucket(userApiBuckets, userId, USER_API_LIMIT)
}

// Cleanup expired entries every 60 seconds
setInterval(() => {
  const now = Date.now()
  for (const buckets of [globalBuckets, writeBuckets, deployBuckets, userDeployBuckets, userApiBuckets]) {
    for (const [key, entry] of buckets) {
      if (now >= entry.resetAt) {
        buckets.delete(key)
      }
    }
  }
}, 60000).unref()

module.exports = { checkRateLimit, checkDeployRateLimit, checkUserDeployRateLimit, checkUserApiRateLimit }
