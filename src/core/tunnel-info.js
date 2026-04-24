/**
 * Tunnel Connector Info
 *
 * 查詢 cloudflared tunnel 的 connector 資訊（哪些機器連著 tunnel）。
 * 30 秒記憶體 cache，失敗不 throw。
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '../../config.json');
const CACHE_TTL = 30000; // 30s

let cached = null;
let cachedAt = 0;

function getCloudflaredConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      path: config.cloudflared?.path || 'cloudflared',
      tunnelId: config.cloudflared?.tunnelId || '',
    };
  } catch {
    return { path: 'cloudflared', tunnelId: '' };
  }
}

function fetchTunnelInfo() {
  const { path: cfPath, tunnelId } = getCloudflaredConfig();
  if (!tunnelId) {
    return { connectorCount: 0, connectors: [] };
  }

  try {
    const output = execSync(
      `"${cfPath}" tunnel info -o json ${tunnelId}`,
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 10000 }
    ).toString();

    const data = JSON.parse(output);
    const conns = data.conns || [];

    const connectors = conns.map(conn => {
      const subConns = conn.conns || [];
      const colos = subConns.map(sc => sc.colo_name).filter(Boolean);
      const originIp = subConns.length > 0 ? subConns[0].origin_ip : '';

      return {
        id: conn.id || '',
        ip: originIp ? originIp.replace(/:\d+$/, '') : '',
        version: conn.version || '',
        arch: conn.arch || '',
        connectedAt: conn.run_at || '',
        colos,
      };
    });

    return { connectorCount: connectors.length, connectors };
  } catch {
    return { connectorCount: 0, connectors: [] };
  }
}

function getTunnelInfo() {
  const now = Date.now();
  if (cached && (now - cachedAt) < CACHE_TTL) {
    return cached;
  }

  cached = fetchTunnelInfo();
  cachedAt = now;
  return cached;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 清除指定 connector（用 cloudflared CLI）
 * 先嘗試指定 connector，失敗則 fallback 到全量 cleanup
 */
function cleanupConnector(connectorId) {
  const { path: cfPath, tunnelId } = getCloudflaredConfig();
  if (!tunnelId || !connectorId) return false;

  // 防止 command injection
  if (!UUID_RE.test(connectorId) || !UUID_RE.test(tunnelId)) return false;

  // 嘗試 1: 指定 connector cleanup
  try {
    execSync(
      `"${cfPath}" tunnel cleanup ${tunnelId} -c ${connectorId}`,
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 }
    );
    return true;
  } catch {
    // 嘗試 2: 全量 cleanup（移除所有 stale connectors）
    try {
      execSync(
        `"${cfPath}" tunnel cleanup ${tunnelId}`,
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 }
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 取得本機公網 IP（5 分鐘 cache）
 */
let localIpCache = null;
let localIpCachedAt = 0;
const LOCAL_IP_TTL = 5 * 60 * 1000; // 5 min

async function getLocalPublicIp() {
  const now = Date.now();
  if (localIpCache && (now - localIpCachedAt) < LOCAL_IP_TTL) {
    return localIpCache;
  }

  const urls = ['https://api.ipify.org', 'https://ifconfig.me/ip'];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'PIPEE/1.0' },
      });
      if (res.ok) {
        const ip = (await res.text()).trim();
        if (ip && /^[\d.]+$/.test(ip)) {
          localIpCache = ip;
          localIpCachedAt = now;
          return ip;
        }
      }
    } catch {
      // try next
    }
  }
  return localIpCache || null;
}

/**
 * 找出非本機 IP 的 connectors
 */
function getForeignConnectors(localIp) {
  const info = getTunnelInfo();
  if (!localIp || !info.connectors.length) return [];
  return info.connectors.filter(c => c.ip && c.ip !== localIp);
}

/**
 * 找出同 IP 但過時的 connectors（同機器殭屍）
 * 只保留最新的那個，其他視為 stale
 */
function getStaleLocalConnectors(localIp) {
  const info = getTunnelInfo();
  if (!localIp || !info.connectors.length) return [];

  const local = info.connectors.filter(c => c.ip === localIp);
  if (local.length <= 1) return [];

  const sorted = [...local].sort((a, b) =>
    new Date(b.connectedAt).getTime() - new Date(a.connectedAt).getTime()
  );

  // 最新的留下，其餘都是殭屍
  return sorted.slice(1);
}

/**
 * 清除 cache（給 takeover enforce 時用，確保拿到最新資訊）
 */
function clearCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = {
  getTunnelInfo,
  cleanupConnector,
  getLocalPublicIp,
  getForeignConnectors,
  getStaleLocalConnectors,
  clearCache,
};
