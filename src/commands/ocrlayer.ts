/**
 * The recognized-text layer and scan clean-up math used by the Scan/OCR commands. No DOM and no commands
 * here, so all of it is unit-tested (tests/unit/fix-cmd1-scan.test.ts).
 *
 * The layer is invisible text (render mode 3) inside a /QuillFolioOCR marked-content block. Words that
 * fit WinAnsi are written in Helvetica; everything else (Cyrillic, Greek, CJK, Arabic, …) in a glyphless
 * Type0 font whose character codes are UTF-16 code units, with a ToUnicode CMap that maps them back.
 */
import type { PdfDocument, PageInfo } from '../pdf/document';
import { Dict, Name, PdfStream, PdfString, Ref, bytesOf, concat, isName, type PdfObj } from '../pdf/objects';
import { ensureFont } from '../pdf/build';
import { parseContent, serializeContent, type Op } from '../pdf/content';
import { textWidth, winAnsiBytes } from '../pdf/stdfonts';
import { deflateZlib } from '../pdf/filters';
import { pageRuns, type EditableRun } from '../pdf/ops/textedit';

/** A recognized word. x0…y1 is its box in PDF user space; ox/oy, dx/dy, w, h place it on rotated pages. */
export interface OcrWord {
  text: string; x0: number; y0: number; x1: number; y1: number; conf: number;
  /** Start of the word's bottom edge as displayed, and the unit direction it reads in (default: left to right along x). */
  ox?: number; oy?: number; dx?: number; dy?: number;
  /** Length along the reading direction and height across it (default: the box size). */
  w?: number; h?: number;
}

export const OCR_TAG = 'QuillFolioOCR';
export const OCR_FONT = 'QuillFolioGlyphless';
const OCR_FONT_RES = 'QFOcrU';
/** Advance of every glyph of the glyphless font, in 1/1000 em (per UTF-16 code unit). */
const OCR_DW = 500;

/** Maps a point of the rendered page (canvas pixels, y down) to PDF user space: pdf.js's viewport.convertToPdfPoint. */
export type ToPdf = (x: number, y: number) => number[];

const num = (v: number): string => { const s = (Math.round(v * 10000) / 10000).toString(); return s === '-0' ? '0' : s; };

/** True when every character has a WinAnsi code (so Helvetica can carry it). */
export function fitsWinAnsi(s: string): boolean {
  for (const ch of s) if (ch !== '?' && winAnsiBytes(ch)[0] === 63) return false;
  return true;
}

const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
/**
 * Text as the layer stores it, and back (the function is its own inverse). PDF readers expect a
 * right-to-left word in visual order (first letter at the right) and turn it around when extracting, so
 * a Hebrew or Arabic word is stored mirrored (digits and Latin letters in it keep their order). Characters outside the Basic Multilingual Plane
 * cannot be mapped back by a two-byte ToUnicode CMap in pdf.js or poppler and become U+FFFD.
 */
export function ocrLayerText(s: string): string {
  const cps = [...s].map((ch) => (ch.length > 1 ? '\uFFFD' : ch));
  if (!cps.some((ch) => RTL.test(ch))) return cps.join('');
  // Runs of digits and left-to-right letters keep their order inside; everything else is mirrored.
  const ltr = (ch: string) => /\p{Nd}/u.test(ch) || (/\p{L}/u.test(ch) && !RTL.test(ch));
  const runs: { ltr: boolean; chars: string[] }[] = [];
  for (const ch of cps) { const l = ltr(ch); const last = runs[runs.length - 1]; if (last && last.ltr === l) last.chars.push(ch); else runs.push({ ltr: l, chars: [ch] }); }
  return runs.reverse().map((r) => (r.ltr ? r.chars : r.chars.reverse()).join('')).join('');
}

const utf16Units = (s: string): number => s.length;
function utf16Hex(s: string): Uint8Array {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); b[i * 2] = c >> 8; b[i * 2 + 1] = c & 255; }
  return b;
}
const hexOf = (b: Uint8Array): string => { let s = '<'; for (const c of b) s += c.toString(16).padStart(2, '0'); return s + '>'; };
function lit(bytes: Uint8Array): string {
  let out = '(';
  for (const c of bytes) out += c === 0x28 || c === 0x29 || c === 0x5c ? '\\' + String.fromCharCode(c) : c < 32 || c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c);
  return out + ')';
}

