/** Organize Pages tab: insert, delete, extract, split, merge, rotate, crop, scale, labels, marks, imposition, selection. */
import { def } from './registry';
import type { App, DocTab } from '../app';
import { Dict, Name, bytesOf } from '../pdf/objects';
import { fmtNum } from '../pdf/writer';
import { PdfDocument } from '../pdf/document';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { PAPER, addBlankPage, addTextPages, imageXObject, ensureXObject, ensureExtGState } from '../pdf/build';
import { deletePages, movePages, rotatePages, duplicatePages, insertBlankPages, setPageBox, cropPages, scalePages, importPages, extractPages, splitGroups, splitParts, addOverlayText, addBates, addWatermark, appendContent, setBackgroundColor, nUp, booklet, reversePages, setPageOrder, parseRanges } from '../pdf/ops/pages';
import { readPageLabels, writePageLabels, readOutlines, type LabelRange } from '../pdf/structure';
import { openAsPdf, imageSpecFromBytes, eachImageSpec, addImagePageOriented, type ImageSpecEx } from '../io';
import { readClipboardText, saveAs } from '../platform/native';
import { ZipWriter } from './zipstream';
import { targetPages, askPages, pagesFromRange, normalizeRange, rangeField, compressRange, viewer, viewerOf, pageOf, saveBytes, baseName, zipOf, uniqueNames, safeName, hexToRgb, FONT_OPTIONS, esc, editTab, guarded, openAsNewTab, clipboardImage, uprightMatrix, type Ctx } from './util';

const sel = (c: Ctx) => targetPages(c);
const after = (c: Ctx) => Math.max(...sel(c)) + 1;

/** Reads picked files (PDFs and images) into PdfDocuments. */
async function docsFromFiles(files: File[], onWarn?: (m: string) => void): Promise<{ name: string; doc: PdfDocument }[]> {
  const out: { name: string; doc: PdfDocument }[] = [];
  for (const f of files) {
    try { const r = await openAsPdf(new Uint8Array(await f.arrayBuffer()), f.name); out.push({ name: f.name, doc: r.doc }); if (r.warnings.length) onWarn?.(`${f.name}: ${r.warnings[0]}`); }
    catch (e: any) { onWarn?.(`${f.name}: ${e?.message || e}`); }
  }
  return out;
}

export async function insertFiles(app: App, files: File[], at?: number, tab: DocTab = app.tab): Promise<void> {
  if (!files.length) return;
  const docs = await docsFromFiles(files, (m) => toast(m, { ms: 6000 }));
  if (!docs.length) return;
  // 'end' is resolved now: pages may have been added while the files were read.
  const where = at === Infinity ? tab.doc.pageCount : at ?? after(tab);
  const n = editTab(app, tab, 'Insert Pages', (doc) => { let pos = Math.min(where, doc.pageCount); let k = 0; for (const d of docs) { const pages = importPages(d.doc, doc, d.doc.pages.map((_, i) => i), pos, { keepAnnots: true }); pos += pages.length; k += pages.length; } return k; });
  if (n != null) toast(`${n} page(s) inserted.`);
}

function parseLabels(text: string): LabelRange[] {
  const out: LabelRange[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s*:\s*([DRrAa]?)\s*(?:"([^"]*)")?\s*(\d+)?\s*$/.exec(line);
    if (!m) continue;
    out.push({ start: +m[1] - 1, style: (m[2] || undefined) as LabelRange['style'], prefix: m[3] || undefined, first: m[4] ? +m[4] : undefined });
  }
  return out;
}

