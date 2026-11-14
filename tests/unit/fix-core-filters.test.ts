import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, bytesOf, cloneObj } from '../../src/pdf/objects';
import { applyPredictor, decodeStream, deflateZlib, filterChain, inflateZlib, lzwDecode, runLengthDecode } from '../../src/pdf/filters';
import { lzwNoise, lzwNoisePlain, lzwText, lzwTextPlain } from './fix-core-fixtures';
import { binStream, eq, onePage, rawPdf, runsOf, text } from './fix-core-helpers';

const plain = (o: unknown) => (o ?? null) as never;

describe('LZW (finding 1)', () => {
  it('decodes a stream of several thousand bytes written by an independent encoder', () => {
    const out = lzwDecode(lzwText());
    expect(out.length).toBe(lzwTextPlain().length);
    expect(text(out)).toBe(text(lzwTextPlain()));
  });
  it('follows the code width up to 12 bits and through a clear code', () => {
    expect(eq(lzwDecode(lzwNoise()), lzwNoisePlain())).toBe(true);
  });
  it('reads a page whose content is LZW, and keeps it through an optimized save', () => {
    const page = '/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>';
    const pdf = rawPdf(onePage({ 4: binStream('/Filter /LZWDecode', lzwText()), 5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' }, page), '/Root 1 0 R');
    const doc = PdfDocument.load(pdf);
    expect(runsOf(doc).length).toBe(60);
    const again = PdfDocument.load(doc.save({ incremental: false, recompress: true, objectStreams: true }));
    expect(runsOf(again).map((r) => r.text)).toEqual(runsOf(doc).map((r) => r.text));
    expect(runsOf(again)[59].text).toBe('Line number 59 of the LZW compressed page');
  });
  it('reports a code that cannot be in the table as damage', () => {
    // clear (256), then 300 as the first code: nothing in a fresh table has that number.
    const r = decodeStream(Uint8Array.from([0x80, 0x4b, 0x00]), new Dict({ Filter: Name.get('LZWDecode') }), plain);
    expect(r.corrupt).toBe(true);
    expect(r.data.length).toBe(0);
  });
});

describe('predictors and recompression (finding 9)', () => {
  const params = (o: Record<string, number>) => new Dict(o);
  it('undoes the TIFF predictor for 16-bit samples', () => {
    const W = 5, H = 3;
    const px = Uint8Array.from({ length: W * H * 2 }, (_, i) => (i * 37 + 11) & 255);
    const enc = new Uint8Array(px.length);
    for (let r = 0; r < H; r++) { let prev = 0; for (let c = 0; c < W; c++) { const o = (r * W + c) * 2; const v = (px[o] << 8) | px[o + 1]; const d = (v - prev) & 0xffff; enc[o] = d >> 8; enc[o + 1] = d & 255; prev = v; } }
    expect(eq(applyPredictor(enc, params({ Predictor: 2, Colors: 1, BitsPerComponent: 16, Columns: W }), plain), px)).toBe(true);
  });
  it('undoes the TIFF predictor for 1-, 2- and 4-bit samples', () => {
    for (const bpc of [1, 2, 4]) {
      const colors = bpc === 4 ? 3 : 1, cols = 13, rows = 4, mask = (1 << bpc) - 1;
      const rowLen = Math.ceil((cols * colors * bpc) / 8);
      const px = new Uint8Array(rowLen * rows), enc = new Uint8Array(rowLen * rows);
      const put = (buf: Uint8Array, r: number, bit: number, v: number) => { buf[r * rowLen + (bit >> 3)] |= v << (8 - bpc - (bit & 7)); };
      for (let r = 0; r < rows; r++) {
        const left = new Array(colors).fill(0);
        for (let x = 0, bit = 0; x < cols; x++) for (let k = 0; k < colors; k++, bit += bpc) {
          const v = (x * 5 + r * 3 + k * 7 + ((x * x) >> 2)) & mask;
          put(px, r, bit, v); put(enc, r, bit, (v - left[k]) & mask); left[k] = v;
        }
      }
      expect(eq(applyPredictor(enc, params({ Predictor: 2, Colors: colors, BitsPerComponent: bpc, Columns: cols }), plain), px), `bpc ${bpc}`).toBe(true);
    }
  });
  it('does not throw on damaged predictor parameters', () => {
    for (const cols of [-1, 0, 2.5, 1e12]) expect(() => applyPredictor(new Uint8Array(100), params({ Predictor: 12, Columns: cols }), plain)).not.toThrow();
  });
  it('recompress never makes a stream larger and never drops a predictor it did not undo', () => {
    // A gradient image stored with the PNG "Sub" predictor: far smaller than the same pixels without it.
    const w = 200, h = 200;
    const rows = new Uint8Array((w * 3 + 1) * h), px = new Uint8Array(w * 3 * h);
    for (let y = 0; y < h; y++) {
      rows[y * (w * 3 + 1)] = 1;
      let prev = [0, 0, 0];
      for (let x = 0; x < w; x++) { const rgb = [(x + y) & 255, (x * 2 + y) & 255, (x + y * 3) & 255]; for (let k = 0; k < 3; k++) { rows[y * (w * 3 + 1) + 1 + x * 3 + k] = (rgb[k] - prev[k]) & 255; px[(y * w + x) * 3 + k] = rgb[k]; } prev = rgb; }
    }
    const z = deflateZlib(rows);
    const img = binStream(`/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns ${w} >>`, z);
    const doc = PdfDocument.load(rawPdf(onePage({ 4: img }, '/Resources << /XObject << /Im1 4 0 R >> >>'), '/Root 1 0 R'));
    const out = PdfDocument.load(doc.save({ incremental: false, recompress: true }));
    const im = out.get<PdfStream>(out.getDict(out.pages[0].resources, 'XObject'), 'Im1');
    expect(im.raw.length).toBeLessThanOrEqual(z.length);
    expect(eq(out.decoded(im), px)).toBe(true);
  });
  it('reads /F and /DP as filter keys only for inline images', () => {
    const d = new Dict({ F: Name.get('Fl') });
    expect(filterChain(d, plain)).toEqual([]); // in a stream dictionary /F is a file specification
    expect(filterChain(d, plain, true)).toEqual([['FlateDecode', null]]);
  });
  it('run-length data that ends in the middle of a run adds nothing', () => {
    expect(Array.from(runLengthDecode(Uint8Array.from([0, 65, 254])))).toEqual([65]);
  });
});

describe('deflate (performance list)', () => {
  const enc = new TextEncoder();
  const samples: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)], ['one byte', Uint8Array.from([7])], ['zeros', new Uint8Array(70000)],
    ['text', enc.encode('The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. '.repeat(120))],
    ['noise', Uint8Array.from({ length: 90000 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 13) & 255)],
    ['skewed', Uint8Array.from({ length: 60000 }, (_, i) => { const r = (Math.imul(i + 7, 2246822519) >>> 8) & 0xffff; let s = 0; while (s < 30 && r >> (15 - s) === 0) s++; return s; })],
  ];
  it('writes streams that node:zlib and the engine both inflate to the same bytes', () => {
    for (const [name, d] of samples) {
      const z = deflateZlib(d);
      expect(eq(new Uint8Array(inflateSync(z)), d), `zlib: ${name}`).toBe(true);
      const r = inflateZlib(z);
      expect(r.corrupt, name).toBe(false);
      expect(eq(r.data, d), `engine: ${name}`).toBe(true);
    }
  });
  it('uses dynamic Huffman codes for text and stores what cannot be compressed', () => {
    const z = deflateZlib(samples[3][1]);
    expect((z[2] >> 1) & 3).toBe(2); // BTYPE of the first block: dynamic
    const noise = samples[4][1];
    expect(deflateZlib(noise).length).toBeLessThan(noise.length + 64);
  });
});

describe('copies share stream bytes (performance list)', () => {
  it('cloneObj does not copy raw or decoded data', () => {
    const s = new PdfStream(new Dict({ Length: 3 }), bytesOf('abc'));
    s.decoded = bytesOf('abc');
    const c = cloneObj(s) as PdfStream;
    expect(c).not.toBe(s);
    expect(c.dict).not.toBe(s.dict);
    expect(c.raw).toBe(s.raw);
    expect(c.decoded).toBe(s.decoded);
  });
});
