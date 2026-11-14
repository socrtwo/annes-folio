/**
 * Minimal baseline TIFF reader that converts the images of a file to 24-bit BMPs, which every
 * browser can display (TIFF is only shown natively by Safari). Supports 8-bit grey, palette and
 * RGB(A) images and 1-bit bilevel images, in strips, uncompressed, PackBits or LZW (with or without
 * the horizontal predictor), chunky planar configuration, every page (IFD) of the file. Anything
 * else — tiles, CMYK, YCbCr, 16-bit samples, fax and JPEG compression — is reported as unsupported
 * rather than decoded wrongly. Everything read from the file is bounded by the file's own length.
 */

export interface TiffPage { width: number; height: number; /** Pixels per inch from the resolution tags, when the file states one. */ dpi: number | null; /** Decodes the page to a BMP when asked (pages are large); null when it uses a feature this reader does not decode. */ bmp: () => Uint8Array | null }
export interface TiffResult { /** The pages whose directories were read (at most `maxPages`). */ pages: TiffPage[]; /** Pages (IFDs) in the file, as far as the chain was followed. */ total: number }

/** The first image as a BMP, or null when the file is not a TIFF or its first page is not decodable here. */
export function tiffToBmp(u8: Uint8Array): Uint8Array | null {
  const r = decodeTiff(u8, 1);
  return r && r.pages.length ? r.pages[0].bmp() : null;
}

const MAX_PIXELS = 40_000_000;
/** Tags the decoder uses; every other directory entry is skipped unread. */
const WANTED = new Set([256, 257, 258, 259, 262, 266, 273, 277, 278, 279, 282, 284, 296, 317, 320, 322, 323, 324, 325, 338]);
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 6: 1, 7: 1, 3: 2, 8: 2, 4: 4, 9: 4, 13: 4, 5: 8, 10: 8 };

/** Reads the directories of up to `maxPages` pages (their pixels are decoded on demand). Null when the bytes are not a TIFF at all. */
export function decodeTiff(u8: Uint8Array, maxPages = 500): TiffResult | null {
  if (u8.length < 8) return null;
  const le = u8[0] === 0x49 && u8[1] === 0x49;
  if (!le && !(u8[0] === 0x4d && u8[1] === 0x4d)) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = u8.length;
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  if (u16(2) !== 42) return null;
  const out: TiffResult = { pages: [], total: 0 };
  const seen = new Set<number>();
  // All directories together may read a few values per byte of the file, no more: a small file that
  // declares millions of values in thousands of directories is cut off.
  let budget = 8 * len + 4096;
  let ifd = u32(4);
  // A directory chain is followed at most 4096 links and never twice through the same offset.
  for (let guard = 0; guard < 4096 && ifd >= 8 && ifd + 2 <= len && !seen.has(ifd); guard++) {
    seen.add(ifd);
    const n = Math.min(u16(ifd), Math.floor((len - ifd - 2) / 12));
    const tags = new Map<number, number[]>();
    const decode = out.pages.length < maxPages;
    for (let k = 0; decode && k < n; k++) {
      const e = ifd + 2 + k * 12;
      const tag = u16(e), type = u16(e + 2), size = TYPE_SIZE[type];
      if (!WANTED.has(tag) || tags.has(tag) || !size) continue;
      let count = u32(e + 4);
      const base = size * count <= 4 ? e + 8 : u32(e + 8);
      if (base >= len) continue;
      count = Math.min(count, Math.floor((len - base) / size), budget); // values cannot lie beyond the file
      budget -= count;
      const vals: number[] = new Array(count);
      for (let i = 0; i < count; i++) {
        const p = base + i * size;
        vals[i] = size === 1 ? u8[p] : size === 2 ? u16(p) : size === 4 ? u32(p) : u32(p + 4) ? u32(p) / u32(p + 4) : 0;
      }
      tags.set(tag, vals);
    }
    out.total++;
    if (decode) {
      const g = (t: number, d: number) => tags.get(t)?.[0] ?? d;
      const res = g(282, 0), unit = g(296, 2);
      const dpi = res > 0 && unit === 2 ? res : res > 0 && unit === 3 ? res * 2.54 : null;
      out.pages.push({ width: g(256, 0), height: g(257, 0), dpi: dpi && dpi >= 20 && dpi <= 4800 ? dpi : null, bmp: () => { try { return decodePage(u8, tags); } catch { return null; } } });
    }
    const nextAt = ifd + 2 + n * 12;
    ifd = nextAt + 4 <= len ? u32(nextAt) : 0;
  }
  return out;
}

