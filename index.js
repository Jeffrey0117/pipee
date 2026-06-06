/**
 * Pipee — Simple self-hosted static site hosting
 *
 * Usage: npm start
 */

const fs = require('fs');
const path = require('path');

// Ensure data directories exist
const dataDir = path.join(__dirname, 'data');
const staticDir = path.join(dataDir, 'static');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });

// Sweep leftovers from interrupted deploys (.tmp-*) and atomic swaps (.old-*).
// They're normally removed right after a deploy, but a crash mid-swap leaves
// them behind — and they'd silently eat disk outside any storage quota.
for (const entry of fs.readdirSync(staticDir)) {
  if (/^\.(tmp|old)-/.test(entry)) {
    try {
      fs.rmSync(path.join(staticDir, entry), { recursive: true, force: true });
      console.log(`[pipee] Removed stale deploy dir: ${entry}`);
    } catch (err) {
      console.error(`[pipee] Failed to remove stale dir ${entry}:`, err.message);
    }
  }
}

// Create config.json from example if it doesn't exist
const configPath = path.join(__dirname, 'config.json');
const examplePath = path.join(__dirname, 'config.example.json');

if (!fs.existsSync(configPath) && fs.existsSync(examplePath)) {
  fs.copyFileSync(examplePath, configPath);
  console.log('[pipee] Created config.json from config.example.json');
  console.log('[pipee] Please update jwtSecret in config.json before production use!');
}

// Start server
require('./src/core/server');
