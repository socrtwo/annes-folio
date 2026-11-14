import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfString, bytesOf, latin1 } from '../../src/pdf/objects';
import { addBlankPage, ensureFont, ensureXObject, imageXObject, makeTextPdf } from '../../src/pdf/build';
import { flateStream } from '../../src/pdf/filters';
import { pageAnnotations } from '../../src/pdf/structure';
import { addNote, exportXfdf } from '../../src/pdf/ops/annots';
import { pageText, pageTextRuns, tablesFromRuns, extractImage, rawToRgba, type PositionedText } from '../../src/pdf/ops/extract';
import { pageRuns, replaceRunText, eraseArea, moveImage } from '../../src/pdf/ops/textedit';
import { listFonts, listImages, sanitize, hiddenInformation, earlierVersions, accessibilityFix } from '../../src/pdf/ops/optimize';
import { rotatePages } from '../../src/pdf/ops/pages';
import { parseContent, analyzeContent } from '../../src/pdf/content';
import { repairPdf, textScan } from '../../src/pdf/repair';
import { sniffFormat, openAsPdf, jpegMeta, rasterDpi, orientationMatrix, addImagePageOriented, eachImageSpec } from '../../src/io';
import { decodeTiff, tiffToBmp } from '../../src/io/tiff';
import { scan } from '../../src/io/recover/fileid';
import { scanZipBytes } from '../../src/io/recover/salvage';
import { immortalInflate } from '../../src/io/recover/inflate';
import { deflateZlib } from '../../src/pdf/filters';

const enc = (s: string) => new TextEncoder().encode(s);
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const reload = (d: PdfDocument, incremental = false) => PdfDocument.load(d.save({ incremental }));
const content = (d: PdfDocument, i = 0) => latin1(d.pageContent(d.pages[i])).replace(/\s+/g, ' ');

// Fixtures made with Pillow 12: an 8×4 JPEG with EXIF orientation 6 and 300 dpi; the same picture with
// only a JFIF density of 150 dpi; a 4×4 PNG with a 200 dpi pHYs chunk; a two-page LZW TIFF (4×2 grey 200,
// 2×2 red) at 300 dpi.
const J6 = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QBWRXhpZgAATU0AKgAAAAgABAESAAMAAAABAAYAAAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAAAAAAAAAAEsAAAAAQAAASwAAAAB/9sAQwAQCwwODAoQDg0OEhEQExgoGhgWFhgxIyUdKDozPTw5Mzg3QEhcTkBEV0U3OFBtUVdfYmdoZz5NcXlwZHhcZWdj/9sAQwEREhIYFRgvGhovY0I4QmNjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2Nj/8AAEQgABAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/aAAwDAQACEQMRAD8Ax6KKK4T6g//Z';
const J150 = '/9j/4AAQSkZJRgABAQEAlgCWAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAEAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDHooorhPqD/9k=';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAB7CAAAewgFu0HU+AAAAFElEQVR4nGNkaPjPAANMDEgANwcAStMBh3meKSgAAAAASUVORK5CYII=';
const TIF = 'SUkqABAAAACAMiBQOBQEAAwAAAEDAAEAAAAEAAAAAQEDAAEAAAACAAAAAgEDAAEAAAAIAAAAAwEDAAEAAAAFAAAABgEDAAEAAAABAAAAEQEEAAEAAAAIAAAAFgEDAAEAAAACAAAAFwEEAAEAAAAHAAAAGgEFAAEAAACmAAAAGwEFAAEAAACuAAAAHAEDAAEAAAABAAAAKAEDAAEAAAACAAAA1AAAACwBAAABAAAALAEAAAEAAAAAAAAAAAAAAAAASUkqABQAAACAP8AACBQSBwWAgAANAAABAwABAAAAAgAAAAEBAwABAAAAAgAAAAIBAwADAAAAhgEAAAMBAwABAAAABQAAAAYBAwABAAAAAgAAABEBBAABAAAAyAAAABUBAwABAAAAAwAAABYBAwABAAAAAgAAABcBBAABAAAACwAAABoBBQABAAAAdgEAABsBBQABAAAAfgEAABwBAwABAAAAAQAAACgBAwABAAAAAgAAAAAAAAAsAQAAAQAAACwBAAABAAAACAAIAAgAAAAAAA==';

