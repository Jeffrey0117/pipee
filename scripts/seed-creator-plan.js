/**
 * Seed Creator plan in PayGate
 *
 * Run this once to register the pipee:creator:monthly plan in PayGate.
 * Usage: node scripts/seed-creator-plan.js
 */

const http = require('http');

const PAYGATE_PORT = 4019;

const plan = {
  id: 'pipee:creator:monthly',
  product: 'pipee',
  tier: 'creator',
  display_name: 'Creator',
  billing_cycle: 'monthly',
  price: 399,
  currency: 'TWD',
  quotas: JSON.stringify({ max_sites: 50, ai_edits: 100 }),
};

const body = JSON.stringify(plan);

const req = http.request({
  hostname: 'localhost',
  port: PAYGATE_PORT,
  path: '/api/plans',
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  },
}, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log('Response:', data);
    if (res.statusCode === 200) {
      console.log('\nCreator plan registered successfully!');
    } else {
      console.error('\nFailed to register plan');
    }
  });
});

req.on('error', (err) => {
  console.error('Error connecting to PayGate:', err.message);
  console.error('Make sure PayGate is running on port', PAYGATE_PORT);
});

req.write(body);
req.end();
