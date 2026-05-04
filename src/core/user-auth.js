/**
 * Pipee Local Authentication
 *
 * Simple username/password auth with crypto.scrypt + JWT.
 * No external auth services needed.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

/**
 * Hash a password with a random salt using scrypt.
 * @param {string} password
 * @returns {{ hash: string, salt: string }}
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

/**
 * Verify a password against a stored hash and salt.
 * @param {string} password
 * @param {string} hash
 * @param {string} salt
 * @returns {boolean}
 */
function verifyPassword(password, hash, salt) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
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
  generateToken,
  verifyToken,
  verifyUserRequest,
};
