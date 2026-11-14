import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs build script without types
import { precacheList, injectPrecache, buildId } from '../../scripts/gen-sw-precache.mjs';

const sw = readFileSync(join(__dirname, '../../public/sw.js'), 'utf8');

/** Runs sw.js with a fake worker scope and returns its listeners and the fake caches. */
function loadWorker(source: string, online: Record<string, { status: number; body: string }>) {
  const listeners: Record<string, (e: any) => void> = {};
  const stores = new Map<string, Map<string, any>>();
  const abs = (u: any) => new URL(typeof u === 'string' ? u : u.url, 'https://app.example/folio/sw.js').href;
  const cacheOf = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (r: any) => m.get(abs(r)),
      put: async (r: any, res: any) => { m.set(abs(r), res); },
      addAll: async (rs: any[]) => { for (const r of rs) { const res = await fetchFn(r); if (res.status !== 200) throw new Error('addAll'); m.set(abs(r), res); } },
    };
  };
  const response = (url: string, o: { status: number; body: string }) => ({ url, status: o.status, ok: o.status === 200, type: 'basic', body: o.body, clone() { return response(url, o); } });
  let offline = false;
  const fetchFn = async (r: any) => { const u = abs(r); if (offline || !(u in online)) { if (offline) throw new Error('offline'); return response(u, { status: 404, body: 'nf' }); } return response(u, online[u]); };
  const scope: any = {
    location: { href: 'https://app.example/folio/sw.js', origin: 'https://app.example' },
    addEventListener: (n: string, f: (e: any) => void) => { listeners[n] = f; },
    skipWaiting: async () => undefined, clients: { claim: async () => undefined },
  };
  const caches = {
    open: async (n: string) => cacheOf(n), keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n),
    match: async (r: any) => { for (const m of stores.values()) { const hit = m.get(abs(r)); if (hit) return hit; } return undefined; },
  };
  class Req { url: string; cache?: string; constructor(u: string, o: any = {}) { this.url = abs(u); this.cache = o.cache; } }
  new Function('self', 'caches', 'fetch', 'Request', 'URL', source)(scope, caches, fetchFn, Req, URL);
  const run = async (name: string, e: any = {}) => { const waits: Promise<any>[] = []; let reply: Promise<any> | undefined; listeners[name]({ ...e, waitUntil: (p: Promise<any>) => waits.push(p), respondWith: (p: Promise<any>) => { reply = p; } }); const out = reply ? await reply.catch((err) => err) : undefined; await Promise.all(waits); return out; };
  const get = (path: string, mode = 'cors') => run('fetch', { request: { url: abs(path), method: 'GET', mode, headers: { has: () => false } } });
  return { run, get, stores, setOffline: (v: boolean) => { offline = v; } };
}

describe('scripts/gen-sw-precache.mjs', () => {
  it('lists the build files (not tesseract, maps or the worker itself) and derives an id from their content', () => {
    const dist = mkdtempSync(join(tmpdir(), 'qf-sw-'));
    for (const d of ['assets', 'pdfjs/wasm', 'icons', 'tesseract']) mkdirSync(join(dist, d), { recursive: true });
    for (const [f, c] of [['assets/index-abc.js', 'a'], ['assets/index-abc.js.map', 'm'], ['pdfjs/wasm/openjpeg.wasm', 'w'], ['icons/icon-192.png', 'i'], ['tesseract/core.wasm', 't'], ['favicon.svg', 's'], ['sw.js', sw], ['index.html', 'h']] as const) writeFileSync(join(dist, f), c);
    const a = precacheList(dist);
    expect(a.urls).toEqual(['./assets/index-abc.js', './pdfjs/wasm/openjpeg.wasm', './icons/icon-192.png', './favicon.svg']);
    writeFileSync(join(dist, 'pdfjs/wasm/openjpeg.wasm'), 'changed');
    expect(precacheList(dist).hash).not.toBe(a.hash);   // an unhashed file that changes gives a new build id, so a new cache
    expect(buildId(a.hash, 1_800_000_000_000)).toMatch(/^[0-9a-z]{8}-[0-9a-f]{8}$/);
    expect(buildId(a.hash, 1_800_000_000_000) < buildId(a.hash, 1_800_000_100_000)).toBe(true);
  });
  it('fills both placeholders of public/sw.js and refuses a file without them', () => {
    const out = injectPrecache(sw, 'mh0abcde-0123abcd', ['./assets/a.js']);
    expect(out).toContain("const BUILD_ID = /*__BUILD_ID__*/ 'mh0abcde-0123abcd';");
    expect(out).toContain('const PRECACHE = /*__PRECACHE__*/ ["./assets/a.js"];');
    expect(injectPrecache(out, 'mh0abcdf-0123abce', [])).toContain("'mh0abcdf-0123abce'");   // can run again on its own output
    expect(() => injectPrecache('self.addEventListener("fetch", () => {})', 'mh0abcde-0123abcd', [])).toThrow();
  });
});

