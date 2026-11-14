/**
 * AI settings and API-key storage.
 *
 * Settings (which provider is active, models, options) live in localStorage. API keys never do, so
 * settings, drafts and documents never contain them. Where a key is kept depends on the platform
 * (keyStorage() says which, for the setup wizard to show):
 *  - Android: encrypted with a key held in the Android Keystore (QuillNative secureSet/secureGet).
 *  - Desktop: encrypted by the system keychain; on a Linux desktop without a keyring, a readable file.
 *  - iOS app with the QuillIOS plugin: the iOS Keychain (keys an older build kept in the app database are
 *    moved there on first use). An iOS build without the plugin: the app database, not encrypted.
 *  - Browser: this site's IndexedDB, not encrypted.
 *  - A browser that offers no IndexedDB (some private windows): memory only, until the tab closes.
 */
import { kvGet, kvSet, kvDel } from '../util/store';
import { isNative, isDesktop, isCapacitor, hasSecureStorage, secureGet, secureSet, secureRemove, secureStorageInfo } from '../platform/native';
import { providerById, type ProviderDef } from './providers';
import { defaultEnsemble, normalizeEnsemble, type EnsembleSettings } from './ensemble';

export interface ProviderConfig {
  id: string;
  /** Model for interactive commands. */
  model: string;
  /** Model for quick, cheap tasks (falls back to model). */
  fastModel?: string;
  baseUrl?: string;
  accountId?: string;
  resource?: string;
  region?: string;
  /** Last fetched model list. */
  models?: string[];
  verified?: number;
}

export interface SavedPrompt { id: string; name: string; prompt: string; input: 'selection' | 'document' | 'none'; output: 'replace' | 'insert' | 'pane' | 'comment' | 'newdoc' }

export interface AiSettings {
  enabled: boolean;
  active: string | null;
  providers: Record<string, ProviderConfig>;
  /** Insert AI edits as tracked changes by "AI (model)". */
  trackAsRevisions: boolean;
  /** Ask before sending the whole document to a cloud service. */
  confirmDocument: boolean;
  /** During setup, look for a copied key when returning to the app. */
  clipboardWatch: boolean;
  /** Remove a recognized key from the clipboard after saving it. */
  clearClipboard: boolean;
  /** Number of alternatives offered by Rewrite. */
  alternatives: number;
  /** Reply language for generated text: 'auto' follows the input. */
  language: string;
  styleGuide: string;
  voiceProfile: string;
  prompts: SavedPrompt[];
  usage: { requests: number; tokensIn: number; tokensOut: number; since: number };
  privacyAck: string[];
  /** Several AIs on one request (provider ids and models only; never keys). */
  ensemble: EnsembleSettings;
}

const KEY = 'quillfolio.ai.v1';

export function defaultAiSettings(): AiSettings {
  return {
    enabled: true, active: null, providers: {}, trackAsRevisions: false, confirmDocument: true, clipboardWatch: true, clearClipboard: true,
    alternatives: 3, language: 'auto', styleGuide: '', voiceProfile: '', prompts: [],
    usage: { requests: 0, tokensIn: 0, tokensOut: 0, since: Date.now() }, privacyAck: [], ensemble: defaultEnsemble(),
  };
}

let cache: AiSettings | null = null;
const listeners = new Set<() => void>();
/**
 * Tells this site's other tabs that settings or keys changed. One channel both sends and receives:
 * a channel never hears its own messages, so a save does not make this tab reload what it just wrote.
 * Browser only, and unref'd so tooling that imports this module under Node can exit.
 */
let channel: BroadcastChannel | null = null;
if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    channel = new BroadcastChannel('quillfolio-ai');
    channel.onmessage = () => reloadAiSettings();
    (channel as unknown as { unref?: () => void }).unref?.();
  } catch { /* unsupported */ }
}
const announce = (type: 'settings' | 'keys') => { try { channel?.postMessage({ type }); } catch { /* closed or unsupported */ } };

