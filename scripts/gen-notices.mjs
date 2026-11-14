// Writes public/third-party-notices.txt: the license of every runtime npm package Anne's Folio
// ships (dependencies and their dependencies), so the notices the MIT, BSD, SIL OFL and Apache
// licenses ask for travel with the web build and the Android app. Runs before `npm run build`.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Node's lookup: the nearest node_modules/<name> at or above `from`. */
function resolvePkg(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return p;
    if (dir === root || dirname(dir) === dir) return null;
  }
}

// Dependencies of Transformers.js that only its Node.js build uses; the app bundles the browser build, so
// these (and what only they depend on) are not in the web build or the apps.
const NOT_SHIPPED = new Set(['onnxruntime-node', 'sharp']);

const seen = new Map(); // directory -> package.json
const queue = Object.keys(rootPkg.dependencies || {}).map((n) => [n, root]);
while (queue.length) {
  const [name, from] = queue.shift();
  if (NOT_SHIPPED.has(name)) continue;
  const dir = resolvePkg(name, from);
  if (!dir || seen.has(dir)) continue;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  seen.set(dir, pkg);
  for (const dep of Object.keys(pkg.dependencies || {})) queue.push([dep, dir]);
}

const repoUrl = (pkg) => {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!r) return pkg.homepage || '';
  return r.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/').replace(/^git:\/\//, 'https://');
};
const licenseText = (dir) => {
  const files = readdirSync(dir);
  const f = files.find((n) => /^(licen[cs]e|copying)(\.(md|markdown|txt))?$/i.test(n));
  if (f) return readFileSync(join(dir, f), 'utf8').trim();
  // Some packages carry the license only in their README's "License" section.
  const readme = files.find((n) => /^readme(\.(md|markdown|txt))?$/i.test(n));
  const m = readme && readFileSync(join(dir, readme), 'utf8').match(/^#+\s*licen[cs]e\s*\n([\s\S]*?)(?=^#+\s|(?![\s\S]))/im);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
};

const rule = '-'.repeat(78);
const parts = [
  'Anne\'s Folio third-party notices',
  '',
  'Anne\'s Folio is MIT-licensed. It includes the open-source components below; each one\'s',
  'copyright notice and license follow. The Android app also includes AndroidX libraries',
  '(appcompat, coordinatorlayout, core, core-splashscreen, activity) under the Apache',
  'License 2.0, whose text appears below with Material Symbols.',
  '',
  'Hunspell (https://github.com/hunspell/hunspell), compiled to WebAssembly inside hunspell-asm',
  'and used unmodified for downloaded spelling dictionaries, is tri-licensed under the Mozilla',
  'Public License 1.1, GPL 2.0 or LGPL 2.1; Anne\'s Folio uses it under the MPL 1.1',
  '(https://www.mozilla.org/MPL/1.1/). Its source code is available at the address above.',
  'Desktop builds also include Electron (MIT) and Chromium, whose licenses ship alongside the',
  'app as LICENSE.electron.txt and LICENSES.chromium.html.',
  '',
];
const sorted = [...seen.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
for (const [dir, pkg] of sorted) {
  const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || (pkg.licenses || []).map((l) => l.type || l).join(' OR ') || 'see below';
  parts.push(rule, `${pkg.name} ${pkg.version} - ${lic}`, repoUrl(pkg), rule, '', licenseText(dir) || `License: ${lic} (no license file in the package).`, '');
}
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public', 'third-party-notices.txt'), parts.join('\n'));
console.log(`third-party-notices.txt: ${sorted.length} packages`);
