/**
 * Pipee Git Deploy
 *
 * Clone/pull from a git repo and deploy as static site.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { STATIC_DIR } = require('./static');

const GIT_CACHE_DIR = path.join(__dirname, '../../data/git-cache');

function ensureGitCache() {
  if (!fs.existsSync(GIT_CACHE_DIR)) {
    fs.mkdirSync(GIT_CACHE_DIR, { recursive: true });
  }
}

function deployFromGit(slug, repoUrl, branch = 'main') {
  ensureGitCache();

  const cacheDir = path.join(GIT_CACHE_DIR, slug);
  let commit;

  if (fs.existsSync(path.join(cacheDir, '.git'))) {
    execSync(`git -C "${cacheDir}" fetch origin`, {
      stdio: 'pipe', windowsHide: true, timeout: 30000,
    });
    execSync(`git -C "${cacheDir}" reset --hard origin/${branch}`, {
      stdio: 'pipe', windowsHide: true, timeout: 10000,
    });
  } else {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
    execSync(`git clone --depth 1 --branch ${branch} "${repoUrl}" "${cacheDir}"`, {
      stdio: 'pipe', windowsHide: true, timeout: 60000,
    });
  }

  commit = execSync(`git -C "${cacheDir}" rev-parse HEAD`, {
    encoding: 'utf-8', windowsHide: true,
  }).trim();

  if (!fs.existsSync(path.join(cacheDir, 'index.html'))) {
    throw new Error('NO_INDEX_HTML');
  }

  const siteDir = path.join(STATIC_DIR, slug);
  const tempDir = path.join(STATIC_DIR, `.tmp-git-${slug}-${Date.now()}`);

  copyDirExcludeGit(cacheDir, tempDir);

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

  const size = getDirSize(siteDir);

  return { commit, size };
}

function copyDirExcludeGit(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirExcludeGit(srcPath, destPath);
    } else {
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

module.exports = { deployFromGit };
