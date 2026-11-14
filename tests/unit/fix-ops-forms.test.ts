import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, PdfString, Ref, bytesOf, latin1 } from '../../src/pdf/objects';
import { addBlankPage } from '../../src/pdf/build';
import { pageAnnotations, readFields } from '../../src/pdf/structure';
import { addField, setFieldValue, setFieldProps, resetForm, deleteField, flattenForm, formData, applyFormData, exportFormFdf, importFormFdf, importFormXfdf } from '../../src/pdf/ops/forms';
import { TEMPLATES } from '../../src/templates';

const reload = (d: PdfDocument) => PdfDocument.load(d.save({ incremental: false }));
const fresh = () => { const d = PdfDocument.create(); addBlankPage(d); return d; };
const field = (d: PdfDocument, name: string) => readFields(d).find((f) => f.name === name)!;
const apOf = (d: PdfDocument, name: string) => { const f = field(d, name); return d.get<PdfStream>(d.getDict(f.widgets[0].dict, 'AP'), 'N'); };
const shown = (d: PdfDocument, name: string) => /\(([^)]*)\) Tj/.exec(latin1(d.decoded(apOf(d, name))))?.[1];

describe('field appearances', () => {
  it('filling one field does not change another that shared its appearance stream', () => {
    const d = fresh();
    const a = addField(d, { name: 'A', type: 'text', page: 0, rect: [50, 700, 250, 720] });
    const b = addField(d, { name: 'B', type: 'text', page: 0, rect: [50, 650, 250, 670] });
    d.resolve<Dict>(b).set('AP', new Dict({ N: d.getDict(d.resolve<Dict>(a), 'AP')!.get('N') as Ref }));
    const r = reload(d);
    setFieldValue(r, field(r, 'A'), 'only A');
    const out = reload(r);
    expect(shown(out, 'A')).toBe('only A');
    expect(shown(out, 'B')).toBe('');
  });

  it('a widget turned by /MK /R is laid out in its own box', () => {
    const d = fresh();
    const a = addField(d, { name: 'R', type: 'text', page: 0, rect: [50, 600, 70, 760] });
    d.getDict(d.resolve<Dict>(a), 'MK')!.set('R', 90);
    setFieldValue(d, field(d, 'R'), 'rotated');
    const n = apOf(d, 'R');
    expect(d.getArray(n, 'BBox')).toEqual([0, 0, 160, 20]);
    expect(d.getArray(n, 'Matrix')).toEqual([0, 1, -1, 0, 20, 0]);
    const y = +/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(latin1(d.decoded(n)))![1];
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(20);
  });

  it('a choice shows the label of its value; text outside WinAnsi asks readers to draw the field', () => {
    const d = fresh();
    addField(d, { name: 'S', type: 'combo', page: 0, rect: [50, 700, 250, 720] });
    field(d, 'S').dict.set('Opt', [[PdfString.fromText('CA'), PdfString.fromText('California')], [PdfString.fromText('NY'), PdfString.fromText('New York')]]);
    setFieldValue(d, field(d, 'S'), 'California');
    expect(field(d, 'S').value).toBe('CA');
    expect(shown(d, 'S')).toBe('California');
    const af = d.getDict(d.catalog, 'AcroForm')!;
    expect(d.get(af, 'NeedAppearances')).not.toBe(true);
    addField(d, { name: 'T', type: 'text', page: 0, rect: [50, 650, 250, 670] });
    setFieldValue(d, field(d, 'T'), 'Ελληνικά');
    expect(d.get(af, 'NeedAppearances')).toBe(true);
  });

  it('a composite /DA font is not fed WinAnsi bytes', () => {
    const d = fresh();
    addField(d, { name: 'T', type: 'text', page: 0, rect: [50, 650, 250, 670] });
    const af = d.getDict(d.catalog, 'AcroForm')!;
    const cid = d.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('Type0'), BaseFont: Name.get('NotoSans'), Encoding: Name.get('Identity-H') }));
    d.getDict(d.getDict(af, 'DR'), 'Font')!.set('F9', cid);
    field(d, 'T').dict.set('DA', PdfString.fromText('/F9 10 Tf 0 g'));
    setFieldValue(d, field(d, 'T'), 'plain');
    const fonts = d.getDict(d.getDict(apOf(d, 'T'), 'Resources'), 'Font')!;
    expect(fonts.keys()).toEqual(['QFHelv']);
    expect(d.getName(d.getDict(fonts, 'QFHelv'), 'BaseFont')).toBe('Helvetica');
  });

  it('property changes redraw with the new properties', () => {
    const d = fresh();
    addField(d, { name: 'M', type: 'text', page: 0, rect: [50, 600, 150, 700], value: 'one two three four five six seven eight nine ten' });
    const f = field(d, 'M');
    setFieldProps(d, f, { multiline: true });
    expect((latin1(d.decoded(apOf(d, 'M'))).match(/ Tj/g) || []).length).toBeGreaterThan(1);
    expect(f.multiline).toBe(true);
  });
});

