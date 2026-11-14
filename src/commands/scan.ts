/**
 * Scan/OCR tab: PDFs from images and the camera, text recognition with tesseract.js (an invisible
 * text layer written into the page), language data on demand, and scan clean-up (deskew, despeckle,
 * auto-crop, compression, reordering). The text layer and the image math live in ocrlayer.ts.
 */
import { def } from './registry';
import type { App, DocTab } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { PdfDocument, type PageInfo } from '../pdf/document';
import { imageXObject, jpegInfo, PAPER, ensureXObject } from '../pdf/build';
import { fmtNum } from '../pdf/writer';
import { bytesOf, concat, PdfString, type Ref } from '../pdf/objects';
import { setPageBox, setPageOrder } from '../pdf/ops/pages';
import { listImages } from '../pdf/ops/optimize';
import { imageSpecFromBytes, eachImageSpec, addImagePageOriented } from '../io';
import { askPages, pageOf, saveBytes, baseName, viewerOf, esc, targetPages, editTab, stillCurrent, guarded, openAsNewTab, recompressedJpeg, replaceImageWithJpeg } from './util';
import { writeTextLayer, stripOcrLayer, invisibleRuns, applyOcrCorrections, ocrLayerText, wordFromCanvasBox, canvasPlacement, isolatedContent, estimateSkew, deskewMatrix, median3x3, inkBounds, type OcrWord } from './ocrlayer';

export { writeTextLayer, invisibleRuns, applyOcrCorrections, ocrLayerText, estimateSkew } from './ocrlayer';

export const OCR_LANGUAGES: [string, string][] = [
  ['eng', 'English'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'], ['nld', 'Dutch'], ['swe', 'Swedish'], ['dan', 'Danish'], ['nor', 'Norwegian'], ['fin', 'Finnish'],
  ['pol', 'Polish'], ['ces', 'Czech'], ['hun', 'Hungarian'], ['ron', 'Romanian'], ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['ell', 'Greek'], ['tur', 'Turkish'], ['heb', 'Hebrew'], ['ara', 'Arabic'], ['hin', 'Hindi'],
  ['chi_sim', 'Chinese (simplified)'], ['chi_tra', 'Chinese (traditional)'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['vie', 'Vietnamese'], ['tha', 'Thai'], ['ind', 'Indonesian'], ['lat', 'Latin'], ['osd', 'Orientation and script detection'],
];
const LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
const CONSENT_KEY = 'quillfolio.ocr.consent';
/** The recognition worker holds the language models in memory; it is closed after this long without use. */
const WORKER_IDLE_MS = 5 * 60 * 1000;

let workerPromise: Promise<any> | null = null;
let workerLangs = '';
let idleTimer: ReturnType<typeof setTimeout> | null = null;

async function terminateWorker(): Promise<void> {
  const p = workerPromise;
  workerPromise = null; workerLangs = '';
  if (p) { try { (await p).terminate(); } catch { /* it never started */ } }
}

async function ocrWorker(app: App, langs: string): Promise<any> {
  if (workerPromise && workerLangs === langs) return workerPromise;
  await terminateWorker();
  workerLangs = langs;
  const p = (async () => {
    const T = await import('tesseract.js');
    const base = new URL('./tesseract/', document.baseURI).href;
    return T.createWorker(langs.split('+'), T.OEM.LSTM_ONLY, {
      workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: LANG_PATH, workerBlobURL: false, gzip: true,
      logger: (m: any) => { if (m.status && typeof m.progress === 'number' && m.progress < 1) app.ui.status?.(`● OCR: ${m.status} ${Math.round(m.progress * 100)}%`); },
      errorHandler: (e: any) => console.warn('tesseract', e),
    });
  })();
  workerPromise = p;
  // A start that failed (offline, an unknown language code) is not kept: the next attempt starts a new worker.
  p.catch(() => { if (workerPromise === p) { workerPromise = null; workerLangs = ''; } });
  return p;
}

async function ensureConsent(langs: string): Promise<boolean> {
  if (localStorage.getItem(CONSENT_KEY) === '1') return true;
  const ok = await confirmDialog('Download Language Data', `Text recognition needs language data for ${langs.split('+').map((l) => OCR_LANGUAGES.find((x) => x[0] === l)?.[1] || l).join(', ')} (about 2–15 MB per language). It is downloaded once from ${LANG_PATH} and kept on this device. The page images never leave this device. Continue?`, 'Download');
  if (ok) localStorage.setItem(CONSENT_KEY, '1');
  return ok;
}

const release = (c: HTMLCanvasElement): void => { c.width = c.height = 0; };

/**
 * Renders a page's own content to a canvas at a resolution (through the viewer's renderer). Comments and
 * form-field values are left out: they are not part of the scan, and they stay live annotations afterwards.
 */
async function renderCanvas(tab: DocTab, i: number, dpi: number): Promise<{ c: HTMLCanvasElement; vp: any }> {
  const v = viewerOf(tab);
  if (!v.pdf) throw new Error('The page is not rendered yet.');
  const { AnnotationMode } = await import('../view/pdfjs');
  const page = await v.pdf.getPage(i + 1);
  const vp = page.getViewport({ scale: dpi / 72 });
  const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, annotationMode: AnnotationMode.DISABLE } as any).promise;
  return { c, vp };
}

