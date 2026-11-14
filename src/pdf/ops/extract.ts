/**
 * Extraction from the object graph: page text (the engine's own decoder, for environments without
 * the renderer), images (JPEG as is, Flate raster as RGB/gray samples), attachments, and tables from
 * positioned text (column clustering).
 */
import { Dict, PdfObj, PdfStream, PdfString, isName, Name } from '../objects';
import { PdfDocument } from '../document';
import { parseContent, analyzeContent, TextRun } from '../content';
import { listImages, ImageInfo } from './optimize';

export interface PositionedText { text: string; x: number; y: number; w: number; h: number; size: number }

/** Positioned text runs of a page from the engine (top-left origin, points). */
export function pageTextRuns(doc: PdfDocument, index: number): PositionedText[] {
  const p = doc.pages[index];
  if (!p) return [];
  const info = analyzeContent(doc, parseContent(doc.pageContent(p)), p.resources);
  // Positions are those of the page as displayed: a page turned by /Rotate reads in its turned order.
  const [x0, y0, x1, y1] = p.cropBox;
  const show = (x: number, y: number): [number, number] => (p.rotate === 90 ? [y - y0, x1 - x] : p.rotate === 180 ? [x1 - x, y1 - y] : p.rotate === 270 ? [y1 - y, x - x0] : [x - x0, y - y0]);
  return info.runs.filter((r) => r.text.trim()).map((r: TextRun) => {
    const a = show(r.box[0], r.box[1]), b = show(r.box[2], r.box[3]);
    const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]), bottom = Math.min(a[1], b[1]), up = Math.max(a[1], b[1]);
    return { text: r.text, x: left, y: p.height - up, w: right - left, h: up - bottom, size: r.size };
  });
}

/** Lines of text, in reading order, from positioned runs (works for the engine's and the renderer's runs). */
export function linesFromRuns(runs: PositionedText[]): string[] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PositionedText[][] = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - r.y) < Math.max(2, Math.min(last[0].h, r.h) * 0.5)) last.push(r); else lines.push([r]);
  }
  return lines.map((l) => { l.sort((a, b) => a.x - b.x); let s = ''; let endX = -Infinity; for (const r of l) { if (s && r.x - endX > r.h * 0.2) s += ' '; s += r.text; endX = r.x + r.w; } return s.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
}

export function pageText(doc: PdfDocument, index: number): string { return linesFromRuns(pageTextRuns(doc, index)).join('\n'); }

/** Markdown-ish text: lines in a larger-than-median font become headings. */
export function textToMarkdown(pages: PositionedText[][]): string {
  const out: string[] = [];
  const sizes = pages.flat().map((r) => r.size).filter((s) => s > 0).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] || 10;
  pages.forEach((runs, i) => {
    const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: PositionedText[][] = [];
    for (const r of sorted) { const last = lines[lines.length - 1]; if (last && Math.abs(last[0].y - r.y) < Math.max(2, r.h * 0.5)) last.push(r); else lines.push([r]); }
    let para = '';
    for (const l of lines) {
      l.sort((a, b) => a.x - b.x);
      const text = l.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const size = Math.max(...l.map((r) => r.size));
      if (size >= median * 1.6) { if (para) out.push(para, ''); para = ''; out.push(`# ${text}`, ''); }
      else if (size >= median * 1.25) { if (para) out.push(para, ''); para = ''; out.push(`## ${text}`, ''); }
      else para = para ? `${para} ${text}` : text;
      if (/[.!?:]$/.test(text) && para === text) { /* keep accumulating */ }
    }
    if (para) out.push(para, '');
    if (i < pages.length - 1) out.push('---', '');
  });
  return out.join('\n');
}

/**
 * Detects tables on a page. Runs on one line that sit close together form one cell; a table is a
 * block of consecutive lines with two or more cells whose cell starts line up in at least two
 * columns. Ordinary paragraphs (one cell per line, or cells that do not align) are not tables.
 */