describe('radio groups', () => {
  it('every button of a group made by addField can be selected, also in the Simple form template', () => {
    for (const d of [TEMPLATES.find((t) => t.id === 'form')!.build(), (() => { const x = fresh(); for (const v of ['Small', 'Medium', 'Large']) addField(x, { name: 'Size', type: 'radio', page: 0, rect: [50, 600, 66, 616], exportValue: v }); return x; })()]) {
      const r = reload(d);
      expect(field(r, 'Size').widgets.map((w) => w.onState)).toEqual(['Small', 'Medium', 'Large']);
      expect(r.getName(field(r, 'Size').dict, 'Subtype')).toBe(''); // the group is not itself a widget
      setFieldValue(r, field(r, 'Size'), 'Small');
      expect(field(r, 'Size').widgets.map((w) => r.getName(w.dict, 'AS'))).toEqual(['Small', 'Off', 'Off']);
      expect(formData(r).Size).toBe('Small');
      expect(() => setFieldValue(r, field(r, 'Size'), 'Huge')).toThrow(/no option/);
    }
  });

  it('a group written by an earlier version (first button merged with the field) is repaired when a button is added', () => {
    const d = fresh();
    const first = addField(d, { name: 'Pick', type: 'checkbox', page: 0, rect: [50, 600, 66, 616], exportValue: 'One' });
    const fd = d.resolve<Dict>(first);
    fd.set('Ff', 1 << 15);
    const second = d.register(new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Widget'), Rect: [80, 600, 96, 616], Parent: first, AS: Name.get('Off'), AP: new Dict({ N: new Dict({ Two: d.getDict(d.getDict(fd, 'AP'), 'N')!.get('One')!, Off: d.getDict(d.getDict(fd, 'AP'), 'N')!.get('Off')! }) }) }));
    fd.set('Kids', [second]);
    d.pages[0].dict.set('Annots', [...(d.getArray(d.pages[0].dict, 'Annots') || []), second]);
    d.invalidatePages();
    addField(d, { name: 'Pick', type: 'radio', page: 0, rect: [110, 600, 126, 616], exportValue: 'Three' });
    const r = reload(d);
    expect(field(r, 'Pick').widgets.map((w) => w.onState)).toEqual(['One', 'Two', 'Three']);
  });

  it('FDF export names the selected option and reset restores the default one', () => {
    const d = TEMPLATES.find((t) => t.id === 'form')!.build();
    setFieldValue(d, field(d, 'Size'), 'Large');
    expect(latin1(exportFormFdf(d))).toMatch(/\/T\s*\(Size\)\s*\/V\s*\/Large/);
    field(d, 'Size').dict.set('DV', Name.get('Medium'));
    resetForm(d);
    expect(formData(d).Size).toBe('Medium');
  });
});

describe('form data', () => {
  it('an exact field name wins over a partial one; "No" does not tick a box', () => {
    const d = fresh();
    const par = d.register(new Dict({ T: PdfString.fromText('shipping'), Kids: [] }));
    const k = addField(d, { name: 'name', type: 'text', page: 0, rect: [50, 700, 250, 720] });
    d.getDict(d.catalog, 'AcroForm')!.set('Fields', [par]); d.resolve<Dict>(par).set('Kids', [k]); d.resolve<Dict>(k).set('Parent', par);
    addField(d, { name: 'name', type: 'text', page: 0, rect: [50, 650, 250, 670] });
    addField(d, { name: 'agree', type: 'checkbox', page: 0, rect: [50, 600, 66, 616] });
    applyFormData(d, { name: 'TOP', agree: 'No' });
    expect(formData(d)).toEqual({ 'shipping.name': '', name: 'TOP', agree: false });
    applyFormData(d, { agree: 'Yes' });
    expect(formData(d).agree).toBe(true);
  });

  it('reads plain FDF files (no cross-reference table) and writes them the same way', () => {
    const d = fresh();
    addField(d, { name: 'name', type: 'text', page: 0, rect: [50, 700, 250, 720] });
    const fdf = '%FDF-1.2\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<</FDF<</Fields[<</T(name)/V(John)>>]>>>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n';
    expect(importFormFdf(d, bytesOf(fdf))).toBe(1);
    expect(formData(d).name).toBe('John');
    const out = latin1(exportFormFdf(d));
    expect(out.startsWith('%FDF-1.2')).toBe(true);
    expect(out).not.toContain('/Catalog');
    const e = fresh();
    addField(e, { name: 'name', type: 'text', page: 0, rect: [50, 700, 250, 720] });
    expect(importFormFdf(e, exportFormFdf(d))).toBe(1);
    expect(formData(e).name).toBe('John');
    expect(() => importFormFdf(e, bytesOf('not an fdf'))).toThrow(/no FDF/);
    expect(() => importFormXfdf(e, '<xfdf><fields><field name="a"><value>x & y</value></field></fields></xfdf>')).toThrow(/not well-formed/);
  });
});

describe('flattening and deleting', () => {
  it('flatten draws values that have no appearance yet and leaves no widgets behind', () => {
    const d = fresh();
    const a = addField(d, { name: 'T', type: 'text', page: 0, rect: [50, 700, 250, 720] });
    const c = addField(d, { name: 'C', type: 'checkbox', page: 0, rect: [50, 650, 66, 666] });
    const w = d.resolve<Dict>(a); w.delete('AP'); w.set('V', PdfString.fromText('typed elsewhere'));
    d.getDict(d.catalog, 'AcroForm')!.set('NeedAppearances', true);
    d.getDict(d.getDict(d.resolve<Dict>(c), 'AP'), 'N')!.delete('Off');
    const r = reload(d);
    expect(flattenForm(r)).toBe(1);
    const out = reload(r);
    expect(out.catalog.has('AcroForm')).toBe(false);
    expect(pageAnnotations(out, out.pages[0])).toEqual([]);
    const xo = out.getDict(out.pages[0].resources, 'XObject')!;
    expect(xo.keys().map((k) => latin1(out.decoded(out.get<PdfStream>(xo, k)))).join('\n')).toContain('(typed elsewhere) Tj');
  });

  it('deleting the last widget of a field removes the field and its calculation-order entry', () => {
    const d = fresh();
    const par = d.register(new Dict({ T: PdfString.fromText('group'), Kids: [] }));
    const k = addField(d, { name: 'leaf', type: 'text', page: 0, rect: [50, 700, 250, 720] });
    const af = d.getDict(d.catalog, 'AcroForm')!;
    af.set('Fields', [par]); af.set('CO', [k]);
    d.resolve<Dict>(par).set('Kids', [k]); d.resolve<Dict>(k).set('Parent', par);
    deleteField(d, field(d, 'group.leaf'));
    const out = reload(d);
    const oaf = out.getDict(out.catalog, 'AcroForm')!;
    expect(out.getArray(oaf, 'Fields')).toEqual([]);
    expect(out.getArray(oaf, 'CO')).toEqual([]);
  });
});
