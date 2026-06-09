const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point config at a temp home BEFORE requiring the module under test.
process.env.PIPEE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pipee-home-'));
const config = require('./config');

test('config: round-trips token via PIPEE_HOME', () => {
  assert.strictEqual(config.getToken(), null);
  config.writeConfig({ token: 'a'.repeat(64) });
  assert.strictEqual(config.getToken(), 'a'.repeat(64));
});

test('config: PIPEE_TOKEN env wins over stored token', () => {
  process.env.PIPEE_TOKEN = 'b'.repeat(64);
  assert.strictEqual(config.getToken(), 'b'.repeat(64));
  delete process.env.PIPEE_TOKEN;
});

test('config: api base defaults to pipee.tw, PIPEE_API overrides, trailing slash stripped', () => {
  assert.strictEqual(config.getApiBase(), 'https://pipee.tw');
  process.env.PIPEE_API = 'http://localhost:3939/';
  assert.strictEqual(config.getApiBase(), 'http://localhost:3939');
  delete process.env.PIPEE_API;
});

test('config: project config remembers the site slug', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipee-proj-'));
  assert.deepStrictEqual(config.readProjectConfig(dir), {});
  config.writeProjectConfig(dir, { site: 'mysite' });
  assert.deepStrictEqual(config.readProjectConfig(dir), { site: 'mysite' });
});
