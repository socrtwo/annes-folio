/**
 * Editing existing page text: replacing the text of one run when its font can be re-encoded
 * (simple Latin fonts), otherwise covering the run with a white box and drawing new text in a
 * standard font. Also inserting new text, images and deleting content by area.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString } from '../objects';
import { PdfDocument, PageInfo } from '../document';
import { parseContent, serializeContent, analyzeContent, encodeString, fontInfo, mul, IDENTITY, TextRun, rectOps, Op, type Matrix } from '../content';
import { ensureFont, ensureXObject, litText } from '../build';
import { winAnsiBytes } from '../stdfonts';
import { fmtNum } from '../writer';
import { bytesOf, concat } from '../objects';
import type { Ref } from '../objects';
import { blankText } from './redact';
import { ownResources } from './shared';

export interface EditableRun extends TextRun { page: number; editable: boolean; /** The run is drawn by a Form XObject: it can be covered, not changed. */ inForm?: boolean }

const TEXT_OPS = new Set(['Tj', 'TJ', "'", '"']);

const num = (v: PdfObj | undefined): number => (typeof v === 'number' && isFinite(v) ? v : 0);
/** The current transformation matrix in effect just before the operator at `index`. */
function ctmBefore(ops: Op[], index: number): Matrix {
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  for (let i = 0; i < index && i < ops.length; i++) {
    const o = ops[i];
    if (o.op === 'q') stack.push(ctm);
    else if (o.op === 'Q') ctm = stack.pop() || ctm;
    else if (o.op === 'cm' && o.args.length >= 6) ctm = mul(o.args.slice(0, 6).map(num) as Matrix, ctm);
  }
  return ctm;
}
const invert = (m: Matrix): Matrix | null => { const det = m[0] * m[3] - m[1] * m[2]; return Math.abs(det) < 1e-12 ? null : [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]; };

/**
 * `ops` followed by `extra` drawn in the page's own coordinates: whatever transformation the content
 * leaves behind is undone first. Nothing is put in front, so operator indexes callers hold stay valid.
 */
function withOverlay(ops: Op[], extra: Op[]): Op[] {
  const inv = invert(ctmBefore(ops, ops.length));
  const back: Op[] = inv && inv.some((v, i) => Math.abs(v - IDENTITY[i]) > 1e-9) ? [{ op: 'cm', args: [...inv] }] : [];
  return [...ops, { op: 'q', args: [] }, ...back, ...extra, { op: 'Q', args: [] }];
}

export function pageRuns(doc: PdfDocument, p: PageInfo): EditableRun[] {
  const ops = parseContent(doc.pageContent(p));
  const info = analyzeContent(doc, ops, p.resources);
  const fonts = p.resources ? doc.getDict(p.resources, 'Font') : null;
  const cache = new Map<string, boolean>();
  return info.runs.map((r) => {
    // A run reported for a `Do` lives in a form with its own fonts: its font name means nothing on the page.
    const inForm = !TEXT_OPS.has(ops[r.opIndex]?.op);
    let ed = inForm ? false : cache.get(r.font);
    if (ed === undefined) { ed = fontInfo(doc, r.font, fonts ? doc.getDict(fonts, r.font) : null).editable; cache.set(r.font, ed); }
    return { ...r, page: p.index, editable: ed, ...(inForm ? { inForm } : {}) };
  });
}

export interface ReplaceResult { mode: 'reencoded' | 'overlaid' }

/** Replaces the text of a run. */
export function replaceRunText(doc: PdfDocument, p: PageInfo, run: EditableRun, newText: string): ReplaceResult {
  const ops = parseContent(doc.pageContent(p));
  const op = ops[run.opIndex];
  const isText = !!op && TEXT_OPS.has(op.op);
  const fonts = p.resources ? doc.getDict(p.resources, 'Font') : null;
  const fd = fonts ? doc.getDict(fonts, run.font) : null;
  const fi = fontInfo(doc, run.font, isText ? fd : null);
  if (isText && fi.editable) {
    const encoded = encodeString(fi, newText);
    // A subset font only holds the glyphs the document used: every new character must be one it has a width for.
    const subset = /^[A-Z]{6}\+/.test(doc.getName(fd, 'BaseFont'));
    if (encoded && (!subset || [...encoded.bytes].every((c) => (fi.widths.get(c) ?? 0) > 0))) {
      if (op.op === 'TJ') op.args[0] = [encoded];
      else if (op.op === '"') op.args[2] = encoded;
      else op.args[0] = encoded;
      doc.setPageContent(p, serializeContent(ops));
      return { mode: 'reencoded' };
    }
  }
  // Overlay: white box over the old run, new text in a standard font at the size the run is drawn at.
  const [x0, y0, x1, y1] = run.box;
  const white = rectOps(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2, [1, 1, 1]);
  // Remove the old string so copy/search no longer finds it (text inside a form can only be covered).
  const kept = isText ? blankText(doc, ops, p.resources, new Set([op])) : ops;
  ownResources(doc, p);
  const font = ensureFont(doc, p, /Times|Serif|Roman|Georgia/i.test(fi.name) ? 'Times-Roman' : /Cour|Mono/i.test(fi.name) ? 'Courier' : 'Helvetica');
  // The box spans 1.1 em (0.25 below the baseline, 0.85 above); the Tf operand alone ignores scaling matrices.
  const size = (y1 - y0) / 1.1 || run.size || 10;
  const text: Op[] = [{ op: 'BT', args: [] }, { op: 'Tf', args: [Name.get(font), size] }, { op: 'rg', args: [0, 0, 0] }, { op: 'Td', args: [x0, y0 + (y1 - y0) * 0.22] }, { op: 'Tj', args: [new PdfString(winAnsiBytes(newText))] }, { op: 'ET', args: [] }];
  doc.setPageContent(p, serializeContent(withOverlay(kept, [...white, ...text])));
  return { mode: 'overlaid' };
}

