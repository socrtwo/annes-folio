// Anne's Folio desktop app (Windows, macOS, Linux, Raspberry Pi OS): Electron main process.
//
// The web build (dist/) is served from the privileged app:// scheme so module workers, fetch and
// IndexedDB behave as on the web. The renderer is sandboxed with context isolation and no Node;
// electron/preload.cjs exposes `window.quillDesktop`, the same interface as the Android plugin.
// File access is limited to files the user opened or saved through a dialog, or opened the app
// with, so document content cannot use the bridge to read or overwrite arbitrary files.
'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, clipboard, safeStorage, powerSaveBlocker, Menu, session } = require('electron');
const path = require('node:path');
// The data folder keeps the app's former name (QuillFolio) so settings, drafts and keys stay where earlier versions put them. // rename:keep
app.setPath('userData', path.join(app.getPath('appData'), 'QuillFolio')); // rename:keep
app.setPath('sessionData', app.getPath('userData')); // rename:keep
const fs = require('node:fs');

const http = require('node:http');
const { pathToFileURL, fileURLToPath } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const SCHEME = 'app';
const HOST = 'quillfolio';
const ORIGIN = `${SCHEME}://${HOST}`;
/** The app's own pages: exactly app://quillfolio/… (a prefix test would also accept app://quillfolio.example). */
const isAppUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === `${SCHEME}:` && x.host === HOST; } catch { return false; } };
const OPENABLE = ['pdf', 'fdf', 'xfdf', 'qfr', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'txt', 'md', 'markdown', 'html', 'htm', 'json', 'zip'];
/** Office files also accepted on the command line (the app identifies a file by its contents and reports what it cannot open). */
const DOCUMENTS = ['docx', 'docm', 'dotx', 'doc', 'odt', 'fodt', 'rtf', 'pptx', 'odp', 'xlsx', 'ods', 'csv', 'eml'];

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// A second copy hands its file to the first and quits; it must not start up (it would rewrite the first copy's files).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/** @type {BrowserWindow | null} */
let win = null;
/** Files opened before the page could receive them. Flushed when the page registers its fileOpened listener. */
const pendingFiles = [];
let rendererReady = false;
let wakeId = -1;

// ------------------------------------------------------------------------------------------
// Files the renderer may read and write

