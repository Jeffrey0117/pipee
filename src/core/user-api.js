/**
 * Pipee User API
 *
 * Handles user registration, login, and site management.
 * Auth via local JWT (username/password).
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { hashPassword, verifyPassword, generateToken, verifyUserRequest } = require('./user-auth');
const { validateSlug, STATIC_DIR } = require('./static');
const { deployFromGit, deployFromGitAtSha } = require('./git-deploy');
const gitea = require('./gitea');
const aiEditor = require('./ai-editor');
const aiSessions = require('./ai-sessions');

const { PLANS } = db;
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
  if (req.method === 'DELETE' && pathname.startsWith('/api/user/sites/')) {
    const slug = pathname.slice('/api/user/sites/'.length);
    return handleDeleteSite(req, res, slug, config);
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

  return jsonErr(res, 'Not found', 'NOT_FOUND', 404);
}

// ── POST /api/auth/register ──

async function handleRegister(req, res, config) {
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

  // Check if username already exists
  const existing = db.getUserByUsername(username);
  if (existing) {
    return jsonErr(res, 'Username already taken', 'CONFLICT', 409);
  }

  const { hash, salt } = hashPassword(data.password);

  let user;
  try {
    user = db.createUser({ username, passwordHash: hash, salt });
  } catch (err) {
    // Race condition: username was taken between check and insert
    if (err.message && err.message.includes('UNIQUE')) {
      return jsonErr(res, 'Username already taken', 'CONFLICT', 409);
    }
    throw err;
  }

  const token = generateToken(user.id, config.jwtSecret);

  return jsonOk(res, {
    token,
    user: {
      id: user.id,
      username: user.username,
      plan: user.plan,
      max_sites: user.max_sites,
    },
  }, 201);
}

// ── POST /api/auth/login ──

async function handleLogin(req, res, config) {
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
  const planConfig = PLANS[user.plan] || PLANS.free;

  return jsonOk(res, {
    user: {
      id: user.id,
      username: user.username,
      plan: user.plan,
      plan_label: planConfig.label,
      max_sites: planConfig.maxSites,
      site_count: siteCount,
      ai_edits_used: user.ai_edits_used || 0,
      ai_edits_limit: planConfig.aiEditsPerMonth,
      ai_enabled: AI_ALLOWED_PLANS.has(user.plan),
      git_dashboard_enabled: GIT_DASHBOARD_PLANS.has(user.plan),
    },
  });
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
    created_at: s.created_at,
    updated_at: s.updated_at,
  }));

  const planConfig = PLANS[user.plan] || PLANS.free;

  return jsonOk(res, {
    sites,
    quota: { used: sites.length, max: planConfig.maxSites },
  });
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

  // Check if slug already exists
  const existing = db.getSite(slug);
  if (existing) {
    return jsonErr(res, 'This slug is already taken', 'SLUG_TAKEN', 409);
  }

  // Quota check (plan-based)
  const planConfig = PLANS[user.plan] || PLANS.free;
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

  // Merge settings into existing config
  const existingConfig = JSON.parse(site.config || '{}');
  const newConfig = { ...existingConfig, ...data };

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

  // Delete DB record
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

  try {
    const { commit, size } = deployFromGit(slug, site.repo_url, site.branch || 'main');
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

    const crypto = require('crypto');
    const signature = req.headers['x-gitea-signature'] || '';
    const expected = crypto.createHmac('sha256', siteConfig.webhookSecret).update(body).digest('hex');
    if (signature !== expected) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid signature' }));
    }
  }

  // Respond immediately, deploy in background
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: 'Deploy triggered' }));

  try {
    const { commit, size } = deployFromGit(slug, site.repo_url, site.branch || 'main');
    db.updateSite(slug, { last_commit: commit, size });
    console.log(`[webhook] Deployed ${slug} from git (${commit.slice(0, 7)})`);
  } catch (err) {
    console.error(`[webhook] Git deploy failed for ${slug}:`, err.message);
  }
}

// ── AI Quota helpers ──

function checkAiQuota(user) {
  const planConfig = PLANS[user.plan] || PLANS.free;
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
  if (!AI_ALLOWED_PLANS.has(user.plan)) {
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

  if (!GIT_DASHBOARD_PLANS.has(user.plan)) {
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

  if (!GIT_DASHBOARD_PLANS.has(user.plan)) {
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

  if (!GIT_DASHBOARD_PLANS.has(user.plan)) {
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

  try {
    const { commit, size } = deployFromGitAtSha(slug, site.repo_url, sha);
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
    console.error(`[pipee] Rollback failed for ${slug}@${sha}:`, err.message);
    return jsonErr(res, 'Rollback failed', 'ROLLBACK_FAILED', 500);
  }
}

module.exports = { handle };
