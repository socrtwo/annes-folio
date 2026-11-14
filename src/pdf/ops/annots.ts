/**
 * Annotations (ISO 32000-1 §12.5): creating markup, notes, free text, shapes, ink, stamps, links,
 * file attachments and redaction marks with generated appearance streams; editing (the appearance
 * is rebuilt from the dictionary, so what is stored and what is drawn agree); replies and review
 * states; XFDF import/export; flattening; applying redactions to page content.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, cloneObj, nameText, pdfDate } from '../objects';
import { flateStream } from '../filters';
import { PdfDocument, PageInfo } from '../document';
import { fmtNum } from '../writer';
import { addAnnotation, pageAnnotations, removeAnnotation, AnnotInfo } from '../structure';
import { stdFontRef, lit, ensureFont } from '../build';
import { textWidth, winAnsiBytes, wrapText, STD_FONTS, type StdFont } from '../stdfonts';
import { serializeContent, rectsOverlap, Op } from '../content';
import { bytesOf, concat } from '../objects';
import { parseXml, esc } from '../../io/xml';
import { detachWidget, mapAnnotGeometry, ownResources } from './shared';
import { redactPageContent, pruneUndrawn, redactWork, type RedactStats } from './redact';

export type RGB = [number, number, number];
export type Rect = [number, number, number, number];

const norm = (r: Rect): Rect => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
const newName = () => PdfString.fromText(`qf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`);

export interface AnnotBase { author?: string; contents?: string; color?: RGB; opacity?: number; subject?: string }

function baseDict(subtype: string, rect: Rect, b: AnnotBase): Dict {
  const d = new Dict({ Type: Name.get('Annot'), Subtype: Name.get(subtype), Rect: norm(rect), F: 4, M: pdfDate(), CreationDate: pdfDate(), NM: newName() });
  if (b.author) d.set('T', PdfString.fromText(b.author));
  if (b.contents) d.set('Contents', PdfString.fromText(b.contents));
  if (b.color) d.set('C', b.color);
  if (b.opacity != null && isFinite(b.opacity) && b.opacity < 1) d.set('CA', Math.max(0, b.opacity));
  if (b.subject) d.set('Subj', PdfString.fromText(b.subject));
  return d;
}

/** A form XObject for an appearance stream. */
function appearance(doc: PdfDocument, bbox: Rect, content: string, extra: Record<string, PdfObj> = {}, resources?: Dict): Ref {
  const s = flateStream(bytesOf(content), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: bbox, Resources: resources || new Dict(), ...extra });
  return doc.register(s);
}

function withOpacity(opacity: number | undefined, blend?: string): { res: Dict; gs: string } {
  const res = new Dict();
  if ((opacity != null && opacity < 1) || blend) {
    const g = new Dict({ Type: Name.get('ExtGState') });
    if (opacity != null && opacity < 1) { g.set('CA', opacity); g.set('ca', opacity); }
    if (blend) g.set('BM', Name.get(blend));
    res.set('ExtGState', new Dict({ GS: g }));
    return { res, gs: '/GS gs ' };
  }
  return { res, gs: '' };
}

const rg = (c: RGB) => `${fmtNum(c[0])} ${fmtNum(c[1])} ${fmtNum(c[2])} rg`;
const RG = (c: RGB) => `${fmtNum(c[0])} ${fmtNum(c[1])} ${fmtNum(c[2])} RG`;
const numbers = (doc: PdfDocument, a: PdfObj | undefined): number[] => (Array.isArray(a) ? a : []).map((x) => { const v = doc.resolve<PdfObj>(x); return typeof v === 'number' && isFinite(v) ? v : 0; });

/** A colour array (gray, RGB or CMYK) as RGB; null when absent or empty. */
function colorOf(doc: PdfDocument, a: PdfObj | undefined): RGB | null {
  const v = numbers(doc, a);
  if (v.length === 1) return [v[0], v[0], v[0]];
  if (v.length === 3) return [v[0], v[1], v[2]];
  if (v.length === 4) return [1 - Math.min(1, v[0] + v[3]), 1 - Math.min(1, v[1] + v[3]), 1 - Math.min(1, v[2] + v[3])];
  return null;
}
const pairs = (v: number[]): [number, number][] => { const out: [number, number][] = []; for (let k = 0; k + 1 < v.length; k += 2) out.push([v[k], v[k + 1]]); return out; };
function bounds(pts: [number, number][], pad = 0): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}
const union = (rects: Rect[]): Rect => bounds(rects.flatMap((r) => [[r[0], r[1]], [r[2], r[3]]] as [number, number][]));
const borderWidthOf = (doc: PdfDocument, d: Dict, def: number): number => { const bs = doc.getDict(d, 'BS'); return bs ? Math.max(0, doc.getNum(bs, 'W', def)) : def; };
const ownAnnotation = (doc: PdfDocument, d: Dict): boolean => doc.getText(d, 'NM').startsWith('qf-');

/** The rectangles of /QuadPoints (bounding box per quad, whatever the corner order). */
function quadRects(doc: PdfDocument, d: Dict): Rect[] {
  const q = numbers(doc, doc.getArray(d, 'QuadPoints'));
  const out: Rect[] = [];
  for (let k = 0; k + 7 < q.length; k += 8) out.push(bounds(pairs(q.slice(k, k + 8))));
  return out.filter((r) => r[2] > r[0] && r[3] > r[1]);
}

// ------------------------------------------------------------------------------------------
// Appearance streams, built from what the annotation dictionary says

function buildMarkup(doc: PdfDocument, d: Dict, kind: string): boolean {
  let all = quadRects(doc, d);
  if (!all.length) { const r = doc.rect(d.get('Rect')); if (!r) return false; all = [r]; }
  const color = colorOf(doc, doc.getArray(d, 'C')) || (kind === 'Highlight' ? [1, 1, 0] : kind === 'StrikeOut' ? [1, 0, 0] : [0, 0, 1]);
  const bbox = union(all);
  d.set('Rect', bbox);
  const { res, gs } = withOpacity(doc.getNum(d, 'CA', 1), kind === 'Highlight' ? 'Multiply' : undefined);
  let ops = `${gs}${rg(color)} ${RG(color)} `;
  for (const r of all) {
    const h = r[3] - r[1];
    if (kind === 'Highlight') ops += `${fmtNum(r[0])} ${fmtNum(r[1])} ${fmtNum(r[2] - r[0])} ${fmtNum(h)} re f `;
    else if (kind === 'Underline') ops += `${fmtNum(Math.max(0.6, h * 0.06))} w ${fmtNum(r[0])} ${fmtNum(r[1] + h * 0.08)} m ${fmtNum(r[2])} ${fmtNum(r[1] + h * 0.08)} l S `;
    else if (kind === 'StrikeOut') ops += `${fmtNum(Math.max(0.6, h * 0.07))} w ${fmtNum(r[0])} ${fmtNum(r[1] + h * 0.42)} m ${fmtNum(r[2])} ${fmtNum(r[1] + h * 0.42)} l S `;
    else {
      // The zigzag step never drops below 1/4000 of the width, so a huge rectangle cannot stall the loop.
      const amp = Math.max(1, h * 0.08, (r[2] - r[0]) / 4000);
      const seg: string[] = [`${fmtNum(Math.max(0.5, h * 0.05))} w ${fmtNum(r[0])} ${fmtNum(r[1])} m`];
      let x = r[0], up = true;
      while (x < r[2]) { x = Math.min(r[2], x + amp); seg.push(`${fmtNum(x)} ${fmtNum(r[1] + (up ? amp : 0))} l`); up = !up; }
      ops += seg.join(' ') + ' S ';
    }
  }
  d.set('AP', new Dict({ N: appearance(doc, bbox, ops, {}, res) }));
  return true;
}

