// Runs after `vite build`: writes the list of the build's files and a build id into dist/sw.js, so the
// service worker can fetch the whole app on install (offline after one visit) and name its cache after
// the build (files of two builds are never mixed, old caches are dropped).
//
//   node scripts/gen-sw-precache.mjs [distDir]     (default: dist)
//
// public/sw.js carries two placeholders, `/*__BUILD_ID__*/ 'dev'` and `/*__PRECACHE__*/ []`; without
// this step it still works and caches files as they are fetched.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Folders and files fetched on install. The OCR engine (tesseract/, about 12 MB) is cached when it is first used instead. */
const INCLUDE_DIRS = ['assets', 'pdfjs', 'icons'];
const INCLUDE_FILES = ['favicon.svg', 'third-party-notices.txt'];
const SKIP = /\.(map|br|gz)$/i;

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (!SKIP.test(name)) out.push(p);
  }
  return out;
}

/** The files to precache as URLs relative to the worker ('./assets/…'), sorted, and a hash of their names and contents. */
export function precacheList(dist) {
  const files = [];
  for (const d of INCLUDE_DIRS) if (existsSync(join(dist, d))) walk(join(dist, d), files);
  for (const f of INCLUDE_FILES) if (existsSync(join(dist, f))) files.push(join(dist, f));
  const hash = createHash('sha256');
  const urls = [];
  for (const f of files) {
    const rel = relative(dist, f).split(sep).join('/');
    hash.update(rel).update('\0').update(readFileSync(f)).update('\0');
    urls.push('./' + rel.split('/').map(encodeURIComponent).join('/'));
  }
  for (const f of ['index.html', 'manifest.webmanifest']) if (existsSync(join(dist, f))) hash.update(f).update('\0').update(readFileSync(join(dist, f)));
  return { urls, hash: hash.digest('hex') };
}

/** sw.js source with the build id and the precache list filled in. Throws when a placeholder is missing. */
export function injectPrecache(source, buildId, urls) {
  const idAt = /\/\*__BUILD_ID__\*\/\s*'[^']*'/, listAt = /\/\*__PRECACHE__\*\/\s*\[[^\]]*\]/;
  if (!idAt.test(source) || !listAt.test(source)) throw new Error('sw.js has no /*__BUILD_ID__*/ or /*__PRECACHE__*/ placeholder');
  if (!/^[0-9a-z]{8,}-[0-9a-f]{8}$/.test(buildId)) throw new Error(`Unexpected build id ${buildId}`);
  return source.replace(idAt, () => `/*__BUILD_ID__*/ '${buildId}'`).replace(listAt, () => `/*__PRECACHE__*/ ${JSON.stringify(urls)}`);
}

/** Build ids sort by build time (the worker keeps the newest earlier cache) and end in the content hash. */
export function buildId(hash, now = Date.now()) {
  return `${now.toString(36).padStart(8, '0')}-${hash.slice(0, 8)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = process.argv[2] || 'dist';
  const sw = join(dist, 'sw.js');
  if (!existsSync(sw)) { console.error(`gen-sw-precache: ${sw} not found (run vite build first)`); process.exit(1); }
  const { urls, hash } = precacheList(dist);
  const id = buildId(hash);
  writeFileSync(sw, injectPrecache(readFileSync(sw, 'utf8'), id, urls));
  console.log(`gen-sw-precache: ${urls.length} files, build ${id}`);
}
