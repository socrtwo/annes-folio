/**
 * Stream filters (ISO 32000-1 §7.4): FlateDecode (ImmortalInflate, so damaged data still yields what
 * it can), LZWDecode, ASCIIHexDecode, ASCII85Decode, RunLengthDecode, and the PNG/TIFF predictors.
 * Image filters (DCTDecode, JPXDecode, CCITTFaxDecode, JBIG2Decode) are left for the renderer: their
 * data passes through untouched and the stream is reported as an "image filter" stream.
 * Encoding: FlateDecode with a small DEFLATE compressor (LZ77; dynamic, fixed or stored blocks), synchronous.
 */
import { immortalInflate } from '../io/recover/inflate';
import { Dict, Name, PdfObj, PdfStream, isName, nameObj } from './objects';

export const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

export interface DecodeResult { data: Uint8Array; corrupt: boolean; imageFilter: string | null; params: Dict | null }

const ALIASES: Record<string, string> = { Fl: 'FlateDecode', LZW: 'LZWDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', RL: 'RunLengthDecode', DCT: 'DCTDecode', CCF: 'CCITTFaxDecode' };

/**
 * The filter chain of a stream as [name, params][] (resolving refs through `resolve`). The short keys /F and
 * /DP are read only for inline images (`inline`): in a stream dictionary /F is a file specification.
 */
export function filterChain(dict: Dict, resolve: (o: PdfObj | undefined) => PdfObj, inline = false): [string, Dict | null][] {
  const f = resolve(dict.get('Filter') ?? (inline ? dict.get('F') : undefined));
  const p = resolve(dict.get('DecodeParms') ?? (inline ? dict.get('DP') : undefined));
  const names: string[] = isName(f) ? [f.name] : Array.isArray(f) ? f.map((x) => resolve(x)).filter(nameObj).map((x) => (x as Name).name) : [];
  const params: (Dict | null)[] = Array.isArray(p) ? p.map((x) => { const r = resolve(x); return r instanceof Dict ? r : null; }) : [p instanceof Dict ? p : null];
  return names.map((n, i) => [ALIASES[n] || n, params[i] ?? null]);
}

/** Decodes a stream's raw bytes (already decrypted) through its filter chain. */
export function decodeStream(raw: Uint8Array, dict: Dict, resolve: (o: PdfObj | undefined) => PdfObj, inline = false): DecodeResult {
  let data = raw;
  let corrupt = false;
  for (const [name, params] of filterChain(dict, resolve, inline)) {
    if (IMAGE_FILTERS.has(name)) return { data, corrupt, imageFilter: name, params };
    switch (name) {
      case 'FlateDecode': { const r = inflateZlib(data); data = r.data; corrupt ||= r.corrupt; break; }
      case 'LZWDecode': { const r = lzw(data, params ? numOf(resolve(params.get('EarlyChange')), 1) : 1); data = r.data; corrupt ||= r.corrupt; break; }
      case 'ASCIIHexDecode': data = asciiHexDecode(data); break;
      case 'ASCII85Decode': data = ascii85Decode(data); break;
      case 'RunLengthDecode': data = runLengthDecode(data); break;
      case 'Crypt': break; // identity crypt filter
      default: return { data, corrupt, imageFilter: name, params }; // unknown filter: hand the bytes on
    }
    // A predictor this module cannot undo leaves the data as it is; `corrupt` tells callers not to re-encode it.
    if (params && (name === 'FlateDecode' || name === 'LZWDecode')) { const r = predict(data, params, resolve); data = r.data; corrupt ||= !r.ok; }
  }
  return { data, corrupt, imageFilter: null, params: null };
}

const numOf = (o: PdfObj, d: number): number => (typeof o === 'number' ? o : d);

