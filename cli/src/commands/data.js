const path = require('path');
const api = require('../api');
const config = require('../config');
const output = require('../output');

module.exports = async function data(pos, flags) {
  const token = config.getToken();
  if (!token) {
    output.error('Not logged in. Run: pipee login');
    return 1;
  }

  const slug = pos[0] || config.readProjectConfig(path.resolve('.')).site;
  if (!slug) {
    output.error('Usage: pipee data <slug> [--enable]');
    return 1;
  }

  try {
    if (flags.enable) {
      await api.dataEnable(token, slug);
    }
    const info = await api.dataInfo(token, slug);

    if (flags.json) { output.json(info); return 0; }

    if (!info.available) {
      output.error('Data API requires a Pro plan. See https://pipee.tw/pricing');
      return 1;
    }
    if (!info.enabled) {
      output.info(`Data API not enabled for "${slug}". Enable it: pipee data ${slug} --enable`);
      return 0;
    }
    output.success(`Data API enabled for ${slug}`);
    output.info(`Endpoint: ${info.endpoint}/{collection}`);
    output.info(`Key:      ${info.apiKey}`);
    output.info(`Records:  ${info.recordCount}/${info.maxRecords}`);
    output.info(`Rules:    ${JSON.stringify(info.rules)}`);
    output.info('');
    output.info('SDK: <script src="https://pipee.tw/sdk.js" data-site="' + slug + '" data-key="' + info.apiKey + '"></script>');
    output.info('Docs: https://pipee.tw/ai');
    return 0;
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') output.error('Token expired or revoked. Run: pipee login');
    else if (err.code === 'PLAN_REQUIRED') output.error('Data API requires a Pro plan. See https://pipee.tw/pricing');
    else output.error(`${err.message} (${err.code})`);
    return 1;
  }
};
