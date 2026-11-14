import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { addBlankPage, addTextPages, PAPER } from '../../src/pdf/build';
import { readOutlines, writeOutlines, readPageLabels, writePageLabels, pageLabelList, readAttachments, addAttachment, removeAttachment, readMetadata, writeMetadata, pageAnnotations, readFields, readLayers } from '../../src/pdf/structure';
import { addTextMarkup, addNote, addFreeText, addShape, addInk, addTextStamp, addLink, addRedactMark, addReply, setAnnotationProps, deleteAnnotation, flattenAnnotations, applyRedactions, exportXfdf, importXfdf } from '../../src/pdf/ops/annots';
import { addField, setFieldValue, resetForm, deleteField, setFieldProps, flattenForm, formData, applyFormData, exportFormXfdf, importFormXfdf, exportFormFdf, importFormFdf, formDataCsv, detectFieldsFromText } from '../../src/pdf/ops/forms';
import { rotatePages, deletePages, movePages, duplicatePages, insertBlankPages, importPages, extractPages, splitDocument, parseRanges, cropPages, scalePages, addWatermark, addBates, addOverlayText, nUp, booklet, reversePages, setPageOrder } from '../../src/pdf/ops/pages';
import { pageText, pageTextRuns, tablesFromRuns, toCsv, textToMarkdown } from '../../src/pdf/ops/extract';
import { pageRuns, replaceRunText, eraseArea, insertText } from '../../src/pdf/ops/textedit';
import { listFonts, stats, hiddenInformation, sanitize, archivalCheck, accessibilityCheck, accessibilityFix } from '../../src/pdf/ops/optimize';
import { repairPdf } from '../../src/pdf/repair';
import { Lexer } from '../../src/pdf/lexer';
import { latin1 } from '../../src/pdf/objects';

const latin = (b: Uint8Array) => latin1(b);
const bytes = (s: string) => new TextEncoder().encode(s);
const latinBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function sample(): PdfDocument {
  const d = PdfDocument.create();
  addTextPages(d, '# Title One\n\nAlpha beta gamma delta.\n\nSecond paragraph here.\n\n## Heading Two\n\nMore words follow.', { title: 'Sample' });
  addBlankPage(d);
  addBlankPage(d, PAPER.a4);
  return reload(d);
}
const reload = (d: PdfDocument, incremental = false) => PdfDocument.load(d.save({ incremental }));

describe('structure', () => {
  it('outlines round trip with nesting', () => {
    const d = sample();
    writeOutlines(d, [{ title: 'One', page: 0, children: [{ title: 'One a', page: 1 }] }, { title: 'Two', page: 2, url: undefined }]);
    const r = reload(d, true);
    const o = readOutlines(r);
    expect(o.map((x) => [x.title, x.dest?.page])).toEqual([['One', 0], ['Two', 2]]);
    expect(o[0].children.map((x) => x.title)).toEqual(['One a']);
  });
  it('page labels', () => {
    const d = sample();
    writePageLabels(d, [{ start: 0, style: 'r' }, { start: 2, style: 'D', prefix: 'A-', first: 1 }]);
    const r = reload(d);
    expect(pageLabelList(readPageLabels(r), 3)).toEqual(['i', 'ii', 'A-1']);
  });
  it('attachments add, list, remove', () => {
    const d = sample();
    addAttachment(d, 'notes.txt', bytes('hello'), { mime: 'text/plain', description: 'Notes' });
    let r = reload(d, true);
    const a = readAttachments(r);
    expect(a.map((x) => [x.name, x.size, x.mime])).toEqual([['notes.txt', 5, 'text/plain']]);
    expect(latin(r.decoded(a[0].stream!))).toBe('hello');
    removeAttachment(r, a[0]);
    r = reload(r);
    expect(readAttachments(r)).toEqual([]);
  });
  it('metadata and XMP', () => {
    const d = sample();
    writeMetadata(d, { title: 'My Doc', author: 'Ann', language: 'en-US', custom: { Project: 'X' } });
    const r = reload(d);
    const m = readMetadata(r);
    expect([m.title, m.author, m.language, m.custom.Project]).toEqual(['My Doc', 'Ann', 'en-US', 'X']);
    expect(m.xmp).toContain('My Doc');
  });
  it('layers are read from OCProperties', () => {
    const d = sample();
    expect(readLayers(d)).toEqual([]);
  });
});