/** zlib-wrapped (or raw) DEFLATE data → bytes; never throws. */
export function inflateZlib(data: Uint8Array): { data: Uint8Array; corrupt: boolean } {
  if (!data.length) return { data, corrupt: false };
  let start = 0;
  // Skip leading whitespace some producers leave before the zlib header.
  while (start < data.length && (data[start] === 0x0a || data[start] === 0x0d || data[start] === 0x20 || data[start] === 0x09)) start++;
  const cmf = data[start], flg = data[start + 1];
  const zlib = (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0;
  const body = data.subarray(zlib ? start + 2 : start);
  const r = immortalInflate(body, { resync: false });
  if (!zlib && r.isCorrupt && r.data.length === 0 && start + 1 < data.length) {
    // Maybe a damaged header: try from the next byte.
    const r2 = immortalInflate(data.subarray(start + 1), { resync: false });
    if (r2.data.length) return { data: r2.data, corrupt: true };
  }
  return { data: r.data, corrupt: r.isCorrupt };
}

export function applyPredictor(data: Uint8Array, params: Dict, resolve: (o: PdfObj | undefined) => PdfObj): Uint8Array {
  return predict(data, params, resolve).data;
}

/** Undoes a TIFF or PNG predictor. `ok` is false when the parameters are ones this code cannot handle (data unchanged). */
function predict(data: Uint8Array, params: Dict, resolve: (o: PdfObj | undefined) => PdfObj): { data: Uint8Array; ok: boolean } {
  const pred = numOf(resolve(params.get('Predictor')), 1);
  if (pred <= 1) return { data, ok: true };
  // Damaged parameters (zero, negative, fractional) fall back to the defaults instead of sizing an array with them.
  const whole = (o: PdfObj, d: number): number => { const v = numOf(o, d); return Number.isFinite(v) && v >= 1 ? Math.floor(v) : d; };
  const colors = whole(resolve(params.get('Colors')), 1);
  const bpc = whole(resolve(params.get('BitsPerComponent')), 8);
  const columns = whole(resolve(params.get('Columns')), 1);
  if (![1, 2, 4, 8, 16].includes(bpc)) return { data, ok: false };
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    // TIFF predictor: each sample is stored as the difference from the same component of the pixel to its left.
    const rows = Math.floor(data.length / rowLen);
    const out = data.slice(0, rows * rowLen);
    for (let r = 0; r < rows; r++) {
      const o = r * rowLen;
      if (bpc === 8) { for (let i = bpp; i < rowLen; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 0xff; }
      else if (bpc === 16) {
        for (let i = bpp; i + 1 < rowLen; i += 2) { const v = (((out[o + i] << 8) | out[o + i + 1]) + ((out[o + i - bpp] << 8) | out[o + i - bpp + 1])) & 0xffff; out[o + i] = v >> 8; out[o + i + 1] = v & 0xff; }
      } else {
        const mask = (1 << bpc) - 1;
        const left = new Uint8Array(colors);
        for (let x = 0, bit = 0; x < columns; x++) for (let k = 0; k < colors; k++, bit += bpc) {
          const at = o + (bit >> 3), shift = 8 - bpc - (bit & 7);
          const v = (((out[at] >> shift) & mask) + left[k]) & mask;
          out[at] = (out[at] & ~(mask << shift)) | (v << shift);
          left[k] = v;
        }
      }
    }
    return { data: out, ok: true };
  }
  return { data: pngPredict(data, rowLen, bpp), ok: true };
}

function pngPredict(data: Uint8Array, rowLen: number, bpp: number): Uint8Array {
  // PNG predictors: each row starts with a filter type byte.
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  if (!rows) return out;
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0, x = src[i];
      let v: number;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: v = x;
      }
      row[i] = v & 0xff;
    }
    prev = row;
  }
  return out;
}

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break;
    let v = -1;
    if (c >= 0x30 && c <= 0x39) v = c - 48; else if (c >= 0x41 && c <= 0x46) v = c - 55; else if (c >= 0x61 && c <= 0x66) v = c - 87; else continue;
    if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break;
    if (c === 0x7a && !tuple.length) { out.push(0, 0, 0, 0); continue; }
    if (c < 0x21 || c > 0x75) continue;
    tuple.push(c - 33);
    if (tuple.length === 5) { let v = 0; for (const t of tuple) v = v * 85 + t; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); tuple = []; }
  }
  if (tuple.length > 1) {
    const n = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let v = 0; for (const t of tuple) v = v * 85 + t;
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...b.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const l = data[i++];
    if (l === 128) break;
    if (l < 128) { for (let k = 0; k <= l && i < data.length; k++) out.push(data[i++]); }
    else { if (i >= data.length) break; const b = data[i++]; for (let k = 0; k < 257 - l; k++) out.push(b); }
  }
  return Uint8Array.from(out);
}

export function lzwDecode(data: Uint8Array, early = 1): Uint8Array { return lzw(data, early).data; }

