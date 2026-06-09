/**
 * Pipee User API
 *
 * Handles user registration, login, and site management.
 * Auth via local JWT (username/password).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { hashPassword, verifyPassword, generateToken, verifyUserRequest } = require('./user-auth');
const { validateSlug, STATIC_DIR } = require('./static');
const { deployFromGit, deployFromGitAtSha } = require('./git-deploy');
const { getClientIp, rateLimit } = require('./rate-limit');
const gitea = require('./gitea');
const aiEditor = require('./ai-editor');
const aiSessions = require('./ai-sessions');

const { PLANS, subscriptionActive, effectivePlan } = db;
const AI_ALLOWED_PLANS = new Set(['pro', 'creator']);
const GIT_DASHBOARD_PLANS = new Set(['pro', 'creator']);

const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_EXTRACTED_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_FILES_PER_SITE = 5000;

// Forbidden file extensions
const FORBIDDEN_EXTENSIONS = new Set(['.exe', '.dll', '.bat', '.ps1', '.cmd', '.com', '.scr', '.msi']);

// ── JSON helpers ──

function jsonOk(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(data));
}

function jsonErr(res, error, code, status) {
  res.writeHead(status, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ error, code }));
}

// ── Email helpers ──

// Pragmatic RFC-5321-ish check: one @, no spaces, a dot in the domain.
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

// subscriptionActive / effectivePlan live in db.js (next to PLANS) so other
// modules (e.g. bandwidth accounting) can resolve entitlements too.

// ── Rate limiting ──
// In-memory sliding windows keyed by client IP (unauthenticated endpoints),
// user id (authenticated), or slug (webhooks). Single source of truth for
// the per-endpoint policies.

const RATE_LIMITS = {
  register:      { max: 5,  windowMs: 60 * 60 * 1000 }, // per IP — scripted mass sign-ups
  login:         { max: 20, windowMs: 10 * 60 * 1000 }, // per IP — credential stuffing
  deploy:        { max: 20, windowMs: 10 * 60 * 1000 }, // per user — all deploy flavors
  webhookDeploy: { max: 10, windowMs: 10 * 60 * 1000 }, // per slug — push-storm hammering
  setEmail:      { max: 5,  windowMs: 60 * 60 * 1000 }, // per user — outbound mail bombing
};

// Returns true (and ends the response with 429) when the caller is over the
// limit for `name`; callers should `return` immediately on true.
function tooManyRequests(res, name, key) {
  const policy = RATE_LIMITS[name];
  const result = rateLimit(`${name}:${key}`, policy.max, policy.windowMs);
  if (result.allowed) return false;
  res.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': String(result.retryAfterSec),
  });
  res.end(JSON.stringify({ error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' }));
  return true;
}

// ── Cloudflare Turnstile ──
// Only enforced when a secret is configured. Fail-closed: a token that can't
// be verified (bad, missing, or siteverify unreachable) rejects registration.

async function verifyTurnstile(token, ip, secret) {
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }).toString(),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    console.error('[pipee] Turnstile verification failed:', err.message);
    return false;
  }
}

// ── Storage quota ──
// Bytes a user may still deploy into `slug` without breaching the account-wide
// storage cap of their effective plan (the site's current size is freed by
// the deploy's atomic swap, so it doesn't count against the headroom).

function storageHeadroom(user, site) {
  const planConfig = PLANS[effectivePlan(user)] || PLANS.free;
  const otherSitesTotal = db.sumSiteSizesByUser(user.id) - (site.size || 0);
  return planConfig.maxStorageBytes - otherSitesTotal;
}

// ── Email verification ──
// An email only maps a PayGate subscription after the owner clicks a link, so
// nobody can pre-claim someone else's address to capture their payment.

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Stores a fresh (unverified) email + verification token on the user and
// emails the confirmation link. Returns { sent, verifyUrl } — verifyUrl is
// provided whenever the email could not be sent (dev / self-hosted fallback)
// so the account owner can still complete verification.
async function sendVerificationEmail(userId, email, config) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  db.updateUser(userId, {
    email,
    email_verified: 0,
    email_verify_token: hashToken(rawToken),
    email_verify_expires: new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString(),
  });

  const base = String(config.externalUrl || '').replace(/\/$/, '');
  const verifyUrl = `${base}/api/user/verify-email?token=${rawToken}`;

  const mailer = config.mailer || {};
  if (!mailer.url) return { sent: false, verifyUrl };

  try {
    const html =
      '<p>Confirm this email to activate your Pipee subscription.</p>' +
      `<p><a href="${verifyUrl}">Verify email</a></p>` +
      '<p>This link expires in 24 hours. If you did not request it, ignore this email.</p>';
    const resp = await fetch(String(mailer.url).replace(/\/$/, '') + '/api/send', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(mailer.token ? { authorization: 'Bearer ' + mailer.token } : {}),
      },
      body: JSON.stringify({ to: email, subject: 'Verify your Pipee email', html, from: mailer.from }),
    });
    return { sent: resp.ok, verifyUrl: resp.ok ? null : verifyUrl };
  } catch {
    return { sent: false, verifyUrl };
  }
}

// Minimal styled HTML response for the email-clicked verification endpoint.
function htmlPage(res, status, heading, message) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Pipee</title>' +
    '<div style="font-family:system-ui,sans-serif;max-width:480px;margin:18vh auto;padding:2rem;text-align:center;color:#1a1a2e">' +
    `<h1 style="font-size:1.3rem;margin:0 0 .6rem">${heading}</h1>` +
    `<p style="color:#5a5a72;line-height:1.5;margin:0 0 1.5rem">${message}</p>` +
    '<a href="/console" style="color:#7c3aed;font-weight:600;text-decoration:none">→ Go to Console</a>' +
    '</div>'
  );
}

// ── Body collection ──

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Archive extraction (ZIP only for standalone) ──

function detectArchiveType(buffer) {
  if (buffer.length < 2) return null;
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) return 'zip';
  return null;
}

async function extractZip(buffer, destDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  fs.mkdirSync(destDir, { recursive: true });

  let fileCount = 0;
  let totalSize = 0;

  const normalizedDest = path.resolve(destDir) + path.sep;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const entryPath = entry.entryName;
    const resolved = path.resolve(destDir, entryPath);
    if (!resolved.startsWith(normalizedDest)) continue;

    const ext = path.extname(entryPath).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext)) {
      throw new Error(`FORBIDDEN_FILE:${ext}`);
    }

    fileCount++;
    if (fileCount > MAX_FILES_PER_SITE) {
      throw new Error('TOO_MANY_FILES');
    }

    totalSize += entry.header.size;
    if (totalSize > MAX_EXTRACTED_SIZE) {
      throw new Error('EXTRACTED_TOO_LARGE');
    }

    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, entry.getData());
  }

  return totalSize;
}

function getDirSize(dir) {
  let size = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      size += fs.statSync(fullPath).size;
    } else if (entry.isDirectory()) {
      size += getDirSize(fullPath);
    }
  }
  return size;
}

// ── Directory swap ──

function swapDirectory(slug, tempDir) {
  const targetDir = path.join(STATIC_DIR, slug);
  const oldDir = path.join(STATIC_DIR, `.old-${slug}-${Date.now()}`);

  if (fs.existsSync(targetDir)) {
    fs.renameSync(targetDir, oldDir);
  }

  try {
    fs.renameSync(tempDir, targetDir);
  } catch (err) {
    if (fs.existsSync(oldDir)) {
      try { fs.renameSync(oldDir, targetDir); } catch { /* best effort */ }
    }
    throw err;
  }

  if (fs.existsSync(oldDir)) {
    setTimeout(() => {
      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 1000);
  }
}