/** Recognizes one page: returns words placed in PDF user space (also on rotated pages). */
async function recognizePage(app: App, tab: DocTab, i: number, langs: string, dpi = 200): Promise<{ words: OcrWord[]; text: string }> {
  const { c, vp } = await renderCanvas(tab, i, dpi);
  try {
    const w = await ocrWorker(app, langs);
    const res = await w.recognize(c, {}, { text: true, blocks: true });
    const toPdf = (x: number, y: number): number[] => vp.convertToPdfPoint(x, y);
    const words: OcrWord[] = [];
    for (const b of res.data.blocks || []) for (const par of b.paragraphs || []) for (const line of par.lines || []) for (const wd of line.words || []) {
      if (wd.text?.trim()) words.push(wordFromCanvasBox(toPdf, wd.bbox, wd.text, wd.confidence));
    }
    return { words, text: res.data.text || '' };
  } finally { release(c); }
}

/**
 * Follows pages through a slow step. Page indexes taken before it are resolved again afterwards by object
 * number, so an edit made meanwhile (a comment, a deleted page) cannot send a result to the wrong page.
 * `same()` is false, with a toast, when the tab was closed or its document replaced (saved or rewritten).
 */
function pageTracker(app: App, tab: DocTab, pages: number[]): { same: () => boolean; page: (i: number) => PageInfo | undefined } {
  const doc0 = tab.doc;
  const nums = new Map(pages.map((i) => [i, doc0.pages[i]?.ref?.num] as [number, number | undefined]));
  return {
    same: () => {
      if (!stillCurrent(app, tab)) return false;
      if (tab.doc !== doc0) { toast(`"${tab.displayName}" was saved or rewritten while this was running; nothing was applied. Run it again.`, { ms: 6000 }); return false; }
      return true;
    },
    page: (i) => { const n = nums.get(i); return n == null ? undefined : tab.doc.pages.find((p) => p.ref?.num === n); },
  };
}

async function recognize(app: App, tab: DocTab, pages: number[], langs: string, replace: boolean): Promise<{ words: number; pages: number } | null> {
  if (!(await ensureConsent(langs))) return null;
  const track = pageTracker(app, tab, pages);
  const results: { i: number; words: OcrWord[] }[] = [];
  if (idleTimer) clearTimeout(idleTimer);
  try {
    for (const [k, i] of pages.entries()) {
      if (!app.docs.includes(tab)) break;
      app.ui.status?.(`● OCR page ${i + 1} (${k + 1} of ${pages.length})…`);
      results.push({ i, words: (await recognizePage(app, tab, i, langs)).words });
    }
  } finally {
    app.ui.status?.('');
    idleTimer = setTimeout(() => { void terminateWorker(); }, WORKER_IDLE_MS);
  }
  if (!track.same()) return null;
  let words = 0, done = 0;
  const ok = editTab(app, tab, 'Recognize Text', (doc) => {
    for (const r of results) { const p = track.page(r.i); if (!p) continue; if (replace) stripOcrLayer(doc, p); writeTextLayer(doc, p, r.words, langs); words += r.words.length; done++; }
    return true;
  });
  return ok ? { words, pages: done } : null;
}