/** LZW (TIFF/PDF flavour, most significant bit first). `corrupt` is set when a code cannot be in the table. */
function lzw(data: Uint8Array, early: number): { data: Uint8Array; corrupt: boolean } {
  let out = new Uint8Array(Math.max(1024, data.length * 3));
  let len = 0;
  let corrupt = false;
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push([], []); };
  reset();
  let codeLen = 9, prev: number[] | null = null, bitBuf = 0, bitCnt = 0, pos = 0;
  while (true) {
    while (bitCnt < codeLen && pos < data.length) { bitBuf = (bitBuf << 8) | data[pos++]; bitCnt += 8; }
    if (bitCnt < codeLen) break;
    const code = (bitBuf >>> (bitCnt - codeLen)) & ((1 << codeLen) - 1);
    bitCnt -= codeLen;
    if (code === 256) { reset(); codeLen = 9; prev = null; continue; }
    if (code === 257) break;
    let entry: number[];
    if (code < dict.length) { entry = dict[code]; if (prev && dict.length < 4096) dict.push([...prev, entry[0]]); }
    else if (prev && code === dict.length && dict.length < 4096) { entry = [...prev, prev[0]]; dict.push(entry); }
    else { corrupt = true; break; }
    if (len + entry.length > out.length) { const grown = new Uint8Array(Math.max(out.length * 2, len + entry.length)); grown.set(out.subarray(0, len)); out = grown; }
    out.set(entry, len); len += entry.length;
    prev = entry;
    // The width grows one code early by default (EarlyChange 1): when the table holds 511, 1023, 2047 entries.
    if (dict.length + early >= (1 << codeLen) && codeLen < 12) codeLen++;
  }
  return { data: out.slice(0, len), corrupt };
}

// ------------------------------------------------------------------------------------------
// Encoding

/** Adler-32 of data. */
function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
// The code for each match length (3–258) and distance (1–32768).
const LEN_SYM = new Uint8Array(259), DIST_SYM = new Uint8Array(32769);
for (let s = 0; s < 29; s++) for (let l = LEN_BASE[s]; l <= (s < 28 ? LEN_BASE[s + 1] - 1 : 258); l++) LEN_SYM[l] = s;
LEN_SYM[258] = 28;
for (let s = 0; s < 30; s++) for (let d = DIST_BASE[s]; d <= (s < 29 ? DIST_BASE[s + 1] - 1 : 32768); d++) DIST_SYM[d] = s;
const FIXED_LIT_LEN = new Uint8Array(288);
FIXED_LIT_LEN.fill(8, 0, 144); FIXED_LIT_LEN.fill(9, 144, 256); FIXED_LIT_LEN.fill(7, 256, 280); FIXED_LIT_LEN.fill(8, 280, 288);
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

/**
 * Huffman code lengths for symbol frequencies, none longer than `maxBits`, and always a complete code
 * (inflaters reject an incomplete one). At least two symbols get a code, as zlib also arranges.
 */
function codeLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const lens = new Uint8Array(freq.length);
  const syms: number[] = [];
  for (let i = 0; i < freq.length; i++) if (freq[i]) syms.push(i);
  for (let i = 0; syms.length < 2; i++) if (!freq[i]) syms.push(i);
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const m = syms.length;
  // The Huffman tree by the two-queue method: leaves in order of weight, then the nodes made from them.
  const weight = new Float64Array(2 * m - 1), parent = new Int32Array(2 * m - 1);
  for (let i = 0; i < m; i++) weight[i] = freq[syms[i]] || 1;
  let leaf = 0, node = m;
  for (let next = m; next < 2 * m - 1; next++) {
    let w = 0;
    for (let k = 0; k < 2; k++) {
      const pick = leaf < m && (node >= next || weight[leaf] <= weight[node]) ? leaf++ : node++;
      w += weight[pick]; parent[pick] = next;
    }
    weight[next] = w;
  }
  const depth = new Int32Array(2 * m - 1);
  const count = new Int32Array(maxBits + 1);
  let kraft = 0;
  for (let i = 2 * m - 3; i >= 0; i--) { depth[i] = depth[parent[i]] + 1; if (i < m) { const d = Math.min(depth[i], maxBits); count[d]++; kraft += 2 ** (maxBits - d); } }
  // Too-deep leaves were cut to maxBits, which oversubscribes the code. Each step moves a leaf from the
  // deepest shorter level one level down and pairs it with a leaf taken from maxBits, which frees exactly one slot.
  for (; kraft > 2 ** maxBits; kraft--) {
    let bits = maxBits - 1;
    while (!count[bits]) bits--;
    count[bits]--; count[bits + 1] += 2; count[maxBits]--;
  }
  // The rarest symbols get the longest codes.
  for (let bits = maxBits, i = 0; bits >= 1; bits--) for (let k = count[bits]; k > 0; k--) lens[syms[i++]] = bits;
  return lens;
}

