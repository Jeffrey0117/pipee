/**
 * Pipee Gitea Client
 *
 * Auto-creates repos for Pipee sites on a Gitea instance.
 * Each site gets its own "mini repo" — users just git push to deploy.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '../../config.json');

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getGiteaConfig() {
  const config = getConfig();
  return config.gitea || {};
}

/** Check if Gitea integration is enabled */
function isEnabled() {
  const cfg = getGiteaConfig();
  return Boolean(cfg.url && cfg.token);
}

/** Generic Gitea API fetch */
async function giteaFetch(apiPath, options = {}) {
  const cfg = getGiteaConfig();
  if (!cfg.url || !cfg.token) {
    throw new Error('Gitea not configured');
  }

  const { method = 'GET', body } = options;
  const url = `${cfg.url}/api/v1${apiPath}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `token ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gitea ${method} ${apiPath}: ${res.status} ${text}`);
  }

  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/** Get the Gitea owner (org or user that owns repos) */
function getOwner() {
  return getGiteaConfig().owner || 'pipee';
}

/** Get clone URL for a repo */
function getCloneUrl(repoName) {
  const cfg = getGiteaConfig();
  const owner = getOwner();
  return `${cfg.url}/${owner}/${repoName}.git`;
}

/** Get web URL for a repo */
function getWebUrl(repoName) {
  const cfg = getGiteaConfig();
  const owner = getOwner();
  return `${cfg.url}/${owner}/${repoName}`;
}

/**
 * Create a Gitea repo for a Pipee site.
 * Returns { clone_url, web_url, webhook_secret } or null if Gitea is not configured.
 */
async function createSiteRepo(slug, pipeeBaseUrl) {
  if (!isEnabled()) return null;

  const owner = getOwner();

  // Create the repo under the org (not the token user)
  const repo = await giteaFetch(`/orgs/${owner}/repos`, {
    method: 'POST',
    body: {
      name: slug,
      description: `Pipee site: ${slug}`,
      private: false,
      auto_init: true,
      default_branch: 'main',
      readme: 'Default',
    },
  });

  // Generate webhook secret
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  // Register webhook for auto-deploy on push
  // Use webhookHost if set (e.g. Docker needs host.docker.internal)
  const cfg = getGiteaConfig();
  const webhookBase = cfg.webhookHost || pipeeBaseUrl;
  const webhookUrl = `${webhookBase}/api/webhook/${slug}`;
  await giteaFetch(`/repos/${owner}/${slug}/hooks`, {
    method: 'POST',
    body: {
      type: 'gitea',
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret: webhookSecret,
      },
      events: ['push'],
      active: true,
    },
  });

  return {
    clone_url: getCloneUrl(slug),
    web_url: repo.html_url || getWebUrl(slug),
    webhook_secret: webhookSecret,
  };
}

/** Delete a Gitea repo (cleanup when site is deleted) */
async function deleteSiteRepo(slug) {
  if (!isEnabled()) return;

  const owner = getOwner();
  try {
    await giteaFetch(`/repos/${owner}/${slug}`, { method: 'DELETE' });
  } catch {
    // Best effort — repo might not exist
  }
}

/**
 * Get commit history for a site repo.
 * Returns { commits, total }.
 */
async function getRepoCommits(slug, { page = 1, limit = 20 } = {}) {
  if (!isEnabled()) return { commits: [], total: 0 };

  const cfg = getGiteaConfig();
  const owner = getOwner();
  const url = `${cfg.url}/api/v1/repos/${owner}/${slug}/commits?page=${page}&limit=${limit}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `token ${cfg.token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gitea commits: ${res.status} ${text}`);
  }

  const total = parseInt(res.headers.get('x-total') || '0', 10);
  const commits = await res.json();

  return { commits, total };
}

/**
 * Get raw diff for a specific commit.
 */
async function getCommitDiff(slug, sha) {
  if (!isEnabled()) return '';

  const cfg = getGiteaConfig();
  const owner = getOwner();
  const url = `${cfg.url}/${owner}/${slug}/commit/${sha}.diff`;

  const res = await fetch(url, {
    headers: { 'Authorization': `token ${cfg.token}` },
  });

  if (!res.ok) return '';
  return res.text();
}

module.exports = {
  isEnabled,
  getCloneUrl,
  getWebUrl,
  getOwner,
  createSiteRepo,
  deleteSiteRepo,
  getRepoCommits,
  getCommitDiff,
};
