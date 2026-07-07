/**
 * Pipee Git Deploy
 *
 * Clone/pull from a git repo and deploy as static site.
 *
 * SECURITY: every git invocation goes through execFileAsync with an argument
 * ARRAY and shell:false — user-controlled values (repo URL, branch, SHA) are
 * passed as argv, never interpolated into a command string, so they can't be
 * turned into shell metacharacters. Branch/SHA/URL are also format-validated.
 * All calls are async so a slow clone never blocks the HTTP event loop.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { STATIC_DIR } = require('./static');

const GIT_CACHE_DIR = path.join(__dirname, '../../data/git-cache');

// Git refuses to interpret an argument as an option once it appears after `--`,
// but branch/URL land in positions where `--` can't always guard them, so we
// also validate their shape. A branch may be any valid ref name minus the
// characters git itself forbids; we take a conservative subset.
const BRANCH_RE = /^(?!-)[A-Za-z0-9._\/-]{1,255}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

// Accepted transports for a linked repo. `file://` and bare local paths are
// rejected so a repo URL can't point git at the server's own filesystem.
function isAllowedRepoUrl(url) {
  return /^https?:\/\//.test(url) || /^git@[^\s]+:[^\s]+$/.test(url);
}

function assertBranch(branch) {
  if (!BRANCH_RE.test(branch)) throw new Error('INVALID_BRANCH');
  return branch;
}

// Promise wrapper around execFile with hard defaults: no shell, hidden window,
// and a bounded buffer so a hostile repo can't blow up memory via git output.
function git(args, { cwd, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      timeout,
      windowsHide: true,
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

function ensureGitCache() {
  if (!fs.existsSync(GIT_CACHE_DIR)) {
    fs.mkdirSync(GIT_CACHE_DIR, { recursive: true });
  }
}

async function deployFromGit(slug, repoUrl, branch = 'main', opts = {}) {
  if (!isAllowedRepoUrl(repoUrl)) throw new Error('INVALID_REPO_URL');
  assertBranch(branch);
  ensureGitCache();

  const cacheDir = path.join(GIT_CACHE_DIR, slug);

  if (fs.existsSync(path.join(cacheDir, '.git'))) {
    await git(['-C', cacheDir, 'fetch', 'origin'], { cwd: cacheDir, timeout: 60000 });
    await git(['-C', cacheDir, 'reset', '--hard', `origin/${branch}`], { cwd: cacheDir, timeout: 15000 });
  } else {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    await git(['clone', '--depth', '1', '--branch', branch, '--', repoUrl, cacheDir], { timeout: 120000 });
  }

  const commit = (await git(['-C', cacheDir, 'rev-parse', 'HEAD'], { cwd: cacheDir })).trim();

  if (!fs.existsSync(path.join(cacheDir, 'index.html'))) {
    throw new Error('NO_INDEX_HTML');
  }

  const size = swapIntoPlace(slug, cacheDir, opts.maxBytes);

  return { commit, size };
}

// Copy the checked-out tree (sans .git) to a temp dir, enforce the size cap
// BEFORE swapping so an oversized repo never goes live, then atomically swap.
function swapIntoPlace(slug, cacheDir, maxBytes) {
  const siteDir = path.join(STATIC_DIR, slug);
  const tempDir = path.join(STATIC_DIR, `.tmp-git-${slug}-${Date.now()}`);

  copyDirExcludeGit(cacheDir, tempDir);

  const size = getDirSize(tempDir);
  if (maxBytes !== undefined && size > maxBytes) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error('SITE_TOO_LARGE');
  }

  const oldDir = path.join(STATIC_DIR, `.old-${slug}-${Date.now()}`);
  if (fs.existsSync(siteDir)) {
    fs.renameSync(siteDir, oldDir);
  }
  try {
    fs.renameSync(tempDir, siteDir);
  } catch (err) {
    if (fs.existsSync(oldDir)) {
      try { fs.renameSync(oldDir, siteDir); } catch { /* best effort */ }
    }
    throw err;
  }
  if (fs.existsSync(oldDir)) {
    setTimeout(() => {
      try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 1000);
  }

  return size;
}

function copyDirExcludeGit(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    // Skip symlinks: a repo could ship a link escaping the site dir, which the
    // static server would then follow. Static sites are plain files only.
    if (entry.isSymbolicLink && entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      copyDirExcludeGit(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
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

async function deployFromGitAtSha(slug, repoUrl, sha, opts = {}) {
  if (!SHA_RE.test(sha)) {
    throw new Error('INVALID_SHA');
  }
  if (!isAllowedRepoUrl(repoUrl)) throw new Error('INVALID_REPO_URL');

  ensureGitCache();
  const cacheDir = path.join(GIT_CACHE_DIR, slug);

  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    await git(['clone', '--', repoUrl, cacheDir], { timeout: 120000 });
  }

  // Unshallow if needed (shallow clones can't checkout arbitrary SHAs)
  try {
    await git(['-C', cacheDir, 'fetch', '--unshallow', 'origin'], { cwd: cacheDir, timeout: 120000 });
  } catch {
    await git(['-C', cacheDir, 'fetch', 'origin'], { cwd: cacheDir, timeout: 60000 });
  }

  await git(['-C', cacheDir, 'checkout', sha], { cwd: cacheDir, timeout: 15000 });

  const commit = (await git(['-C', cacheDir, 'rev-parse', 'HEAD'], { cwd: cacheDir })).trim();

  if (!fs.existsSync(path.join(cacheDir, 'index.html'))) {
    throw new Error('NO_INDEX_HTML');
  }

  const size = swapIntoPlace(slug, cacheDir, opts.maxBytes);
  return { commit, size };
}

module.exports = { deployFromGit, deployFromGitAtSha, isAllowedRepoUrl, BRANCH_RE };
