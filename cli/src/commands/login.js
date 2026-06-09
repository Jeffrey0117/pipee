const readline = require('readline');
const api = require('../api');
const config = require('../config');
const output = require('../output');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

module.exports = async function login(pos, flags) {
  let token = flags.token || process.env.PIPEE_TOKEN;

  if (!token) {
    output.info('Get your deploy token: https://pipee.tw/console → CLI section → copy token');
    token = await prompt('Deploy token: ');
  }
  if (!token) {
    output.error('No token provided.');
    return 1;
  }

  let me;
  try {
    me = await api.me(token);
  } catch (err) {
    output.error(err.code === 'UNAUTHORIZED' ? 'Invalid token.' : err.message);
    return 1;
  }

  config.writeConfig({ ...config.readConfig(), token });

  if (flags.json) {
    output.json({ ok: true, user: me.user });
    return 0;
  }
  output.success(`Logged in as ${me.user.name || me.user.email} (${me.user.plan_label || me.user.plan})`);
  output.info(`Sites: ${me.user.site_count}/${me.user.max_sites}`);
  return 0;
};
