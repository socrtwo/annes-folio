/**
 * Printing: pages are rendered to images at the chosen resolution and sent to the system print
 * service through a hidden frame (web and desktop) or the native print plugin (Android). The iOS app
 * with its native plugin prints a PDF of the chosen pages through the iOS print sheet instead, because
 * printing a web page from WKWebView is unreliable.
 */
import type { App } from '../app';
import { openDialog, toast } from '../ui/dialog';
import { pagesFromRange, rangeField, pageImage } from '../commands/util';
import { isNative, isIOS, printDocument, printPdf } from '../platform/native';
import { extractPages, nUp, booklet } from '../pdf/ops/pages';

export interface PrintOptions { pages?: number[]; dpi?: number; scale?: 'fit' | 'actual'; booklet?: boolean; nUp?: 1 | 2 | 4; grayscale?: boolean; annotations?: boolean }

export async function printPages(app: App, o: PrintOptions = {}): Promise<void> {
  const pages = o.pages || app.doc.pages.map((_, i) => i);
  const dpi = o.dpi || app.prefs.printDpi || 150;
  if (!pages.length) { toast('No pages to print.'); return; }
  if (pages.length > 400) { toast('Printing is limited to 400 pages at a time; print a range.'); return; }
  if (isIOS() && (await printPdfIOS(app, pages, o))) return;
  app.ui.status?.('● Preparing pages for printing…');
  const urls: string[] = [];
  // Page sizes in points, for printing at actual size.
  const sizes = pages.map((i) => { const p = app.doc.pages[i]; return p ? [p.width, p.height] : [612, 792]; });
  try {
    for (const i of pages) { const blob = await pageImage(app, i, dpi); urls.push(URL.createObjectURL(blob)); }
  } catch (e) {
    for (const u of urls) URL.revokeObjectURL(u); // nothing will print: do not keep the rendered pages
    throw e;
  } finally { app.ui.status?.(''); }
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  const per = o.nUp || 1;
  // "Actual size" gives each page its real dimensions; with several pages per sheet they are fitted instead.
  const actual = o.scale === 'actual' && per === 1;
  const css =`@page{margin:${o.scale === 'actual' ? '0' : '8mm'}} body{margin:0} .p{page-break-after:always;display:grid;grid-template-columns:repeat(${per === 4 ? 2 : per},1fr);gap:4mm;height:${o.scale === 'actual' ? 'auto' : '100vh'};align-items:center;justify-items:center;${o.grayscale ? 'filter:grayscale(1);' : ''}} .p:last-child{page-break-after:auto} img{max-width:100%;max-height:100%;object-fit:contain} img.a{max-width:none;max-height:none}`;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${(app.tab.displayName || 'Document').replace(/[<&]/g, '')}</title><style>${css}</style></head><body></body></html>`);
  doc.close();
  const order = o.booklet ? bookletOrder(urls.length) : urls.map((_, k) => k);
  for (let k = 0; k < order.length; k += per) {
    const sheet = doc.createElement('div'); sheet.className = 'p';
    for (let j = 0; j < per; j++) { const idx = order[k + j]; if (idx == null || idx < 0) { sheet.appendChild(doc.createElement('div')); continue; } const img = doc.createElement('img'); img.src = urls[idx]; if (actual) { img.className = 'a'; img.style.width = `${sizes[idx][0]}pt`; img.style.height = `${sizes[idx][1]}pt`; } sheet.appendChild(img); }
    doc.body.appendChild(sheet);
  }
  await Promise.all([...doc.images].map((im) => (im.complete ? Promise.resolve() : new Promise<void>((res) => { im.onload = () => res(); im.onerror = () => res(); }))));
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; setTimeout(() => { frame.remove(); for (const u of urls) URL.revokeObjectURL(u); }, 1500); };
  if (isNative() && !(window as any).quillDesktop) {
    // Android: the native plugin prints the current WebView; show the sheets in the page instead of a hidden frame.
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff;z-index:99999';
    try { await printDocument(app.tab.displayName); } finally { cleanup(); }
    return;
  }
  const w = frame.contentWindow!;
  // The frame stays until printing is over: where the print dialog does not block scripts, a
  // one-minute timer removed the pages while the dialog was still open.
  w.onafterprint = cleanup;
  window.addEventListener('afterprint', cleanup, { once: true });
  w.focus();
  w.print();
  setTimeout(cleanup, 15 * 60000);
}

/**
 * iOS: the chosen pages as a PDF (the pages themselves, not pictures of them) for the iOS print sheet,
 * laid out two or four to a sheet, or as a booklet, with the engine's own imposition. Grayscale is the
 * print sheet's "Black & White" option there. False when the app has no iOS print plugin.
 */
async function printPdfIOS(app: App, pages: number[], o: PrintOptions): Promise<boolean> {
  const first = app.doc.pages[pages[0]];
  const w = first?.width || 612, h = first?.height || 792;
  let doc = extractPages(app.doc, pages);
  // A booklet and two-up use a landscape sheet of the page's size; four-up a portrait one.
  if (o.booklet) doc = booklet(doc, [Math.max(w, h), Math.min(w, h)]);
  else if (o.nUp === 2) doc = nUp(doc, { cols: 2, rows: 1, paper: [Math.max(w, h), Math.min(w, h)] });
  else if (o.nUp === 4) doc = nUp(doc, { cols: 2, rows: 2, paper: [Math.min(w, h), Math.max(w, h)] });
  const bytes = doc.save({ incremental: false });
  return printPdf(new Blob([bytes as BlobPart], { type: 'application/pdf' }), app.tab.displayName || 'Document');
}

/** Sheet order for a saddle-stitched booklet printed two-up: [last, first, second, second-to-last, …]. */
export function bookletOrder(n: number): number[] {
  const total = Math.ceil(n / 4) * 4;
  const out: number[] = [];
  for (let i = 0; i < total / 2; i += 2) {
    const a = total - 1 - i, b = i, c = i + 1, d = total - 2 - i;
    out.push(a < n ? a : -1, b < n ? b : -1, c < n ? c : -1, d < n ? d : -1);
  }
  return out;
}

export async function printDialog(app: App): Promise<void> {
  const r = await openDialog({ title: 'Print', fields: [
    { key: 'which', label: 'Pages', type: 'radio', options: [{ value: 'all', label: 'All pages' }, { value: 'current', label: 'Current page' }, { value: 'range', label: 'Range' }], value: 'all' },
    { ...rangeField(app), visibleIf: (v) => v.which === 'range' },
    { key: 'dpi', label: 'Resolution', type: 'select', options: [{ value: '96', label: 'Draft (96 dpi)' }, { value: '150', label: 'Normal (150 dpi)' }, { value: '300', label: 'High (300 dpi)' }], value: String(app.prefs.printDpi || 150), half: true },
    { key: 'scale', label: 'Scale', type: 'select', options: [{ value: 'fit', label: 'Fit to printable area' }, { value: 'actual', label: 'Actual size (no margins)' }], value: 'fit', half: true },
    { key: 'nUp', label: 'Pages per sheet', type: 'select', options: ['1', '2', '4'], value: '1', half: true },
    { key: 'gray', label: 'Grayscale', type: 'checkbox', value: false, half: true },
    { key: 'booklet', label: 'Booklet order (print two per sheet, duplex, fold in the middle)', type: 'checkbox', value: false },
  ], ok: 'Print', help: 'The system print dialog follows, where you choose the printer, paper and duplex options.' });
  if (!r) return;
  const pages = r.which === 'all' ? app.doc.pages.map((_, i) => i) : r.which === 'current' ? [app.page] : pagesFromRange(app, r.range);
  app.prefs.printDpi = +r.dpi || 150; app.savePrefs();
  await printPages(app, { pages, dpi: +r.dpi || 150, scale: r.scale, nUp: r.booklet ? 2 : (+r.nUp as 1 | 2 | 4), grayscale: r.gray, booklet: r.booklet });
}
