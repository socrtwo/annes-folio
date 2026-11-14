import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { addBlankPage, addImagePage } from '../../src/pdf/build';
import { parseContent, analyzeContent } from '../../src/pdf/content';
import { bytesOf, latin1 } from '../../src/pdf/objects';
import { estimateSkew, deskewMatrix, median3x3, inkBounds, canvasPlacement, wordFromCanvasBox, isolatedContent, writeTextLayer, invisibleRuns, stripOcrOps, stripOcrLayer, applyOcrCorrections, ocrLayerText, fitsWinAnsi, identityToUnicode, invisibleShows, OCR_FONT, type OcrWord, type ToPdf } from '../../src/commands/ocrlayer';

const word = (text: string, x: number, y: number, w: number, h = 14): OcrWord => ({ text, x0: x, y0: y, x1: x + w, y1: y + h, conf: 90 });
function imageDoc(): PdfDocument {
  const d = PdfDocument.create();
  addImagePage(d, { kind: 'rgb', data: new Uint8Array(20 * 20 * 3).fill(255), width: 20, height: 20 } as any, { paper: [612, 792], dpi: 72 });
  return PdfDocument.load(d.save({ incremental: false }));
}
const reload = (d: PdfDocument, incremental = false) => PdfDocument.load(d.save({ incremental }));
const texts = (d: PdfDocument, i = 0) => invisibleRuns(d, d.pages[i]).map((r) => r.text);

describe('deskew (finding 4)', () => {
  // A page whose text lines run downhill to the right by `tilt` degrees (canvas coordinates, y down).
  function tilted(tilt: number, W = 400, H = 550): Uint8ClampedArray {
    const g = new Uint8ClampedArray(W * H).fill(255);
    const t = Math.tan((tilt * Math.PI) / 180);
    for (let line = 60; line < H - 60; line += 24) for (let x = 40; x < W - 40; x++) for (let k = 0; k < 6; k++) { const y = Math.round(line + (x - W / 2) * t) + k; if (y >= 0 && y < H) g[y * W + x] = 0; }
    return g;
  }
  it('measures the tilt and its sign', () => {
    expect(estimateSkew(tilted(3), 400, 550)).toBe(3);
    expect(estimateSkew(tilted(-2), 400, 550)).toBe(-2);
    expect(estimateSkew(tilted(0), 400, 550)).toBe(0);
  });
  it('straightens the lines instead of doubling the tilt', () => {
    for (const tilt of [3, -2.5, 5]) {
      const deg = estimateSkew(tilted(tilt), 400, 550);
      // In user space (y up) a line that runs downhill to the right by `tilt` has direction (cos, −sin).
      const rad = (tilt * Math.PI) / 180, dir = [Math.cos(rad), -Math.sin(rad)];
      const m = deskewMatrix(deg, 306, 396);
      const after = [m[0] * dir[0] + m[2] * dir[1], m[1] * dir[0] + m[3] * dir[1]];
      expect(Math.abs((Math.atan2(after[1], after[0]) * 180) / Math.PI)).toBeLessThan(0.01);
    }
  });
  it('turns about the given center', () => {
    const m = deskewMatrix(4, 306, 396);
    expect(m[0] * 306 + m[2] * 396 + m[4]).toBeCloseTo(306, 6);
    expect(m[1] * 306 + m[3] * 396 + m[5]).toBeCloseTo(396, 6);
  });
});