describe('annotations', () => {
  it('creates markup, notes, shapes, ink, stamps and links with appearances', () => {
    const d = sample();
    const p = d.pages[0];
    addTextMarkup(d, p, 'Highlight', [[72, 700, 200, 714]], { author: 'Ann', color: [1, 1, 0] });
    addNote(d, p, 100, 650, { contents: 'A note', author: 'Ann' });
    addFreeText(d, p, [72, 500, 300, 560], { text: 'Box text', size: 12 });
    addShape(d, p, 'Circle', [300, 300, 400, 380], { stroke: [1, 0, 0] });
    addInk(d, p, [[[10, 10], [50, 60], [90, 20]]], { width: 3 });
    addTextStamp(d, p, [72, 100, 272, 140], 'Approved');
    addLink(d, p, [72, 50, 200, 70], { url: 'https://example.org' });
    const r = reload(d, true);
    const a = pageAnnotations(r, r.pages[0]);
    const types = a.map((x) => x.subtype).filter((t) => t !== 'Popup').sort();
    expect(types).toEqual(['Circle', 'FreeText', 'Highlight', 'Ink', 'Link', 'Stamp', 'Text']);
    for (const x of a) if (x.subtype !== 'Popup' && x.subtype !== 'Link') expect(r.getDict(x.dict, 'AP'), x.subtype).toBeTruthy();
    expect(a.find((x) => x.subtype === 'Text')!.contents).toBe('A note');
  });
  it('edits, replies to, deletes and flattens annotations', () => {
    const d = sample();
    const p = d.pages[0];
    const ref = addNote(d, p, 100, 650, { contents: 'first', author: 'Ann' });
    setAnnotationProps(d, p, ref, { contents: 'second', color: [0, 0, 1] });
    addReply(d, p, ref, 'reply', 'Bob', { model: 'Review', state: 'Accepted' });
    let r = reload(d, true);
    const notes = pageAnnotations(r, r.pages[0]).filter((x) => x.subtype === 'Text');
    expect(notes.map((x) => x.contents).sort()).toEqual(['reply', 'second']);
    expect(notes.find((x) => x.irt)!.state).toBe('Accepted');
    deleteAnnotation(r, r.pages[0], notes.find((x) => !x.irt)!.ref!);
    r = reload(r);
    expect(pageAnnotations(r, r.pages[0]).filter((x) => x.subtype === 'Text' && !x.irt)).toEqual([]);
    addShape(r, r.pages[0], 'Square', [10, 10, 100, 100], { fill: [0, 1, 0] });
    const n = flattenAnnotations(r, r.pages[0], (x) => x.subtype === 'Square');
    expect(n).toBe(1);
    r = reload(r);
    expect(pageAnnotations(r, r.pages[0]).some((x) => x.subtype === 'Square')).toBe(false);
    expect(latin(r.pageContent(r.pages[0]))).toContain('Do');
  });
  it('redaction removes text under the mark', () => {
    const d = sample();
    const p = d.pages[0];
    const runs = pageRuns(d, p);
    const target = runs.find((x) => /Alpha/.test(x.text))!;
    addRedactMark(d, p, [target.box]);
    const res = applyRedactions(d, [0]);
    expect(res.textRemoved).toBeGreaterThan(0);
    const r = reload(d);
    expect(pageText(r, 0)).not.toContain('Alpha');
    expect(pageAnnotations(r, r.pages[0]).some((x) => x.subtype === 'Redact')).toBe(false);
  });
  it('XFDF export and import', () => {
    const d = sample();
    addNote(d, d.pages[0], 100, 650, { contents: 'Shared note', author: 'Ann' });
    addTextMarkup(d, d.pages[1], 'Underline', [[72, 700, 200, 714]]);
    const xml = exportXfdf(d, 'sample.pdf');
    expect(xml).toContain('<xfdf');
    expect(xml).toContain('Shared note');
    const e = sample();
    const n = importXfdf(e, xml);
    expect(n).toBe(2);
    const r = reload(e);
    expect(pageAnnotations(r, r.pages[0]).find((x) => x.subtype === 'Text')!.contents).toBe('Shared note');
    expect(pageAnnotations(r, r.pages[1]).some((x) => x.subtype === 'Underline')).toBe(true);
  });
});

