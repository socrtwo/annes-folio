/**
 * Platform bridge. One API, three back ends:
 * - Android: the `QuillNative` Capacitor plugin (android/app/src/main/java/.../QuillNativePlugin.java)
 *   provides the Storage Access Framework (real Open / Save As dialogs, write-back to the same file),
 *   the system print service (which also offers "Save as PDF"), sharing, and files opened from other apps.
 * - Desktop (Windows, macOS, Linux, Raspberry Pi OS): the Electron preload (electron/preload.cjs)
 *   exposes the same interface as `window.quillDesktop`, backed by native file dialogs and the file system.
 * - Browser and iOS: <input type=file>, the File System Access API or downloads, and window.print().
 *   On iOS, saved files go to the app's own Documents folder. iOS shows that folder in Finder's file
 *   sharing, not in the Files app, so Share is the way to put a copy in Files or another app.
 *
 * File contents cross the Android bridge as base64 strings (`data`); the desktop bridge passes bytes
 * (`bytes`), which needs a third of the memory and has no string-length limit.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { download, pickFile } from '../ui/dom';

export interface OpenedFile { name: string; data: ArrayBuffer; uri: string | null; mime?: string }

/** File contents on the bridge: base64 (`data`, Android) or bytes (`bytes`, desktop). */
interface Payload { data?: string; bytes?: Uint8Array }
interface FileResult extends Payload { uri?: string; name?: string; mime?: string }

interface QuillNativePlugin {
  /** ACTION_OPEN_DOCUMENT. Resolves {canceled:true} when dismissed. */
  openDocument(opts: { mimeTypes: string[] }): Promise<FileResult & { canceled?: boolean }>;
  /** ACTION_CREATE_DOCUMENT then write. */
  saveAs(opts: { name: string; mime: string } & Payload): Promise<{ canceled?: boolean; uri?: string; name?: string }>;
  /** Overwrite an existing document URI obtained from openDocument/saveAs (persisted permission). */
  writeUri(opts: { uri: string } & Payload): Promise<{ ok: boolean }>;
  /** Read a URI again (recent files). */
  readUri(opts: { uri: string }): Promise<FileResult>;
  /** Print the current WebView through PrintManager. */
  print(opts: { jobName: string }): Promise<void>;
  /** Share a file through ACTION_SEND. */
  share(opts: { name: string; mime: string; title?: string } & Payload): Promise<void>;
  /** File the app was launched with (ACTION_VIEW / ACTION_EDIT / ACTION_SEND), consumed once. */
  getLaunchFile(): Promise<FileResult>;
  /** Keep the screen awake (read-aloud, teleprompter). */
  keepAwake(opts: { on: boolean }): Promise<void>;
  addListener(event: 'fileOpened', cb: (f: FileResult) => void): Promise<{ remove: () => void }>;
  addListener(event: 'oauthCallback', cb: (r: { url: string }) => void): Promise<{ remove: () => void }>;
  /** Android Keystore-backed encrypted preferences (API keys). The desktop answers how well the value is protected. */
  secureSet(opts: { key: string; value: string }): Promise<void | { encrypted?: boolean }>;
  secureGet(opts: { key: string }): Promise<{ value?: string | null }>;
  secureRemove(opts: { key: string }): Promise<void>;
  /** ClipboardManager text (foreground app only; Android 12+ shows a "pasted" notice). */
  readClipboard(): Promise<{ text?: string | null }>;
  writeClipboard(opts: { text: string; sensitive?: boolean }): Promise<void>;
  /** One-shot http://127.0.0.1:<port>/ listener for OAuth redirects (OpenRouter PKCE); only requests for `path` count. */
  startLoopback(opts: { timeoutMs: number; successHtml?: string; path?: string }): Promise<{ port: number }>;
  stopLoopback(): Promise<void>;
}

/** The desktop bridge adds what Android gets from Capacitor itself. */
interface DesktopBridge extends QuillNativePlugin {
  /** 'win32' | 'darwin' | 'linux' */
  platform: string;
  openExternal(opts: { url: string }): Promise<void>;
  /** HTTP from the main process (no CORS), for AI providers that block browsers. */
  http(opts: { url: string; method: string; headers: Record<string, string>; data?: unknown }): Promise<{ status: number; text: string; retryAfter?: string }>;
  /** Whether saved keys are encrypted by the system keychain (false: no keyring, the key file is readable). */
  secureInfo?(): Promise<{ encrypted: boolean; available: boolean; backend: string }>;
}

const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? (window as any).quillDesktop : undefined;
const Native: QuillNativePlugin = desktop || registerPlugin<QuillNativePlugin>('QuillNative');