const grantsFile = () => path.join(app.getPath('userData'), 'granted-files.json');
let grants = new Set();
function loadGrants() {
  try { grants = new Set(JSON.parse(fs.readFileSync(grantsFile(), 'utf8'))); } catch { grants = new Set(); }
}
function grant(p) {
  const abs = path.resolve(p);
  // Re-opening a file moves it to the newest end, so the files in use are the last to be dropped.
  grants.delete(abs);
  grants.add(abs);
  // Keep the most recent 200 (enough for the recent-files list).
  const list = [...grants].slice(-200);
  grants = new Set(list);
  try { fs.writeFileSync(grantsFile(), JSON.stringify(list)); } catch { /* read-only profile */ }
}
function grantedPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Not a file address');
  const p = path.resolve(fileURLToPath(uri));
  if (!grants.has(p)) throw new Error('Anne\'s Folio has no permission for this file; open it again.');
  return p;
}
const MIME = {
  pdf: 'application/pdf', fdf: 'application/vnd.fdf', xfdf: 'application/vnd.adobe.xfdf', qfr: 'application/x-quillfolio-review',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', html: 'text/html', htm: 'text/html', json: 'application/json', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odp: 'application/vnd.oasis.opendocument.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ods: 'application/vnd.oasis.opendocument.spreadsheet', csv: 'text/csv', eml: 'message/rfc822',
}
/** File contents cross to the page as bytes (structured clone), not base64: a third of the memory and no string-length limit. */
function fileResult(p) {
  const data = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  return { uri: pathToFileURL(p).href, name: path.basename(p), mime: MIME[ext] || 'application/octet-stream', bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
/** Bytes sent by the page (`bytes`), or base64 (`data`) from an older page. */
function payload(o) {
  if (o && o.bytes && ArrayBuffer.isView(o.bytes)) return Buffer.from(o.bytes.buffer, o.bytes.byteOffset, o.bytes.byteLength);
  return Buffer.from(String((o && o.data) || ''), 'base64');
}
/** `cwd`: the folder the command was typed in (a second copy passes its own). */
function fileFromArgs(argv, cwd = process.cwd()) {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    const ext = path.extname(a).slice(1).toLowerCase();
    // Files are recognized by their contents, so names without an extension open too.
    const known = OPENABLE.includes(ext) || DOCUMENTS.includes(ext) || (!ext && !a.includes('desktop-app'));
    const abs = path.resolve(cwd, a);
    try { if (known && fs.statSync(abs).isFile()) return abs; } catch { /* not a file */ }
  }
  return null;
}
function openExternalFile(p) {
  grant(p);
  if (win && rendererReady) win.webContents.send('ql:fileOpened', fileResult(p));
  else pendingFiles.push(p);
  // macOS keeps running with no window: opening a file from Finder must bring one back.
  if (!win && app.isReady()) createWindow();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}
function flushPendingFiles() {
  while (win && rendererReady && pendingFiles.length) win.webContents.send('ql:fileOpened', fileResult(pendingFiles.shift()));
}

// ------------------------------------------------------------------------------------------
// Secure storage (API keys): encrypted with the OS keychain / DPAPI / libsecret via safeStorage

const secureFile = () => path.join(app.getPath('userData'), 'secure.json');
function readSecure() { try { return JSON.parse(fs.readFileSync(secureFile(), 'utf8')); } catch { return {}; } }
/** Written to a temporary file first, so a crash mid-write cannot lose every saved key. */
function writeSecure(o) {
  const tmp = secureFile() + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 }); fs.renameSync(tmp, secureFile()); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
/**
 * How well the system protects saved keys. Linux without a keyring (GNOME Keyring, KWallet) falls back to
 * 'basic_text': safeStorage then "encrypts" with a fixed password, which hides the key from a glance and
 * nothing more. The page is told, so it can say so instead of claiming the key is encrypted.
 */
function secureInfo() {
  let available = false;
  try { available = safeStorage.isEncryptionAvailable(); } catch { /* not ready or unsupported */ }
  let backend = process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'dpapi' : 'unknown';
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    try { backend = safeStorage.getSelectedStorageBackend(); } catch { /* keep 'unknown' */ }
  }
  const weak = process.platform === 'linux' && (backend === 'basic_text' || backend === 'unknown');
  return { encrypted: available && !weak, available, backend };
}
function seal(v) {
  return safeStorage.isEncryptionAvailable() ? { enc: true, v: safeStorage.encryptString(v).toString('base64') } : { enc: false, v };
}
function unseal(rec) {
  if (!rec) return null;
  return rec.enc ? safeStorage.decryptString(Buffer.from(rec.v, 'base64')) : rec.v;
}

// ------------------------------------------------------------------------------------------
// OAuth loopback (OpenRouter PKCE), as on Android: one-shot listener on 127.0.0.1 only

let loop = null;
function stopLoop() { if (loop) { clearTimeout(loop.timer); try { loop.server.close(); } catch { /* */ } loop = null; } }

// ------------------------------------------------------------------------------------------
// IPC

const HTTP_TIMEOUT_MS = 180000;
const RELEASES_URL = 'https://github.com/socrtwo/annes-folio/releases/latest';
const safeUrl = (u) => typeof u === 'string' && /^(https?|mailto|tel|ftp|sms|geo):/i.test(u.trim());
function handle(name, fn) {
  ipcMain.handle('ql:' + name, async (e, opts) => {
    if (!win || e.sender !== win.webContents || !e.senderFrame || !isAppUrl(e.senderFrame.url)) throw new Error('Refused');
    return fn(opts || {});
  });
}

