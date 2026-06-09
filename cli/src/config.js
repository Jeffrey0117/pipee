/**
 * Config storage.
 *
 * Global:  ~/.pipee/config.json   { token, apiBase? }   (PIPEE_HOME overrides ~)
 * Project: ./pipee.json           { site }              (remembers the slug per folder)
 *
 * Env overrides (highest priority, agent-friendly):
 *   PIPEE_TOKEN — deploy token
 *   PIPEE_API   — API base URL (default https://pipee.tw)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_API = 'https://pipee.tw';

function configDir() {
  return path.join(process.env.PIPEE_HOME || os.homedir(), '.pipee');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

function getToken() {
  return process.env.PIPEE_TOKEN || readConfig().token || null;
}

function getApiBase() {
  const base = process.env.PIPEE_API || readConfig().apiBase || DEFAULT_API;
  return base.replace(/\/+$/, '');
}

function projectConfigPath(dir) {
  return path.join(dir, 'pipee.json');
}

function readProjectConfig(dir) {
  try { return JSON.parse(fs.readFileSync(projectConfigPath(dir), 'utf8')); } catch { return {}; }
}

function writeProjectConfig(dir, cfg) {
  fs.writeFileSync(projectConfigPath(dir), JSON.stringify(cfg, null, 2) + '\n');
}

module.exports = {
  configPath,
  readConfig,
  writeConfig,
  getToken,
  getApiBase,
  readProjectConfig,
  writeProjectConfig,
  DEFAULT_API,
};