/** Running in the Capacitor app shell (Android or iOS). */
export const isCapacitor = (): boolean => Capacitor.isNativePlatform();
/** A native bridge is present: real file dialogs, write-back, secure storage, OAuth loopback (Android app or desktop app). */
export const isNative = (): boolean => !!desktop || (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('QuillNative'));
export const isDesktop = (): boolean => !!desktop;
export const isIOS = (): boolean => Capacitor.getPlatform() === 'ios';
/** 'android' | 'ios' | 'web' | 'windows' | 'macos' | 'linux' */
export const platformName = (): string => (desktop ? ({ win32: 'windows', darwin: 'macos' } as Record<string, string>)[desktop.platform] || 'linux' : Capacitor.getPlatform());
/** Desktop HTTP without CORS, or null when not on desktop. */
export const desktopHttp = desktop ? (o: { url: string; method: string; headers: Record<string, string>; data?: unknown }) => desktop.http(o) : null;

// iOS: files live in the app's Documents folder, which the Files app shows.
const IOS_PREFIX = 'ios-doc:';
async function iosWrite(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'document';
  await Filesystem.writeFile({ path: safe, data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Documents });
  return safe;
}
/** Save As on iOS has no picker: never replace another document's file, use "Name (2).ext" instead. */
async function iosFreeName(name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_') || 'document';
  const dot = safe.lastIndexOf('.');
  const base = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
  for (let i = 1; i < 500; i++) {
    const candidate = i === 1 ? safe : `${base} (${i})${ext}`;
    try { await Filesystem.stat({ path: candidate, directory: Directory.Documents }); } catch { return candidate; }
  }
  return `${base} (${Date.now()})${ext}`;
}

export function b64FromBuffer(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}

export function bufferFromB64(b64: string): ArrayBuffer {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

/** The contents of a file the bridge handed over, or null when it carries none. */
function received(r: Payload | null | undefined): ArrayBuffer | null {
  if (r?.bytes) { const b = r.bytes; return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); }
  return r?.data ? bufferFromB64(r.data) : null;
}
/** A blob in the form this platform's bridge takes. */
async function outgoing(blob: Blob): Promise<Payload> {
  const buf = await blob.arrayBuffer();
  return desktop ? { bytes: new Uint8Array(buf) } : { data: b64FromBuffer(buf) };
}
const opened = (r: FileResult, data: ArrayBuffer, uri: string | null = r.uri || null): OpenedFile => ({ name: r.name || 'document', data, uri, mime: r.mime });

export async function openDocument(accept: string, mimeTypes: string[]): Promise<OpenedFile | null> {
  if (isNative()) {
    const r = await Native.openDocument({ mimeTypes });
    const data = r.canceled ? null : received(r);
    return data ? opened(r, data) : null;
  }
  // Chromium browsers: a file handle, so that Save can write back to the file that was opened.
  const anyWin = window as any;
  if (anyWin.showOpenFilePicker && !isCapacitor()) {
    try {
      const exts = accept.split(',').map((x) => x.trim()).filter((x) => /^\.\w{1,16}$/.test(x));
      const [handle] = await anyWin.showOpenFilePicker(exts.length ? { types: [{ description: 'Supported files', accept: { 'application/octet-stream': exts } }] } : {});
      const f: File = await handle.getFile();
      return { name: f.name, data: await f.arrayBuffer(), uri: 'fsa:' + (await handleId(handle)), mime: f.type };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      // Not allowed here (an embedded frame, a browser policy): the classic file input below.
    }
  }
  const files = await pickFile(accept);
  if (!files.length) return null;
  return { name: files[0].name, data: await files[0].arrayBuffer(), uri: null, mime: files[0].type };
}

function toastSaved(name: string): void {
  import('../ui/dialog').then(({ toast }) => toast(`Saved "${name}" in Anne's Folio on this device. To put a copy in Files or another app, use Share.`)).catch(() => undefined);
}

export async function saveAs(blob: Blob, name: string): Promise<{ uri: string | null; name: string } | null> {
  if (isNative()) {
    const r = await Native.saveAs({ name, mime: blob.type || 'application/octet-stream', ...(await outgoing(blob)) });
    if (r.canceled) return null;
    return { uri: r.uri || null, name: r.name || name };
  }
  if (isIOS()) {
    const n = await iosWrite(blob, await iosFreeName(name));
    toastSaved(n);
    return { uri: IOS_PREFIX + n, name: n };
  }
  const anyWin = window as any;
  if (anyWin.showSaveFilePicker) {
    try {
      const handle = await anyWin.showSaveFilePicker({ suggestedName: name });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return { uri: 'fsa:' + (await handleId(handle)), name: handle.name };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
    }
  }
  download(blob, name);
  return { uri: null, name };
}

