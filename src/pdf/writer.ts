/**
 * Serialization (ISO 32000-1 §7.3, §7.5): objects to bytes, full rewrites with renumbering (unused
 * objects dropped, streams optionally recompressed, optional encryption) and incremental updates
 * (the original bytes untouched, changed objects and a new cross-reference section appended).
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, bytesOf, concat, dictOf, isName, latin1, nameObj, utf8 } from './objects';
import { deflateZlib } from './filters';
import { SecurityHandler, Permissions } from './crypt';
import type { PdfDocument } from './document';
import { md5, randomBytes } from './hash';

export interface SaveOptions {
  /** Append an update instead of rewriting (default: when possible). */
  incremental?: boolean;
  /** Full rewrite only: recompress non-image streams with Flate. */
  recompress?: boolean;
  /** Full rewrite only: keep objects that are not reachable from the trailer. */
  keepUnused?: boolean;
  /** Full rewrite only: pack dictionaries into object streams and write an xref stream. */
  objectStreams?: boolean;
  /** Encrypt with AES-256 (full rewrite). */
  encrypt?: { userPassword: string; ownerPassword: string; permissions: Partial<Permissions>; encryptMetadata?: boolean };
  /** Drop the existing encryption (full rewrite). */
  removeSecurity?: boolean;
  /** PDF version for the header (full rewrite). */
  version?: string;
}