function gray(c: HTMLCanvasElement): Uint8ClampedArray {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const g = new Uint8ClampedArray(c.width * c.height);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  return g;
}

/**
 * Replaces a page's content with a JPEG of its rendering, drawn with the matrix that puts it back exactly
 * where the page showed it. The page's rotation, boxes and annotations stay untouched, so rotated or
 * cropped pages keep their look and comments stay where they were.
 */
function replaceWithImage(doc: PdfDocument, p: PageInfo, jpeg: Uint8Array, m: number[]): void {
  const info = jpegInfo(jpeg);
  if (!info) throw new Error('Could not encode the page image.');
  const ref = imageXObject(doc, { kind: 'jpeg', data: jpeg, width: info.width, height: info.height, gray: info.components === 1 });
  const name = ensureXObject(doc, p, 'QFScan', ref);
  doc.setPageContent(p, bytesOf(`q ${m.map(fmtNum).join(' ')} cm /${name} Do Q\n`));
}

const toJpeg = (c: HTMLCanvasElement, q = 0.85): Promise<Uint8Array> => new Promise((res, rej) => c.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('Could not encode the page image.'))), 'image/jpeg', q));

def([
  {
    id: 'scan.fromImages', label: 'PDF from Images…', icon: 'photo_library', tab: 'Scan/OCR', group: 'Create', popular: true, noRecord: true, edits: false,
    tip: 'Photos, scans and screenshots as a new PDF, one per page',
    run: async (app) => {
      const files = await pickFile('image/*', true);
      if (!files.length) return;
      const r = await openDialog({ title: 'PDF from Images', fields: [{ key: 'paper', label: 'Page size', type: 'select', options: [{ value: 'image', label: 'Fit the page to each picture' }, ...Object.keys(PAPER).map((k) => ({ value: k, label: k.toUpperCase() }))], value: 'image', half: true }, { key: 'dpi', label: 'Picture resolution (dpi)', type: 'number', min: 36, max: 1200, value: 200, half: true }, { key: 'ocr', label: 'Recognize text afterwards', type: 'checkbox', value: false }], ok: 'Create' });
      if (!r) return;
      const doc = PdfDocument.create();
      // Every page of a multi-page TIFF becomes a page; JPEGs are turned as their EXIF orientation asks.
      for (const f of files) { try { for (const w of await eachImageSpec(new Uint8Array(await f.arrayBuffer()), f.type === 'image/jpeg' ? 'jpeg' : undefined, (spec) => { addImagePageOriented(doc, spec, { paper: r.paper === 'image' ? 'image' : PAPER[r.paper], dpi: +r.dpi || 200 }); })) toast(`${f.name}: ${w}`); } catch (e: any) { toast(`${f.name}: ${e?.message || e}`); } }
      if (!doc.pageCount) return;
      const name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : 'Scanned pages';
      const t = openAsNewTab(app, doc.save({ incremental: false }), name);
      if (r.ocr) { await t.ui.reload(); if (app.tab === t) app.exec('scan.recognize', { pages: t.doc.pages.map((_, i) => i) }); }
    },
  },
  {
    id: 'scan.fromCamera', label: 'Scan with Camera', icon: 'photo_camera', tab: 'Scan/OCR', group: 'Create', noRecord: true,
    tip: 'Take a photo (on phones and tablets) and add it as a page',
    run: async (app) => {
      const tab = app.tab;
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment');
      const file = await new Promise<File | null>((res) => { input.onchange = () => res(input.files?.[0] || null); input.oncancel = () => res(null); input.click(); });
      if (!file) return;
      const spec = await imageSpecFromBytes(new Uint8Array(await file.arrayBuffer()), file.type === 'image/jpeg' ? 'jpeg' : undefined);
      const at = Math.max(...targetPages(tab)) + 1;
      if (editTab(app, tab, 'Scan with Camera', (doc) => { addImagePageOriented(doc, spec, { paper: 'image', dpi: 200, at }); return true; })) tab.ui.goToPage(at);
    },
  },
  {
    id: 'scan.recognize', label: 'Recognize Text', icon: 'document_scanner', tab: 'Scan/OCR', group: 'Recognize Text', popular: true,
    tip: 'OCR the chosen pages and add an invisible text layer so they can be searched, selected and copied (any language, including Cyrillic, Greek, Chinese, Japanese, Korean, Hebrew and Arabic)',
    run: async (app, arg?: { pages?: number[]; langs?: string }) => {
      const tab = app.tab;
      let pages = arg?.pages, langs = arg?.langs || app.prefs.ocrLanguage || 'eng', replace = true;
      if (!pages) {
        const r = await askPages(tab, 'Recognize Text', [
          { key: 'langs', label: 'Languages (codes joined with +)', type: 'text', value: langs, help: 'Scan/OCR ▸ OCR Languages lists the codes.' },
          { key: 'replace', label: 'Replace an earlier recognized layer on these pages', type: 'checkbox', value: true },
          { key: 'i', type: 'info', html: '<p class="ql-help">Recognition runs on this device. Language data (a few MB) downloads once per language. Pages with real text already do not need OCR. Comments and field values are not recognized.</p>' },
        ], 'Recognize');
        if (!r) return;
        pages = r.pages; langs = String(r.values.langs).trim() || 'eng'; replace = !!r.values.replace;
      }
      if (!/^[A-Za-z_]+(\+[A-Za-z_]+)*$/.test(langs)) { toast(`"${langs}" is not a list of language codes. Write codes joined with +, for example eng+deu.`, { ms: 6000 }); return; }
      if (!arg?.pages) { app.prefs.ocrLanguage = langs; app.savePrefs(); }
      try {
        const res = await recognize(app, tab, pages, langs, replace);
        if (res?.pages) toast(`Recognized ${res.words} word(s) on ${res.pages} page(s).`, { ms: 6000, action: 'Clean up', onAction: () => { if (app.docs.includes(tab)) { app.activate(tab); app.exec('scan.ocrCleanup'); } } });
      } catch (e: any) { app.ui.status?.(''); toast(`OCR failed: ${e?.message || e}`, { ms: 8000 }); }
    },
  },
  {
    id: 'scan.languages', label: 'OCR Languages…', icon: 'translate', tab: 'Scan/OCR', group: 'Recognize Text', noRecord: true, edits: false,
    tip: 'Choose the languages to recognize; their data downloads on first use and stays on this device',
    run: async (app) => {
      const cur = (app.prefs.ocrLanguage || 'eng').split('+');
      const r = await openDialog({ title: 'OCR Languages', fields: [
        { key: 'l', label: 'Languages (several are allowed; recognition is slower with more)', type: 'list', multiple: true, rows: 12, options: OCR_LANGUAGES.map(([v, l]) => ({ value: v, label: `${l} (${v})` })), value: cur },
        { key: 'i', type: 'info', html: `<p class="ql-help">Data comes from ${esc(LANG_PATH)} (tessdata, Apache 2.0), about 2–15 MB per language, cached in this browser. Nothing else is sent anywhere.</p>` },
      ], buttons: [{ label: 'Delete Cached Data', onClick: () => guarded('Delete Cached Data', async () => { await terminateWorker(); indexedDB.deleteDatabase('keyval-store'); toast('Cached language data deleted.'); }) }] });
      if (!r) return;
      const langs = (r.l as string[]).filter(Boolean);
      if (!langs.length) { toast('Choose at least one language.'); return; }
      app.prefs.ocrLanguage = langs.join('+'); app.savePrefs();
      toast(`OCR languages: ${langs.join(', ')}`);
    },
  },
  {
    id: 'scan.exportText', label: 'Export Recognized Text', icon: 'notes', tab: 'Scan/OCR', group: 'Recognize Text', edits: false, noRecord: true,
    tip: 'Save the text of the pages (including recognized layers) as a .txt file',
    // Always the text the pages hold now, so reordered pages and OCR Cleanup corrections are what gets exported.
    run: async (app) => { const tab = app.tab; const v = viewerOf(tab); const out: string[] = []; for (let i = 0; i < tab.doc.pageCount; i++) out.push(`--- page ${i + 1} ---\n${await v.pageText(i)}`); await saveBytes(out.join('\n\n'), `${baseName(tab)} OCR.txt`, 'text/plain'); },
  },
  {
    id: 'scan.ocrCleanup', label: 'OCR Cleanup…', icon: 'spellcheck', tab: 'Scan/OCR', group: 'Recognize Text',
    tip: 'Correct words in the recognized (invisible) text layer of the current page',
    run: async (app) => {
      const tab = app.tab;
      const p = pageOf(tab, tab.ui.page);
      const runs = invisibleRuns(tab.doc, p);
      if (!runs.length) { toast('This page has no recognized text layer. Use Recognize Text first.'); return; }
      // The layer stores right-to-left words mirrored (as PDF readers expect); here they are shown and typed in reading order.
      const shown = runs.map((x) => ocrLayerText(x.text));
      const r = await openDialog({ title: `OCR Cleanup: page ${p.index + 1}`, wide: true, fields: [{ key: 't', label: `${runs.length} recognized word(s), one per line; edit any of them`, type: 'textarea', rows: 18, value: shown.join('\n') }], ok: 'Apply' });
      if (!r) return;
      const lines = String(r.t).split('\n');
      if (lines.length !== runs.length) { toast('Keep one line per word (the number of lines changed).'); return; }
      const changes = runs.map((run, k) => ({ run, text: lines[k] })).filter((ch, k) => ch.text !== shown[k]);
      if (!changes.length) { toast('Nothing was changed.'); return; }
      // One rewrite of the page for all corrections; the words stay invisible whatever characters they hold.
      const n = editTab(app, tab, 'OCR Cleanup', (doc) => applyOcrCorrections(doc, doc.pages[p.index], changes));
      if (n != null) toast(`${n} word(s) corrected.`);
    },
  },
  {
    id: 'scan.deskew', label: 'Deskew', icon: 'rotate_90_degrees_ccw', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Straighten tilted scans (the angle is measured from the text lines; the page content is rotated about its center)',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Deskew Pages', [{ key: 'manual', label: 'Angle in degrees (blank = detect). A positive angle turns the content counter-clockwise', type: 'text', value: '' }], 'Deskew');
      if (!r) return;
      const track = pageTracker(app, tab, r.pages);
      const angles: { i: number; deg: number }[] = [];
      for (const i of r.pages) {
        let deg = parseFloat(r.values.manual);
        // Detected: how far the lines run downhill to the right, which is the counter-clockwise turn that straightens them.
        if (!Number.isFinite(deg)) { const { c } = await renderCanvas(tab, i, 50); deg = estimateSkew(gray(c), c.width, c.height); release(c); }
        if (Math.abs(deg) >= 0.25) angles.push({ i, deg });
      }
      if (!angles.length) { toast('The pages look straight already.'); return; }
      if (!track.same()) return;
      const done = editTab(app, tab, 'Deskew', (doc) => {
        for (const a of angles) {
          const p = track.page(a.i); if (!p) continue;
          const [x0, y0, x1, y1] = p.mediaBox;
          const m = deskewMatrix(a.deg, (x0 + x1) / 2, (y0 + y1) / 2);
          doc.setPageContent(p, concat([bytesOf(`q ${m.map(fmtNum).join(' ')} cm\n`), isolatedContent(doc.pageContent(p)), bytesOf('\nQ\n')]));
        }
        return true;
      });
      if (done) toast(`Deskewed ${angles.length} page(s): ${angles.map((a) => `${a.i + 1}: ${a.deg.toFixed(1)}°`).join(', ')}`);
    },
  },
  {
    id: 'scan.despeckle', label: 'Despeckle', icon: 'blur_on', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Remove dust and noise from scanned pages with a median filter (the page is replaced by its cleaned image; use on scans only)',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Despeckle Pages', [{ key: 'dpi', label: 'Resolution (dpi)', type: 'number', min: 72, max: 400, value: 200, half: true }, { key: 'bw', label: 'Also convert to black and white', type: 'checkbox', value: false, half: true }, { key: 'i', type: 'info', html: '<p class="ql-help">The page content becomes one image; text in the page (including recognized text) is lost, so run OCR afterwards. Comments and form fields stay as they are.</p>' }], 'Despeckle');
      if (!r) return;
      if (!(await confirmDialog('Despeckle', `Replace ${r.pages.length} page(s) with cleaned images?`, 'Despeckle'))) return;
      const track = pageTracker(app, tab, r.pages);
      const dpi = Math.max(72, Math.min(400, +r.values.dpi || 200));
      const images: { i: number; jpeg: Uint8Array; m: number[] }[] = [];
      try {
        for (const i of r.pages) {
          if (!app.docs.includes(tab)) break;
          app.ui.status?.(`● Cleaning page ${i + 1}…`);
          const { c, vp } = await renderCanvas(tab, i, dpi);
          const ctx = c.getContext('2d')!; const id = ctx.getImageData(0, 0, c.width, c.height); const d = id.data;
          const out = median3x3(gray(c), c.width, c.height);
          for (let j = 0, k = 0; j < d.length; j += 4, k++) { const v = r.values.bw ? (out[k] < 150 ? 0 : 255) : out[k]; d[j] = d[j + 1] = d[j + 2] = v; }
          ctx.putImageData(id, 0, 0);
          images.push({ i, jpeg: await toJpeg(c, r.values.bw ? 0.9 : 0.85), m: canvasPlacement((x, y) => vp.convertToPdfPoint(x, y), c.width, c.height) });
          release(c);
        }
      } finally { app.ui.status?.(''); }
      if (!track.same()) return;
      editTab(app, tab, 'Despeckle', (doc) => { for (const im of images) { const p = track.page(im.i); if (p) replaceWithImage(doc, p, im.jpeg, im.m); } });
    },
  },
  {
    id: 'scan.autoCrop', label: 'Auto-Crop', icon: 'crop_free', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Trim the white borders of scanned pages (sets the crop box; nothing is deleted)',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Auto-Crop Pages', [{ key: 'margin', label: 'Keep a margin of (pt)', type: 'number', min: 0, max: 144, value: 12 }], 'Crop');
      if (!r) return;
      const track = pageTracker(app, tab, r.pages);
      const m = Math.max(0, +r.values.margin || 0);
      const boxes: { i: number; box: [number, number, number, number] }[] = [];
      for (const i of r.pages) {
        const { c, vp } = await renderCanvas(tab, i, 72);
        // Rows and columns need a few dark pixels to count, so single specks at the edge do not stop the crop.
        const ink = inkBounds(gray(c), c.width, c.height);
        release(c);
        if (!ink) continue;
        const pts = [[ink.x0, ink.y0], [ink.x1, ink.y0], [ink.x0, ink.y1], [ink.x1, ink.y1]].map(([x, y]) => vp.convertToPdfPoint(x, y) as number[]);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        boxes.push({ i, box: [Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m] });
      }
      if (!boxes.length) { toast('No content was found to crop to.'); return; }
      if (!track.same()) return;
      let n = 0;
      editTab(app, tab, 'Auto-Crop', (doc) => {
        for (const b of boxes) {
          const p = track.page(b.i); if (!p) continue;
          const box: [number, number, number, number] = [Math.max(p.mediaBox[0], b.box[0]), Math.max(p.mediaBox[1], b.box[1]), Math.min(p.mediaBox[2], b.box[2]), Math.min(p.mediaBox[3], b.box[3])];
          if (box[2] - box[0] > 1 && box[3] - box[1] > 1) { setPageBox(doc, [p.index], 'CropBox', box); n++; }
        }
      });
      if (n) toast(`${n} page(s) cropped. Organize Pages ▸ Crop ▸ Remove Cropping undoes it later.`);
    },
  },
  {
    id: 'scan.compressScans', label: 'Compress Scans…', icon: 'compress', tab: 'Scan/OCR', group: 'Enhance Scans',
    tip: 'Re-encode large page images as JPEG at a chosen quality and size',
    run: async (app) => {
      const tab = app.tab;
      const r = await askPages(tab, 'Compress Scanned Images', [{ key: 'q', label: 'JPEG quality', type: 'range', min: 0.3, max: 0.95, step: 0.05, value: 0.7, half: true }, { key: 'max', label: 'Longest side (px)', type: 'number', min: 300, max: 6000, value: 2000, half: true }, { key: 'gray', label: 'Convert to grayscale', type: 'checkbox', value: false }], 'Compress');
      if (!r) return;
      const track = pageTracker(app, tab, r.pages);
      const doc0 = tab.doc;
      const want = new Set(r.pages);
      // Images with a mask and stencil masks are left alone (recompressedJpeg skips them): a JPEG cannot stand in for either.
      const imgs = listImages(doc0).filter((im) => want.has(im.page) && im.ref && (im.width > 400 || im.height > 400));
      if (!imgs.length) { toast('No large images on those pages.'); return; }
      const before = imgs.reduce((n, im) => n + im.bytes, 0);
      const jobs: { ref: Ref; jpeg: Uint8Array; was: number }[] = [];
      try {
        for (const [k, im] of imgs.entries()) {
          app.ui.status?.(`● Compressing image ${k + 1} of ${imgs.length}…`);
          try { const jpeg = await recompressedJpeg(doc0, im, +r.values.max || 2000, +r.values.q || 0.7, !!r.values.gray); if (jpeg) jobs.push({ ref: im.ref!, jpeg, was: im.bytes }); }
          catch (e) { console.warn('compress', e); }
        }
      } finally { app.ui.status?.(''); }
      if (!jobs.length) { toast('The images are already small (or cannot be re-encoded here).'); return; }
      if (!track.same()) return;
      if (!editTab(app, tab, 'Compress Scans', (doc) => { for (const j of jobs) replaceImageWithJpeg(doc, j.ref, j.jpeg); return true; })) return;
      const after = before - jobs.reduce((n, j) => n + j.was - j.jpeg.length, 0);
      toast(`${jobs.length} image(s) recompressed: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB. Save As a rewritten PDF to shrink the file.`, { ms: 8000 });
    },
  },
  {
    id: 'scan.reorder', label: 'Reorder Duplex Scan', icon: 'swap_calls', tab: 'Scan/OCR', group: 'Pages',
    tip: 'Fix a one-sided scanner\'s output: fronts (1, 3, 5…) followed by backs (6, 4, 2) become 1, 2, 3…',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Reorder Duplex Scan', fields: [{ key: 'mode', label: 'The pages are', type: 'radio', options: [{ value: 'backsReversed', label: 'All fronts, then all backs scanned last page first' }, { value: 'backsForward', label: 'All fronts, then all backs in order' }, { value: 'alternate', label: 'Alternating already; swap each pair' }], value: 'backsReversed' }], ok: 'Reorder' });
      if (!r) return;
      editTab(app, tab, 'Reorder Duplex Scan', (doc) => {
        const n = doc.pageCount, half = Math.ceil(n / 2);
        const order: number[] = [];
        if (r.mode === 'alternate') { for (let i = 0; i < n; i += 2) { if (i + 1 < n) order.push(i + 1); order.push(i); } }
        else { const fronts = [...Array(half).keys()]; const backs = [...Array(n - half).keys()].map((k) => half + k); if (r.mode === 'backsReversed') backs.reverse(); for (let i = 0; i < half; i++) { order.push(fronts[i]); if (backs[i] != null) order.push(backs[i]); } }
        setPageOrder(doc, order);
      });
      viewerOf(tab).pageSel = [];
    },
  },
  {
    id: 'scan.makeSearchableReport', label: 'Searchable Pages Report', icon: 'fact_check', tab: 'Scan/OCR', group: 'Recognize Text', edits: false, noRecord: true,
    tip: 'Which pages have text (real or recognized) and which are image-only',
    run: async (app) => {
      const tab = app.tab;
      const v = viewerOf(tab);
      const items = [] as { level: 'info' | 'warning'; text: string; page: number }[];
      for (let i = 0; i < tab.doc.pageCount; i++) { const t = (await v.pageText(i)).trim(); const ocr = !!tab.doc.pages[i]?.dict.has('QuillFolioOCR'); items.push(t ? { level: 'info', text: `Page ${i + 1}: ${t.split(/\s+/).length} word(s)${ocr ? ' (recognized)' : ''}`, page: i } : { level: 'warning', text: `Page ${i + 1}: no text (image only)`, page: i }); }
      const missing = items.filter((x) => x.level === 'warning').map((x) => x.page);
      if (!stillCurrent(app, tab)) return;
      app.ui.openPane('report', { title: app.tab === tab ? 'Searchable Pages' : `Searchable Pages: ${tab.displayName}`, items, actions: missing.length ? [{ label: `Recognize ${missing.length} page(s)`, run: () => { if (app.docs.includes(tab)) { app.activate(tab); app.exec('scan.recognize', { pages: missing }); } } }] : [] });
    },
  },
]);

export { PdfString };
