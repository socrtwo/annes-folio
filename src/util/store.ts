/** Minimal IndexedDB key-value store with a localStorage fallback. Writes reject when they do not reach storage. */
const DB = 'quillfolio';
const OS = 'kv';
let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OS);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

// The localStorage fallback stores JSON, which has no binary type: ArrayBuffers and typed arrays are wrapped as base64.
const BIN = '$qfbin';
const tagOf = (v: unknown): string => Object.prototype.toString.call(v);

/** Base64 of bytes, built in slices: spreading a large array into String.fromCharCode overflows the call stack. */
export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}
export function fromBase64(s: string): Uint8Array {
  const t = atob(s);
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = t.charCodeAt(i);
  return out;
}

/** JSON text of a value in which binary parts survive (used by the localStorage fallback). */
export function encodeStored(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object') {
      if (tagOf(v) === '[object ArrayBuffer]') return { [BIN]: 'buffer', data: toBase64(new Uint8Array(v as ArrayBuffer)) };
      if (ArrayBuffer.isView(v)) return { [BIN]: 'bytes', data: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    }
    return v;
  });
}
export function decodeStored<T = any>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.data === 'string' && (v[BIN] === 'buffer' || v[BIN] === 'bytes')) {
      const b = fromBase64(v.data);
      return v[BIN] === 'buffer' ? b.buffer : b;
    }
    return v;
  });
}

/** An Error that says what failed and, when the platform gave one, why ("The quota has been exceeded."). */
const failure = (e: unknown, what: string): Error => { const m = (e as { message?: unknown } | null)?.message; return new Error(typeof m === 'string' && m ? `${what} ${m}` : what); };

export async function kvGet<T = any>(key: string): Promise<T | undefined> {
  const db = await open();
  if (!db) {
    try { const v = localStorage.getItem('qlkv:' + key); return v ? decodeStored<T>(v) : undefined; } catch { return undefined; }
  }
  return new Promise((resolve) => {
    try {
      const r = db.transaction(OS).objectStore(OS).get(key);
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

/** Stores a value. Rejects when it was not stored (storage full, transaction aborted, storage unavailable). */
export async function kvSet(key: string, value: any): Promise<void> {
  const db = await open();
  if (!db) {
    try { localStorage.setItem('qlkv:' + key, encodeStored(value)); } catch (e) { throw failure(e, 'The value could not be stored (storage is full or unavailable).'); }
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OS, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failure(tx.error, 'The value could not be stored.'));
    tx.onabort = () => reject(failure(tx.error, 'The value could not be stored (storage may be full).'));
    tx.objectStore(OS).put(value, key);
  });
}

/** Deletes a key. Rejects when the deletion did not reach storage. */
export async function kvDel(key: string): Promise<void> {
  const db = await open();
  if (!db) {
    try { localStorage.removeItem('qlkv:' + key); } catch (e) { throw failure(e, 'The value could not be removed.'); }
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OS, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failure(tx.error, 'The value could not be removed.'));
    tx.onabort = () => reject(failure(tx.error, 'The value could not be removed.'));
    tx.objectStore(OS).delete(key);
  });
}

export async function kvKeys(prefix = ''): Promise<string[]> {
  const db = await open();
  if (!db) {
    try { return Object.keys(localStorage).filter((k) => k.startsWith('qlkv:' + prefix)).map((k) => k.slice(5)); } catch { return []; }
  }
  return new Promise((resolve) => {
    try {
      const r = db.transaction(OS).objectStore(OS).getAllKeys();
      r.onsuccess = () => resolve((r.result as string[]).filter((k) => String(k).startsWith(prefix)));
      r.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}
