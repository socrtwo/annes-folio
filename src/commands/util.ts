/** Helpers shared by the command modules (no commands are defined here). */
import type { App, DocTab } from '../app';
import { PdfDocument, type PageInfo } from '../pdf/document';
import { PdfStream, type Ref } from '../pdf/objects';
import { pageAnnotations, type AnnotInfo } from '../pdf/structure';
import { imageXObject, jpegInfo, type ImageSpec } from '../pdf/build';
import type { ImageInfo } from '../pdf/ops/optimize';
import { extractImage, rawToRgba } from '../pdf/ops/extract';
import { openDialog, toast } from '../ui/dialog';
import { saveAs } from '../platform/native';
import { parseRanges } from '../pdf/ops/pages';
import type { Viewer } from '../view/viewer';

export type RGB = [number, number, number];
export type Rect = [number, number, number, number];

/** What a helper works on: the app (its active tab) or a tab captured before an await. */
export type Ctx = App | DocTab;
export const tabOf = (c: Ctx): DocTab => ('docs' in c ? c.active : c);
export const viewerOf = (tab: DocTab): Viewer => tab.ui as unknown as Viewer;

export const toBlob = (data: Uint8Array | string, mime: string): Blob => new Blob([data as BlobPart], { type: mime });

/** A name from a document or a file made safe as a file or ZIP entry name (no path parts, no control characters). */
export function safeName(name: unknown, fallback = 'file'): string {
  // eslint-disable-next-line no-control-regex
  const s = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 180);
  return s || fallback;
}

/** The document's base file name without extension. */
export const baseName = (c: Ctx): string => { const t = tabOf(c); return safeName((t.fileName || t.title || 'Document').replace(/\.[^.]+$/, ''), 'Document'); };

/** Saves bytes produced by an export with the system save dialog. False when the user cancelled. */
export async function saveBytes(data: Uint8Array | string, name: string, mime: string): Promise<boolean> {
  const r = await saveAs(toBlob(data, mime), safeName(name));
  if (r) toast(`Saved ${r.name}`);
  return !!r;
}

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** '#rrggbb' → [r, g, b] in 0..1. */
export function hexToRgb(hex: string, fallback: RGB = [0, 0, 0]): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(c: RGB | null | undefined, fallback = '#000000'): string {
  if (!c) return fallback;
  return '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export const viewer = (c: Ctx): Viewer => viewerOf(tabOf(c));

/** Pages the organize commands act on: the thumbnail selection, or the current page. */
export function targetPages(c: Ctx): number[] { return viewer(c).targetPages(); }

export function currentPage(c: Ctx): PageInfo {
  const t = tabOf(c);
  const p = t.doc.pages[t.ui?.page ?? 0] || t.doc.pages[0];
  if (!p) throw new Error('The document has no pages.');
  return p;
}

/** The selected annotation (object number from the viewer) as engine data. */
export function selectedAnnotation(c: Ctx): { page: PageInfo; ref: Ref; info: AnnotInfo } | null {
  const t = tabOf(c);
  const s = t?.ui?.selectedAnnot;
  if (!s) return null;
  const page = t.doc.pages[s.page];
  if (!page) return null;
  const info = pageAnnotations(t.doc, page).find((a) => a.ref?.num === s.num);
  return info && info.ref ? { page, ref: info.ref, info } : null;
}

export const hasAnnotSelected = (app: App): boolean => !!selectedAnnotation(app);

/** Dialog field for a page range ("1-3, 7, 9-") and its parsing. */
export function rangeField(c: Ctx, key = 'range', label = 'Pages'): { key: string; label: string; type: 'text'; value: string; help: string } {
  const t = tabOf(c);
  const sel = viewerOf(t).pageSel;
  const value = sel.length > 1 ? compressRange(sel) : String((t.ui?.page ?? 0) + 1);
  return { key, label, type: 'text', value, help: `1-${t.doc.pageCount}; e.g. "1-3, 7, 9-" (odd/even allowed)` };
}

/**
 * Checks a page range part by part ("1 - 3, 7; 9–", odd, even). Returns it in the plain form
 * parseRanges reads ("1-3,7,9-10") and the parts that name no page of the document.
 */
export function normalizeRange(spec: string, count: number): { spec: string; bad: string[] } {
  const ok: string[] = [], bad: string[] = [];
  for (const raw of String(spec || '').split(/[,;]/)) {
    const part = raw.trim().replace(/[‐-―−]/g, '-').toLowerCase();
    if (!part) continue;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (part === 'odd' || part === 'even') ok.push(part);
    else if (part === 'all') ok.push(`1-${count}`);
    else if (m && (m[1] || m[2])) {
      let a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : count;
      if (a > b) [a, b] = [b, a];
      if (a > count || b < 1) bad.push(raw.trim()); else ok.push(`${Math.max(1, a)}-${Math.min(count, b)}`);
    } else if (/^\d+$/.test(part) && +part >= 1 && +part <= count) ok.push(String(+part));
    else bad.push(raw.trim());
  }
  return { spec: ok.join(','), bad };
}

/** Page indexes for a range typed by the user. Throws with what was wrong instead of guessing. */
export function pagesFromRange(c: Ctx, spec: string): number[] {
  const doc = tabOf(c).doc;
  const n = doc.pageCount;
  const s = String(spec || '').trim();
  if (!s || s.toLowerCase() === 'all') return doc.pages.map((_, i) => i);
  const { spec: norm, bad } = normalizeRange(s, n);
  if (bad.length) throw new Error(`${bad.map((b) => `"${b}"`).join(', ')} ${bad.length > 1 ? 'are' : 'is'} not a page or range of this document (${n} page${n === 1 ? '' : 's'}). Write ranges like 1-3, 7, 9-.`);
  const r = norm ? parseRanges(norm, n) : [];
  if (!r.length) throw new Error(`No pages match "${spec}".`);
  return r;
}
export function compressRange(pages: number[]): string {
  const p = [...pages].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < p.length; i++) { let j = i; while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++; out.push(j > i ? `${p[i] + 1}-${p[j] + 1}` : String(p[i] + 1)); i = j; }
  return out.join(', ');
}