/** Canonical codes for the lengths, bit-reversed so they can be written least significant bit first. */
function canonicalCodes(lens: Uint8Array): Uint16Array {
  const count = new Uint16Array(16), next = new Uint16Array(16);
  for (let i = 0; i < lens.length; i++) count[lens[i]]++;
  count[0] = 0;
  for (let bits = 1, code = 0; bits < 16; bits++) { code = (code + count[bits - 1]) << 1; next[bits] = code; }
  const codes = new Uint16Array(lens.length);
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i];
    if (!l) continue;
    let c = next[l]++, r = 0;
    for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    codes[i] = r;
  }
  return codes;
}
const FIXED_LIT_CODE = canonicalCodes(FIXED_LIT_LEN), FIXED_DIST_CODE = canonicalCodes(FIXED_DIST_LEN);

class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private acc = 0;
  private n = 0;
  private room(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    const grown = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }
  /** Up to 16 bits, least significant first. */
  bits(v: number, count: number): void {
    this.acc |= v << this.n; this.n += count;
    if (this.n >= 8) { this.room(3); while (this.n >= 8) { this.buf[this.len++] = this.acc & 255; this.acc >>>= 8; this.n -= 8; } }
  }
  align(): void { if (this.n) { this.room(1); this.buf[this.len++] = this.acc & 255; this.acc = 0; this.n = 0; } }
  byte(b: number): void { this.align(); this.room(1); this.buf[this.len++] = b & 255; }
  raw(b: Uint8Array): void { this.align(); this.room(b.length); this.buf.set(b, this.len); this.len += b.length; }
  bytes(): Uint8Array { this.align(); return this.buf.slice(0, this.len); }
}

/**
 * Writes one DEFLATE block for `n` tokens (a literal byte, or a match length with its distance) that stand
 * for data[from, to), in whichever form is smallest: dynamic Huffman codes, the fixed codes, or stored.
 */
function writeBlock(w: BitWriter, lit: Uint16Array, dist: Uint16Array, n: number, final: boolean, data: Uint8Array, from: number, to: number): void {
  const lf = new Uint32Array(286), df = new Uint32Array(30);
  let extra = 0;
  for (let i = 0; i < n; i++) {
    if (dist[i]) { const ls = LEN_SYM[lit[i]], ds = DIST_SYM[dist[i]]; lf[257 + ls]++; df[ds]++; extra += LEN_EXTRA[ls] + DIST_EXTRA[ds]; }
    else lf[lit[i]]++;
  }
  lf[256] = 1;
  const ll = codeLengths(lf, 15), dl = codeLengths(df, 15);
  let nl = 286; while (nl > 257 && !ll[nl - 1]) nl--;
  let nd = 30; while (nd > 1 && !dl[nd - 1]) nd--;
  // The two length tables as one run-length coded sequence (codes 16–18 repeat a length or zeros).
  const seq = new Uint8Array(nl + nd); seq.set(ll.subarray(0, nl)); seq.set(dl.subarray(0, nd), nl);
  const rle: number[] = []; // symbol, extra value, extra bit count
  const cf = new Uint32Array(19);
  for (let i = 0; i < seq.length;) {
    const v = seq[i];
    let run = 1; while (i + run < seq.length && seq[i + run] === v) run++;
    i += run;
    if (v === 0) {
      while (run >= 11) { const r = Math.min(run, 138); rle.push(18, r - 11, 7); cf[18]++; run -= r; }
      if (run >= 3) { rle.push(17, run - 3, 3); cf[17]++; run = 0; }
    } else {
      rle.push(v, 0, 0); cf[v]++; run--;
      while (run >= 3) { const r = Math.min(run, 6); rle.push(16, r - 3, 2); cf[16]++; run -= r; }
    }
    for (; run > 0; run--) { rle.push(v, 0, 0); cf[v]++; }
  }
  const cl = codeLengths(cf, 7);
  let nc = 19; while (nc > 4 && !cl[CLEN_ORDER[nc - 1]]) nc--;
  let dynBits = 3 + 14 + 3 * nc + extra, fixBits = 3 + extra;
  for (let i = 0; i < rle.length; i += 3) dynBits += cl[rle[i]] + rle[i + 2];
  for (let i = 0; i < 286; i++) { dynBits += lf[i] * ll[i]; fixBits += lf[i] * FIXED_LIT_LEN[i]; }
  for (let i = 0; i < 30; i++) { dynBits += df[i] * dl[i]; fixBits += df[i] * 5; }
  const storedBits = (to - from) * 8 + 40 * Math.max(1, Math.ceil((to - from) / 65535)) + 7;
  if (storedBits < dynBits && storedBits < fixBits) {
    for (let at = from; ;) {
      const len = Math.min(65535, to - at);
      w.bits(final && at + len >= to ? 1 : 0, 1); w.bits(0, 2); w.align();
      w.byte(len & 255); w.byte(len >> 8); w.byte(~len & 255); w.byte((~len >> 8) & 255);
      w.raw(data.subarray(at, at + len));
      at += len;
      if (at >= to) break;
    }
    return;
  }
  const dynamic = dynBits < fixBits;
  w.bits(final ? 1 : 0, 1); w.bits(dynamic ? 2 : 1, 2);
  let lc = FIXED_LIT_CODE, dc = FIXED_DIST_CODE, llen: Uint8Array = FIXED_LIT_LEN, dlen: Uint8Array = FIXED_DIST_LEN;
  if (dynamic) {
    w.bits(nl - 257, 5); w.bits(nd - 1, 5); w.bits(nc - 4, 4);
    for (let i = 0; i < nc; i++) w.bits(cl[CLEN_ORDER[i]], 3);
    const cc = canonicalCodes(cl);
    for (let i = 0; i < rle.length; i += 3) { w.bits(cc[rle[i]], cl[rle[i]]); if (rle[i + 2]) w.bits(rle[i + 1], rle[i + 2]); }
    lc = canonicalCodes(ll); dc = canonicalCodes(dl); llen = ll; dlen = dl;
  }
  for (let i = 0; i < n; i++) {
    if (dist[i]) {
      const ls = LEN_SYM[lit[i]], ds = DIST_SYM[dist[i]];
      w.bits(lc[257 + ls], llen[257 + ls]); if (LEN_EXTRA[ls]) w.bits(lit[i] - LEN_BASE[ls], LEN_EXTRA[ls]);
      w.bits(dc[ds], dlen[ds]); if (DIST_EXTRA[ds]) w.bits(dist[i] - DIST_BASE[ds], DIST_EXTRA[ds]);
    } else w.bits(lc[lit[i]], llen[lit[i]]);
  }
  w.bits(lc[256], llen[256]);
}

