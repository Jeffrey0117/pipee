const api = require('../api');
const config = require('../config');
const output = require('../output');

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

module.exports = async function sites(pos, flags) {
  const token = config.getToken();
  if (!token) {
    output.error('Not logged in. Run: pipee login');
    return 1;
  }

  let data;
  try {
    data = await api.sites(token);
  } catch (err) {
    output.error(err.code === 'UNAUTHORIZED' ? 'Token expired or revoked. Run: pipee login' : err.message);
    return 1;
  }

  if (flags.json) { output.json(data.sites); return 0; }

  if (!data.sites || data.sites.length === 0) {
    output.info('No sites yet. Deploy one: pipee deploy --site <slug>');
    return 0;
  }
  for (const s of data.sites) {
    output.info(`${s.slug.padEnd(20)} ${s.url.padEnd(40)} ${formatSize(s.size).padStart(9)}  ${s.hits_today} hits today`);
  }
  return 0;
};