export function tablesFromRuns(runs: PositionedText[]): string[][][] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PositionedText[][] = [];
  for (const r of sorted) { const last = lines[lines.length - 1]; if (last && Math.abs(last[0].y - r.y) < Math.max(2, r.h * 0.5)) last.push(r); else lines.push([r]); }
  const rows = lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    const cells: { x: number; text: string }[] = [];
    let end = -Infinity;
    for (const r of line) {
      const gap = r.x - end;
      // A gap wider than a generous word space starts a new cell.
      if (!cells.length || gap > Math.max(9, r.h * 1.2)) cells.push({ x: r.x, text: r.text });
      else cells[cells.length - 1].text += (gap > r.h * 0.2 ? ' ' : '') + r.text;
      end = Math.max(end, r.x + r.w);
    }
    return cells;
  });
  const tables: string[][][] = [];
  let cur: { x: number; text: string }[][] = [];
  const flush = () => {
    if (cur.length >= 2) {
      // Column boundaries: cluster cell starts.
      const xs = cur.flat().map((c) => c.x).sort((a, b) => a - b);
      const cols: number[] = [];
      for (const x of xs) if (!cols.length || x - cols[cols.length - 1] > 12) cols.push(x);
      const colOf = (x: number) => { let c = 0; for (let i = 0; i < cols.length; i++) if (x + 6 >= cols[i]) c = i; return c; };
      const hits = new Array(cols.length).fill(0);
      for (const row of cur) for (const c of new Set(row.map((cell) => colOf(cell.x)))) hits[c]++;
      if (hits.filter((h) => h >= 2).length >= 2) tables.push(cur.map((row) => { const cells = new Array(cols.length).fill(''); for (const cell of row) { const c = colOf(cell.x); cells[c] = (cells[c] ? cells[c] + ' ' : '') + cell.text.replace(/\s+/g, ' ').trim(); } return cells; }));
    }
    cur = [];
  };
  for (const row of rows) { if (row.length >= 2) cur.push(row); else flush(); }
  flush();
  return tables;
}