function registerIpc() {
  handle('openDocument', async ({ mimeTypes }) => {
    // The page may ask for certain types only (a PDF to compare with, for example).
    const want = Array.isArray(mimeTypes) && !mimeTypes.includes('*/*') ? OPENABLE.filter((x) => mimeTypes.includes(MIME[x])) : [];
    const exts = want.length ? want : OPENABLE;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: exts.length === 1 ? exts[0].toUpperCase() : want.length ? 'Supported files' : 'PDF and files Anne\'s Folio can turn into PDF', extensions: exts }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    grant(r.filePaths[0]);
    return fileResult(r.filePaths[0]);
  });
  handle('saveAs', async (o) => {
    const { name } = o;
    const ext = path.extname(String(name || '')).slice(1);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), path.basename(String(name || 'document'))),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] : undefined,
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, payload(o));
    grant(r.filePath);
    return { uri: pathToFileURL(r.filePath).href, name: path.basename(r.filePath) };
  });
  handle('writeUri', async (o) => {
    const p = grantedPath(o.uri);
    // Write a temporary file first, so a failed write never truncates the document. The temporary file sits
    // beside the real file (the target of a link, not the link), takes its permissions, and never outlives a failure.
    const real = fs.realpathSync(p);
    const tmp = real + '.ql-saving';
    try {
      const mode = fs.statSync(real).mode & 0o7777;
      fs.writeFileSync(tmp, payload(o), { mode });
      fs.chmodSync(tmp, mode); // the mode given at creation is cut by the umask
      fs.renameSync(tmp, real);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* report the write error, not the clean-up */ }
      throw e;
    }
    return { ok: true };
  });
  handle('readUri', async ({ uri }) => fileResult(grantedPath(uri)));
  handle('print', async () => new Promise((res) => win.webContents.print({}, () => res())));
  handle('share', async (o) => {
    // Desktops have no share sheet: offer Save As.
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), path.basename(String(o.name || 'document'))) });
    if (!r.canceled && r.filePath) { fs.writeFileSync(r.filePath, payload(o)); grant(r.filePath); }
  });
  handle('getLaunchFile', async () => {
    const p = pendingFiles.shift();
    return p ? fileResult(p) : {};
  });
  // Sent by the preload script once the page listens for fileOpened: deliver anything that arrived earlier.
  ipcMain.on('ql:fileListenerReady', (e) => { if (win && e.sender === win.webContents) { rendererReady = true; flushPendingFiles(); } });
  handle('keepAwake', async ({ on }) => {
    if (on && wakeId < 0) wakeId = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && wakeId >= 0) { powerSaveBlocker.stop(wakeId); wakeId = -1; }
  });
  handle('secureSet', async ({ key, value }) => { const o = readSecure(); o[String(key)] = seal(String(value)); writeSecure(o); return { encrypted: secureInfo().encrypted }; });
  handle('secureInfo', async () => secureInfo());
  handle('secureGet', async ({ key }) => { try { return { value: unseal(readSecure()[String(key)]) }; } catch { return { value: null }; } });
  handle('secureRemove', async ({ key }) => { const o = readSecure(); delete o[String(key)]; writeSecure(o); });
  handle('readClipboard', async () => ({ text: clipboard.readText() }));
  handle('writeClipboard', async ({ text }) => { clipboard.writeText(String(text ?? '')); });
  handle('startLoopback', async ({ timeoutMs, successHtml, path: want }) => {
    stopLoop();
    const server = http.createServer((req, res) => {
      // Only this sign-in's nonce path counts: another program probing the port must not end it.
      if (typeof want === 'string' && want && String(req.url || '').split('?')[0] !== want) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(typeof successHtml === 'string' ? successHtml : '<p>You can close this tab.</p>');
      const port = server.address().port;
      if (win) win.webContents.send('ql:oauthCallback', { url: `http://127.0.0.1:${port}${req.url}` });
      if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
      setTimeout(stopLoop, 500);
    });
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    loop = { server, timer: setTimeout(stopLoop, Math.min(Number(timeoutMs) || 300000, 900000)) };
    return { port: server.address().port };
  });
  handle('stopLoopback', async () => stopLoop());
  handle('openExternal', async ({ url }) => { if (safeUrl(url)) await shell.openExternal(url); });
  handle('http', async ({ url, method, headers, data }) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('Only https requests are allowed');
    // A server that never answers must not leave the request (and the page's AI command) waiting forever.
    const res = await net.fetch(url, { method: method || 'GET', headers: headers || {}, body: data == null ? undefined : typeof data === 'string' ? data : JSON.stringify(data), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') || undefined };
  });
}