const POSITIONS = [{ value: 'top-left', label: 'Top left' }, { value: 'top-center', label: 'Top center' }, { value: 'top-right', label: 'Top right' }, { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-center', label: 'Bottom center' }, { value: 'bottom-right', label: 'Bottom right' }, { value: 'center', label: 'Center' }];

def([
  {
    id: 'organize.insertBlank', label: 'Insert Blank Page', icon: 'note_add', tab: 'Organize Pages', group: 'Insert', keys: ['Mod-Shift-b'], popular: true,
    tip: 'A blank page after the current one, the same size',
    run: (app, arg?: { count?: number; at?: number }) => { const p = pageOf(app, app.page); const at = arg?.at ?? after(app); app.edit('Insert Blank Page', (doc) => insertBlankPages(doc, at, arg?.count || 1, [p.mediaBox[2] - p.mediaBox[0], p.mediaBox[3] - p.mediaBox[1]])); app.tab.ui.goToPage(at); },
  },
  {
    id: 'organize.insertBlankPages', label: 'Insert Blank Pages…', icon: 'library_add', tab: 'Organize Pages', group: 'Insert',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Insert Blank Pages', fields: [{ key: 'n', label: 'How many', type: 'number', min: 1, max: 500, value: 1, half: true }, { key: 'at', label: 'Insert', type: 'select', options: [{ value: 'after', label: 'After the current page' }, { value: 'before', label: 'Before the current page' }, { value: 'end', label: 'At the end' }, { value: 'start', label: 'At the start' }], value: 'after', half: true }, { key: 'paper', label: 'Size', type: 'select', options: [{ value: 'same', label: 'Same as the current page' }, ...Object.keys(PAPER).map((k) => ({ value: k, label: k.toUpperCase() }))], value: 'same', half: true }, { key: 'land', label: 'Landscape', type: 'checkbox', value: false, half: true }] });
      if (!r) return;
      const p = pageOf(tab, tab.ui.page);
      let size: [number, number] = r.paper === 'same' ? [p.mediaBox[2] - p.mediaBox[0], p.mediaBox[3] - p.mediaBox[1]] : PAPER[r.paper];
      if (r.land && size[0] < size[1]) size = [size[1], size[0]];
      const at = r.at === 'after' ? tab.ui.page + 1 : r.at === 'before' ? tab.ui.page : r.at === 'end' ? tab.doc.pageCount : 0;
      editTab(app, tab, 'Insert Blank Pages', (doc) => insertBlankPages(doc, at, +r.n || 1, size));
      tab.ui.goToPage(at);
    },
  },
  { id: 'organize.insertFromFile', label: 'Insert from File…', icon: 'file_open', tab: 'Organize Pages', group: 'Insert', popular: true, tip: 'Pages of other PDFs (or images) after the current page', run: async (app) => { const tab = app.tab; const files = await pickFile('.pdf,image/*,.txt,.md,.html', true); await insertFiles(app, files, undefined, tab); } },
  {
    id: 'organize.insertFromImages', label: 'Insert from Images…', icon: 'photo_library', tab: 'Organize Pages', group: 'Insert', tip: 'One page per picture, sized to the picture',
    run: async (app) => {
      const tab = app.tab;
      const files = await pickFile('image/*', true);
      if (!files.length) return;
      const r = await openDialog({ title: 'Insert from Images', fields: [{ key: 'paper', label: 'Page size', type: 'select', options: [{ value: 'image', label: 'Fit the page to the picture' }, ...Object.keys(PAPER).map((k) => ({ value: k, label: `${k.toUpperCase()} (picture fitted with margins)` }))], value: 'image', half: true }, { key: 'dpi', label: 'Picture resolution (dpi)', type: 'number', min: 36, max: 1200, value: 150, half: true }], ok: 'Insert' });
      if (!r) return;
      const specs: ImageSpecEx[] = [];
      // Every page of a multi-page TIFF becomes a page; JPEGs are turned as their EXIF orientation asks.
      for (const f of files) { try { for (const w of await eachImageSpec(new Uint8Array(await f.arrayBuffer()), f.type === 'image/jpeg' ? 'jpeg' : undefined, (spec) => specs.push(spec))) toast(`${f.name}: ${w}`); } catch (e: any) { toast(`${f.name}: ${e?.message || e}`); } }
      if (!specs.length) return;
      let at = after(tab);
      editTab(app, tab, 'Insert from Images', (doc) => { for (const s of specs) addImagePageOriented(doc, s, { paper: r.paper === 'image' ? 'image' : PAPER[r.paper], dpi: +r.dpi || 150, at: at++ }); });
      tab.ui.goToPage(after(tab));
    },
  },
  {
    id: 'organize.insertFromClipboard', label: 'Insert from Clipboard', icon: 'content_paste', tab: 'Organize Pages', group: 'Insert', tip: 'A page from the picture or text on the clipboard',
    run: async (app) => {
      const tab = app.tab;
      let image = await clipboardImage();
      if (!image && app.clip?.image) image = new Blob([app.clip.image.data as BlobPart], { type: app.clip.image.mime });
      const at = after(tab);
      if (image) { const spec = await imageSpecFromBytes(new Uint8Array(await image.arrayBuffer()), image.type === 'image/jpeg' ? 'jpeg' : undefined); editTab(app, tab, 'Insert from Clipboard', (doc) => addImagePageOriented(doc, spec, { paper: 'image', at })); tab.ui.goToPage(at); return; }
      const text = (await readClipboardText()) || app.clip?.text || '';
      if (!text.trim()) { toast('The clipboard has no picture or text.'); return; }
      const p = pageOf(tab, tab.ui.page);
      editTab(app, tab, 'Insert from Clipboard', (doc) => { const d = PdfDocument.create(); addTextPages(d, text, { paper: [p.mediaBox[2] - p.mediaBox[0], p.mediaBox[3] - p.mediaBox[1]] }); importPages(d, doc, d.pages.map((_, i) => i), at); });
      tab.ui.goToPage(at);
    },
  },
  {
    id: 'organize.insertFromText', label: 'Insert from Text…', icon: 'article', tab: 'Organize Pages', group: 'Insert', tip: 'Typeset typed or pasted text (Markdown headings and lists) as new pages',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Insert from Text', wide: true, fields: [{ key: 't', label: 'Text', type: 'textarea', rows: 12, autofocus: true }, { key: 'font', label: 'Font', type: 'select', options: FONT_OPTIONS, value: 'Helvetica', half: true }, { key: 'size', label: 'Size (pt)', type: 'number', min: 6, max: 36, value: 11, half: true }], ok: 'Insert' });
      if (!r || !String(r.t).trim()) return;
      const p = pageOf(tab, tab.ui.page); const at = after(tab);
      editTab(app, tab, 'Insert from Text', (doc) => { const d = PdfDocument.create(); addTextPages(d, String(r.t), { paper: [p.mediaBox[2] - p.mediaBox[0], p.mediaBox[3] - p.mediaBox[1]], font: r.font, size: +r.size || 11 }); importPages(d, doc, d.pages.map((_, i) => i), at); });
      tab.ui.goToPage(at);
    },
  },
  { id: 'organize.insertFiles', label: 'Insert Dropped Files', icon: 'file_open', tab: 'Organize Pages', group: 'Insert', internal: true, noRecord: true, run: (app, files: File[]) => insertFiles(app, files) },
  {
    id: 'organize.delete', label: 'Delete Pages', icon: 'delete_sweep', tab: 'Organize Pages', group: 'Pages', popular: true, tip: 'Delete the selected pages (or the current page)',
    run: async (app, arg?: number[]) => {
      const tab = app.tab;
      const pages = arg || sel(tab);
      if (pages.length >= tab.doc.pageCount) { toast('A document needs at least one page.'); return; }
      if (pages.length > 1 && !(await confirmDialog('Delete Pages', `Delete ${pages.length} pages (${compressRange(pages)})?`, 'Delete'))) return;
      editTab(app, tab, 'Delete Pages', (doc) => deletePages(doc, pages));
      viewerOf(tab).pageSel = [];
      tab.ui.goToPage(Math.min(pages[0], tab.doc.pageCount - 1));
    },
  },
  {
    id: 'organize.replace', label: 'Replace Pages…', icon: 'swap_horiz', tab: 'Organize Pages', group: 'Pages', tip: 'Replace the selected pages with the pages of another file',
    run: async (app) => {
      const tab = app.tab;
      const [f] = await pickFile('.pdf,image/*');
      if (!f) return;
      const [src] = await docsFromFiles([f], (m) => toast(m));
      if (!src) return;
      const pages = sel(tab);
      const r = await openDialog({ title: 'Replace Pages', fields: [{ key: 'i', type: 'info', html: `<p>Replace page(s) ${esc(compressRange(pages))} with pages from ${esc(f.name)} (${src.doc.pageCount} page(s)):</p>` }, { key: 'range', label: 'Pages of the new file', type: 'text', value: `1-${src.doc.pageCount}` }], ok: 'Replace' });
      if (!r) return;
      const range = normalizeRange(r.range, src.doc.pageCount);
      const srcPages = range.bad.length || !range.spec ? [] : parseRanges(range.spec, src.doc.pageCount);
      if (!srcPages.length) { toast(`"${r.range}" names no page of ${f.name} (${src.doc.pageCount} page(s)). Nothing was replaced.`, { ms: 6000 }); return; }
      editTab(app, tab, 'Replace Pages', (doc) => { importPages(src.doc, doc, srcPages, pages[0], { keepAnnots: true }); deletePages(doc, pages.map((i) => i + srcPages.length)); });
      viewerOf(tab).pageSel = [];
    },
  },
  {
    id: 'organize.extract', label: 'Extract Pages…', icon: 'output', tab: 'Organize Pages', group: 'Pages', edits: false, popular: true, tip: 'The chosen pages as a new document (open it, or save it straight away)',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Extract Pages', [{ key: 'what', label: 'Then', type: 'radio', options: [{ value: 'open', label: 'Open as a new document' }, { value: 'save', label: 'Save as a file' }, { value: 'each', label: 'Save each page as its own file (ZIP)' }], value: 'open' }, { key: 'remove', label: 'Remove the pages from this document', type: 'checkbox', value: false }], 'Extract');
      if (!r) return;
      const base = `${baseName(tab)} pages ${compressRange(r.pages).replace(/, /g, '_')}`;
      if (r.values.what === 'each') {
        const files = r.pages.map((i) => { const d = extractPages(tab.doc, [i]); return { name: `${baseName(tab)} page ${i + 1}.pdf`, data: d.save({ incremental: false }) }; });
        // A cancelled or failed save must not be followed by removing the pages.
        if (!(await saveBytes(await zipOf(files), `${base}.zip`, 'application/zip'))) return;
      } else {
        const bytes = extractPages(tab.doc, r.pages).save({ incremental: false });
        if (r.values.what === 'save') { if (!(await saveBytes(bytes, `${base}.pdf`, 'application/pdf'))) return; }
        else openAsNewTab(app, bytes, base);
      }
      if (r.values.remove) {
        if (r.pages.length >= tab.doc.pageCount) { toast('The pages were not removed: a document needs at least one page.'); return; }
        // `tab` is the document the pages came from, also when the extract opened in a new tab.
        if (editTab(app, tab, 'Extract Pages', (doc) => { deletePages(doc, r.pages); return true; })) viewerOf(tab).pageSel = [];
      }
    },
  },
  { id: 'organize.duplicate', label: 'Duplicate Pages', icon: 'library_add', tab: 'Organize Pages', group: 'Pages', run: (app) => { const pages = sel(app); app.edit('Duplicate Pages', (doc) => duplicatePages(doc, pages)); } },
  {
    id: 'organize.move', label: 'Move Pages…', icon: 'low_priority', tab: 'Organize Pages', group: 'Pages', tip: 'Move the selected pages to a position (you can also drag thumbnails)',
    run: async (app) => {
      const tab = app.tab;
      const pages = sel(tab);
      const r = await openDialog({ title: 'Move Pages', fields: [{ key: 'i', type: 'info', html: `<p>Move page(s) ${esc(compressRange(pages))}</p>` }, { key: 'to', label: 'Before page number (one past the end moves them to the end)', type: 'number', min: 1, max: tab.doc.pageCount + 1, value: tab.doc.pageCount + 1 }], ok: 'Move' });
      if (!r) return;
      editTab(app, tab, 'Move Pages', (doc) => movePages(doc, pages, (+r.to || 1) - 1));
      viewerOf(tab).pageSel = [];
    },
  },
  { id: 'organize.moveTo', label: 'Move Pages To', icon: 'low_priority', tab: 'Organize Pages', group: 'Pages', internal: true, noRecord: true, run: (app, a: { from: number[]; to: number }) => { app.edit('Move Pages', (doc) => movePages(doc, a.from, a.to > Math.max(...a.from) ? a.to + 1 : a.to)); viewer(app).pageSel = []; } },
  { id: 'organize.reverse', label: 'Reverse Page Order', icon: 'swap_vert', tab: 'Organize Pages', group: 'Pages', run: (app) => app.edit('Reverse Pages', (doc) => reversePages(doc)) },
  {
    id: 'organize.split', label: 'Split…', icon: 'call_split', tab: 'Organize Pages', group: 'Split and Merge', edits: false, popular: true, tip: 'Split into several PDFs: every N pages, by page ranges, at top-level bookmarks, or by file size',
    run: async (app) => {
      const tab = app.tab;
      const hasBm = readOutlines(tab.doc).length > 0;
      const r = await openDialog({ title: 'Split Document', fields: [
        { key: 'mode', label: 'Split', type: 'radio', options: [{ value: 'every', label: 'Every N pages' }, { value: 'ranges', label: 'By page ranges' }, ...(hasBm ? [{ value: 'bookmarks', label: 'At top-level bookmarks' }] : []), { value: 'size', label: 'By file size' }], value: 'every' },
        { key: 'n', label: 'Pages per file', type: 'number', min: 1, value: 1, visibleIf: (v) => v.mode === 'every' },
        { key: 'ranges', label: 'Ranges, separated by semicolons (e.g. 1-3; 4-6; 7-)', type: 'text', value: '', visibleIf: (v) => v.mode === 'ranges' },
        { key: 'mb', label: 'Largest file (MB)', type: 'number', min: 0.1, step: 0.1, value: 5, visibleIf: (v) => v.mode === 'size' },
        { key: 'out', label: 'Then', type: 'radio', options: [{ value: 'zip', label: 'Save all parts as one ZIP' }, { value: 'tabs', label: 'Open each part as a document' }], value: 'zip' },
      ], ok: 'Split' });
      if (!r) return;
      const mode = r.mode === 'every' ? { kind: 'every' as const, n: +r.n || 1 } : r.mode === 'ranges' ? { kind: 'ranges' as const, ranges: r.ranges } : r.mode === 'bookmarks' ? { kind: 'bookmarks' as const, items: readOutlines(tab.doc).filter((o) => o.dest).map((o) => ({ title: o.title, page: o.dest!.page })) } : { kind: 'size' as const, maxBytes: (+r.mb || 5) * 1024 * 1024 };
      const groups = splitGroups(tab.doc, mode);
      if (!groups.length) { toast('Nothing to split.'); return; }
      if (r.out === 'tabs') {
        const rev = tab.bytes;
        if (groups.length > 12 && !(await confirmDialog('Split Document', `This opens ${groups.length} documents at once, each in its own tab. Saving them as one ZIP is lighter.`, `Open ${groups.length} Tabs`))) return;
        if (!app.stillOpen(tab, rev)) return;
        for (const p of splitParts(tab.doc, mode, groups)) openAsNewTab(app, p.doc.save({ incremental: false }), `${baseName(tab)} ${p.name}`);
        return;
      }
      await saveSplitZip(tab.doc, mode, groups, baseName(tab));
    },
  },
  { id: 'organize.merge', label: 'Merge Files…', icon: 'merge', tab: 'Organize Pages', group: 'Split and Merge', tip: 'Append other PDFs (or images) at the end of this document', run: async (app) => { const tab = app.tab; const files = await pickFile('.pdf,image/*', true); await insertFiles(app, files, Infinity, tab); } },
  {
    id: 'organize.combineFiles', label: 'Combine Files…', icon: 'library_books', tab: 'Organize Pages', group: 'Split and Merge', edits: false, popular: true, tip: 'Several PDFs and pictures into one new document, in the order you choose',
    run: async (app) => {
      const files = await pickFile('.pdf,image/*,.txt,.md,.html', true);
      if (!files.length) return;
      const r = await openDialog({ title: 'Combine Files', fields: [{ key: 'order', label: 'Order (one file name per line; reorder as you like)', type: 'textarea', rows: Math.min(12, files.length + 1), value: files.map((f) => f.name).join('\n') }, { key: 'bm', label: 'Add a bookmark for each file', type: 'checkbox', value: true }], ok: 'Combine' });
      if (!r) return;
      const order = String(r.order).split('\n').map((s) => s.trim()).filter(Boolean).map((n) => files.find((f) => f.name === n)).filter((f): f is File => !!f);
      const docs = await docsFromFiles(order.length ? order : files, (m) => toast(m, { ms: 6000 }));
      if (!docs.length) return;
      const out = PdfDocument.create();
      const marks: { title: string; page: number }[] = [];
      for (const d of docs) { marks.push({ title: d.name.replace(/\.[^.]+$/, ''), page: out.pageCount }); importPages(d.doc, out, d.doc.pages.map((_, i) => i), undefined, { keepAnnots: true }); }
      if (r.bm) { const { writeOutlines } = await import('../pdf/structure'); writeOutlines(out, marks); }
      openAsNewTab(app, out.save({ incremental: false }), 'Combined');
      toast(`${docs.length} file(s) combined into ${out.pageCount} page(s).`);
    },
  },
  { id: 'organize.rotateLeft', label: 'Rotate Left', icon: 'rotate_left', tab: 'Organize Pages', group: 'Rotate and Crop', keys: ['Mod-Shift-ArrowLeft'], tip: 'Rotate the selected pages 90° counterclockwise (saved in the file)', run: (app) => { const pages = sel(app); app.edit('Rotate Left', (doc) => rotatePages(doc, pages, -90)); } },
  { id: 'organize.rotateRight', label: 'Rotate Right', icon: 'rotate_right', tab: 'Organize Pages', group: 'Rotate and Crop', keys: ['Mod-Shift-ArrowRight'], popular: true, tip: 'Rotate the selected pages 90° clockwise (saved in the file)', run: (app) => { const pages = sel(app); app.edit('Rotate Right', (doc) => rotatePages(doc, pages, 90)); } },
  { id: 'organize.rotate180', label: 'Rotate 180°', icon: 'flip_camera_android', tab: 'Organize Pages', group: 'Rotate and Crop', run: (app) => { const pages = sel(app); app.edit('Rotate 180°', (doc) => rotatePages(doc, pages, 180)); } },
  {
    id: 'organize.crop', label: 'Crop…', icon: 'crop', tab: 'Organize Pages', group: 'Rotate and Crop', tip: 'Trim margins from the selected pages (the content stays in the file; Undo restores it), or drag a crop rectangle',
    run: async (app) => {
      const tab = app.tab;
      const pages = sel(tab);
      const p = pageOf(tab, pages[0]);
      const r = await openDialog({ title: 'Crop Pages', fields: [
        { key: 'i', type: 'info', html: `<p class="ql-help">Pages ${esc(compressRange(pages))}; page ${pages[0] + 1} is ${(p.cropBox[2] - p.cropBox[0]).toFixed(0)} × ${(p.cropBox[3] - p.cropBox[1]).toFixed(0)} pt. Margins to remove, in points (72 = 1 in):</p>` },
        { key: 'left', label: 'Left', type: 'number', value: 0, half: true }, { key: 'right', label: 'Right', type: 'number', value: 0, half: true },
        { key: 'top', label: 'Top', type: 'number', value: 0, half: true }, { key: 'bottom', label: 'Bottom', type: 'number', value: 0, half: true },
      ], ok: 'Crop', buttons: [{ label: 'Drag a Rectangle Instead', onClick: (_v, ctl) => { ctl.close(null); tab.ui.setTool('crop'); toast('Drag the area to keep on the page.', { ms: 3000 }); } }, { label: 'Remove Cropping', onClick: (_v, ctl) => { ctl.close(null); guarded('Remove Cropping', () => editTab(app, tab, 'Remove Cropping', (doc) => setPageBox(doc, pages, 'CropBox', null))); } }] });
      if (!r) return;
      editTab(app, tab, 'Crop Pages', (doc) => cropPages(doc, pages, { left: +r.left || 0, top: +r.top || 0, right: +r.right || 0, bottom: +r.bottom || 0 }));
    },
  },
  {
    id: 'organize.pageBoxes', label: 'Page Boxes…', icon: 'select_all', tab: 'Organize Pages', group: 'Rotate and Crop', tip: 'Set the media, crop, bleed, trim and art boxes of the selected pages in points',
    run: async (app) => {
      const tab = app.tab;
      const pages = sel(tab); const p = pageOf(tab, pages[0]);
      const box = (k: string) => { const b = tab.doc.rect(p.dict.get(k)); return b ? b.map((v) => +v.toFixed(2)).join(' ') : ''; };
      const r = await openDialog({ title: 'Page Boxes', fields: [
        { key: 'i', type: 'info', html: `<p class="ql-help">Four numbers each: left bottom right top (points). Leave a box empty to remove it. Pages ${esc(compressRange(pages))}.</p>` },
        { key: 'MediaBox', label: 'MediaBox (the page)', type: 'text', value: p.mediaBox.map((v) => +v.toFixed(2)).join(' ') },
        { key: 'CropBox', label: 'CropBox (what is shown)', type: 'text', value: box('CropBox') },
        { key: 'BleedBox', label: 'BleedBox', type: 'text', value: box('BleedBox') }, { key: 'TrimBox', label: 'TrimBox', type: 'text', value: box('TrimBox') }, { key: 'ArtBox', label: 'ArtBox', type: 'text', value: box('ArtBox') },
      ], ok: 'Apply' });
      if (!r) return;
      editTab(app, tab, 'Page Boxes', (doc) => { for (const k of ['MediaBox', 'CropBox', 'BleedBox', 'TrimBox', 'ArtBox'] as const) { const s = String(r[k]).trim(); if (!s) { if (k !== 'MediaBox') setPageBox(doc, pages, k, null); continue; } const v = s.split(/[\s,]+/).map(Number); if (v.length === 4 && v.every((x) => Number.isFinite(x))) setPageBox(doc, pages, k, [v[0], v[1], v[2], v[3]]); } });
    },
  },
  {
    id: 'organize.scale', label: 'Resize Pages…', icon: 'aspect_ratio', tab: 'Organize Pages', group: 'Rotate and Crop', tip: 'Scale the page content to another paper size or by a factor',
    run: async (app) => {
      const tab = app.tab;
      const pages = sel(tab);
      const r = await openDialog({ title: 'Resize Pages', fields: [{ key: 'mode', label: 'Resize', type: 'radio', options: [{ value: 'paper', label: 'To a paper size (content scaled to fit, centered)' }, { value: 'factor', label: 'By a factor' }], value: 'paper' }, { key: 'paper', label: 'Paper', type: 'select', options: Object.keys(PAPER).map((k) => ({ value: k, label: k.toUpperCase() })), value: 'a4', visibleIf: (v) => v.mode === 'paper', half: true }, { key: 'land', label: 'Landscape', type: 'checkbox', value: false, visibleIf: (v) => v.mode === 'paper', half: true }, { key: 'factor', label: 'Factor (1 = unchanged)', type: 'number', min: 0.05, max: 20, step: 0.05, value: 1, visibleIf: (v) => v.mode === 'factor' }], ok: 'Resize' });
      if (!r) return;
      let paper: [number, number] | undefined = r.mode === 'paper' ? [...PAPER[r.paper]] as [number, number] : undefined;
      if (paper && r.land) paper = [paper[1], paper[0]];
      editTab(app, tab, 'Resize Pages', (doc) => scalePages(doc, pages, paper ? { paper } : { factor: +r.factor || 1 }));
    },
  },
  {
    id: 'organize.pageLabels', label: 'Page Labels…', icon: 'label', tab: 'Organize Pages', group: 'Page Marks', tip: 'Number ranges of pages as i, ii, iii or A-1, A-2 (how readers show page numbers)',
    run: async (app) => {
      const tab = app.tab;
      const cur = readPageLabels(tab.doc);
      const text = cur.map((l) => `${l.start + 1}: ${l.style || ''}${l.prefix ? ` "${l.prefix}"` : ''}${l.first ? ` ${l.first}` : ''}`).join('\n');
      const r = await openDialog({ title: 'Page Labels', wide: true, fields: [{ key: 't', label: 'Ranges, one per line: start-page: style "prefix" first-number', type: 'textarea', rows: 8, value: text || `1: r\n${Math.min(tab.doc.pageCount, 3)}: D 1`, help: 'Styles: D = 1, 2, 3; R = I, II; r = i, ii; A = A, B; a = a, b. Example: 1: r (roman from page 1), 4: D 1 (arabic from page 4 starting at 1), 10: D "A-" 1 (A-1, A-2 …).' }], ok: 'Apply', buttons: [{ label: 'Remove Labels', onClick: (_v, ctl) => { ctl.close(null); guarded('Remove Page Labels', () => editTab(app, tab, 'Remove Page Labels', (doc) => writePageLabels(doc, []))); } }] });
      if (!r) return;
      const ranges = parseLabels(String(r.t));
      if (!ranges.length) { toast('No valid ranges.'); return; }
      if (ranges[0].start !== 0) ranges.unshift({ start: 0, style: 'D' });
      editTab(app, tab, 'Page Labels', (doc) => writePageLabels(doc, ranges));
    },
  },
  {
    id: 'organize.headerFooter', label: 'Header and Footer…', icon: 'vertical_align_top', tab: 'Organize Pages', group: 'Page Marks', tip: 'Text at the top or bottom of pages: page numbers, dates, titles',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Header and Footer', wide: true, fields: [
        rangeField(tab), { key: 'hl', label: 'Header left', type: 'text', value: '', half: true }, { key: 'hc', label: 'Header center', type: 'text', value: '', half: true }, { key: 'hr', label: 'Header right', type: 'text', value: '', half: true },
        { key: 'fl', label: 'Footer left', type: 'text', value: '', half: true }, { key: 'fc', label: 'Footer center', type: 'text', value: 'Page {page} of {pages}', half: true }, { key: 'fr', label: 'Footer right', type: 'text', value: '', half: true },
        { key: 'font', label: 'Font', type: 'select', options: FONT_OPTIONS, value: 'Helvetica', half: true }, { key: 'size', label: 'Size (pt)', type: 'number', min: 4, max: 48, value: 9, half: true }, { key: 'margin', label: 'Margin (pt)', type: 'number', min: 4, max: 200, value: 36, half: true }, { key: 'color', label: 'Color', type: 'color', value: '#333333', half: true },
        { key: 'i', type: 'info', html: '<p class="ql-help">Placeholders: {page} {pages} {label} {title} {date} {bates:000001}.</p>' },
      ], ok: 'Add' });
      if (!r) return;
      const pages = pagesFromRange(tab, r.range);
      const labels = viewerOf(tab).pageLabels();
      const specs: [string, string][] = [['top-left', r.hl], ['top-center', r.hc], ['top-right', r.hr], ['bottom-left', r.fl], ['bottom-center', r.fc], ['bottom-right', r.fr]];
      editTab(app, tab, 'Header and Footer', (doc) => { for (const [position, text] of specs) if (String(text).trim()) addOverlayText(doc, pages, { text, font: r.font, size: +r.size || 9, color: hexToRgb(r.color), position: position as any, margin: +r.margin || 36 }, (i) => ({ label: labels[i], title: tab.title })); });
    },
  },
  {
    id: 'organize.bates', label: 'Bates Numbering…', icon: 'format_list_numbered', tab: 'Organize Pages', group: 'Page Marks', tip: 'Sequential document numbers for legal discovery (prefix, zero-padded number, suffix)',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Bates Numbering', fields: [rangeField(tab), { key: 'prefix', label: 'Prefix', type: 'text', value: 'ABC', half: true }, { key: 'suffix', label: 'Suffix', type: 'text', value: '', half: true }, { key: 'start', label: 'Start at', type: 'number', min: 0, value: 1, half: true }, { key: 'digits', label: 'Digits', type: 'number', min: 1, max: 12, value: 6, half: true }, { key: 'pos', label: 'Position', type: 'select', options: POSITIONS, value: 'bottom-right', half: true }, { key: 'size', label: 'Size (pt)', type: 'number', min: 4, max: 36, value: 9, half: true }], ok: 'Add' });
      if (!r) return;
      const pages = pagesFromRange(tab, r.range);
      editTab(app, tab, 'Bates Numbering', (doc) => addBates(doc, pages, { prefix: r.prefix, suffix: r.suffix, start: r.start === '' || r.start == null || !Number.isFinite(+r.start) ? 1 : Math.max(0, Math.floor(+r.start)), digits: +r.digits || 6, position: r.pos, size: +r.size || 9 }));
    },
  },
  {
    id: 'organize.watermark', label: 'Watermark…', icon: 'water_drop', tab: 'Organize Pages', group: 'Page Marks', popular: true,
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Watermark', fields: [rangeField(tab), { key: 'text', label: 'Text', type: 'text', value: 'DRAFT' }, { key: 'size', label: 'Size (pt)', type: 'number', min: 8, max: 400, value: 72, half: true }, { key: 'opacity', label: 'Opacity', type: 'range', min: 0.05, max: 1, step: 0.05, value: 0.2, half: true }, { key: 'rotate', label: 'Angle', type: 'number', min: -90, max: 90, value: 45, half: true }, { key: 'color', label: 'Color', type: 'color', value: '#c62828', half: true }, { key: 'under', label: 'Behind the page content', type: 'checkbox', value: false }], ok: 'Add' });
      if (!r || !String(r.text).trim()) return;
      const pages = pagesFromRange(tab, r.range);
      editTab(app, tab, 'Watermark', (doc) => addWatermark(doc, pages, r.text, { size: +r.size || 72, opacity: +r.opacity, color: hexToRgb(r.color), rotate: +r.rotate || 0, underlay: r.under }));
    },
  },
  {
    id: 'organize.background', label: 'Background…', icon: 'format_color_fill', tab: 'Organize Pages', group: 'Page Marks', tip: 'A solid background color behind the page content',
    run: async (app) => { const tab = app.tab; const r = await openDialog({ title: 'Page Background', fields: [rangeField(tab), { key: 'color', label: 'Color', type: 'color', value: '#fff8e1' }], ok: 'Apply' }); if (!r) return; const pages = pagesFromRange(tab, r.range); editTab(app, tab, 'Background', (doc) => setBackgroundColor(doc, pages, hexToRgb(r.color))); },
  },
  {
    id: 'organize.imageOverlay', label: 'Image Overlay…', icon: 'imagesmode', tab: 'Organize Pages', group: 'Page Marks', tip: 'A picture (logo, stamp) at the same place on every chosen page',
    run: async (app) => {
      const tab = app.tab;
      const [f] = await pickFile('image/*'); if (!f) return;
      const spec = await imageSpecFromBytes(new Uint8Array(await f.arrayBuffer()), f.type === 'image/jpeg' ? 'jpeg' : undefined);
      const r = await openDialog({ title: 'Image Overlay', fields: [rangeField(tab), { key: 'w', label: 'Width (pt)', type: 'number', min: 4, value: Math.round(Math.min(144, spec.width / 2)), half: true }, { key: 'pos', label: 'Position', type: 'select', options: POSITIONS, value: 'top-right', half: true }, { key: 'margin', label: 'Margin (pt)', type: 'number', min: 0, value: 24, half: true }, { key: 'opacity', label: 'Opacity', type: 'range', min: 0.05, max: 1, step: 0.05, value: 1, half: true }, { key: 'under', label: 'Behind the page content', type: 'checkbox', value: false }], ok: 'Add' });
      if (!r) return;
      const pages = pagesFromRange(tab, r.range);
      const w = +r.w || 100, hh = w * spec.height / spec.width, m = +r.margin || 0;
      editTab(app, tab, 'Image Overlay', (doc) => {
        const ref = imageXObject(doc, spec);
        for (const i of pages) {
          const p = doc.pages[i];
          if (!p) continue;
          // Placed in the page as the reader sees it: each page's own visible size, crop box and rotation.
          const x = /left/.test(r.pos) ? m : /right/.test(r.pos) ? p.width - w - m : (p.width - w) / 2;
          const y = /top/.test(r.pos) ? p.height - hh - m : /bottom/.test(r.pos) ? m : (p.height - hh) / 2;
          const name = ensureXObject(doc, p, 'QFIm', ref);
          const gs = +r.opacity < 1 ? `/${ensureExtGState(doc, p, new Dict({ Type: Name.get('ExtGState'), CA: +r.opacity, ca: +r.opacity }))} gs ` : '';
          appendContent(doc, p, bytesOf(`q ${gs}${uprightMatrix(p, x, y, w, hh).map(fmtNum).join(' ')} cm /${name} Do Q`), !!r.under);
        }
      });
    },
  },
  {
    id: 'organize.booklet', label: 'Booklet…', icon: 'menu_book', tab: 'Organize Pages', group: 'Imposition', edits: false, tip: 'Impose the pages two-up in saddle-stitch order for duplex printing and folding',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Make Booklet', fields: [{ key: 'paper', label: 'Sheet', type: 'select', options: Object.keys(PAPER).map((k) => ({ value: k, label: `${k.toUpperCase()} landscape` })), value: 'letter' }, { key: 'out', label: 'Then', type: 'radio', options: [{ value: 'tab', label: 'Open as a new document' }, { value: 'save', label: 'Save as a file' }], value: 'tab' }], ok: 'Make Booklet' });
      if (!r) return;
      const paper = PAPER[r.paper];
      const out = booklet(tab.doc, [paper[1], paper[0]]);
      const bytes = out.save({ incremental: false });
      if (r.out === 'save') await saveBytes(bytes, `${baseName(tab)} booklet.pdf`, 'application/pdf');
      else openAsNewTab(app, bytes, `${baseName(tab)} booklet`);
    },
  },
  {
    id: 'organize.nUp', label: 'N-up…', icon: 'grid_on', tab: 'Organize Pages', group: 'Imposition', edits: false, tip: 'Several pages per sheet (2-up, 4-up, 6-up…)',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'N-up', fields: [{ key: 'cols', label: 'Columns', type: 'number', min: 1, max: 6, value: 2, half: true }, { key: 'rows', label: 'Rows', type: 'number', min: 1, max: 6, value: 1, half: true }, { key: 'paper', label: 'Sheet', type: 'select', options: Object.keys(PAPER).map((k) => ({ value: k, label: k.toUpperCase() })), value: 'letter', half: true }, { key: 'land', label: 'Landscape', type: 'checkbox', value: true, half: true }, { key: 'order', label: 'Order', type: 'select', options: [{ value: 'across', label: 'Across then down' }, { value: 'down', label: 'Down then across' }], value: 'across', half: true }, { key: 'margin', label: 'Margin (pt)', type: 'number', min: 0, value: 18, half: true }, { key: 'out', label: 'Then', type: 'radio', options: [{ value: 'tab', label: 'Open as a new document' }, { value: 'save', label: 'Save as a file' }], value: 'tab' }], ok: 'Impose' });
      if (!r) return;
      let paper: [number, number] = [...PAPER[r.paper]] as [number, number];
      if (r.land && paper[0] < paper[1]) paper = [paper[1], paper[0]];
      const out = nUp(tab.doc, { cols: +r.cols || 2, rows: +r.rows || 1, paper, margin: +r.margin || 0, gap: 8, order: r.order });
      const bytes = out.save({ incremental: false });
      if (r.out === 'save') await saveBytes(bytes, `${baseName(tab)} ${r.cols}x${r.rows}-up.pdf`, 'application/pdf');
      else openAsNewTab(app, bytes, `${baseName(tab)} N-up`);
    },
  },
  { id: 'organize.selectAll', label: 'Select All Pages', icon: 'select_all', tab: 'Organize Pages', group: 'Select', noRecord: true, edits: false, run: (app) => viewer(app).selectAllPages() },
  { id: 'organize.selectOdd', label: 'Select Odd Pages', icon: 'filter_1', tab: 'Organize Pages', group: 'Select', noRecord: true, edits: false, run: (app) => { const v = viewer(app); v.pageSel = app.doc.pages.map((_, i) => i).filter((i) => i % 2 === 0); v.renderRail(); v.layout(); app.refresh(); } },
  { id: 'organize.selectEven', label: 'Select Even Pages', icon: 'filter_2', tab: 'Organize Pages', group: 'Select', noRecord: true, edits: false, run: (app) => { const v = viewer(app); v.pageSel = app.doc.pages.map((_, i) => i).filter((i) => i % 2 === 1); v.renderRail(); v.layout(); app.refresh(); } },
  { id: 'organize.selectRange', label: 'Select Pages…', icon: 'checklist', tab: 'Organize Pages', group: 'Select', noRecord: true, edits: false, run: async (app) => { const tab = app.tab; const r = await askPages(tab, 'Select Pages', [], 'Select'); if (!r) return; const v = viewerOf(tab); v.pageSel = r.pages; v.renderRail(); v.layout(); app.refresh(); } },
  { id: 'organize.selectNone', label: 'Clear Page Selection', icon: 'deselect', tab: 'Organize Pages', group: 'Select', noRecord: true, edits: false, run: (app) => { const v = viewer(app); v.pageSel = []; v.renderRail(); v.layout(); app.refresh(); } },
  {
    id: 'organize.interleave', label: 'Interleave Two Documents…', icon: 'shuffle', tab: 'Organize Pages', group: 'Split and Merge', tip: 'Alternate this document\'s pages with another\'s (fronts and backs scanned separately)',
    run: async (app) => {
      const tab = app.tab;
      const [f] = await pickFile('.pdf'); if (!f) return;
      const [src] = await docsFromFiles([f], (m) => toast(m)); if (!src) return;
      const r = await openDialog({ title: 'Interleave', fields: [{ key: 'rev', label: `Reverse the pages of ${f.name} first (backs scanned last page first)`, type: 'checkbox', value: true }], ok: 'Interleave' });
      if (!r) return;
      editTab(app, tab, 'Interleave', (doc) => { const n = doc.pageCount; const other = src.doc.pages.map((_, i) => i); if (r.rev) other.reverse(); importPages(src.doc, doc, other, n, { keepAnnots: true }); const order: number[] = []; for (let i = 0; i < Math.max(n, other.length); i++) { if (i < n) order.push(i); if (i < other.length) order.push(n + i); } setPageOrder(doc, order); });
    },
  },
]);

export { addBlankPage };

/**
 * Writes the parts of a split into one ZIP, building each part only when its turn comes and letting its
 * document go once its bytes are in the archive: at any time one part's document is held, plus the archive.
 * Parts with the same name are kept apart ("… (2).pdf").
 */
export async function saveSplitZip(src: PdfDocument, mode: Parameters<typeof splitGroups>[1], groups: { name: string; pages: number[] }[], base: string): Promise<boolean> {
  const names = uniqueNames(groups.map((g) => `${base} ${g.name}.pdf`));
  const zip = new ZipWriter();
  let k = 0;
  for (const p of splitParts(src, mode, groups)) zip.add(names[k++], p.doc.save({ incremental: false }));
  const r = await saveAs(new Blob(zip.finish() as BlobPart[], { type: 'application/zip' }), safeName(`${base} split.zip`));
  if (r) toast(`Saved ${r.name}`);
  return !!r;
}
