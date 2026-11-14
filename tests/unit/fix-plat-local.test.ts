/** On-device model: Stop works while the model is still loading, and nothing is left waiting forever. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

class FakeWorker {
  static last: FakeWorker;
  posted: any[] = [];
  terminated = false;
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  constructor(public url: URL, public opts: unknown) { FakeWorker.last = this; }
  postMessage(m: any) { this.posted.push(m); }
  terminate() { this.terminated = true; }
  reply(m: any) { this.onmessage?.({ data: m }); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function fresh() {
  vi.resetModules();
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
  return import('../../src/ai/local');
}
beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('on-device model', () => {
  it('the worker is the app\'s own file and is told where the bundled ONNX Runtime is', async () => {
    const local = await fresh();
    void local.loadLocalModel('onnx-community/Qwen2.5-0.5B-Instruct').catch(() => undefined);
    await tick();
    const w = FakeWorker.last;
    expect(String(w.url)).toMatch(/\/src\/ai\/local\.worker\.ts(\?|$)/);
    expect(w.posted[0]).toMatchObject({ type: 'load', model: 'onnx-community/Qwen2.5-0.5B-Instruct' });
    expect(w.posted[0].ortBase).toMatch(/\/ort\/$/);
  });

  it('no code is loaded from a CDN', () => {
    const src = readFileSync('src/ai/local.ts', 'utf8') + readFileSync('src/ai/local.worker.ts', 'utf8');
    expect(src).not.toMatch(/https?:\/\/[^\s'"`]*(jsdelivr|unpkg|esm\.sh)/);
    expect(readFileSync('electron/main.cjs', 'utf8').split('const CSP')[1].split('].join')[0]).not.toMatch(/jsdelivr|'unsafe-eval'/);
  });

  it('Stop while the model is loading ends the request at once and tells the worker which one', async () => {
    const local = await fresh();
    const ctl = new AbortController();
    const p = local.localChat('m', { messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal }).then(() => 'answered', (e) => e.code);
    await tick();
    const w = FakeWorker.last;
    const id = w.posted[0].id;
    ctl.abort();
    expect(await p).toBe('aborted'); // without waiting for the worker
    expect(w.posted[1]).toEqual({ type: 'stop', id });
    // A late answer for the stopped request is ignored.
    w.reply({ type: 'done', id, text: 'late' });
  });

  it('a request the worker reports as stopped is rejected as Stopped', async () => {
    const local = await fresh();
    const p = local.loadLocalModel('m').then(() => 'loaded', (e) => e.code);
    await tick();
    FakeWorker.last.reply({ type: 'stopped', id: FakeWorker.last.posted[0].id });
    expect(await p).toBe('aborted');
  });

  it('deleting the models settles requests that were waiting', async () => {
    const local = await fresh();
    const p = local.localChat('m', { messages: [{ role: 'user', content: 'hi' }] }).then(() => 'answered', (e) => e.code);
    await tick();
    await local.clearLocalModels();
    expect(await Promise.race([p, new Promise((r) => setTimeout(() => r('still waiting'), 200))])).toBe('aborted');
    expect(FakeWorker.last.terminated).toBe(true);
  });

  it('a crashed worker settles every waiting request', async () => {
    const local = await fresh();
    const a = local.loadLocalModel('m').then(() => 'loaded', (e) => e.code);
    const b = local.localChat('m', { messages: [{ role: 'user', content: 'hi' }] }).then(() => 'answered', (e) => e.code);
    await tick();
    FakeWorker.last.onerror?.({ message: 'boom' });
    expect(await Promise.all([a, b])).toEqual(['network', 'network']);
  });

  it('refuses a download the browser reports no room for, with the numbers', async () => {
    const local = await fresh();
    vi.stubGlobal('caches', { open: async () => ({ keys: async () => [] }) });
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ quota: 100 * 1048576, usage: 40 * 1048576 }), persist: async () => true } });
    try {
      const msg = await local.loadLocalModel('onnx-community/Qwen2.5-0.5B-Instruct').then(() => 'started', (e) => e.message);
      expect(msg).toMatch(/needs about 510 MB/);
      expect(msg).toMatch(/about 60 MB more/);
    } finally { delete (navigator as any).storage; }
  });
});

describe('scripts/copy-pdfjs.mjs', () => {
  it('ships the ONNX Runtime loaders as .js, the name the worker asks for', () => {
    expect(readFileSync('scripts/copy-pdfjs.mjs', 'utf8')).toContain("f.replace(/\\.mjs$/, '.js')");
    expect(readFileSync('src/ai/local.worker.ts', 'utf8')).toContain(".replace(/\\.mjs$/, '.js')");
    if (existsSync('public/ort')) expect(readdirSync('public/ort').filter((f) => !/\.(js|wasm)$/.test(f))).toEqual([]);
  });

  it('stops on a missing source instead of warning', () => {
    const src = readFileSync('scripts/copy-pdfjs.mjs', 'utf8');
    expect(src).not.toMatch(/console\.warn\('missing'/);
    expect(src).toMatch(/throw new Error\(`missing in node_modules/);
  });
});
