/**
 * Pack a site folder into a ZIP buffer for deploy.
 * Excludes dev junk at any depth; requires index.html at the folder root
 * (same rule the server enforces, so we fail fast locally).
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const EXCLUDE = new Set(['node_modules', '.git', '.pipee', '.DS_Store', 'Thumbs.db', 'pipee.json']);

function zipFolder(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
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