/** A little-endian TIFF with one directory of [tag, type, count, value] entries followed by `extra`. */
function tiff(entries: [number, number, number, number][], extra = new Uint8Array(0)): Uint8Array {
  const n = entries.length; const b = new Uint8Array(8 + 2 + n * 12 + 4 + extra.length); const dv = new DataView(b.buffer);
  b[0] = 0x49; b[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, n, true);
  entries.forEach(([tag, type, count, val], i) => { const e = 10 + i * 12; dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true); if (type === 3 && count === 1) dv.setUint16(e + 8, val, true); else dv.setUint32(e + 8, val, true); });
  b.set(extra, 10 + n * 12 + 4); return b;
}
const dataOff = (n: number) => 10 + n * 12 + 4;

describe('format detection', () => {
  it('a ZIP of PDFs and a review package are packages, as the app writes them (stored entries)', async () => {
    const z = new JSZip();
    z.file('a.pdf', makeTextPdf(['first document']));
    z.file('b.pdf', makeTextPdf(['second document', 'second doc page 2']));
    const zip = await z.generateAsync({ type: 'uint8array' });
    expect(sniffFormat(zip, 'docs.zip')).toBe('zip');
    const r = await openAsPdf(zip, 'docs.zip');
    expect(r.format).toBe('zip');
    expect(r.doc.pages.map((_, i) => pageText(r.doc, i))).toEqual(['first document', 'second document', 'second doc page 2']);
    expect(PdfDocument.load(r.bytes).pageCount).toBe(3); // the bytes handed to the viewer match the document
    expect(r.warnings).toContain('2 PDFs from the archive were combined.');
  });

  it('a review package opens with its comments once', async () => {
    const d = PdfDocument.load(makeTextPdf(['review me']));
    addNote(d, d.pages[0], 100, 700, { contents: 'in both' });
    const pdf = d.save({ incremental: true });
    const withExtra = PdfDocument.load(pdf);
    addNote(withExtra, withExtra.pages[0], 200, 600, { contents: 'only in xfdf' });
    const q = new JSZip();
    q.file('mimetype', 'application/x-quillfolio-review'); q.file('doc.pdf', pdf); q.file('doc.xfdf', exportXfdf(withExtra));
    const qfr = await q.generateAsync({ type: 'uint8array' });
    expect(sniffFormat(qfr, 'x.qfr')).toBe('qfr');
    const r = await openAsPdf(qfr, 'x.qfr');
    expect(pageAnnotations(r.doc, r.doc.pages[0]).filter((a) => a.subtype === 'Text').map((a) => a.contents).sort()).toEqual(['in both', 'only in xfdf']);
  });

  it('text is not mistaken for a picture, a PDF or form data', () => {
    expect(sniffFormat(enc('BMW quarterly report\nSales were up.'), 'notes.txt')).toBe('txt');
    expect(sniffFormat(enc('How PDF works: every file starts with %PDF-1.7 and ...'), 'howto.txt')).toBe('txt');
    expect(sniffFormat(enc('# Notes\nThe root element is <xfdf xmlns=...>'), 'notes.md')).toBe('md');
    expect(sniffFormat(enc('<?xml version="1.0"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/></xfdf>'), 'c.xml')).toBe('xfdf');
  });

  it('PDFs are still found behind junk and under a wrong name', () => {
    const pdf = makeTextPdf(['x']);
    expect(sniffFormat(pdf, 'renamed.txt')).toBe('pdf');
    const http = new Uint8Array([...enc('HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\n\r\n'), ...pdf]);
    expect(sniffFormat(http, 'download.bin')).toBe('pdf');
    const junk = new Uint8Array(3000 + pdf.length); junk.fill(0x07, 0, 3000); junk.set(pdf, 3000);
    expect(sniffFormat(junk, 'x.dat')).toBe('pdf');
  });
});