// ------------------------------------------------------------------------------------------
// Window

// Content Security Policy for the app. Every script is the app's own: nothing is loaded from a CDN and
// nothing is evaluated from text. WebAssembly is for pdf.js, OCR, spelling and the on-device AI model
// (ONNX Runtime, shipped in dist/ort/); http to localhost is for Ollama and LM Studio. Inline scripts
// and plugins are never allowed.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* data: blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join('; ');

function serveApp() {
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('Forbidden', { status: 403 });
    let rel;
    try { rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html'; } catch { return new Response('Bad request', { status: 400 }); }
    const file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST + path.sep) && file !== DIST) return new Response('Forbidden', { status: 403 });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(DIST, 'index.html');
    const res = await net.fetch(pathToFileURL(target).href);
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    // The app never contacts a server by itself, so it cannot notice a newer version: this opens the releases page.
    { role: 'help', submenu: [{ label: `Look for a Newer Version (this is ${app.getVersion()})…`, click: () => void shell.openExternal(RELEASES_URL) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    title: 'Anne\'s Folio',
    backgroundColor: '#ffffff',
    autoHideMenuBar: process.platform !== 'darwin',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false, // Anne's Folio has its own spelling checker
    },
  });
  // Links open in the system browser; the window never navigates away from the app and the page never
  // opens windows of its own.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isAppUrl(url)) { e.preventDefault(); if (safeUrl(url)) void shell.openExternal(url); } });
  // The page asks before unloading with unsaved documents: confirm here, as the browser would.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Unsaved changes', message: 'Some documents have unsaved changes. Close Anne\'s Folio anyway?' });
    if (choice === 0) e.preventDefault();
  });
  // A reload drops the page's listeners until it registers them again. ('did-start-loading' also fires for
  // downloads, which would stop "Open with" from reaching a page that is still listening.)
  win.webContents.on('did-navigate', () => { rendererReady = false; });
  win.webContents.on('render-process-gone', () => { rendererReady = false; });
  win.on('closed', () => { win = null; rendererReady = false; });
  void win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', (_e, argv, cwd) => {
  const p = fileFromArgs(argv, cwd);
  if (p) openExternalFile(p);
  else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
// macOS: files opened from Finder (before or after launch).
app.on('open-file', (e, p) => { e.preventDefault(); if (app.isReady()) openExternalFile(p); else pendingFiles.push(p); });

/**
 * Permissions the page may use; everything else (camera, location, notifications, MIDI, …) is refused.
 * Audio capture is for recorded comments; the clipboard for Copy and Paste; full screen for presentations.
 */
const PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen']);
function permissionPolicy() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    const ours = !!win && wc === win.webContents && isAppUrl(details.requestingUrl || wc.getURL());
    const audioOnly = permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((t) => t === 'audio');
    done(ours && (PERMISSIONS.has(permission) || audioOnly));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => isAppUrl(origin) && (PERMISSIONS.has(permission) || (permission === 'media' && details.mediaType === 'audio')));
}

if (gotLock) app.whenReady().then(() => {
  loadGrants();
  const p = fileFromArgs(process.argv);
  if (p) pendingFiles.unshift(p);
  for (const f of pendingFiles) grant(f);
  serveApp();
  permissionPolicy();
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { stopLoop(); if (process.platform !== 'darwin') app.quit(); });
