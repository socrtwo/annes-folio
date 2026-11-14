import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, Ref, latin1 } from '../../src/pdf/objects';
import { addBlankPage, makeTextPdf } from '../../src/pdf/build';
import { pageAnnotations, readFields, readAttachments } from '../../src/pdf/structure';
import { addTextMarkup, addNote, addFreeText, addShape, addInk, addTextStamp, addRedactMark, addFileAttachmentAnnot, setAnnotationProps, refreshAppearance, deleteAnnotation, duplicateAnnotation, flattenAnnotations, exportXfdf, importXfdf } from '../../src/pdf/ops/annots';
import { addField } from '../../src/pdf/ops/forms';
import { parseXml } from '../../src/io/xml';

const reload = (d: PdfDocument) => PdfDocument.load(d.save({ incremental: false }));
const fresh = () => { const d = PdfDocument.create(); return { d, p: addBlankPage(d) }; };
const ap = (d: PdfDocument, ref: Ref) => d.get<PdfStream>(d.getDict(d.resolve<Dict>(ref), 'AP'), 'N');
const apText = (d: PdfDocument, ref: Ref) => latin1(d.decoded(ap(d, ref)));
const nums = (d: PdfDocument, ref: Ref, key: string) => (d.getArray(d.resolve<Dict>(ref), key) || []).map((x) => d.resolve<number>(x));