describe('pictures', () => {
  it('reads EXIF orientation and the declared resolution', () => {
    expect(jpegMeta(unb64(J6))).toEqual({ orientation: 6, dpi: 300 });
    expect(jpegMeta(unb64(J150))).toEqual({ orientation: 1, dpi: 150 });
    expect(Math.round(rasterDpi(unb64(PNG))!)).toBe(200);
  });

  it('a JPEG becomes a page of its real size, turned as its orientation asks', async () => {
    const r = await openAsPdf(unb64(J6), 'photo.jpg');
    // 8 × 4 pixels at 300 dpi, shown turned: 4 × 8 pixels = 0.96 × 1.92 pt, brought up to the 3 pt minimum.
    expect(r.doc.pages[0].mediaBox.map((v) => +v.toFixed(2))).toEqual([0, 0, 3, 6]);
    expect(content(r.doc)).toContain('q 0 -6 3 0 0 6 cm /Im1 Do Q');
    // 8 × 4 pixels at 150 dpi = 3.84 × 1.92 pt, the short side brought up to 3 pt.
    const plain = await openAsPdf(unb64(J150), 'scan.jpg');
    expect(plain.doc.pages[0].mediaBox.map((v) => +v.toFixed(2))).toEqual([0, 0, 6, 3]);
    const d = PdfDocument.create();
    expect(addImagePageOriented(d, { kind: 'gray', data: new Uint8Array(600 * 300), width: 600, height: 300, dpi: 300 }).mediaBox).toEqual([0, 0, 144, 72]);
  });

  it('every orientation maps the corners where an upright picture has them', () => {
    // Stored top-left corner (0, 1) of the unit square → where it must be shown, for a 4 × 2 box (turned ones 2 × 4).
    const at = (o: number, w: number, h: number) => { const m = orientationMatrix(o, w, h); return [m[2] + m[4], m[3] + m[5]]; };
    expect([1, 2, 3, 4].map((o) => at(o, 4, 2))).toEqual([[0, 2], [4, 2], [4, 0], [0, 0]]);
    expect([5, 6, 7, 8].map((o) => at(o, 2, 4))).toEqual([[0, 4], [2, 4], [2, 0], [0, 0]]);
    const d = PdfDocument.create();
    const p = addImagePageOriented(d, { kind: 'gray', data: new Uint8Array(40 * 20), width: 40, height: 20, orientation: 8, dpi: 72 }, { paper: 'image' });
    expect(p.mediaBox).toEqual([0, 0, 20, 40]);
  });
});

describe('TIFF', () => {
  it('reads every page of a multi-page file, with its resolution', () => {
    const t = decodeTiff(unb64(TIF))!;
    expect(t.total).toBe(2);
    expect(t.pages.map((p) => [p.width, p.height, p.dpi])).toEqual([[4, 2, 300], [2, 2, 300]]);
    const first = t.pages[0].bmp()!, second = t.pages[1].bmp()!;
    expect([...first.subarray(54, 57)]).toEqual([200, 200, 200]);
    expect([...second.subarray(54, 57)]).toEqual([0, 0, 255]); // BGR: red
  });

  it('reports tiles, CMYK and unknown layouts as unsupported instead of decoding them wrongly', () => {
    const tiled = tiff([[256, 3, 1, 4], [257, 3, 1, 4], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [277, 3, 1, 1], [322, 3, 1, 4], [323, 3, 1, 4], [324, 4, 1, dataOff(10)], [325, 4, 1, 16]], new Uint8Array(16).fill(200));
    expect(tiffToBmp(tiled)).toBeNull();
    const cmyk = tiff([[256, 3, 1, 2], [257, 3, 1, 2], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 5], [277, 3, 1, 4], [273, 4, 1, dataOff(9)], [278, 3, 1, 2], [279, 4, 1, 16]], new Uint8Array(16).fill(128));
    expect(tiffToBmp(cmyk)).toBeNull();
    const grey = tiff([[256, 3, 1, 2], [257, 3, 1, 2], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1], [277, 3, 1, 1], [273, 4, 1, dataOff(9)], [278, 3, 1, 2], [279, 4, 1, 4]], Uint8Array.from([10, 20, 30, 40]));
    expect([...tiffToBmp(grey)!.subarray(54, 60)]).toEqual([30, 30, 30, 40, 40, 40]); // bottom row first
  });

  it('a tiny file that declares millions of values is read in no time', () => {
    const ents: [number, number, number, number][] = [];
    for (let i = 0; i < 400; i++) ents.push([1000 + i, 1, 1 << 20, 0], [273, 1, 1 << 20, 0]);
    const t = Date.now();
    expect(tiffToBmp(tiff(ents))).toBeNull();
    expect(Date.now() - t).toBeLessThan(500);
    // A directory chain that loops ends.
    const loop = tiff([[256, 3, 1, 1]]); new DataView(loop.buffer).setUint32(10 + 12, 8, true);
    expect(decodeTiff(loop)!.total).toBe(1);
  });

  it('eachImageSpec explains a TIFF it cannot read', async () => {
    const tiled = tiff([[256, 3, 1, 4], [257, 3, 1, 4], [322, 3, 1, 4], [324, 4, 1, 0]]);
    await expect(eachImageSpec(tiled, 'tiff', () => {})).rejects.toThrow(/tiles/);
  });
});