export function toCsv(table: string[][]): string { return table.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n'; }

export interface ExtractedImage { info: ImageInfo; kind: 'jpeg' | 'jp2' | 'raw' | 'unsupported'; data: Uint8Array; components: number; width: number; height: number; bpc: number }

type ColorModel = 'gray' | 'rgb' | 'cmyk' | 'lab' | 'tint' | 'indexed' | 'mask';
interface ColorInfo { model: ColorModel | null; comps: number; /** Indexed: the base space and the lookup table. */ base?: ColorInfo; palette?: Uint8Array; /** Lab: white point and the range of a and b. */ white?: number[]; range?: number[] }

/** What the engine knows about a colour space: its model and component count (model null: not convertible here). */
function colorInfo(doc: PdfDocument, cs: PdfObj | undefined, depth = 0): ColorInfo {
  const v = doc.resolve<PdfObj>(cs);
  const name = isName(v) ? v.name : Array.isArray(v) && isName(doc.resolve<PdfObj>(v[0])) ? (doc.resolve<PdfObj>(v[0]) as Name).name : '';
  const arr = Array.isArray(v) ? v : [];
  switch (name) {
    case 'DeviceGray': case 'G': case 'CalGray': return { model: 'gray', comps: 1 };
    case 'DeviceRGB': case 'RGB': case 'CalRGB': return { model: 'rgb', comps: 3 };
    case 'DeviceCMYK': case 'CMYK': return { model: 'cmyk', comps: 4 };
    case 'ICCBased': { const st = doc.resolve<PdfObj>(arr[1]); const n = st instanceof PdfStream ? doc.getNum(st, 'N', 3) : 3; return n === 1 ? { model: 'gray', comps: 1 } : n === 4 ? { model: 'cmyk', comps: 4 } : n === 3 ? { model: 'rgb', comps: 3 } : { model: null, comps: n }; }
    case 'Lab': { const d = doc.resolve<PdfObj>(arr[1]); const nums = (k: string, def: number[]) => { const a = d instanceof Dict ? doc.getArray(d, k) : null; const out = (a || []).map((x) => doc.resolve<PdfObj>(x)).filter((x): x is number => typeof x === 'number'); return out.length === def.length ? out : def; }; return { model: 'lab', comps: 3, white: nums('WhitePoint', [0.9642, 1, 0.8249]), range: nums('Range', [-100, 100, -100, 100]) }; }
    // One ink: the tint is how much ink, so 0 is paper. The ink's own colour is not looked up; it is shown as black.
    case 'Separation': return { model: 'tint', comps: 1 };
    case 'DeviceN': { const names = doc.resolve<PdfObj>(arr[1]); const n = Array.isArray(names) ? names.length : 0; return n === 1 ? { model: 'tint', comps: 1 } : { model: null, comps: n || 1 }; }
    case 'Indexed': case 'I': {
      if (depth > 2) return { model: null, comps: 1 };
      const base = colorInfo(doc, arr[1], depth + 1);
      const lookup = doc.resolve<PdfObj>(arr[3]);
      const palette = lookup instanceof PdfStream ? doc.decoded(lookup) : lookup instanceof PdfString ? lookup.bytes : undefined;
      return { model: base.model && base.model !== 'indexed' && palette ? 'indexed' : null, comps: 1, base, palette };
    }
    default: return { model: null, comps: 1 };
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Components in 0..1 (Lab: L* 0..100 and a*, b* in their range) → sRGB 0..255. */
function toRgb(ci: ColorInfo, c: number[]): [number, number, number] {
  if (ci.model === 'gray') return [c[0] * 255, c[0] * 255, c[0] * 255];
  if (ci.model === 'tint') return [(1 - c[0]) * 255, (1 - c[0]) * 255, (1 - c[0]) * 255];
  if (ci.model === 'rgb') return [c[0] * 255, c[1] * 255, c[2] * 255];
  if (ci.model === 'cmyk') return [255 * (1 - c[0]) * (1 - c[3]), 255 * (1 - c[1]) * (1 - c[3]), 255 * (1 - c[2]) * (1 - c[3])];
  if (ci.model === 'lab') {
    // CIE L*a*b* → XYZ (relative to the space's white) → linear sRGB (D50 matrix) → gamma.
    const w = ci.white!, fy = (c[0] + 16) / 116, fx = fy + c[1] / 500, fz = fy - c[2] / 200;
    const g = (t: number) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
    const X = w[0] * g(fx), Y = w[1] * g(fy), Z = w[2] * g(fz);
    const lin = [3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z, -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z, 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z];
    const out = lin.map((v) => 255 * clamp01(v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    return [out[0], out[1], out[2]];
  }
  return [0, 0, 0];
}

/** Raw bytes of an image: JPEG/JPX files directly; Flate/uncompressed samples as 'raw'. */
export function extractImage(doc: PdfDocument, info: ImageInfo): ExtractedImage {
  const r = doc.decode(info.stream);
  const mask = doc.get(info.stream, 'ImageMask') === true;
  const ci = colorInfo(doc, info.stream.dict.get('ColorSpace'));
  const components = mask ? 1 : ci.comps;
  const bpc = mask ? 1 : info.bpc;
  if (r.imageFilter === 'DCTDecode') return { info, kind: 'jpeg', data: r.data, components, width: info.width, height: info.height, bpc: 8 };
  if (r.imageFilter === 'JPXDecode') return { info, kind: 'jp2', data: r.data, components, width: info.width, height: info.height, bpc: 8 };
  if (r.imageFilter) return { info, kind: 'unsupported', data: r.data, components, width: info.width, height: info.height, bpc };
  return { info, kind: 'raw', data: r.data, components, width: info.width, height: info.height, bpc };
}

/**
 * Expands raw samples to RGBA bytes for a canvas: gray, RGB, CMYK, Lab, single-ink (Separation) and
 * indexed images at 1–16 bits per component, /Decode arrays, stencil masks (painted pixels black,
 * the rest transparent) and soft masks. Null for colour spaces the engine cannot convert (several
 * inks, patterns) and for sizes that make no sense.
 */
export function rawToRgba(doc: PdfDocument, ex: ExtractedImage): Uint8ClampedArray | null {
  const { width: w, height: h, data } = ex;
  if (ex.kind !== 'raw') return null;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) || w * h > 120_000_000) return null;
  const st = ex.info.stream;
  const mask = doc.get(st, 'ImageMask') === true;
  const ci: ColorInfo = mask ? { model: 'mask', comps: 1 } : colorInfo(doc, st.dict.get('ColorSpace'));
  if (!ci.model) return null;
  const bpc = mask ? 1 : ex.bpc;
  if (![1, 2, 4, 8, 16].includes(bpc)) return null;
  const comps = ci.comps;
  const rowBytes = Math.ceil((w * comps * bpc) / 8);
  const max = 2 ** bpc - 1;
  const sample = (row: number, i: number): number => {
    if (bpc === 8) return data[row * rowBytes + i] ?? 0;
    if (bpc === 16) return ((data[row * rowBytes + i * 2] ?? 0) << 8) | (data[row * rowBytes + i * 2 + 1] ?? 0);
    const bit = i * bpc; const byte = data[row * rowBytes + (bit >> 3)] ?? 0;
    return (byte >> (8 - bpc - (bit & 7))) & max;
  };
  // /Decode maps the sample range onto each component's range; the default depends on the colour space.
  const dec = (doc.getArray(st, 'Decode') || []).map((x) => doc.resolve<PdfObj>(x)).filter((x): x is number => typeof x === 'number');
  const lab = ci.model === 'lab' ? [0, 100, ci.range![0], ci.range![1], ci.range![2], ci.range![3]] : null;
  const lo = (k: number) => (dec.length >= comps * 2 ? dec[k * 2] : lab ? lab[k * 2] : ci.model === 'indexed' ? 0 : 0);
  const hi = (k: number) => (dec.length >= comps * 2 ? dec[k * 2 + 1] : lab ? lab[k * 2 + 1] : ci.model === 'indexed' ? max : 1);
  const out = new Uint8ClampedArray(w * h * 4);
  const c: number[] = new Array(comps).fill(0);
  const base = ci.base, pal = ci.palette, pc = base ? base.comps : 0, pv: number[] = new Array(pc).fill(0);
  const baseLab = base && base.model === 'lab' ? [0, 100, base.range![0], base.range![1], base.range![2], base.range![3]] : null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (let k = 0; k < comps; k++) c[k] = lo(k) + (sample(y, x * comps + k) * (hi(k) - lo(k))) / max;
    if (ci.model === 'mask') { out[o + 3] = c[0] < 0.5 ? 255 : 0; continue; } // 0 paints (with the default /Decode)
    let rgb: [number, number, number];
    if (ci.model === 'indexed' && base && pal) {
      const idx = Math.max(0, Math.round(c[0])) * pc;
      for (let k = 0; k < pc; k++) { const b = (pal[idx + k] ?? 0) / 255; pv[k] = baseLab ? baseLab[k * 2] + b * (baseLab[k * 2 + 1] - baseLab[k * 2]) : b; }
      rgb = toRgb(base, pv);
    } else rgb = toRgb(ci, c);
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = 255;
  }
  // Soft mask → alpha
  const sm = doc.get(st, 'SMask');
  if (sm instanceof PdfStream) {
    try {
      const smd = doc.decode(sm);
      const sw = doc.getNum(sm, 'Width'), sh = doc.getNum(sm, 'Height'), sb = doc.getNum(sm, 'BitsPerComponent', 8);
      if (!smd.imageFilter && sw === w && sh === h && sb === 8) for (let i = 0; i < w * h; i++) out[i * 4 + 3] = smd.data[i] ?? 255;
    } catch { /* keep opaque */ }
  }
  return out;
}

export { listImages };
export const imageName = (im: ImageInfo, i: number): string => `image-${i + 1}-page-${im.page + 1}${im.filter.includes('DCT') ? '.jpg' : im.filter.includes('JPX') ? '.jp2' : '.png'}`;
export const N = Name.get;
