/**
 * Comment tab: text markup, notes, text boxes, drawing, stamps, attachments, measurements, and the
 * management of annotations (properties, replies, status, delete, flatten, XFDF). Also the dispatcher
 * for every drawing tool: the viewer reports a finished gesture as comment.toolDone.
 */
import { def, type MenuEntry } from './registry';
import { NO_CHANGE, type App, type DocTab, type Tool } from '../app';
import { openDialog, toast, confirmDialog, promptDialog, colorMenu, HIGHLIGHT_COLORS, STANDARD_COLORS } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { pageAnnotations, allAnnotations, readFields, type AnnotInfo } from '../pdf/structure';
import type { PdfDocument, PageInfo } from '../pdf/document';
import { Ref } from '../pdf/objects';
import { imageXObject, type ImageSpec } from '../pdf/build';
import {
  addTextMarkup, addNote, addFreeText, addShape, addInk, STAMP_TEXTS, addTextStamp, addImageStamp, addLink, addFileAttachmentAnnot, addRedactMark,
  setAnnotationProps, addReply, deleteAnnotation, duplicateAnnotation, flattenAnnotations, exportXfdf, importXfdf, type MarkupKind, type ShapeKind,
} from '../pdf/ops/annots';
import { addField, type NewField } from '../pdf/ops/forms';
import { formatLength } from '../view/viewer';
import { isSafeExternalUrl } from '../util/sanitize';
import { viewer, pageOf, selectedAnnotation, hasAnnotSelected, selectedText, saveBytes, baseName, hexToRgb, rgbToHex, imageSpecFromFile, fitBox, esc, FONT_OPTIONS, type Rect, type RGB } from './util';
import { annotLabel } from '../ui/panes';

const author = (app: App) => app.prefs.author || 'Author';
const penColor = (app: App): RGB => hexToRgb(app.prefs.penColor, [0.9, 0.2, 0.2]);
const hlColor = (app: App): RGB => hexToRgb(app.prefs.highlightColor, [1, 0.92, 0.23]);

/** A comment (not a form field widget) is selected. */
const commentSelected = (app: App): boolean => { const s = selectedAnnotation(app); return !!s && s.info.subtype !== 'Widget'; };

/** Tool commands: with text selected, the markup tools apply at once; otherwise they arm the tool. */
const toolCmd = (id: string, t: Tool, label: string, icon: string, group: string, extra: Record<string, unknown> = {}, opts?: (app: App) => any) => ({
  id, label, icon, tab: 'Comment', group, kind: 'toggle' as const, noRecord: true,
  isActive: (app: App) => app.tab?.ui?.tool === t && (!opts || JSON.stringify(app.viewer.toolOpts) === JSON.stringify(opts(app))),
  run: (app: App) => { app.tab.ui.setTool(t, opts ? opts(app) : {}); app.focus(); }, ...extra,
});

const markupCmd = (id: string, t: Tool, kind: MarkupKind, label: string, icon: string, keys: string[]) => ({
  id, label, icon, keys, tab: 'Comment', group: 'Text Markup', kind: 'toggle' as const, noRecord: true,
  tip: `${label} the selected text, or drag over text with the tool`,
  isActive: (app: App) => app.tab?.ui?.tool === t,
  run: (app: App) => {
    const sr = app.viewer.selectionRects;
    if (sr && sr.rects.length) { markup(app, app.tab, kind, sr.page, sr.rects); app.viewer.clearSelection(); return; }
    app.tab.ui.setTool(t);
    app.focus();
  },
});

function markup(app: App, tab: DocTab, kind: MarkupKind, page: number, rects: Rect[], contents?: string): void {
  const color: RGB = kind === 'Highlight' ? hlColor(app) : penColor(app);
  app.editTab(tab, kind, (doc) => addTextMarkup(doc, pageOf(tab, page), kind, rects, { author: author(app), color, contents }));
}

/** Rectangles of text items inside a dragged rectangle (so a drag with a markup tool marks words, not the box). */
async function textRectsIn(tab: DocTab, page: number, rect: Rect): Promise<Rect[]> {
  const items = await viewer(tab).items(page);
  const out: Rect[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const r: Rect = [it.x, it.y - it.h * 0.2, it.x + it.w, it.y + it.h * 0.8];
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    if (cx >= rect[0] && cx <= rect[2] && cy >= rect[1] && cy <= rect[3]) out.push(r);
  }
  return out.length ? out : [rect];
}

async function textBox(app: App, tab: DocTab, page: number, rect: Rect, callout?: Rect): Promise<void> {
  const r = await openDialog({ title: callout ? 'Callout' : 'Text Box', fields: [
    { key: 't', label: 'Text', type: 'textarea', rows: 4, autofocus: true },
    { key: 'font', label: 'Font', type: 'select', options: FONT_OPTIONS, value: 'Helvetica', half: true },
    { key: 'size', label: 'Size (pt)', type: 'number', min: 4, max: 96, value: 12, half: true },
    { key: 'color', label: 'Text color', type: 'color', value: '#000000', half: true },
    { key: 'fill', label: 'Fill', type: 'color', value: '#FFFFE0', half: true },
    { key: 'border', label: 'Border', type: 'checkbox', value: true, half: true },
    { key: 'align', label: 'Align', type: 'select', options: ['left', 'center', 'right'], value: 'left', half: true },
  ], ok: 'Add' });
  if (!r || !String(r.t).trim()) return;
  let box = rect;
  if (box[2] - box[0] < 20 || box[3] - box[1] < 12) box = [rect[0], rect[3] - 24 - String(r.t).split('\n').length * (+r.size || 12) * 1.2, rect[0] + 200, rect[3]];
  const co = callout ? ([callout[0], callout[1], (box[0] + box[2]) / 2, box[3], box[0], box[3]] as [number, number, number, number, number, number]) : undefined;
  app.editTab(tab, callout ? 'Callout' : 'Text Box', (doc) => addFreeText(doc, pageOf(tab, page), box, { text: String(r.t), font: r.font, size: +r.size || 12, textColor: hexToRgb(r.color), fill: hexToRgb(r.fill), border: r.border ? [0.4, 0.4, 0.4] : null, align: r.align, author: author(app), callout: co }));
}