function buildNote(doc: PdfDocument, d: Dict): boolean {
  const color = colorOf(doc, doc.getArray(d, 'C')) || [1, 0.85, 0.2];
  const { res, gs } = withOpacity(doc.getNum(d, 'CA', 1));
  const ops = `${gs}${rg(color)} 0.2 0.2 0.2 RG 0.8 w 1 1 18 18 re B 0.2 0.2 0.2 rg BT /F1 7 Tf 3.5 11 Td (...) Tj ET`;
  res.set('Font', new Dict({ F1: stdFontRef(doc, 'Helvetica-Bold') }));
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, 20, 20], ops, {}, res) }));
  return true;
}

/** The standard font a /DA font name (or the font of the previous appearance) stands for. */
function daFont(doc: PdfDocument, d: Dict, name: string): StdFont {
  if ((STD_FONTS as string[]).includes(name)) return name as StdFont;
  const ap = doc.getDict(d, 'AP'), n = ap ? doc.get<PdfObj>(ap, 'N') : null;
  const fonts = n instanceof PdfStream ? doc.getDict(doc.getDict(n, 'Resources'), 'Font') : null;
  const base = fonts && fonts.keys().length ? doc.getName(doc.getDict(fonts, fonts.has(name) ? name : fonts.keys()[0]), 'BaseFont') : '';
  if ((STD_FONTS as string[]).includes(base)) return base as StdFont;
  const hint = base || name;
  const bold = /Bold|Bd/i.test(hint), ital = /Ital|Obli/i.test(hint);
  if (/Cour|Mono/i.test(hint)) return (bold ? (ital ? 'Courier-BoldOblique' : 'Courier-Bold') : ital ? 'Courier-Oblique' : 'Courier') as StdFont;
  if (/Tim|TiRo|Serif|Roman/i.test(hint)) return (bold ? (ital ? 'Times-BoldItalic' : 'Times-Bold') : ital ? 'Times-Italic' : 'Times-Roman') as StdFont;
  return (bold ? (ital ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : ital ? 'Helvetica-Oblique' : 'Helvetica') as StdFont;
}

function parseAnnotDA(da: string): { font: string; size: number; text: RGB; border: RGB | null } {
  const f = /\/([^\s/]+)\s+(-?[\d.]+)\s+Tf/.exec(da);
  const col = (three: RegExp, one: RegExp): RGB | null => { const m3 = three.exec(da); if (m3) return [+m3[1], +m3[2], +m3[3]]; const m1 = one.exec(da); return m1 ? [+m1[1], +m1[1], +m1[1]] : null; };
  const n = '(-?[\\d.]+)';
  return { font: f ? f[1] : 'Helvetica', size: f && +f[2] > 0 ? +f[2] : 12, text: col(new RegExp(`${n}\\s+${n}\\s+${n}\\s+rg\\b`), new RegExp(`${n}\\s+g\\b`)) || [0, 0, 0], border: col(new RegExp(`${n}\\s+${n}\\s+${n}\\s+RG\\b`), new RegExp(`${n}\\s+G\\b`)) };
}

function buildFreeText(doc: PdfDocument, d: Dict): boolean {
  const rect = doc.rect(d.get('Rect'));
  if (!rect) return false;
  const rd = numbers(doc, doc.getArray(d, 'RD'));
  const r: Rect = rd.length === 4 ? [rect[0] + rd[0], rect[1] + rd[1], rect[2] - rd[2], rect[3] - rd[3]] : rect;
  const da = parseAnnotDA(doc.getText(d, 'DA'));
  const font = daFont(doc, d, da.font), size = da.size, tc = da.text;
  const fill = colorOf(doc, doc.getArray(d, 'C'));
  const bw = borderWidthOf(doc, d, 1);
  const border = bw > 0 ? da.border || (d.has('BS') ? tc : null) : null;
  const q = doc.getNum(d, 'Q', 0);
  const text = doc.getText(d, 'Contents');
  const w = r[2] - r[0], h = r[3] - r[1];
  const pad = 3;
  const { res, gs } = withOpacity(doc.getNum(d, 'CA', 1));
  let ops = '';
  if (fill) ops += `${rg(fill)} 0 0 ${fmtNum(w)} ${fmtNum(h)} re f `;
  if (border) ops += `${RG(border)} ${fmtNum(bw)} w ${fmtNum(bw / 2)} ${fmtNum(bw / 2)} ${fmtNum(w - bw)} ${fmtNum(h - bw)} re S `;
  const lines = wrapText(text, font, size, w - pad * 2);
  ops += `BT ${rg(tc)} /F1 ${fmtNum(size)} Tf `;
  lines.forEach((l, i) => {
    const lw = textWidth(l, font, size);
    const x = q === 1 ? (w - lw) / 2 : q === 2 ? w - pad - lw : pad;
    const y = h - pad - size * 0.85 - i * size * 1.2;
    if (y < -size) return;
    ops += `1 0 0 1 ${fmtNum(x)} ${fmtNum(y)} Tm ${lit(winAnsiBytes(l))} Tj `;
  });
  ops += 'ET';
  res.set('Font', new Dict({ F1: stdFontRef(doc, font) }));
  const cl = numbers(doc, doc.getArray(d, 'CL'));
  if (cl.length >= 4) {
    // The callout line is drawn in the full Rect; the text box sits inside it at the /RD offsets.
    const X = (x: number) => fmtNum(x - rect[0]), Y = (y: number) => fmtNum(y - rect[1]);
    const line = `${RG(border || tc)} 1 w ` + pairs(cl).map(([x, y], i) => `${X(x)} ${Y(y)} ${i ? 'l' : 'm'}`).join(' ') + ' S';
    ops = `${gs}q ${line} Q q 1 0 0 1 ${X(r[0])} ${Y(r[1])} cm ${ops} Q`;
    d.set('AP', new Dict({ N: appearance(doc, [0, 0, rect[2] - rect[0], rect[3] - rect[1]], ops, {}, res) }));
  } else d.set('AP', new Dict({ N: appearance(doc, [0, 0, w, h], gs + ops, { Matrix: [1, 0, 0, 1, 0, 0] }, res) }));
  return true;
}

const circle = (X: (x: number) => string, Y: (y: number) => string, cx: number, cy: number, rx: number, ry: number, k = 0.5523): string =>
  `${X(cx + rx)} ${Y(cy)} m ${X(cx + rx)} ${Y(cy + ry * k)} ${X(cx + rx * k)} ${Y(cy + ry)} ${X(cx)} ${Y(cy + ry)} c ${X(cx - rx * k)} ${Y(cy + ry)} ${X(cx - rx)} ${Y(cy + ry * k)} ${X(cx - rx)} ${Y(cy)} c ${X(cx - rx)} ${Y(cy - ry * k)} ${X(cx - rx * k)} ${Y(cy - ry)} ${X(cx)} ${Y(cy - ry)} c ${X(cx + rx * k)} ${Y(cy - ry)} ${X(cx + rx)} ${Y(cy - ry * k)} ${X(cx + rx)} ${Y(cy)} c`;

/** The geometry rectangle of a Square/Circle: /Rect inset by /RD (annotations made here keep the stroke width there). */
function innerRect(doc: PdfDocument, d: Dict, rect: Rect, lw: number): Rect {
  const rd = numbers(doc, doc.getArray(d, 'RD'));
  const v = rd.length === 4 ? rd : ownAnnotation(doc, d) ? [lw, lw, lw, lw] : [0, 0, 0, 0];
  return [rect[0] + v[0], rect[1] + v[1], rect[2] - v[2], rect[3] - v[3]];
}

function buildShape(doc: PdfDocument, d: Dict, sub: string): boolean {
  const lw = borderWidthOf(doc, d, 1);
  const stroke = colorOf(doc, doc.getArray(d, 'C')) || [1, 0, 0];
  const fill = colorOf(doc, doc.getArray(d, 'IC'));
  const bs = doc.getDict(d, 'BS');
  const dashed = !!bs && doc.getName(bs, 'S') === 'D';
  const be = doc.getDict(d, 'BE');
  const cloud = sub === 'Polygon' && (doc.getName(d, 'IT') === 'PolygonCloud' || (!!be && doc.getName(be, 'S') === 'C'));
  let bbox: Rect, r: Rect | null = null, pts: [number, number][] = [];
  if (sub === 'Square' || sub === 'Circle') {
    const rect = doc.rect(d.get('Rect'));
    if (!rect) return false;
    bbox = rect; r = innerRect(doc, d, rect, lw);
  } else {
    pts = pairs(numbers(doc, doc.getArray(d, sub === 'Line' ? 'L' : 'Vertices')));
    if (pts.length < (sub === 'Line' ? 2 : 1)) return false;
    bbox = bounds(pts, lw);
    d.set('Rect', bbox);
  }
  const { res, gs } = withOpacity(doc.getNum(d, 'CA', 1));
  let ops = `${gs}${RG(stroke)} ${fill ? rg(fill) + ' ' : ''}${fmtNum(lw)} w ${dashed ? '[4 2] 0 d ' : ''}`;
  const paint = fill ? 'B' : 'S';
  const X = (x: number) => fmtNum(x - bbox[0]), Y = (y: number) => fmtNum(y - bbox[1]);
  if (sub === 'Square' && r) ops += `${X(r[0] + lw / 2)} ${Y(r[1] + lw / 2)} ${fmtNum(r[2] - r[0] - lw)} ${fmtNum(r[3] - r[1] - lw)} re ${paint}`;
  else if (sub === 'Circle' && r) ops += `${circle(X, Y, (r[0] + r[2]) / 2, (r[1] + r[3]) / 2, (r[2] - r[0]) / 2 - lw / 2, (r[3] - r[1]) / 2 - lw / 2)} ${paint}`;
  else if (sub === 'Line') {
    const a = pts[0], b = pts[1];
    ops += `${X(a[0])} ${Y(a[1])} m ${X(b[0])} ${Y(b[1])} l S`;
    const le = doc.getArray(d, 'LE');
    if (le && le.some((x) => { const n = doc.resolve<PdfObj>(x); return n instanceof Name && n.name !== 'None'; })) {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), len = Math.max(8, lw * 4);
      for (const s of [1, -1]) ops += ` ${X(b[0])} ${Y(b[1])} m ${X(b[0] - len * Math.cos(ang + s * 0.5))} ${Y(b[1] - len * Math.sin(ang + s * 0.5))} l S`;
    }
  } else {
    ops += pts.map((q, i) => `${X(q[0])} ${Y(q[1])} ${i ? 'l' : 'm'}`).join(' ');
    if (cloud) {
      // Scallops along each edge.
      const parts: string[] = [];
      const rad = Math.max(6, lw * 3);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, n = Math.min(2000, Math.max(1, Math.round(len / (rad * 1.6))));
        for (let k = 0; k < n; k++) parts.push(circle(X, Y, a[0] + (dx * (k + 0.5)) / n, a[1] + (dy * (k + 0.5)) / n, rad, rad, 0.55));
      }
      ops += ` ${fill ? 'f' : 'n'} ${parts.join(' ')} ${paint}`;
    } else ops += sub === 'Polygon' ? ` h ${paint}` : ' S';
  }
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, bbox[2] - bbox[0], bbox[3] - bbox[1]], ops, {}, res) }));
  return true;
}