/** ToUnicode CMap for codes that are UTF-16 code units: 256 ranges, one per high byte, as the CMap rules require. */
export function identityToUnicode(): string {
  const head = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  let body = '';
  for (let hi = 0; hi < 256; hi += 100) {
    const n = Math.min(100, 256 - hi);
    body += `${n} beginbfrange\n`;
    for (let k = hi; k < hi + n; k++) { const h = k.toString(16).toUpperCase().padStart(2, '0'); body += `<${h}00> <${h}FF> <${h}00>\n`; }
    body += 'endbfrange\n';
  }
  return head + body + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
}

const fontCache = new WeakMap<PdfDocument, Ref>();
const isOcrFont = (doc: PdfDocument, o: PdfObj | undefined): boolean => { const d = doc.resolve<PdfObj>(o); return d instanceof Dict && doc.getName(d, 'BaseFont') === OCR_FONT && doc.getName(d, 'Subtype') === 'Type0'; };

/** The document's glyphless Unicode font (one object shared by all pages), created when missing. */
export function ocrFontRef(doc: PdfDocument): Ref {
  const cached = fontCache.get(doc);
  if (cached && isOcrFont(doc, cached)) return cached;
  for (const p of doc.pages) {
    const fonts = p.resources ? doc.getDict(p.resources, 'Font') : null;
    if (!fonts) continue;
    for (const k of fonts.keys()) { const r = fonts.get(k); if (r instanceof Ref && isOcrFont(doc, r)) { fontCache.set(doc, r); return r; } }
  }
  const raw = deflateZlib(bytesOf(identityToUnicode()));
  const toUnicode = doc.register(new PdfStream(new Dict({ Filter: Name.get('FlateDecode'), Length: raw.length }), raw));
  const desc = doc.register(new Dict({ Type: Name.get('FontDescriptor'), FontName: Name.get(OCR_FONT), Flags: 4, FontBBox: [0, -250, OCR_DW, 750], ItalicAngle: 0, Ascent: 750, Descent: -250, CapHeight: 700, StemV: 80 }));
  const cid = doc.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('CIDFontType2'), BaseFont: Name.get(OCR_FONT), CIDSystemInfo: new Dict({ Registry: PdfString.fromText('Adobe'), Ordering: PdfString.fromText('Identity'), Supplement: 0 }), FontDescriptor: desc, DW: OCR_DW, CIDToGIDMap: Name.get('Identity') }));
  const ref = doc.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('Type0'), BaseFont: Name.get(OCR_FONT), Encoding: Name.get('Identity-H'), DescendantFonts: [cid], ToUnicode: toUnicode }));
  fontCache.set(doc, ref);
  return ref;
}

function ensureOcrFont(doc: PdfDocument, p: PageInfo): string {
  const res = doc.pageResources(p);
  let fonts = doc.getDict(res, 'Font');
  if (!fonts) { fonts = new Dict(); res.set('Font', fonts); }
  else if (!(res.get('Font') instanceof Dict)) { fonts = fonts.clone(); res.set('Font', fonts); }
  if (!isOcrFont(doc, fonts.get(OCR_FONT_RES))) fonts.set(OCR_FONT_RES, ocrFontRef(doc));
  if (p.ref) doc.touch(p.ref);
  return OCR_FONT_RES;
}

/** Natural width of a word at a size, in the font the layer would use for it. */
const naturalWidth = (text: string, size: number): number => (fitsWinAnsi(text) ? textWidth(text, 'Helvetica', size) : (utf16Units(text) * OCR_DW * size) / 1000) || 1;
const clampTz = (v: number): number => Math.max(1, Math.min(2000, v));

/**
 * A word box of the rendered page (canvas pixels) as an OcrWord in user space. Works for any page rotation
 * because it converts three corners instead of assuming the page is upright.
 */