// ── URL helper ──

function getSiteUrl(req, slug, config) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (isLocal) return `http://${host}/_sites/${slug}/`;
  return `https://${slug}.${config.domain}`;
}

// ── Route handler ──

async function handle(req, res, pathname, config) {
  // POST /api/auth/register
  if (req.method === 'POST' && pathname === '/api/auth/register') {
    return handleRegister(req, res, config);
  }

  // POST /api/auth/login
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    return handleLogin(req, res, config);
  }

  // GET /api/user/me
  if (req.method === 'GET' && pathname === '/api/user/me') {
    return handleMe(req, res, config);
  }

  // GET /api/plans (public: tiers + checkout URLs for the pricing/upgrade UI)
  if (req.method === 'GET' && pathname === '/api/plans') {
    return handlePlans(req, res, config);
  }

  // GET /api/config (public: non-secret client config, e.g. Turnstile site key)
  if (req.method === 'GET' && pathname === '/api/config') {
    return jsonOk(res, {
      turnstile_site_key: (config.turnstile && config.turnstile.siteKey) || null,
    });
  }

  // PUT /api/user/email (set/update billing email for subscription mapping)
  if (req.method === 'PUT' && pathname === '/api/user/email') {
    return handleSetEmail(req, res, config);
  }

  // GET /api/user/verify-email?token=... (confirm email ownership via emailed link)
  if (req.method === 'GET' && pathname === '/api/user/verify-email') {
    return handleVerifyEmail(req, res, config);
  }

  // POST /api/webhooks/paygate (PayGate subscription events)
  if (req.method === 'POST' && pathname === '/api/webhooks/paygate') {
    return handlePaygateWebhook(req, res, config);
  }

  // GET /api/admin/overview (admin-only: all users + their sites)
  if (req.method === 'GET' && pathname === '/api/admin/overview') {
    return handleAdminOverview(req, res, config);
  }

  // GET /api/user/sites
  if (req.method === 'GET' && pathname === '/api/user/sites') {
    return handleUserSites(req, res, config);
  }

  // POST /api/user/sites
  if (req.method === 'POST' && pathname === '/api/user/sites') {
    return handleCreateSite(req, res, config);
  }

  // POST /api/user/sites/:slug/deploy
  const deployMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/deploy$/);
  if (req.method === 'POST' && deployMatch) {
    return handleDeploy(req, res, deployMatch[1], config);
  }

  // PUT /api/user/sites/:slug/settings
  const settingsMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/settings$/);
  if (req.method === 'PUT' && settingsMatch) {
    return handleUpdateSettings(req, res, settingsMatch[1], config);
  }

  // DELETE /api/user/sites/:slug
  const deleteSiteMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
  if (req.method === 'DELETE' && deleteSiteMatch) {
    return handleDeleteSite(req, res, deleteSiteMatch[1], config);
  }

  // POST /api/user/sites/:slug/link-repo
  const linkRepoMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/link-repo$/);
  if (req.method === 'POST' && linkRepoMatch) {
    return handleLinkRepo(req, res, linkRepoMatch[1], config);
  }

  // POST /api/user/sites/:slug/git-deploy
  const gitDeployMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/git-deploy$/);
  if (req.method === 'POST' && gitDeployMatch) {
    return handleGitDeploy(req, res, gitDeployMatch[1], config);
  }

  // POST /api/webhook/github/:slug (GitHub push -> auto deploy)
  const ghWebhookMatch = pathname.match(/^\/api\/webhook\/github\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
  if (req.method === 'POST' && ghWebhookMatch) {
    return handleGitHubWebhook(req, res, ghWebhookMatch[1], config);
  }

  // POST /api/webhook/:slug (Gitea push -> auto deploy)
  const webhookMatch = pathname.match(/^\/api\/webhook\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
  if (req.method === 'POST' && webhookMatch) {
    return handleWebhookDeploy(req, res, webhookMatch[1], config);
  }

  // POST /api/user/sites/:slug/ai-chat
  const aiChatMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/ai-chat$/);
  if (req.method === 'POST' && aiChatMatch) {
    return handleAiChat(req, res, aiChatMatch[1], config);
  }

  // DELETE /api/user/sites/:slug/ai-chat (clear session)
  const aiClearMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/ai-chat$/);
  if (req.method === 'DELETE' && aiClearMatch) {
    return handleAiClearSession(req, res, aiClearMatch[1], config);
  }

  // GET /api/user/sites/:slug/files
  const filesMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/files$/);
  if (req.method === 'GET' && filesMatch) {
    return handleListFiles(req, res, filesMatch[1], config);
  }

  // GET /api/user/sites/:slug/commits (Pro+ Git Dashboard)
  const commitsMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/commits$/);
  if (req.method === 'GET' && commitsMatch) {
    return handleGetCommits(req, res, commitsMatch[1], config);
  }

  // GET /api/user/sites/:slug/commits/:sha/diff (Pro+ Git Dashboard)
  const diffMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/commits\/([0-9a-f]{7,40})\/diff$/);
  if (req.method === 'GET' && diffMatch) {
    return handleGetCommitDiff(req, res, diffMatch[1], diffMatch[2], config);
  }

  // POST /api/user/sites/:slug/rollback (Pro+ Git Dashboard)
  const rollbackMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/rollback$/);
  if (req.method === 'POST' && rollbackMatch) {
    return handleRollback(req, res, rollbackMatch[1], config);
  }

  // POST /api/user/sites/:slug/link-github
  const linkGitHubMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/link-github$/);
  if (req.method === 'POST' && linkGitHubMatch) {
    return handleLinkGitHub(req, res, linkGitHubMatch[1], config);
  }

  // DELETE /api/user/sites/:slug/link-github
  const unlinkGitHubMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/link-github$/);
  if (req.method === 'DELETE' && unlinkGitHubMatch) {
    return handleUnlinkGitHub(req, res, unlinkGitHubMatch[1], config);
  }

  // GET/DELETE /api/user/sites/:slug/data (Data API status / disable)
  const dataInfoMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/data$/);
  if (req.method === 'GET' && dataInfoMatch) {
    return handleDataInfo(req, res, dataInfoMatch[1], config);
  }
  if (req.method === 'DELETE' && dataInfoMatch) {
    return handleDataDisable(req, res, dataInfoMatch[1], config);
  }

  // POST /api/user/sites/:slug/data/enable (provision API key — Pro+)
  const dataEnableMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/data\/enable$/);
  if (req.method === 'POST' && dataEnableMatch) {
    return handleDataEnable(req, res, dataEnableMatch[1], config);
  }

  // POST /api/user/sites/:slug/data/rotate-key (issue a fresh key)
  const dataRotateMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/data\/rotate-key$/);
  if (req.method === 'POST' && dataRotateMatch) {
    return handleDataRotateKey(req, res, dataRotateMatch[1], config);
  }

  // PUT /api/user/sites/:slug/data/rules (set per-collection access rules)
  const dataRulesMatch = pathname.match(/^\/api\/user\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])\/data\/rules$/);
  if (req.method === 'PUT' && dataRulesMatch) {
    return handleDataSetRules(req, res, dataRulesMatch[1], config);
  }

  return jsonErr(res, 'Not found', 'NOT_FOUND', 404);
}

