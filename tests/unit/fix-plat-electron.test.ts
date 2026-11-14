// @vitest-environment node
/** Desktop shell (electron/main.cjs) run against a stand-in for the 'electron' module. */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const MAIN = path.resolve('electron/main.cjs');
const realLoad = (Module as any)._load;
const realPlatform = process.platform;
const realArgv = process.argv;
let tmp = '';

interface Shell {
  handlers: Record<string, (e: unknown, o?: unknown) => Promise<any>>;
  events: Record<string, (...a: any[]) => void>;
  wcEvents: Record<string, (...a: any[]) => void>;
  call: (name: string, opts?: unknown, senderUrl?: string) => Promise<any>;
  proto: (url: string) => Promise<Response>;
  ask: (permission: string, details?: Record<string, unknown>, contents?: unknown) => Promise<boolean>;
  check: (permission: string, origin: string, details?: Record<string, unknown>) => boolean;
  wc: Record<string, any>;
  state: { quit: boolean; windows: number; lastOpen: any; fetchOpts: any };
}

async function start(opts: { lock?: boolean; backend?: string; platform?: string; argv?: string[] } = {}): Promise<Shell> {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-main-'));
  fs.mkdirSync(path.join(tmp, 'userData'));
  const backend = opts.backend ?? 'gnome_libsecret';
  const handlers: Shell['handlers'] = {}, events: Shell['events'] = {}, wcEvents: Shell['wcEvents'] = {};
  const state: Shell['state'] = { quit: false, windows: 0, lastOpen: null, fetchOpts: null };
  let protoHandler: any = null, permReq: any = null, permCheck: any = null, ready!: () => void;
  const readyP = new Promise<void>((r) => { ready = r; });
  const wc: Shell['wc'] = { send() {}, on(n: string, f: any) { wcEvents[n] = f; }, setWindowOpenHandler() {}, getURL: () => 'app://quillfolio/index.html', print() {} };
  const win = { webContents: wc, on() {}, loadURL: async () => undefined, isMinimized: () => false, focus() {}, restore() {} };
  const electron = {
    app: { setPath() {}, getPath: (n: string) => path.join(tmp, n), requestSingleInstanceLock: () => opts.lock !== false, quit() { state.quit = true; }, on(n: string, f: any) { events[n] = f; }, whenReady: () => readyP, isReady: () => true, isPackaged: true, getVersion: () => '0.0.0' },
    BrowserWindow: class { constructor() { state.windows++; return win as any; } static getAllWindows() { return [win]; } },
    protocol: { registerSchemesAsPrivileged() {}, handle(_s: string, f: any) { protoHandler = f; } },
    net: { fetch: async (_u: string, o: any) => { state.fetchOpts = o; return { status: 200, headers: new Headers({ 'retry-after': '7' }), text: async () => 'ok', body: null }; } },
    ipcMain: { handle(n: string, f: any) { handlers[n] = f; }, on() {} },
    dialog: { showOpenDialog: async (_w: unknown, o: unknown) => { state.lastOpen = o; return { canceled: true, filePaths: [] }; }, showSaveDialog: async () => ({ canceled: true }), showMessageBoxSync: () => 1 },
    shell: { openExternal: async () => undefined },
    clipboard: { readText: () => '', writeText() {} },
    safeStorage: { isEncryptionAvailable: () => backend !== 'none', encryptString: (v: string) => Buffer.from('E:' + v), decryptString: (b: Buffer) => b.toString().slice(2), getSelectedStorageBackend: () => backend },
    powerSaveBlocker: { start: () => 1, stop() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
    session: { defaultSession: { setPermissionRequestHandler(f: any) { permReq = f; }, setPermissionCheckHandler(f: any) { permCheck = f; } } },
  };
  (Module as any)._load = function (req: string, ...a: unknown[]) { return req === 'electron' ? electron : realLoad.call(this, req, ...a); };
  Object.defineProperty(process, 'platform', { value: opts.platform ?? 'linux' });
  process.argv = opts.argv ?? ['electron'];
  delete require.cache[MAIN];
  require(MAIN);
  ready();
  await new Promise((r) => setTimeout(r, 20));
  const ev = (url: string) => ({ sender: wc, senderFrame: { url } });
  return {
    handlers, events, wcEvents, wc, state,
    call: (name, o, senderUrl = 'app://quillfolio/index.html') => handlers['ql:' + name](ev(senderUrl), o),
    proto: (url) => protoHandler({ url }),
    ask: (permission, details = {}, contents = wc) => new Promise((res) => permReq(contents, permission, res, { requestingUrl: 'app://quillfolio/index.html', ...details })),
    check: (permission, origin, details = {}) => permCheck(wc, permission, origin, details),
  };
}

afterEach(() => {
  (Module as any)._load = realLoad;
  Object.defineProperty(process, 'platform', { value: realPlatform });
  process.argv = realArgv;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** A document reached through a link, opened from the command line (which grants access to it). */
function linkedDoc(): { doc: string; link: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-doc-'));
  const doc = path.join(dir, 'real', 'doc.pdf');
  fs.mkdirSync(path.dirname(doc));
  fs.writeFileSync(doc, 'OLD');
  fs.chmodSync(doc, 0o640);
  const link = path.join(dir, 'link.pdf');
  fs.symlinkSync(doc, link);
  return { doc, link };
}

describe('who may call the bridge', () => {
  it('only the app\'s own pages: a look-alike host is refused', async () => {
    const s = await start();
    await expect(s.call('readClipboard', {}, 'app://quillfolio.evil.example/index.html')).rejects.toThrow('Refused');
    await expect(s.call('readClipboard', {})).resolves.toEqual({ text: '' });
  });

  it('the app:// handler serves only its own host and stays inside dist/', async () => {
    const s = await start();
    expect((await s.proto('app://evil.example/index.html')).status).toBe(403);
    expect((await s.proto('app://quillfolio/..%2f..%2fetc/passwd')).status).toBe(403);
    expect((await s.proto('app://quillfolio/%E0%A4%A')).status).toBe(400);
  });

  it('navigation away from the app is stopped, including to a look-alike host', async () => {
    const s = await start();
    const stopped = (url: string) => { let n = 0; s.wcEvents['will-navigate']({ preventDefault() { n++; } }, url); return n; };
    expect([stopped('app://quillfolio/index.html'), stopped('app://quillfolio.evil.example/'), stopped('https://example.com/')]).toEqual([0, 1, 1]);
  });

  it('the policy has no eval and no CDN', () => {
    const csp = fs.readFileSync(MAIN, 'utf8').split('const CSP')[1].split('].join')[0];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' blob:");
    expect(csp).not.toMatch(/unsafe-eval'(?<!wasm-unsafe-eval')|https:\/\/cdn\./);
  });
});

describe('permissions', () => {
  it('audio capture, clipboard and full screen for the app; nothing else, and nothing for other origins', async () => {
    const s = await start();
    expect(await s.ask('media', { mediaTypes: ['audio'] })).toBe(true);
    expect(await s.ask('clipboard-read')).toBe(true);
    expect(await s.ask('fullscreen')).toBe(true);
    for (const [p, d] of [['media', { mediaTypes: ['video'] }], ['media', { mediaTypes: ['audio', 'video'] }], ['geolocation', {}], ['notifications', {}], ['midi', {}], ['display-capture', {}]] as const) expect(await s.ask(p, d), p).toBe(false);
    expect(await s.ask('fullscreen', { requestingUrl: 'https://example.com/' })).toBe(false);
    expect(await s.ask('fullscreen', {}, {})).toBe(false); // some other web contents
    expect(s.check('media', 'app://quillfolio', { mediaType: 'audio' })).toBe(true);
    expect(s.check('media', 'app://quillfolio', { mediaType: 'video' })).toBe(false);
    expect(s.check('usb', 'app://quillfolio')).toBe(false);
    expect(s.check('clipboard-read', 'https://example.com')).toBe(false);
  });
});

describe('writing back to a document', () => {
  it('follows a link, keeps the file\'s permissions, sends and returns bytes, leaves no temporary file', async () => {
    const { doc, link } = linkedDoc();
    const s = await start({ argv: ['electron', link] });
    const uri = pathToFileURL(link).href;
    await expect(s.call('writeUri', { uri, bytes: new Uint8Array(Buffer.from('NEW')) })).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(doc, 'utf8')).toBe('NEW');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(doc).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(path.dirname(doc))).toEqual(['doc.pdf']);
    const r = await s.call('readUri', { uri });
    expect(Buffer.from(r.bytes).toString()).toBe('NEW');
    expect('data' in r).toBe(false);
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  });

  it('a failed write keeps the document and cleans up', async () => {
    const { doc, link } = linkedDoc();
    const s = await start({ argv: ['electron', link] });
    const rename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }; // a file another program holds open
    try {
      await expect(s.call('writeUri', { uri: pathToFileURL(link).href, data: Buffer.from('X').toString('base64') })).rejects.toThrow('locked');
    } finally { fs.renameSync = rename; }
    expect(fs.readFileSync(doc, 'utf8')).toBe('OLD');
    expect(fs.readdirSync(path.dirname(doc))).toEqual(['doc.pdf']);
    fs.rmSync(path.dirname(link), { recursive: true, force: true });
  });

  it('a file that was never opened or saved here cannot be read', async () => {
    const s = await start();
    await expect(s.call('readUri', { uri: pathToFileURL('/etc/hostname').href })).rejects.toThrow(/no permission/);
  });
});