describe('forms', () => {
  it('adds fields of every type, fills, resets, flattens', () => {
    const d = sample();
    addField(d, { name: 'Name', type: 'text', page: 0, rect: [72, 600, 300, 622] });
    addField(d, { name: 'Agree', type: 'checkbox', page: 0, rect: [72, 560, 90, 578] });
    addField(d, { name: 'Size', type: 'radio', page: 0, rect: [72, 520, 90, 538], exportValue: 'S' });
    addField(d, { name: 'Size', type: 'radio', page: 0, rect: [100, 520, 118, 538], exportValue: 'M' });
    addField(d, { name: 'Color', type: 'combo', page: 0, rect: [72, 480, 200, 502], options: ['Red', 'Green'] });
    addField(d, { name: 'Sig', type: 'signature', page: 1, rect: [72, 100, 300, 150] });
    let r = reload(d);
    let f = readFields(r);
    expect(f.map((x) => [x.name, x.type]).sort()).toEqual([['Agree', 'checkbox'], ['Color', 'combo'], ['Name', 'text'], ['Sig', 'signature'], ['Size', 'radio']]);
    setFieldValue(r, f.find((x) => x.name === 'Name')!, 'Ann Example');
    setFieldValue(r, f.find((x) => x.name === 'Agree')!, true);
    setFieldValue(r, f.find((x) => x.name === 'Size')!, 'M');
    setFieldValue(r, f.find((x) => x.name === 'Color')!, 'Green');
    r = reload(r, true);
    expect(formData(r)).toEqual({ Name: 'Ann Example', Agree: true, Size: 'M', Color: 'Green' });
    const csv = formDataCsv(r);
    expect(csv.split('\n')[0]).toContain('Name');
    const xfdf = exportFormXfdf(r);
    const fdf = exportFormFdf(r);
    const e = reload(d);
    expect(importFormXfdf(e, xfdf)).toBeGreaterThanOrEqual(3);
    expect(formData(e).Name).toBe('Ann Example');
    const e2 = reload(d);
    expect(importFormFdf(e2, fdf)).toBeGreaterThanOrEqual(3);
    expect(formData(e2).Color).toBe('Green');
    const e3 = reload(d);
    applyFormData(e3, { Name: 'From JSON', Agree: 'true' });
    expect(formData(e3).Name).toBe('From JSON');
    resetForm(r);
    expect(formData(r).Name).toBe('');
    f = readFields(r);
    setFieldProps(r, f.find((x) => x.name === 'Name')!, { tooltip: 'Your name', required: true, maxLen: 40 });
    deleteField(r, f.find((x) => x.name === 'Sig')!);
    r = reload(r);
    const nm = readFields(r).find((x) => x.name === 'Name')!;
    expect([nm.tooltip, nm.required, nm.maxLen]).toEqual(['Your name', true, 40]);
    expect(readFields(r).some((x) => x.name === 'Sig')).toBe(false);
    setFieldValue(r, nm, 'Flat');
    const n = flattenForm(r);
    expect(n).toBeGreaterThan(0);
    r = reload(r);
    expect(readFields(r)).toEqual([]);
  });
  it('detects blanks from text', () => {
    const specs = detectFieldsFromText([{ text: 'Name: ____________', box: [72, 700, 250, 712] }, { text: 'Date ________', box: [72, 680, 200, 692] }], []);
    expect(specs.length).toBeGreaterThanOrEqual(1);
    expect(specs[0].type).toBe('text');
  });
});