// ── POST /api/auth/register ──

async function handleRegister(req, res, config) {
  const ip = getClientIp(req, config.trustProxy);
  if (tooManyRequests(res, 'register', ip)) return;

  let body;
  try {
    body = await collectBody(req, 8192);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  // Bot gate (active only when a Turnstile secret is configured).
  const turnstileSecret = config.turnstile && config.turnstile.secret;
  if (turnstileSecret) {
    const human = await verifyTurnstile(data.turnstile_token, ip, turnstileSecret);
    if (!human) {
      return jsonErr(res, 'CAPTCHA verification failed. Please try again.', 'CAPTCHA_FAILED', 403);
    }
  }

  if (!data.username || typeof data.username !== 'string' || data.username.trim().length < 3) {
    return jsonErr(res, 'Username must be at least 3 characters', 'BAD_REQUEST', 400);
  }
  if (!data.password || typeof data.password !== 'string' || data.password.length < 6) {
    return jsonErr(res, 'Password must be at least 6 characters', 'BAD_REQUEST', 400);
  }

  const username = data.username.trim().toLowerCase();

  if (!/^[a-z0-9_-]+$/.test(username)) {
    return jsonErr(res, 'Username can only contain lowercase letters, numbers, hyphens, and underscores', 'BAD_REQUEST', 400);
  }

  // Optional billing email (used to map PayGate subscriptions). Stored
  // unverified; a verification link is sent after the account is created.
  let email = null;
  if (data.email !== undefined && data.email !== null && String(data.email).trim() !== '') {
    email = normalizeEmail(data.email);
    if (!isValidEmail(email)) {
      return jsonErr(res, 'Invalid email address', 'BAD_REQUEST', 400);
    }
    if (db.getVerifiedUserByEmail(email)) {
      return jsonErr(res, 'Email already in use', 'CONFLICT', 409);
    }
  }

  // Check if username already exists
  const existing = db.getUserByUsername(username);
  if (existing) {
    return jsonErr(res, 'Username already taken', 'CONFLICT', 409);
  }

  const { hash, salt } = hashPassword(data.password);

  let user;
  try {
    user = db.createUser({ username, passwordHash: hash, salt, email });
  } catch (err) {
    // Race condition: username or email was taken between check and insert
    if (err.message && err.message.includes('UNIQUE')) {
      const taken = /email/i.test(err.message) ? 'Email already in use' : 'Username already taken';
      return jsonErr(res, taken, 'CONFLICT', 409);
    }
    throw err;
  }

  // Best-effort: kick off email verification (never blocks registration).
  if (email) {
    try { await sendVerificationEmail(user.id, email, config); } catch { /* non-fatal */ }
  }

  const token = generateToken(user.id, config.jwtSecret);

  return jsonOk(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email || null,
      email_verified: false,
      plan: user.plan,
      max_sites: user.max_sites,
    },
  }, 201);
}

// ── POST /api/auth/login ──

async function handleLogin(req, res, config) {
  if (tooManyRequests(res, 'login', getClientIp(req, config.trustProxy))) return;

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  if (!data.username || !data.password) {
    return jsonErr(res, 'Username and password are required', 'BAD_REQUEST', 400);
  }

  const username = data.username.trim().toLowerCase();
  const user = db.getUserByUsername(username);

  if (!user || !verifyPassword(data.password, user.password_hash, user.salt)) {
    return jsonErr(res, 'Invalid username or password', 'UNAUTHORIZED', 401);
  }

  const token = generateToken(user.id, config.jwtSecret);

  return jsonOk(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email || null,
      email_verified: !!user.email_verified,
      plan: user.plan,
      max_sites: user.max_sites,
    },
  });
}

// ── GET /api/user/me ──

function handleMe(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const siteCount = db.countSitesByUser(user.id);
  // Entitlements follow the effective plan so a lapsed subscription reverts
  // to free even if the `expired` webhook never arrived.
  const plan = effectivePlan(user);
  const planConfig = PLANS[plan] || PLANS.free;

  return jsonOk(res, {
    user: {
      id: user.id,
      username: user.username,
      email: user.email || null,
      email_verified: !!user.email_verified,
      plan: plan,
      plan_label: planConfig.label,
      max_sites: planConfig.maxSites,
      site_count: siteCount,
      ai_edits_used: user.ai_edits_used || 0,
      ai_edits_limit: planConfig.aiEditsPerMonth,
      ai_enabled: AI_ALLOWED_PLANS.has(plan),
      git_dashboard_enabled: GIT_DASHBOARD_PLANS.has(plan),
      sub_expires_at: user.sub_expires_at || null,
      sub_active: subscriptionActive(user),
    },
  });
}

// ── GET /api/plans ──
// Public catalogue of tiers + PAYUNi checkout URLs (from config). The frontend
// reads checkout_url from here so links can be changed without touching markup.

function handlePlans(req, res, config) {
  const checkout = (config.paygate && config.paygate.checkout) || {};
  const plans = Object.keys(PLANS).map((tier) => ({
    tier,
    label: PLANS[tier].label,
    max_sites: PLANS[tier].maxSites,
    ai_edits: PLANS[tier].aiEditsPerMonth,
    checkout_url: checkout[tier] || null,
  }));
  return jsonOk(res, { plans });
}

// ── PUT /api/user/email ──

