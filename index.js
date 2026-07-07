/**
 * Pipee — Simple self-hosted static site hosting
 *
 * Usage: npm start
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
}

// Harden the JWT secret: the shipped placeholder is public (it's in the repo),
// so anyone could forge tokens — including one for the id=1 admin. If the
// config still carries the placeholder (or no secret at all), mint a strong
// random secret and persist it. This runs before the server loads its config,
// so a fresh install is safe by default with no manual step. Rotating the
// secret logs out any existing sessions once, which is the intended trade-off.
const PLACEHOLDER_SECRET = 'change-this-to-a-random-string';
try {
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!cfg.jwtSecret || cfg.jwtSecret === PLACEHOLDER_SECRET) {
      cfg.jwtSecret = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
      console.log('[pipee] Generated a random jwtSecret in config.json');
    }
  }
} catch (err) {
  console.error('[pipee] Failed to normalize jwtSecret:', err.message);
  process.exit(1);
}

// Start server
require('./src/core/server');
