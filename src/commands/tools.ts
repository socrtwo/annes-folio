/** Tools tab: optimize, extract, inspect, bookmarks, attachments, batch, convert, XMP. */
import { def } from './registry';
import type { App } from '../app';
import { PdfDocument } from '../pdf/document';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { pickFile, h } from '../ui/dom';
import { Dict, Name, PdfStream, Ref, PdfString } from '../pdf/objects';
import { readOutlines, writeOutlines, outlinesToInput, readAttachments, addAttachment, removeAttachment, readMetadata, writeMetadata, type OutlineItem, type OutlineInput, type Attachment } from '../pdf/structure';
import { listImages, listFonts, sanitize, archivalCheck } from '../pdf/ops/optimize';
import { extractImage, rawToRgba, imageName, pageTextRuns, tablesFromRuns, toCsv, textToMarkdown, linesFromRuns } from '../pdf/ops/extract';
import { addWatermark, addBates } from '../pdf/ops/pages';
import { flattenAnnotations } from '../pdf/ops/annots';
import { flattenForm } from '../pdf/ops/forms';
import { openAsPdf } from '../io';
import { replaceWithBytes, confirmRewrite } from './file';
import { saveBytes, baseName, zipOf, pageOf, viewerOf, esc, docCopy, askPages, hexToRgb, editTab, stillCurrent, guarded, openAsNewTab, recompressedJpeg, replaceImageWithJpeg, safeName, tabOf, type Ctx } from './util';
import { newOwnerPassword, showGeneratedPassword } from './protect';
import { remember } from './nav';

/** Image bytes (JPEG as stored, else PNG through a canvas) for every image, for extraction. */
async function imageFiles(doc: PdfDocument, pages?: Set<number>): Promise<{ name: string; data: Uint8Array }[]> {
  const out: { name: string; data: Uint8Array }[] = [];
  const imgs = listImages(doc).filter((im) => !pages || pages.has(im.page));
  for (const [i, im] of imgs.entries()) {
    try {
      const ex = extractImage(doc, im);
      if (ex.kind === 'jpeg' || ex.kind === 'jp2') { out.push({ name: imageName(im, i), data: ex.data }); continue; }
      const rgba = rawToRgba(doc, ex);
      if (!rgba) continue;
      const c = document.createElement('canvas'); c.width = ex.width; c.height = ex.height;
      c.getContext('2d')!.putImageData(new ImageData(rgba as any, ex.width, ex.height), 0, 0);
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
      if (blob) out.push({ name: imageName(im, i), data: new Uint8Array(await blob.arrayBuffer()) });
    } catch (e) { console.warn('extract image', e); }
  }
  return out;
}

/** Downsamples every raster image larger than maxPx on its longest side to JPEG (in place; callers pass a copy of the document). */
async function downsampleImages(doc: PdfDocument, maxPx: number, quality: number): Promise<number> {
  let n = 0;
  for (const im of listImages(doc)) {
    if (!im.ref || Math.max(im.width, im.height) <= maxPx) continue;
    try {
      const jpeg = await recompressedJpeg(doc, im, maxPx, quality);
      if (jpeg) { replaceImageWithJpeg(doc, im.ref, jpeg); n++; }
    } catch (e) { console.warn('downsample', e); }
  }
  return n;
}

async function optimize(app: App, preset?: { images?: number; quality?: number; sanitize?: boolean }): Promise<void> {
  const tab = app.tab;
  if (tab.readOnly) { toast('This document is read-only.'); return; }
  const before = tab.bytes.length;
  let r: any = preset ? { unused: true, recompress: true, objstm: true, images: preset.images ? 'yes' : 'no', maxPx: preset.images || 1500, q: preset.quality || 0.75, meta: !!preset.sanitize, thumbs: true } : null;
  if (!r) {
    r = await openDialog({ title: 'Optimize PDF', fields: [
      { key: 'i', type: 'info', html: `<p class="ql-help">Current size: ${(before / 1024).toFixed(0)} KB. The document is rewritten in memory; Save writes the result.</p>` },
      { key: 'unused', label: 'Drop unused objects and earlier versions', type: 'checkbox', value: true, half: true },
      { key: 'recompress', label: 'Recompress content streams', type: 'checkbox', value: true, half: true },
      { key: 'objstm', label: 'Pack objects into object streams', type: 'checkbox', value: true, half: true },
      { key: 'thumbs', label: 'Remove embedded page thumbnails', type: 'checkbox', value: true, half: true },
      { key: 'images', label: 'Downsample large images', type: 'select', options: [{ value: 'no', label: 'Keep images as they are' }, { value: 'yes', label: 'Downsample to a longest side of…' }], value: 'no', half: true },
      { key: 'maxPx', label: 'Pixels', type: 'number', min: 200, max: 8000, value: 1500, half: true, visibleIf: (v) => v.images === 'yes' },
      { key: 'q', label: 'JPEG quality', type: 'range', min: 0.3, max: 0.95, step: 0.05, value: 0.75, visibleIf: (v) => v.images === 'yes' },
      { key: 'meta', label: 'Remove metadata and private application data', type: 'checkbox', value: false },
    ], ok: 'Optimize' });
    if (!r) return;
  }
  if (!(await confirmRewrite(tab, 'Optimizing'))) return;
  // The result replaces exactly the document it was made from: `rev` catches edits made, and the tab check a
  // switch to another tab, while the images are being re-encoded.
  const rev = tab.bytes;
  app.ui.status?.('● Optimizing…');
  let bytes: Uint8Array, imgs = 0;
  try {
    const copy = PdfDocument.load(rev, { password: tab.password || undefined });
    if (r.images === 'yes') imgs = await downsampleImages(copy, +r.maxPx || 1500, +r.q || 0.75);
    if (r.thumbs || r.meta) sanitize(copy, { thumbnails: !!r.thumbs, metadata: !!r.meta, privateData: !!r.meta });
    bytes = copy.save({ incremental: false, recompress: !!r.recompress, objectStreams: !!r.objstm, keepUnused: !r.unused });
  } finally { app.ui.status?.(''); }
  if (!stillCurrent(app, tab, rev) || !replaceWithBytes(app, tab, bytes)) return;
  toast(`Optimized: ${(before / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB${imgs ? `, ${imgs} image(s) downsampled` : ''}. Save to keep it.`, { ms: 8000 });
}