async function handleSetEmail(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);
  const { user } = result;

  // Each call may send a verification email to an arbitrary address — limit
  // it so an account can't be scripted into an outbound mail cannon.
  if (tooManyRequests(res, 'setEmail', user.id)) return;

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const email = normalizeEmail(data.email || '');
  if (!isValidEmail(email)) {
    return jsonErr(res, 'Invalid email address', 'BAD_REQUEST', 400);
  }

  // Conflict only against a *verified* holder — an unverified pre-claim by
  // someone else must not block the real owner.
  const verifiedHolder = db.getVerifiedUserByEmail(email);
  if (verifiedHolder && verifiedHolder.id !== user.id) {
    return jsonErr(res, 'Email already in use', 'CONFLICT', 409);
  }

  // Already verified on this account and unchanged: nothing to do.
  if (email === (user.email || '') && user.email_verified) {
    return jsonOk(res, { email, email_verified: true, verification_sent: false });
  }

  let sendResult;
  try {
    sendResult = await sendVerificationEmail(user.id, email, config);
  } catch {
    return jsonErr(res, 'Failed to start email verification', 'INTERNAL', 500);
  }

  return jsonOk(res, {
    email,
    email_verified: false,
    verification_sent: sendResult.sent,
    verify_url: sendResult.verifyUrl || undefined,
  });
}

// ── GET /api/user/verify-email ──