export function aiSettings(): AiSettings {
  if (cache) return cache;
  let s = defaultAiSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = { ...s, ...JSON.parse(raw) };
  } catch { /* corrupt or unavailable storage: defaults */ }
  if (!s.providers || typeof s.providers !== 'object') s.providers = {};
  if (!Array.isArray(s.prompts)) s.prompts = [];
  s.prompts = s.prompts.filter((p) => p && typeof p.name === 'string' && typeof p.prompt === 'string');
  s.ensemble = normalizeEnsemble(s.ensemble);
  cache = s;
  return s;
}

export function saveAiSettings(mut?: (s: AiSettings) => void): void {
  const s = aiSettings();
  mut?.(s);
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* quota: the change still applies in this tab */ }
  announce('settings');
  listeners.forEach((f) => f());
}

export function onAiSettingsChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Reload after another window (the OAuth callback tab) changed settings or keys. */
export function reloadAiSettings(): void {
  cache = null;
  // Keys are read from storage again (another tab may have replaced or removed one); a key that
  // exists only in this tab's memory has nowhere to be read from and stays.
  for (const id of [...keyCache.keys()]) if (!memoryOnly.has(id)) keyCache.delete(id);
  listeners.forEach((f) => f());
}

// ------------------------------------------------------------------------------------------
// Keys

const keyCache = new Map<string, string>();
/** Providers whose key could not be stored and is held in memory for this tab only. */
const memoryOnly = new Set<string>();

/**
 * util/store falls back to localStorage when the browser has no IndexedDB. A key must never rest
 * there (localStorage is where settings live): any copy is removed. True when there was one.
 */
