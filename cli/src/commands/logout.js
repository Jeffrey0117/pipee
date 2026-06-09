const config = require('../config');
const output = require('../output');

module.exports = async function logout(pos, flags) {
  const cfg = config.readConfig();
  if (!cfg.token) {
    output.info('Not logged in.');
    return 0;
  }
  const { token: _removed, ...rest } = cfg;
  config.writeConfig(rest);
  if (flags.json) { output.json({ ok: true }); return 0; }
  output.success('Logged out.');
  return 0;
};