describe('repair and salvage', () => {
  it('a healthy file comes back as it is, in one piece', () => {
    const d = PdfDocument.create(); const p = addBlankPage(d);
    const jpg = new Uint8Array(400); jpg.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
    for (let i = 0; i < 3; i++) ensureXObject(d, p, 'Im', imageXObject(d, { kind: 'jpeg', data: jpg.slice(), width: 8, height: 8 }));
    const pdf = d.save({ incremental: false });
    expect(scan(pdf).segments.map((s) => s.ext)).toEqual(['pdf']);
    const rep = repairPdf(makeTextPdf(['healthy one', 'two']), 'ok.pdf');
    expect(rep.doc!.report.reconstructed).toBe(false);
    expect(rep.summary).toBe('The file opened without repair.');
    // Two PDFs glued together are still two pieces.
    const a = makeTextPdf(['a']), b = makeTextPdf(['b']);
    expect(scan(new Uint8Array([...a, ...b])).segments.map((s) => s.ext)).toEqual(['pdf', 'pdf']);
  });

  it('the text scan reads each stream once', () => {
    const raw = bytesOf('%PDF-1.4\n1 0 obj<</Length 30>>stream\nBT (Hello world one) Tj ET\nendstream\nendobj\n2 0 obj<</Length 30>>stream\nBT (Second stream) Tj ET\nendstream\nendobj\n');
    expect(textScan(raw).match(/Second stream/g)!.length).toBe(1);
  });

  it('ZIP salvage decodes only what is asked for, within a total limit, and skips encrypted entries', async () => {
    const z = new JSZip();
    z.file('big.bin', new Uint8Array(3_000_000));
    z.file('doc.pdf', makeTextPdf(['in zip']));
    z.file('nameless', makeTextPdf(['by content']));
    const zip = await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const wanted = scanZipBytes(zip, { want: (name, head) => /\.pdf$/i.test(name) || latin1(head, 0, 5) === '%PDF-' });
    expect([...wanted.keys()].sort()).toEqual(['doc.pdf', 'nameless']);
    const capped = scanZipBytes(zip, { maxTotal: 1000 });
    expect([...capped.values()].reduce((n, e) => n + e.data.length, 0)).toBeLessThanOrEqual(1000);
    const flagged = zip.slice(); flagged[6] |= 1; // first entry marked encrypted
    expect(scanZipBytes(flagged).has('big.bin')).toBe(false);
    expect(immortalInflate(deflateZlib(new Uint8Array(100000)).subarray(2), { maxOutput: 1024 }).data.length).toBeLessThanOrEqual(1024);
  });
});

