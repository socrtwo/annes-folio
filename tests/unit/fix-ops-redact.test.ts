import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, PdfString, Ref, bytesOf, latin1 } from '../../src/pdf/objects';
import { addBlankPage, ensureFont, ensureXObject, imageXObject, makeTextPdf } from '../../src/pdf/build';
import { flateStream } from '../../src/pdf/filters';
import { pageAnnotations, readFields } from '../../src/pdf/structure';
import { addRedactMark, applyRedactions, setAnnotationProps } from '../../src/pdf/ops/annots';
import { addField } from '../../src/pdf/ops/forms';
import { pageRuns } from '../../src/pdf/ops/textedit';
import { pageText } from '../../src/pdf/ops/extract';
import { hiddenInformation, sanitize } from '../../src/pdf/ops/optimize';

type Rect = [number, number, number, number];
const reload = (d: PdfDocument) => PdfDocument.load(d.save({ incremental: false }));
/** Every decoded stream of the document, as it would be after the bytes are written and read back. */
const streams = (d: PdfDocument) => d.objectNumbers().map((n) => { const o = d.fetch(new Ref(n, d.genOf(n))); return o instanceof PdfStream ? latin1(d.decoded(o)) : ''; });
const content = (d: PdfDocument, i = 0) => latin1(d.pageContent(d.pages[i])).replace(/\s+/g, ' ');
/** A one-page document whose content is the given operators ("F1" is the page's Helvetica). */
function page(ops: string): PdfDocument {
  const d = PdfDocument.create();
  const p = addBlankPage(d);
  const f = ensureFont(d, p, 'Helvetica');
  d.setPageContent(p, bytesOf(ops.replace(/F1/g, f)));
  return reload(d);
}