function handleVerifyEmail(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const raw = url.searchParams.get('token') || '';
  if (!raw) {
    return htmlPage(res, 400, 'Invalid link', 'This verification link is missing its token.');
  }

  const user = db.getUserByVerifyToken(hashToken(raw));
  if (!user || !user.email) {
    return htmlPage(res, 400, 'Link invalid', 'This verification link is invalid or has already been used.');
  }
  if (!user.email_verify_expires || Date.parse(user.email_verify_expires) < Date.now()) {
    return htmlPage(res, 400, 'Link expired', 'This verification link has expired. Request a new one from the console.');
  }

  const holder = db.getVerifiedUserByEmail(user.email);
  if (holder && holder.id !== user.id) {
    return htmlPage(res, 409, 'Already verified', 'This email is already verified on another account.');
  }

  try {
    db.updateUser(user.id, {
      email_verified: 1,
      email_verify_token: null,
      email_verify_expires: null,
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return htmlPage(res, 409, 'Already verified', 'This email is already verified on another account.');
    }
    throw err;
  }

  return htmlPage(res, 200, 'Email verified', 'You can close this tab and continue your upgrade.');
}

// ── POST /api/webhooks/paygate ──
// PayGate posts subscription lifecycle events. We verify the HMAC signature,
// map the subscription to a local user by email, and adjust their plan.

function verifyWebhookSignature(rawBuffer, signature, secret) {
  if (!signature || typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    return false;
  }
  const provided = signature.slice(7);
  const expected = crypto.createHmac('sha256', secret).update(rawBuffer).digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

async function handlePaygateWebhook(req, res, config) {
  const paygate = config.paygate || {};
  const secret = paygate.webhookSecret;
  if (!secret) {
    return jsonErr(res, 'PayGate webhook not configured', 'NOT_CONFIGURED', 503);
  }

  let raw;
  try {
    raw = await collectBody(req, 64 * 1024);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  const signature = req.headers['x-webhook-signature'] || '';
  if (!verifyWebhookSignature(raw, signature, secret)) {
    return jsonErr(res, 'Invalid signature', 'UNAUTHORIZED', 401);
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const event = payload.event || '';
  const data = payload.data || {};
  const sub = data.subscription || {};
  const plan = data.plan || {};
  const product = paygate.product || 'pipee';

  // Ignore events for other products sharing this PayGate instance.
  if (sub.product && sub.product !== product) {
    return jsonOk(res, { success: true, ignored: 'product_mismatch' });
  }

  const email = sub.email ? normalizeEmail(sub.email) : '';
  // Only a *verified* owner of the email receives the plan, so a subscription
  // can never be captured by an account that merely claimed the address.
  const user = email ? db.getVerifiedUserByEmail(email) : null;

  // Acknowledge unmapped subscriptions so PayGate stops retrying; the user can
  // claim the subscription later by verifying this email on their account.
  if (!user) {
    return jsonOk(res, { success: true, mapped: false });
  }

  if (event === 'subscription.activated') {
    // Clamp tier to the known plan whitelist; unknown tier -> free.
    const tier = PLANS[String(sub.tier || plan.tier || '').toLowerCase()]
      ? String(sub.tier || plan.tier).toLowerCase()
      : 'free';
    const planConfig = PLANS[tier];
    // Only persist a parseable ISO date, else leave expiry open (null).
    const endDate = sub.end_date && !Number.isNaN(Date.parse(sub.end_date))
      ? sub.end_date : null;
    db.updateUser(user.id, {
      plan: tier,
      max_sites: planConfig.maxSites,
      sub_expires_at: endDate,
    });
  } else if (event === 'subscription.expired' || event === 'subscription.cancelled') {
    // Guard against stale / re-delivered events (webhooks are at-least-once):
    // only revoke once the paid period has actually lapsed. A fresh `activated`
    // carrying a future end_date therefore can't be wiped by an old `cancelled`,
    // and a cancellation keeps access until the period it was paid through ends.
    const stillPaid = user.sub_expires_at
      && Date.parse(user.sub_expires_at) > Date.now();
    if (!stillPaid) {
      db.updateUser(user.id, {
        plan: 'free',
        max_sites: PLANS.free.maxSites,
        sub_expires_at: null,
      });
    }
  }

  return jsonOk(res, { success: true });
}

// ── GET /api/user/sites ──

function handleUserSites(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const sites = db.listSitesByUser(user.id).map(s => ({
    slug: s.slug,
    url: getSiteUrl(req, s.slug, config),
    size: s.size,
    config: JSON.parse(s.config || '{}'),
    repo_url: s.repo_url || null,
    git_url: s.repo_url ? `${config.externalUrl}/git/${s.slug}.git` : null,
    branch: s.branch || null,
    last_commit: s.last_commit || null,
    deploy_method: s.deploy_method || 'upload',
    github_webhook_url: (s.deploy_method === 'github') ? `${config.externalUrl}/api/webhook/github/${s.slug}` : null,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  const planConfig = PLANS[effectivePlan(user)] || PLANS.free;

  return jsonOk(res, {
    sites,
    quota: { used: sites.length, max: planConfig.maxSites },
  });
}

// ── GET /api/admin/overview ──
// Admin-only cross-tenant view. Guarded by a STRICT id===1 check — NOT by plan,
// because a paying `creator` user must never see other tenants' data.

const ADMIN_USER_ID = 1;

function handleAdminOverview(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  if (user.id !== ADMIN_USER_ID) {
    return jsonErr(res, 'Forbidden', 'FORBIDDEN', 403);
  }

  const users = db.listAllUsersWithSites().map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email || null,
    email_verified: !!u.email_verified,
    plan: effectivePlan(u),
    sub_expires_at: u.sub_expires_at || null,
    created_at: u.created_at,
    sites: u.sites.map((s) => ({
      slug: s.slug,
      url: getSiteUrl(req, s.slug, config),
      size: s.size,
      deploy_method: s.deploy_method || 'upload',
      created_at: s.created_at,
      updated_at: s.updated_at,
    })),
  }));

  const totals = {
    users: users.length,
    sites: users.reduce((n, u) => n + u.sites.length, 0),
  };

  return jsonOk(res, { users, totals });
}

// ── POST /api/user/sites ──

async function handleCreateSite(req, res, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const slug = (data.slug || '').trim().toLowerCase();
  const slugError = validateSlug(slug);
  if (slugError) return jsonErr(res, slugError, 'INVALID_SLUG', 400);

  const { user } = result;

  // Anti-abuse: free-plan accounts must verify their email before they can
  // host anything. One verified email = one hosting-capable free account
  // (verified emails are uniquely indexed), which stops scripted mass
  // sign-ups from being used as free CDN/storage. Paid/creator accounts are
  // already email-verified via PayGate, so they're exempt.
  const plan = effectivePlan(user);
  if (plan === 'free' && !user.email_verified) {
    return jsonErr(res, 'Please verify your email before creating a site.', 'EMAIL_NOT_VERIFIED', 403);
  }

  // Check if slug already exists
  const existing = db.getSite(slug);
  if (existing) {
    return jsonErr(res, 'This slug is already taken', 'SLUG_TAKEN', 409);
  }

  // Quota check (plan-based)
  const planConfig = PLANS[plan] || PLANS.free;
  const count = db.countSitesByUser(user.id);
  if (count >= planConfig.maxSites) {
    return jsonErr(res, `Site limit reached (${planConfig.maxSites}). Upgrade your plan or delete a site.`, 'QUOTA_EXCEEDED', 402);
  }

  const site = db.createSite({ slug, userId: user.id });

  // Create the directory
  const siteDir = path.join(STATIC_DIR, slug);
  if (!fs.existsSync(siteDir)) {
    fs.mkdirSync(siteDir, { recursive: true });
  }

  // Auto-create Gitea repo if configured
  let repoInfo = null;
  if (gitea.isEnabled()) {
    try {
      repoInfo = await gitea.createSiteRepo(slug, config.externalUrl);
      if (repoInfo) {
        const siteConfig = { webhookSecret: repoInfo.webhook_secret };
        db.updateSite(slug, {
          repo_url: repoInfo.clone_url,
          branch: 'main',
          deploy_method: 'git',
          config: JSON.stringify(siteConfig),
        });
      }
    } catch (err) {
      console.error(`[pipee] Failed to create Gitea repo for ${slug}:`, err.message);
      // Non-fatal — site is still created, just without git
    }
  }

  return jsonOk(res, {
    slug: site.slug,
    url: getSiteUrl(req, slug, config),
    git_url: repoInfo ? `${config.externalUrl}/git/${slug}.git` : null,
  }, 201);
}

// ── POST /api/user/sites/:slug/deploy ──

async function handleDeploy(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  if (tooManyRequests(res, 'deploy', user.id)) return;

  // Ownership check
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  // Collect body
  let body;
  try {
    body = await collectBody(req, MAX_ARCHIVE_SIZE);
  } catch (err) {
    if (err.message === 'BODY_TOO_LARGE') {
      return jsonErr(res, 'Archive exceeds 50 MB limit', 'ARCHIVE_TOO_LARGE', 413);
    }
    return jsonErr(res, 'Failed to read request body', 'DEPLOY_FAILED', 500);
  }

  if (body.length === 0) {
    return jsonErr(res, 'Empty request body', 'DEPLOY_FAILED', 400);
  }

  // Detect archive type
  const archiveType = detectArchiveType(body);
  if (!archiveType) {
    return jsonErr(res, 'Unsupported format. Upload a ZIP file.', 'INVALID_FORMAT', 400);
  }

  // Extract to temp dir
  const tempDir = path.join(STATIC_DIR, `.tmp-${slug}-${Date.now()}`);
  let extractedSize;

  try {
    extractedSize = await extractZip(body, tempDir);
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

    if (err.message === 'EXTRACTED_TOO_LARGE') {
      return jsonErr(res, 'Extracted content exceeds 50 MB limit', 'ARCHIVE_TOO_LARGE', 413);
    }
    if (err.message === 'TOO_MANY_FILES') {
      return jsonErr(res, `Site exceeds ${MAX_FILES_PER_SITE} file limit`, 'TOO_MANY_FILES', 400);
    }
    if (err.message.startsWith('FORBIDDEN_FILE:')) {
      const ext = err.message.split(':')[1];
      return jsonErr(res, `${ext} files are not allowed`, 'FORBIDDEN_FILE', 400);
    }
    return jsonErr(res, 'Failed to extract archive', 'EXTRACTION_FAILED', 400);
  }

  // Validate: must have index.html
  if (!fs.existsSync(path.join(tempDir, 'index.html'))) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return jsonErr(res, 'Archive must contain index.html at the root', 'NO_INDEX_HTML', 400);
  }

  // Account-wide storage quota (checked before the swap so nothing goes live)
  if (extractedSize > storageHeadroom(user, site)) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return jsonErr(res, 'Account storage limit reached. Delete a site or upgrade your plan.', 'STORAGE_QUOTA_EXCEEDED', 413);
  }

  // Swap directories
  try {
    swapDirectory(slug, tempDir);
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return jsonErr(res, 'Failed to deploy site', 'DEPLOY_FAILED', 500);
  }

  // Update DB
  db.updateSite(slug, { size: extractedSize });

  const siteUrl = getSiteUrl(req, slug, config);

  return jsonOk(res, {
    url: siteUrl,
    slug,
    size: extractedSize,
  });
}

// ── PUT /api/user/sites/:slug/settings ──

async function handleUpdateSettings(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  // Merge settings into existing config (protect internal keys)
  const existingConfig = JSON.parse(site.config || '{}');
  const { webhookSecret: _ws, githubWebhookSecret: _gws, ...safeData } = data;
  const newConfig = { ...existingConfig, ...safeData };

  db.updateSite(slug, { config: JSON.stringify(newConfig) });

  return jsonOk(res, { slug, config: newConfig });
}

// ── DELETE /api/user/sites/:slug ──

async function handleDeleteSite(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  // Delete files
  const siteDir = path.join(STATIC_DIR, slug);
  try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Clean up Gitea repo (best effort)
  if (gitea.isEnabled() && site.repo_url) {
    try { await gitea.deleteSiteRepo(slug); } catch (err) {
      console.error(`[pipee] Failed to delete Gitea repo for ${slug}:`, err.message);
    }
  }

  // Drop the site's data records, then the site row itself.
  try { db.deleteRecordsBySite(slug); } catch (err) {
    console.error(`[pipee] Failed to delete data records for ${slug}:`, err.message);
  }
  db.deleteSite(slug);

  return jsonOk(res, { deleted: true });
}

// ── POST /api/user/sites/:slug/link-repo ──

async function handleLinkRepo(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const repoUrl = (data.repo_url || '').trim();
  const branch = (data.branch || 'main').trim();

  if (!repoUrl) {
    return jsonErr(res, 'repo_url is required', 'BAD_REQUEST', 400);
  }

  if (!repoUrl.startsWith('http://') && !repoUrl.startsWith('https://') && !repoUrl.startsWith('git@')) {
    return jsonErr(res, 'Invalid repo URL', 'BAD_REQUEST', 400);
  }

  db.updateSite(slug, {
    repo_url: repoUrl,
    branch,
    deploy_method: 'git',
  });

  return jsonOk(res, {
    slug,
    repo_url: repoUrl,
    branch,
    deploy_method: 'git',
  });
}

// ── POST /api/user/sites/:slug/git-deploy ──

async function handleGitDeploy(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  if (!site.repo_url) {
    return jsonErr(res, 'No git repo linked. Use link-repo first.', 'NO_REPO', 400);
  }

  if (tooManyRequests(res, 'deploy', user.id)) return;

  // Per-deploy cap: the per-site archive limit AND the account-wide quota.
  const maxBytes = Math.min(MAX_EXTRACTED_SIZE, storageHeadroom(user, site));
  if (maxBytes <= 0) {
    return jsonErr(res, 'Account storage limit reached. Delete a site or upgrade your plan.', 'STORAGE_QUOTA_EXCEEDED', 413);
  }

  try {
    const { commit, size } = deployFromGit(slug, site.repo_url, site.branch || 'main', { maxBytes });
    db.updateSite(slug, { last_commit: commit, size });

    const siteUrl = getSiteUrl(req, slug, config);

    return jsonOk(res, {
      url: siteUrl,
      slug,
      commit: commit.slice(0, 7),
      size,
    });
  } catch (err) {
    if (err.message === 'NO_INDEX_HTML') {
      return jsonErr(res, 'Repository must contain index.html at the root', 'NO_INDEX_HTML', 400);
    }
    if (err.message === 'SITE_TOO_LARGE') {
      return jsonErr(res, 'Repository exceeds your size or storage limit', 'SITE_TOO_LARGE', 413);
    }
    return jsonErr(res, 'Git deploy failed', 'DEPLOY_FAILED', 500);
  }
}

// ── POST /api/webhook/:slug (Gitea auto-deploy) ──

async function handleWebhookDeploy(req, res, slug, config) {
  const site = db.getSite(slug);
  if (!site) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Site not found' }));
  }

  if (!site.repo_url || site.deploy_method !== 'git') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Site not configured for git deploy' }));
  }

  if (tooManyRequests(res, 'webhookDeploy', slug)) return;

  // Verify Gitea signature if webhook secret is set
  const siteConfig = JSON.parse(site.config || '{}');
  if (siteConfig.webhookSecret) {
    let body;
    try {
      body = await collectBody(req, 1024 * 1024);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Failed to read body' }));
    }

    const signature = req.headers['x-gitea-signature'] || '';
    const expected = crypto.createHmac('sha256', siteConfig.webhookSecret).update(body).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid signature' }));
    }
  }

  // Respond immediately, deploy in background
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: 'Deploy triggered' }));

  try {
    const owner = db.getUserById(site.user_id);
    const maxBytes = Math.min(MAX_EXTRACTED_SIZE, Math.max(0, storageHeadroom(owner, site)));
    const { commit, size } = deployFromGit(slug, site.repo_url, site.branch || 'main', { maxBytes });
    db.updateSite(slug, { last_commit: commit, size });
    console.log(`[webhook] Deployed ${slug} from git (${commit.slice(0, 7)})`);
  } catch (err) {
    console.error(`[webhook] Git deploy failed for ${slug}:`, err.message);
  }
}

