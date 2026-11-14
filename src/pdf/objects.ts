/**
 * PDF object model (ISO 32000-1 §7.3): the eight basic types plus indirect references and streams.
 * Everything Anne's Folio reads, repairs, edits and writes is built from these classes.
 */

/** A name object. Interned, so names compare with ===. */
export class Name {
  private static cache = new Map<string, Name>();
  private constructor(public readonly name: string) {}
  static get(name: string): Name {
    let n = Name.cache.get(name);
    if (!n) { n = new Name(name); Name.cache.set(name, n); }
    return n;
  }
  toString(): string { return '/' + this.name; }
}
export const N = (s: string): Name => Name.get(s);

/** An indirect object reference `num gen R`. */
export class Ref {
  constructor(public readonly num: number, public readonly gen = 0) {}
  get key(): string { return `${this.num}R${this.gen}`; }
  toString(): string { return `${this.num} ${this.gen} R`; }
  equals(o: unknown): boolean { return o instanceof Ref && o.num === this.num && o.gen === this.gen; }
}

/** A string object: raw bytes, remembered as literal or hex for round trips. */
export class PdfString {
  constructor(public bytes: Uint8Array, public hex = false) {}
  static fromText(s: string, forceUtf16 = false): PdfString {
    // Bytes that mean the same character in PDFDocEncoding and Latin-1 are written as they are (0x7F–0xA0
    // and 0xAD differ or are undefined there); anything else becomes UTF-16BE with a byte-order mark.
    const plain = (c: number) => (c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff && c !== 0xad) || c === 10 || c === 13 || c === 9;
    const looksLikeBom = s.startsWith('\u00fe\u00ff') || s.startsWith('\u00ff\u00fe') || s.startsWith('\u00ef\u00bb\u00bf');
    if (!forceUtf16 && !looksLikeBom && [...s].every((c) => plain(c.codePointAt(0)!))) {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return new PdfString(b);
    }
    const out: number[] = [0xfe, 0xff];
    for (const ch of s) {
      let c = ch.codePointAt(0)!;
      if (c > 0xffff) { c -= 0x10000; out.push(0xd8 | (c >> 18), (c >> 10) & 0xff, 0xdc | ((c >> 8) & 3), c & 0xff); } else out.push(c >> 8, c & 0xff);
    }
    return new PdfString(new Uint8Array(out));
  }
  static fromBytes(b: Uint8Array, hex = false): PdfString { return new PdfString(b, hex); }
  /** The text of a text string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding). */
  toText(): string {
    const b = this.bytes;
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
      return s;
    }
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) { // UTF-16LE: not allowed, but some writers emit it
      let s = '';
      for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i + 1] << 8) | b[i]);
      return s;
    }
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { try { return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(3)); } catch { /* fall through */ } }
    let s = '';
    for (let i = 0; i < b.length; i++) s += PDFDOC[b[i]] ?? String.fromCharCode(b[i]);
    return s;
  }
  /** Bytes as a Latin-1 string (for keys, dates, binary comparison). */
  toLatin1(): string { return latin1(this.bytes); }
  toString(): string { return this.toText(); }
}

// PDFDocEncoding differences from Latin-1 (§D.2).
const PDFDOC: Record<number, string> = {
  0x18: '˘', 0x19: 'ˇ', 0x1a: 'ˆ', 0x1b: '˙', 0x1c: '˝', 0x1d: '˛', 0x1e: '˚', 0x1f: '˜',
  0x80: '•', 0x81: '†', 0x82: '‡', 0x83: '…', 0x84: '—', 0x85: '–', 0x86: 'ƒ', 0x87: '⁄', 0x88: '‹', 0x89: '›',
  0x8a: '−', 0x8b: '‰', 0x8c: '„', 0x8d: '“', 0x8e: '”', 0x8f: '‘', 0x90: '’', 0x91: '‚', 0x92: '™', 0x93: 'ﬁ',
  0x94: 'ﬂ', 0x95: 'Ł', 0x96: 'Œ', 0x97: 'Š', 0x98: 'Ÿ', 0x99: 'Ž', 0x9a: 'ı', 0x9b: 'ł', 0x9c: 'œ', 0x9d: 'š', 0x9e: 'ž', 0xa0: '€',
};

export type PdfObj = null | boolean | number | PdfString | Name | PdfObj[] | Dict | PdfStream | Ref;