/** File System Access handles by id. Names alone are not unique: two folders can hold "Report.docx". */
const handles = new Map<string, any>();
let handleSeq = 0;
async function handleId(handle: any): Promise<string> {
  // The same file saved again keeps its id (and so its recent-files and version-history entries).
  for (const [id, h] of handles) {
    try { if (await h.isSameEntry?.(handle)) { handles.set(id, handle); return id; } } catch { /* stale handle */ }
  }
  // Unique per save, so two files with the same name in different folders never share a handle.
  const id = `${Date.now().toString(36)}${(++handleSeq).toString(36)}:${handle.name}`;
  handles.set(id, handle);
  return id;
}

export async function writeBack(uri: string, blob: Blob): Promise<boolean> {
  if (uri.startsWith('fsa:')) {
    const h = handles.get(uri.slice(4));
    if (!h) return false;
    // A file that was opened (not saved) here is readable only until the browser's "Save changes?" prompt is answered.
    if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  }
  if (uri.startsWith(IOS_PREFIX)) { await iosWrite(blob, uri.slice(IOS_PREFIX.length)); return true; }
  if (!isNative()) return false;
  const r = await Native.writeUri({ uri, ...(await outgoing(blob)) });
  return !!r.ok;
}

export async function readUri(uri: string): Promise<OpenedFile | null> {
  if (uri.startsWith(IOS_PREFIX)) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const r = await Filesystem.readFile({ path: uri.slice(IOS_PREFIX.length), directory: Directory.Documents });
      return { name: uri.slice(IOS_PREFIX.length), data: bufferFromB64(typeof r.data === 'string' ? r.data : b64FromBuffer(await (r.data as Blob).arrayBuffer())), uri };
    } catch { return null; }
  }
  if (!isNative()) return null;
  try {
    const r = await Native.readUri({ uri });
    const data = received(r);
    return data ? opened(r, data, uri) : null;
  } catch {
    return null;
  }
}

export async function printDocument(jobName: string): Promise<void> {
  if (isNative()) { await Native.print({ jobName }); return; }
  window.print();
}

