#!/usr/bin/env node
// Stages the desktop app for electron-builder in build/desktop-app/: the web build (dist/), the
// Electron main and preload scripts, an icon, and a package.json with no dependencies (everything
// the app needs is already bundled into dist/ by Vite). Run after `npm run build`.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build/desktop-app');
if (!existsSync(join(root, 'dist/index.html'))) throw new Error('dist/ is missing: run npm run build first');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'electron'), { recursive: true });
cpSync(join(root, 'dist'), join(out, 'dist'), { recursive: true });
for (const f of ['main.cjs', 'preload.cjs']) cpSync(join(root, 'electron', f), join(out, 'electron', f));
cpSync(join(root, 'resources/icon-512.png'), join(out, 'electron/icon.png'));
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'quillfolio',
  productName: 'Anne\'s Folio',
  version: pkg.version,
  description: pkg.description,
  homepage: 'https://github.com/socrtwo/annes-folio',
  author: { name: 'socrtwo', email: 'socrtwo@users.noreply.github.com' },
  license: pkg.license,
  main: 'electron/main.cjs',
  desktopName: 'quillfolio.desktop',
}, null, 2));
console.log('staged', out);
