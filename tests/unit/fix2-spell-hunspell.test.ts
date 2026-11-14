// Hunspell (hunspell-asm, for downloaded dictionaries) names its in-memory files with nanoid(45). nanoid is
// replaced by vendor/nanoid-compat (npm audit flagged nanoid 2); this checks the replacement keeps Hunspell working.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('Hunspell with the vendored nanoid', () => {
  it('nanoid-compat keeps nanoid 2\'s call shape', () => {
    const nanoid = require('nanoid');
    expect(typeof nanoid).toBe('function');
    const id = nanoid(45);
    expect(id).toMatch(/^[A-Za-z0-9_-]{45}$/);
    expect(nanoid(45)).not.toBe(id);
    expect(nanoid().length).toBe(21);
    for (const bad of [0, -5, 2.5, NaN, Infinity]) expect(nanoid(bad).length).toBeGreaterThan(0);
  });
  it('loads a dictionary and checks and suggests words', async () => {
    const { loadModule } = require('hunspell-asm/dist/cjs/index.js');
    const factory = await loadModule();
    const dir = `${process.cwd()}/node_modules/dictionary-en/`;
    const aff = factory.mountBuffer(new Uint8Array(readFileSync(dir + 'index.aff')), 'en.aff');
    const dic = factory.mountBuffer(new Uint8Array(readFileSync(dir + 'index.dic')), 'en.dic');
    const h = factory.create(aff, dic);
    expect(h.spell('sentence')).toBe(true);
    expect(h.spell('sentense')).toBe(false);
    expect(h.suggest('sentense')).toContain('sentence');
    h.dispose(); factory.unmount(aff); factory.unmount(dic);
  }, 60000);
});
