/**
 * Downloadable spelling dictionaries.
 *
 * The catalog (dictionary-catalog.json, made by scripts/gen-dictionary-catalog.mjs) lists the free
 * Hunspell dictionaries of the wooorm/dictionaries project, one npm package per language. A
 * dictionary is downloaded only when the user installs it:
 *   1. from cdn.jsdelivr.net (index.aff and index.dic), each file checked against its SHA-256;
 *   2. if that fails, the npm tarball from registry.npmjs.org, checked against npm's SHA-512.
 * Installed dictionaries are kept in IndexedDB and work offline. American, British, Canadian and
 * Australian English are bundled with the app.
 */
import catalogJson from './dictionary-catalog.json';
import { kvGet, kvSet, kvDel, kvKeys, toBase64 } from '../util/store';

export interface DictInfo {
  id: string;
  tag: string;
  name: string;
  native?: string;
  pkg: string;
  version: string;
  license: string;
  aff: { size: number; sha256: string };
  dic: { size: number; sha256: string };
  tarball: string;
  integrity: string;
  bundled?: boolean;
  /** Measured Hunspell (WebAssembly) load time in seconds on a desktop CPU, and memory in MB. */
  loadSec?: number;
  memoryMB?: number;
}

/** The files as downloaded: Hunspell reads each dictionary's own encoding (SET in the .aff). */
interface Stored { version: string; aff: Uint8Array; dic: Uint8Array }

export const CATALOG: DictInfo[] = (catalogJson as { dictionaries: DictInfo[] }).dictionaries;
export const dictById = (id: string): DictInfo | undefined => CATALOG.find((d) => d.id === id);
/** Dictionaries that take long to load or much memory (warned about before installing). */
export const isHeavy = (d: DictInfo): boolean => (d.loadSec ?? 0) > 2 || (d.memoryMB ?? 0) > 60;

const KEY = (id: string) => 'dict:' + id;
let installedP: Promise<Set<string>> | null = null;

/** Ids of the installed (downloaded) dictionaries. */
export function installedDictionaries(): Promise<Set<string>> {
  if (!installedP) installedP = kvKeys('dict:').then((ks) => new Set(ks.map((k) => k.slice(5)))).catch(() => new Set<string>());
  return installedP;
}

export async function loadDictionary(id: string): Promise<Stored | null> {
  return ((await kvGet(KEY(id))) as Stored | undefined) || null;
}

/**
 * True when the installed copy of a dictionary is not the version the catalog lists (installing it again
 * replaces it). False for dictionaries that are not installed or not in the catalog.
 */
export async function dictionaryUpdateAvailable(id: string): Promise<boolean> {
  const d = dictById(id);
  const stored = d ? await loadDictionary(id) : null;
  return !!d && !!stored && stored.version !== d.version;
}

export async function removeDictionary(id: string): Promise<void> {
  await kvDel(KEY(id));
  installedP = null;
}

export type Progress = (p: { phase: 'download' | 'verify' | 'save'; loaded: number; total: number }) => void;