describe('redaction removes content from the file, not just from the page', () => {
  it('a redacted image and text inside a Form XObject are gone after a full rewrite; the rest of the form stays', () => {
    const d = PdfDocument.create();
    const p = addBlankPage(d);
    const img = imageXObject(d, { kind: 'gray', data: new Uint8Array(100).fill(0x41), width: 10, height: 10 });
    const iname = ensureXObject(d, p, 'Im', img);
    const fnt = ensureFont(d, p, 'Helvetica');
    // The form shares the page's resources dictionary, as many producers do.
    const form = d.register(flateStream(bytesOf(`BT /${fnt} 12 Tf 100 500 Td (FORMSECRET inside form) Tj ET BT /${fnt} 12 Tf 100 300 Td (unrelated text far away) Tj ET`), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, 612, 792], Resources: d.pageResources(p) }));
    const fname = ensureXObject(d, p, 'Fm', form);
    d.setPageContent(p, bytesOf(`q 100 0 0 100 50 600 cm /${iname} Do Q /${fname} Do`));
    const r = reload(d);
    const res = applyRedactions(r, [0], new Map([[0, [[60, 610, 80, 630], [100, 495, 170, 512]] as Rect[]]]));
    expect([res.imagesRemoved, res.textRemoved, res.formsRewritten]).toEqual([1, 1, 1]);
    const out = reload(r);
    const all = streams(out).join('\n');
    expect(all).not.toContain('FORMSECRET');
    expect(all).not.toContain('A'.repeat(100));
    expect(pageText(out, 0)).toContain('unrelated text far away');
    expect(out.getDict(out.pages[0].resources, 'XObject')!.keys().some((k) => k === iname || k === fname)).toBe(false);
  });

  it('an XObject still drawn on another page survives; one that only lingers in shared resources does not', () => {
    const d = PdfDocument.create();
    const a = addBlankPage(d), b = addBlankPage(d), c = addBlankPage(d);
    const secret = imageXObject(d, { kind: 'gray', data: new Uint8Array(64).fill(0x53), width: 8, height: 8 });
    const logo = imageXObject(d, { kind: 'gray', data: new Uint8Array(64).fill(0x4c), width: 8, height: 8 });
    const shared = d.register(new Dict({ XObject: new Dict({ S: secret, L: logo }) }));
    for (const p of [a, b, c]) p.dict.set('Resources', shared);
    d.setPageContent(a, bytesOf('q 50 0 0 50 100 100 cm /S Do Q q 50 0 0 50 300 100 cm /L Do Q'));
    d.setPageContent(b, bytesOf('q 50 0 0 50 300 100 cm /L Do Q'));
    d.setPageContent(c, bytesOf('q 50 0 0 50 300 100 cm /L Do Q'));
    const r = reload(d);
    applyRedactions(r, [0], new Map([[0, [[90, 90, 160, 160], [290, 90, 360, 160]] as Rect[]]]));
    const out = reload(r);
    const all = streams(out).join('\n');
    expect(all).not.toContain('S'.repeat(64)); // listed by pages 2 and 3, drawn by none
    expect(all).toContain('L'.repeat(64)); // still drawn on pages 2 and 3
    expect(content(out, 1)).toContain('/L Do');
  });

  it('text after a removed string stays where it was (Tj, quote operators)', () => {
    let d = page('BT /F1 12 Tf 100 700 Td (SECRET ) Tj (public words) Tj ET');
    const before = pageRuns(d, d.pages[0]).find((r) => r.text === 'public words')!.box;
    applyRedactions(d, [0], new Map([[0, [[100, 695, 135, 712]] as Rect[]]]));
    const after = pageRuns(d, d.pages[0]).find((r) => r.text === 'public words')!.box;
    expect(after[0]).toBeCloseTo(before[0], 1);
    expect(pageText(d, 0)).not.toContain('SECRET');

    d = page("BT /F1 12 Tf 14 TL 100 700 Td (line one) Tj (SECRET line two) ' (line three) ' ET");
    const y3 = pageRuns(d, d.pages[0]).find((r) => r.text === 'line three')!.box[1];
    applyRedactions(d, [0], new Map([[0, [[100, 683, 200, 696]] as Rect[]]]));
    const runs = pageRuns(d, d.pages[0]);
    expect(runs.find((r) => r.text === 'line three')!.box[1]).toBeCloseTo(y3, 1);
    expect(runs.some((r) => /SECRET/.test(r.text))).toBe(false);
  });

  it('only the glyphs under the mark go when the font states its widths', () => {
    const d0 = PdfDocument.create();
    const p0 = addBlankPage(d0);
    const widths = new Array(95).fill(500);
    const font = d0.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('TrueType'), BaseFont: Name.get('Mono'), Encoding: Name.get('WinAnsiEncoding'), FirstChar: 32, LastChar: 126, Widths: widths }));
    d0.pageResources(p0).set('Font', new Dict({ F7: font }));
    d0.setPageContent(p0, bytesOf('BT /F7 10 Tf 100 700 Td (keep SECRET keep) Tj ET'));
    const d = reload(d0);
    // "SECRET" spans x = 125..155 (5 units per glyph).
    applyRedactions(d, [0], new Map([[0, [[126, 698, 154, 710]] as Rect[]]]));
    expect(pageRuns(d, d.pages[0]).map((r) => r.text).join('')).toBe('keep  keep');
  });

  it('black boxes are drawn in page coordinates even when the content leaves a transformation behind', () => {
    const d = page('0.5 0 0 0.5 0 0 cm BT /F1 24 Tf 200 1400 Td (SECRET scaled) Tj ET');
    const run = pageRuns(d, d.pages[0])[0];
    applyRedactions(d, [0], new Map([[0, [run.box] as Rect[]]]));
    const c = content(d);
    expect(c.startsWith('q ')).toBe(true);
    expect(c).toMatch(/ET Q q 0 0 0 rg 100 697/); // the old content is closed off before the box
  });

  it('a mark that was moved redacts where it is now', () => {
    const d = PdfDocument.load(makeTextPdf(['hello']));
    const p = d.pages[0];
    const ref = addRedactMark(d, p, [[100, 100, 200, 120]]);
    setAnnotationProps(d, p, ref, { rect: [300, 500, 400, 520] });
    applyRedactions(d, [0]);
    expect(content(d)).toContain('300 500 100 20 re');
    expect(content(d)).not.toContain('100 100 100 20 re');
  });

  it('draws the overlay text of a mark and removes /ActualText of redacted marked content', () => {
    const d = page('/Span <</ActualText (SECRET actual)>> BDC BT /F1 12 Tf 100 700 Td (SECRET) Tj ET EMC BT /F1 12 Tf 100 600 Td (visible) Tj ET');
    const run = pageRuns(d, d.pages[0]).find((r) => r.text === 'SECRET')!;
    addRedactMark(d, d.pages[0], [run.box as Rect], { overlayText: 'REDACTED' });
    applyRedactions(d, [0]);
    const c = content(d);
    expect(c).not.toContain('SECRET');
    expect(c).toContain('(REDACTED) Tj');
    expect(c).toContain('1 1 1 rg');
  });

  it('removes vector paths that lie inside the area and keeps the others', () => {
    const d = page('0 0 1 rg 110 110 20 20 re f 1 0 0 RG 50 50 m 500 500 l S');
    const res = applyRedactions(d, [0], new Map([[0, [[100, 100, 200, 200]] as Rect[]]]));
    expect(res.pathsRemoved).toBe(1);
    const c = content(d);
    expect(c).not.toContain('110 110 20 20 re');
    expect(c).toContain('50 50 m 500 500 l S');
  });

  it('a widget under the mark takes its field value out of the form', () => {
    const d = PdfDocument.create(); addBlankPage(d);
    const group = d.register(new Dict({ T: PdfString.fromText('person'), Kids: [] }));
    const w = addField(d, { name: 'ssn', type: 'text', page: 0, rect: [50, 700, 250, 720], value: '123-45-6789' });
    const af = d.getDict(d.catalog, 'AcroForm')!; af.set('Fields', [group]);
    d.resolve<Dict>(group).set('Kids', [w]); d.resolve<Dict>(w).set('Parent', group);
    const r = reload(d);
    applyRedactions(r, [0], new Map([[0, [[40, 690, 260, 730]] as Rect[]]]));
    const out = reload(r);
    expect(readFields(out)).toEqual([]);
    expect(latin1(out.buf)).not.toContain('123-45-6789');
    expect(pageAnnotations(out, out.pages[0])).toEqual([]);
  });
});