/** True when the current normal appearance paints with the Multiply blend mode (a highlighter stroke). */
function multiplies(doc: PdfDocument, d: Dict): boolean {
  const ap = doc.getDict(d, 'AP'), n = ap ? doc.get<PdfObj>(ap, 'N') : null;
  const eg = n instanceof PdfStream ? doc.getDict(doc.getDict(n, 'Resources'), 'ExtGState') : null;
  return !!eg && eg.keys().some((k) => doc.getName(doc.getDict(eg, k), 'BM') === 'Multiply');
}

function buildInk(doc: PdfDocument, d: Dict): boolean {
  const strokes = (doc.getArray(d, 'InkList') || []).map((g) => pairs(numbers(doc, doc.resolve<PdfObj>(g))));
  if (!strokes.some((s) => s.length)) return false;
  const highlighter = doc.getName(d, 'IT') === 'InkHighlight' || multiplies(doc, d);
  const color = colorOf(doc, doc.getArray(d, 'C')) || (highlighter ? [1, 1, 0] : [0, 0, 1]);
  const lw = borderWidthOf(doc, d, highlighter ? 12 : 2);
  const bbox = bounds(strokes.flat(), lw);
  d.set('Rect', bbox);
  const { res, gs } = withOpacity(doc.getNum(d, 'CA', 1), highlighter ? 'Multiply' : undefined);
  const parts: string[] = [`${gs}${RG(color)} ${fmtNum(lw)} w 1 J 1 j`];
  for (const s of strokes) { if (!s.length) continue; parts.push(s.map((q, i) => `${fmtNum(q[0] - bbox[0])} ${fmtNum(q[1] - bbox[1])} ${i ? 'l' : 'm'}`).join(' ') + (s.length === 1 ? ` ${fmtNum(s[0][0] - bbox[0])} ${fmtNum(s[0][1] - bbox[1])} l` : '') + ' S'); }
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, bbox[2] - bbox[0], bbox[3] - bbox[1]], parts.join(' ') + ' ', {}, res) }));
  return true;
}

const stampName = (text: string) => 'QF' + text.replace(/[^A-Za-z]/g, '');

function buildStamp(doc: PdfDocument, d: Dict): boolean {
  const r = doc.rect(d.get('Rect'));
  if (!r) return false;
  const w = r[2] - r[0], h = r[3] - r[1];
  const ap = doc.getDict(d, 'AP'), old = ap ? doc.get<PdfObj>(ap, 'N') : null;
  const oldRes = old instanceof PdfStream ? doc.getDict(old, 'Resources') : null;
  const image = oldRes ? doc.getDict(oldRes, 'XObject')?.get('Im') : undefined;
  const opacity = doc.getNum(d, 'CA', 1);
  if (image instanceof Ref && doc.getName(d, 'Name').startsWith('QF') || d.has('QFImage')) {
    const im = image instanceof Ref ? image : d.get('QFImage');
    if (!(im instanceof Ref)) return false;
    const { res, gs } = withOpacity(opacity);
    res.set('XObject', new Dict({ Im: im }));
    d.set('AP', new Dict({ N: appearance(doc, [0, 0, w, h], `q ${gs}${fmtNum(w)} 0 0 ${fmtNum(h)} 0 0 cm /Im Do Q`, {}, res) }));
    return true;
  }
  // A text stamp made here: its text is kept in /QFText (older ones: the contents, when the name still matches).
  const contents = doc.getText(d, 'Contents');
  const text = d.has('QFText') ? doc.getText(d, 'QFText') : doc.getName(d, 'Name') === stampName(contents) && contents ? contents : '';
  if (!text) return false;
  const color = colorOf(doc, doc.getArray(d, 'C')) || [0.8, 0.1, 0.1];
  const font: StdFont = 'Helvetica-Bold';
  let size = h * 0.6;
  while (size > 4 && textWidth(text, font, size) > w - 12) size *= 0.9;
  const tw = textWidth(text, font, size);
  const { res, gs } = withOpacity(opacity);
  res.set('Font', new Dict({ F1: stdFontRef(doc, font) }));
  const ops = `${gs}${RG(color)} ${rg(color)} 2 w 1 1 ${fmtNum(w - 2)} ${fmtNum(h - 2)} re S BT /F1 ${fmtNum(size)} Tf ${fmtNum((w - tw) / 2)} ${fmtNum((h - size * 0.7) / 2)} Td ${lit(winAnsiBytes(text))} Tj ET`;
  // The stamp's rotation lives in the appearance matrix and is kept.
  const m = old instanceof PdfStream ? numbers(doc, doc.getArray(old, 'Matrix')) : [];
  const extra: Record<string, PdfObj> = m.length === 6 && (Math.abs(m[1]) > 1e-9 || Math.abs(m[2]) > 1e-9) ? { Matrix: m } : {};
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, w, h], ops, extra, res) }));
  return true;
}

