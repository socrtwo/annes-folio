/**
 * Cross-reference tables and streams (ISO 32000-1 §7.5.4–7.5.8) and their reconstruction from the
 * bytes of a damaged file.
 */
import { Dict, PdfObj, PdfStream, Ref, isName, latin1 } from './objects';
import { Lexer, Parser, isRegular, isWhite } from './lexer';
import { decodeStream } from './filters';

export interface XrefEntry { offset: number; gen: number; /** 1 = in file, 2 = in an object stream (offset = stream object number, idx = index). */ type: 1 | 2; idx?: number }

export interface XrefResult {
  entries: Map<number, XrefEntry>;
  trailer: Dict;
  /** The file's newest section is an xref stream (updates should then use one too). */
  usesXrefStream: boolean;
  /** Where the newest section really starts (what an update's /Prev must name), not the number after `startxref`. */
  startxref: number;
  warnings: string[];
  /** Offsets of every xref section seen (newest first). */
  sections: number[];
}

interface Section { entries: Map<number, XrefEntry>; /** Object numbers this section marks free (deleted). */ free: number[]; trailer: Dict; stream: boolean; offset: number }

const num = (o: PdfObj | undefined, d = 0): number => (typeof o === 'number' ? o : d);

/** Parses the xref chain starting at startxref. Throws when nothing usable is found. */
export function parseXref(buf: Uint8Array, resolveLength: (o: PdfObj) => PdfObj = (o) => o): XrefResult {
  const tail = Lexer.findLast(buf, 'startxref');
  if (tail < 0) throw new Error('No startxref');
  const lex = new Lexer(buf, tail + 9);
  const t = lex.next();
  if (t.t !== 'num') throw new Error('startxref has no offset');
  const result: XrefResult = { entries: new Map(), trailer: new Dict(), usesXrefStream: false, startxref: t.v, warnings: [], sections: [] };
  const seen = new Set<number>();
  // Objects a newer section deleted: an older section's entry for them must not bring them back.
  const freed = new Set<number>();
  const merge = (s: Section, withFree: boolean) => {
    for (const [n, e] of s.entries) if (!result.entries.has(n) && !freed.has(n)) result.entries.set(n, e);
    for (const [k, v] of s.trailer.map) if (!result.trailer.has(k)) result.trailer.set(k, v);
    if (withFree) for (const n of s.free) if (!result.entries.has(n)) freed.add(n);
  };
  const read = (off: number): Section | null => {
    if (seen.has(off)) return null;
    if (off < 0 || off >= buf.length) { result.warnings.push(`xref offset ${off} is outside the file`); return null; }
    seen.add(off);
    result.sections.push(off);
    const section = parseSection(buf, off, resolveLength);
    if (!section) result.warnings.push(`No xref section at ${off}`);
    else seen.add(section.offset);
    return section;
  };
  let next: number | null = t.v;
  let first = true;
  while (next !== null) {
    const section = read(next);
    next = null;
    if (!section) { if (first) throw new Error('startxref points at nothing'); continue; }
    if (first) { result.usesXrefStream = section.stream; result.startxref = section.offset; }
    first = false;
    merge(section, false);
    // Hybrid files: the table lists the objects kept in object streams as free, and the xref stream named
    // by XRefStm supplies them. So the stream is read before the table's free entries take effect.
    const xs = section.trailer.get('XRefStm');
    if (typeof xs === 'number') { const hybrid = read(xs); if (hybrid) merge(hybrid, true); }
    for (const n of section.free) if (!result.entries.has(n)) freed.add(n);
    const prev = section.trailer.get('Prev');
    if (typeof prev === 'number') next = prev;
  }
  if (!result.trailer.has('Root')) throw new Error('The trailer has no /Root');
  return result;
}

function parseSection(buf: Uint8Array, off: number, resolveLength: (o: PdfObj) => PdfObj): Section | null {
  const lex = new Lexer(buf, off);
  lex.skipWs();
  if (Lexer.find(buf, 'xref', lex.pos, lex.pos + 4) === lex.pos) return parseTable(buf, lex.pos + 4, lex.pos);
  // An xref stream: "n g obj <<…>> stream"
  const start = lex.pos;
  const p = new Parser(buf, start, resolveLength);
  const ind = p.parseIndirect();
  if (ind && ind.obj instanceof PdfStream && isName(ind.obj.dict.get('Type'), 'XRef')) return parseXrefStream(ind.obj, resolveLength, start);
  // Some writers point a few bytes before/after "xref" (but "startxref" is not a table).
  for (let from = Math.max(0, off - 64); ;) {
    const near = Lexer.find(buf, 'xref', from, off + 128);
    if (near < 0) return null;
    if (near !== off && !(near >= 5 && Lexer.find(buf, 'start', near - 5, near) === near - 5)) return parseTable(buf, near + 4, near);
    from = near + 4;
  }
}