describe('saved keys', () => {
  it('says whether the system really encrypts them', async () => {
    let s = await start();
    expect(await s.call('secureSet', { key: 'k', value: 'v' })).toEqual({ encrypted: true });
    expect(await s.call('secureGet', { key: 'k' })).toEqual({ value: 'v' });
    expect(fs.readdirSync(path.join(tmp, 'userData')).filter((f) => f.startsWith('secure'))).toEqual(['secure.json']);
    s = await start({ backend: 'basic_text' }); // Linux without a keyring: a fixed password
    expect(await s.call('secureSet', { key: 'k', value: 'v' })).toEqual({ encrypted: false });
    expect(await s.call('secureInfo')).toEqual({ encrypted: false, available: true, backend: 'basic_text' });
    s = await start({ backend: 'none' });
    expect(await s.call('secureInfo')).toMatchObject({ encrypted: false, available: false });
    s = await start({ platform: 'darwin' });
    expect(await s.call('secureInfo')).toEqual({ encrypted: true, available: true, backend: 'keychain' });
  });
});

describe('starting up', () => {
  it('a second copy quits without opening a window or registering anything', async () => {
    const s = await start({ lock: false });
    expect(s.state).toMatchObject({ quit: true, windows: 0 });
    expect(Object.keys(s.handlers)).toEqual([]);
  });

  it('a file named by a second copy is found in that copy\'s folder', async () => {
    const s = await start();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-cwd-'));
    fs.writeFileSync(path.join(other, 'b.pdf'), 'B');
    s.events['second-instance']({}, ['app', './b.pdf'], other);
    expect((await s.call('getLaunchFile')).name).toBe('b.pdf');
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('of the 200 remembered files, the one just re-opened is the last to be forgotten', async () => {
    const s = await start();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-many-'));
    const file = (i: number | string) => path.join(dir, `f${i}.pdf`);
    const open = (i: number | string) => { fs.writeFileSync(file(i), 'x'); s.events['second-instance']({}, ['app', file(i)], dir); };
    for (let i = 0; i < 200; i++) open(i);
    open(0); // the oldest file is opened again
    open('new'); // then one more: something has to go
    const readable = (i: number | string) => s.call('readUri', { uri: pathToFileURL(file(i)).href }).then(() => true, () => false);
    expect([await readable(0), await readable(1), await readable('new')]).toEqual([true, false, true]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the open dialog honours the types the page asks for', async () => {
    const s = await start();
    await s.call('openDocument', { mimeTypes: ['application/pdf'] });
    expect(s.state.lastOpen.filters[0]).toEqual({ name: 'PDF', extensions: ['pdf'] });
    await s.call('openDocument', { mimeTypes: ['*/*'] });
    expect(s.state.lastOpen.filters[0].extensions).toContain('png');
  });

  it('requests for AI providers are https only, time-limited, and pass Retry-After on', async () => {
    const s = await start();
    await expect(s.call('http', { url: 'http://example.com' })).rejects.toThrow(/Only https/);
    expect(await s.call('http', { url: 'https://example.com' })).toEqual({ status: 200, text: 'ok', retryAfter: '7' });
    expect(s.state.fetchOpts.signal).toBeInstanceOf(AbortSignal);
  });
});