export function wordFromCanvasBox(toPdf: ToPdf, box: { x0: number; y0: number; x1: number; y1: number }, text: string, conf = 0): OcrWord {
  const a = toPdf(box.x0, box.y1), b = toPdf(box.x1, box.y1), c = toPdf(box.x0, box.y0), d = toPdf(box.x1, box.y0);
  const w = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, h = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
  const xs = [a[0], b[0], c[0], d[0]], ys = [a[1], b[1], c[1], d[1]];
  return { text, conf, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), ox: a[0], oy: a[1], dx: (b[0] - a[0]) / w, dy: (b[1] - a[1]) / w, w, h };
}

/** The image matrix (a b c d e f for `cm`) that puts a rendering of the page back exactly where the page shows it. */
export function canvasPlacement(toPdf: ToPdf, width: number, height: number): [number, number, number, number, number, number] {
  const a = toPdf(0, height), b = toPdf(width, height), c = toPdf(0, 0);
  return [b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1], a[0], a[1]];
}

/**
 * Page content with its graphics state closed off: when the content leaves a `q` open or changes the
 * matrix outside any q…Q (scanner output such as "612 0 0 792 0 0 cm /Im0 Do"), it is wrapped so that
 * what is appended afterwards is drawn in plain page coordinates.
 */
export function isolatedContent(data: Uint8Array): Uint8Array {
  let depth = 0, leaks = false;
  try { for (const o of parseContent(data)) { if (o.op === 'q') depth++; else if (o.op === 'Q') depth = Math.max(0, depth - 1); else if (o.op === 'cm' && depth === 0) leaks = true; } }
  catch { leaks = true; }
  if (!leaks && depth === 0) return data;
  return concat([bytesOf('q\n'), data, bytesOf('\n' + 'Q\n'.repeat(depth + 1))]);
}

/** Writes words as invisible text (render mode 3) so the page becomes searchable and selectable. */
export function writeTextLayer(doc: PdfDocument, p: PageInfo, words: OcrWord[], lang: string): void {
  let helv = '', uni = '';
  const ops: string[] = [`/${OCR_TAG} BMC`, 'q BT 3 Tr 0 Tc 0 Tw 0 Ts'];
  for (const w of words) {
    if (!w.text) continue;
    const dx = w.dx ?? 1, dy = w.dy ?? 0;
    const wd = w.w ?? w.x1 - w.x0, hh = w.h ?? w.y1 - w.y0;
    const size = Math.max(2, hh * 0.9);
    const latin = fitsWinAnsi(w.text);
    const text = latin ? w.text : ocrLayerText(w.text);
    const font = latin ? (helv ||= ensureFont(doc, p, 'Helvetica')) : (uni ||= ensureOcrFont(doc, p));
    const tz = clampTz((wd / naturalWidth(text, size)) * 100);
    // The baseline sits a little above the bottom edge of the word box, measured across the reading direction.
    const bx = (w.ox ?? w.x0) - dy * size * 0.22, by = (w.oy ?? w.y0) + dx * size * 0.22;
    ops.push(`/${font} ${num(size)} Tf ${num(tz)} Tz ${num(dx)} ${num(dy)} ${num(-dy)} ${num(dx)} ${num(bx)} ${num(by)} Tm ${latin ? lit(winAnsiBytes(text)) : hexOf(utf16Hex(text))} Tj`);
  }
  ops.push('ET Q', 'EMC');
  doc.setPageContent(p, concat([isolatedContent(doc.pageContent(p)), bytesOf('\n' + ops.join('\n') + '\n')]));
  p.dict.set(OCR_TAG, PdfString.fromText(lang));
  if (p.ref) doc.update(p.ref, p.dict);
}

const SHOW = new Set(['Tj', 'TJ', "'", '"']);

