import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, PdfString, Ref, bytesOf, latin1 } from '../../src/pdf/objects';
import { addBlankPage, addTextPage, ensureFont, makeTextPdf } from '../../src/pdf/build';
import { readFields, readOutlines, writeOutlines, pageAnnotations } from '../../src/pdf/structure';
import { addField, setFieldValue, applyFormData, formData } from '../../src/pdf/ops/forms';
import { addLink, addTextMarkup } from '../../src/pdf/ops/annots';
import { movePages, deletePages, parseRanges, importPages, extractPages, splitDocument, addOverlayText, addBates, scalePages, nUp, booklet, rotatePages, setBackgroundColor } from '../../src/pdf/ops/pages';
import { hiddenLayers } from '../../src/pdf/ops/optimize';
import { TEMPLATES } from '../../src/templates';

const reload = (d: PdfDocument, incremental = false) => PdfDocument.load(d.save({ incremental }));
const streams = (d: PdfDocument) => d.objectNumbers().map((n) => { const o = d.fetch(new Ref(n, d.genOf(n))); return o instanceof PdfStream ? latin1(d.decoded(o)) : ''; }).join('\n');
const content = (d: PdfDocument, i = 0) => latin1(d.pageContent(d.pages[i])).replace(/\s+/g, ' ');