/**
 * zlib (RFC 1950) stream with DEFLATE data: LZ77 with hash chains, written in blocks that each use
 * dynamic Huffman codes, the fixed codes or no compression, whichever is smallest.
 */
export function deflateZlib(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.byte(0x78); w.byte(0x9c);
  const n = data.length;
  const BLOCK = 1 << 15;
  const lit = new Uint16Array(BLOCK), dist = new Uint16Array(BLOCK);
  let count = 0, blockStart = 0;
  const HASH = 1 << 15;
  const head = new Int32Array(HASH).fill(-1);
  const prevIdx = new Int32Array(n);
  const hashAt = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HASH - 1);
  let i = 0;
  while (i < n) {
    if (count === BLOCK) { writeBlock(w, lit, dist, count, false, data, blockStart, i); count = 0; blockStart = i; }
    let bestLen = 0, bestDist = 0;
    if (i + 2 < n) {
      const h = hashAt(i);
      let p = head[h];
      let chain = 0;
      while (p >= 0 && i - p <= 32768 && chain++ < 48) {
        if (data[p] === data[i] && data[p + 1] === data[i + 1] && data[p + 2] === data[i + 2]) {
          let l = 3;
          while (l < 258 && i + l < n && data[p + l] === data[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = i - p; if (l >= 258) break; }
        }
        p = prevIdx[p];
      }
      prevIdx[i] = head[h];
      head[h] = i;
    }
    if (bestLen >= 3) {
      lit[count] = bestLen; dist[count++] = bestDist;
      for (let k = 1; k < bestLen; k++) { const j = i + k; if (j + 2 < n) { const h = hashAt(j); prevIdx[j] = head[h]; head[h] = j; } }
      i += bestLen;
    } else { lit[count] = data[i]; dist[count++] = 0; i++; }
  }
  writeBlock(w, lit, dist, count, true, data, blockStart, n);
  const ad = adler32(data);
  w.byte((ad >>> 24) & 255); w.byte((ad >>> 16) & 255); w.byte((ad >>> 8) & 255); w.byte(ad & 255);
  return w.bytes();
}

/** Makes a Flate-compressed stream object from bytes (and extra dictionary entries). */
export function flateStream(data: Uint8Array, entries: Record<string, PdfObj> = {}, compress = true): PdfStream {
  const dict = new Dict(entries);
  const raw = compress ? deflateZlib(data) : data;
  if (compress) dict.set('Filter', Name.get('FlateDecode'));
  dict.set('Length', raw.length);
  const s = new PdfStream(dict, raw);
  s.decoded = data;
  return s;
}
