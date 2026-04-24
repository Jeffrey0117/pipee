/**
 * PIPEE entry point
 * Usage: node index.js
 */

// Load services/.env if exists
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, 'services', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length) {
        process.env[key.trim()] = valueParts.join('=').trim();
      }
    }
  });
  console.log('[pipee] Loaded services/.env');
}

require('./src/core/server');