describe('sanitize', () => {
  function scripted(): PdfDocument {
    const base = PdfDocument.create(); addBlankPage(base);
    const js = base.register(new Dict({ S: Name.get('JavaScript'), JS: PdfString.fromText('app.alert(1)') }));
    const names = base.register(new Dict({ JavaScript: new Dict({ Names: [PdfString.fromText('x'), js] }), EmbeddedSearch: new Dict() }));
    base.catalog.set('Names', names);
    base.catalog.set('OpenAction', new Dict({ S: Name.get('GoTo'), D: [base.pages[0].ref!, Name.get('Fit')], Next: js }));
    const launch = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Link'), Rect: [0, 0, 10, 10], A: new Dict({ S: Name.get('Launch'), F: PdfString.fromText('cmd.exe') }) });
    const web = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Link'), Rect: [0, 20, 10, 30], A: new Dict({ S: Name.get('URI'), URI: PdfString.fromText('https://example.com') }) });
    base.pages[0].dict.set('Annots', [base.register(launch), base.register(web)]);
    const item = base.register(new Dict({ Title: PdfString.fromText('Bookmark'), A: new Dict({ S: Name.get('JavaScript'), JS: PdfString.fromText('app.beep()') }) }));
    base.catalog.set('Outlines', base.register(new Dict({ Type: Name.get('Outlines'), First: item, Last: item, Count: 1 })));
    const group = base.register(new Dict({ T: PdfString.fromText('g'), Kids: [], AA: new Dict({ C: js }) }));
    base.catalog.set('AcroForm', new Dict({ Fields: [group] }));
    base.catalog.set('ViewerPreferences', base.register(new Dict({ FitWindow: true })));
    return reload(base);
  }
  it('removes scripts and active actions wherever they hang, and an incremental save keeps it that way', () => {
    const d = scripted();
    expect(hiddenInformation(d).items.find((i) => i.kind === 'JavaScript / actions')!.count).toBe(5);
    expect(sanitize(d, { javascript: true })).toEqual(['JavaScript and actions']);
    for (const out of [reload(d, true), reload(d, false)]) {
      expect(out.getDict(out.getDict(out.catalog, 'Names'), 'JavaScript')).toBeNull();
      const oa = out.getDict(out.catalog, 'OpenAction')!;
      expect([out.getName(oa, 'S'), oa.has('Next')]).toEqual(['GoTo', false]);
      const links = pageAnnotations(out, out.pages[0]);
      expect(links.map((a) => out.getName(out.getDict(a.dict, 'A'), 'S'))).toEqual(['', 'URI']);
      expect(out.getDict(out.getDict(out.catalog, 'Outlines'), 'First')!.has('A')).toBe(false);
      expect(out.resolve<Dict>(out.getArray(out.getDict(out.catalog, 'AcroForm'), 'Fields')![0]).has('AA')).toBe(false);
      expect(hiddenInformation(out).items.some((i) => i.kind === 'JavaScript / actions')).toBe(false);
    }
    expect(latin1(reload(d, false).buf)).not.toContain('app.alert');
    expect(sanitize(reload(d), { javascript: true })).toEqual([]); // nothing left: nothing claimed
  });

  it('other removals from /Names and viewer preferences survive an incremental save', () => {
    const d = scripted();
    expect(sanitize(d, { embeddedSearchIndex: true })).toEqual(['embedded search index']);
    accessibilityFix(d, {});
    const out = reload(d, true);
    expect(out.getDict(out.catalog, 'Names')!.has('EmbeddedSearch')).toBe(false);
    expect(out.get(out.getDict(out.catalog, 'ViewerPreferences'), 'DisplayDocTitle')).toBe(true);
  });

  it('counts earlier versions without counting a linearized file as one', () => {
    const one = makeTextPdf(['v1']);
    expect(earlierVersions(one)).toBe(0);
    const d = PdfDocument.load(one); addBlankPage(d);
    expect(earlierVersions(d.save({ incremental: true }))).toBe(1);
    const lin = new Uint8Array([...bytesOf('%PDF-1.4\n1 0 obj<</Linearized 1/L 100>>endobj\nstartxref\n0\n%%EOF\n'), ...one.subarray(9)]);
    expect(earlierVersions(lin)).toBe(0);
    expect(earlierVersions(new Uint8Array([...one, ...bytesOf('stream\n%%EOF in data\nendstream')]))).toBe(0);
  });
});