/** Downloads a file, giving up as soon as it is larger than `max` bytes (the catalog knows every size). */
async function fetchBytes(url: string, total: number, onProgress: Progress | undefined, base: number, all: number, signal: AbortSignal | undefined, max: number): Promise<Uint8Array> {
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`${new URL(url).host} answered ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (got > max) { void reader.cancel().catch(() => undefined); throw new Error(`${new URL(url).host} sent more data than this dictionary has`); }
    onProgress?.({ phase: 'download', loaded: base + Math.min(got, total || got), total: all });
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function digest(algo: 'SHA-256' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest(algo, data as Uint8Array<ArrayBuffer>));
  if (algo === 'SHA-256') return sha256(data);
  throw new Error('This device cannot verify the download (no Web Crypto).');
}
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const b64 = toBase64;

/** Plain SHA-256 for platforms without crypto.subtle in this context. */
export function sha256(data: Uint8Array): Uint8Array {
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(padded.length - 4, (len << 3) >>> 0);
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}

/** Read package/<name> from a tar archive. */
export function untar(tar: Uint8Array, want: string): Uint8Array {
  const td = new TextDecoder();
  const str = (a: number, b: number) => td.decode(tar.subarray(a, b)).replace(/\0[\s\S]*$/, '');
  for (let off = 0; off + 512 <= tar.length;) {
    const name = str(off, off + 100);
    if (!name) break;
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8);
    const prefix = str(off + 345, off + 500);
    if ((prefix ? `${prefix}/${name}` : name) === want) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${want} is missing from the package`);
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('This device cannot unpack the package (no DecompressionStream).');
  const stream = new Response(data as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Download, verify and store a dictionary. */
export async function installDictionary(id: string, onProgress?: Progress, signal?: AbortSignal): Promise<void> {
  const d = dictById(id);
  if (!d) throw new Error(`Unknown dictionary "${id}"`);
  const all = d.aff.size + d.dic.size;
  let aff: Uint8Array, dic: Uint8Array;
  try {
    const base = `https://cdn.jsdelivr.net/npm/${d.pkg}@${d.version}/`;
    aff = await fetchBytes(base + 'index.aff', d.aff.size, onProgress, 0, all, signal, d.aff.size);
    dic = await fetchBytes(base + 'index.dic', d.dic.size, onProgress, d.aff.size, all, signal, d.dic.size);
    onProgress?.({ phase: 'verify', loaded: all, total: all });
    if (hex(await digest('SHA-256', aff)) !== d.aff.sha256 || hex(await digest('SHA-256', dic)) !== d.dic.sha256) throw new Error('checksum mismatch');
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    // Second source: the package itself from the npm registry, checked against npm's own hash.
    // The compressed package cannot be larger than the two files it carries plus its small extras.
    const tgz = await fetchBytes(d.tarball, 0, onProgress ? (p) => onProgress({ ...p, total: Math.max(p.total, p.loaded) }) : undefined, 0, all, signal, all + (1 << 20));
    onProgress?.({ phase: 'verify', loaded: all, total: all });
    const [algo, want] = d.integrity.split('-');
    if (algo !== 'sha512' || b64(await digest('SHA-512', tgz)) !== want) throw new Error('The downloaded dictionary failed its integrity check. Nothing was installed.');
    const tar = await gunzip(tgz);
    aff = untar(tar, 'package/index.aff');
    dic = untar(tar, 'package/index.dic');
  }
  onProgress?.({ phase: 'save', loaded: all, total: all });
  try { await kvSet(KEY(id), { version: d.version, aff: aff.slice(), dic: dic.slice() } satisfies Stored); }
  catch { throw new Error('The dictionary could not be stored (storage full or unavailable).'); }
  if (!(await kvGet(KEY(id)))) throw new Error('The dictionary could not be stored (storage full or unavailable).');
  installedP = null;
}

/**
 * The installed dictionary for a BCP 47 language tag, or null. "fr-CA" uses fr, "de-LI" de-ch,
 * "pt-PT" pt-pt (other Portuguese uses the Brazilian pt), "no" nb, "sr-Latn" sr-latn, "grc" the
 * polytonic Greek dictionary, "ca-ES-valencia" ca-valencia.
 */
export function dictionaryFor(tag: string | null | undefined, installed: Set<string>): string | null {
  if (!tag) return null;
  const t = tag.toLowerCase().replace(/_/g, '-');
  const parts = t.split('-');
  let lang = parts[0];
  if (lang === 'no') lang = 'nb';
  const script = parts.find((p, i) => i > 0 && p.length === 4 && /^[a-z]+$/.test(p));
  const region = parts.find((p, i) => i > 0 && (p.length === 2 || /^\d{3}$/.test(p)));
  const cands: string[] = [];
  if (lang === 'grc' || parts.includes('polyton')) cands.push('el-polyton');
  if (lang === 'ca' && parts.includes('valencia')) cands.push('ca-valencia');
  if (script === 'latn') cands.push(`${lang}-latn`);
  if (lang === 'de' && region === 'li') cands.push('de-ch');
  if (region) cands.push(`${lang}-${region}`);
  if (lang === 'pt' && region === 'pt') cands.push('pt-pt');
  cands.push(lang);
  return cands.find((c) => installed.has(c)) || null;
}