/** Asks for a page range (defaulting to the selection) and returns page indexes. A range that does not parse keeps the dialog open. */
export async function askPages(c: Ctx, title: string, extra: any[] = [], ok = 'OK'): Promise<{ pages: number[]; values: Record<string, any> } | null> {
  const tab = tabOf(c);
  const r = await openDialog({ title, fields: [rangeField(tab), ...extra], ok, validate: (v) => { try { pagesFromRange(tab, v.range); return null; } catch (e: any) { return e?.message || String(e); } } });
  if (!r) return null;
  return { pages: pagesFromRange(tab, r.range), values: r };
}

/** Runs fn(doc) as one undoable step on the active document. */
export function edit<T>(app: App, label: string, fn: (doc: PdfDocument) => T): T | undefined {
  return app.edit(label, (doc) => fn(doc));
}

/**
 * True while `tab` is still open and, when `rev` is given (its `bytes` taken before an await), unchanged
 * since then. Says why not otherwise, so a slow command never writes into another document or over newer edits.
 */
export function stillCurrent(app: App, tab: DocTab, rev?: Uint8Array): boolean {
  if (!app.docs.includes(tab)) { toast(`"${tab.displayName}" was closed; nothing was changed.`); return false; }
  if (rev && tab.bytes !== rev) { toast(`"${tab.displayName}" changed while this was running; nothing was applied. Run it again.`, { ms: 6000 }); return false; }
  return true;
}

/** One undoable step on a tab captured before an await (the active tab may have changed since). */
export function editTab<T>(app: App, tab: DocTab, label: string, fn: (doc: PdfDocument) => T): T | undefined {
  if (!stillCurrent(app, tab)) return undefined;
  if (tab.readOnly) { toast('This document is read-only.'); return undefined; }
  return tab.edit(label, () => fn(tab.doc));
}