describe('page tree edits', () => {
  it('keep an inherited /CropBox when the tree is flattened', () => {
    const raw = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 2/MediaBox[0 0 612 792]/CropBox[100 100 300 300]/Rotate 90>>endobj
3 0 obj<</Type/Pages/Parent 2 0 R/Kids[4 0 R 5 0 R]/Count 2>>endobj
4 0 obj<</Type/Page/Parent 3 0 R>>endobj
5 0 obj<</Type/Page/Parent 3 0 R>>endobj
trailer<</Root 1 0 R/Size 6>>
%%EOF`;
    const d = PdfDocument.load(bytesOf(raw));
    movePages(d, [1], 0);
    const r = reload(d);
    expect(r.pages.map((p) => p.cropBox)).toEqual([[100, 100, 300, 300], [100, 100, 300, 300]]);
    expect(r.pages.map((p) => p.rotate)).toEqual([90, 90]);
  });

  it('deleting a page removes its form fields, their values, and destinations that pointed at it', () => {
    const d = PdfDocument.create(); addBlankPage(d); addBlankPage(d);
    addField(d, { name: 'ssn', type: 'text', page: 1, rect: [50, 700, 250, 720], value: '123-45-6789' });
    addField(d, { name: 'kept', type: 'text', page: 0, rect: [50, 700, 250, 720], value: 'stays' });
    addLink(d, d.pages[0], [10, 10, 50, 30], { page: 1 });
    writeOutlines(d, [{ title: 'First', page: 0 }, { title: 'Second', page: 1 }]);
    const r = reload(d);
    deletePages(r, [1]);
    const out = reload(r);
    expect(out.pageCount).toBe(1);
    expect(readFields(out).map((f) => [f.name, f.value])).toEqual([['kept', 'stays']]);
    expect(latin1(out.buf)).not.toContain('123-45-6789');
    expect(readOutlines(out).map((o) => [o.title, o.dest?.page ?? null])).toEqual([['First', 0], ['Second', null]]);
    expect(pageAnnotations(out, out.pages[0]).find((a) => a.subtype === 'Link')!.dict.has('Dest')).toBe(false);
  });

  it('parseRanges follows the agreed rules (C5)', () => {
    expect(parseRanges('2 - 3', 10)).toEqual([1, 2]);
    expect(parseRanges('2 – 3; 5—6', 10)).toEqual([1, 2, 4, 5]);
    expect(parseRanges('-', 10)).toEqual([]);
    expect(parseRanges('1, -, 3', 10)).toEqual([0, 2]);
    expect(parseRanges('5-3', 10)).toEqual([2, 3, 4]);
    expect(parseRanges('8-20, 0-2', 10)).toEqual([7, 8, 9, 0, 1]);
    expect(parseRanges('12, 0, 4', 10)).toEqual([3]);
    expect(parseRanges('7, 2, 7, 1-2', 10)).toEqual([6, 1, 0]);
    expect(parseRanges('1 3', 10)).toEqual([]); // spaces do not separate parts
    expect(parseRanges('8-, -2', 10)).toEqual([7, 8, 9, 0, 1]);
    expect(parseRanges('even', 4)).toEqual([1, 3]);
  });

  it('split "every n" tolerates n below 1', () => {
    const d = PdfDocument.load(makeTextPdf(['a', 'b', 'c']));
    expect(splitDocument(d, { kind: 'every', n: 0 }).map((g) => g.doc.pageCount)).toEqual([1, 1, 1]);
    expect(splitDocument(d, { kind: 'every', n: -2 }).map((g) => g.doc.pageCount)).toEqual([1, 1, 1]);
  });

  it('per-page operations on a long document do not rewalk the page tree for every page', () => {
    const d0 = PdfDocument.create();
    for (let i = 0; i < 1500; i++) addBlankPage(d0);
    const d = reload(d0);
    const all = d.pages.map((_, i) => i);
    let walks = 0;
    const proto = Object.getPrototypeOf(d), desc = Object.getOwnPropertyDescriptor(proto, 'pages')!;
    Object.defineProperty(d, 'pages', { get() { if (!(d as any).pageCache) walks++; return desc.get!.call(d); } });
    rotatePages(d, all, 90);
    setBackgroundColor(d, all, [1, 1, 1]);
    addBates(d, all, { start: 1, digits: 6, position: 'bottom-right' });
    expect(walks).toBeLessThan(10);
  });
});

describe('importing pages', () => {
  function threePages(): PdfDocument {
    const d = PdfDocument.create();
    addTextPage(d, 'cover page'); addTextPage(d, 'CONFIDENTIAL page two body'); addTextPage(d, 'page three body');
    const p0 = d.pages[0];
    const viaAction = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Link'), Rect: [0, 0, 10, 10], A: new Dict({ S: Name.get('GoTo'), D: [d.pages[1].ref!, Name.get('Fit')] }) });
    const viaDest = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Link'), Rect: [0, 20, 10, 30], Dest: [d.pages[2].ref!, Name.get('Fit')] });
    p0.dict.set('Annots', [d.register(viaAction), d.register(viaDest)]);
    addTextMarkup(d, p0, 'Highlight', [[72, 700, 200, 714]], { contents: 'marked' });
    return reload(d);
  }
  it('does not copy pages that a link, a /P entry or a destination points at', () => {
    const src = threePages();
    const out = reload(extractPages(src, [0]));
    expect(out.pageCount).toBe(1);
    expect(streams(out)).not.toContain('CONFIDENTIAL');
    expect(streams(out)).not.toContain('page three');
    // An incremental save writes everything that was created: nothing of the other pages may have been.
    const host = PdfDocument.load(makeTextPdf(['host']));
    importPages(src, host, [0]);
    const inc = PdfDocument.load(host.save({ incremental: true }));
    expect(streams(inc)).not.toContain('CONFIDENTIAL');
    expect(streams(inc)).not.toContain('page three');
    const annots = pageAnnotations(inc, inc.pages[1]);
    expect(annots.filter((a) => a.subtype === 'Link').every((a) => !a.dict.has('Dest') && !a.dict.has('A'))).toBe(true);
    expect(annots.find((a) => a.subtype === 'Highlight')!.dict.get('P')).toEqual(inc.pages[1].ref);
  });

  it('keeps links between pages that are imported together', () => {
    const src = threePages();
    const out = reload(extractPages(src, [0, 2]));
    const link = pageAnnotations(out, out.pages[0]).find((a) => a.dict.has('Dest'))!;
    expect((out.getArray(link.dict, 'Dest')![0] as Ref).num).toBe(out.pages[1].ref!.num);
  });

  it('imported form fields are the widgets on the page, once, with their group', () => {
    const src = reload(TEMPLATES.find((t) => t.id === 'form')!.build());
    const dst = PdfDocument.load(makeTextPdf(['host']));
    importPages(src, dst, [0]);
    const out = reload(dst);
    const fields = readFields(out);
    expect(fields.map((f) => f.name).sort()).toEqual(readFields(src).map((f) => f.name).sort());
    expect(fields.every((f) => f.widgets.every((w) => w.page === 1))).toBe(true);
    expect(fields.find((f) => f.name === 'Size')!.widgets.map((w) => w.onState)).toEqual(['Small', 'Medium', 'Large']);
    applyFormData(out, { Name: 'Zed' });
    const onPage = pageAnnotations(reload(out), out.pages[1]).find((a) => out.getText(a.dict, 'T') === 'Name')!;
    expect(out.getText(onPage.dict, 'V')).toBe('Zed');
    setFieldValue(out, readFields(out).find((f) => f.name === 'Size')!, 'Large');
    expect(formData(out).Size).toBe('Large');
  });

  it('a layer that is hidden in the source stays hidden', () => {
    const d = PdfDocument.create();
    const p = addBlankPage(d);
    const f = ensureFont(d, p, 'Helvetica');
    const g = d.register(new Dict({ Type: Name.get('OCG'), Name: PdfString.fromText('Draft notes') }));
    d.pageResources(p).set('Properties', new Dict({ MC0: g }));
    d.setPageContent(p, bytesOf(`/OC /MC0 BDC BT /${f} 12 Tf 100 700 Td (hidden draft) Tj ET EMC`));
    d.catalog.set('OCProperties', new Dict({ OCGs: [g], D: new Dict({ OFF: [g] }) }));
    const out = reload(extractPages(reload(d), [0]));
    expect(hiddenLayers(out).map((l) => l.name)).toEqual(['Draft notes']);
  });
});

describe('placement on rotated and cropped pages', () => {
  it('headers and Bates numbers follow /Rotate', () => {
    const d = PdfDocument.load(makeTextPdf(['x']));
    rotatePages(d, [0], 90);
    addOverlayText(d, [0], { text: 'HEADER', position: 'top-left' });
    // Top-left of the displayed page (792 × 612) is user-space (36, 36), text running up the y axis.
    expect(content(d)).toContain('0 1 -1 0 36 36 Tm (HEADER) Tj');
    const u = PdfDocument.load(makeTextPdf(['x']));
    addOverlayText(u, [0], { text: 'HEADER', position: 'top-left' });
    expect(content(u)).toContain('36 756 Td (HEADER) Tj');
  });

  it('fit to paper gives the displayed page the paper size and keeps cropped content hidden', () => {
    const d = PdfDocument.load(makeTextPdf(['x']));
    rotatePages(d, [0], 90);
    d.pages[0].dict.set('CropBox', [100, 100, 400, 500]);
    d.invalidatePages();
    scalePages(d, [0], { paper: [612, 792] });
    const p = reload(d).pages[0];
    expect([Math.round(p.width), Math.round(p.height)]).toEqual([612, 792]);
    expect(content(d)).toContain('100 100 300 400 re W n');
  });

  it('N-up and booklet place rotated pages with a crop origin inside their cell and leave the source alone', () => {
    const src0 = PdfDocument.load(makeTextPdf(['one', 'two']));
    for (const p of src0.pages) { p.dict.set('CropBox', [100, 100, 400, 500]); p.dict.set('Rotate', 90); }
    const src = reload(src0);
    const out = nUp(src, { cols: 2, rows: 1, paper: [792, 612], margin: 18, gap: 12 });
    expect(src.dirty).toBe(false);
    expect(src.changed.size).toBe(0);
    // Displayed page: 400 × 300; cell 372 × 576; scale 0.93; first page at x = 18, y = 18 + (576 - 279) / 2.
    expect(content(out)).toContain('q 0.93 0 0 0.93 18 166.5 cm /Pg1 Do Q');
    const form = out.get<PdfStream>(out.getDict(out.pages[0].resources, 'XObject'), 'Pg1');
    expect(out.getArray(form, 'Matrix')).toEqual([0, -1, 1, 0, -100, 400]);
    expect(() => nUp(src, { cols: -1, rows: 2, paper: [792, 612] })).not.toThrow();
    booklet(src);
    expect(src.changed.size).toBe(0);
  });
});