const NAME_ESC = /[^\x21-\x7e]|[#()<>\[\]{}\/%]/g;

/** A name is a byte string (one char per byte, as the lexer reads it); one made in code with wider characters is written as UTF-8. */
export function serializeName(n: string): string {
  if (/[^\x00-\xff]/.test(n)) n = latin1(utf8(n));
  return '/' + n.replace(NAME_ESC, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());
}

export function serializeString(s: PdfString): string {
  const b = s.bytes;
  let binary = s.hex;
  if (!binary) { let bad = 0; for (let i = 0; i < b.length; i++) if (b[i] < 32 || b[i] > 126) bad++; binary = bad > b.length / 4 && b.length > 2; }
  if (binary) { let h = '<'; for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0'); return h + '>'; }
  let out = '(';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c === 10) out += '\\n'; else if (c === 13) out += '\\r'; else if (c === 9) out += '\\t'; else if (c === 8) out += '\\b'; else if (c === 12) out += '\\f';
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

/**
 * A number in PDF syntax: no exponent, and eight significant digits (more than the single-precision
 * reals most readers use), so that small values such as a 1/2048 font matrix survive being rewritten.
 */
export function fmtNum(n: number): string {
  if (!isFinite(n)) return '0';
  if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? String(n) : BigInt(n).toString();
  const a = Math.abs(n);
  if (a < 1e-30) return '0';
  if (a >= 1e21) return BigInt(Math.round(n)).toString();
  const decimals = Math.max(0, 7 - Math.floor(Math.log10(a)));
  let s = n.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** Serializes a direct object. Streams return their dictionary + data. */
export function serialize(o: PdfObj): Uint8Array {
  const parts: Uint8Array[] = [];
  const push = (s: string) => parts.push(bytesOf(s));
  const walk = (v: PdfObj): void => {
    if (v === null || v === undefined) push('null');
    else if (typeof v === 'boolean') push(v ? 'true' : 'false');
    else if (typeof v === 'number') push(fmtNum(v));
    else if (v instanceof PdfString) push(serializeString(v));
    else if (v instanceof Name) push(serializeName(v.name));
    else if (v instanceof Ref) push(`${v.num} ${v.gen} R`);
    else if (Array.isArray(v)) { push('['); v.forEach((x, i) => { if (i) push(' '); walk(x); }); push(']'); }
    else if (v instanceof Dict) {
      push('<<');
      for (const [k, x] of v.map) { push(serializeName(k)); if (!(x instanceof Dict) && !Array.isArray(x) && !(x instanceof PdfString) && !(x instanceof Name)) push(' '); walk(x); }
      push('>>');
    } else if (v instanceof PdfStream) {
      const d = v.dict.clone();
      d.set('Length', v.raw.length);
      walk(d);
      push('\nstream\n');
      parts.push(v.raw);
      push('\nendstream');
    }
  };
  walk(o);
  return concat(parts);
}

/**
 * serialize() as a list of pieces, for writers that join everything once at the end: a stream's data is
 * handed over as it is instead of being copied into an intermediate buffer first. Saves one copy of every
 * changed stream on every incremental save (the app writes one after each edit).
 */
export function serializeParts(o: PdfObj): Uint8Array[] {
  if (!(o instanceof PdfStream)) return [serialize(o)];
  const d = o.dict.clone();
  d.set('Length', o.raw.length);
  return [serialize(d), bytesOf('\nstream\n'), o.raw, bytesOf('\nendstream')];
}

function reachable(doc: PdfDocument, roots: PdfObj[]): Set<number> {
  const seen = new Set<number>();
  const stack: PdfObj[] = [...roots];
  while (stack.length) {
    const v = stack.pop()!;
    // Pushed one by one: spreading a very large array or dictionary into push() overflows the call stack.
    if (v instanceof Ref) { if (seen.has(v.num)) continue; seen.add(v.num); stack.push(doc.fetch(v)); }
    else if (Array.isArray(v)) { for (const x of v) stack.push(x); }
    else if (v instanceof Dict) { for (const x of v.map.values()) stack.push(x); }
    else if (v instanceof PdfStream) { for (const x of v.dict.map.values()) stack.push(x); }
  }
  return seen;
}

/** Remaps references in an object graph (used by renumbering and by copying between documents). */
export function remapRefs(o: PdfObj, map: (r: Ref) => Ref): PdfObj {
  if (o instanceof Ref) return map(o);
  if (Array.isArray(o)) return o.map((x) => remapRefs(x, map));
  if (o instanceof Dict) { const d = new Dict(); for (const [k, v] of o.map) d.map.set(k, remapRefs(v, map)); return d; }
  if (o instanceof PdfStream) { const s = new PdfStream(remapRefs(o.dict, map) as Dict, o.raw); s.decoded = o.decoded; return s; }
  return o;
}

const IMAGE_OR_FONT = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);

function recompressed(doc: PdfDocument, s: PdfStream): PdfStream {
  const f = s.dict.get('Filter');
  const names = isName(f) ? [f.name] : Array.isArray(f) ? f.filter(nameObj).map((n) => (n as Name).name) : [];
  // /F means the data is in another file: there is nothing here to recompress.
  if (names.some((n) => IMAGE_OR_FONT.has(n)) || isName(s.dict.get('Type'), 'XRef') || s.dict.has('F')) return s;
  if (names.length === 1 && names[0] === 'FlateDecode' && !s.dict.has('DecodeParms')) return s; // already Flate without predictor
  let data: Uint8Array;
  // `corrupt` also covers a predictor that could not be undone: such data must keep its /DecodeParms.
  try { const r = doc.decode(s); if (r.imageFilter || r.corrupt) return s; data = r.data; } catch { return s; }
  const raw = deflateZlib(data);
  // Never make a stream bigger (a predictor often compresses an image better than plain Flate does).
  if (raw.length >= s.raw.length) return s;
  const d = s.dict.clone();
  d.delete('DecodeParms');
  d.set('Filter', Name.get('FlateDecode'));
  d.set('Length', raw.length);
  const out = new PdfStream(d, raw);
  out.decoded = data;
  return out;
}

export function writeFull(doc: PdfDocument, opts: SaveOptions = {}): Uint8Array {
  const trailer = doc.trailer;
  const encRef = trailer.get('Encrypt');
  // Encryption for the new file.
  const ids = doc.resolve(trailer.get('ID'));
  const oldId0 = Array.isArray(ids) && ids[0] instanceof PdfString ? ids[0].bytes : null;
  const freshId = (): Uint8Array => md5(concat([randomBytes(16), bytesOf(String(Date.now()))]));
  let id0: Uint8Array | null = oldId0;
  let security: SecurityHandler | null = null;
  let encDict: Dict | null = null;
  if (opts.encrypt) {
    id0 = freshId();
    const e = SecurityHandler.createAes256(opts.encrypt.userPassword, opts.encrypt.ownerPassword, opts.encrypt.permissions, id0, opts.encrypt.encryptMetadata !== false);
    security = e.handler; encDict = e.dict;
  } else if (doc.security && !opts.removeSecurity) {
    security = doc.security;
    encDict = security.dict;
  }
  // An RC4 or AES-128 key is derived from ID[0]. A file with no /ID was encrypted with an empty one, so
  // giving it an ID now would make its own password stop working.
  const keepNoId = !oldId0 && !!security && security === doc.security && security.R < 5;
  if (!id0 && !keepNoId) id0 = freshId();
  const roots: PdfObj[] = [trailer.get('Root') ?? null, trailer.get('Info') ?? null];
  // What a kept encryption dictionary refers to has to be written and renumbered like everything else.
  if (encDict && !opts.encrypt) for (const v of encDict.map.values()) roots.push(v);
  // Left out before numbering, so the new file has no gaps (and so no free entries): the old /Encrypt
  // dictionary (written again below), old xref streams, and object streams (their contents are written directly).
  const dropped = (n: number): boolean => {
    if (encRef instanceof Ref && encRef.num === n) return true;
    const o = doc.fetch(new Ref(n, doc.genOf(n)));
    return o instanceof PdfStream && (isName(o.dict.get('Type'), 'XRef') || isName(o.dict.get('Type'), 'ObjStm'));
  };
  const nums = (opts.keepUnused ? doc.objectNumbers() : [...reachable(doc, roots)].sort((a, b) => a - b)).filter((n) => !dropped(n));
  // Renumber 1..n in order.
  const map = new Map<number, number>();
  nums.forEach((n, i) => map.set(n, i + 1));
  const mapRef = (r: Ref): Ref => (map.has(r.num) ? new Ref(map.get(r.num)!, 0) : new Ref(0, 0));
  // The header has to admit what the file uses, unless the caller chose a version.
  let version = opts.version || versionOf(doc);
  const atLeast = (v: string) => { if (!opts.version && version < v) version = v; };
  if (opts.objectStreams) atLeast('1.5');
  if (security) atLeast(security.R >= 5 ? '1.7' : security.method === 'aesv2' || security.stringMethod === 'aesv2' ? '1.6' : security.V >= 4 ? '1.5' : '1.4');
  // AES-256 with revision 6 is PDF 2.0; in a 1.7 file it is declared as Adobe extension level 8.
  const rootRef = trailer.get('Root');
  const declareR6 = !!opts.encrypt && version < '2.0';
  const out: Uint8Array[] = [];
  let pos = 0;
  const push = (b: Uint8Array) => { out.push(b); pos += b.length; };
  push(bytesOf(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`));
  const offsets = new Map<number, number>();
  const objStmCandidates: [number, Uint8Array][] = [];
  for (const n of nums) {
    const newNum = map.get(n)!;
    let obj = doc.fetch(new Ref(n, doc.genOf(n)));
    if (declareR6 && rootRef instanceof Ref && rootRef.num === n && obj instanceof Dict) obj = withExtensionLevel8(doc, obj);
    // Recompressed before renumbering: decoding may follow references (/DecodeParms), which are still the document's.
    if (obj instanceof PdfStream && opts.recompress) obj = recompressed(doc, obj);
    obj = remapRefs(obj, mapRef);
    if (security) obj = security.encryptObject(obj, new Ref(newNum, 0));
    if (opts.objectStreams && !(obj instanceof PdfStream) && !security) { objStmCandidates.push([newNum, serialize(obj)]); continue; }
    offsets.set(newNum, pos);
    push(bytesOf(`${newNum} 0 obj\n`));
    push(serialize(obj));
    push(bytesOf('\nendobj\n'));
  }
  let size = nums.length + 1;
  const xrefStmEntries: [number, number, number, number][] = []; // num, type, f2, f3
  if (objStmCandidates.length) {
    // One object stream per 100 objects.
    for (let i = 0; i < objStmCandidates.length; i += 100) {
      const chunk = objStmCandidates.slice(i, i + 100);
      const stmNum = size++;
      let header = '';
      const bodies: Uint8Array[] = [];
      let off = 0;
      chunk.forEach(([num, data]) => { header += `${num} ${off} `; bodies.push(data, bytesOf('\n')); off += data.length + 1; });
      const hb = bytesOf(header + '\n');
      const data = concat([hb, ...bodies]);
      const raw = deflateZlib(data);
      const s = new PdfStream(new Dict({ Type: Name.get('ObjStm'), N: chunk.length, First: hb.length, Filter: Name.get('FlateDecode'), Length: raw.length }), raw);
      offsets.set(stmNum, pos);
      push(bytesOf(`${stmNum} 0 obj\n`)); push(serialize(s)); push(bytesOf('\nendobj\n'));
      chunk.forEach(([num], idx) => xrefStmEntries.push([num, 2, stmNum, idx]));
    }
  }
  let encNum = 0;
  if (encDict) {
    encNum = size++;
    offsets.set(encNum, pos);
    push(bytesOf(`${encNum} 0 obj\n`)); push(serialize(opts.encrypt ? encDict : remapRefs(encDict, mapRef))); push(bytesOf('\nendobj\n'));
  }
  const newTrailer = new Dict();
  newTrailer.set('Root', rootRef instanceof Ref ? mapRef(rootRef) : (rootRef ?? null) as PdfObj);
  const info = trailer.get('Info');
  if (info instanceof Ref && map.has(info.num)) newTrailer.set('Info', mapRef(info));
  if (id0) newTrailer.set('ID', [new PdfString(id0, true), new PdfString(md5(concat([id0, randomBytes(16), bytesOf(String(Date.now()))])), true)]);
  if (encNum) newTrailer.set('Encrypt', new Ref(encNum, 0));
  const xrefPos = pos;
  if (opts.objectStreams || xrefStmEntries.length) {
    const xnum = size++;
    newTrailer.set('Size', size);
    const rows: Uint8Array[] = [];
    const W = [1, 4, 2];
    const entryFor = new Map<number, [number, number, number]>();
    for (const [n, o] of offsets) entryFor.set(n, [1, o, 0]);
    for (const [n, t, f2, f3] of xrefStmEntries) entryFor.set(n, [t, f2, f3]);
    entryFor.set(xnum, [1, xrefPos, 0]);
    for (let n = 0; n < size; n++) {
      const e = entryFor.get(n) || [0, 0, n === 0 ? 65535 : 0]; // object 0 heads the (empty) free list with generation 65535
      rows.push(Uint8Array.from([e[0], (e[1] >>> 24) & 255, (e[1] >>> 16) & 255, (e[1] >>> 8) & 255, e[1] & 255, (e[2] >> 8) & 255, e[2] & 255]));
    }
    const data = concat(rows);
    const raw = deflateZlib(data);
    const xd = new Dict({ Type: Name.get('XRef'), Size: size, W, Filter: Name.get('FlateDecode'), Length: raw.length });
    for (const [k, v] of newTrailer.map) xd.set(k, v);
    push(bytesOf(`${xnum} 0 obj\n`)); push(serialize(new PdfStream(xd, raw))); push(bytesOf('\nendobj\n'));
  } else {
    newTrailer.set('Size', size);
    let x = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) { const o = offsets.get(n); x += o != null ? `${String(o).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n'; }
    push(bytesOf(x));
    push(bytesOf('trailer\n')); push(serialize(newTrailer)); push(bytesOf('\n'));
  }
  push(bytesOf(`startxref\n${xrefPos}\n%%EOF\n`));
  return concat(out);
}

export function writeIncremental(doc: PdfDocument, _opts: SaveOptions = {}): Uint8Array {
  const base = doc.buf;
  const out: Uint8Array[] = [base];
  let pos = base.length;
  const push = (b: Uint8Array) => { out.push(b); pos += b.length; };
  if (base.length && base[base.length - 1] !== 10 && base[base.length - 1] !== 13) push(bytesOf('\n'));
  const changed = [...doc.changed.entries()].sort((a, b) => a[0] - b[0]);
  const offsets = new Map<number, number>();
  const deleted: number[] = [];
  let size = doc.size;
  for (const [n, obj] of changed) {
    if (n >= size) size = n + 1;
    if (obj === null) { if (n > 0) deleted.push(n); continue; }
    const gen = doc.genOf(n);
    let o: PdfObj = obj;
    if (doc.security) o = doc.security.encryptObject(o, new Ref(n, gen));
    offsets.set(n, pos);
    push(bytesOf(`${n} ${gen} obj\n`)); for (const part of serializeParts(o)) push(part); push(bytesOf('\nendobj\n'));
  }
  const t = new Dict();
  for (const k of ['Root', 'Info', 'Encrypt']) if (doc.trailer.has(k)) t.set(k, doc.trailer.get(k)!);
  // ID[0] stays, ID[1] is new. A file without an /ID gets one, except when it is encrypted with a key
  // derived from the ID (RC4, AES-128): that key was made from an empty ID and must go on working.
  const ids = doc.resolve(doc.trailer.get('ID'));
  const oldId0 = Array.isArray(ids) && ids[0] instanceof PdfString ? ids[0] : null;
  if (oldId0 || !(doc.security && doc.security.R < 5)) {
    const id0 = oldId0 ?? new PdfString(md5(concat([randomBytes(16), bytesOf(String(Date.now()))])), true);
    t.set('ID', [id0, new PdfString(md5(concat([id0.bytes, randomBytes(16), bytesOf(String(Date.now()) + pos)])), true)]);
  }
  t.set('Size', size);
  if (doc.startxref >= 0) t.set('Prev', doc.startxref);
  // The free list (§7.5.4): object 0 heads it, each free object names the next one, and the last names 0.
  // It holds the objects deleted now and those the previous revision already listed as free, so that
  // this section's entry for object 0 (which replaces the old one) does not cut the earlier ones off.
  const gens = new Map<number, number>();
  for (const n of deleted) gens.set(n, Math.min(65535, doc.genOf(n) + 1));
  for (const [n, g] of doc.prevFree) if (n > 0 && n < size && !offsets.has(n) && !gens.has(n)) gens.set(n, g);
  const freeList = [...gens.keys()].sort((a, b) => a - b);
  const nextFree = new Map<number, number>();
  freeList.forEach((n, i) => nextFree.set(n, freeList[i + 1] ?? 0));
  const freeGen = (n: number): number => gens.get(n) ?? 0;
  const xrefPos = pos;
  if (doc.usesXrefStream) {
    const xnum = size;
    const nums = [...(freeList.length ? [0] : []), ...offsets.keys(), ...freeList, xnum].sort((a, b) => a - b);
    const rows: Uint8Array[] = [];
    const index: number[] = [];
    // Index: runs of consecutive numbers.
    let runStart = -1, runLen = 0, prev = -2;
    const flush = () => { if (runStart >= 0) index.push(runStart, runLen); };
    for (const n of nums) {
      if (n !== prev + 1) { flush(); runStart = n; runLen = 0; }
      runLen++; prev = n;
      const o = n === xnum ? xrefPos : offsets.get(n);
      const e: [number, number, number] = o != null ? [1, o, n === xnum ? 0 : doc.genOf(n)] : n === 0 ? [0, freeList[0] ?? 0, 65535] : [0, nextFree.get(n) ?? 0, freeGen(n)];
      rows.push(Uint8Array.from([e[0], (e[1] >>> 24) & 255, (e[1] >>> 16) & 255, (e[1] >>> 8) & 255, e[1] & 255, (e[2] >> 8) & 255, e[2] & 255]));
    }
    flush();
    const data = concat(rows);
    const raw = deflateZlib(data);
    const xd = new Dict({ Type: Name.get('XRef'), Size: size + 1, W: [1, 4, 2], Index: index, Filter: Name.get('FlateDecode'), Length: raw.length });
    for (const [k, v] of t.map) if (k !== 'Size') xd.set(k, v);
    push(bytesOf(`${xnum} 0 obj\n`)); push(serialize(new PdfStream(xd, raw))); push(bytesOf('\nendobj\n'));
  } else {
    // Every section starts with object 0 (the head of the free list), as readers expect of a table.
    const nums = [0, ...[...offsets.keys(), ...freeList].filter((n) => n > 0)].sort((a, b) => a - b);
    const pad = (v: number, w: number) => String(v).padStart(w, '0');
    let x = 'xref\n';
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      x += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        const n = nums[k]; const o = offsets.get(n);
        x += o != null && n > 0 ? `${pad(o, 10)} ${pad(doc.genOf(n), 5)} n \n` : n === 0 ? `${pad(freeList[0] ?? 0, 10)} 65535 f \n` : `${pad(nextFree.get(n) ?? 0, 10)} ${pad(freeGen(n), 5)} f \n`;
      }
      i = j + 1;
    }
    push(bytesOf(x));
    push(bytesOf('trailer\n')); push(serialize(t)); push(bytesOf('\n'));
  }
  push(bytesOf(`startxref\n${xrefPos}\n%%EOF\n`));
  return concat(out);
}

/** The catalog with /Extensions /ADBE declaring extension level 8 (unless it already declares that or more). */
function withExtensionLevel8(doc: PdfDocument, cat: Dict): Dict {
  const ext = dictOf(doc.resolve(cat.get('Extensions')));
  const adbe = ext ? dictOf(doc.resolve(ext.get('ADBE'))) : null;
  const level = adbe ? doc.resolve(adbe.get('ExtensionLevel')) : null;
  if (typeof level === 'number' && level >= 8) return cat;
  const e = ext ? ext.clone() : new Dict();
  e.set('ADBE', new Dict({ BaseVersion: Name.get('1.7'), ExtensionLevel: 8 }));
  const c = cat.clone();
  c.set('Extensions', e);
  return c;
}

function versionOf(doc: PdfDocument): string {
  const m = /%PDF-(\d\.\d)/.exec(doc.report.header);
  const v = doc.catalog.get('Version');
  const cv = isName(v) ? v.name : '';
  const best = [m?.[1] || '1.4', cv].filter(Boolean).sort().pop() || '1.4';
  return best < '1.4' ? '1.4' : best;
}