describe('pages', () => {
  it('rotates, deletes, moves, duplicates, inserts, reverses', () => {
    let d = sample();
    rotatePages(d, [2], 90);
    insertBlankPages(d, 1, 2, [100, 200]);
    expect(d.pageCount).toBe(5);
    duplicatePages(d, [0]);
    expect(d.pageCount).toBe(6);
    deletePages(d, [1, 2]);
    expect(d.pageCount).toBe(4);
    movePages(d, [3], 0);
    d = reload(d);
    expect(d.pages[0].rotate).toBe(90);
    reversePages(d);
    setPageOrder(d, [1, 0, 2, 3]);
    d = reload(d);
    expect(d.pageCount).toBe(4);
  });
  it('imports, extracts and splits', () => {
    const a = sample();
    const b = PdfDocument.create();
    addTextPages(b, 'Imported page text', { title: 'B' });
    addNote(b, b.pages[0], 50, 50, { contents: 'kept' });
    importPages(b, a, [0], 1, { keepAnnots: true });
    const r = reload(a);
    expect(r.pageCount).toBe(4);
    expect(pageText(r, 1)).toContain('Imported');
    expect(pageAnnotations(r, r.pages[1]).some((x) => x.contents === 'kept')).toBe(true);
    const ex = reload(extractPages(r, [1, 3]));
    expect(ex.pageCount).toBe(2);
    expect(parseRanges('1-2, 4', 4)).toEqual([0, 1, 3]);
    expect(splitDocument(r, { kind: 'every', n: 3 }).map((p) => p.doc.pageCount)).toEqual([3, 1]);
    expect(splitDocument(r, { kind: 'ranges', ranges: '1-2; 3-4' }).length).toBe(2);
    expect(splitDocument(r, { kind: 'size', maxBytes: 10 }).length).toBeGreaterThanOrEqual(1);
  });
  it('crops, scales, marks and imposes', () => {
    const d = sample();
    cropPages(d, [0], { left: 10, top: 10, right: 10, bottom: 10 });
    scalePages(d, [1], { paper: PAPER.a5 });
    addWatermark(d, [0, 1, 2], 'DRAFT', { opacity: 0.3 });
    addBates(d, [0, 1, 2], { prefix: 'X', start: 7, digits: 4, position: 'bottom-right' });
    addOverlayText(d, [0], { text: 'Page {page} of {pages}', position: 'top-center' });
    const r = reload(d);
    expect(r.pages[0].cropBox).toEqual([10, 10, 602, 782]);
    expect(Math.round(r.pages[1].width)).toBe(Math.round(PAPER.a5[0]));
    expect(pageText(r, 1)).toContain('X0008');
    expect(pageText(r, 0)).toContain('Page 1 of 3');
    const n = reload(nUp(r, { cols: 2, rows: 1, paper: [PAPER.letter[1], PAPER.letter[0]] }));
    expect(n.pageCount).toBe(2);
    const bk = reload(booklet(r));
    expect(bk.pageCount).toBe(2);
  });
});