function parseTable(buf: Uint8Array, pos: number, offset: number): Section {
  const entries = new Map<number, XrefEntry>();
  const free: number[] = [];
  const lex = new Lexer(buf, pos);
  for (;;) {
    lex.skipWs();
    if (Lexer.find(buf, 'trailer', lex.pos, lex.pos + 7) === lex.pos) {
      const p = new Parser(buf, lex.pos + 7);
      const t = p.parse();
      return { entries, free, trailer: t instanceof Dict ? t : new Dict(), stream: false, offset };
    }
    const a = lex.next();
    const b = lex.next();
    if (a.t !== 'num' || b.t !== 'num') return { entries, free, trailer: new Dict(), stream: false, offset };
    const start = a.v, count = b.v;
    lex.skipWs();
    // Entries are 20 bytes each in a valid file, but tolerate sloppy spacing by tokenizing.
    for (let i = 0; i < count; i++) {
      lex.skipWs();
      const save = lex.pos;
      if (Lexer.find(buf, 'trailer', lex.pos, lex.pos + 7) === lex.pos) break;
      const o = lex.next(), g = lex.next(), k = lex.next();
      if (o.t !== 'num' || g.t !== 'num' || k.t !== 'kw') { lex.pos = save; break; }
      const n = start + i;
      if (k.v === 'n') { if (!entries.has(n)) entries.set(n, { offset: o.v, gen: g.v, type: 1 }); }
      else if (k.v === 'f' && n > 0) free.push(n);
    }
  }
}

function parseXrefStream(s: PdfStream, resolveLength: (o: PdfObj) => PdfObj, offset: number): Section {
  const d = s.dict;
  const data = decodeStream(s.raw, d, (o) => resolveLength(o ?? null)).data;
  const W = (d.get('W') as PdfObj[] | undefined)?.map((x) => num(x)) || [1, 1, 1];
  const size = num(d.get('Size'));
  const index = (d.get('Index') as PdfObj[] | undefined)?.map((x) => num(x)) || [0, size];
  const entries = new Map<number, XrefEntry>();
  const free: number[] = [];
  const rowLen = W.reduce((a, b) => a + b, 0);
  let pos = 0;
  const read = (w: number): number => { let v = 0; for (let i = 0; i < w; i++) v = v * 256 + (data[pos++] ?? 0); return v; };
  for (let k = 0; k + 1 < index.length; k += 2) {
    const start = index[k], count = index[k + 1];
    for (let i = 0; i < count && pos + rowLen <= data.length; i++) {
      const type = W[0] === 0 ? 1 : read(W[0]);
      const f2 = read(W[1]);
      const f3 = read(W[2]);
      const n = start + i;
      if (entries.has(n)) continue;
      if (type === 1) entries.set(n, { offset: f2, gen: f3, type: 1 });
      else if (type === 2) entries.set(n, { offset: f2, gen: 0, type: 2, idx: f3 });
      else if (type === 0 && n > 0) free.push(n);
    }
  }
  const trailer = new Dict();
  for (const k of ['Root', 'Info', 'ID', 'Encrypt', 'Prev', 'Size', 'XRefStm']) if (d.has(k)) trailer.set(k, d.get(k)!);
  return { entries, free, trailer, stream: true, offset };
}

// ------------------------------------------------------------------------------------------
// Reconstruction

export interface ObjectHeader { num: number; gen: number; offset: number }

/**
 * Every "num gen obj" in the file, in file order. Works on the bytes (searching for "obj" and reading
 * backwards), so it needs no string copy of the file and stays linear on long runs of digits.
 */