/** Finds an outline item by its object reference in a tree. */
function findItem(items: OutlineItem[], ref: Ref | null): { list: OutlineItem[]; index: number } | null {
  if (!ref) return null;
  for (let i = 0; i < items.length; i++) { if (items[i].ref?.equals(ref)) return { list: items, index: i }; const r = findItem(items[i].children, ref); if (r) return r; }
  return null;
}

/** Heading candidates from font sizes: lines noticeably larger than the page's common size. */
export function headingsFromText(doc: PdfDocument): { title: string; page: number; y: number; level: number }[] {
  const out: { title: string; page: number; y: number; size: number }[] = [];
  const sizes: number[] = [];
  // Every page is parsed once; the second pass works on the kept runs.
  const pageRuns = doc.pages.map((_, i) => pageTextRuns(doc, i).filter((r) => r.text.trim()));
  for (const runs of pageRuns) for (const r of runs) sizes.push(Math.round(r.size));
  if (!sizes.length) return [];
  const counts = new Map<number, number>(); for (const s of sizes) counts.set(s, (counts.get(s) || 0) + 1);
  const body = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  pageRuns.forEach((all, i) => {
    const runs = all.filter((r) => r.text.trim() && r.size >= body * 1.2 && r.text.trim().length > 2 && r.text.trim().length < 120);
    // Merge runs on the same line.
    const lines: { y: number; size: number; parts: { x: number; text: string }[] }[] = [];
    for (const r of runs) { const l = lines.find((x) => Math.abs(x.y - r.y) < r.size * 0.5); if (l) l.parts.push({ x: r.x, text: r.text }); else lines.push({ y: r.y, size: r.size, parts: [{ x: r.x, text: r.text }] }); }
    for (const l of lines) out.push({ title: l.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim(), page: i, y: l.y + l.size, size: l.size });
  });
  const distinct = [...new Set(out.map((o) => Math.round(o.size)))].sort((a, b) => b - a);
  return out.map((o) => ({ title: o.title, page: o.page, y: o.y, level: Math.min(2, distinct.indexOf(Math.round(o.size))) }));
}

/** Word shingles for a document-similarity estimate. */
function shingles(text: string, k = 5): Set<string> {
  const w = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(' '));
  return s;
}