describe('text extraction and editing', () => {
  it('extracts text, runs, markdown and tables', () => {
    const d = sample();
    expect(pageText(d, 0)).toContain('Alpha beta gamma delta.');
    const runs = pageTextRuns(d, 0);
    expect(runs.length).toBeGreaterThan(3);
    const md = textToMarkdown([runs]);
    expect(md).toMatch(/^#+ Title One/m);
    const t = PdfDocument.create();
    const p = addBlankPage(t);
    const rows = [['Item', 'Qty', 'Price'], ['Apple', '3', '1.20'], ['Pear', '5', '2.50']];
    rows.forEach((r, i) => r.forEach((c, j) => insertText(t, p, 72 + j * 120, 700 - i * 20, c, { size: 11 })));
    const tables = tablesFromRuns(pageTextRuns(t, 0));
    expect(tables.length).toBe(1);
    expect(tables[0][1]).toEqual(['Apple', '3', '1.20']);
    expect(toCsv(tables[0]).split('\n')[0]).toBe('"Item","Qty","Price"');
  });
  it('replaces run text in a simple font, erases and inserts', () => {
    const d = sample();
    const p = d.pages[0];
    const run = pageRuns(d, p).find((r) => /Alpha/.test(r.text))!;
    expect(run.editable).toBe(true);
    const res = replaceRunText(d, p, run, 'Omega beta gamma delta.');
    expect(res.mode).toBe('reencoded');
    let r = reload(d);
    expect(pageText(r, 0)).toContain('Omega beta');
    const run2 = pageRuns(r, r.pages[0]).find((x) => /Second/.test(x.text))!;
    const n = eraseArea(r, r.pages[0], run2.box);
    expect(n).toBeGreaterThan(0);
    insertText(r, r.pages[0], 72, 300, 'Inserted line', { font: 'Courier', size: 10 });
    r = reload(r);
    expect(pageText(r, 0)).not.toContain('Second paragraph');
    expect(pageText(r, 0)).toContain('Inserted line');
  });
});

describe('optimize and checks', () => {
  it('lists fonts and stats, finds hidden information, sanitizes', () => {
    const d = sample();
    addNote(d, d.pages[0], 10, 10, { contents: 'secret', author: 'Ann' });
    addAttachment(d, 'a.txt', bytes('x'));
    writeMetadata(d, { title: 'T', author: 'Ann' });
    const r = reload(d, true);
    expect(listFonts(r).some((f) => f.name.includes('Helvetica'))).toBe(true);
    expect(stats(r, 'one two three').words).toBe(3);
    const kinds = hiddenInformation(r).items.map((i) => i.kind);
    expect(kinds).toContain('Attachments');
    expect(kinds).toContain('Comments and markup');
    const done = sanitize(r, { attachments: true, comments: true, metadata: true });
    expect(done.length).toBeGreaterThanOrEqual(2);
    const s = reload(r);
    expect(readAttachments(s)).toEqual([]);
    expect(pageAnnotations(s, s.pages[0]).filter((a) => a.subtype === 'Text')).toEqual([]);
  });
  it('archival and accessibility checks and the fixer', () => {
    const d = sample();
    expect(archivalCheck(d).some((i) => i.level === 'error')).toBe(true);
    const before = accessibilityCheck(d, ['text', '', '']);
    expect(before.some((i) => /language/i.test(i.text))).toBe(true);
    const done = accessibilityFix(d, { title: 'Fixed', language: 'en' });
    expect(done).toContain('language');
    const after = accessibilityCheck(reload(d));
    expect(after.some((i) => /No document language/.test(i.text))).toBe(false);
  });
});

describe('repair', () => {
  const good = () => { const d = sample(); writeOutlines(d, [{ title: 'Top', page: 0 }]); return d.save({ incremental: false }); };
  const damage = (fn: (s: string) => string) => latinBytes(fn(latin(good())));
  const cases: [string, (s: string) => string][] = [
    ['truncated file', (s) => s.slice(0, Math.floor(s.length * 0.8))],
    ['zeroed xref offsets', (s) => s.replace(/(\d{10}) (\d{5}) n/g, '0000000000 $2 n')],
    ['no trailer or xref', (s) => s.slice(0, s.lastIndexOf('xref'))],
    ['garbage prefix', (s) => 'JUNKJUNKJUNK'.repeat(50) + s],
    ['garbage suffix and no EOF', (s) => s.replace('%%EOF', '') + '\0'.repeat(300)],
    ['missing header', (s) => s.replace('%PDF-1.7', '')],
    ['wrong stream lengths', (s) => s.replace(/\/Length (\d+)/g, '/Length 1')],
    ['deleted pages object', (s) => s.replace(/<<\s*\/Type \/Pages[^>]*>>/, '<< >>')],
  ];
  for (const [name, fn] of cases) {
    it(`recovers pages from a file with ${name}`, () => {
      const r = repairPdf(damage(fn), 'damaged.pdf');
      expect(r.doc, r.summary).toBeTruthy();
      expect(r.doc!.pageCount, r.summary).toBeGreaterThanOrEqual(2);
      expect(r.methods.some((m) => m.status === 'success' || m.status === 'partial')).toBe(true);
      const re = PdfDocument.load(r.bytes!);
      expect(re.pageCount).toBe(r.doc!.pageCount);
      expect(pageText(re, 0)).toContain('Alpha');
    });
  }
  it('reports what was lost and rebuilt', () => {
    const r = repairPdf(damage((s) => s.slice(0, s.lastIndexOf('xref'))), 'x.pdf');
    expect(r.rebuilt.length).toBeGreaterThan(0);
    expect(r.identification.description.toLowerCase()).toContain('pdf');
  });
  it('salvages text from a hopeless file', () => {
    const r = repairPdf(bytes('nothing to see here, just text words words words'), 'junk.pdf');
    expect(r.textOnly).toBe(true);
    expect(r.doc).toBeTruthy();
    expect(pageText(r.doc!, 0)).toContain('words');
  });
  it('corrupt flate streams keep the rest of the page', () => {
    const src = good();
    const s = latin(src);
    const i = s.indexOf('stream\n', s.indexOf('/FlateDecode')) + 7;
    const arr = src.slice();
    for (let k = i + 20; k < i + 40; k++) arr[k] = 0;
    const r = repairPdf(arr, 'flate.pdf');
    expect(r.doc).toBeTruthy();
    expect(r.doc!.pageCount).toBe(3);
  });
});

describe('lexer helpers', () => {
  it('finds markers', () => {
    const b = bytes('abc %PDF-1.4 def');
    expect(Lexer.find(b, '%PDF-', 0)).toBe(4);
  });
});
