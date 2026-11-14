#!/usr/bin/env node
// Runs the Android project's Gradle wrapper with the given arguments, on any system:
// `./gradlew` does not exist as a command in the Windows command prompt, where the wrapper is gradlew.bat.
// Usage: node scripts/gradlew.mjs assembleRelease
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const android = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'android');
const win = process.platform === 'win32';
const r = spawnSync(win ? 'gradlew.bat' : './gradlew', process.argv.slice(2), { cwd: android, stdio: 'inherit', shell: win });
if (r.error) { console.error(`Could not start the Gradle wrapper in ${android}: ${r.error.message}`); process.exit(1); }
process.exit(r.status ?? 1);