export function scanObjectHeaders(buf: Uint8Array): ObjectHeader[] {
  const out: ObjectHeader[] = [];
  const digit = (c: number) => c >= 0x30 && c <= 0x39;
  for (let from = 0; ;) {
    const at = Lexer.find(buf, 'obj', from);
    if (at < 0) break;
    from = at + 3;
    if (at + 3 < buf.length && isRegular(buf[at + 3])) continue;
    let p = at - 1;
    if (p < 0 || !isWhite(buf[p])) continue; // also rules out "endobj"
    while (p >= 0 && isWhite(buf[p])) p--;
    const gEnd = p;
    while (p >= 0 && digit(buf[p])) p--;
    if (p === gEnd || gEnd - p > 5 || p < 0 || !isWhite(buf[p])) continue;
    let gen = 0; for (let i = p + 1; i <= gEnd; i++) gen = gen * 10 + (buf[i] - 0x30);
    while (p >= 0 && isWhite(buf[p])) p--;
    const nEnd = p;
    while (p >= 0 && digit(buf[p])) p--;
    if (p === nEnd || nEnd - p > 10) continue;
    let n = 0; for (let i = p + 1; i <= nEnd; i++) n = n * 10 + (buf[i] - 0x30);
    out.push({ num: n, gen, offset: p + 1 });
  }
  return out;
}

/** What a scan of the file found, before object streams are opened and a catalog is chosen. */
export interface Scan {
  entries: Map<number, XrefEntry>;
  /** Object numbers of the object streams found, in file order. */
  objStreams: number[];
  /** Trailer dictionaries and xref stream dictionaries, with where they are. */
  trailers: { pos: number; dict: Dict; stream: boolean }[];
  /** Root, Info, ID and Encrypt from the newest trailer that has each. */
  trailer: Dict;
  catalogs: number[];
  pagesRoots: number[];
  objectsFound: number;
}

/**
 * First pass of a rebuild: finds every top-level object and every trailer. The last definition of an
 * object wins (later updates come later in the file). Object streams are only listed, because in an
 * encrypted file they cannot be read until the security handler has the trailer's /Encrypt and /ID.
 */
export function scanObjects(buf: Uint8Array, resolveLength: (o: PdfObj) => PdfObj = (o) => o): Scan {
  const scan: Scan = { entries: new Map(), objStreams: [], trailers: [], trailer: new Dict(), catalogs: [], pagesRoots: [], objectsFound: 0 };
  const objStreams = new Set<number>();
  for (const h of scanObjectHeaders(buf)) {
    scan.entries.set(h.num, { offset: h.offset, gen: h.gen, type: 1 });
    scan.objectsFound++;
    objStreams.delete(h.num);
    // Peek at the object's dictionary type without a full parse: the next bytes, but no further than the
    // object itself (the dictionary of a neighbour must not be mistaken for this one's).
    let head = latin1(buf, h.offset, h.offset + 400);
    const own = head.search(/\bendobj\b|\bstream\b/);
    if (own >= 0) head = head.slice(0, own);
    if (/\/Type\s*\/ObjStm\b/.test(head)) objStreams.add(h.num);
    if (/\/Type\s*\/XRef\b/.test(head)) { try { const o = new Parser(buf, h.offset, resolveLength).parseIndirect(); if (o?.obj instanceof PdfStream) scan.trailers.push({ pos: h.offset, dict: o.obj.dict, stream: true }); } catch { /* */ } }
    if (/\/Type\s*\/Catalog\b/.test(head)) scan.catalogs.push(h.num);
    if (/\/Type\s*\/Pages\b/.test(head) && !/\/Parent\b/.test(head)) scan.pagesRoots.push(h.num);
  }
  scan.objStreams = [...objStreams].sort((a, b) => scan.entries.get(a)!.offset - scan.entries.get(b)!.offset);
  for (let from = 0; ;) {
    const at = Lexer.find(buf, 'trailer', from);
    if (at < 0) break;
    from = at + 7;
    try { const t = new Parser(buf, at + 7, resolveLength).parse(); if (t instanceof Dict) scan.trailers.push({ pos: at, dict: t, stream: false }); } catch { /* */ }
  }
  // The newest trailer (the last in the file) that has a key supplies it.
  for (const t of [...scan.trailers].sort((a, b) => b.pos - a.pos)) {
    for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (!scan.trailer.has(k) && t.dict.has(k)) scan.trailer.set(k, t.dict.get(k)!);
  }
  return scan;
}

/**
 * Lists the objects of one object stream (its decoded, decrypted bytes) in a scan so they resolve even
 * when no xref stream survives. A top-level definition wins only if it comes later in the file than the stream.
 */