function buildFileAttachment(doc: PdfDocument, d: Dict): boolean {
  const color = colorOf(doc, doc.getArray(d, 'C')) || [0.3, 0.5, 0.9];
  const { res, gs } = withOpacity(doc.getNum(d, 'CA', 1));
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, 16, 20], `${gs}${rg(color)} 0.2 0.2 0.2 RG 1 w 2 2 12 16 re B 5 6 m 5 15 l 9 15 l 9 6 l S`, {}, res) }));
  return true;
}

function buildRedactMark(doc: PdfDocument, d: Dict): boolean {
  let all = quadRects(doc, d);
  if (!all.length) { const r = doc.rect(d.get('Rect')); if (!r) return false; all = [r]; }
  const bbox = union(all);
  d.set('Rect', bbox);
  let ops = '1 0 0 RG 1 w ';
  for (const r of all) ops += `${fmtNum(r[0] - bbox[0] + 0.5)} ${fmtNum(r[1] - bbox[1] + 0.5)} ${fmtNum(r[2] - r[0] - 1)} ${fmtNum(r[3] - r[1] - 1)} re S `;
  d.set('AP', new Dict({ N: appearance(doc, [0, 0, bbox[2] - bbox[0], bbox[3] - bbox[1]], ops) }));
  return true;
}

/** Rebuilds /AP /N from the dictionary. False when this module cannot draw the subtype (the appearance is left alone). */
function buildAppearance(doc: PdfDocument, d: Dict): boolean {
  const sub = doc.getName(d, 'Subtype');
  switch (sub) {
    case 'Highlight': case 'Underline': case 'StrikeOut': case 'Squiggly': return buildMarkup(doc, d, sub);
    case 'Text': return buildNote(doc, d);
    case 'FreeText': return buildFreeText(doc, d);
    case 'Square': case 'Circle': case 'Line': case 'Polygon': case 'PolyLine': return buildShape(doc, d, sub);
    case 'Ink': return buildInk(doc, d);
    case 'Stamp': return buildStamp(doc, d);
    case 'FileAttachment': return buildFileAttachment(doc, d);
    case 'Redact': return buildRedactMark(doc, d);
    default: return false;
  }
}

/**
 * Rebuilds an annotation's appearance stream from its dictionary (after the dictionary was edited
 * directly). Returns false when the subtype is not one this module draws; nothing changes then.
 */
export function refreshAppearance(doc: PdfDocument, p: PageInfo, ref: Ref): boolean {
  void p;
  const d = doc.resolve<PdfObj>(ref);
  if (!(d instanceof Dict) || !buildAppearance(doc, d)) return false;
  doc.update(ref, d);
  return true;
}

// ------------------------------------------------------------------------------------------
// Text markup

export type MarkupKind = 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly';

/** Quads: [x1 y1 x2 y2 x3 y3 x4 y4] per rectangle in the order PDF wants (upper-left, upper-right, lower-left, lower-right). */
export function quadsFromRects(rects: Rect[]): number[] {
  const out: number[] = [];
  for (const r of rects.map(norm)) out.push(r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]);
  return out;
}

export function addTextMarkup(doc: PdfDocument, p: PageInfo, kind: MarkupKind, rects: Rect[], b: AnnotBase = {}): Ref {
  const color = b.color || (kind === 'Highlight' ? [1, 1, 0] : kind === 'StrikeOut' ? [1, 0, 0] : [0, 0, 1]);
  const all = rects.map(norm);
  if (!all.length) throw new Error('A text markup needs at least one rectangle.');
  const d = baseDict(kind, union(all), { ...b, color });
  d.set('QuadPoints', quadsFromRects(all));
  buildMarkup(doc, d, kind);
  return addAnnotation(doc, p, d);
}

// ------------------------------------------------------------------------------------------
// Notes, free text, shapes, ink, stamps

export function addNote(doc: PdfDocument, p: PageInfo, x: number, y: number, b: AnnotBase & { icon?: string } = {}): Ref {
  const color = b.color || [1, 0.85, 0.2];
  const rect: Rect = [x, y - 20, x + 20, y];
  const d = baseDict('Text', rect, { ...b, color });
  d.set('Name', Name.get(b.icon || 'Comment'));
  d.set('Open', false);
  buildNote(doc, d);
  const ref = addAnnotation(doc, p, d);
  addPopup(doc, p, ref, [x + 24, y - 120, x + 204, y]);
  return ref;
}

export function addPopup(doc: PdfDocument, p: PageInfo, parent: Ref, rect: Rect): Ref {
  const pop = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Popup'), Rect: rect, Parent: parent, Open: false, F: 28 });
  const ref = addAnnotation(doc, p, pop);
  const pd = doc.resolve<Dict>(parent); pd.set('Popup', ref); doc.touch(parent);
  return ref;
}

export interface FreeTextOpts extends AnnotBase { text: string; font?: StdFont; size?: number; textColor?: RGB; fill?: RGB | null; border?: RGB | null; borderWidth?: number; align?: 'left' | 'center' | 'right'; callout?: [number, number, number, number, number, number] }

/** A text box. As the standard has it, /C holds the background (`fill`, or `color`), /DA the text and border colours, /BS the border width. */
export function addFreeText(doc: PdfDocument, p: PageInfo, rect: Rect, o: FreeTextOpts): Ref {
  const r = norm(rect);
  const font = o.font || 'Helvetica', size = o.size || 12, tc = o.textColor || [0, 0, 0];
  const d = baseDict('FreeText', r, { ...o, contents: o.text, color: o.fill || (o.fill === null ? undefined : o.color) });
  d.set('DA', PdfString.fromText(`/${font} ${fmtNum(size)} Tf ${rg(tc)}${o.border ? ' ' + RG(o.border) : ''}`));
  d.set('BS', new Dict({ W: o.border ? Math.max(0, o.borderWidth ?? 1) : 0, S: Name.get('S') }));
  d.set('Q', o.align === 'center' ? 1 : o.align === 'right' ? 2 : 0);
  if (o.callout) {
    const c = o.callout;
    const bx = union([r, bounds(pairs([...c]))]);
    d.set('IT', Name.get('FreeTextCallout')); d.set('CL', [...c]); d.set('LE', Name.get('OpenArrow'));
    d.set('Rect', bx);
    d.set('RD', [r[0] - bx[0], r[1] - bx[1], bx[2] - r[2], bx[3] - r[3]]);
  }
  buildFreeText(doc, d);
  return addAnnotation(doc, p, d);
}

export type ShapeKind = 'Square' | 'Circle' | 'Line' | 'Polygon' | 'PolyLine' | 'Cloud';
export interface ShapeOpts extends AnnotBase { stroke?: RGB; fill?: RGB | null; width?: number; points?: [number, number][]; arrow?: boolean; dashed?: boolean }

