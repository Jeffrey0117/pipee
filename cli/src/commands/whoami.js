const api = require('../api');
const config = require('../config');
const output = require('../output');

module.exports = async function whoami(pos, flags) {
  const token = config.getToken();
  if (!token) {
    output.error('Not logged in. Run: pipee login');
    return 1;
  }

  let me;
  try {
    me = await api.me(token);
  } catch (err) {
    output.error(err.code === 'UNAUTHORIZED' ? 'Token expired or revoked. Run: pipee login' : err.message);
    return 1;
  }

  if (flags.json) { output.json(me.user); return 0; }
  const u = me.user;
  output.info(`${u.name || '(no name)'} <${u.email || 'no email'}>`);
  output.info(`Plan: ${u.plan_label || u.plan}   Sites: ${u.site_count}/${u.max_sites}`);
  return 0;
};