/** A dictionary. Keys are stored without the leading slash. */
export class Dict {
  map = new Map<string, PdfObj>();
  constructor(entries?: Record<string, PdfObj> | Map<string, PdfObj>) {
    if (entries instanceof Map) this.map = new Map(entries);
    else if (entries) for (const [k, v] of Object.entries(entries)) if (v !== undefined) this.map.set(k, v);
  }
  get(key: string): PdfObj | undefined { return this.map.get(key); }
  has(key: string): boolean { return this.map.has(key); }
  set(key: string, value: PdfObj | undefined): this { if (value === undefined) this.map.delete(key); else this.map.set(key, value); return this; }
  delete(key: string): boolean { return this.map.delete(key); }
  keys(): string[] { return [...this.map.keys()]; }
  get size(): number { return this.map.size; }
  clone(): Dict { return new Dict(this.map); }
  /** /Type as a string, or ''. */
  get type(): string { const t = this.map.get('Type'); return t instanceof Name ? t.name : ''; }
}

/** A stream: its dictionary and the raw (still encoded, possibly encrypted) bytes. */
export class PdfStream {
  /** Decoded bytes, filled in by the document's decoder (filters.ts) on request. */
  decoded: Uint8Array | null = null;
  constructor(public dict: Dict, public raw: Uint8Array) {}
  get length(): number { return this.raw.length; }
}

export const isName = (o: unknown, name?: string): o is Name => o instanceof Name && (name === undefined || o.name === name);
/** Array predicate form (filter/every) without the optional name argument. */
export const nameObj = (o: unknown): o is Name => o instanceof Name;
export const isDict = (o: unknown): o is Dict => o instanceof Dict;
export const isStream = (o: unknown): o is PdfStream => o instanceof PdfStream;
export const isRef = (o: unknown): o is Ref => o instanceof Ref;
export const isNum = (o: unknown): o is number => typeof o === 'number';
export const isArray = (o: unknown): o is PdfObj[] => Array.isArray(o);
export const isString = (o: unknown): o is PdfString => o instanceof PdfString;

/** The dictionary of a dict or stream object. */
export function dictOf(o: PdfObj | undefined): Dict | null {
  if (o instanceof Dict) return o;
  if (o instanceof PdfStream) return o.dict;
  return null;
}

/**
 * Deep copy of an object graph. Refs are shared (what copies within one document want), and so are a
 * stream's bytes: `raw` and `decoded` are replaced, never written into, so copies can share them.
 */
export function cloneObj(o: PdfObj): PdfObj {
  if (Array.isArray(o)) return o.map(cloneObj);
  if (o instanceof Dict) { const d = new Dict(); for (const [k, v] of o.map) d.map.set(k, cloneObj(v)); return d; }
  if (o instanceof PdfStream) { const s = new PdfStream(cloneObj(o.dict) as Dict, o.raw); s.decoded = o.decoded; return s; }
  if (o instanceof PdfString) return new PdfString(o.bytes.slice(), o.hex);
  return o;
}

/** A PDF date string (D:YYYYMMDDHHmmSS+hh'mm'). */
export function pdfDate(d = new Date()): PdfString {
  const p = (n: number) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  return PdfString.fromText(`D:${String(d.getFullYear()).padStart(4, '0')}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(tz) / 60))}'${p(Math.abs(tz) % 60)}'`);
}

/** Parses a PDF date string; null when it is not one. */
export function parsePdfDate(s: string | PdfString | undefined | null): Date | null {
  if (!s) return null;
  const t = (typeof s === 'string' ? s : s.toText()).trim();
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(t);
  if (!m) { const d = new Date(t); return isNaN(d.getTime()) ? null : d; }
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', sign, oh = '00', om = '00'] = m;
  // Date.UTC and the Date constructor read years 0–99 as 1900–1999, so the year is set separately.
  const utc = new Date(Date.UTC(2000, +mo - 1, +d, +h, +mi, +se)); utc.setUTCFullYear(+y);
  let ms = utc.getTime();
  if (sign === '+' || sign === '-') ms -= (sign === '+' ? 1 : -1) * ((+oh) * 60 + (+om)) * 60000;
  else if (!sign) { const local = new Date(2000, +mo - 1, +d, +h, +mi, +se); local.setFullYear(+y); return isNaN(local.getTime()) ? null : local; }
  const out = new Date(ms);
  return isNaN(out.getTime()) ? null : out;
}

/** Bytes as a Latin-1 string, built in chunks (one character at a time makes a rope with a node per byte). */
export const latin1 = (u8: Uint8Array, from = 0, to = u8.length): string => {
  const end = Math.min(to, u8.length);
  let s = '';
  for (let i = Math.max(0, from); i < end; i += 0x2000) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(end, i + 0x2000)) as unknown as number[]);
  return s;
};
/** A name for display: names are kept as their bytes (so they round-trip), and this decodes UTF-8 when it is valid. */
export const nameText = (name: string): string => {
  if (!/[\x80-\xff]/.test(name) || /[^\x00-\xff]/.test(name)) return name;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytesOf(name)); } catch { return name; }
};
export const bytesOf = (s: string): Uint8Array => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const concat = (parts: Uint8Array[]): Uint8Array => { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