// ── AI Quota helpers ──

function checkAiQuota(user) {
  const planConfig = PLANS[effectivePlan(user)] || PLANS.free;
  const limit = planConfig.aiEditsPerMonth;
  const now = new Date();
  const resetAt = user.ai_edits_reset_at ? new Date(user.ai_edits_reset_at) : null;

  // Reset monthly quota if past reset date
  if (!resetAt || now >= resetAt) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    db.updateUser(user.id, { ai_edits_used: 0, ai_edits_reset_at: nextReset });
    return { allowed: true, used: 0, limit };
  }

  return {
    allowed: (user.ai_edits_used || 0) < limit,
    used: user.ai_edits_used || 0,
    limit,
  };
}

// ── POST /api/user/sites/:slug/ai-chat ──

async function handleAiChat(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  // Plan check
  if (!AI_ALLOWED_PLANS.has(effectivePlan(user))) {
    return jsonErr(res, 'AI Editor requires a Pro plan. Upgrade to unlock.', 'PLAN_REQUIRED', 403);
  }

  // Ownership check
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  // Quota check
  const quota = checkAiQuota(user);
  if (!quota.allowed) {
    return jsonErr(res, `Monthly AI edit limit reached (${quota.limit}). Resets next month.`, 'QUOTA_EXCEEDED', 429);
  }

  // Parse message
  let body;
  try {
    body = await collectBody(req, 16384);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const message = (data.message || '').trim();
  if (!message) {
    return jsonErr(res, 'Message is required', 'BAD_REQUEST', 400);
  }

  if (message.length > 4000) {
    return jsonErr(res, 'Message too long (max 4000 characters)', 'BAD_REQUEST', 400);
  }

  // Get existing session ID
  const sessionId = aiSessions.getSessionId(user.id, slug);

  try {
    const aiResult = await aiEditor.chat(slug, message, sessionId);

    // Save session ID for conversation continuity
    if (aiResult.sessionId) {
      aiSessions.setSessionId(user.id, slug, aiResult.sessionId);
    }

    // Increment quota if files were changed (re-read user for atomic update)
    if (aiResult.filesChanged.length > 0) {
      const freshUser = db.getUserById(user.id);
      const currentUsed = freshUser.ai_edits_used || 0;
      db.updateUser(user.id, { ai_edits_used: currentUsed + 1 });

      // Update site size
      const siteDir = path.join(STATIC_DIR, slug);
      if (fs.existsSync(siteDir)) {
        const newSize = getDirSize(siteDir);
        db.updateSite(slug, { size: newSize });
      }
    }

    const freshQuota = checkAiQuota(db.getUserById(user.id));

    return jsonOk(res, {
      reply: aiResult.reply,
      filesChanged: aiResult.filesChanged,
      quota: { used: freshQuota.used, limit: freshQuota.limit },
    });
  } catch (err) {
    console.error('[ai-editor] Chat error:', err.message);
    // Don't leak internal API error details to client
    const safeMsg = err.message && err.message.includes('timeout')
      ? 'AI request timed out. Please try again.'
      : 'AI request failed. Please try again.';
    return jsonErr(res, safeMsg, 'AI_ERROR', 502);
  }
}

// ── DELETE /api/user/sites/:slug/ai-chat ──

function handleAiClearSession(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  // Ownership check
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  aiSessions.clearSession(user.id, slug);

  return jsonOk(res, { cleared: true });
}

// ── GET /api/user/sites/:slug/files ──

function handleListFiles(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  const files = aiEditor.listSiteFiles(slug);

  return jsonOk(res, { files, total: files.length });
}

// ── GET /api/user/sites/:slug/commits (Pro+ Git Dashboard) ──

async function handleGetCommits(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  if (!GIT_DASHBOARD_PLANS.has(effectivePlan(user))) {
    return jsonErr(res, 'Git Dashboard requires a Pro plan. Upgrade to unlock.', 'PLAN_REQUIRED', 403);
  }

  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  if (!site.repo_url) {
    return jsonErr(res, 'No git repo linked', 'NO_REPO', 400);
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));

  try {
    const { commits, total } = await gitea.getRepoCommits(slug, { page, limit });

    return jsonOk(res, {
      commits: commits.map(c => ({
        sha: c.sha,
        message: (c.commit && c.commit.message) || '',
        author: (c.commit && c.commit.author && c.commit.author.name) || '',
        date: (c.commit && c.commit.author && c.commit.author.date) || '',
      })),
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error(`[pipee] Failed to get commits for ${slug}:`, err.message);
    return jsonErr(res, 'Failed to fetch commits', 'GIT_ERROR', 502);
  }
}

// ── GET /api/user/sites/:slug/commits/:sha/diff (Pro+ Git Dashboard) ──

async function handleGetCommitDiff(req, res, slug, sha, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  if (!GIT_DASHBOARD_PLANS.has(effectivePlan(user))) {
    return jsonErr(res, 'Git Dashboard requires a Pro plan.', 'PLAN_REQUIRED', 403);
  }

  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  if (!site.repo_url) {
    return jsonErr(res, 'No git repo linked', 'NO_REPO', 400);
  }

  try {
    const diff = await gitea.getCommitDiff(slug, sha);
    return jsonOk(res, { sha, diff });
  } catch (err) {
    console.error(`[pipee] Failed to get diff for ${slug}@${sha}:`, err.message);
    return jsonErr(res, 'Failed to fetch diff', 'GIT_ERROR', 502);
  }
}

// ── POST /api/user/sites/:slug/rollback (Pro+ Git Dashboard) ──

async function handleRollback(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;

  if (!GIT_DASHBOARD_PLANS.has(effectivePlan(user))) {
    return jsonErr(res, 'Git Dashboard requires a Pro plan.', 'PLAN_REQUIRED', 403);
  }

  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  if (!site.repo_url) {
    return jsonErr(res, 'No git repo linked', 'NO_REPO', 400);
  }

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const sha = (data.sha || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    return jsonErr(res, 'Invalid commit SHA', 'BAD_REQUEST', 400);
  }

  if (tooManyRequests(res, 'deploy', user.id)) return;

  const maxBytes = Math.min(MAX_EXTRACTED_SIZE, storageHeadroom(user, site));
  if (maxBytes <= 0) {
    return jsonErr(res, 'Account storage limit reached. Delete a site or upgrade your plan.', 'STORAGE_QUOTA_EXCEEDED', 413);
  }

  try {
    const { commit, size } = deployFromGitAtSha(slug, site.repo_url, sha, { maxBytes });
    db.updateSite(slug, { last_commit: commit, size });

    const siteUrl = getSiteUrl(req, slug, config);

    return jsonOk(res, {
      url: siteUrl,
      slug,
      commit: commit.slice(0, 7),
      size,
    });
  } catch (err) {
    if (err.message === 'INVALID_SHA') {
      return jsonErr(res, 'Invalid commit SHA', 'BAD_REQUEST', 400);
    }
    if (err.message === 'NO_INDEX_HTML') {
      return jsonErr(res, 'That commit has no index.html at root', 'NO_INDEX_HTML', 400);
    }
    if (err.message === 'SITE_TOO_LARGE') {
      return jsonErr(res, 'That commit exceeds your size or storage limit', 'SITE_TOO_LARGE', 413);
    }
    console.error(`[pipee] Rollback failed for ${slug}@${sha}:`, err.message);
    return jsonErr(res, 'Rollback failed', 'ROLLBACK_FAILED', 500);
  }
}

// ── POST /api/user/sites/:slug/link-github ──

async function handleLinkGitHub(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  let body;
  try {
    body = await collectBody(req, 4096);
  } catch {
    return jsonErr(res, 'Failed to read body', 'BAD_REQUEST', 400);
  }

  let data;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_REQUEST', 400);
  }

  const repoUrl = (data.repo_url || '').trim();
  const branch = (data.branch || 'main').trim();

  if (!repoUrl) {
    return jsonErr(res, 'repo_url is required', 'BAD_REQUEST', 400);
  }

  if (!repoUrl.startsWith('https://')) {
    return jsonErr(res, 'Please provide an HTTPS repo URL', 'BAD_REQUEST', 400);
  }

  const crypto = require('crypto');
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  const existingConfig = JSON.parse(site.config || '{}');
  const newConfig = { ...existingConfig, githubWebhookSecret: webhookSecret };

  const cloneUrl = repoUrl.endsWith('.git') ? repoUrl : repoUrl + '.git';

  db.updateSite(slug, {
    repo_url: cloneUrl,
    branch,
    deploy_method: 'github',
    config: JSON.stringify(newConfig),
  });

  const webhookUrl = `${config.externalUrl}/api/webhook/github/${slug}`;

  return jsonOk(res, {
    slug,
    repo_url: cloneUrl,
    branch,
    deploy_method: 'github',
    webhook_url: webhookUrl,
    webhook_secret: webhookSecret,
  });
}

// ── DELETE /api/user/sites/:slug/link-github ──

async function handleUnlinkGitHub(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) return jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401);

  const { user } = result;
  const site = db.getSite(slug);
  if (!site) return jsonErr(res, 'Site not found', 'NOT_FOUND', 404);
  if (site.user_id !== user.id) return jsonErr(res, 'Not your site', 'FORBIDDEN', 403);

  const existingConfig = JSON.parse(site.config || '{}');
  const { githubWebhookSecret: _removed, ...cleanConfig } = existingConfig;

  db.updateSite(slug, {
    repo_url: null,
    branch: 'main',
    deploy_method: 'upload',
    config: JSON.stringify(cleanConfig),
  });

  return jsonOk(res, { slug, disconnected: true });
}