describe('lists and extraction', () => {
  it('listFonts stays fast when forms share one resources dictionary', () => {
    const d = PdfDocument.create(); const p = addBlankPage(d);
    const resRef = d.register(new Dict()); const res = d.resolve<Dict>(resRef); const xo = new Dict();
    for (let i = 0; i < 14; i++) xo.set('F' + i, d.register(flateStream(bytesOf(''), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, 1, 1], Resources: resRef })));
    res.set('XObject', xo); res.set('Font', new Dict({ F1: d.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('Type1'), BaseFont: Name.get('Helvetica') })) }));
    p.dict.set('Resources', resRef);
    const r = reload(d);
    const t = Date.now();
    expect(listFonts(r).map((f) => f.name)).toEqual(['Helvetica']);
    expect(Date.now() - t).toBeLessThan(1000); // 14 forms used to mean 14^7 walks
  });

  it('single-ink and stencil images convert the right way round; several inks are refused', () => {
    const d = PdfDocument.create(); const p = addBlankPage(d);
    const img = (cs: unknown, extra: Record<string, unknown> = {}, data = [0, 255]) => d.register(flateStream(Uint8Array.from(data), { Type: Name.get('XObject'), Subtype: Name.get('Image'), Width: 2, Height: 1, BitsPerComponent: 8, ...(cs ? { ColorSpace: cs } : {}), ...extra } as any));
    const sep = img([Name.get('Separation'), Name.get('Black'), Name.get('DeviceGray'), new Dict()]);
    const mask = img(null, { ImageMask: true, BitsPerComponent: 1 }, [0b01000000]);
    const deviceN = img([Name.get('DeviceN'), [Name.get('Cyan'), Name.get('Spot')], Name.get('DeviceCMYK'), new Dict()], {}, [0, 0, 255, 255]);
    const lab = img([Name.get('Lab'), new Dict({ WhitePoint: [0.9642, 1, 0.8249] })], { Width: 1 }, [255, 128, 128]);
    d.pageResources(p).set('XObject', new Dict({ Sep: sep, Mask: mask, DN: deviceN, Lab: lab }));
    const images = listImages(d);
    const rgba = (name: string) => rawToRgba(d, extractImage(d, images.find((i) => i.name === name)!));
    expect([...rgba('Sep')!.subarray(0, 8)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255]); // no ink is paper, full ink is dark
    expect([...rgba('Mask')!.subarray(0, 8)]).toEqual([0, 0, 0, 255, 0, 0, 0, 0]); // painted, then transparent
    expect(rgba('DN')).toBeNull();
    const white = rgba('Lab')!;
    expect([white[0], white[1], white[2]].every((v) => v >= 250)).toBe(true);
    expect(images.find((i) => i.name === 'Mask')!.hasMask).toBe(true);
    expect(rawToRgba(d, { ...extractImage(d, images[0]), width: 1e6, height: 1e6 })).toBeNull();
  });

  it('paragraphs are not tables; aligned columns are', () => {
    const run = (text: string, x: number, y: number): PositionedText => ({ text, x, y, w: text.length * 5, h: 10, size: 10 });
    const paragraph = [run('The quick', 72, 100), run('brown fox', 120, 100), run('jumps over', 72, 114), run('the lazy dog', 125, 114)];
    expect(tablesFromRuns(paragraph)).toEqual([]);
    const table = [run('Item', 72, 100), run('Qty', 300, 100), run('Apples', 72, 114), run('12', 300, 114), run('Pears', 72, 128), run('7', 300, 128)];
    expect(tablesFromRuns(table)).toEqual([[['Item', 'Qty'], ['Apples', '12'], ['Pears', '7']]]);
  });

  it('text positions follow /Rotate', () => {
    const d = PdfDocument.load(makeTextPdf(['first line\nsecond line']));
    const upright = pageTextRuns(d, 0).map((r) => [Math.round(r.x), Math.round(r.y)]);
    rotatePages(d, [0], 90);
    const turned = pageTextRuns(d, 0);
    // In the turned page the lines run down the page: they share y, not x, and each is taller than wide.
    expect(Math.round(turned[0].y)).toBe(upright[0][0]);
    expect(turned.every((r) => r.h > r.w)).toBe(true);
  });
});