def([
  { id: 'tools.optimize', label: 'Optimize…', icon: 'tune', tab: 'Tools', group: 'Optimize', popular: true, tip: 'Rewrite the file smaller: drop unused objects, recompress, pack object streams, downsample images', run: (app) => optimize(app) },
  {
    id: 'tools.reduceSize', label: 'Reduce File Size', icon: 'compress', tab: 'Tools', group: 'Optimize', kind: 'menu',
    menu: () => [{ id: 'tools.reduceSize', arg: 'screen', label: 'Smallest (screen: images 1000 px, quality 0.6)' }, { id: 'tools.reduceSize', arg: 'ebook', label: 'E-book (images 1500 px, quality 0.75)' }, { id: 'tools.reduceSize', arg: 'print', label: 'Print (images 3000 px, quality 0.85)' }, { id: 'tools.reduceSize', arg: 'lossless', label: 'Lossless (structure only)' }],
    run: (app, preset?: string) => optimize(app, preset === 'screen' ? { images: 1000, quality: 0.6 } : preset === 'ebook' ? { images: 1500, quality: 0.75 } : preset === 'print' ? { images: 3000, quality: 0.85 } : preset === 'lossless' ? {} : undefined),
  },
  {
    id: 'tools.compressImages', label: 'Compress Images…', icon: 'photo_size_select_small', tab: 'Tools', group: 'Optimize', tip: 'Downsample and re-encode the pictures in the document (page content stays as it is)',
    run: async (app) => {
      const tab = app.tab;
      const imgs = listImages(tab.doc);
      if (!imgs.length) { toast('The document has no images.'); return; }
      const r = await openDialog({ title: 'Compress Images', fields: [{ key: 'i', type: 'info', html: `<p class="ql-help">${imgs.length} image(s), ${(imgs.reduce((n, x) => n + x.bytes, 0) / 1024).toFixed(0)} KB. Largest: ${Math.max(...imgs.map((x) => Math.max(x.width, x.height)))} px.</p>` }, { key: 'maxPx', label: 'Longest side (px)', type: 'number', min: 200, max: 8000, value: 1500, half: true }, { key: 'q', label: 'JPEG quality', type: 'range', min: 0.3, max: 0.95, step: 0.05, value: 0.75, half: true }], ok: 'Compress' });
      if (!r || !(await confirmRewrite(tab, 'Compressing the images'))) return;
      const rev = tab.bytes;
      app.ui.status?.('● Compressing images…');
      let copy: PdfDocument, n = 0;
      try { copy = PdfDocument.load(rev, { password: tab.password || undefined }); n = await downsampleImages(copy, +r.maxPx || 1500, +r.q || 0.75); }
      finally { app.ui.status?.(''); }
      if (!n) { toast('No image was larger than that (or could be made smaller).'); return; }
      const bytes = copy.save({ incremental: false, recompress: false, keepUnused: false });
      if (!stillCurrent(app, tab, rev) || !replaceWithBytes(app, tab, bytes)) return;
      toast(`${n} image(s) compressed; the file is now ${(bytes.length / 1024).toFixed(0)} KB. Save to keep it.`);
    },
  },
  { id: 'tools.rewrite', label: 'Rewrite File', icon: 'cleaning_services', tab: 'Tools', group: 'Optimize', tip: 'A clean full rewrite in memory (renumbered objects, no earlier versions); Save writes it', run: async (app) => { const tab = app.tab; if (tab.readOnly) { toast('This document is read-only.'); return; } if (!(await confirmRewrite(tab, 'Rewriting the file'))) return; const before = tab.bytes.length; const bytes = tab.doc.save({ incremental: false }); if (replaceWithBytes(app, tab, bytes)) toast(`Rewritten: ${(before / 1024).toFixed(0)} KB → ${(bytes.length / 1024).toFixed(0)} KB. Undo history is cleared; Save writes it.`); } },
  {
    id: 'tools.extractText', label: 'Extract Text…', icon: 'notes', tab: 'Tools', group: 'Extract', edits: false, noRecord: true, tip: 'Plain text or Markdown of the chosen pages, from the document (engine) or the renderer',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Extract Text', [{ key: 'fmt', label: 'Format', type: 'radio', options: [{ value: 'txt', label: 'Plain text' }, { value: 'md', label: 'Markdown (headings from font sizes)' }], value: 'txt' }, { key: 'layout', label: 'Keep the layout (lines by position, from the engine)', type: 'checkbox', value: false }], 'Extract');
      if (!r) return;
      let text: string;
      if (r.values.fmt === 'md') text = textToMarkdown(r.pages.map((i) => pageTextRuns(tab.doc, i)));
      else if (r.values.layout) text = r.pages.map((i) => linesFromRuns(pageTextRuns(tab.doc, i)).join('\n')).join('\n\n\f\n');
      else { const v = viewerOf(tab); const parts: string[] = []; for (const i of r.pages) parts.push(await v.pageText(i)); text = parts.join('\n\n'); }
      await saveBytes(text, `${baseName(tab)}.${r.values.fmt}`, r.values.fmt === 'md' ? 'text/markdown' : 'text/plain');
    },
  },
  {
    id: 'tools.extractImages', label: 'Extract Images', icon: 'photo_library', tab: 'Tools', group: 'Extract', edits: false, noRecord: true, tip: 'Every embedded picture as a file (JPEG as stored; others as PNG)',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Extract Images', [], 'Extract');
      if (!r) return;
      app.ui.status?.('● Extracting images…');
      let files: { name: string; data: Uint8Array }[];
      try { files = await imageFiles(tab.doc, new Set(r.pages)); } finally { app.ui.status?.(''); }
      if (!files.length) { toast('No extractable images on those pages (JBIG2 and CCITT images cannot be decoded yet).'); return; }
      if (files.length === 1) { await saveBytes(files[0].data, `${baseName(tab)} ${files[0].name}`, files[0].name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'); return; }
      await saveBytes(await zipOf(files), `${baseName(tab)} images.zip`, 'application/zip');
    },
  },
  {
    id: 'tools.extractTables', label: 'Extract Tables', icon: 'table', tab: 'Tools', group: 'Extract', edits: false, noRecord: true, popular: true, tip: 'Tables detected from text positions, as CSV (one file per table, zipped when several)',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Extract Tables', [], 'Extract');
      if (!r) return;
      const files: { name: string; data: string }[] = [];
      for (const i of r.pages) { const tables = tablesFromRuns(pageTextRuns(tab.doc, i)); tables.forEach((t, k) => files.push({ name: `${baseName(tab)} page ${i + 1} table ${k + 1}.csv`, data: toCsv(t) })); }
      if (!files.length) { toast('No tables were detected on those pages. Try AI ▸ Extract Table for free-form layouts.'); return; }
      if (files.length === 1) { await saveBytes(files[0].data, files[0].name, 'text/csv'); return; }
      await saveBytes(await zipOf(files), `${baseName(tab)} tables.zip`, 'application/zip');
    },
  },
  {
    id: 'tools.extractAttachments', label: 'Extract Attachments', icon: 'attach_file', tab: 'Tools', group: 'Extract', edits: false, noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const att = readAttachments(tab.doc).filter((a) => a.stream);
      if (!att.length) { toast('The document has no attachments.'); return; }
      if (att.length === 1) { await saveBytes(tab.doc.decoded(att[0].stream!), att[0].name, att[0].mime || 'application/octet-stream'); return; }
      await saveBytes(await zipOf(att.map((a) => ({ name: a.name, data: tab.doc.decoded(a.stream!) }))), `${baseName(tab)} attachments.zip`, 'application/zip');
    },
  },
  {
    id: 'tools.pageInfo', label: 'Page Info', icon: 'info', tab: 'Tools', group: 'Inspect', edits: false, noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const p = pageOf(tab, tab.ui.page);
      const res = p.resources;
      const names = (k: string) => { const d = res ? tab.doc.getDict(res, k) : null; return d ? d.keys().join(', ') : '—'; };
      const box = (k: string) => { const b = tab.doc.rect(p.dict.get(k)); return b ? b.map((v) => +v.toFixed(2)).join(' ') : '—'; };
      const rows: [string, string][] = [['Page', `${p.index + 1} of ${tab.doc.pageCount}${p.ref ? ` (object ${p.ref.num})` : ''}`], ['Size', `${p.width.toFixed(2)} × ${p.height.toFixed(2)} pt (${(p.width / 72).toFixed(2)} × ${(p.height / 72).toFixed(2)} in, ${(p.width / 72 * 25.4).toFixed(0)} × ${(p.height / 72 * 25.4).toFixed(0)} mm)`], ['Rotation', `${p.rotate}°`], ['MediaBox', box('MediaBox')], ['CropBox', box('CropBox')], ['TrimBox', box('TrimBox')], ['BleedBox', box('BleedBox')], ['ArtBox', box('ArtBox')], ['Content', `${tab.doc.pageContent(p).length} bytes`], ['Fonts', names('Font')], ['XObjects', names('XObject')], ['Annotations', String((tab.doc.getArray(p.dict, 'Annots') || []).length)], ['Recognized text', p.dict.has('QuillFolioOCR') ? tab.doc.getText(p.dict, 'QuillFolioOCR') : 'no']];
      await openDialog({ title: 'Page Info', ok: 'Close', cancel: false, content: h('table', { class: 'ql-table' }, rows.map((rw) => h('tr', null, h('th', { style: 'text-align:left;padding-right:12px;white-space:nowrap' }, rw[0]), h('td', null, rw[1])))) });
    },
  },
  {
    id: 'tools.similar', label: 'Similar Documents', icon: 'difference', tab: 'Tools', group: 'Inspect', edits: false, noRecord: true, tip: 'How much the open documents overlap in wording (shingle similarity)',
    run: async (app) => {
      if (app.docs.length < 2) { toast('Open two or more documents to compare them.'); return; }
      const sets: { name: string; s: Set<string> }[] = [];
      for (const d of app.docs) { const text = (await (d.ui as any).allText?.(300))?.join('\n') || ''; sets.push({ name: d.displayName, s: shingles(text) }); }
      const rows: string[] = [];
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { const a = sets[i].s, b = sets[j].s; let inter = 0; for (const x of a) if (b.has(x)) inter++; const union = a.size + b.size - inter; rows.push(`${sets[i].name} ↔ ${sets[j].name}: ${union ? ((100 * inter) / union).toFixed(1) : '0'}% shared phrases`); }
      await openDialog({ title: 'Similar Documents', ok: 'Close', cancel: false, content: h('ul', null, rows.map((r) => h('li', null, r))) });
    },
  },
  {
    id: 'tools.addBookmark', label: 'Add Bookmark', icon: 'bookmark_add', tab: 'Tools', group: 'Bookmarks', keys: ['Mod-Shift-d'], popular: true, tip: 'A bookmark to the current page (titled with the selected text, if any)',
    run: async (app) => {
      const tab = app.tab;
      const title = await promptDialog('Add Bookmark', 'Title', (tab.ui.selectedText || '').trim().slice(0, 80) || `Page ${tab.ui.page + 1}`);
      if (!title) return;
      const page = tab.ui.page;
      editTab(app, tab, 'Add Bookmark', (doc) => { const items = outlinesToInput(readOutlines(doc)); items.push({ title, page }); writeOutlines(doc, items); });
      if (!app.ui.paneOpen('bookmarks')) app.ui.openPane('bookmarks');
    },
  },
  {
    id: 'tools.editBookmark', label: 'Edit Bookmark…', icon: 'edit', tab: 'Tools', group: 'Bookmarks',
    run: async (app, it?: OutlineItem) => {
      const tab = app.tab;
      const items = readOutlines(tab.doc);
      let target = it;
      if (!target) { const flat: OutlineItem[] = []; const walk = (l: OutlineItem[]) => { for (const x of l) { flat.push(x); walk(x.children); } }; walk(items); if (!flat.length) { toast('No bookmarks.'); return; } const r = await openDialog({ title: 'Edit Bookmark', fields: [{ key: 'b', label: 'Bookmark', type: 'select', options: flat.map((x, i) => ({ value: String(i), label: x.title })), value: '0' }] }); if (!r) return; target = flat[+r.b]; }
      const r = await openDialog({ title: 'Edit Bookmark', fields: [{ key: 'title', label: 'Title', type: 'text', value: target.title }, { key: 'page', label: 'Page', type: 'number', min: 1, max: tab.doc.pageCount, value: (target.dest?.page ?? tab.ui.page) + 1, half: true }, { key: 'url', label: 'Or a web address', type: 'text', value: target.url || '', half: true }, { key: 'open', label: 'Expanded', type: 'checkbox', value: target.open }] });
      if (!r) return;
      editTab(app, tab, 'Edit Bookmark', (doc) => {
        const tree = readOutlines(doc);
        const found = findItem(tree, target!.ref);
        if (!found) return;
        const x = found.list[found.index];
        x.title = r.title; x.open = !!r.open;
        if (r.url) { x.url = r.url; x.dest = null; } else { x.url = undefined; x.dest = { page: (+r.page || 1) - 1, kind: 'XYZ' }; }
        writeOutlines(doc, outlinesToInput(tree));
      });
    },
  },
  {
    id: 'tools.deleteBookmark', label: 'Delete Bookmark', icon: 'bookmark_remove', tab: 'Tools', group: 'Bookmarks',
    run: async (app, it?: OutlineItem) => {
      const tab = app.tab;
      if (!it) { app.exec('tools.editBookmark'); return; }
      editTab(app, tab, 'Delete Bookmark', (doc) => { const tree = readOutlines(doc); const f = findItem(tree, it.ref); if (!f) return; f.list.splice(f.index, 1); writeOutlines(doc, outlinesToInput(tree)); });
    },
  },
  {
    id: 'tools.bookmarksFromHeadings', label: 'Bookmarks from Headings', icon: 'auto_fix_high', tab: 'Tools', group: 'Bookmarks', tip: 'Make bookmarks from the lines set in larger type than the body text',
    run: async (app) => {
      const tab = app.tab;
      const heads = headingsFromText(tab.doc);
      if (!heads.length) { toast('No headings were detected (the text is all one size, or the pages are images).'); return; }
      const r = await openDialog({ title: 'Bookmarks from Headings', fields: [{ key: 'h', label: `${heads.length} heading(s) found; keep`, type: 'list', multiple: true, rows: 12, options: heads.map((x, i) => ({ value: String(i), label: `${'   '.repeat(x.level)}${x.title} (p. ${x.page + 1})` })), value: heads.map((_, i) => String(i)) }, { key: 'replace', label: 'Replace the existing bookmarks', type: 'checkbox', value: !readOutlines(tab.doc).length }], ok: 'Add' });
      if (!r?.h?.length) return;
      const keep = (r.h as string[]).map((i) => heads[+i]);
      editTab(app, tab, 'Bookmarks from Headings', (doc) => {
        const items: OutlineInput[] = r.replace ? [] : outlinesToInput(readOutlines(doc));
        const stack: OutlineInput[][] = [items];
        for (const hd of keep) { const lvl = Math.min(hd.level, stack.length - 1); stack.length = lvl + 1; const node: OutlineInput = { title: hd.title, page: hd.page, y: hd.y, children: [] }; stack[lvl].push(node); stack.push(node.children!); }
        writeOutlines(doc, items);
      });
      if (!app.ui.paneOpen('bookmarks')) app.ui.openPane('bookmarks');
    },
  },
  { id: 'tools.deleteBookmarks', label: 'Delete All Bookmarks', icon: 'bookmarks', tab: 'Tools', group: 'Bookmarks', run: async (app) => { const tab = app.tab; if (!readOutlines(tab.doc).length) { toast('There are no bookmarks.'); return; } if (await confirmDialog('Delete Bookmarks', 'Remove every bookmark?', 'Delete')) editTab(app, tab, 'Delete Bookmarks', (doc) => writeOutlines(doc, [])); } },
  {
    id: 'tools.addAttachment', label: 'Attach File…', icon: 'attach_file', tab: 'Tools', group: 'Attachments', tip: 'Embed a file in the document (document level; Comment ▸ Attach File pins one to a page)',
    run: async (app) => {
      const tab = app.tab;
      const files = await pickFile('*/*', true);
      if (!files.length) return;
      const data = await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) })));
      editTab(app, tab, 'Attach File', (doc) => { for (const d of data) addAttachment(doc, d.name, d.bytes, { mime: d.mime }); });
      if (!app.ui.paneOpen('attachments')) app.ui.openPane('attachments');
    },
  },
  {
    id: 'tools.openAttachment', label: 'Open Attachment', icon: 'open_in_new', tab: 'Tools', group: 'Attachments', edits: false, noRecord: true, tip: 'Open an attached PDF in a new tab, or save other files',
    run: async (app, a?: Attachment) => {
      const tab = app.tab;
      const att = a || (await pickAttachment(tab));
      if (!att?.stream) return;
      const data = tab.doc.decoded(att.stream);
      // PDFs, pictures and plain text open as a document in a new tab. Nothing from an attachment is ever opened
      // as a web page (an attached HTML or SVG file would run with this app's access); everything else is saved.
      const name = safeName(att.name, 'attachment');
      if (/\.(pdf|png|jpe?g|gif|webp|bmp|tiff?|txt|md)$/i.test(name) || /^application\/pdf$/i.test(att.mime)) {
        try { const res = await openAsPdf(data, /\.[a-z0-9]+$/i.test(name) ? name : `${name}.pdf`); const t = app.createTab(res.doc, { title: name.replace(/\.[^.]+$/, ''), fileName: `${name.replace(/\.[^.]+$/, '')}.pdf` }, res.bytes); t.dirty = false; return; }
        catch (e: any) { toast(`Could not open ${name} here (${e?.message || e}); saving it instead.`, { ms: 6000 }); }
      }
      await saveBytes(data, name, att.mime || 'application/octet-stream');
    },
  },
  { id: 'tools.saveAttachment', label: 'Save Attachment', icon: 'download', tab: 'Tools', group: 'Attachments', edits: false, noRecord: true, run: async (app, a?: Attachment) => { const tab = app.tab; const att = a || (await pickAttachment(tab)); if (att?.stream) await saveBytes(tab.doc.decoded(att.stream), att.name, att.mime || 'application/octet-stream'); } },
  { id: 'tools.removeAttachment', label: 'Remove Attachment', icon: 'delete', tab: 'Tools', group: 'Attachments', run: async (app, a?: Attachment) => { const tab = app.tab; const att = a || (await pickAttachment(tab)); if (!att) return; if (await confirmDialog('Remove Attachment', `Remove ${att.name}?`, 'Remove')) editTab(app, tab, 'Remove Attachment', (doc) => removeAttachment(doc, readAttachments(doc).find((x) => x.name === att.name && x.where === att.where)!)); } },
  {
    id: 'tools.batch', label: 'Batch Process…', icon: 'dynamic_feed', tab: 'Tools', group: 'Batch', noRecord: true, edits: false, popular: true,
    tip: 'Run one operation over several files picked at once; the results come back as a ZIP',
    run: async (app) => {
      const files = await pickFile('.pdf,image/*', true);
      if (!files.length) return;
      const r = await openDialog({ title: `Batch: ${files.length} file(s)`, fields: [
        { key: 'op', label: 'Operation', type: 'select', options: [{ value: 'optimize', label: 'Optimize (rewrite, recompress, object streams)' }, { value: 'flatten', label: 'Flatten comments and forms' }, { value: 'watermark', label: 'Add a watermark' }, { value: 'bates', label: 'Bates numbering across all files' }, { value: 'encrypt', label: 'Encrypt (AES-256)' }, { value: 'sanitize', label: 'Remove metadata, scripts and attachments' }, { value: 'text', label: 'Extract text (.txt per file)' }, { value: 'merge', label: 'Merge into one PDF' }], value: 'optimize' },
        { key: 'text', label: 'Watermark text', type: 'text', value: 'DRAFT', visibleIf: (v) => v.op === 'watermark' },
        { key: 'prefix', label: 'Bates prefix', type: 'text', value: 'DOC', visibleIf: (v) => v.op === 'bates', half: true }, { key: 'start', label: 'Start at', type: 'number', value: 1, visibleIf: (v) => v.op === 'bates', half: true },
        { key: 'pw', label: 'Open password (needed to open each file)', type: 'password', visibleIf: (v) => v.op === 'encrypt', half: true }, { key: 'pw2', label: 'Confirm', type: 'password', visibleIf: (v) => v.op === 'encrypt', half: true },
        { key: 'opw', label: 'Permissions password (empty: one is generated and shown to you)', type: 'password', visibleIf: (v) => v.op === 'encrypt' },
      ], validate: (v) => (v.op !== 'encrypt' ? null : !v.pw ? 'Enter an open password: without one the files would open for anyone.' : v.pw !== v.pw2 ? 'The open passwords do not match.' : v.opw && v.opw === v.pw ? 'The permissions password must differ from the open password.' : null), ok: 'Run' });
      if (!r) return;
      const out: { name: string; data: Uint8Array | string }[] = [];
      const log: string[] = [];
      let failed = 0, done = 0;
      const ownerPw = r.op === 'encrypt' ? String(r.opw || '') || newOwnerPassword() : '';
      let bates = r.start === '' || r.start == null || !Number.isFinite(+r.start) ? 1 : Math.max(0, Math.floor(+r.start));
      const merged = r.op === 'merge' ? PdfDocument.create() : null;
      for (const f of files) {
        try {
          app.ui.status?.(`● ${f.name}…`);
          const res = await openAsPdf(new Uint8Array(await f.arrayBuffer()), f.name);
          const d = res.doc; const base = f.name.replace(/\.[^.]+$/, '');
          const all = d.pages.map((_, i) => i);
          if (r.op === 'text') { const { pageText } = await import('../pdf/ops/extract'); out.push({ name: `${base}.txt`, data: all.map((i) => pageText(d, i)).join('\n\n') }); }
          else if (r.op === 'merge') { const { importPages } = await import('../pdf/ops/pages'); importPages(d, merged!, all, undefined, { keepAnnots: true }); }
          else {
            if (r.op === 'flatten') { flattenForm(d); for (const p of d.pages) flattenAnnotations(d, p); }
            if (r.op === 'watermark') addWatermark(d, all, r.text || 'DRAFT', { size: 72, opacity: 0.2, color: [0.8, 0.1, 0.1], rotate: 45 });
            if (r.op === 'bates') { addBates(d, all, { prefix: r.prefix, start: bates, digits: 6, position: 'bottom-right' }); bates += all.length; }
            if (r.op === 'sanitize') sanitize(d, { metadata: true, javascript: true, attachments: true, privateData: true, thumbnails: true });
            const bytes = r.op === 'encrypt' ? d.save({ incremental: false, encrypt: { userPassword: String(r.pw), ownerPassword: ownerPw, permissions: {} } }) : d.save({ incremental: false, recompress: r.op === 'optimize', objectStreams: r.op === 'optimize' });
            out.push({ name: `${base}.pdf`, data: bytes });
          }
          done++;
          log.push(`${f.name}: ok${res.repair ? ' (repaired)' : ''}`);
        } catch (e: any) { failed++; log.push(`${f.name}: FAILED — ${e?.message || e}`); }
      }
      app.ui.status?.('');
      const problems = () => openDialog({ title: 'Batch Log', wide: true, ok: 'Close', cancel: false, content: h('pre', { class: 'ql-notices' }, log.join('\n')) });
      if (merged) {
        if (!done) { toast('None of the files could be read; nothing was merged.', { action: 'Details', onAction: problems, ms: 9000 }); return; }
        openAsNewTab(app, merged.save({ incremental: false }), 'Merged');
        // A skipped file must not go unnoticed in a merged document.
        toast(failed ? `${done} of ${files.length} file(s) merged; ${failed} could not be read and ${failed === 1 ? 'is' : 'are'} missing from the result.` : `${done} file(s) merged.`, failed ? { action: 'Details', onAction: problems, ms: 12000 } : {});
        return;
      }
      // zipOf keeps results with the same name apart ("scan.pdf", "scan (2).pdf").
      out.push({ name: 'batch-log.txt', data: log.join('\n') });
      const saved = await saveBytes(await zipOf(out), `batch ${r.op}.zip`, 'application/zip');
      if (failed) toast(`${failed} of ${files.length} file(s) failed; see batch-log.txt in the ZIP.`, { action: 'Details', onAction: problems, ms: 9000 });
      if (saved && r.op === 'encrypt' && !r.opw) await showGeneratedPassword(ownerPw);
    },
  },
  {
    id: 'tools.toArchival', label: 'Prepare for Archiving', icon: 'inventory', tab: 'Tools', group: 'Convert', tip: 'Apply what Anne\'s Folio can toward an archival PDF: remove encryption and scripts, write XMP with a title and language (no font embedding or color profiles yet)',
    run: async (app) => {
      const tab = app.tab;
      const issues = archivalCheck(tab.doc);
      const m = readMetadata(tab.doc);
      const r = await openDialog({ title: 'Prepare for Archiving', fields: [{ key: 'i', type: 'info', html: `<p class="ql-help">${issues.length} finding(s) from the archival check. This step cannot embed fonts or add color profiles, so the result is "archival-ready" rather than conforming PDF/A.</p>` }, { key: 'title', label: 'Title', type: 'text', value: m.title || tab.title }, { key: 'lang', label: 'Language', type: 'text', value: m.language || 'en-US' }, { key: 'strip', label: 'Remove scripts and actions', type: 'checkbox', value: true }, { key: 'layers', label: 'Remove hidden layers and their content (an archival PDF may not hide content in layers)', type: 'checkbox', value: false }], ok: 'Prepare' });
      if (!r) return;
      if (tab.doc.security) { toast('Remove the security first (Protect ▸ Remove Security).'); return; }
      editTab(app, tab, 'Prepare for Archiving', (doc) => { writeMetadata(doc, { title: r.title, language: r.lang }); if (r.strip || r.layers) { tab.mustRewrite = true; sanitize(doc, { javascript: !!r.strip, hiddenLayers: !!r.layers }); } const vp = doc.getDict(doc.catalog, 'ViewerPreferences') || new Dict(); vp.set('DisplayDocTitle', true); doc.catalog.set('ViewerPreferences', vp); doc.update(doc.catalogRef, doc.catalog); });
      app.exec('review.archivalCheck');
    },
  },
  {
    id: 'tools.editXmp', label: 'Edit XMP Metadata…', icon: 'data_object', tab: 'Tools', group: 'Convert', tip: 'The XMP packet as XML',
    run: async (app) => {
      const tab = app.tab;
      const m = readMetadata(tab.doc);
      const r = await openDialog({ title: 'XMP Metadata', wide: true, fields: [{ key: 'x', label: 'XMP packet (XML)', type: 'textarea', rows: 18, value: m.xmp || '' }], ok: 'Save', buttons: [{ label: 'Generate from Properties', onClick: (_v, ctl) => { ctl.close(null); guarded('Write XMP', () => editTab(app, tab, 'Write XMP', (doc) => writeMetadata(doc, {}))); } }] });
      if (!r) return;
      const xml = String(r.x);
      if (xml.trim() && !/<x:xmpmeta|<rdf:RDF/.test(xml)) { toast('That does not look like an XMP packet (no x:xmpmeta or rdf:RDF element).'); return; }
      editTab(app, tab, 'XMP Metadata', (doc) => {
        if (!xml.trim()) { doc.catalog.delete('Metadata'); doc.update(doc.catalogRef, doc.catalog); return; }
        const s = new PdfStream(new Dict({ Type: Name.get('Metadata'), Subtype: Name.get('XML') }), new TextEncoder().encode(xml));
        s.dict.set('Length', s.raw.length);
        const old = doc.catalog.get('Metadata');
        if (old instanceof Ref) doc.update(old, s); else { doc.catalog.set('Metadata', doc.register(s)); doc.update(doc.catalogRef, doc.catalog); }
      });
    },
  },
  {
    id: 'tools.goToBookmark', label: 'Go to Bookmark', icon: 'bookmark', tab: 'Tools', group: 'Bookmarks', kind: 'menu', edits: false, noRecord: true,
    menu: (app) => { const flat: { title: string; page: number }[] = []; const walk = (l: OutlineItem[], d: number) => { for (const x of l) { if (x.dest) flat.push({ title: `${'  '.repeat(d)}${x.title}`, page: x.dest.page }); walk(x.children, d + 1); } }; walk(readOutlines(app.doc), 0); return flat.length ? flat.slice(0, 40).map((f) => ({ id: 'tools.goToBookmark', arg: f.page, label: f.title })) : [{ label: '(no bookmarks)' }]; },
    run: (app, page?: number) => { if (page == null) { app.ui.openPane('bookmarks'); return; } remember(app); app.tab.ui.goToPage(page); },
  },
  { id: 'tools.fontsReport', label: 'Fonts Report (Text)', icon: 'font_download', tab: 'Tools', group: 'Inspect', edits: false, noRecord: true, run: async (app) => { const tab = app.tab; const f = listFonts(tab.doc); await saveBytes(f.map((x) => `${x.name}\t${x.subtype}\t${x.encoding}\t${x.embedded ? 'embedded' : 'not embedded'}\tpages ${x.pages.map((p) => p + 1).join(',')}`).join('\n'), `${baseName(tab)} fonts.tsv`, 'text/tab-separated-values'); } },
]);

async function pickAttachment(c: Ctx): Promise<Attachment | null> {
  const tab = tabOf(c);
  const att = readAttachments(tab.doc);
  if (!att.length) { toast('The document has no attachments.'); return null; }
  const r = await openDialog({ title: 'Attachment', fields: [{ key: 'a', label: 'File', type: 'select', options: att.map((a, i) => ({ value: String(i), label: `${a.name} (${(a.size / 1024).toFixed(1)} KB)` })), value: '0' }] });
  return r ? att[+r.a] : null;
}

export { esc, docCopy, PdfString, hexToRgb };