describe('recognized text layer (finding 6)', () => {
  it('stores Cyrillic, Greek, CJK and Korean so that they read back, with one shared Unicode font', () => {
    const d = imageDoc();
    addBlankPage(d);
    const words = ['Hello', 'naïve', 'Привет', 'Ελληνικά', '日本語', '中文', '한국어'];
    writeTextLayer(d, d.pages[0], words.map((t, k) => word(t, 72, 700 - k * 20, 60)), 'eng');
    writeTextLayer(d, d.pages[1], [word('страница', 72, 700, 70)], 'rus');
    for (const doc of [d, reload(d), reload(d, true)]) {
      expect(texts(doc, 0)).toEqual(words);
      expect(texts(doc, 1)).toEqual(['страница']);
      // One font object for the whole document, not one per page.
      const fonts = doc.objectNumbers().filter((n) => { const o = doc.fetch({ num: n, gen: doc.genOf(n) } as any) as any; return o?.get && doc.getName(o, 'BaseFont') === OCR_FONT && doc.getName(o, 'Subtype') === 'Type0'; });
      expect(fonts.length).toBe(1);
    }
    expect(d.getText(d.pages[0].dict, 'QuillFolioOCR')).toBe('eng');
  });
  it('never writes "?" for a character Helvetica lacks', () => {
    expect(fitsWinAnsi('naïve €5')).toBe(true);
    expect(fitsWinAnsi('Привет')).toBe(false);
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [word('Łódź', 72, 700, 40)], 'pol');
    expect(texts(reload(d))).toEqual(['Łódź']);
  });
  it('maps codes back with a ToUnicode CMap of 256 ranges that each stay within one high byte', () => {
    const cmap = identityToUnicode();
    expect(cmap.match(/^<[0-9A-F]{2}00> <[0-9A-F]{2}FF> <[0-9A-F]{2}00>$/gm)!.length).toBe(256);
    expect(cmap).toContain('<0400> <04FF> <0400>');
    expect(cmap).not.toContain('<0000> <FFFF> <0000>');
  });
  it('stores right-to-left words mirrored, as readers expect, and gives them back in reading order', () => {
    expect(ocrLayerText('שלום')).toBe('םולש');
    for (const s of ['שלום', 'مرحبا', 'עברית2024', 'שלום,', 'Hello', 'Привет']) expect(ocrLayerText(ocrLayerText(s))).toBe(s);
    expect(ocrLayerText('Hello')).toBe('Hello');
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [word('שלום', 72, 700, 40)], 'heb');
    expect(texts(d).map(ocrLayerText)).toEqual(['שלום']);
  });
  it('makes each word exactly as wide as its box, in either font', () => {
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [word('Hello', 72, 700, 40), word('Привет', 72, 680, 60)], 'eng+rus');
    const runs = invisibleRuns(d, d.pages[0]);
    expect(runs[0].box[2] - runs[0].box[0]).toBeCloseTo(40, 0);
    expect(runs[1].box[2] - runs[1].box[0]).toBeCloseTo(60, 0);
    expect(runs[1].box[0]).toBeCloseTo(72, 1);
  });
  it('places words along the reading direction on a rotated page', () => {
    // pdf.js viewport of a 612×792 page with /Rotate 90 at scale 1: the canvas is 792 wide and 612 high.
    const toPdf: ToPdf = (x, y) => [y, x];
    const w = wordFromCanvasBox(toPdf, { x0: 100, y0: 50, x1: 180, y1: 62 }, 'Hello', 90);
    expect([w.dx, w.dy].map((v) => Math.round(v! * 1e6) / 1e6)).toEqual([0, 1]);
    expect(w.w).toBeCloseTo(80, 6);
    expect(w.h).toBeCloseTo(12, 6);
    expect([w.x0, w.y0, w.x1, w.y1]).toEqual([50, 100, 62, 180]);
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [w], 'eng');
    const box = invisibleRuns(d, d.pages[0])[0].box;
    // The run is as long as the word along y (its reading direction in user space) and as thin as its height along x.
    expect(box[3] - box[1]).toBeCloseTo(80, 0);
    expect(box[2] - box[0]).toBeLessThan(16);
    expect(box[1]).toBeCloseTo(100, 0);
    expect(box[0]).toBeGreaterThanOrEqual(49);
    expect(box[2]).toBeLessThanOrEqual(63);
  });
  it('is not scaled by a matrix the scanner left open in the page content', () => {
    const d = imageDoc();
    const p = d.pages[0];
    const im = d.getDict(p.resources!, 'XObject')!.keys()[0];
    d.setPageContent(p, bytesOf(`612 0 0 792 0 0 cm /${im} Do`));
    writeTextLayer(d, d.pages[0], [word('Hello', 72, 700, 40)], 'eng');
    const run = invisibleRuns(d, d.pages[0])[0];
    expect(run.box[0]).toBeCloseTo(72, 0);
    expect(run.box[2] - run.box[0]).toBeCloseTo(40, 0);
    expect(run.box[1]).toBeGreaterThan(690);
    expect(run.box[3]).toBeLessThan(720);
  });
  it('wraps content only when it leaks state', () => {
    const clean = bytesOf('q 612 0 0 792 0 0 cm /Im0 Do Q\n');
    expect(isolatedContent(clean)).toBe(clean);
    expect(latin1(isolatedContent(bytesOf('612 0 0 792 0 0 cm /Im0 Do')))).toMatch(/^q\n[\s\S]*\nQ\n$/);
    expect(latin1(isolatedContent(bytesOf('q q 1 0 0 1 5 5 cm /Im0 Do Q'))).match(/Q/g)!.length).toBe(3);
  });
});

