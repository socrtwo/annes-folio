// After a rebuild, /Annots and /Fields can name objects the damage destroyed or fragments that are no
// annotation or field. They are dropped (other readers warn about them, and pypdf refused such a file).
import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { makeTextPdf } from '../../src/pdf/build';
import { Dict, PdfString, Ref } from '../../src/pdf/objects';
import { addNote } from '../../src/pdf/ops/annots';
import { addField } from '../../src/pdf/ops/forms';
import { readFields } from '../../src/pdf/structure';

function damaged(): Uint8Array {
  const d = PdfDocument.load(makeTextPdf(['one']));
  addNote(d, d.pages[0], 50, 50, { contents: 'kept' });
  addField(d, { name: 'kept', type: 'text', page: 0, rect: [72, 700, 300, 720] } as any);
  const fragment = d.register(new Dict({ ModDate: 1 })); // neither a field nor an annotation
  const p = d.pages[0];
  const annots = d.getArray(p.dict, 'Annots')!;
  p.dict.set('Annots', [...annots, new Ref(9999, 0), fragment]);
  d.update(p.ref!, p.dict);
  const af = d.getDict(d.catalog, 'AcroForm')!;
  af.set('Fields', [...d.getArray(af, 'Fields')!, new Ref(9998, 0), fragment, new Dict({ Kids: [new Ref(9997, 0)], T: PdfString.fromText('group') })]);
  d.update(d.catalogRef, d.catalog);
  return d.save({ incremental: false });
}

describe('a rebuilt document drops references to lost annotations and fields', () => {
  it('keeps the live entries and says what it removed', () => {
    const doc = PdfDocument.load(damaged(), { repair: true });
    expect(doc.report.reconstructed).toBe(true);
    const annots = doc.getArray(doc.pages[0].dict, 'Annots')!;
    expect(annots.every((a) => doc.resolve<Dict>(a) instanceof Dict && doc.resolve<Dict>(a).has('Subtype'))).toBe(true);
    expect(readFields(doc).map((f) => f.name)).toContain('kept');
    const fields = doc.getArray(doc.getDict(doc.catalog, 'AcroForm'), 'Fields')!;
    expect(fields.every((f) => doc.resolve(f) instanceof Dict)).toBe(true);
    expect(doc.report.warnings.some((w) => /were removed/.test(w))).toBe(true);
    expect(doc.dirty).toBe(false);
    // The saved file has none of them either.
    const again = PdfDocument.load(doc.save({ incremental: false }));
    expect(again.report.reconstructed).toBe(false);
    expect(again.getArray(again.pages[0].dict, 'Annots')!.length).toBe(annots.length);
  });
  it('leaves a document that needed no rebuild alone', () => {
    const doc = PdfDocument.load(damaged());
    expect(doc.report.reconstructed).toBe(false);
    expect(doc.getArray(doc.pages[0].dict, 'Annots')!.length).toBeGreaterThan(2);
  });
});
