/**
 * Pack a site folder into a ZIP buffer for deploy.
 * Excludes dev junk at any depth; requires index.html at the folder root
 * (same rule the server enforces, so we fail fast locally).
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const EXCLUDE = new Set(['node_modules', '.git', '.pipee', '.DS_Store', 'Thumbs.db', 'pipee.json']);

function zipFolder(target) {
  const root = path.resolve(target);
  if (!fs.existsSync(root)) {
    throw new Error(`No such file or directory: ${root}`);
  }

  // Single-file deploy: an .html file becomes the site's index.html.
  if (fs.statSync(root).isFile()) {
    if (!/\.html?$/i.test(root)) {
      throw new Error('Single-file deploy must be an .html file (it becomes index.html)');
    }
    const zip = new AdmZip();
    zip.addFile('index.html', fs.readFileSync(root));
    return zip.toBuffer();
  }

  if (!fs.existsSync(path.join(root, 'index.html'))) {
    throw new Error(`No index.html in ${root} — the folder root must contain index.html`);
  }

  const zip = new AdmZip();
  zip.addLocalFolder(root, '', (entryPath) => {
    const parts = entryPath.split(/[\\/]/);
    return !parts.some((seg) => EXCLUDE.has(seg));
  });
  return zip.toBuffer();
}

module.exports = { zipFolder, EXCLUDE };