describe('replacing and correcting a recognized layer', () => {
  it('tracks invisible text through q/Q and a Tr set before BT', () => {
    const ops = parseContent(bytesOf('3 Tr BT /F1 10 Tf (hidden) Tj ET q 0 Tr BT (seen) Tj ET Q BT (hidden again) Tj ET'));
    const shows = ops.map((o, k) => (o.op === 'Tj' ? k : -1)).filter((k) => k >= 0);
    expect([...invisibleShows(ops)]).toEqual([shows[0], shows[2]]);
  });
  it('removes only the invisible strings of a foreign layer and keeps visible text in the same text object', () => {
    const out = stripOcrOps(parseContent(bytesOf('BT /F1 10 Tf 3 Tr (hidden) Tj 0 Tr (visible) Tj ET')));
    const shown = out.filter((o) => o.op === 'Tj').map((o) => latin1((o.args[0] as any).bytes));
    expect(shown).toEqual(['', 'visible']);
  });
  it('removes its own block whole and leaves the page content', () => {
    const d = imageDoc();
    const before = latin1(d.pageContent(d.pages[0])).trim();
    writeTextLayer(d, d.pages[0], [word('Hello', 72, 700, 40), word('Привет', 72, 680, 60)], 'eng');
    stripOcrLayer(d, d.pages[0]);
    expect(invisibleRuns(d, d.pages[0])).toEqual([]);
    const after = latin1(d.pageContent(d.pages[0]));
    expect(after).not.toContain('BMC');
    expect(after.replace(/\s+/g, ' ')).toContain(before.replace(/\s+/g, ' '));
  });
  it('corrects words in one rewrite, keeps them invisible and in place, and switches font when needed', () => {
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [word('Helo', 72, 700, 40), word('Привт', 72, 680, 60), word('ok', 72, 660, 20)], 'eng+rus');
    const p = d.pages[0];
    const runs = invisibleRuns(d, p);
    const objectsBefore = d.objectNumbers().length;
    const n = applyOcrCorrections(d, p, [{ run: runs[0], text: 'Hello' }, { run: runs[1], text: 'Привет' }, { run: runs[2], text: 'да' }]);
    expect(n).toBe(3);
    // One new content stream for all three corrections (the page already has the Unicode font).
    expect(d.objectNumbers().length).toBe(objectsBefore + 1);
    const after = invisibleRuns(d, d.pages[0]);
    expect(after.map((r) => r.text)).toEqual(['Hello', 'Привет', 'да']);
    after.forEach((r, k) => { expect(r.box[0]).toBeCloseTo(runs[k].box[0], 0); expect(r.box[2] - r.box[0]).toBeCloseTo(runs[k].box[2] - runs[k].box[0], 0); });
    // Nothing visible was drawn: every text-showing operator of the page is still invisible, and no box was painted.
    const ops = parseContent(d.pageContent(d.pages[0]));
    const all = analyzeContent(d, ops, d.pages[0].resources).runs.filter((r) => r.text);
    expect(all.length).toBe(3);
    expect(all.every((r) => invisibleShows(ops).has(r.opIndex))).toBe(true);
    expect(ops.some((o) => o.op === 're' || o.op === 'f')).toBe(false);
    expect(applyOcrCorrections(d, d.pages[0], [{ run: after[0], text: 'Hello' }])).toBe(0);
  });
});

describe('scan image math', () => {
  it('takes a 3×3 median and copies the edges', () => {
    const w = 5, h = 5, g = new Uint8ClampedArray(w * h).fill(200);
    g[2 * w + 2] = 0; // one speck
    g[0] = 7;
    const out = median3x3(g, w, h);
    expect(out[2 * w + 2]).toBe(200);
    expect(out[0]).toBe(7);
    const edge = new Uint8ClampedArray([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect([...median3x3(edge, 3, 3)]).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });
  it('crops to the ink and is not stopped by a single speck', () => {
    const w = 100, h = 80, g = new Uint8ClampedArray(w * h).fill(255);
    for (let y = 20; y < 60; y++) for (let x = 30; x < 70; x++) g[y * w + x] = 0;
    g[2 * w + 3] = 0; // dust in the corner
    expect(inkBounds(g, w, h)).toEqual({ x0: 30, y0: 20, x1: 70, y1: 60 });
    expect(inkBounds(new Uint8ClampedArray(w * h).fill(255), w, h)).toBeNull();
  });
  it('puts a rendering of a rotated, cropped page back where the page shows it', () => {
    // Upright page with crop box [50 100 350 500] at scale 2: canvas 600×800.
    const upright: ToPdf = (x, y) => [50 + x / 2, 500 - y / 2];
    expect(canvasPlacement(upright, 600, 800)).toEqual([300, 0, 0, 400, 50, 100]);
    // /Rotate 90, page 612×792, scale 1: canvas 792×612, canvas (x, y) is user (y, x).
    const rot: ToPdf = (x, y) => [y, x];
    const m = canvasPlacement(rot, 792, 612);
    // The unit square's corners land on the page corners: the image fills the unrotated media box.
    const at = (u: number, v: number) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
    expect([at(0, 0), at(1, 0), at(0, 1), at(1, 1)]).toEqual([[612, 0], [612, 792], [0, 0], [0, 792]]);
  });
});