describe('text editing', () => {
  const page = (ops: string, extra?: (d: PdfDocument, p: ReturnType<typeof addBlankPage>) => void) => { const d = PdfDocument.create(); const p = addBlankPage(d); const f = ensureFont(d, p, 'Helvetica'); extra?.(d, p); d.setPageContent(p, bytesOf(ops.replace(/F1/g, f))); return reload(d); };

  it('erasing over text inside a form leaves the form drawing; operator indexes stay valid', () => {
    const d = PdfDocument.create(); const p = addBlankPage(d);
    const fnt = ensureFont(d, p, 'Helvetica');
    const form = d.register(flateStream(bytesOf(`BT /${fnt} 12 Tf 100 500 Td (small word) Tj ET BT /${fnt} 12 Tf 100 300 Td (rest of the page) Tj ET`), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, 612, 792], Resources: d.pageResources(p) }));
    const fname = ensureXObject(d, p, 'Fm', form);
    d.setPageContent(p, bytesOf(`/${fname} Do BT /${fnt} 12 Tf 100 600 Td (own text) Tj (tail) Tj ET`));
    const r = reload(d);
    const tailIndex = pageRuns(r, r.pages[0]).find((x) => x.text === 'tail')!.opIndex;
    const tailX = pageRuns(r, r.pages[0]).find((x) => x.text === 'tail')!.box[0];
    expect(pageRuns(r, r.pages[0]).find((x) => x.text === 'small word')!.inForm).toBe(true);
    eraseArea(r, r.pages[0], [95, 490, 250, 520]);
    eraseArea(r, r.pages[0], [95, 595, 152, 615]);
    expect(content(r)).toContain(`/${fname} Do`);
    expect(content(r)).not.toContain('() Do');
    const runs = pageRuns(r, r.pages[0]);
    expect(runs.map((x) => x.text)).toContain('rest of the page');
    expect(runs.map((x) => x.text)).not.toContain('own text');
    const tail = runs.find((x) => x.text === 'tail')!;
    expect(tail.opIndex).toBe(tailIndex);
    expect(tail.box[0]).toBeCloseTo(tailX, 1);
  });

  it('an overlaid replacement has the size the text is shown at, WinAnsi bytes, and page coordinates', () => {
    const d = page('0.5 0 0 0.5 0 0 cm BT /F9 1 Tf 24 0 0 24 200 1400 Tm <00410042> Tj ET', (doc, p) => {
      const cid = doc.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('Type0'), BaseFont: Name.get('X'), Encoding: Name.get('Identity-H') }));
      (doc.getDict(doc.pageResources(p), 'Font') as Dict).set('F9', cid);
    });
    const run = pageRuns(d, d.pages[0])[0];
    expect(replaceRunText(d, d.pages[0], run, 'it’s €5 — ok').mode).toBe('overlaid');
    const c = content(d);
    expect(c).toContain('(it\\222s \\2005 \\227 ok) Tj');
    expect(c).toMatch(/q 2 0 0 2 0 0 cm /); // the leftover scaling is undone for the overlay
    expect(c).toMatch(/\/QFHelvetica 12 Tf/); // 24 × 0.5, not the Tf operand 1
  });

  it('a subset font is only re-encoded with glyphs it has', () => {
    const d = page('BT /F8 12 Tf 100 700 Td (abc) Tj ET', (doc, p) => {
      const widths = new Array(95).fill(0); for (const ch of 'abc') widths[ch.charCodeAt(0) - 32] = 500;
      const sub = doc.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('TrueType'), BaseFont: Name.get('ABCDEF+Subset'), Encoding: Name.get('WinAnsiEncoding'), FirstChar: 32, LastChar: 126, Widths: widths, FontDescriptor: new Dict({ Type: Name.get('FontDescriptor'), FontFile2: doc.register(flateStream(new Uint8Array(4))) }) }));
      (doc.getDict(doc.pageResources(p), 'Font') as Dict).set('F8', sub);
    });
    const run = pageRuns(d, d.pages[0])[0];
    expect(replaceRunText(d, d.pages[0], run, 'cab').mode).toBe('reencoded');
    expect(replaceRunText(d, d.pages[0], pageRuns(d, d.pages[0])[0], 'xyz').mode).toBe('overlaid');
  });

  it('moveImage puts the image where it is asked, whatever transformations surround it', () => {
    const boxOf = (d: PdfDocument) => { const info = analyzeContent(d, parseContent(d.pageContent(d.pages[0])), d.pages[0].resources); return info.images[0].box.map((v) => +v.toFixed(2)); };
    const withImage = (ops: string) => page(ops, (doc, p) => { ensureXObject(doc, p, 'Im', imageXObject(doc, { kind: 'gray', data: new Uint8Array(4), width: 2, height: 2 })); });
    const nested = withImage('q 1 0 0 1 100 200 cm 50 0 0 50 0 0 cm /Im1 Do Q');
    const idx = parseContent(nested.pageContent(nested.pages[0])).findIndex((o) => o.op === 'Do');
    expect(moveImage(nested, nested.pages[0], idx, { x: 10, y: 20, w: 30, h: 40 })).toBe(true);
    expect(boxOf(nested)).toEqual([10, 20, 40, 60]);
    expect(parseContent(nested.pageContent(nested.pages[0])).findIndex((o) => o.op === 'Do')).toBe(idx);
    const shared = withImage('2 0 0 2 0 0 cm 50 0 0 50 0 0 cm /Im1 Do 0 0 1 1 re f');
    const i2 = parseContent(shared.pageContent(shared.pages[0])).findIndex((o) => o.op === 'Do');
    moveImage(shared, shared.pages[0], i2, { x: 10, y: 20, w: 30, h: 40 });
    expect(boxOf(shared)).toEqual([10, 20, 40, 60]);
    expect(content(shared)).toContain('2 0 0 2 0 0 cm 50 0 0 50 0 0 cm q'); // the matrix other content uses is untouched
  });
});
