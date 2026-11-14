/**
 * ImmortalInflate: a DEFLATE decoder that never throws.
 *
 * Port of the decoder in socrtwo/wordrecovery-SF (web/app.js), which in turn came from
 * socrtwo/Universal-File-Repair-Tool. It returns every byte it managed to decode before
 * reaching bad data, and flags the result as corrupt. This version uses canonical Huffman
 * tables (count/symbol arrays) instead of a hash map, and unpacks the literal/length and
 * distance code lengths as one sequence as RFC 1951 requires.
 *
 * Optional resynchronization (not in the original): after a decode error, scan forward bit
 * by bit for the next dynamic-Huffman block header with complete codes whose output looks
 * like text, and continue from there. Back-references into the lost region are filled with
 * a placeholder byte. Data in later deflate blocks is recovered instead of discarded.
 */

export interface InflateResult {
  data: Uint8Array;
  isCorrupt: boolean;
  /** Number of damaged regions skipped by resynchronization. */
  gaps?: number;
}

export interface InflateOptions {
  resync?: boolean;
  /** Byte written for back-references into a lost region (default: space). */
  placeholder?: number;
  /** How far past a failure to search for the next block, in bits. */
  resyncWindowBits?: number;
  /**
   * Treat a block whose output stops looking like text as damaged (text parts only). Damaged
   * Huffman data often decodes "successfully" into garbage, so a decode error alone misses it.
   */
  validateText?: boolean;
  /**
   * The data is known to be damaged (CRC mismatch): reject stored and fixed-Huffman blocks and
   * incomplete codes, which compressors of text do not emit but desynchronized decoding does.
   */
  strictBlocks?: boolean;
  /** Stop after this many output bytes (the result is then flagged corrupt). For sniffing a header or bounding memory. */
  maxOutput?: number;
  /** Called at the start of each decoded block (diagnostics). */
  onBlock?: (bitPos: number, outLen: number) => void;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(u8: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Huffman { count: Uint16Array; symbol: Uint16Array; complete: boolean }

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Hard ceiling on output so a damaged stream cannot expand without bound. */
const MAX_OUT = 256 * 1024 * 1024;

function build(lengths: ArrayLike<number>, n: number): Huffman | null {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(n);
  const offs = new Uint16Array(16);
  for (let s = 0; s < n; s++) count[lengths[s] & 15]++;
  if (count[0] === n) return null;
  let left = 1;
  for (let len = 1; len < 16; len++) { left = (left << 1) - count[len]; if (left < 0) break; }
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let s = 0; s < n; s++) if (lengths[s]) symbol[offs[lengths[s] & 15]++] = s;
  return { count, symbol, complete: left === 0 };
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  return build(l, 288)!;
})();
const FIXED_DIST = build(new Uint8Array(30).fill(5), 30)!;

class Corrupt extends Error {}