function purgeLocalStorageKey(providerId: string): boolean {
  try {
    const k = 'qlkv:aikey:' + providerId;
    if (localStorage.getItem(k) == null) return false;
    localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

export interface KeyStorage {
  kind: 'android-keystore' | 'desktop-keychain' | 'desktop-file' | 'browser' | 'ios-keychain' | 'ios-app' | 'memory';
  /** The key is still there after the app or tab is closed. */
  persistent: boolean;
  /** The key is encrypted with a secret held by the operating system. */
  encrypted: boolean;
  /** One plain sentence for the user. */
  note: string;
}

let browserDb: Promise<boolean> | null = null;
/** Whether this browser keeps the key-value store in IndexedDB (false: util/store is on its localStorage fallback, or nothing). */
function hasBrowserDb(): Promise<boolean> {
  if (!browserDb) browserDb = (async () => {
    try {
      await kvSet('probe:aikey', 1);
      let fallback = false;
      try { fallback = localStorage.getItem('qlkv:probe:aikey') != null; } catch { /* no localStorage either */ }
      await kvDel('probe:aikey');
      return !fallback;
    } catch { return false; }
  })();
  return browserDb;
}

/** Where API keys are kept on this platform and how well they are protected there. */
export async function keyStorage(): Promise<KeyStorage> {
  if (isCapacitor() && !isNative() && hasSecureStorage()) return { kind: 'ios-keychain', persistent: true, encrypted: true, note: 'Keys are kept in the iOS Keychain for this app, on this device only.' };
  if (isNative() && !isDesktop()) return { kind: 'android-keystore', persistent: true, encrypted: true, note: 'Keys are encrypted with a key held in the Android Keystore and stay on this device.' };
  if (isDesktop()) {
    const info = await secureStorageInfo();
    return info.encrypted
      ? { kind: 'desktop-keychain', persistent: true, encrypted: true, note: 'Keys are encrypted by this computer\'s keychain (macOS Keychain, Windows data protection or the Linux keyring).' }
      : { kind: 'desktop-file', persistent: true, encrypted: false, note: 'This computer has no keyring Anne\'s Folio can use, so keys are saved in a file in your profile that any program running under your account can read. Install GNOME Keyring or KWallet to have them encrypted.' };
  }
  if (!(await hasBrowserDb())) return { kind: 'memory', persistent: false, encrypted: false, note: 'This browser window does not let the site keep a database (a private window, for example), so keys are kept only until this tab is closed.' };
  if (isCapacitor()) return { kind: 'ios-app', persistent: true, encrypted: false, note: 'Keys are saved in the app\'s own storage on this device, not encrypted (the iOS Keychain is not used).' };
  return { kind: 'browser', persistent: true, encrypted: false, note: 'Keys are saved in this browser\'s storage for this site, not encrypted: other pages at the same address and anyone using this browser profile can read them.' };
}

export async function getApiKey(providerId: string): Promise<string> {
  if (keyCache.has(providerId)) return keyCache.get(providerId)!;
  let k = '';
  try {
    k = hasSecureStorage() ? (await secureGet('ai.key.' + providerId)) || '' : ((await kvGet('aikey:' + providerId)) as string) || '';
    // iOS builds before the Keychain plugin kept keys in the app database: move such a key into the Keychain once.
    if (!k && hasSecureStorage() && isCapacitor() && !isNative()) {
      const old = ((await kvGet('aikey:' + providerId).catch(() => undefined)) as string) || '';
      if (old) { await secureSet('ai.key.' + providerId, old); await kvDel('aikey:' + providerId).catch(() => undefined); k = old; }
    }
  } catch {
    return ''; // storage failed just now: ask it again next time instead of remembering "no key"
  }
  // A copy an earlier version left in localStorage is used for this session and removed from there.
  if (!hasSecureStorage() && purgeLocalStorageKey(providerId) && k && !(await hasBrowserDb())) memoryOnly.add(providerId);
  keyCache.set(providerId, k);
  return k;
}

/** Saves a key and says where it went (see KeyStorage: it may be memory only, or not encrypted). */
export async function setApiKey(providerId: string, key: string): Promise<KeyStorage> {
  keyCache.set(providerId, key);
  memoryOnly.delete(providerId);
  if (hasSecureStorage()) await secureSet('ai.key.' + providerId, key);
  else {
    let stored = await hasBrowserDb();
    if (stored) { try { await kvSet('aikey:' + providerId, key); } catch { stored = false; } }
    purgeLocalStorageKey(providerId);
    if (!stored) memoryOnly.add(providerId);
  }
  announce('keys');
  const where = await keyStorage();
  return memoryOnly.has(providerId) && where.kind !== 'memory' ? { kind: 'memory', persistent: false, encrypted: false, note: 'The key could not be saved (storage is full or blocked), so it is kept only until this tab is closed.' } : where;
}

export async function deleteApiKey(providerId: string): Promise<void> {
  keyCache.delete(providerId);
  memoryOnly.delete(providerId);
  if (hasSecureStorage()) {
    await secureRemove('ai.key.' + providerId);
    // An iOS key from before the Keychain plugin may still sit in the app database.
    if (isCapacitor() && !isNative()) await kvDel('aikey:' + providerId).catch(() => undefined);
  } else {
    purgeLocalStorageKey(providerId);
    await kvDel('aikey:' + providerId);
  }
  announce('keys');
}

export function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 12 ? '•'.repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// ------------------------------------------------------------------------------------------
// Resolved configuration

export interface ResolvedProvider { def: ProviderDef; cfg: ProviderConfig; key: string; baseUrl: string }

export function resolveBaseUrl(def: ProviderDef, cfg: Partial<ProviderConfig>): string {
  let url = (cfg.baseUrl || def.baseUrl || '').trim();
  url = url.replace('{accountId}', encodeURIComponent(cfg.accountId || '')).replace('{resource}', encodeURIComponent(cfg.resource || '')).replace('{region}', encodeURIComponent(cfg.region || 'us-east-1'));
  return url.replace(/\/+$/, '');
}

export async function resolveProvider(id?: string | null): Promise<ResolvedProvider | null> {
  const s = aiSettings();
  const pid = id || s.active;
  if (!pid) return null;
  const def = providerById(pid);
  const cfg = s.providers[pid];
  if (!def || !cfg) return null;
  const key = def.needsKey || pid === 'custom' || pid === 'ollama' || pid === 'lmstudio' ? await getApiKey(pid) : '';
  return { def, cfg, key, baseUrl: resolveBaseUrl(def, cfg) };
}

export function recordUsage(tokensIn: number, tokensOut: number): void {
  saveAiSettings((s) => { s.usage.requests++; s.usage.tokensIn += tokensIn || 0; s.usage.tokensOut += tokensOut || 0; });
}
