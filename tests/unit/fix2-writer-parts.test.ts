// The incremental writer hands stream data to the output as pieces instead of copying it into a buffer
// first; every object must still come out byte for byte as serialize() writes it.
import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { makeTextPdf, addImagePage } from '../../src/pdf/build';
import { addNote } from '../../src/pdf/ops/annots';
import { serialize, serializeParts } from '../../src/pdf/writer';
import { latin1 } from '../../src/pdf/objects';

const join = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

describe('incremental writer pieces', () => {
  it('serializeParts joins to serialize() for streams and other objects', () => {
    const d = PdfDocument.load(makeTextPdf(['x']));
    const px = new Uint8Array(30 * 20 * 3).map((_, i) => (i * 7) & 255);
    addImagePage(d, { kind: 'rgb', data: px, width: 30, height: 20 } as any, {});
    for (const obj of d.changed.values()) if (obj !== null) expect(Array.from(join(serializeParts(obj)))).toEqual(Array.from(serialize(obj)));
  });
  it('every object in an incremental update is written exactly as serialize() writes it, and the file reloads', () => {
    const d = PdfDocument.load(makeTextPdf(['one', 'two']));
    const px = new Uint8Array(40 * 40 * 3).map((_, i) => (i * 13) & 255);
    addImagePage(d, { kind: 'rgb', data: px, width: 40, height: 40 } as any, {});
    addNote(d, d.pages[0], 10, 10, { contents: 'n' });
    const base = d.buf.length;
    const out = d.save({ incremental: true });
    const text = latin1(out.subarray(base));
    for (const [n, obj] of d.changed) {
      if (obj === null) continue;
      const head = `${n} ${d.genOf(n)} obj\n`;
      const at = text.indexOf(head);
      expect(at, `object ${n}`).toBeGreaterThanOrEqual(0);
      const body = serialize(obj);
      expect(latin1(out.subarray(base + at + head.length, base + at + head.length + body.length))).toBe(latin1(body));
    }
    const back = PdfDocument.load(out);
    expect(back.pageCount).toBe(3);
    expect(back.report.reconstructed).toBe(false);
  });
});
