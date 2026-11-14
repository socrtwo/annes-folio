// iOS app with the QuillIOS plugin: Print sends a PDF of the chosen pages to the iOS print sheet (WKWebView
// cannot reliably print a web page); booklet and N-up are laid out by the engine first.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { makeTextPdf } from '../../src/pdf/build';

const printed: { bytes: Uint8Array; job: string }[] = [];
let ios = true;
vi.mock('../../src/platform/native', () => ({
  isNative: () => false,
  isIOS: () => ios,
  printDocument: async () => {},
  printPdf: async (b: Blob, job: string) => { if (!ios) return false; printed.push({ bytes: new Uint8Array(await b.arrayBuffer()), job }); return true; },
}));
vi.mock('../../src/commands/util', () => ({ pagesFromRange: () => [], rangeField: () => ({}), pageImage: async () => { throw new Error('should not render page images on iOS'); } }));

const appWith = (doc: PdfDocument) => ({ doc, prefs: { printDpi: 150 }, tab: { displayName: 'Report' }, ui: { status: () => {} } }) as any;

describe('printing on iOS', () => {
  beforeEach(() => { printed.length = 0; ios = true; });
  it('prints the chosen pages as a PDF', async () => {
    const { printPages } = await import('../../src/export/print');
    const doc = PdfDocument.load(makeTextPdf(['one', 'two', 'three']));
    await printPages(appWith(doc), { pages: [0, 2] });
    expect(printed).toHaveLength(1);
    expect(printed[0].job).toBe('Report');
    const out = PdfDocument.load(printed[0].bytes);
    expect(out.pageCount).toBe(2);
  });
  it('lays out four pages to a sheet and a booklet before printing', async () => {
    const { printPages } = await import('../../src/export/print');
    const doc = PdfDocument.load(makeTextPdf(['1', '2', '3', '4']));
    await printPages(appWith(doc), { nUp: 4 });
    expect(PdfDocument.load(printed[0].bytes).pageCount).toBe(1);
    await printPages(appWith(doc), { booklet: true, nUp: 2 });
    expect(PdfDocument.load(printed[1].bytes).pageCount).toBe(2);
  });
});