/** Removes every run and image whose box lies inside the area (white-out editing). */
export function eraseArea(doc: PdfDocument, p: PageInfo, area: [number, number, number, number], white = true): number {
  const ops = parseContent(doc.pageContent(p));
  const info = analyzeContent(doc, ops, p.resources);
  const inside = (b: [number, number, number, number]) => b[0] >= area[0] - 1 && b[2] <= area[2] + 1 && b[1] >= area[1] - 1 && b[3] <= area[3] + 1;
  let n = 0;
  // Only operators of the page itself are changed. Content drawn by a Form XObject is reported for
  // its `Do`; touching that would remove the whole form, so it is only painted over.
  const blank = new Set<Op>();
  for (const r of info.runs) { const op = ops[r.opIndex]; if (inside(r.box) && op && TEXT_OPS.has(op.op) && !blank.has(op)) { blank.add(op); n++; } }
  const kept = blankText(doc, ops, p.resources, blank);
  const xo = p.resources ? doc.getDict(p.resources, 'XObject') : null;
  for (const im of info.images) {
    const op = kept[im.opIndex];
    if (!inside(im.box) || !op) continue;
    const direct = op.op === 'INLINE_IMAGE' || (op.op === 'Do' && op.args[0] instanceof Name && !!xo && doc.getName(doc.get<PdfStream | null>(xo, op.args[0].name), 'Subtype') === 'Image');
    if (direct) { kept[im.opIndex] = { op: 'n', args: [] }; n++; }
  }
  const out = white ? withOverlay(kept, rectOps(area[0], area[1], area[2] - area[0], area[3] - area[1], [1, 1, 1])) : kept;
  doc.setPageContent(p, serializeContent(out));
  return n;
}

export function insertText(doc: PdfDocument, p: PageInfo, x: number, y: number, text: string, o: { font?: 'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Times-Bold' | 'Courier'; size?: number; color?: [number, number, number]; maxWidth?: number } = {}): void {
  ownResources(doc, p);
  const font = ensureFont(doc, p, o.font || 'Helvetica');
  const size = o.size || 12;
  const c = o.color || [0, 0, 0];
  const lines = text.split(/\r?\n/);
  const ops = lines.map((l, i) => `BT /${font} ${fmtNum(size)} Tf ${fmtNum(c[0])} ${fmtNum(c[1])} ${fmtNum(c[2])} rg ${fmtNum(x)} ${fmtNum(y - i * size * 1.2)} Td ${litText(l)} Tj ET`).join('\n');
  const cur = doc.pageContent(p);
  doc.setPageContent(p, concat([bytesOf('q\n'), cur, bytesOf('\nQ\n'), bytesOf(ops), bytesOf('\n')]));
}

export function insertImage(doc: PdfDocument, p: PageInfo, image: Ref, box: { x: number; y: number; w: number; h: number }): void {
  ownResources(doc, p);
  const name = ensureXObject(doc, p, 'QFIm', image);
  const cur = doc.pageContent(p);
  doc.setPageContent(p, concat([bytesOf('q\n'), cur, bytesOf('\nQ\n'), bytesOf(`q ${fmtNum(box.w)} 0 0 ${fmtNum(box.h)} ${fmtNum(box.x)} ${fmtNum(box.y)} cm /${name} Do Q\n`)]));
}

/**
 * Moves or resizes the image drawn by a Do operator at `opIndex` (from analyzeContent) so that it
 * fills `box` in page coordinates, whatever transformations surround it. When the image has its own
 * `cm … Do Q` the matrix is changed in place and operator indexes stay as they were; otherwise the
 * Do is wrapped in `q cm … Q` (it then sits two operators later).
 */
export function moveImage(doc: PdfDocument, p: PageInfo, opIndex: number, box: { x: number; y: number; w: number; h: number }): boolean {
  const ops = parseContent(doc.pageContent(p));
  const op = ops[opIndex];
  if (!op || op.op !== 'Do') return false;
  const target: Matrix = [box.w, 0, 0, box.h, box.x, box.y];
  // A matrix placed right before the Do and undone right after it belongs to this image alone.
  const own = ops[opIndex - 1]?.op === 'cm' && ops[opIndex - 1].args.length >= 6 && ops[opIndex + 1]?.op === 'Q';
  const inv = invert(ctmBefore(ops, own ? opIndex - 1 : opIndex));
  if (!inv) return false;
  const m = mul(target, inv);
  if (own) ops[opIndex - 1].args = [...m];
  else ops.splice(opIndex, 1, { op: 'q', args: [] }, { op: 'cm', args: [...m] }, op, { op: 'Q', args: [] });
  doc.setPageContent(p, serializeContent(ops));
  return true;
}

export function deleteImage(doc: PdfDocument, p: PageInfo, opIndex: number): boolean {
  const ops = parseContent(doc.pageContent(p));
  const op = ops[opIndex];
  if (!op || (op.op !== 'Do' && op.op !== 'INLINE_IMAGE')) return false;
  ops[opIndex] = { op: 'n', args: [] };
  doc.setPageContent(p, serializeContent(ops));
  return true;
}

export const asDict = (o: unknown): Dict | null => (o instanceof Dict ? o : null);