/** One page as a bottom-up 24-bit BMP, or null when it uses something this reader does not decode. */
function decodePage(u8: Uint8Array, tags: Map<number, number[]>): Uint8Array | null {
  const g = (t: number, d: number) => tags.get(t)?.[0] ?? d;
  const w = g(256, 0), h = g(257, 0);
  if (!w || !h || w * h > MAX_PIXELS) return null;
  if (tags.has(322) || tags.has(323) || tags.has(324) || tags.has(325)) return null; // tiled
  const bps = tags.get(258) || [1];
  const comp = g(259, 1), photo = g(262, 1), spp = g(277, 1), rps = g(278, h) || h, planar = g(284, 1), pred = g(317, 1);
  if (![1, 5, 32773].includes(comp) || spp < 1 || spp > 4 || (planar !== 1 && spp > 1)) return null;
  const bits = bps[0];
  if (bps.some((b) => b !== bits) || !(bits === 8 || (bits === 1 && spp === 1))) return null;
  if (bits === 1 && g(266, 1) !== 1) return null; // reversed bit order
  const map = tags.get(320);
  // Photometric interpretations with their sample counts: bilevel/grey (± one extra), RGB (± alpha), palette.
  if (photo === 0 || photo === 1) { if (spp > 2) return null; }
  else if (photo === 2) { if (spp < 3 || bits !== 8) return null; }
  else if (photo === 3) { if (spp !== 1 || bits !== 8 || !map || map.length < 3) return null; }
  else return null; // CMYK, YCbCr, Lab, masks…
  const offsets = tags.get(273) || [], counts = tags.get(279) || [];
  if (!offsets.length) return null;
  const rowBytes = Math.ceil((w * spp * bits) / 8);
  const raw = new Uint8Array(rowBytes * h);
  let o = 0;
  for (let s = 0; s < offsets.length && o < raw.length; s++) {
    const start = offsets[s];
    if (start >= u8.length) return null;
    const strip = u8.subarray(start, counts[s] != null ? start + counts[s] : u8.length);
    const rows = Math.min(rps, h - Math.floor(o / rowBytes));
    const want = rows * rowBytes;
    const dec = comp === 1 ? strip : comp === 32773 ? packBits(strip, want) : lzw(strip, want);
    raw.set(dec.subarray(0, Math.min(want, raw.length - o)), o);
    o += want;
  }
  if (pred === 2 && bits === 8) {
    for (let y = 0; y < h; y++) for (let x = spp; x < w * spp; x++) raw[y * rowBytes + x] = (raw[y * rowBytes + x] + raw[y * rowBytes + x - spp]) & 255;
  }
  // Alpha: unassociated (2) is blended over white; associated (1) is already multiplied, so only the white is added.
  const extra = spp === 4 ? g(338, 0) : 0;
  const m = map ? Math.floor(map.length / 3) : 0;
  // 24-bit bottom-up BMP.
  const stride = Math.ceil((w * 3) / 4) * 4;
  const out = new Uint8Array(54 + stride * h);
  const ov = new DataView(out.buffer);
  out[0] = 0x42; out[1] = 0x4d;
  ov.setUint32(2, out.length, true); ov.setUint32(10, 54, true); ov.setUint32(14, 40, true);
  ov.setInt32(18, w, true); ov.setInt32(22, h, true); ov.setUint16(26, 1, true); ov.setUint16(28, 24, true);
  ov.setUint32(34, stride * h, true); ov.setInt32(38, 2835, true); ov.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * stride, r0 = y * rowBytes;
    for (let x = 0; x < w; x++) {
      let r: number, gg: number, b: number;
      if (bits === 1) { const bit = (raw[r0 + (x >> 3)] >> (7 - (x & 7))) & 1; r = gg = b = (photo === 0 ? 1 - bit : bit) * 255; }
      else {
        const i = r0 + x * spp;
        if (photo === 3 && map) { const k = raw[i]; r = (map[k] ?? 0) >> 8; gg = (map[m + k] ?? 0) >> 8; b = (map[2 * m + k] ?? 0) >> 8; }
        else if (photo === 2) {
          r = raw[i]; gg = raw[i + 1]; b = raw[i + 2];
          if (extra === 1 || extra === 2) { const a = raw[i + 3] / 255, white = 255 * (1 - a), f = extra === 2 ? a : 1; r = r * f + white; gg = gg * f + white; b = b * f + white; }
        } else r = gg = b = photo === 0 ? 255 - raw[i] : raw[i];
      }
      out[row + x * 3] = b; out[row + x * 3 + 1] = gg; out[row + x * 3 + 2] = r;
    }
  }
  return out;
}

function packBits(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want);
  let i = 0, o = 0;
  while (i < src.length && o < want) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < want; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < want; k++) out[o++] = v; }
  }
  return out;
}

function lzw(src: Uint8Array, want: number): Uint8Array {
  const out = new Uint8Array(want);
  let o = 0, bitPos = 0, width = 9;
  let dict: Uint8Array[] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push(Uint8Array.of(i)); dict.push(new Uint8Array(0), new Uint8Array(0)); width = 9; };
  reset();
  let prev: Uint8Array | null = null;
  const read = () => {
    let v = 0;
    for (let k = 0; k < width; k++) { const byte = src[(bitPos + k) >> 3] ?? 0; v = (v << 1) | ((byte >> (7 - ((bitPos + k) & 7))) & 1); }
    bitPos += width;
    return v;
  };
  while (bitPos + width <= src.length * 8 && o < want) {
    const code = read();
    if (code === 256) { reset(); prev = null; continue; }
    if (code === 257) break;
    let entry: Uint8Array;
    if (code < dict.length) entry = dict[code];
    else if (prev) { entry = new Uint8Array(prev.length + 1); entry.set(prev); entry[prev.length] = prev[0]; }
    else break;
    for (let k = 0; k < entry.length && o < want; k++) out[o++] = entry[k];
    // The table holds 4096 codes; a stream that never clears it cannot grow it further.
    if (prev && dict.length < 4096) { const ne = new Uint8Array(prev.length + 1); ne.set(prev); ne[prev.length] = entry[0]; dict.push(ne); }
    prev = entry;
    // Early change: the code width grows one code before the table fills.
    if (dict.length + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}
