/**
 * The renderer: pdf.js (Apache 2.0) rasterizes pages and extracts positioned text for the viewer.
 * Anne's Folio's own engine remains the document of record; pdf.js only ever reads the bytes the
 * engine produces. The worker, CMaps, standard fonts and WASM decoders are bundled (scripts/copy-pdfjs.mjs).
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { textFromItems } from './viewutil';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const base = (() => { try { return new URL('./pdfjs/', document.baseURI).href; } catch { return './pdfjs/'; } })();

/** One worker for every document: a worker per load costs a thread and a start-up on each edit. */
let shared: InstanceType<typeof pdfjs.PDFWorker> | null = null;
function sharedWorker(): InstanceType<typeof pdfjs.PDFWorker> | undefined {
  try {
    if (!shared || shared.destroyed) shared = new pdfjs.PDFWorker();
    return shared;
  } catch { return undefined; } // pdf.js then starts a worker of its own for the document
}

/** Images above this many pixels are not decoded (a 16,000 × 16,000 scan fits; a decompression bomb does not). */
const MAX_IMAGE_PIXELS = 256e6;

/** Documents above this size are read by the worker in ranges instead of being copied to it whole on every load. */
export const RANGE_LOAD_ABOVE = 8 * 1024 * 1024;

/**
 * Serves a document to the worker in the ranges it asks for. pdf.js copies each range it is handed (a
 * subarray is not a whole buffer), so `bytes` is never transferred away and stays usable by the app.
 */
export function rangeSource(bytes: Uint8Array): InstanceType<typeof pdfjs.PDFDataRangeTransport> {
  const t = new pdfjs.PDFDataRangeTransport(bytes.length, null);
  t.requestDataRange = (begin: number, end: number) => t.onDataRange(begin, bytes.subarray(begin, Math.min(end, bytes.length)));
  return t;
}

export async function openPdfjs(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  // pdf.js transfers a buffer it is given to its worker: a small document goes as a copy, a large one in ranges,
  // so that an edit to a 50 MB file does not copy and send all 50 MB again (only what the visible pages need).
  const source = bytes.length > RANGE_LOAD_ABOVE ? { range: rangeSource(bytes), length: bytes.length, disableAutoFetch: true, disableStream: true } : { data: bytes.slice() };
  const task = pdfjs.getDocument({ ...source, password, worker: sharedWorker(), cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/', wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/', stopAtErrors: false, enableXfa: false, maxImageSize: MAX_IMAGE_PIXELS } as any);
  const pdf = await task.promise;
  // pdf.js keeps destroy() on the loading task; the viewer calls it through the proxy. The shared worker stays.
  (pdf as any).destroy = () => task.destroy();
  return pdf;
}

/** `angle`: direction of the text baseline in radians, counter-clockwise in page space (0 for ordinary horizontal text). */
export interface TextItem { str: string; x: number; y: number; w: number; h: number; dir: string; fontName: string; hasEOL: boolean; angle?: number }

/** Text items in PDF user space (bottom-left origin), unrotated page coordinates. */
export async function pageTextItems(page: PDFPageProxy): Promise<TextItem[]> {
  const tc = await page.getTextContent();
  const out: TextItem[] = [];
  for (const it of tc.items as any[]) {
    if (!('str' in it)) continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    const fontH = Math.hypot(c, d) || Math.abs(d) || 1;
    const w = it.width ?? Math.hypot(a, b) * (it.str.length || 1);
    out.push({ str: it.str, x: e, y: f, w, h: it.height || fontH, dir: it.dir, fontName: it.fontName, hasEOL: !!it.hasEOL, angle: Math.atan2(b, a) });
  }
  return out;
}

/** Plain text of a page: one line break per line, a blank line between paragraphs. */
export async function pageTextString(page: PDFPageProxy): Promise<string> {
  const tc = await page.getTextContent();
  return textFromItems(tc.items as any[]);
}

export const PdfjsTextLayer = pdfjs.TextLayer;
export const AnnotationMode = pdfjs.AnnotationMode;
export const pdfjsVersion = pdfjs.version;
export type { PDFDocumentProxy, PDFPageProxy };
