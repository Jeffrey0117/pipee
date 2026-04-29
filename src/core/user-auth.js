/**
 * LetMeUse User Authentication
 *
 * Decodes LetMeUse JWT tokens and resolves/creates users.
 * Tokens are trusted internally (issued by LetMeUse SDK on client side).
 */

const db = require('./db');

/**
 * Decode a LetMeUse JWT without signature verification.
 * We trust these tokens because they come from the LetMeUse SDK.
 * @param {string} token - JWT string
 * @returns {{ sub: string, email?: string, name?: string } | null}
 */
function decodeLetmeuseToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Find user by LetMeUse sub, or create one. Handles race conditions where
 * two concurrent requests try to create the same user.
 * @param {{ sub: string, email?: string, name?: string }} payload
 * @returns {object} user record
 */
function resolveOrCreateUser(payload) {
  let user = db.getUserByLetmeuseSub(payload.sub);
  if (user) return user;

  try {
    return db.createUser({
      letmeuse_sub: payload.sub,
      email: payload.email || null,
      name: payload.name || null,
    });
  } catch (err) {
    // UNIQUE constraint violation — another request created it first
    user = db.getUserByLetmeuseSub(payload.sub);
    if (user) return user;
    throw err;
  }
}

/**
 * Extract LetMeUse token from request, decode it, and resolve or create the user.
 * @param {import('http').IncomingMessage} req
 * @returns {{ user: object, token: string } | null}
 */
function verifyUserRequest(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  const payload = decodeLetmeuseToken(token);
  if (!payload) return null;

  const user = resolveOrCreateUser(payload);
  return { user, token };
}

module.exports = { decodeLetmeuseToken, resolveOrCreateUser, verifyUserRequest };