/** Runs a dialog-button handler; a failure becomes a toast instead of an unreported error. */
export function guarded(label: string, fn: () => unknown): void {
  const report = (e: any) => { console.error(e); toast(`${label}: ${e?.message || e}`, { ms: 6000 }); };
  try { const r = fn(); if (r instanceof Promise) r.catch(report); } catch (e) { report(e); }
}

export function pageOf(c: Ctx, i: number): PageInfo {
  const p = tabOf(c).doc.pages[i];
  if (!p) throw new Error(`Page ${i + 1} does not exist.`);
  return p;
}

/** The text selected in the viewer, or an empty string. */
export const selectedText = (c: Ctx): string => tabOf(c)?.ui?.selectedText || '';

/** Loads a copy of the document (for exports that must not alter it). */
export async function docCopy(c: Ctx): Promise<PdfDocument> {
  const t = tabOf(c);
  return PdfDocument.load(t.bytes, { password: t.password || undefined });
}

/** Opens freshly written bytes as a new, unsaved document. */
export function openAsNewTab(app: App, bytes: Uint8Array, title: string): DocTab {
  const name = safeName(title, 'Document');
  const t = app.createTab(PdfDocument.load(bytes), { title: name, fileName: `${name}.pdf` }, bytes);
  t.dirty = true;
  return t;
}

/** Builds a PNG (or JPEG) blob of a page through the viewer's renderer. */
export async function pageImage(c: Ctx, i: number, dpi: number, format: 'png' | 'jpeg' = 'png', quality = 0.9): Promise<Blob> {
  const png = await viewer(c).renderPagePng(i, dpi);
  if (format === 'png') return png;
  const bmp = await createImageBitmap(png);
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page'))), 'image/jpeg', quality));
}

/**
 * Decodes a picture file for the engine (JPEG kept as is, everything else via canvas). It does not touch any
 * document: the caller creates the XObject with imageXObject(doc, spec) inside its edit, so a cancelled or
 * undone placement leaves nothing behind in the file.
 */
export async function imageSpecFromFile(file: Blob): Promise<ImageSpec> {
  const { imageSpecFromBytes, uprightImageSpec } = await import('../io');
  // A stamp or signature is placed by its pixel box, so a photo that is only turned by its EXIF tag is redrawn upright first.
  return uprightImageSpec(await imageSpecFromBytes(new Uint8Array(await file.arrayBuffer()), file.type === 'image/jpeg' ? 'jpeg' : undefined));
}

/** The picture on the system clipboard, if the platform lets the page read one. */
export async function clipboardImage(): Promise<Blob | null> {
  try {
    const items = await (navigator.clipboard as any).read?.();
    for (const it of items || []) { const t = it.types.find((x: string) => x.startsWith('image/')); if (t) return await it.getType(t); }
  } catch { /* no image access */ }
  return null;
}

/**
 * Re-encodes an image XObject as a JPEG at most maxPx on its longest side. Null when the image cannot be
 * decoded here, is a stencil mask or has a mask (a JPEG cannot carry either), has a /Decode array (the canvas
 * would bake the undecoded samples in), or would not get smaller.
 */
export async function recompressedJpeg(doc: PdfDocument, im: ImageInfo, maxPx: number, quality: number, gray = false): Promise<Uint8Array | null> {
  if (!im.ref || im.hasMask || doc.resolve(im.stream.dict.get('ImageMask')) === true || im.stream.dict.has('Decode')) return null;
  const ex = extractImage(doc, im);
  let bmp: ImageBitmap;
  if (ex.kind === 'jpeg') bmp = await createImageBitmap(new Blob([ex.data as BlobPart], { type: 'image/jpeg' }));
  else { const rgba = rawToRgba(doc, ex); if (!rgba) return null; bmp = await createImageBitmap(new ImageData(rgba as any, ex.width, ex.height)); }
  const s = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); if (gray) ctx.filter = 'grayscale(1)'; ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', quality));
  c.width = c.height = 0;
  if (!blob) return null;
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  return jpegInfo(jpeg) && jpeg.length < im.bytes * 0.95 ? jpeg : null;
}