class Bits {
  pos: number; buf = 0; cnt = 0;
  constructor(public src: Uint8Array, bitPos = 0) {
    this.pos = bitPos >>> 3;
    const r = bitPos & 7;
    if (r) { this.buf = (src[this.pos++] ?? 0) >>> r; this.cnt = 8 - r; }
  }
  bitPos(): number { return this.pos * 8 - this.cnt; }
  bits(n: number): number {
    while (this.cnt < n) {
      if (this.pos >= this.src.length) throw new Corrupt();
      this.buf |= this.src[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    const v = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return v;
  }
  decode(h: Huffman): number {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l < 16; l++) {
      code |= this.bits(1);
      const c = h.count[l];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Corrupt();
  }
  align(): void { this.buf = 0; this.cnt = 0; }
}

class Out {
  data = new Uint8Array(1 << 16);
  len = 0;
  /** Output index where the trustworthy window starts (after a resync). */
  windowStart = 0;
  /** True once a resync has dropped data: references before windowStart become placeholders. */
  lossy = false;
  constructor(public placeholder: number, initial: number, public limit = MAX_OUT) { this.data = new Uint8Array(Math.max(1024, Math.min(initial, 1 << 24, limit + 258))); }
  need(n: number): void {
    if (this.len + n > this.limit) throw new Corrupt();
    if (this.len + n <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(Math.min(size, this.limit));
    next.set(this.data.subarray(0, this.len));
    this.data = next;
  }
}

/** Decode one block. Returns BFINAL. Throws Corrupt on bad data. */
function block(s: Bits, o: Out, strict: boolean): number {
  const final = s.bits(1);
  const type = s.bits(2);
  if (type === 0) {
    if (strict) throw new Corrupt();
    s.align();
    if (s.pos + 4 > s.src.length) throw new Corrupt();
    const n = s.src[s.pos] | (s.src[s.pos + 1] << 8);
    s.pos += 4;
    const avail = Math.min(n, s.src.length - s.pos);
    o.need(avail);
    o.data.set(s.src.subarray(s.pos, s.pos + avail), o.len);
    o.len += avail; s.pos += avail;
    if (avail < n) throw new Corrupt();
    return final;
  }
  let lit: Huffman | null, dist: Huffman | null;
  if (type === 1) {
    if (strict) throw new Corrupt();
    lit = FIXED_LIT; dist = FIXED_DIST;
  } else if (type === 2) {
    const nlen = s.bits(5) + 257, ndist = s.bits(5) + 1, ncode = s.bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw new Corrupt();
    const cl = new Uint8Array(19);
    for (let i = 0; i < ncode; i++) cl[CLEN_ORDER[i]] = s.bits(3);
    const clh = build(cl, 19);
    if (!clh || (strict && !clh.complete)) throw new Corrupt();
    const lengths = new Uint8Array(nlen + ndist);
    let i = 0;
    while (i < nlen + ndist) {
      const sym = s.decode(clh);
      if (sym < 16) { lengths[i++] = sym; continue; }
      let rep = 0, val = 0;
      if (sym === 16) { if (i === 0) throw new Corrupt(); val = lengths[i - 1]; rep = 3 + s.bits(2); }
      else if (sym === 17) rep = 3 + s.bits(3);
      else rep = 11 + s.bits(7);
      if (i + rep > nlen + ndist) throw new Corrupt();
      while (rep--) lengths[i++] = val;
    }
    if (strict && !lengths[256]) throw new Corrupt();
    lit = build(lengths.subarray(0, nlen), nlen);
    dist = build(lengths.subarray(nlen), ndist);
    if (strict && (!lit || !lit.complete || (dist && !dist.complete && ndist > 1))) throw new Corrupt();
  } else throw new Corrupt();
  if (!lit) throw new Corrupt();
  for (;;) {
    const sym = s.decode(lit);
    if (sym < 256) { o.need(1); o.data[o.len++] = sym; continue; }
    if (sym === 256) return final;
    const lc = sym - 257;
    if (lc > 28 || !dist) throw new Corrupt();
    const n = LEN_BASE[lc] + s.bits(LEN_EXTRA[lc]);
    const dc = s.decode(dist);
    if (dc > 29) throw new Corrupt();
    const d = DIST_BASE[dc] + s.bits(DIST_EXTRA[dc]);
    o.need(n);
    let from = o.len - d;
    if (from < o.windowStart || from < 0) {
      if (!o.lossy) throw new Corrupt();
      // Reference into data lost before the resync point.
      for (let k = 0; k < n; k++, from++) o.data[o.len++] = from >= o.windowStart ? o.data[from] : o.placeholder;
      continue;
    }
    for (let k = 0; k < n; k++) o.data[o.len++] = o.data[from++];
  }
}

const isTextByte = (c: number) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0x80;

/** First 64-byte window in [from, to) that is mostly non-text, or -1. */
function firstBadWindow(u8: Uint8Array, from: number, to: number): number {
  for (let w = from; w + 64 <= to; w += 32) {
    let bad = 0;
    for (let i = w; i < w + 64; i++) if (!isTextByte(u8[i])) bad++;
    if (bad > 6) return w;
  }
  return -1;
}

function looksLikeText(u8: Uint8Array, from: number, to: number): boolean {
  const n = to - from;
  if (n < 256) return false;
  let ok = 0;
  for (let i = from; i < to; i++) { const c = u8[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc2) ok++; }
  return ok / n > 0.97;
}

export function immortalInflate(input: Uint8Array, opts: InflateOptions = {}): InflateResult {
  const o = new Out(opts.placeholder ?? 0x20, input.length * 4, Math.max(1, Math.min(MAX_OUT, opts.maxOutput ?? MAX_OUT)));
  let s = new Bits(input);
  let corrupted = false, gaps = 0;
  const totalBits = input.length * 8;
  for (;;) {
    // The damage can sit anywhere in the failing block (bad codes often decode as valid
    // symbols for a while), so the search for the next block starts at the failing block's start.
    let failedAt = -1, blockStart = s.bitPos();
    try {
      for (;;) {
        blockStart = s.bitPos();
        opts.onBlock?.(blockStart, o.len);
        const outStart = o.len;
        const fin = block(s, o, !!opts.strictBlocks);
        if (opts.validateText) {
          const bad = firstBadWindow(o.data, outStart, o.len);
          if (bad >= 0) { o.len = Math.max(outStart, bad); throw new Corrupt(); }
        }
        if (fin) break;
      }
      break;
    } catch {
      corrupted = true;
      failedAt = blockStart;
    }
    if (!opts.resync || failedAt < 0) break;
    // Resynchronize: look for the next plausible dynamic block after the failure.
    const limit = Math.min(totalBits - 64, failedAt + (opts.resyncWindowBits ?? 1 << 21));
    const keep = o.len;
    let found = false, fin = 0;
    for (let b = failedAt + 1; b < limit; b++) {
      // Fast pre-checks on BTYPE=10, HLIT and HDIST before a full header parse.
      const at = b >>> 3;
      const v = (input[at] | (input[at + 1] << 8) | (input[at + 2] << 16)) >>> (b & 7);
      if (((v >>> 1) & 3) !== 2 || ((v >>> 3) & 31) > 29 || ((v >>> 8) & 31) > 29) continue;
      const t = new Bits(input, b);
      o.len = keep;
      o.windowStart = keep;
      o.lossy = true;
      try { fin = block(t, o, true); } catch { continue; }
      if (!looksLikeText(o.data, keep, o.len) || (opts.validateText && firstBadWindow(o.data, keep, o.len) >= 0)) continue;
      gaps++;
      found = true;
      s = t;
      break;
    }
    if (!found) { o.len = keep; break; }
    if (fin) break;
  }
  return { data: o.data.slice(0, o.len), isCorrupt: corrupted, gaps };
}