describe('hidden layers', () => {
  function layered(baseOff: boolean): PdfDocument {
    const d = PdfDocument.create();
    const p = addBlankPage(d);
    const f = ensureFont(d, p, 'Helvetica');
    const g = d.register(new Dict({ Type: Name.get('OCG'), Name: PdfString.fromText('Internal notes') }));
    const v = d.register(new Dict({ Type: Name.get('OCG'), Name: PdfString.fromText('Print') }));
    d.pageResources(p).set('Properties', new Dict({ MC0: g, MC1: v }));
    d.setPageContent(p, bytesOf(`/OC /MC0 BDC BT /${f} 12 Tf 100 700 Td (HIDDENNOTE) Tj ET 10 10 50 50 re f EMC /OC /MC1 BDC BT /${f} 12 Tf 100 600 Td (shown text) Tj ET EMC`));
    d.catalog.set('OCProperties', new Dict({ OCGs: [g, v], D: baseOff ? new Dict({ BaseState: Name.get('OFF'), ON: [v] }) : new Dict({ OFF: [g] }) }));
    return reload(d);
  }
  for (const baseOff of [false, true]) {
    it(`are reported and removed with their content (${baseOff ? '/BaseState /OFF' : '/OFF list'})`, () => {
      const d = layered(baseOff);
      expect(hiddenInformation(d).items.find((i) => i.kind === 'Hidden layers')?.detail).toBe('Internal notes');
      const done = sanitize(d, { hiddenLayers: true });
      expect(done).toEqual(['hidden layers (1 removed with their content)']);
      const out = reload(d);
      expect(streams(out).join('\n')).not.toContain('HIDDENNOTE');
      expect(latin1(out.buf)).not.toContain('Internal notes');
      expect(content(out)).not.toContain('10 10 50 50 re f');
      expect(pageText(out, 0)).toContain('shown text');
      expect(hiddenInformation(out).items.some((i) => i.kind === 'Hidden layers')).toBe(false);
    });
  }
});