describe('setAnnotationProps (C6)', () => {
  it('moves QuadPoints, InkList, L, Vertices and CL with the rectangle and leaves the matrix alone', () => {
    const { d, p } = fresh();
    const hl = addTextMarkup(d, p, 'Highlight', [[100, 100, 200, 120]]);
    setAnnotationProps(d, p, hl, { rect: [300, 500, 400, 520] });
    expect(nums(d, hl, 'QuadPoints')).toEqual([300, 520, 400, 520, 300, 500, 400, 500]);
    const ink = addInk(d, p, [[[10, 10], [20, 30]]], { width: 2 });
    setAnnotationProps(d, p, ink, { rect: [108, 108, 122, 132] }); // was [8, 8, 22, 32]
    expect(d.resolve<number[]>(d.getArray(d.resolve<Dict>(ink), 'InkList')![0])).toEqual([110, 110, 120, 130]);
    const line = addShape(d, p, 'Line', [50, 50, 150, 100], { points: [[50, 50], [150, 100]], width: 1 });
    setAnnotationProps(d, p, line, { rect: [59, 69, 161, 121] }); // was [49, 49, 151, 101]
    expect(nums(d, line, 'L')).toEqual([60, 70, 160, 120]);
    const poly = addShape(d, p, 'Polygon', [0, 0, 10, 10], { points: [[0, 0], [10, 0], [10, 10]], width: 1 });
    setAnnotationProps(d, p, poly, { rect: [99, 199, 111, 211] });
    expect(nums(d, poly, 'Vertices')).toEqual([100, 200, 110, 200, 110, 210]);
    const call = addFreeText(d, p, [200, 200, 300, 240], { text: 'note', callout: [100, 100, 150, 150, 200, 220] });
    const before = nums(d, call, 'Rect');
    setAnnotationProps(d, p, call, { rect: [before[0] + 10, before[1] + 20, before[2] + 10, before[3] + 20] });
    expect(nums(d, call, 'CL')).toEqual([110, 120, 160, 170, 210, 240]);
    const stamp = addTextStamp(d, p, [100, 100, 300, 160], 'Draft', { rotate: 30 });
    const m = nums(d, stamp, 'Rect') && (d.getArray(ap(d, stamp), 'Matrix') || []).map((x) => d.resolve<number>(x));
    setAnnotationProps(d, p, stamp, { rect: [120, 100, 320, 160] });
    expect((d.getArray(ap(d, stamp), 'Matrix') || []).map((x) => d.resolve<number>(x))).toEqual(m);
    expect(m[1]).toBeCloseTo(0.5, 5);
  });

  it('a note keeps its popup next to it', () => {
    const { d, p } = fresh();
    const note = addNote(d, p, 100, 700, { contents: 'n' });
    const pop = d.resolve<Dict>(note).get('Popup') as Ref;
    setAnnotationProps(d, p, note, { rect: [300, 480, 320, 500] });
    expect(d.rect(d.resolve<Dict>(pop).get('Rect'))).toEqual([324, 380, 504, 500]);
  });

  it('rebuilds the appearance after a colour, opacity, border-width or text change', () => {
    const { d, p } = fresh();
    const sq = addShape(d, p, 'Square', [100, 100, 200, 200], { stroke: [1, 0, 0], width: 2 });
    setAnnotationProps(d, p, sq, { color: [0, 0, 1] });
    expect(apText(d, sq)).toContain('0 0 1 RG');
    setAnnotationProps(d, p, sq, { opacity: 0.4 });
    expect(d.getNum(d.getDict(d.getDict(d.getDict(ap(d, sq), 'Resources'), 'ExtGState'), 'GS'), 'CA')).toBeCloseTo(0.4);
    setAnnotationProps(d, p, sq, { borderWidth: 6 });
    expect(apText(d, sq)).toContain(' 6 w ');
    expect(d.getNum(d.getDict(d.resolve<Dict>(sq), 'BS'), 'W')).toBe(6);
    expect(d.rect(d.resolve<Dict>(sq).get('Rect'))).toEqual([94, 94, 206, 206]); // the square itself stays 100..200
    const hl = addTextMarkup(d, p, 'Highlight', [[100, 300, 200, 320]]);
    setAnnotationProps(d, p, hl, { color: [0, 1, 0] });
    expect(apText(d, hl)).toContain('0 1 0 rg');
    const ft = addFreeText(d, p, [100, 400, 300, 440], { text: 'before' });
    setAnnotationProps(d, p, ft, { contents: 'after edit' });
    expect(apText(d, ft)).toContain('(after edit) Tj');
    const ink = addInk(d, p, [[[10, 10], [20, 30]]], { highlighter: true });
    setAnnotationProps(d, p, ink, { color: [1, 0, 1] });
    expect(apText(d, ink)).toContain('1 0 1 RG');
    expect(d.getName(d.getDict(d.getDict(d.getDict(ap(d, ink), 'Resources'), 'ExtGState'), 'GS'), 'BM')).toBe('Multiply');
    const stamp = addTextStamp(d, p, [100, 500, 300, 560], 'Final');
    setAnnotationProps(d, p, stamp, { color: [0, 0.5, 0] });
    expect(apText(d, stamp)).toContain('0 0.5 0 rg');
    expect(apText(d, stamp)).toContain('(Final) Tj');
  });

  it('does not redraw when nothing visible changed, and leaves appearances it cannot draw alone', () => {
    const { d, p } = fresh();
    const sq = addShape(d, p, 'Square', [100, 100, 200, 200], { stroke: [1, 0, 0] });
    const before = (d.getDict(d.resolve<Dict>(sq), 'AP')!.get('N') as Ref).num;
    setAnnotationProps(d, p, sq, { contents: 'a comment', color: [1, 0, 0], opacity: 1, author: 'x' });
    expect((d.getDict(d.resolve<Dict>(sq), 'AP')!.get('N') as Ref).num).toBe(before);
    const foreign = d.register(new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Caret'), Rect: [10, 10, 20, 20] }));
    p.dict.set('Annots', [...(d.getArray(p.dict, 'Annots') || []), foreign]);
    expect(refreshAppearance(d, p, foreign)).toBe(false);
    expect(refreshAppearance(d, p, sq)).toBe(true);
  });
});

describe('deleting, duplicating and flattening', () => {
  it('deleting a widget leaves no dangling entry in /Fields', () => {
    const { d, p } = fresh();
    const w = addField(d, { name: 'gone', type: 'text', page: 0, rect: [50, 700, 250, 720] });
    addField(d, { name: 'stays', type: 'text', page: 0, rect: [50, 650, 250, 670] });
    deleteAnnotation(d, p, w);
    const out = reload(d);
    const fields = out.getArray(out.getDict(out.catalog, 'AcroForm'), 'Fields')!;
    expect(fields.length).toBe(1);
    expect(fields.every((f) => out.resolve(f) instanceof Dict)).toBe(true);
    expect(readFields(out).map((f) => f.name)).toEqual(['stays']);
  });

  it('a duplicate has its own name and its own appearance stream', () => {
    const { d, p } = fresh();
    const sq = addShape(d, p, 'Square', [100, 100, 200, 200], {});
    const copy = duplicateAnnotation(d, p, sq, 12, -12);
    const a = d.resolve<Dict>(sq), b = d.resolve<Dict>(copy);
    expect(d.getText(b, 'NM')).not.toBe(d.getText(a, 'NM'));
    expect((d.getDict(b, 'AP')!.get('N') as Ref).num).not.toBe((d.getDict(a, 'AP')!.get('N') as Ref).num);
    expect(d.rect(b.get('Rect'))).toEqual([110, 86, 214, 190]);
    setAnnotationProps(d, p, copy, { color: [0, 1, 0] });
    expect(apText(d, sq)).not.toContain('0 1 0 RG');
    const hl = addTextMarkup(d, p, 'Highlight', [[100, 300, 200, 320]]);
    expect(nums(d, duplicateAnnotation(d, p, hl, 10, 10), 'QuadPoints')).toEqual([110, 330, 210, 330, 110, 310, 210, 310]);
    const note = addNote(d, p, 100, 700, { contents: 'n' });
    const note2 = duplicateAnnotation(d, p, note, 30, 0);
    expect(d.resolve<Dict>(note2).get('Popup')).not.toEqual(d.resolve<Dict>(note).get('Popup'));
  });

  it('flattening picks the off state when a state dictionary has no /AS, and draws streams that omit /Subtype', () => {
    const { d, p } = fresh();
    const box = addField(d, { name: 'c', type: 'checkbox', page: 0, rect: [50, 600, 66, 616] });
    d.resolve<Dict>(box).delete('AS');
    const sq = addShape(d, p, 'Square', [100, 100, 200, 200], {});
    ap(d, sq).dict.delete('Subtype');
    const r = reload(d);
    expect(flattenAnnotations(r, r.pages[0])).toBe(2);
    const xo = r.getDict(r.pages[0].resources, 'XObject')!;
    const forms = xo.keys().map((k) => r.get<PdfStream>(xo, k));
    expect(forms.every((f) => r.getName(f, 'Subtype') === 'Form')).toBe(true);
    expect(forms.some((f) => / l S/.test(latin1(r.decoded(f))))).toBe(false); // no check-mark stroke: the off appearance was used
    expect(readFields(reload(r))).toEqual([]);
  });

  it('writes the attachment MIME type as a plain name', () => {
    const { d, p } = fresh();
    addFileAttachmentAnnot(d, p, 100, 700, 'a.txt', new TextEncoder().encode('hi'), { mime: 'text/plain' });
    const bytes = latin1(d.save({ incremental: false }));
    expect(bytes).toContain('/Subtype/text#2Fplain');
    expect(bytes).not.toContain('#232F');
    expect(readAttachments(reload(d)).map((a) => a.mime)).toEqual(['text/plain']);
  });
});

describe('XFDF', () => {
  it('exports well-formed XML whatever subtypes the document holds', () => {
    const { d, p } = fresh();
    addNote(d, p, 100, 700, { contents: 'fine \u0001note', author: 'a' });
    p.dict.set('Annots', [...(d.getArray(p.dict, 'Annots') || []), d.register(new Dict({ Type: Name.get('Annot'), Subtype: Name.get('3D'), Rect: [0, 0, 10, 10] })), d.register(new Dict({ Type: Name.get('Annot'), Subtype: Name.get('x><evil a="1"'), Rect: [0, 0, 10, 10] }))]);
    const xml = exportXfdf(d);
    expect(parseXml(xml)).not.toBeNull();
    expect(xml).not.toContain('evil');
    expect(xml).not.toContain('<3d');
    const e = fresh();
    expect(importXfdf(e.d, xml)).toBe(1);
  });

  it('import reports malformed XML, reads quads in any corner order, and skips comments the document already has', () => {
    const { d, p } = fresh();
    expect(() => importXfdf(d, '<xfdf><annots><text page="0" rect="1,2,3,4"><contents>a & b</contents></text></annots></xfdf>')).toThrow(/not well-formed/);
    importXfdf(d, '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><highlight page="0" rect="100,100,200,112" coords="100,100,200,100,200,112,100,112"/></annots></xfdf>');
    expect(pageAnnotations(d, p)[0].rect).toEqual([100, 100, 200, 112]);
    const xml = exportXfdf(d);
    expect(importXfdf(d, xml)).toBe(0);
    expect(pageAnnotations(d, p).length).toBe(1);
  });

  it('a wild rectangle cannot stall the import', () => {
    const { d, p } = fresh();
    const t = Date.now();
    const n = importXfdf(d, '<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><squiggly page="0" rect="0,0,300000000,10" coords="0,10,300000000,10,0,0,300000000,0"/><line page="0" rect="0,0,10,10" width="abc"/></annots></xfdf>');
    expect(n).toBe(1);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(pageAnnotations(d, p)[0].rect[2]).toBeLessThanOrEqual(612 + 792);
  });

  it('round-trips a redaction mark with its overlay text', () => {
    const { d, p } = fresh();
    addRedactMark(d, p, [[100, 100, 200, 120]], { overlayText: 'WITHHELD' });
    const e = fresh();
    expect(importXfdf(e.d, exportXfdf(d))).toBe(1);
    expect(e.d.getText(pageAnnotations(e.d, e.p)[0].dict, 'OverlayText')).toBe('WITHHELD');
    void makeTextPdf;
  });
});