/** Indexes of the text-showing operators drawn invisibly (render mode 3), following q/Q and Tr like a reader does. */
export function invisibleShows(ops: Op[]): Set<number> {
  const out = new Set<number>();
  const stack: number[] = [];
  let tr = 0;
  ops.forEach((o, k) => {
    if (o.op === 'q') stack.push(tr);
    else if (o.op === 'Q') tr = stack.pop() ?? tr;
    else if (o.op === 'Tr') tr = Number(o.args[0]) || 0;
    else if (SHOW.has(o.op) && tr === 3) out.add(k);
  });
  return out;
}

const blankShow = (o: Op): Op => (o.op === 'TJ' ? { op: 'TJ', args: [[]] } : o.op === '"' ? { op: '"', args: [o.args[0], o.args[1], new PdfString(new Uint8Array(0))] } : { op: o.op, args: [new PdfString(new Uint8Array(0))] });

/**
 * Removes an earlier recognized layer: the /QuillFolioOCR block this app wrote, and the strings of any other
 * invisible text (older versions, other OCR programs). Visible text in the same text object stays.
 */
export function stripOcrOps(ops: Op[]): Op[] {
  const out: Op[] = [];
  let skip = 0;
  for (const o of ops) {
    if (skip) { if (o.op === 'BMC' || o.op === 'BDC') skip++; else if (o.op === 'EMC') skip--; continue; }
    if (o.op === 'BMC' && isName(o.args[0], OCR_TAG)) { skip = 1; continue; }
    out.push(o);
  }
  const hidden = invisibleShows(out);
  return out.map((o, k) => (hidden.has(k) ? blankShow(o) : o));
}
export function stripOcrLayer(doc: PdfDocument, p: PageInfo): void {
  doc.setPageContent(p, serializeContent(stripOcrOps(parseContent(doc.pageContent(p)))));
}

/** The runs of a page's invisible (recognized) text layer. `text` is what the layer stores; ocrLayerText(text) gives the reading order of right-to-left words. */
export function invisibleRuns(doc: PdfDocument, p: PageInfo): EditableRun[] {
  const hidden = invisibleShows(parseContent(doc.pageContent(p)));
  return pageRuns(doc, p).filter((r) => hidden.has(r.opIndex));
}

/**
 * Replaces the text of recognized words in place, in one rewrite of the page content. The word keeps its
 * position and width (its horizontal scaling is recomputed); a correction Helvetica cannot write switches
 * that word to the Unicode font. Nothing visible is drawn. `text` is in reading order; `run` is a run from
 * invisibleRuns. Returns how many words changed.
 */
export function applyOcrCorrections(doc: PdfDocument, p: PageInfo, changes: { run: { opIndex: number; text: string; font: string }; text: string }[]): number {
  const ops = parseContent(doc.pageContent(p));
  const fonts = p.resources ? doc.getDict(p.resources, 'Font') : null;
  let uni = '';
  let n = 0;
  // From the end, so that operators inserted for one word do not move the indexes of the others.
  for (const ch of [...changes].sort((a, b) => b.run.opIndex - a.run.opIndex)) {
    const k = ch.run.opIndex, op = ops[k];
    if (!op || !SHOW.has(op.op) || ch.text === ocrLayerText(ch.run.text)) continue;
    const wasUni = isOcrFont(doc, fonts?.get(ch.run.font));
    // The word's font size and horizontal scaling: the nearest Tf and Tz before it.
    let size = 0, tz = 100, gotTz = false;
    for (let j = k - 1; j >= 0 && (!size || !gotTz); j--) {
      if (!gotTz && ops[j].op === 'Tz') { tz = Number(ops[j].args[0]) || 100; gotTz = true; }
      if (!size && ops[j].op === 'Tf') size = Number(ops[j].args[1]) || 0;
    }
    if (!size) continue;
    const oldNatural = wasUni ? (utf16Units(ch.run.text) * OCR_DW * size) / 1000 : textWidth(ch.run.text, 'Helvetica', size);
    const width = ((oldNatural || 1) * tz) / 100;
    const toUni = wasUni || !fitsWinAnsi(ch.text);
    const text = toUni ? ocrLayerText(ch.text) : ch.text;
    const str = toUni ? new PdfString(utf16Hex(text), true) : new PdfString(winAnsiBytes(text));
    const newNatural = (toUni ? (utf16Units(text) * OCR_DW * size) / 1000 : textWidth(text, 'Helvetica', size)) || 1;
    const newTz = text ? clampTz((width / newNatural) * 100) : tz;
    const show: Op = op.op === 'TJ' ? { op: 'TJ', args: [[str]] } : op.op === '"' ? { op: '"', args: [op.args[0], op.args[1], str] } : { op: op.op, args: [str] };
    const before: Op[] = [], after: Op[] = [];
    if (toUni && !wasUni) {
      uni ||= ensureOcrFont(doc, p);
      before.push({ op: 'Tf', args: [Name.get(uni), size] });
      after.push({ op: 'Tf', args: [Name.get(ch.run.font), size] });
    }
    before.push({ op: 'Tz', args: [Math.round(newTz * 100) / 100] });
    after.push({ op: 'Tz', args: [tz] });
    ops.splice(k, 1, ...before, show, ...after);
    n++;
  }
  if (n) doc.setPageContent(p, serializeContent(ops));
  return n;
}

