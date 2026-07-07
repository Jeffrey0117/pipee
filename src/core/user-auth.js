/**
 * Pipee Local Authentication
 *
 * Simple username/password auth with crypto.scrypt + JWT.
 * No external auth services needed.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);

/**
 * Hash a password with a random salt using scrypt.
 * Async so the KDF (deliberately CPU-heavy) runs off the event loop and can't
 * be turned into a DoS by hammering register/login.
 * @param {string} password
 * @returns {Promise<{ hash: string, salt: string }>}
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return { hash: derived.toString('hex'), salt };
}

/**
 * Verify a password against a stored hash and salt.
 * @param {string} password
 * @param {string} hash
 * @param {string} salt
 * @returns {Promise<boolean>}
 */
async function verifyPassword(password, hash, salt) {
  const derived = await scrypt(password, salt, 64);
  const hashBuf = Buffer.from(hash, 'hex');
  if (derived.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(derived, hashBuf);
}

// Constant-work verify for a non-existent user: runs a real scrypt against a
// throwaway salt so login latency doesn't reveal whether a username exists
// (timing oracle). Result is discarded; caller always returns "invalid".
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
async function dummyVerify(password) {
  try { await scrypt(String(password || ''), DUMMY_SALT, 64); } catch { /* ignore */ }
  return false;
}

/**
 * Generate a JWT token for a user.
 * @param {number} userId
 * @param {string} jwtSecret
 * @returns {string}
 */
function generateToken(userId, jwtSecret) {
  return jwt.sign({ userId }, jwtSecret, { expiresIn: '30d' });
}

/**
 * Verify a JWT token and return the decoded payload.
 * @param {string} token
 * @param {string} jwtSecret
 * @returns {{ userId: number } | null}
 */
function verifyToken(token, jwtSecret) {
  try {
    return jwt.verify(token, jwtSecret);
  } catch {
    return null;
  }
}

/**
 * Extract Bearer token from request, verify JWT, and return the user.
 * @param {import('http').IncomingMessage} req
 * @param {{ jwtSecret: string }} config
 * @returns {{ user: object } | null}
 */
function verifyUserRequest(req, config) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const payload = verifyToken(token, config.jwtSecret);
  if (!payload || !payload.userId) return null;

  const user = db.getUserById(payload.userId);
  if (!user) return null;

  return { user };
}

module.exports = {
  hashPassword,
  verifyPassword,
  dummyVerify,
  generateToken,
  verifyToken,
  verifyUserRequest,
};