export function addObjectStream(scan: Scan, stmNum: number, data: Uint8Array, count: number, first: number): void {
  const stm = scan.entries.get(stmNum);
  if (!stm || stm.type !== 1) return;
  const lex = new Lexer(data, 0);
  const pairs: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = lex.next(), b = lex.next();
    if (a.t !== 'num' || b.t !== 'num') break;
    pairs.push([a.v, b.v]);
  }
  pairs.forEach(([n, off], i) => {
    const had = scan.entries.get(n);
    if (n === stmNum || (had && had.type === 1 && had.offset > stm.offset)) return;
    scan.entries.set(n, { offset: stmNum, gen: 0, type: 2, idx: i });
    // Objects in streams count as catalogs/pages roots too (each object ends where the next one starts).
    const end = i + 1 < pairs.length && pairs[i + 1][1] > off ? first + pairs[i + 1][1] : data.length;
    const head = latin1(data, first + off, Math.min(end, first + off + 300));
    if (/\/Type\s*\/Catalog\b/.test(head)) scan.catalogs.push(n);
    if (/\/Type\s*\/Pages\b/.test(head) && !/\/Parent\b/.test(head)) scan.pagesRoots.push(n);
  });
}

export interface Reconstruction extends XrefResult { objectsFound: number; trailersFound: number; catalogSynthesized: boolean; /** The page tree root to build a catalog around, when no catalog survived. */ pagesRoot: number | null }

/**
 * Last pass of a rebuild: chooses the catalog. `usable` says whether an object number really holds a
 * dictionary (the caller can fetch it; a damaged or missing catalog is passed over for the next candidate).
 */
export function finishScan(scan: Scan, usable: (n: number, what: 'catalog' | 'pages') => boolean = (n) => scan.entries.has(n)): Reconstruction {
  const warnings: string[] = [];
  const trailer = scan.trailer;
  let catalogSynthesized = false;
  let pagesRoot: number | null = null;
  const root = trailer.get('Root');
  if (!(root instanceof Ref && usable(root.num, 'catalog'))) {
    trailer.delete('Root');
    const last = (list: number[], what: 'catalog' | 'pages'): number | null => { for (let i = list.length - 1; i >= 0; i--) if (usable(list[i], what)) return list[i]; return null; };
    const cat = last(scan.catalogs, 'catalog');
    if (cat !== null) { trailer.set('Root', new Ref(cat, scan.entries.get(cat)?.gen ?? 0)); warnings.push('The trailer was missing or damaged; the document catalog was found by scanning.'); }
    else {
      catalogSynthesized = true;
      pagesRoot = last(scan.pagesRoots, 'pages');
      warnings.push(pagesRoot !== null ? 'No document catalog survived; one was rebuilt from the page tree.' : 'No catalog and no page tree root found; pages will be collected by scanning.');
    }
  }
  if (!scan.objectsFound) warnings.push('No objects found in the file.');
  let maxNum = 0;
  for (const n of scan.entries.keys()) if (n > maxNum) maxNum = n;
  trailer.set('Size', maxNum + 1);
  const streams = scan.trailers.filter((t) => t.stream).length;
  return { entries: scan.entries, trailer, usesXrefStream: streams > 0 && streams === scan.trailers.length, startxref: -1, warnings, sections: [], objectsFound: scan.objectsFound, trailersFound: scan.trailers.length - streams, catalogSynthesized, pagesRoot };
}

/**
 * Rebuilds the cross-reference table of an unencrypted file in one call. (PdfDocument runs the three
 * passes itself so that it can decrypt object streams in between.)
 */
export function reconstructXref(buf: Uint8Array, resolveLength: (o: PdfObj) => PdfObj = (o) => o): Reconstruction {
  const scan = scanObjects(buf, resolveLength);
  for (const sn of scan.objStreams) {
    try {
      const o = new Parser(buf, scan.entries.get(sn)!.offset, resolveLength).parseIndirect();
      if (!(o?.obj instanceof PdfStream)) continue;
      const data = decodeStream(o.obj.raw, o.obj.dict, (x) => resolveLength(x ?? null)).data;
      addObjectStream(scan, sn, data, num(o.obj.dict.get('N')), num(o.obj.dict.get('First')));
    } catch { /* damaged object stream */ }
  }
  return finishScan(scan);
}
