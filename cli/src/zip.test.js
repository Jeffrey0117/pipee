const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { zipFolder } = require('./zip');

function makeSite(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipee-zip-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hi</h1>');
  if (extra) extra(dir);
  return dir;
}

test('zipFolder: packs files and requires index.html', () => {
  const dir = makeSite((d) => {
    fs.writeFileSync(path.join(d, 'style.css'), 'body{}');
  });
  const buf = zipFolder(dir);
  const names = new AdmZip(buf).getEntries().map((e) => e.entryName);
  assert.ok(names.includes('index.html'));
  assert.ok(names.includes('style.css'));
});

test('zipFolder: excludes node_modules, .git, and pipee.json at any depth', () => {
  const dir = makeSite((d) => {
    fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(d, 'node_modules', 'x', 'index.js'), '0');
    fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'ref');
    fs.writeFileSync(path.join(d, 'pipee.json'), '{"site":"x"}');
    fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(d, 'assets', 'a.png'), 'png');
  });
  const names = new AdmZip(zipFolder(dir)).getEntries().map((e) => e.entryName);
  assert.ok(names.some((n) => n.startsWith('assets/')));
  assert.ok(!names.some((n) => n.includes('node_modules')));
  assert.ok(!names.some((n) => n.includes('.git')));
  assert.ok(!names.includes('pipee.json'));
});

test('zipFolder: throws without index.html', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipee-zip-'));
  fs.writeFileSync(path.join(dir, 'about.html'), 'x');
  assert.throws(() => zipFolder(dir), /index\.html/);
});

test('zipFolder: a single .html file becomes index.html', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipee-zip-'));
  const file = path.join(dir, 'landing.html');
  fs.writeFileSync(file, '<h1>solo</h1>');
  const names = new AdmZip(zipFolder(file)).getEntries().map((e) => e.entryName);
  assert.deepStrictEqual(names, ['index.html']);
});

test('zipFolder: a single non-html file is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipee-zip-'));
  const file = path.join(dir, 'script.js');
  fs.writeFileSync(file, '0');
  assert.throws(() => zipFolder(file), /\.html/);
});