export async function shareFile(blob: Blob, name: string, title?: string): Promise<void> {
  if (isNative()) {
    await Native.share({ name, mime: blob.type || 'application/octet-stream', title, ...(await outgoing(blob)) });
    return;
  }
  if (isIOS()) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const w = await Filesystem.writeFile({ path: name.replace(/[\\/:*?"<>|]/g, '_') || 'document', data: b64FromBuffer(await blob.arrayBuffer()), directory: Directory.Cache });
    await Share.share({ title: title || name, files: [w.uri] });
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as any;
  if (nav.canShare && nav.canShare({ files: [file] })) { await nav.share({ files: [file], title: title || name }); return; }
  download(blob, name);
}

/**
 * iOS has no QuillNative plugin: "Open in Anne's Folio" and Share arrive as file:// URLs through the
 * Capacitor App plugin. With LSSupportsOpeningDocumentsInPlace off, iOS copies the file into the app's
 * Documents/Inbox first, so it can be read without a security-scoped bookmark. There is no write-back
 * URI: Save on iOS goes through Save As / Share.
 */
let lastIosUrl = '';
async function readIosUrl(url: string): Promise<OpenedFile | null> {
  if (!/^file:/i.test(url) || url === lastIosUrl) return null;
  lastIosUrl = url;
  try {
    const { Filesystem } = await import('@capacitor/filesystem');
    const r = await Filesystem.readFile({ path: url });
    const data = typeof r.data === 'string' ? bufferFromB64(r.data) : await (r.data as Blob).arrayBuffer();
    let name = url.split(/[?#]/)[0].split('/').pop() || 'document';
    try { name = decodeURIComponent(name); } catch { /* keep the raw name */ }
    // iOS put this copy in the app's Inbox for us; once read it is only taking up space.
    if (/\/Documents\/Inbox\//.test(url)) void Filesystem.deleteFile({ path: url }).catch(() => undefined);
    return { name, data, uri: null };
  } catch {
    return null;
  }
}

export async function launchFile(): Promise<OpenedFile | null> {
  if (isCapacitor() && isIOS() && !isNative()) {
    try {
      const { App } = await import('@capacitor/app');
      const r = await App.getLaunchUrl();
      return r?.url ? await readIosUrl(r.url) : null;
    } catch {
      return null;
    }
  }
  if (!isNative()) return null;
  try {
    const r = await Native.getLaunchFile();
    const data = received(r);
    return data ? opened(r, data) : null;
  } catch {
    return null;
  }
}

export function onFileOpened(cb: (f: OpenedFile) => void): void {
  if (isCapacitor() && isIOS() && !isNative()) {
    void import('@capacitor/app').then(({ App }) => App.addListener('appUrlOpen', (e) => { void readIosUrl(e.url).then((f) => { if (f) cb(f); }); }));
    return;
  }
  if (!isNative()) return;
  void Native.addListener('fileOpened', (r) => { const data = received(r); if (data) cb(opened(r, data)); });
}

export async function keepAwake(on: boolean): Promise<void> {
  if (!isNative()) {
    try { if (on) (window as any).__wake = await (navigator as any).wakeLock?.request('screen'); else (window as any).__wake?.release(); } catch { /* */ }
    return;
  }
  try { await Native.keepAwake({ on }); } catch { /* */ }
}

/** Open a URL outside the app (system browser, mail or phone app). */
export function openExternal(url: string): void {
  // Only hand ordinary web/mail/phone addresses to the system; never navigate this WebView to script.
  if (!/^(https?|mailto|tel|ftp|sms|geo):/i.test(url.trim())) return;
  if (desktop) { void desktop.openExternal({ url }); return; }
  if (isCapacitor()) { window.location.href = url; return; }
  window.open(url, '_blank', 'noopener');
}

export async function onBackButton(cb: () => boolean): Promise<void> {
  if (!isCapacitor() || isIOS()) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => { if (!cb()) App.minimizeApp(); });
}

export const OPEN_ACCEPT = '.pdf,.fdf,.xfdf,.qfr,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.svg,.txt,.md,.markdown,.html,.htm,.json,.zip';
export const OPEN_MIMES = [
  'application/pdf', 'application/x-pdf', 'application/vnd.fdf', 'application/vnd.adobe.xfdf', 'application/x-quillfolio-review',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/svg+xml',
  'text/markdown', 'text/plain', 'text/html', 'application/json', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream', '*/*',
];

// ------------------------------------------------------------------------------------------
// Secure storage, clipboard, OAuth loopback, app resume (AI setup)

export async function secureSet(key: string, value: string): Promise<void> {
  await Native.secureSet({ key, value });
}
/**
 * How the native bridge protects saved secrets: the Android Keystore, or on the desktop the system
 * keychain (macOS Keychain, Windows DPAPI, a Linux keyring). `encrypted: false` means a Linux desktop
 * without a keyring, where the key file can be read by anything running as the user.
 */
export async function secureStorageInfo(): Promise<{ encrypted: boolean; backend: string }> {
  if (!desktop) return { encrypted: true, backend: 'android-keystore' };
  try { const r = await desktop.secureInfo?.(); if (r) return { encrypted: !!r.encrypted, backend: String(r.backend || 'unknown') }; } catch { /* an older desktop shell */ }
  return { encrypted: false, backend: 'unknown' };
}
export async function secureGet(key: string): Promise<string | null> {
  return (await Native.secureGet({ key })).value ?? null;
}
export async function secureRemove(key: string): Promise<void> {
  await Native.secureRemove({ key });
}

/** Read clipboard text. Returns null when the platform refuses (no permission, no focus). */
export async function readClipboardText(): Promise<string | null> {
  try {
    if (isNative()) return (await Native.readClipboard()).text ?? null;
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch { /* denied */ }
  return null;
}

export async function writeClipboardText(text: string, sensitive = false): Promise<boolean> {
  try {
    if (isNative()) { await Native.writeClipboard({ text, sensitive }); return true; }
    await navigator.clipboard.writeText(text);
    return true;
  } catch { return false; }
}

export async function startOAuthLoopback(timeoutMs: number, successHtml?: string, path?: string): Promise<number> {
  return (await Native.startLoopback({ timeoutMs, successHtml, path })).port;
}
export async function stopOAuthLoopback(): Promise<void> {
  try { await Native.stopLoopback(); } catch { /* not running */ }
}
export function onOAuthCallback(cb: (url: string) => void): Promise<{ remove: () => void }> {
  return Native.addListener('oauthCallback', (r) => cb(r.url));
}

/** Called when the app returns to the foreground (Android resume, browser tab visible again). */
export function onAppResume(cb: () => void): () => void {
  const vis = () => { if (document.visibilityState === 'visible') cb(); };
  document.addEventListener('visibilitychange', vis);
  let remove: (() => void) | null = null;
  if (isCapacitor()) {
    import('@capacitor/app').then(({ App }) => App.addListener('resume', cb)).then((h) => { remove = () => h.remove(); }).catch(() => undefined);
  }
  return () => { document.removeEventListener('visibilitychange', vis); remove?.(); };
}
