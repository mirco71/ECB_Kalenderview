const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASSET_DIRS = ['js', 'css'];
const PAGES = ['index.html', 'login.html', 'admin.html'];

/** All files below dir (relative POSIX paths), sorted for a stable hash. */
function listFiles(root, dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Version of the static JS/CSS: first 10 hex chars of a SHA-256 over path and
 * content of every file in public/js and public/css. Changes whenever an asset
 * changes, so browsers (and Cloudflare, max-age=14400) fetch the new file.
 */
function computeAssetVersion(publicDir) {
  const hash = crypto.createHash('sha256');
  const files = ASSET_DIRS.flatMap(d => listFiles(publicDir, d)).sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(publicDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 10);
}

/**
 * Appends ?v=<version> to src="/js/x.js" and href="/css/x.css". References that
 * already carry a query string are left alone.
 */
function addVersion(html, version) {
  return html.replace(
    /\b(src|href)="(\/(?:js|css)\/[^"?]*\.(?:js|css))"/g,
    (m, attr, url) => `${attr}="${url}?v=${version}"`
  );
}

/** Reads the HTML pages once and returns { 'index.html': rewritten, ... }. */
function loadVersionedPages(publicDir) {
  const version = computeAssetVersion(publicDir);
  const pages = {};
  for (const name of PAGES) {
    pages[name] = addVersion(fs.readFileSync(path.join(publicDir, name), 'utf8'), version);
  }
  return { version, pages };
}

module.exports = { computeAssetVersion, addVersion, loadVersionedPages };
