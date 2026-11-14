/** AI settings and key storage: one notification per save, keys re-read after another tab changes them, never in localStorage. */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, unknown>();
let idb = true; // false: util/store is on its localStorage fallback
vi.mock('../../src/util/store', () => ({
  kvGet: async (k: string) => (idb ? kv.get(k) : JSON.parse(localStorage.getItem('qlkv:' + k) ?? 'null') ?? undefined),
  kvSet: async (k: string, v: unknown) => { if (idb) kv.set(k, v); else localStorage.setItem('qlkv:' + k, JSON.stringify(v)); },
  kvDel: async (k: string) => { if (idb) kv.delete(k); else localStorage.removeItem('qlkv:' + k); },
}));

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function fresh() {
  vi.resetModules();
  return import('../../src/ai/store');
}

beforeEach(() => { kv.clear(); localStorage.clear(); idb = true; });

describe('settings change notifications', () => {
  it('a save tells listeners once and does not make this tab reload what it just wrote', async () => {
    const store = await fresh();
    let n = 0;
    store.onAiSettingsChange(() => n++);
    const before = store.aiSettings();
    store.saveAiSettings((s) => { s.language = 'French'; });
    await tick();
    expect(n).toBe(1);
    expect(store.aiSettings()).toBe(before); // the cache was not thrown away
  });

  it('a change that could not be written to storage still applies in this tab', async () => {
    const store = await fresh();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      store.saveAiSettings((s) => { s.language = 'German'; });
      await tick();
      expect(store.aiSettings().language).toBe('German');
    } finally { spy.mockRestore(); }
  });

  it('another tab\'s change reloads settings and drops cached keys', async () => {
    const store = await fresh();
    await store.setApiKey('groq', 'old-key');
    expect(await store.getApiKey('groq')).toBe('old-key');
    // Another tab replaces the key and the settings, then announces it.
    kv.set('aikey:groq', 'new-key');
    localStorage.setItem('quillfolio.ai.v1', JSON.stringify({ language: 'Spanish' }));
    const other = new BroadcastChannel('quillfolio-ai');
    other.postMessage({ type: 'keys' });
    await tick();
    other.close();
    expect(await store.getApiKey('groq')).toBe('new-key');
    expect(store.aiSettings().language).toBe('Spanish');
  });
});

describe('where keys are kept', () => {
  it('browser: IndexedDB, reported as not encrypted', async () => {
    const store = await fresh();
    const where = await store.setApiKey('groq', 'k1');
    expect(where).toMatchObject({ kind: 'browser', persistent: true, encrypted: false });
    expect(kv.get('aikey:groq')).toBe('k1');
    expect(Object.keys(localStorage).filter((k) => k.includes('aikey'))).toEqual([]);
  });

  it('a browser without IndexedDB: the key stays in memory and never reaches localStorage', async () => {
    idb = false;
    const store = await fresh();
    const where = await store.setApiKey('groq', 'secret-key');
    expect(where).toMatchObject({ kind: 'memory', persistent: false });
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('secret-key');
    expect(await store.getApiKey('groq')).toBe('secret-key'); // usable until the tab closes
    // Another tab's announcement must not wipe a key that exists nowhere else.
    store.reloadAiSettings();
    expect(await store.getApiKey('groq')).toBe('secret-key');
    expect((await store.keyStorage()).kind).toBe('memory');
  });

  it('a key an earlier version left in localStorage is used once and removed from there', async () => {
    idb = false;
    localStorage.setItem('qlkv:aikey:groq', JSON.stringify('legacy-key'));
    const store = await fresh();
    expect(await store.getApiKey('groq')).toBe('legacy-key');
    expect(localStorage.getItem('qlkv:aikey:groq')).toBeNull();
  });

  it('a storage failure is not remembered as "no key"', async () => {
    const store = await fresh();
    kv.set('aikey:groq', 'k');
    const mod = await import('../../src/util/store');
    const spy = vi.spyOn(mod, 'kvGet').mockRejectedValueOnce(new Error('blocked'));
    expect(await store.getApiKey('groq')).toBe('');
    expect(await store.getApiKey('groq')).toBe('k');
    spy.mockRestore();
  });

  it('deleting a key removes it everywhere', async () => {
    const store = await fresh();
    await store.setApiKey('groq', 'k1');
    await store.deleteApiKey('groq');
    expect(kv.has('aikey:groq')).toBe(false);
    expect(await store.getApiKey('groq')).toBe('');
  });
});