/** Puts a recompressed JPEG in place of an image XObject (same object number, so every use follows). */
export function replaceImageWithJpeg(doc: PdfDocument, ref: Ref, jpeg: Uint8Array): void {
  const info = jpegInfo(jpeg)!;
  const nr = imageXObject(doc, { kind: 'jpeg', data: jpeg, width: info.width, height: info.height, gray: info.components === 1 });
  const fresh = doc.resolve<PdfStream>(nr), old = doc.resolve<PdfStream | null>(ref);
  // What says when and how the image is shown stays with it: its layer, alternate text, structure link, smoothing.
  if (old instanceof PdfStream && fresh instanceof PdfStream) for (const k of ['OC', 'Alt', 'StructParent', 'Interpolate']) { const v = old.dict.get(k); if (v !== undefined && v !== null) fresh.dict.set(k, v); }
  doc.update(ref, fresh); doc.remove(nr);
}

/** Fits an image into a box (points), centered. */
export function fitBox(w: number, h: number, box: Rect): { x: number; y: number; w: number; h: number } {
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const s = Math.min(bw / w, bh / h);
  const fw = w * s, fh = h * s;
  return { x: box[0] + (bw - fw) / 2, y: box[1] + (bh - fh) / 2, w: fw, h: fh };
}

/**
 * The `cm` matrix that draws a unit-square image w×h points large and upright as the reader sees the page,
 * its lower-left corner (x, y) points from the lower-left corner of the visible page. It follows the page's
 * crop box and /Rotate, so the same position works on portrait, landscape and rotated pages.
 */
export function uprightMatrix(p: { cropBox: Rect; rotate: number }, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  const [x0, y0, x1, y1] = p.cropBox;
  switch (((p.rotate % 360) + 360) % 360) {
    case 90: return [0, w, -h, 0, x1 - y, y0 + x];
    case 180: return [-w, 0, 0, -h, x1 - x, y1 - y];
    case 270: return [0, -w, h, 0, x0 + y, y1 - x];
    default: return [w, 0, 0, h, x0 + x, y0 + y];
  }
}

export const FONT_OPTIONS = ['Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Times-Bold', 'Courier'];

/** Entry names made safe and unique: a second "a.pdf" becomes "a (2).pdf" instead of replacing the first. */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const safe = safeName(n);
    const dot = safe.lastIndexOf('.');
    const base = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
    let name = safe;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base} (${k})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export function zipOf(files: { name: string; data: Uint8Array | string | Blob }[]): Promise<Uint8Array> {
  return import('jszip').then(async ({ default: JSZip }) => {
    const z = new JSZip();
    const names = uniqueNames(files.map((f) => f.name));
    files.forEach((f, i) => z.file(names[i], f.data));
    return z.generateAsync({ type: 'uint8array', streamFiles: true });
  });
}

/**
 * Parses CSV text into rows of cells (RFC 4180: quoted cells may hold commas, doubled quotes and line
 * breaks). A leading byte-order mark and blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, wasQuoted = false;
  const endRow = () => { row.push(cell); if (row.length > 1 || row[0] !== '' || wasQuoted) rows.push(row); row = []; cell = ''; wasQuoted = false; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') { quoted = true; wasQuoted = true; }
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; endRow(); }
    else cell += ch;
  }
  if (cell !== '' || row.length || wasQuoted) endRow();
  return rows;
}

/** Field name → value from a CSV whose first row holds the names and second the values. Only cells present in the data row are returned. */
export function csvFormData(text: string): Record<string, string> | null {
  const rows = parseCsv(text);
  if (rows.length < 2) return null;
  const out: Record<string, string> = {};
  rows[0].forEach((k, i) => { const name = k.trim(); if (name && i < rows[1].length) out[name] = rows[1][i]; });
  return out;
}
