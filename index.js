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