// ── Data API management (Pro+) ──
// Owner-facing endpoints (JWT) to provision the per-site key, inspect status,
// rotate the key, and set per-collection rules. The public CRUD surface lives
// in data-api.js; these only configure it.

const DATA_PLANS = new Set(['pro', 'creator']);

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function generateDataKey() {
  return 'pk_' + crypto.randomBytes(24).toString('hex');
}

// Seed rules that make a contact-form collection work out of the box: visitors
// may write to `submissions` but read nothing; everything else is deny-all.
function defaultDataRules() {
  return JSON.stringify({
    _default: { read: 'none', write: 'none' },
    submissions: { read: 'none', write: 'public' },
  });
}

// Normalize a client-supplied rules object: only known shapes survive, values
// collapse to 'public'/'none', collection names are validated, and `_default`
// is always present (deny-all when omitted).
function sanitizeRules(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length > 50) return null;

  const NAME_RE = /^(_default|[a-z0-9][a-z0-9_-]{0,63})$/;
  const out = {};
  for (const key of keys) {
    if (!NAME_RE.test(key)) return null;
    const v = input[key] || {};
    out[key] = {
      read: v.read === 'public' ? 'public' : 'none',
      write: v.write === 'public' ? 'public' : 'none',
    };
  }
  if (!out._default) out._default = { read: 'none', write: 'none' };
  return out;
}