describe('public/sw.js', () => {
  const base = 'https://app.example/folio/';
  const site = { [base]: { status: 200, body: 'INDEX' }, [base + 'index.html']: { status: 200, body: 'INDEX' }, [base + 'manifest.webmanifest']: { status: 200, body: '{}' }, [base + 'assets/a.js']: { status: 200, body: 'A' }, [base + 'pdfjs/x.wasm']: { status: 200, body: 'W1' }, [base + 'third-party-notices.txt']: { status: 200, body: 'NOTICES' } };

  it('works without the injected list and with it fetches every listed file on install', async () => {
    const dev = loadWorker(sw, site);
    await dev.run('install');
    expect([...dev.stores.get('quillfolio-dev')!.keys()].sort()).toEqual([base, base + 'index.html', base + 'manifest.webmanifest'].sort());
    const built = loadWorker(injectPrecache(sw, 'mh0abcde-0123abcd', ['./assets/a.js', './pdfjs/x.wasm', './assets/missing.js']), site);
    await built.run('install');   // the missing file does not fail the install
    const c = built.stores.get('quillfolio-mh0abcde-0123abcd')!;
    expect(c.has(base + 'assets/a.js') && c.has(base + 'pdfjs/x.wasm')).toBe(true);   // was 3 entries: offline reload after one visit failed
    expect(c.has(base + 'assets/missing.js')).toBe(false);
    built.setOffline(true);
    expect((await built.get('./assets/a.js')).body).toBe('A');
    expect((await built.get('./', 'navigate')).body).toBe('INDEX');
  });

  it('never stores another page or an error page as the offline start page', async () => {
    const w = loadWorker(sw, site);
    await w.run('install');
    expect((await w.get('./third-party-notices.txt', 'navigate')).body).toBe('NOTICES');
    expect((await w.get('./no-such-page', 'navigate')).status).toBe(404);
    w.setOffline(true);
    expect((await w.get('./', 'navigate')).body).toBe('INDEX');   // was the notices text, then the 404 page
  });

  it('serves unhashed files from the network first and keeps only its own older caches trimmed', async () => {
    const live = { ...site };
    const w = loadWorker(injectPrecache(sw, 'mh0abcde-0123abcd', ['./pdfjs/x.wasm']), live);
    await w.run('install');
    live[base + 'pdfjs/x.wasm'] = { status: 200, body: 'W2' };
    expect((await w.get('./pdfjs/x.wasm')).body).toBe('W2');     // was the stale cached copy first
    for (const n of ['quillfolio-v1', 'quillfolio-mg000000-aaaaaaaa', 'quillfolio-mg111111-bbbbbbbb', 'transformers-cache', 'quillpen-v1']) await (w.stores.set(n, new Map()), Promise.resolve());
    await w.run('activate');
    expect([...w.stores.keys()].sort()).toEqual(['quillfolio-mg111111-bbbbbbbb', 'quillfolio-mh0abcde-0123abcd', 'quillpen-v1', 'transformers-cache']);   // was: every other cache deleted
  });

  it('leaves POST and other origins alone', async () => {
    const w = loadWorker(sw, site);
    expect(await w.run('fetch', { request: { url: 'https://api.openai.com/v1/chat', method: 'POST', mode: 'cors', headers: { has: () => false } } })).toBeUndefined();
    expect(await w.run('fetch', { request: { url: 'https://openrouter.ai/api/v1/models', method: 'GET', mode: 'cors', headers: { has: () => false } } })).toBeUndefined();
  });
});