async function noteAt(app: App, tab: DocTab, page: number, x: number, y: number): Promise<void> {
  const r = await openDialog({ title: 'Note', fields: [{ key: 't', label: 'Comment', type: 'textarea', rows: 4, autofocus: true }, { key: 'icon', label: 'Icon', type: 'select', options: ['Comment', 'Note', 'Key', 'Help', 'NewParagraph', 'Paragraph', 'Insert'], value: 'Comment', half: true }, { key: 'color', label: 'Color', type: 'color', value: app.prefs.noteColor, half: true }], ok: 'Add' });
  if (!r) return;
  app.editTab(tab, 'Note', (doc) => addNote(doc, pageOf(tab, page), x, y, { contents: String(r.t), author: author(app), icon: r.icon, color: hexToRgb(r.color) }));
}

async function linkAt(app: App, tab: DocTab, page: number, rect: Rect): Promise<void> {
  const count = tab.doc.pageCount;
  const r = await openDialog({ title: 'Link', fields: [
    { key: 'kind', label: 'Link to', type: 'radio', options: [{ value: 'url', label: 'A web address' }, { value: 'page', label: 'A page in this document' }], value: 'url' },
    { key: 'url', label: 'Address', type: 'text', value: 'https://', visibleIf: (v) => v.kind === 'url' },
    { key: 'page', label: 'Page number', type: 'number', min: 1, max: count, value: 1, visibleIf: (v) => v.kind === 'page' },
    { key: 'border', label: 'Visible border', type: 'checkbox', value: false },
  ], ok: 'Add', validate: (v) => {
    if (v.kind === 'page') return +v.page >= 1 && +v.page <= count && Number.isInteger(+v.page) ? null : `Give a page number from 1 to ${count}.`;
    const u = String(v.url).trim();
    return isSafeExternalUrl(u) && !/^[a-z]+:\/*$/i.test(u) ? null : 'Give a complete web, mail or phone address (https://…, mailto:…, tel:…).';
  } });
  if (!r) return;
  const target = r.kind === 'url' ? { url: String(r.url).trim() } : { page: Math.min(count, Math.max(1, Math.round(+r.page) || 1)) - 1 };
  app.editTab(tab, 'Link', (doc) => addLink(doc, pageOf(tab, page), rect, target, { border: r.border }));
}

/** Places a text stamp, or the picture armed on the Stamp/Sign tool (its image object is created inside the edit). */
function stampAt(app: App, tab: DocTab, page: number, rect: Rect, opts: { text?: string; imageSpec?: ImageSpec; width?: number; height?: number }): void {
  let box = rect;
  const spec = opts.imageSpec;
  if (spec) {
    const iw = opts.width || spec.width || 1, ih = opts.height || spec.height || 1;
    if (box[2] - box[0] < 8) { const w = Math.min(200, iw); box = [rect[0], rect[3] - w * ih / iw, rect[0] + w, rect[3]]; }
    else box = (() => { const f = fitBox(iw, ih, rect); return [f.x, f.y, f.x + f.w, f.y + f.h] as Rect; })();
    app.editTab(tab, 'Stamp', (doc) => addImageStamp(doc, pageOf(tab, page), box, imageXObject(doc, spec), { author: author(app), opacity: app.prefs.stampOpacity }));
    return;
  }
  const text = opts.text || 'Approved';
  if (box[2] - box[0] < 8) box = [rect[0], rect[3] - 36, rect[0] + Math.max(100, text.length * 16), rect[3]];
  app.editTab(tab, 'Stamp', (doc) => addTextStamp(doc, pageOf(tab, page), box, text, { author: author(app), opacity: app.prefs.stampOpacity, color: hexToRgb(app.prefs.penColor, [0.8, 0.1, 0.1]) }));
}

async function attachAt(app: App, tab: DocTab, page: number, x: number, y: number): Promise<void> {
  const [f] = await pickFile('*/*');
  if (!f) return;
  const data = new Uint8Array(await f.arrayBuffer());
  app.editTab(tab, 'Attach File', (doc) => addFileAttachmentAnnot(doc, pageOf(tab, page), x, y, f.name, data, { author: author(app), mime: f.type || 'application/octet-stream' }));
}

function measureLine(app: App, tab: DocTab, page: number, pts: [number, number][]): void {
  if (pts.length < 2) return;
  const len = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const label = formatLength(len, app.prefs.measureUnit, app.prefs);
  const ref = app.editTab(tab, 'Measure', (doc) => addShape(doc, pageOf(tab, page), 'Line', [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])], { points: [pts[0], pts[1]], stroke: penColor(app), width: 1, author: author(app), contents: label, subject: 'Distance' }));
  if (ref) toast(`Distance: ${label}`);
}

function measureArea(app: App, tab: DocTab, page: number, pts: [number, number][]): void {
  if (pts.length < 3) { toast('Click at least three corners, then double-click to finish.'); return; }
  let a = 0, per = 0;
  for (let i = 0; i < pts.length; i++) { const q = pts[i], r = pts[(i + 1) % pts.length]; a += q[0] * r[1] - r[0] * q[1]; per += Math.hypot(r[0] - q[0], r[1] - q[1]); }
  a = Math.abs(a) / 2;
  const scale = app.prefs.measureScale || 1;
  const unit = app.prefs.measureScaleUnit || app.prefs.measureUnit;
  const conv: Record<string, number> = { pt: 1, in: 1 / 72, mm: 25.4 / 72, cm: 2.54 / 72, ft: 1 / 864, m: 0.0254 / 72 };
  const k = conv[unit] ?? 1;
  const label = `Area ${(a * scale * scale * k * k).toFixed(2)} ${unit}², perimeter ${formatLength(per, app.prefs.measureUnit, app.prefs)}`;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const ref = app.editTab(tab, 'Measure Area', (doc) => addShape(doc, pageOf(tab, page), 'Polygon', [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], { points: pts, stroke: penColor(app), fill: null, width: 1, author: author(app), contents: label, subject: 'Area' }));
  if (ref) toast(label, { ms: 5000 });
}

/** The first of Base1, Base2, … that no form field of the document is called yet. */
export function freeFieldName(doc: PdfDocument, base: string): string {
  const existing = new Set(readFields(doc).map((f) => f.name));
  let n = 1;
  while (existing.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function fieldAt(app: App, tab: DocTab, tool: string, page: number, rect: Rect): void {
  const type = tool.slice(6) as NewField['type'] | 'date';
  let box = rect;
  const small = type === 'checkbox' || type === 'radio';
  if (box[2] - box[0] < 6 || box[3] - box[1] < 6) box = small ? [rect[0], rect[3] - 16, rect[0] + 16, rect[3]] : [rect[0], rect[3] - 22, rect[0] + (type === 'signature' ? 200 : 160), rect[3]];
  const base = type === 'date' ? 'Date' : type[0].toUpperCase() + type.slice(1);
  const ref = app.editTab(tab, 'Add Field', (doc) => {
    const spec: NewField = { name: freeFieldName(doc, base), type: type === 'date' ? 'text' : type, page, rect: box, border: [0.5, 0.5, 0.5], tooltip: type === 'date' ? 'Date (YYYY-MM-DD)' : undefined, options: type === 'combo' || type === 'list' ? ['Option 1', 'Option 2'] : undefined, value: type === 'button' ? 'Button' : undefined };
    return addField(doc, spec);
  });
  if (ref) { tab.ui.selectedAnnot = { page, num: ref.num }; setTimeout(() => { if (app.tab === tab) app.exec('forms.properties'); }, 50); }
}

/** The viewer finished a gesture with the current tool. Everything acts on the tab the gesture was made on. */
async function toolDone(app: App, a: { tool: Tool; page: number; start: [number, number]; end: [number, number]; rect: Rect; pts: [number, number][]; click: boolean; opts: any }): Promise<void> {
  const tab = app.tab;
  const t = a.tool;
  const { page, rect } = a;
  pageOf(tab, page);
  switch (t) {
    case 'highlight': case 'underline': case 'strikeout': case 'squiggly': {
      if (a.click) return;
      const kind: MarkupKind = t === 'highlight' ? 'Highlight' : t === 'underline' ? 'Underline' : t === 'strikeout' ? 'StrikeOut' : 'Squiggly';
      markup(app, tab, kind, page, await textRectsIn(tab, page, rect));
      return;
    }
    case 'note': return noteAt(app, tab, page, a.end[0], a.end[1]);
    case 'freetext': return textBox(app, tab, page, rect);
    case 'callout': return textBox(app, tab, page, [a.end[0], a.end[1] - 48, a.end[0] + 180, a.end[1]], [a.start[0], a.start[1], 0, 0]);
    case 'square': case 'circle': {
      if (a.opts?.erase) { const { eraseRect } = await import('./edit'); return eraseRect(app, page, rect, tab); }
      if (rect[2] - rect[0] < 2) return;
      app.editTab(tab, t === 'square' ? 'Rectangle' : 'Ellipse', (doc) => addShape(doc, pageOf(tab, page), t === 'square' ? 'Square' : 'Circle', rect, { stroke: penColor(app), width: app.prefs.penWidth, fill: a.opts?.fill ? hexToRgb(a.opts.fill) : null, author: author(app) }));
      return;
    }
    case 'line': case 'arrow': {
      if (a.click) return;
      app.editTab(tab, t === 'arrow' ? 'Arrow' : 'Line', (doc) => addShape(doc, pageOf(tab, page), 'Line', rect, { points: [a.start, a.end], arrow: t === 'arrow', stroke: penColor(app), width: app.prefs.penWidth, author: author(app) }));
      return;
    }
    case 'polygon': case 'polyline': case 'cloud': {
      if (a.pts.length < 2) return;
      if (a.opts?.measureArea) return measureArea(app, tab, page, a.pts);
      const kind: ShapeKind = t === 'polygon' ? 'Polygon' : t === 'polyline' ? 'PolyLine' : 'Cloud';
      app.editTab(tab, kind, (doc) => addShape(doc, pageOf(tab, page), kind, rect, { points: a.pts, stroke: penColor(app), width: app.prefs.penWidth, author: author(app) }));
      return;
    }
    case 'ink': case 'highlighter': {
      if (a.pts.length < 2) return;
      app.editTab(tab, t === 'ink' ? 'Pen' : 'Highlighter', (doc) => addInk(doc, pageOf(tab, page), [a.pts], { color: t === 'ink' ? penColor(app) : hlColor(app), width: t === 'ink' ? app.prefs.penWidth : Math.max(8, app.prefs.penWidth * 5), highlighter: t === 'highlighter', author: author(app) }));
      return;
    }
    case 'eraser': {
      // Delete ink annotations the stroke touches.
      const touched = (doc: PdfDocument, p: PageInfo) => pageAnnotations(doc, p).filter((an) => an.subtype === 'Ink' && an.ref && a.pts.some((q) => q[0] >= an.rect[0] && q[0] <= an.rect[2] && q[1] >= an.rect[1] && q[1] <= an.rect[3]));
      if (!touched(tab.doc, pageOf(tab, page)).length) return;
      app.editTab(tab, 'Erase Ink', (doc) => { const p = pageOf(tab, page); for (const an of touched(doc, p)) deleteAnnotation(doc, p, an.ref!); });
      return;
    }
    case 'stamp': {
      if (a.opts?.mark) { const { placeMark } = await import('./sign'); if (app.stillOpen(tab) && app.tab === tab) placeMark(app, page, a.end[0], a.end[1] - 14, a.opts.mark); return; }
      if (a.opts?.date) { const { insertText } = await import('../pdf/ops/textedit'); app.editTab(tab, 'Date', (doc) => insertText(doc, pageOf(tab, page), a.end[0], a.end[1] - 10, new Date().toLocaleDateString(), { size: 11, color: [0.06, 0.16, 0.42] })); return; }
      return stampAt(app, tab, page, rect, a.opts || {});
    }
    case 'sign': return stampAt(app, tab, page, rect, a.opts || {});
    case 'link': { if (rect[2] - rect[0] < 4) return; return linkAt(app, tab, page, rect); }
    case 'attach': return attachAt(app, tab, page, a.end[0], a.end[1]);
    case 'redact': {
      if (a.click) return;
      const rects = a.opts?.text ? await textRectsIn(tab, page, rect) : [rect];
      app.editTab(tab, 'Mark for Redaction', (doc) => addRedactMark(doc, pageOf(tab, page), rects, { author: author(app), overlayText: a.opts?.overlayText }));
      return;
    }
    case 'measure': return measureLine(app, tab, page, [a.start, a.end]);
    case 'measureArea': return measureArea(app, tab, page, a.pts);
    case 'zoom': { const { zoomToRect } = await import('./home'); return zoomToRect(app, page, rect, a.click, !!a.opts?.out, tab); }
    case 'snapshot': { const { snapshotRect } = await import('./home'); return snapshotRect(app, page, rect, tab); }
    case 'image': { const { placeImage } = await import('./edit'); return placeImage(app, page, rect, a.opts, tab); }
    case 'text': { const { addTextAt } = await import('./edit'); return addTextAt(app, page, a.end[0], a.end[1], a.click ? undefined : rect, '', tab); }
    case 'erase': { const { eraseRect } = await import('./edit'); return eraseRect(app, page, rect, tab); }
    case 'crop': {
      if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) return;
      const { setPageBox } = await import('../pdf/ops/pages');
      app.editTab(tab, 'Crop Page', (doc) => setPageBox(doc, [page], 'CropBox', rect));
      tab.ui.setTool('select');
      return;
    }
    default:
      if (t.startsWith('field-')) return fieldAt(app, tab, t, page, rect);
  }
}

// ------------------------------------------------------------------------------------------
// Properties and management

async function properties(app: App): Promise<void> {
  const tab = app.tab;
  const s = selectedAnnotation(tab);
  if (!s) { toast('Select an annotation first.'); return; }
  if (s.info.subtype === 'Widget') { app.exec(tab.fillMode ? 'forms.fillValue' : 'forms.properties'); return; }
  const i = s.info;
  const rev = tab.bytes;
  const r = await openDialog({ title: `${annotLabel(i)} Properties`, fields: [
    { key: 'contents', label: 'Comment', type: 'textarea', rows: 4, value: i.contents },
    { key: 'author', label: 'Author', type: 'text', value: i.author, half: true },
    { key: 'subject', label: 'Subject', type: 'text', value: tab.doc.getText(i.dict, 'Subj'), half: true },
    { key: 'color', label: 'Color', type: 'color', value: rgbToHex(i.color, '#ffff00'), half: true },
    { key: 'opacity', label: 'Opacity', type: 'range', min: 0.05, max: 1, step: 0.05, value: i.opacity ?? 1, half: true },
    { key: 'hidden', label: 'Hidden', type: 'checkbox', value: i.hidden, half: true },
    { key: 'i', type: 'info', html: `<p class="ql-help">${esc(i.subtype)} on page ${i.page + 1}${i.date ? `, ${esc(i.date.toLocaleString())}` : ''}. Rect ${i.rect.map((v) => v.toFixed(0)).join(', ')}.</p>` },
  ] });
  if (!r || !app.stillOpen(tab, rev)) return;
  // Only what the dialog changed is written, so an unchanged colour or opacity does not redraw the annotation.
  const props: Parameters<typeof setAnnotationProps>[3] = {};
  if (r.contents !== i.contents) props.contents = r.contents;
  if (r.author !== i.author) props.author = r.author;
  if (r.subject !== tab.doc.getText(i.dict, 'Subj')) props.subject = r.subject;
  if (String(r.color).toLowerCase() !== rgbToHex(i.color, '#ffff00').toLowerCase()) props.color = hexToRgb(r.color);
  if (Math.abs(+r.opacity - (i.opacity ?? 1)) > 1e-6) props.opacity = +r.opacity;
  if (!!r.hidden !== !!i.hidden) props.hidden = !!r.hidden;
  if (!Object.keys(props).length) return;
  app.editTab(tab, 'Annotation Properties', (doc) => setAnnotationProps(doc, pageOf(tab, s.page.index), s.ref, props));
}

const STATES: { label: string; model: 'Review' | 'Marked'; state: string }[] = [
  { label: 'Accepted', model: 'Review', state: 'Accepted' }, { label: 'Rejected', model: 'Review', state: 'Rejected' }, { label: 'Cancelled', model: 'Review', state: 'Cancelled' }, { label: 'Completed', model: 'Review', state: 'Completed' }, { label: 'None', model: 'Review', state: 'None' },
  { label: 'Marked', model: 'Marked', state: 'Marked' }, { label: 'Unmarked', model: 'Marked', state: 'Unmarked' },
];

/**
 * The review status of an annotation: a status is not stored on the annotation itself but on the newest
 * reply to it that carries one (PDF 12.5.6.3).
 */
export function annotationState(annots: AnnotInfo[], ref: Ref): string | undefined {
  let best: AnnotInfo | undefined;
  for (const a of annots) if (a.state && a.irt?.num === ref.num && (!best || (a.date?.getTime() ?? 0) >= (best.date?.getTime() ?? 0))) best = a;
  return best?.state;
}
const selectedState = (app: App): string | undefined => { const s = selectedAnnotation(app); return s ? annotationState(pageAnnotations(app.doc, s.page), s.ref) : undefined; };

/** Reorders the selected annotation within the page's /Annots array. */
function reorder(app: App, toFront: boolean): void {
  const s = selectedAnnotation(app);
  if (!s) return;
  app.edit(toFront ? 'Bring to Front' : 'Send to Back', (doc) => {
    const arr = doc.getArray(s.page.dict, 'Annots');
    const i = arr ? arr.findIndex((x) => x instanceof Ref && x.equals(s.ref)) : -1;
    if (!arr || i < 0 || i === (toFront ? arr.length - 1 : 0)) return NO_CHANGE;
    const [it] = arr.splice(i, 1);
    if (toFront) arr.push(it); else arr.unshift(it);
    const ar = s.page.dict.get('Annots');
    if (ar instanceof Ref) doc.update(ar, arr); else if (s.page.ref) doc.update(s.page.ref, s.page.dict);
    return undefined;
  });
}

/** Comments as the user counts them: no form widgets, links, popup windows. */
const isComment = (a: AnnotInfo): boolean => !['Widget', 'Popup', 'Link'].includes(a.subtype);

function summarize(tab: DocTab): string {
  const every = allAnnotations(tab.doc);
  const all = every.filter(isComment);
  const lines: string[] = [`Comments in ${tab.displayName}`, `${all.filter((a) => !a.irt).length} comment(s), ${all.filter((a) => a.irt).length} repl${all.filter((a) => a.irt).length === 1 ? 'y' : 'ies'}, ${new Set(all.map((a) => a.author).filter(Boolean)).size} author(s)`, ''];
  let page = -1;
  for (const a of all.sort((x, y) => x.page - y.page || y.rect[3] - x.rect[3])) {
    if (a.page !== page) { page = a.page; lines.push(`Page ${page + 1}`, '-'.repeat(12)); }
    const state = a.irt ? a.state : a.ref ? annotationState(every.filter((x) => x.page === a.page), a.ref) : undefined;
    lines.push(`${a.irt ? '  ↳ ' : ''}${annotLabel(a)}${a.author ? ` — ${a.author}` : ''}${a.date ? ` — ${a.date.toLocaleString()}` : ''}${state ? ` [${state}]` : ''}`);
    if (a.contents) lines.push(...a.contents.split('\n').map((l) => `    ${l}`));
  }
  return lines.join('\n');
}

const sel = (app: App): AnnotInfo | null => selectedAnnotation(app)?.info || null;
const TO_PT: Record<string, number> = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, ft: 864, m: 72 / 0.0254 };

def([
  markupCmd('comment.highlight', 'highlight', 'Highlight', 'Highlight', 'ink_highlighter', ['Mod-Alt-h']),
  markupCmd('comment.underline', 'underline', 'Underline', 'Underline', 'format_underlined', ['Mod-Alt-u']),
  markupCmd('comment.strikeout', 'strikeout', 'StrikeOut', 'Strikethrough', 'strikethrough_s', ['Mod-Alt-s']),
  markupCmd('comment.squiggly', 'squiggly', 'Squiggly', 'Squiggly Underline', 'format_color_text', []),
  toolCmd('comment.note', 'note', 'Note', 'add_comment', 'Notes', { keys: ['Mod-Alt-n'], tip: 'Click where a sticky note goes', popular: true }),
  toolCmd('comment.freetext', 'freetext', 'Text Box', 'text_fields', 'Notes', { tip: 'Drag a box for text that shows on the page' }),
  toolCmd('comment.callout', 'callout', 'Callout', 'speaker_notes', 'Notes', { tip: 'Drag from the point of interest to where the text box goes' }),
  toolCmd('comment.pen', 'ink', 'Pen', 'draw', 'Drawing', { keys: ['Mod-Alt-p'], tip: 'Draw freehand ink' }),
  toolCmd('comment.highlighterPen', 'highlighter', 'Highlighter Pen', 'border_color', 'Drawing', { tip: 'Freehand translucent highlighter' }),
  toolCmd('comment.eraser', 'eraser', 'Ink Eraser', 'ink_eraser', 'Drawing', { tip: 'Drag over ink to delete those strokes' }),
  toolCmd('comment.line', 'line', 'Line', 'horizontal_rule', 'Drawing'),
  toolCmd('comment.arrow', 'arrow', 'Arrow', 'north_east', 'Drawing'),
  toolCmd('comment.rectangle', 'square', 'Rectangle', 'rectangle', 'Drawing', {}, () => ({})),
  toolCmd('comment.ellipse', 'circle', 'Ellipse', 'circle', 'Drawing'),
  toolCmd('comment.polygon', 'polygon', 'Polygon', 'pentagon', 'Drawing', { tip: 'Click each corner; double-click or Enter to finish' }, () => ({})),
  toolCmd('comment.polyline', 'polyline', 'Polyline', 'timeline', 'Drawing', { tip: 'Click each point; double-click or Enter to finish' }),
  toolCmd('comment.cloud', 'cloud', 'Cloud', 'cloud', 'Drawing', { tip: 'A revision cloud: click each corner, double-click to finish' }),
  {
    id: 'comment.stamp', label: 'Stamp', icon: 'approval', tab: 'Comment', group: 'Stamps', kind: 'gallery', noRecord: true,
    tip: 'Pick a stamp, then click or drag where it goes',
    menu: () => STAMP_TEXTS.map((t) => ({ id: 'comment.stamp', arg: t, label: t, preview: 'font-weight:700;color:#A6303B;border:2px solid #A6303B;border-radius:4px;padding:1px 6px' })),
    isActive: (app) => app.tab?.ui?.tool === 'stamp' && !!app.viewer.toolOpts?.text,
    run: (app, text?: string) => { app.tab.ui.setTool('stamp', { text: text || 'Approved' }); toast(`Click or drag on the page to place "${text || 'Approved'}".`, { ms: 2500 }); },
  },
  { id: 'comment.customStamp', label: 'Custom Stamp…', icon: 'new_label', tab: 'Comment', group: 'Stamps', noRecord: true, tip: 'A stamp with your own words', run: async (app) => { const tab = app.tab; const t = await promptDialog('Custom Stamp', 'Stamp text', `${app.prefs.initials || ''} ${new Date().toLocaleDateString()}`.trim()); if (t && app.stillOpen(tab)) { tab.ui.setTool('stamp', { text: t }); toast(`Click or drag on the page to place "${t}".`, { ms: 2500 }); } } },
  {
    id: 'comment.imageStamp', label: 'Image Stamp…', icon: 'image', tab: 'Comment', group: 'Stamps', noRecord: true, tip: 'A picture file as a stamp (a logo, a scanned signature)',
    run: async (app) => {
      const tab = app.tab;
      const [f] = await pickFile('image/*');
      if (!f) return;
      const spec = await imageSpecFromFile(f);
      if (!app.stillOpen(tab)) return;
      tab.ui.setTool('stamp', { imageSpec: spec, width: spec.width, height: spec.height });
      toast('Click or drag on the page to place the picture stamp.', { ms: 2500 });
    },
  },
  toolCmd('comment.attachFile', 'attach', 'Attach File', 'attach_file', 'Attach', { tip: 'Click where a file attachment icon goes, then pick the file' }),
  {
    id: 'comment.audio', label: 'Audio Comment', icon: 'mic', tab: 'Comment', group: 'Attach', noRecord: true,
    tip: 'Record a voice note with the microphone; it is attached to the page as a file',
    run: async (app) => {
      const tab = app.tab;
      const page = tab.ui.page;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { toast('Recording is not available in this browser.'); return; }
      let stream: MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { toast('Microphone access was refused.'); return; }
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.start();
      const t0 = Date.now();
      const r = await openDialog({ title: 'Audio Comment', fields: [{ key: 'i', type: 'info', html: '<p>● Recording… Choose Stop when you are done.</p>' }], ok: 'Stop and Attach', cancel: 'Discard' });
      const secs = Math.round((Date.now() - t0) / 1000);
      await new Promise<void>((res) => { rec.onstop = () => res(); try { rec.stop(); } catch { res(); } });
      stream.getTracks().forEach((tr) => tr.stop());
      if (!r) return;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const data = new Uint8Array(await blob.arrayBuffer());
      app.editTab(tab, 'Audio Comment', (doc) => { const p = pageOf(tab, page); return addFileAttachmentAnnot(doc, p, p.cropBox[0] + 24, p.cropBox[3] - 24, `voice-note-${Date.now()}.${/ogg/.test(blob.type) ? 'ogg' : 'webm'}`, data, { author: author(app), mime: blob.type.split(';')[0] || 'audio/webm', contents: `Audio comment (${secs} s)` }); });
    },
  },
  toolCmd('comment.measure', 'measure', 'Measure Distance', 'straighten', 'Measure', { tip: 'Drag between two points; the distance is written on a line annotation' }),
  toolCmd('comment.measureArea', 'polygon', 'Measure Area', 'square_foot', 'Measure', { tip: 'Click the corners of an area; double-click to finish' }, () => ({ measureArea: true })),
  {
    id: 'comment.measureScale', label: 'Measurement Scale…', icon: 'architecture', tab: 'Comment', group: 'Measure', noRecord: true, edits: false,
    tip: 'Set the drawing scale (e.g. 1 in = 10 ft) and the unit shown',
    run: async (app) => {
      const p = app.prefs;
      const scaled = !!p.measureScale && p.measureScale !== 1 && !!TO_PT[p.measureScaleUnit || ''];
      // The stored scale is shown as "1 in on the page = N real units", so pressing OK keeps it.
      const r = await openDialog({ title: 'Measurement Scale', fields: [
        { key: 'unit', label: 'Display unit', type: 'select', options: ['pt', 'in', 'mm', 'cm'], value: p.measureUnit, half: true },
        { key: 'use', label: 'Use a drawing scale', type: 'checkbox', value: scaled },
        { key: 'pageLen', label: 'Length on the page', type: 'number', value: 1, half: true, visibleIf: (v) => v.use }, { key: 'pageUnit', label: 'Page unit', type: 'select', options: ['in', 'mm', 'cm', 'pt'], value: 'in', half: true, visibleIf: (v) => v.use },
        { key: 'realLen', label: 'Equals (real length)', type: 'number', value: scaled ? +(p.measureScale! * 72 / TO_PT[p.measureScaleUnit!]).toPrecision(6) : 10, half: true, visibleIf: (v) => v.use }, { key: 'realUnit', label: 'Real unit', type: 'select', options: ['ft', 'm', 'in', 'mm', 'cm'], value: scaled ? p.measureScaleUnit! : 'ft', half: true, visibleIf: (v) => v.use },
      ], validate: (v) => (!v.use || (+v.pageLen > 0 && +v.realLen > 0) ? null : 'Both lengths must be greater than zero.') });
      if (!r) return;
      p.measureUnit = r.unit;
      if (r.use) { p.measureScale = (+r.realLen * TO_PT[r.realUnit]) / (+r.pageLen * TO_PT[r.pageUnit]); p.measureScaleUnit = r.realUnit; }
      else { p.measureScale = 1; p.measureScaleUnit = ''; }
      app.savePrefs();
    },
  },
  {
    id: 'comment.color', label: 'Color', icon: 'palette', tab: 'Comment', group: 'Style', kind: 'color', noRecord: true,
    tip: 'Color for new highlights, or for new drawings and text marks; with an annotation selected, recolor it',
    value: (app) => app.prefs.penColor,
    // The menu says which of the two colors an entry sets ("hl:" highlights, "pen:" drawings); a bare color follows the armed tool.
    run: async (app, arg?: string) => {
      const tab = app.tab;
      let target: 'hl' | 'pen' | null = null;
      let c = arg;
      const m = /^(hl|pen):(.+)$/.exec(c || '');
      if (m) { target = m[1] as 'hl' | 'pen'; c = m[2]; }
      if (!c) { c = (await colorMenu(app.ui.anchorFor('comment.color'), { highlight: true, title: 'Annotation color' })) || undefined; if (!c || !app.stillOpen(tab)) return; }
      const color = c;
      const s = selectedAnnotation(tab);
      if (s && s.info.subtype !== 'Widget') { app.editTab(tab, 'Annotation Color', (doc) => setAnnotationProps(doc, pageOf(tab, s.page.index), s.ref, { color: hexToRgb(color) })); return; }
      if (!target) target = HIGHLIGHT_COLORS.includes(color.toLowerCase()) && ['highlight', 'highlighter'].includes(tab.ui.tool) ? 'hl' : 'pen';
      if (target === 'hl') app.prefs.highlightColor = color; else app.prefs.penColor = color;
      app.savePrefs(); app.refresh();
    },
    menu: (app) => [
      { heading: 'Highlights' }, ...HIGHLIGHT_COLORS.slice(0, 6).map((c) => ({ id: 'comment.color', arg: `hl:${c}`, label: c, swatch: c, checked: app.prefs.highlightColor.toLowerCase() === c })),
      { separator: true },
      { heading: 'Drawings and text marks' }, ...STANDARD_COLORS.map((c) => ({ id: 'comment.color', arg: `pen:${c}`, label: c, swatch: c, checked: app.prefs.penColor.toLowerCase() === c })),
    ],
  },
  {
    id: 'comment.opacity', label: 'Opacity', icon: 'opacity', tab: 'Comment', group: 'Style', kind: 'menu', noRecord: true,
    menu: (app) => [100, 85, 70, 50, 30].map((o) => ({ id: 'comment.opacity', arg: o / 100, label: `${o}%`, checked: Math.round(((commentSelected(app) ? sel(app)?.opacity : undefined) ?? app.prefs.stampOpacity) * 100) === o })),
    run: (app, o?: number) => { if (o == null) return; const s = selectedAnnotation(app); if (s && s.info.subtype !== 'Widget') app.edit('Opacity', (doc) => setAnnotationProps(doc, s.page, s.ref, { opacity: o })); else { app.prefs.stampOpacity = o; app.savePrefs(); } },
  },
  {
    id: 'comment.lineWidth', label: 'Line Width', icon: 'line_weight', tab: 'Comment', group: 'Style', kind: 'menu', noRecord: true,
    menu: (app) => [0.5, 1, 2, 3, 4, 6, 8].map((w) => ({ id: 'comment.lineWidth', arg: w, label: `${w} pt`, checked: app.prefs.penWidth === w })),
    run: (app, w?: number) => {
      if (w == null) return;
      app.prefs.penWidth = w; app.savePrefs();
      const s = selectedAnnotation(app);
      if (s && s.info.subtype !== 'Widget') app.edit('Line Width', (doc) => setAnnotationProps(doc, s.page, s.ref, { borderWidth: w }));
    },
  },
  { id: 'comment.author', label: 'Author Name…', icon: 'person', tab: 'Comment', group: 'Style', noRecord: true, edits: false, tip: 'The name written on new comments', run: async (app) => { const n = await promptDialog('Author', 'Name on new comments', app.prefs.author); if (n) { app.prefs.author = n; app.savePrefs(); } } },
  { id: 'comment.properties', label: 'Properties…', icon: 'tune', tab: 'Comment', group: 'Manage', keys: ['Mod-i'], noRecord: true, isEnabled: hasAnnotSelected, run: properties },
  {
    id: 'comment.reply', label: 'Reply…', icon: 'reply', tab: 'Comment', group: 'Manage', isEnabled: commentSelected,
    run: async (app) => {
      const tab = app.tab;
      const s = selectedAnnotation(tab);
      if (!s || s.info.subtype === 'Widget') return;
      const t = await promptDialog('Reply', `Reply to ${annotLabel(s.info)}${s.info.author ? ` by ${s.info.author}` : ''}`, '', { type: 'textarea', rows: 3 } as any);
      if (!t) return;
      app.editTab(tab, 'Reply', (doc) => addReply(doc, pageOf(tab, s.page.index), s.ref, t, author(app)));
    },
  },
  {
    id: 'comment.setStatus', label: 'Set Status', icon: 'task_alt', tab: 'Comment', group: 'Manage', kind: 'menu', isEnabled: commentSelected,
    menu: (app) => { const cur = selectedState(app); return STATES.map((st) => ({ id: 'comment.setStatus', arg: st.state, label: st.label, checked: cur === st.state })); },
    run: (app, state?: string) => { const s = selectedAnnotation(app); const st = STATES.find((x) => x.state === state); if (!s || !st || s.info.subtype === 'Widget') return; app.edit('Set Status', (doc) => addReply(doc, s.page, s.ref, `${st.label} set by ${author(app)}`, author(app), { model: st.model, state: st.state })); },
  },
  { id: 'comment.hide', label: 'Hide / Show', icon: 'visibility_off', tab: 'Comment', group: 'Manage', kind: 'toggle', isEnabled: hasAnnotSelected, isActive: (app) => !!sel(app)?.hidden, run: (app) => { const s = selectedAnnotation(app); if (s) app.edit('Hide Annotation', (doc) => setAnnotationProps(doc, s.page, s.ref, { hidden: !s.info.hidden })); } },
  {
    id: 'comment.delete', label: 'Delete', icon: 'delete', tab: 'Comment', group: 'Manage', keys: ['Delete'], isEnabled: hasAnnotSelected,
    run: (app) => {
      const s = selectedAnnotation(app);
      if (!s) return;
      // A form field is more than its widget: Forms ▸ Delete Field removes it from the form as well.
      if (s.info.subtype === 'Widget') { app.exec('forms.deleteField'); return; }
      if (app.edit('Delete Annotation', (doc) => { deleteAnnotation(doc, s.page, s.ref); return true; })) app.tab.ui.selectedAnnot = null;
    },
  },
  {
    id: 'comment.deleteAll', label: 'Delete All Comments', icon: 'comments_disabled', tab: 'Comment', group: 'Manage',
    run: async (app) => {
      const tab = app.tab;
      const page = tab.ui.page;
      const count = (onPage: boolean) => allAnnotations(tab.doc).filter((a) => isComment(a) && !a.irt && (!onPage || a.page === page)).length;
      if (!allAnnotations(tab.doc).some((a) => !['Widget', 'Link'].includes(a.subtype) && a.ref)) { toast('There are no comments.'); return; }
      const r = await openDialog({ title: 'Delete All Comments', fields: [{ key: 'scope', label: 'Delete', type: 'radio', options: [{ value: 'page', label: `On this page (${count(true)})` }, { value: 'all', label: `In the whole document (${count(false)})` }], value: 'page' }], help: 'Replies are deleted with the comments they answer.', ok: 'Delete' });
      if (!r) return;
      const done = app.editTab(tab, 'Delete All Comments', (doc) => {
        const pages = doc.pages;
        const all = allAnnotations(doc).filter((a) => !['Widget', 'Link'].includes(a.subtype) && a.ref && (r.scope === 'all' || a.page === page));
        if (!all.length) return NO_CHANGE;
        for (const a of all) deleteAnnotation(doc, pages[a.page], a.ref!);
        return true;
      });
      if (done) tab.ui.selectedAnnot = null;
    },
  },
  {
    id: 'comment.summarize', label: 'Summarize Comments', icon: 'summarize', tab: 'Comment', group: 'Manage', edits: false, noRecord: true,
    tip: 'A list of every comment by page, to copy, save as text or add as pages at the end',
    run: async (app) => {
      const tab = app.tab;
      const text = summarize(tab);
      const r = await openDialog({ title: 'Comment Summary', wide: true, fields: [{ key: 't', type: 'textarea', rows: 18, value: text, label: 'Summary' }], ok: 'Save as Text…', cancel: 'Close', buttons: [
        { label: 'Copy', onClick: (v) => { navigator.clipboard?.writeText(String(v.t)); toast('Copied'); } },
        { label: 'Append as Pages', onClick: async (v, ctl) => { ctl.close(null); const { addTextPages } = await import('../pdf/build'); app.editTab(tab, 'Comment Summary Pages', (doc) => addTextPages(doc, String(v.t), { title: 'Comment Summary', font: 'Helvetica', size: 10 })); } },
      ] });
      if (r) await saveBytes(String(r.t), `${baseName(tab)} comments.txt`, 'text/plain');
    },
  },
  {
    id: 'comment.importXfdf', label: 'Import Comments (XFDF)', icon: 'download', tab: 'Comment', group: 'Manage', tip: 'Add the annotations from an XFDF file (another reviewer\'s comments)',
    run: async (app) => {
      const tab = app.tab;
      const [f] = await pickFile('.xfdf,.xml,.fdf');
      if (!f) return;
      const xml = await f.text();
      const n = app.editTab(tab, 'Import Comments', (doc) => importXfdf(doc, xml) || NO_CHANGE);
      toast(n ? `${n} comment(s) imported.` : 'No comments were found in that file.');
    },
  },
  { id: 'comment.exportXfdf', label: 'Export Comments (XFDF)', icon: 'ios_share', tab: 'Comment', group: 'Manage', edits: false, noRecord: true, run: (app) => saveBytes(exportXfdf(app.doc, app.tab.fileName), `${baseName(app)}.xfdf`, 'application/vnd.adobe.xfdf') },
  {
    id: 'comment.flatten', label: 'Flatten Comments', icon: 'layers_clear', tab: 'Comment', group: 'Manage', tip: 'Draw every comment into the page content so any reader shows it and nobody can move it',
    run: async (app) => {
      const tab = app.tab;
      const page = tab.ui.page;
      const r = await openDialog({ title: 'Flatten Comments', fields: [{ key: 'scope', label: 'Flatten', type: 'radio', options: [{ value: 'page', label: 'This page' }, { value: 'all', label: 'All pages' }], value: 'all' }, { key: 'notes', label: 'Include sticky notes (their icons)', type: 'checkbox', value: false }], ok: 'Flatten' });
      if (!r) return;
      const n = app.editTab(tab, 'Flatten Comments', (doc) => { let k = 0; for (const p of doc.pages) if (r.scope === 'all' || p.index === page) k += flattenAnnotations(doc, p, (a) => a.subtype !== 'Widget' && a.subtype !== 'Link' && (r.notes || a.subtype !== 'Text')); return k || NO_CHANGE; });
      toast(`${n || 0} annotation(s) flattened.`);
    },
  },
  { id: 'comment.flattenOne', label: 'Flatten This Annotation', icon: 'layers_clear', tab: 'Comment', group: 'Arrange', isEnabled: commentSelected, run: (app) => { const s = selectedAnnotation(app); if (!s || s.info.subtype === 'Widget') return; if (app.edit('Flatten Annotation', (doc) => flattenAnnotations(doc, s.page, (a) => !!a.ref && a.ref.equals(s.ref)) || NO_CHANGE)) app.tab.ui.selectedAnnot = null; } },
  {
    id: 'comment.duplicate', label: 'Duplicate', icon: 'content_copy', tab: 'Comment', group: 'Arrange', keys: ['Mod-d'], isEnabled: commentSelected,
    run: (app) => {
      const s = selectedAnnotation(app);
      if (!s || s.info.subtype === 'Widget') return;
      const ref = app.edit('Duplicate Annotation', (doc) => duplicateAnnotation(doc, s.page, s.ref, 12, -12));
      if (ref) app.tab.ui.selectedAnnot = { page: s.page.index, num: ref.num };
    },
  },
  { id: 'comment.toFront', label: 'Bring to Front', icon: 'flip_to_front', tab: 'Comment', group: 'Arrange', isEnabled: hasAnnotSelected, run: (app) => reorder(app, true) },
  { id: 'comment.toBack', label: 'Send to Back', icon: 'flip_to_back', tab: 'Comment', group: 'Arrange', isEnabled: hasAnnotSelected, run: (app) => reorder(app, false) },
  {
    id: 'comment.link', label: 'Link', icon: 'link', tab: 'Comment', group: 'Links', kind: 'toggle', noRecord: true,
    tip: 'Make the selected text a link, or drag a rectangle to link',
    isActive: (app) => app.tab?.ui?.tool === 'link',
    run: (app) => { const sr = app.viewer.selectionRects; if (sr && sr.rects.length) { const xs = sr.rects.flatMap((r) => [r[0], r[2]]), ys = sr.rects.flatMap((r) => [r[1], r[3]]); void linkAt(app, app.tab, sr.page, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]); app.viewer.clearSelection(); return; } app.tab.ui.setTool('link'); },
  },
  { id: 'comment.moveAnnotation', label: 'Move Annotation', icon: 'open_with', tab: 'Comment', group: 'Arrange', internal: true, noRecord: true, run: (app, a: { page: number; num: number; rect: Rect }) => { const p = pageOf(app, a.page); const ref = new Ref(a.num, app.doc.genOf(a.num)); app.edit('Move Annotation', (doc) => setAnnotationProps(doc, p, ref, { rect: a.rect })); } },
  // Not an edit by itself: zoom and snapshot gestures arrive here too, and every change it makes goes through the tab's own read-only check.
  { id: 'comment.toolDone', label: 'Finish Tool Gesture', icon: 'done', tab: 'Comment', group: 'Manage', internal: true, noRecord: true, edits: false, run: (app, a) => toolDone(app, a) },
  {
    id: 'comment.nextComment', label: 'Next Comment', icon: 'skip_next', tab: 'Comment', group: 'Manage', keys: ['Mod-Alt-ArrowRight'], noRecord: true, edits: false,
    run: (app) => step(app, 1),
  },
  { id: 'comment.prevComment', label: 'Previous Comment', icon: 'skip_previous', tab: 'Comment', group: 'Manage', keys: ['Mod-Alt-ArrowLeft'], noRecord: true, edits: false, run: (app) => step(app, -1) },
  {
    id: 'comment.markupFromText', label: 'Mark Up Selected Text with a Note', icon: 'rate_review', tab: 'Comment', group: 'Text Markup', isEnabled: (app) => !!selectedText(app),
    tip: 'Highlight the selection and attach a comment to it',
    run: async (app) => { const tab = app.tab; const sr = viewer(tab).selectionRects; if (!sr) return; const t = await promptDialog('Comment on Selection', `"${selectedText(tab).slice(0, 60)}…"`, '', { type: 'textarea', rows: 3 } as any); if (t == null) return; markup(app, tab, 'Highlight', sr.page, sr.rects, t); viewer(tab).clearSelection(); },
  },
]);

function step(app: App, dir: 1 | -1): void {
  const all = allAnnotations(app.doc).filter((a) => a.ref && !['Widget', 'Popup', 'Link'].includes(a.subtype) && !a.irt).sort((x, y) => x.page - y.page || y.rect[3] - x.rect[3]);
  if (!all.length) { toast('There are no comments.'); return; }
  const cur = app.tab.ui.selectedAnnot;
  let i = cur ? all.findIndex((a) => a.ref!.num === cur.num) : -1;
  i = i < 0 ? (dir > 0 ? 0 : all.length - 1) : (i + dir + all.length) % all.length;
  const a = all[i];
  app.tab.ui.selectedAnnot = { page: a.page, num: a.ref!.num };
  app.tab.ui.goToPage(a.page, a.rect[3] + 40);
  app.tab.ui.refreshAnnotations();
  app.refresh();
}

export { toolDone, markup, confirmDialog, type MenuEntry };
