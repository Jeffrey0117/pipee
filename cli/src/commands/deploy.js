const fs = require('fs');
const path = require('path');
const api = require('../api');
const config = require('../config');
const output = require('../output');
const { zipFolder } = require('../zip');

module.exports = async function deploy(pos, flags) {
  const token = config.getToken();
  if (!token) {
    output.error('Not logged in. Run: pipee login');
    return 1;
  }

  const target = path.resolve(pos[0] || '.');
  // pipee.json lives next to a single-file target, in the folder otherwise.
  const dir = fs.existsSync(target) && fs.statSync(target).isFile() ? path.dirname(target) : target;
  const projectCfg = config.readProjectConfig(dir);
  const slug = flags.site || projectCfg.site;
  if (!slug) {
    output.error('No site slug. Use: pipee deploy --site <slug>  (it gets remembered in pipee.json)');
    return 1;
  }

  let buffer;
  try {
    buffer = zipFolder(target);
  } catch (err) {
    output.error(err.message);
    return 1;
  }

  if (!flags.json) output.info(`Deploying ${target} → ${slug} (${(buffer.length / 1024).toFixed(1)} KB zipped)...`);

  let result;
  try {
    result = await api.deploy(token, slug, buffer);
  } catch (err) {
    if (err.code === 'SLUG_TAKEN') {
      output.error(`"${slug}" belongs to someone else. Pick another name: pipee deploy --site <slug>`);
    } else if (err.code === 'UNAUTHORIZED') {
      output.error('Token expired or revoked. Run: pipee login');
    } else {
      output.error(`${err.message} (${err.code})`);
    }
    return 1;
  }

  if (projectCfg.site !== slug) {
    config.writeProjectConfig(dir, { ...projectCfg, site: slug });
  }

  if (flags.json) { output.json(result); return 0; }
  output.success(`Live at ${result.url}`);
  return 0;
};