// ------------------------------------------------------------------------------------------
// Scan clean-up math

/**
 * Skew of the text lines in degrees, from the variance of horizontal projection profiles. The image has
 * y pointing down; a positive result means the lines run downhill to the right on screen (the scan is
 * turned clockwise by that angle).
 */
export function estimateSkew(g: Uint8ClampedArray, w: number, h: number): number {
  let best = 0, bestScore = -1;
  const step = 2;
  for (let deg = -6; deg <= 6; deg += 0.5) {
    const t = Math.tan((deg * Math.PI) / 180);
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) { const yy = Math.round(y + (x - w / 2) * t); if (yy >= 0 && yy < h && g[yy * w + x] < 128) rows[y]++; }
    let mean = 0; for (let y = 0; y < h; y += step) mean += rows[y]; mean /= h / step;
    let varc = 0; for (let y = 0; y < h; y += step) varc += (rows[y] - mean) ** 2;
    if (varc > bestScore) { bestScore = varc; best = deg; }
  }
  return best;
}

/**
 * The content matrix that straightens a page whose lines are skewed by `deg` as estimateSkew reports it
 * (clockwise on screen): a counter-clockwise turn by the same angle about (cx, cy). In user space y points
 * up, so that is a rotation by +deg.
 */
export function deskewMatrix(deg: number, cx: number, cy: number): [number, number, number, number, number, number] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

/** 3×3 median of a gray image (edges copied). One pass, no per-pixel allocation. */
export function median3x3(g: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.length);
  const v = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (y === 0 || y === h - 1) { for (let x = 0; x < w; x++) out[row + x] = g[row + x]; continue; }
    out[row] = g[row]; out[row + w - 1] = g[row + w - 1];
    for (let x = 1; x < w - 1; x++) {
      let n = 0;
      for (let dy = -w; dy <= w; dy += w) { const i = row + dy + x; v[n++] = g[i - 1]; v[n++] = g[i]; v[n++] = g[i + 1]; }
      // Insertion sort of nine values; the median is the fifth.
      for (let i = 1; i < 9; i++) { const t = v[i]; let j = i - 1; while (j >= 0 && v[j] > t) { v[j + 1] = v[j]; j--; } v[j + 1] = t; }
      out[row + x] = v[4];
    }
  }
  return out;
}

/**
 * The box of the page's ink in a gray image: the outermost rows and columns that hold at least `min` dark
 * pixels, so that single specks at the edge do not stop the crop. Null when the page is blank.
 */
export function inkBounds(g: Uint8ClampedArray, w: number, h: number, min = 3, dark = 200): { x0: number; y0: number; x1: number; y1: number } | null {
  const cols = new Uint32Array(w), rows = new Uint32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x] < dark) { cols[x]++; rows[y]++; }
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < w && cols[x0] < min) x0++;
  while (x1 >= 0 && cols[x1] < min) x1--;
  while (y0 < h && rows[y0] < min) y0++;
  while (y1 >= 0 && rows[y1] < min) y1--;
  return x1 > x0 && y1 > y0 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null;
}