// Resolve { user, site } for an owned site, or null after ending the response.
function requireOwnedSite(req, res, slug, config) {
  const result = verifyUserRequest(req, config);
  if (!result) { jsonErr(res, 'Not authenticated', 'UNAUTHORIZED', 401); return null; }
  const site = db.getSite(slug);
  if (!site) { jsonErr(res, 'Site not found', 'NOT_FOUND', 404); return null; }
  if (site.user_id !== result.user.id) { jsonErr(res, 'Not your site', 'FORBIDDEN', 403); return null; }
  return { user: result.user, site };
}

// GET /api/user/sites/:slug/data
function handleDataInfo(req, res, slug, config) {
  const ctx = requireOwnedSite(req, res, slug, config);
  if (!ctx) return;

  const plan = effectivePlan(ctx.user);
  const planConfig = PLANS[plan] || PLANS.free;
  const base = String(config.externalUrl || '').replace(/\/$/, '');

  return jsonOk(res, {
    available: DATA_PLANS.has(plan),
    enabled: !!ctx.site.data_api_key,
    apiKey: ctx.site.data_api_key || null,
    rules: safeParse(ctx.site.data_rules, {}),
    recordCount: db.countRecordsByUser(ctx.user.id),
    maxRecords: planConfig.maxDataRecords || 0,
    endpoint: `${base}/api/db/${slug}`,
  });
}

// POST /api/user/sites/:slug/data/enable
function handleDataEnable(req, res, slug, config) {
  const ctx = requireOwnedSite(req, res, slug, config);
  if (!ctx) return;
  if (!DATA_PLANS.has(effectivePlan(ctx.user))) {
    return jsonErr(res, 'Upgrade to Pro to use the Data API', 'PLAN_REQUIRED', 403);
  }

  const apiKey = ctx.site.data_api_key || generateDataKey();
  const rules = ctx.site.data_rules && ctx.site.data_rules !== '{}'
    ? ctx.site.data_rules
    : defaultDataRules();
  db.updateSite(slug, { data_api_key: apiKey, data_rules: rules });

  return jsonOk(res, { apiKey, rules: safeParse(rules, {}) });
}

// POST /api/user/sites/:slug/data/rotate-key
function handleDataRotateKey(req, res, slug, config) {
  const ctx = requireOwnedSite(req, res, slug, config);
  if (!ctx) return;
  if (!ctx.site.data_api_key) return jsonErr(res, 'Data API not enabled', 'NOT_ENABLED', 400);

  const apiKey = generateDataKey();
  db.updateSite(slug, { data_api_key: apiKey });
  return jsonOk(res, { apiKey });
}

// PUT /api/user/sites/:slug/data/rules
async function handleDataSetRules(req, res, slug, config) {
  const ctx = requireOwnedSite(req, res, slug, config);
  if (!ctx) return;
  if (!ctx.site.data_api_key) return jsonErr(res, 'Data API not enabled', 'NOT_ENABLED', 400);

  let body;
  try {
    body = JSON.parse((await collectBody(req, 16384)).toString('utf8') || '{}');
  } catch {
    return jsonErr(res, 'Invalid JSON', 'BAD_JSON', 400);
  }

  const rules = sanitizeRules(body && body.rules);
  if (!rules) return jsonErr(res, 'Invalid rules', 'BAD_RULES', 400);

  db.updateSite(slug, { data_rules: JSON.stringify(rules) });
  return jsonOk(res, { rules });
}

// DELETE /api/user/sites/:slug/data (disable; records are kept)
function handleDataDisable(req, res, slug, config) {
  const ctx = requireOwnedSite(req, res, slug, config);
  if (!ctx) return;
  db.updateSite(slug, { data_api_key: null });
  return jsonOk(res, { enabled: false });
}

// ── POST /api/webhook/github/:slug (GitHub push -> auto deploy) ──

async function handleGitHubWebhook(req, res, slug, config) {
  const site = db.getSite(slug);
  if (!site) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Site not found' }));
  }

  if (site.deploy_method !== 'github') {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Site not configured for GitHub deploy' }));
  }

  const siteConfig = JSON.parse(site.config || '{}');
  if (!siteConfig.githubWebhookSecret) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'GitHub webhook not configured' }));
  }

  if (tooManyRequests(res, 'webhookDeploy', slug)) return;

  let body;
  try {
    body = await collectBody(req, 1024 * 1024);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Failed to read body' }));
  }

  // Verify GitHub signature (x-hub-signature-256: sha256=<hex>)
  const signature = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', siteConfig.githubWebhookSecret).update(body).digest('hex');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid signature' }));
  }

  // Handle GitHub ping event (sent when webhook is first created)
  const ghEvent = req.headers['x-github-event'] || '';
  if (ghEvent === 'ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'pong' }));
  }

  if (ghEvent !== 'push') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ skipped: true, message: 'Not a push event' }));
  }

  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
  }

  // Only deploy if push is to the configured branch
  const ref = payload.ref || '';
  const expectedRef = 'refs/heads/' + (site.branch || 'main');
  if (ref !== expectedRef) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ skipped: true, message: 'Push to different branch' }));
  }

  // Respond immediately, deploy in background
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: 'Deploy triggered' }));

  try {
    const owner = db.getUserById(site.user_id);
    const maxBytes = Math.min(MAX_EXTRACTED_SIZE, Math.max(0, storageHeadroom(owner, site)));
    const { commit, size } = deployFromGit(slug, site.repo_url, site.branch || 'main', { maxBytes });
    db.updateSite(slug, { last_commit: commit, size });
    console.log(`[github-webhook] Deployed ${slug} from GitHub (${commit.slice(0, 7)})`);
  } catch (err) {
    console.error(`[github-webhook] Deploy failed for ${slug}:`, err.message);
  }
}

module.exports = { handle };