export function addShape(doc: PdfDocument, p: PageInfo, kind: ShapeKind, rect: Rect, o: ShapeOpts = {}): Ref {
  const r = norm(rect);
  const stroke = o.stroke || o.color || [1, 0, 0];
  const lw = o.width != null && isFinite(o.width) && o.width >= 0 ? o.width : 2;
  const pts = (o.points || []).filter((q) => q && isFinite(q[0]) && isFinite(q[1]));
  const sub = kind === 'Cloud' ? 'Polygon' : kind;
  const d = baseDict(sub, [r[0] - lw, r[1] - lw, r[2] + lw, r[3] + lw], { ...o, color: stroke });
  if (o.fill) d.set('IC', o.fill);
  const bs = new Dict({ W: lw, S: Name.get(o.dashed ? 'D' : 'S') });
  if (o.dashed) bs.set('D', [4, 2]);
  d.set('BS', bs);
  if (kind === 'Square' || kind === 'Circle') d.set('RD', [lw, lw, lw, lw]);
  else if (kind === 'Line') {
    const a = pts[0] || [r[0], r[1]], b = pts[1] || [r[2], r[3]];
    d.set('L', [a[0], a[1], b[0], b[1]]);
    if (o.arrow) d.set('LE', [Name.get('None'), Name.get('OpenArrow')]);
  } else {
    // Without points the rectangle's corners are the vertices.
    const v: [number, number][] = pts.length ? pts : [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
    d.set('Vertices', v.flat());
    if (kind === 'Cloud') { d.set('IT', Name.get('PolygonCloud')); d.set('BE', new Dict({ S: Name.get('C'), I: 1 })); }
  }
  buildShape(doc, d, sub);
  return addAnnotation(doc, p, d);
}

export function addInk(doc: PdfDocument, p: PageInfo, strokes: [number, number][][], o: AnnotBase & { width?: number; highlighter?: boolean } = {}): Ref {
  const color = o.color || (o.highlighter ? [1, 1, 0] : [0, 0, 1]);
  const lw = o.width != null && isFinite(o.width) && o.width >= 0 ? o.width : o.highlighter ? 12 : 2;
  const clean = strokes.map((s) => s.filter((q) => q && isFinite(q[0]) && isFinite(q[1])));
  if (!clean.some((s) => s.length)) throw new Error('An ink annotation needs at least one point.');
  const d = baseDict('Ink', bounds(clean.flat(), lw), { ...o, color, opacity: o.highlighter ? (o.opacity ?? 0.5) : o.opacity });
  d.set('InkList', clean.map((s) => s.flat()));
  d.set('BS', new Dict({ W: lw }));
  if (o.highlighter) d.set('IT', Name.get('InkHighlight'));
  buildInk(doc, d);
  return addAnnotation(doc, p, d);
}

export const STAMP_TEXTS = ['Approved', 'Draft', 'Confidential', 'Final', 'For Review', 'Not Approved', 'Received', 'Revised', 'Void', 'Completed', 'Sign Here', 'Witness', 'Initial Here', 'Top Secret', 'Expired', 'Experimental', 'Departmental', 'Preliminary Results', 'Information Only', 'For Public Release', 'Not For Public Release', 'Sold', 'For Comment', 'As Is'];

export function addTextStamp(doc: PdfDocument, p: PageInfo, rect: Rect, text: string, o: AnnotBase & { rotate?: number } = {}): Ref {
  const r = norm(rect);
  const color = o.color || [0.8, 0.1, 0.1];
  const d = baseDict('Stamp', r, { ...o, color, contents: o.contents || text, opacity: o.opacity ?? 0.85 });
  d.set('Name', Name.get(stampName(text)));
  d.set('QFText', PdfString.fromText(text));
  buildStamp(doc, d);
  if (o.rotate) { const s = doc.get<PdfStream>(doc.getDict(d, 'AP'), 'N'); const a = (o.rotate * Math.PI) / 180; s.dict.set('Matrix', [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); }
  return addAnnotation(doc, p, d);
}

export function addImageStamp(doc: PdfDocument, p: PageInfo, rect: Rect, image: Ref, o: AnnotBase & { name?: string } = {}): Ref {
  const r = norm(rect);
  const d = baseDict('Stamp', r, o);
  d.set('Name', Name.get(o.name || 'QFImage'));
  d.set('QFImage', image);
  buildStamp(doc, d);
  return addAnnotation(doc, p, d);
}

export function addLink(doc: PdfDocument, p: PageInfo, rect: Rect, target: { url?: string; page?: number; y?: number }, o: { border?: boolean } = {}): Ref {
  const r = norm(rect);
  const d = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Link'), Rect: r, Border: o.border ? [0, 0, 1] : [0, 0, 0], F: 4 });
  if (target.url) d.set('A', new Dict({ S: Name.get('URI'), URI: PdfString.fromText(target.url) }));
  else if (target.page != null) { const tp = doc.pages[target.page]; if (tp?.ref) d.set('Dest', [tp.ref, Name.get('XYZ'), null, target.y ?? tp.cropBox[3], null]); }
  return addAnnotation(doc, p, d);
}

export function addFileAttachmentAnnot(doc: PdfDocument, p: PageInfo, x: number, y: number, name: string, data: Uint8Array, o: AnnotBase & { mime?: string } = {}): Ref {
  // The MIME type is the name itself; the writer escapes the slash.
  const stream = flateStream(data, { Type: Name.get('EmbeddedFile'), Subtype: Name.get(o.mime || 'application/octet-stream'), Params: new Dict({ Size: data.length, ModDate: pdfDate() }) });
  const sref = doc.register(stream);
  const fs = new Dict({ Type: Name.get('Filespec'), F: PdfString.fromText(name), UF: PdfString.fromText(name, true), EF: new Dict({ F: sref, UF: sref }) });
  const d = baseDict('FileAttachment', [x, y - 20, x + 16, y], { ...o, color: o.color || [0.3, 0.5, 0.9], contents: o.contents || name });
  d.set('FS', doc.register(fs));
  d.set('Name', Name.get('Paperclip'));
  buildFileAttachment(doc, d);
  return addAnnotation(doc, p, d);
}

export function addRedactMark(doc: PdfDocument, p: PageInfo, rects: Rect[], o: AnnotBase & { overlayText?: string } = {}): Ref {
  const all = rects.map(norm);
  if (!all.length) throw new Error('A redaction mark needs at least one rectangle.');
  const d = baseDict('Redact', union(all), { ...o, color: o.color || [1, 0, 0] });
  d.set('QuadPoints', quadsFromRects(all));
  d.set('IC', [0, 0, 0]);
  if (o.overlayText) d.set('OverlayText', PdfString.fromText(o.overlayText));
  buildRedactMark(doc, d);
  return addAnnotation(doc, p, d);
}

// ------------------------------------------------------------------------------------------
// Editing

const sameColor = (a: RGB | null, b: RGB): boolean => !!a && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);

/**
 * Changes annotation properties. A new colour, opacity, border width or (for text boxes) contents
 * rebuilds the appearance for every subtype this module draws; a new rectangle moves all stored
 * geometry (QuadPoints, InkList, L, Vertices, CL) with it and leaves the appearance matrix alone.
 */
export function setAnnotationProps(doc: PdfDocument, p: PageInfo, ref: Ref, props: { contents?: string; author?: string; color?: RGB; opacity?: number; rect?: Rect; hidden?: boolean; subject?: string; borderWidth?: number }): void {
  const d = doc.resolve<Dict>(ref);
  if (!(d instanceof Dict)) return;
  const sub = doc.getName(d, 'Subtype');
  let redraw = false;
  if (props.contents !== undefined) { if (sub === 'FreeText' && doc.getText(d, 'Contents') !== props.contents) redraw = true; d.set('Contents', PdfString.fromText(props.contents)); }
  if (props.author !== undefined) d.set('T', PdfString.fromText(props.author));
  if (props.subject !== undefined) d.set('Subj', PdfString.fromText(props.subject));
  if (props.color && props.color.every((v) => isFinite(v))) { if (!sameColor(colorOf(doc, doc.getArray(d, 'C')), props.color)) redraw = true; d.set('C', props.color); }
  if (props.opacity != null && isFinite(props.opacity)) { const o = Math.max(0, Math.min(1, props.opacity)); if (Math.abs(doc.getNum(d, 'CA', 1) - o) > 1e-4) redraw = true; d.set('CA', o); }
  if (props.borderWidth != null && isFinite(props.borderWidth) && props.borderWidth >= 0) {
    const w = props.borderWidth, old = borderWidthOf(doc, d, 1);
    if (!d.has('BS') || Math.abs(old - w) > 1e-4) {
      const rect = doc.rect(d.get('Rect'));
      if ((sub === 'Square' || sub === 'Circle') && rect) {
        // The shape keeps its size: the rectangle grows or shrinks with the stroke.
        const r = innerRect(doc, d, rect, old);
        d.set('Rect', [r[0] - w, r[1] - w, r[2] + w, r[3] + w]); d.set('RD', [w, w, w, w]);
      }
      const bs = (doc.getDict(d, 'BS') || new Dict({ S: Name.get('S') })).clone();
      bs.set('W', w);
      d.set('BS', bs);
      redraw = true;
    }
  }
  if (props.rect && props.rect.every((v) => isFinite(v))) {
    const old = doc.rect(d.get('Rect')), nr = norm(props.rect);
    d.set('Rect', nr);
    if (old) {
      const sx = (nr[2] - nr[0]) / (old[2] - old[0] || 1), sy = (nr[3] - nr[1]) / (old[3] - old[1] || 1);
      mapAnnotGeometry(doc, d, (x, y) => [nr[0] + (x - old[0]) * sx, nr[1] + (y - old[1]) * sy]);
      // The popup of a note follows it.
      const pop = d.get('Popup'), pd = doc.resolve<PdfObj>(pop), pr = pd instanceof Dict ? doc.rect(pd.get('Rect')) : null;
      if (pop instanceof Ref && pd instanceof Dict && pr) { pd.set('Rect', [pr[0] + nr[0] - old[0], pr[1] + nr[3] - old[3], pr[2] + nr[0] - old[0], pr[3] + nr[3] - old[3]]); doc.touch(pop); }
    }
  }
  if (props.hidden !== undefined) { const f = doc.getNum(d, 'F', 4); d.set('F', props.hidden ? f | 2 : f & ~2); }
  if (redraw) buildAppearance(doc, d);
  d.set('M', pdfDate());
  doc.update(ref, d);
  void p;
}

export function addReply(doc: PdfDocument, p: PageInfo, parent: Ref, text: string, author: string, state?: { model: 'Review' | 'Marked'; state: string }): Ref {
  const pd = doc.resolve<Dict>(parent);
  const rect = doc.rect(pd.get('Rect')) || [0, 0, 20, 20];
  const d = baseDict('Text', rect, { author, contents: text });
  d.set('IRT', parent);
  d.set('F', 28 + 2); // hidden; replies live in the popup
  if (state) { d.set('RT', Name.get('R')); d.set('StateModel', PdfString.fromText(state.model)); d.set('State', PdfString.fromText(state.state)); }
  return addAnnotation(doc, p, d);
}

/** Deletes an annotation (with its popup and replies). A form widget also leaves the AcroForm field tree. */
export function deleteAnnotation(doc: PdfDocument, p: PageInfo, ref: Ref): void {
  if (doc.getName(doc.resolve<Dict | null>(ref), 'Subtype') === 'Widget') detachWidget(doc, ref);
  removeAnnotation(doc, p, ref);
}

/** A copy of an appearance entry (a stream, or a dictionary of state streams) with its own stream objects. */
function copyAppearance(doc: PdfDocument, v: PdfObj | undefined): PdfObj {
  const o = doc.resolve<PdfObj>(v);
  if (o instanceof PdfStream) return doc.register(cloneObj(o));
  if (o instanceof Dict) { const d = new Dict(); for (const [k, x] of o.map) d.set(k, copyAppearance(doc, x)); return d; }
  return null;
}

/**
 * Duplicates an annotation on its page, moved by (dx, dy). The copy has its own /NM and its own
 * appearance streams, so editing one no longer changes the other. A note gets its own popup; a
 * form widget becomes another widget of the same field (a merged field gets a new unique name).
 */
export function duplicateAnnotation(doc: PdfDocument, p: PageInfo, ref: Ref, dx: number, dy: number): Ref {
  const src = doc.resolve<PdfObj>(ref);
  if (!(src instanceof Dict)) throw new Error('There is no such annotation.');
  const d = cloneObj(src) as Dict;
  const sub = doc.getName(d, 'Subtype');
  const ap = doc.getDict(src, 'AP');
  if (ap) { const nap = new Dict(); for (const [k, v] of ap.map) nap.set(k, copyAppearance(doc, v)); d.set('AP', nap); }
  const r = doc.rect(d.get('Rect'));
  if (r) d.set('Rect', [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  mapAnnotGeometry(doc, d, (x, y) => [x + dx, y + dy]);
  d.delete('Popup'); d.delete('IRT');
  if (sub !== 'Widget') { d.set('NM', newName()); d.set('M', pdfDate()); d.set('CreationDate', pdfDate()); }
  const out = addAnnotation(doc, p, d);
  if (sub === 'Widget') {
    const parent = d.get('Parent');
    const pd = doc.resolve<PdfObj>(parent);
    if (parent instanceof Ref && pd instanceof Dict) { pd.set('Kids', [...(doc.getArray(pd, 'Kids') || []), out]); doc.touch(parent); }
    else {
      // A merged field/widget: the copy is a field of its own and needs its own name.
      const af = doc.getDict(doc.catalog, 'AcroForm');
      const fields = af ? doc.getArray(af, 'Fields') || [] : [];
      const names = new Set(fields.map((f) => doc.getText(doc.resolve<Dict | null>(f), 'T')));
      const base = doc.getText(d, 'T') || 'Field';
      let k = 2; while (names.has(`${base} ${k}`)) k++;
      d.set('T', PdfString.fromText(`${base} ${k}`));
      if (af) { af.set('Fields', [...fields, out]); const ar = doc.catalog.get('AcroForm'); if (ar instanceof Ref) doc.touch(ar); else doc.update(doc.catalogRef, doc.catalog); }
    }
  } else if (src.has('Popup') && r) addPopup(doc, p, out, [r[2] + dx + 4, r[3] + dy - 120, r[2] + dx + 184, r[3] + dy]);
  return out;
}

/** Flattens annotations into page content (their normal appearance is drawn, then they are removed). */
export function flattenAnnotations(doc: PdfDocument, p: PageInfo, filter: (a: AnnotInfo) => boolean = () => true): number {
  const annots = pageAnnotations(doc, p);
  const ops: string[] = [];
  let n = 0;
  const res = ownResources(doc, p);
  let xo = doc.getDict(res, 'XObject');
  if (!xo) { xo = new Dict(); res.set('XObject', xo); } else if (!(res.get('XObject') instanceof Dict)) { xo = xo.clone(); res.set('XObject', xo); }
  for (const a of annots) {
    if (!filter(a) || a.hidden || a.subtype === 'Popup' || a.subtype === 'Link') continue;
    const ap = doc.getDict(a.dict, 'AP');
    let nap = ap ? doc.get<PdfObj>(ap, 'N') : null;
    let stateRef: PdfObj | undefined = ap ? ap.get('N') : undefined;
    if (nap instanceof Dict) {
      // A state dictionary: the current state, else the off state; never an arbitrary "on" appearance.
      const as = doc.getName(a.dict, 'AS');
      const key = as && nap.has(as) ? as : nap.has('Off') ? 'Off' : a.subtype === 'Widget' ? '' : nap.keys()[0];
      stateRef = key ? nap.get(key) : undefined;
      nap = key ? doc.get<PdfObj>(nap, key) : null;
    }
    if (!(nap instanceof PdfStream)) continue;
    const bbox = doc.rect(nap.dict.get('BBox')) || [0, 0, 1, 1];
    const mtx = numbers(doc, doc.getArray(nap, 'Matrix'));
    const m = mtx.length >= 6 ? mtx : [1, 0, 0, 1, 0, 0];
    // Transform bbox by matrix; map to rect (§12.5.5).
    const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as [number, number]);
    const [tx0, ty0, tx1, ty1] = bounds(corners);
    const r = a.rect;
    const sx = (r[2] - r[0]) / (tx1 - tx0 || 1), sy = (r[3] - r[1]) / (ty1 - ty0 || 1);
    let name = `QFA${++n}_${a.ref?.num ?? 0}`;
    while (xo.has(name)) name += 'x';
    // `Do` needs a form XObject: appearance streams that omit /Subtype get it on a copy.
    let fref: Ref;
    if (doc.getName(nap, 'Subtype') !== 'Form') { const c = cloneObj(nap) as PdfStream; c.dict.set('Type', Name.get('XObject')); c.dict.set('Subtype', Name.get('Form')); fref = doc.register(c); }
    else fref = stateRef instanceof Ref ? stateRef : doc.register(nap);
    xo.set(name, fref);
    ops.push(`q ${fmtNum(sx)} 0 0 ${fmtNum(sy)} ${fmtNum(r[0] - tx0 * sx)} ${fmtNum(r[1] - ty0 * sy)} cm /${name} Do Q`);
    if (a.ref) deleteAnnotation(doc, p, a.ref);
  }
  if (ops.length) { const cur = doc.pageContent(p); doc.setPageContent(p, concat([bytesOf('q\n'), cur, bytesOf('\nQ\n'), bytesOf(ops.join('\n'))])); }
  if (p.ref) doc.touch(p.ref);
  return ops.length;
}

// ------------------------------------------------------------------------------------------
// Redaction

export interface RedactResult { textRemoved: number; imagesRemoved: number; areas: number; /** Vector paths that lay wholly inside an area. */ pathsRemoved: number; /** Form XObjects rewritten (or removed) because content inside them was under an area. */ formsRewritten: number;
  /**
   * Pages (0-based) whose content could not be checked completely: their Form XObjects draw each other so many
   * times over that the work limit ran out. What was found there is removed and covered, but forms left
   * unchecked may still hold content under the areas.
   */
  incompletePages: number[] }

/**
 * Applies every Redact annotation on the pages (and the given rects). Text glyphs, images and vector
 * paths under the areas are removed from the page content and from the Form XObjects it draws
 * (rewritten as private copies); XObjects that are no longer drawn leave the resources; annotations
 * under the areas and the marks go; black boxes (with the marks' overlay text) are drawn on top.
 * The removed data is gone from the document only once it is saved as a full rewrite.
 */
export function applyRedactions(doc: PdfDocument, indexes: number[], extra: Map<number, Rect[]> = new Map()): RedactResult {
  const stats: RedactStats = { text: 0, images: 0, paths: 0, forms: 0 };
  const dropped = new Set<number>();
  let areas = 0;
  const incompletePages: number[] = [];
  const pages = doc.pages;
  for (const i of new Set(indexes)) {
    const p = pages[i];
    if (!p) continue;
    const rects: Rect[] = (extra.get(i) || []).map(norm);
    const labels: { rect: Rect; text: string }[] = [];
    for (const m of pageAnnotations(doc, p).filter((a) => a.subtype === 'Redact')) {
      // QuadPoints move with the mark (setAnnotationProps), so they are where the user sees it.
      const quads = quadRects(doc, m.dict);
      const own = quads.length ? quads : [m.rect];
      rects.push(...own);
      const text = doc.getText(m.dict, 'OverlayText');
      if (text) for (const r of own) labels.push({ rect: r, text });
    }
    if (!rects.length) continue;
    areas += rects.length;
    const work = redactWork();
    const ops: Op[] = redactPageContent(doc, p, rects, stats, dropped, work);
    if (work.cutShort) incompletePages.push(i);
    // Black boxes on top, in clean user space (the old content is closed off in q…Q).
    ops.push({ op: 'q', args: [] }, { op: 'rg', args: [0, 0, 0] });
    for (const r of rects) ops.push({ op: 're', args: [r[0], r[1], r[2] - r[0], r[3] - r[1]] }, { op: 'f', args: [] });
    ops.push({ op: 'Q', args: [] });
    if (labels.length) {
      ownResources(doc, p);
      const font = ensureFont(doc, p, 'Helvetica');
      for (const { rect: r, text } of labels) {
        const w = r[2] - r[0], h = r[3] - r[1];
        let size = Math.max(4, Math.min(14, h * 0.6));
        while (size > 4 && textWidth(text, 'Helvetica', size) > w - 4) size *= 0.9;
        const tw = textWidth(text, 'Helvetica', size);
        ops.push({ op: 'q', args: [] }, { op: 're', args: [r[0], r[1], w, h] }, { op: 'W', args: [] }, { op: 'n', args: [] }, { op: 'BT', args: [] }, { op: 'Tf', args: [Name.get(font), size] }, { op: 'rg', args: [1, 1, 1] },
          { op: 'Td', args: [r[0] + Math.max(2, (w - tw) / 2), r[1] + (h - size * 0.7) / 2] }, { op: 'Tj', args: [new PdfString(winAnsiBytes(text))] }, { op: 'ET', args: [] }, { op: 'Q', args: [] });
      }
    }
    doc.setPageContent(p, serializeContent(ops));
    // Annotations within the areas (and the marks themselves) go; a widget takes its field value with it.
    for (const a of pageAnnotations(doc, p)) if (a.ref && (a.subtype === 'Redact' || rects.some((r) => rectsOverlap(r, a.rect)))) deleteAnnotation(doc, p, a.ref);
  }
  pruneUndrawn(doc, dropped);
  return { textRemoved: stats.text, imagesRemoved: stats.images, areas, pathsRemoved: stats.paths, formsRewritten: stats.forms, incompletePages: incompletePages.sort((a, b) => a - b) };
}

// ------------------------------------------------------------------------------------------
// XFDF

const hexColor = (c: RGB | null) => (c ? '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('') : undefined);
/** Annotation subtypes XFDF has elements for; anything else is left out of an export. */
const XFDF_TAGS = new Set(['text', 'highlight', 'underline', 'strikeout', 'squiggly', 'freetext', 'square', 'circle', 'line', 'polygon', 'polyline', 'ink', 'stamp', 'redact', 'fileattachment', 'caret', 'sound']);

export function exportXfdf(doc: PdfDocument, fileName = ''): string {
  const items: string[] = [];
  const list = (a: PdfObj | undefined) => numbers(doc, a).map(fmtNum).join(',');
  for (const a of doc.pages.flatMap((p) => pageAnnotations(doc, p))) {
    const tag = a.subtype.toLowerCase();
    if (!XFDF_TAGS.has(tag)) continue;
    const attrs: string[] = [`page="${a.page}"`, `rect="${a.rect.map(fmtNum).join(',')}"`];
    if (a.author) attrs.push(`title="${esc(a.author)}"`);
    if (a.name) attrs.push(`name="${esc(a.name)}"`);
    if (a.color) attrs.push(`color="${hexColor(a.color)}"`);
    if (a.date) attrs.push(`date="${esc(pdfDate(a.date).toText())}"`);
    if (a.opacity < 1) attrs.push(`opacity="${fmtNum(a.opacity)}"`);
    if (a.irt) { const parent = doc.resolve<Dict>(a.irt); attrs.push(`inreplyto="${esc(doc.getText(parent, 'NM'))}"`); }
    if (a.subtype === 'Text') attrs.push(`icon="${esc(nameText(doc.getName(a.dict, 'Name')) || 'Comment')}"`);
    if (a.subtype === 'Stamp' && a.dict.has('QFText')) attrs.push(`icon="${esc(doc.getText(a.dict, 'QFText'))}"`);
    const q = doc.getArray(a.dict, 'QuadPoints'); if (q) attrs.push(`coords="${list(q)}"`);
    const bs = doc.getDict(a.dict, 'BS'); if (bs) attrs.push(`width="${fmtNum(doc.getNum(bs, 'W', 1))}"`);
    const ic = colorOf(doc, doc.getArray(a.dict, 'IC')); if (ic) attrs.push(`interior-color="${hexColor(ic)}"`);
    const st = doc.getText(a.dict, 'State'); if (st) attrs.push(`state="${esc(st)}" statemodel="${esc(doc.getText(a.dict, 'StateModel'))}"`);
    const ot = doc.getText(a.dict, 'OverlayText'); if (ot) attrs.push(`overlay-text="${esc(ot)}"`);
    const l = numbers(doc, doc.getArray(a.dict, 'L')); if (l.length >= 4) attrs.push(`start="${fmtNum(l[0])},${fmtNum(l[1])}" end="${fmtNum(l[2])},${fmtNum(l[3])}"`);
    let inner = a.contents ? `<contents>${esc(a.contents)}</contents>` : '';
    const ink = doc.getArray(a.dict, 'InkList'); if (ink) inner += `<inklist>${ink.map((g) => `<gesture>${list(doc.resolve<PdfObj>(g))}</gesture>`).join('')}</inklist>`;
    const v = doc.getArray(a.dict, 'Vertices'); if (v) inner += `<vertices>${list(v)}</vertices>`;
    items.push(`<${tag} ${attrs.join(' ')}>${inner}</${tag}>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">${fileName ? `<f href="${esc(fileName)}"/>` : ''}<annots>${items.join('')}</annots></xfdf>`;
}

const parseColor = (s: string | null): RGB | undefined => { const m = s && /^#?([0-9a-f]{6})$/i.exec(s.trim()); return m ? [parseInt(m[1].slice(0, 2), 16) / 255, parseInt(m[1].slice(2, 4), 16) / 255, parseInt(m[1].slice(4, 6), 16) / 255] : undefined; };
const nums = (s: string | null): number[] => (s ? s.split(/[\s,;]+/).filter(Boolean).map(Number).filter((x) => isFinite(x)) : []);

/**
 * Imports annotations from XFDF (comments from another reader). Returns how many were added; throws
 * when the file is not XML. An annotation whose name (/NM) the document already has is skipped, so
 * importing the same file twice, or a review package's own comments, does not duplicate them.
 */
export function importXfdf(doc: PdfDocument, xml: string): number {
  const dom = parseXml(xml);
  if (!dom) throw new Error('The XFDF file is not well-formed XML; nothing was imported.');
  const annots = dom.getElementsByTagNameNS('*', 'annots')[0];
  if (!annots) return 0;
  let count = 0;
  const byName = new Map<string, Ref>();
  const pages = doc.pages;
  const existing = new Set(pages.flatMap((pg) => pageAnnotations(doc, pg)).map((a) => a.name).filter(Boolean));
  for (const el of [...annots.children]) {
    const page = +(el.getAttribute('page') || 0);
    const p = pages[page];
    if (!p) continue;
    if (existing.has(el.getAttribute('name') || '')) continue;
    // Coordinates are kept within reach of the page: a wild value cannot blow up the appearance generators.
    const [mx0, my0, mx1, my1] = p.mediaBox, slack = Math.max(mx1 - mx0, my1 - my0);
    const cx = (x: number) => Math.max(mx0 - slack, Math.min(mx1 + slack, x)), cy = (y: number) => Math.max(my0 - slack, Math.min(my1 + slack, y));
    const points = (s: string | null): [number, number][] => pairs(nums(s)).map(([x, y]) => [cx(x), cy(y)]);
    const rect = points(el.getAttribute('rect'));
    if (rect.length < 2) continue;
    const opacity = el.getAttribute('opacity') ? +el.getAttribute('opacity')! : NaN;
    const base: AnnotBase = { author: el.getAttribute('title') || undefined, contents: el.getElementsByTagNameNS('*', 'contents')[0]?.textContent || el.getElementsByTagNameNS('*', 'contents-richtext')[0]?.textContent || undefined, color: parseColor(el.getAttribute('color')), opacity: isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : undefined };
    const tag = el.localName.toLowerCase();
    const r: Rect = norm([rect[0][0], rect[0][1], rect[1][0], rect[1][1]]);
    const width = (def: number) => { const w = +(el.getAttribute('width') || def); return isFinite(w) && w >= 0 ? Math.min(w, 100) : def; };
    const coords = points(el.getAttribute('coords'));
    const quadRectsIn: Rect[] = [];
    for (let k = 0; k + 3 < coords.length; k += 4) { const b = bounds(coords.slice(k, k + 4)); if (b[2] > b[0] && b[3] > b[1]) quadRectsIn.push(b); }
    let ref: Ref | null = null;
    try {
      switch (tag) {
        case 'highlight': case 'underline': case 'strikeout': case 'squiggly': ref = addTextMarkup(doc, p, (tag[0].toUpperCase() + tag.slice(1)).replace('Strikeout', 'StrikeOut') as MarkupKind, quadRectsIn.length ? quadRectsIn : [r], base); break;
        case 'text': ref = addNote(doc, p, r[0], r[3], { ...base, icon: el.getAttribute('icon') || undefined }); break;
        case 'freetext': ref = addFreeText(doc, p, r, { ...base, text: base.contents || '' }); break;
        case 'square': case 'circle': ref = addShape(doc, p, tag === 'square' ? 'Square' : 'Circle', r, { ...base, fill: parseColor(el.getAttribute('interior-color')) || null, width: width(1) }); break;
        case 'line': { const s = points(el.getAttribute('start')), e = points(el.getAttribute('end')); if (!s.length || !e.length) continue; ref = addShape(doc, p, 'Line', r, { ...base, points: [s[0], e[0]], width: width(1) }); break; }
        case 'polygon': case 'polyline': { const pts = points(el.getElementsByTagNameNS('*', 'vertices')[0]?.textContent || null); if (!pts.length) continue; ref = addShape(doc, p, tag === 'polygon' ? 'Polygon' : 'PolyLine', r, { ...base, points: pts, fill: parseColor(el.getAttribute('interior-color')) || null, width: width(1) }); break; }
        case 'ink': { const strokes = [...el.getElementsByTagNameNS('*', 'gesture')].map((g) => points(g.textContent)); ref = addInk(doc, p, strokes, { ...base, width: width(2) }); break; }
        case 'stamp': ref = addTextStamp(doc, p, r, (el.getAttribute('icon') || base.contents || 'Stamp').replace(/^#/, ''), base); break;
        case 'redact': ref = addRedactMark(doc, p, quadRectsIn.length ? quadRectsIn : [r], { ...base, overlayText: el.getAttribute('overlay-text') || el.getAttribute('overlaytext') || undefined }); break;
        default: continue;
      }
    } catch { continue; }
    if (ref) {
      count++;
      const nm = el.getAttribute('name'); if (nm) { byName.set(nm, ref); doc.resolve<Dict>(ref).set('NM', PdfString.fromText(nm)); }
      const irt = el.getAttribute('inreplyto'); if (irt && byName.has(irt)) { const d = doc.resolve<Dict>(ref); d.set('IRT', byName.get(irt)!); d.set('F', 30); }
      const st = el.getAttribute('state'); if (st) { const d = doc.resolve<Dict>(ref); d.set('State', PdfString.fromText(st)); d.set('StateModel', PdfString.fromText(el.getAttribute('statemodel') || 'Review')); }
    }
  }
  return count;
}

export { pageAnnotations, removeAnnotation };
