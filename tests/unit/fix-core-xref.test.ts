import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, PdfStream, Ref, bytesOf, cloneObj, latin1 } from '../../src/pdf/objects';
import { addTextPage, makeTextPdf } from '../../src/pdf/build';
import { parseXref, scanObjectHeaders } from '../../src/pdf/xref';
import { onePage, rawPdf, runsOf, stream } from './fix-core-helpers';

/** Where the last classic table starts ("xref" at the start of a line, not the one inside "startxref"). */
const tableAt = (s: string): number => s.lastIndexOf('\nxref\n') + 1;

describe('large documents (finding 3)', () => {
  it('opens a file with 130,000 objects', () => {
    const objs = onePage();
    for (let i = 4; i < 130000; i++) objs[i] = 'null';
    const d = PdfDocument.load(rawPdf(objs, '/Root 1 0 R'));
    expect(d.pageCount).toBe(1);
    expect(d.report.reconstructed).toBe(false);
    expect(d.size).toBe(130000);
  }, 60000);
  it('rewrites a document that holds one array of 150,000 numbers', () => {
    const d = PdfDocument.load(rawPdf(onePage({ 4: '[' + '0 '.repeat(150000) + ']' }, '', '/Big 4 0 R'), '/Root 1 0 R'));
    const back = PdfDocument.load(d.save({ incremental: false }));
    expect(back.getArray(back.catalog, 'Big')!.length).toBe(150000);
  }, 60000);
});

describe('deleted objects and free entries (finding 17, lower-priority list)', () => {
  const pdf = () => rawPdf(onePage({ 4: '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] /Contents (secret note) >>' }, '/Annots [4 0 R]'), '/Root 1 0 R');
  it('an object deleted by an update stays deleted when the file is read again', () => {
    const doc = PdfDocument.load(pdf());
    doc.remove(new Ref(4, 0));
    const back = PdfDocument.load(doc.save({ incremental: true }));
    expect(back.report.reconstructed).toBe(false);
    expect(back.resolve(new Ref(4, 0))).toBeNull();
    expect(back.objectNumbers()).not.toContain(4);
    expect(back.pageCount).toBe(1);
  });
  it('an appended table starts with object 0 and links the free list', () => {
    const doc = PdfDocument.load(pdf());
    doc.remove(new Ref(4, 0));
    const out = latin1(doc.save({ incremental: true }));
    const table = out.slice(tableAt(out));
    expect(table).toMatch(/^xref\n0 1\n0000000004 65535 f \n/); // object 0 heads the list: next free is 4
    expect(table).toMatch(/\n4 \d+\n0000000000 00001 f \n/); // 4 ends it, generation raised
  });
  it('an update with nothing deleted still starts its table at object 0', () => {
    const doc = PdfDocument.load(makeTextPdf(['One']));
    addTextPage(doc, 'Two');
    const out = latin1(doc.save({ incremental: true }));
    expect(out.slice(tableAt(out))).toMatch(/^xref\n0 \d+\n0000000000 65535 f \n/);
  });
  it('cross-reference streams give object 0 generation 65535, in full and in appended sections', () => {
    const full = PdfDocument.load(makeTextPdf(['One'])).save({ incremental: false, objectStreams: true });
    const a = PdfDocument.load(full);
    const xs = a.resolve<PdfStream>(new Ref(a.size - 1, 0));
    expect(a.getName(xs, 'Type')).toBe('XRef');
    expect(Array.from(a.decoded(xs).subarray(0, 7))).toEqual([0, 0, 0, 0, 0, 255, 255]);
    const gone = a.pages[0].ref!.num;
    a.remove(new Ref(gone, 0)); // only to produce a free entry
    const inc = a.save({ incremental: true });
    const r = parseXref(inc);
    expect(r.usesXrefStream).toBe(true);
    expect(r.entries.has(gone)).toBe(false);
    // The appended section lists object 0 as the head of the free list, pointing at the deleted object.
    const b = PdfDocument.load(inc);
    const upd = b.resolve<PdfStream>(new Ref(b.size - 1, 0));
    expect(b.getArray(upd, 'Index')!.slice(0, 2)).toEqual([0, 1]);
    const row = Array.from(b.decoded(upd).subarray(0, 7));
    expect(row[0]).toBe(0);
    expect((row[1] << 24) | (row[2] << 16) | (row[3] << 8) | row[4]).toBe(gone);
    expect([row[5], row[6]]).toEqual([255, 255]);
  });
  it('a hybrid file: objects the table lists as free are found through /XRefStm', () => {
    // Object 4 lives in an object stream (5); the table marks 4 free and names the xref stream (6).
    const objStm = stream('/Type /ObjStm /N 1 /First 4', '4 0 << /Title (From the stream) >>');
    const head = '%PDF-1.5\n%\xe2\xe3\xcf\xd3\n';
    const bodies: Record<number, string> = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>', 5: objStm };
    let s = head; const off: Record<number, number> = {};
    for (const n of [1, 2, 3, 5]) { off[n] = s.length; s += `${n} 0 obj\n${bodies[n]}\nendobj\n`; }
    const xsOff = s.length;
    const row = (t: number, a: number, b: number) => String.fromCharCode(t, (a >> 8) & 255, a & 255, b);
    const xdata = row(2, 5, 0);
    s += `6 0 obj\n<< /Type /XRef /Size 7 /W [1 2 1] /Index [4 1] /Length ${xdata.length} >>\nstream\n${xdata}\nendstream\nendobj\n`;
    const xref = s.length;
    const e = (n: number) => `${String(off[n]).padStart(10, '0')} 00000 n \n`;
    s += `xref\n0 6\n0000000004 65535 f \n${e(1)}${e(2)}${e(3)}0000000000 00001 f \n${e(5)}trailer\n<< /Size 7 /Root 1 0 R /Info 4 0 R /XRefStm ${xsOff} >>\nstartxref\n${xref}\n%%EOF\n`;
    const d = PdfDocument.load(bytesOf(s));
    expect(d.report.reconstructed).toBe(false);
    expect(d.title).toBe('From the stream');
  });
});

describe('incremental updates point at a real section (finding 11)', () => {
  it('a rebuilt document is written in full even when an update is asked for', () => {
    const good = latin1(makeTextPdf(['One']));
    const doc = PdfDocument.load(bytesOf(good.slice(0, tableAt(good)))); // table and trailer lost
    expect(doc.report.reconstructed).toBe(true);
    addTextPage(doc, 'Two');
    const out = doc.save({ incremental: true });
    const back = PdfDocument.load(out);
    expect(back.report.reconstructed).toBe(false);
    expect(back.report.warnings).toEqual([]);
    expect(back.pageCount).toBe(2);
  });
  it('a new document is written in full even when an update is asked for', () => {
    const d = PdfDocument.create();
    addTextPage(d, 'One');
    expect(latin1(d.save({ incremental: true }), 0, 5)).toBe('%PDF-');
  });
  it('/Prev names where the table is, not the wrong number after startxref', () => {
    const good = latin1(makeTextPdf(['One']));
    const real = +/startxref\n(\d+)/.exec(good)![1];
    const doc = PdfDocument.load(bytesOf(good.replace(/startxref\n\d+/, `startxref\n${real + 7}`)));
    expect(doc.report.reconstructed).toBe(false);
    expect(doc.startxref).toBe(real);
    addTextPage(doc, 'Two');
    const out = latin1(doc.save({ incremental: true }));
    expect(out.slice(out.lastIndexOf('trailer'))).toContain(`/Prev ${real}`);
  });
  it('"xref" inside "startxref" is not taken for a table', () => {
    const good = latin1(makeTextPdf(['One']));
    // startxref points just before the keyword "startxref" itself.
    const at = good.lastIndexOf('startxref');
    const d = PdfDocument.load(bytesOf(good.replace(/startxref\n\d+/, `startxref\n${at - 20}`)));
    expect(d.pageCount).toBe(1);
  });
});

describe('damaged and hostile structure (findings 19, 20; contract C7)', () => {
  it('a stream whose /Length points at itself is read once, by its endstream', () => {
    const big = 'x'.repeat(2_000_000);
    const pdf = rawPdf(onePage({ 4: `<< /Length 4 0 R >>\nstream\n${big}\nendstream` }, '/Contents 4 0 R'), '/Root 1 0 R');
    const t0 = Date.now();
    const doc = PdfDocument.load(pdf);
    expect(doc.pageContent(doc.pages[0]).length).toBe(big.length + 1);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 60000);
  it('two streams whose lengths point at each other both load', () => {
    const pdf = rawPdf(onePage({ 4: '<< /Length 5 0 R >>\nstream\nBT (a) Tj ET\nendstream', 5: '<< /Length 4 0 R >>\nstream\nBT (b) Tj ET\nendstream' }, '/Contents [4 0 R 5 0 R]'), '/Root 1 0 R');
    const doc = PdfDocument.load(pdf);
    expect(latin1(doc.pageContent(doc.pages[0]))).toBe('BT (a) Tj ET\nBT (b) Tj ET\n');
  });
  it('objects the table misplaces are all found with one scan', () => {
    const objs = onePage({ 4: '(filler 4)', 5: stream('', 'BT /F1 12 Tf 72 700 Td (found) Tj ET'), 6: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' }, '/Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >>');
    for (let i = 7; i < 40; i++) objs[i] = `(filler ${i})`;
    const good = latin1(rawPdf(objs, '/Root 1 0 R'));
    // Shift the offsets of objects 5 and 6 in the table so they point into other objects (the quick check
    // of the table when the file is opened samples every third entry, and misses these two).
    const lines = good.slice(tableAt(good)).split('\n');
    for (const n of [5, 6]) lines[2 + n] = String(+lines[2 + n].slice(0, 10) + 3).padStart(10, '0') + lines[2 + n].slice(10);
    const doc = PdfDocument.load(bytesOf(good.slice(0, tableAt(good)) + lines.join('\n')));
    expect(doc.report.reconstructed).toBe(false);
    expect(runsOf(doc)[0].text).toBe('found');
    expect(doc.report.warnings.filter((w) => /found by searching/.test(w)).length).toBe(2);
  });
  it('scanObjectHeaders finds headers without reading digits twice', () => {
    const b = bytesOf('junk 12 0 obj\n<<>>\nendobj\n' + '9'.repeat(200000) + '\n7 3 obj null endobj xobj 1 0 objx');
    expect(scanObjectHeaders(b).map((h) => [h.num, h.gen])).toEqual([[12, 0], [7, 3]]);
  });
  it('a root that is not a catalog: the catalog is found by scanning, or the load says why not', () => {
    // The trailer names an integer as the root, and a real catalog exists elsewhere.
    const a = PdfDocument.load(rawPdf({ 1: '42', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>', 4: '<< /Type /Catalog /Pages 2 0 R >>' }, '/Root 1 0 R'));
    expect(a.pageCount).toBe(1);
    // No catalog at all, but a page tree: a catalog is built around it.
    const b = PdfDocument.load(rawPdf({ 1: '42', 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>' }, '/Root 1 0 R'));
    expect(b.pageCount).toBe(1);
    // Nothing usable: the document that comes back still has a catalog (and no pages) rather than throwing later.
    const c = PdfDocument.load(rawPdf({ 1: '42', 2: '(nothing)' }, '/Root 1 0 R'));
    expect(() => c.catalog).not.toThrow();
    expect(c.pageCount).toBe(0);
  });
  it('objects made while rebuilding do not take the numbers of objects in the file', () => {
    // No catalog and no page tree: the page (object 1) is collected, and the new Pages/Catalog must not become objects 1 and 2.
    const s = '%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [0 0 100 100] /Contents 2 0 R >>\nendobj\n2 0 obj\n<< /Length 12 >>\nstream\nBT (p) Tj ET\nendstream\nendobj\n';
    const d = PdfDocument.load(bytesOf(s));
    expect(d.pageCount).toBe(1);
    expect(latin1(d.pageContent(d.pages[0]))).toContain('(p) Tj');
  });
  it('a later object stream beats an earlier top-level definition when the table is rebuilt', () => {
    const stm = stream('/Type /ObjStm /N 1 /First 4', '4 0 << /Title (new) >>');
    const pdf = rawPdf(onePage({ 4: '<< /Title (old) >>', 5: stm }), '/Root 1 0 R /Info 4 0 R');
    expect(PdfDocument.load(pdf).title).toBe('old'); // by its table, the file still says 4 is top-level
    expect(PdfDocument.load(pdf, { repair: true }).title).toBe('new');
  });
});

describe('page tree (lower-priority list)', () => {
  it('walks a tree deeper than 64 levels', () => {
    const objs: Record<number, string> = { 1: '<< /Type /Catalog /Pages 2 0 R >>' };
    const depth = 200;
    for (let i = 0; i < depth; i++) objs[2 + i] = `<< /Type /Pages /Kids [${3 + i} 0 R] /Count 1 ${i ? `/Parent ${1 + i} 0 R` : '/MediaBox [0 0 300 400]'} >>`;
    objs[2 + depth] = `<< /Type /Page /Parent ${1 + depth} 0 R >>`;
    const d = PdfDocument.load(rawPdf(objs, '/Root 1 0 R'));
    expect(d.pageCount).toBe(1);
    expect(d.pages[0].mediaBox).toEqual([0, 0, 300, 400]);
  });
  it('keeps document order and survives a cycle', () => {
    const objs = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R 6 0 R 2 0 R] /Count 4 >>', 3: '<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R 3 0 R] /Count 2 >>', 4: '<< /Type /Page /Parent 3 0 R /N 1 >>', 5: '<< /Type /Page /Parent 3 0 R /N 2 >>', 6: '<< /Type /Page /Parent 2 0 R /N 3 >>' };
    expect(PdfDocument.load(rawPdf(objs, '/Root 1 0 R')).pages.map((p) => p.dict.get('N'))).toEqual([1, 2, 3]);
  });
  it('a catalog held directly in the trailer becomes one object, once', () => {
    const d = PdfDocument.load(makeTextPdf(['One']));
    d.trailer.set('Root', d.catalog.clone()); // a direct dictionary where a reference belongs
    const before = d.size;
    const r1 = d.catalogRef, r2 = d.catalogRef;
    expect(r1.num).toBe(r2.num);
    expect(d.size).toBe(before + 1);
    expect(d.trailer.get('Root')).toBeInstanceOf(Ref);
    expect(PdfDocument.load(d.save({ incremental: false })).pageCount).toBe(1);
  });
});

describe('full rewrites (lower-priority list)', () => {
  it('the header admits what the file uses', () => {
    const src = rawPdf(onePage(), '/Root 1 0 R', { header: '1.3' });
    const d = PdfDocument.load(src);
    expect(latin1(d.save({ incremental: false }), 0, 8)).toBe('%PDF-1.4');
    expect(latin1(d.save({ incremental: false, objectStreams: true }), 0, 8)).toBe('%PDF-1.5');
    expect(latin1(d.save({ incremental: false, version: '1.4', objectStreams: true }), 0, 8)).toBe('%PDF-1.4'); // a caller's choice is kept
    const enc = d.save({ incremental: false, encrypt: { userPassword: '', ownerPassword: 'o', permissions: {} } });
    expect(latin1(enc, 0, 8)).toBe('%PDF-1.7');
    const back = PdfDocument.load(enc);
    const adbe = back.getDict(back.getDict(back.catalog, 'Extensions'), 'ADBE')!;
    expect([back.getName(adbe, 'BaseVersion'), back.getNum(adbe, 'ExtensionLevel')]).toEqual(['1.7', 8]);
    expect(d.catalog.has('Extensions')).toBe(false); // the document in memory is not changed by saving
  });
  it('leaves no gaps in the numbering when old xref and object streams are dropped', () => {
    const packed = PdfDocument.load(makeTextPdf(['One', 'Two'])).save({ incremental: false, objectStreams: true });
    const out = latin1(PdfDocument.load(packed).save({ incremental: false, keepUnused: true }));
    const table = out.slice(tableAt(out), out.lastIndexOf('trailer'));
    expect(table.match(/ f \n/g)!.length).toBe(1); // only object 0
  });
  it('an undo snapshot shares stream bytes with the document', () => {
    const d = PdfDocument.load(makeTextPdf(['One']));
    addTextPage(d, 'Two');
    for (const [, v] of d.changed) if (v instanceof PdfStream) expect((cloneObj(v) as PdfStream).raw).toBe(v.raw);
    expect([...d.changed.values()].some((v) => v instanceof PdfStream)).toBe(true);
  });
});

describe('trailer /Size and new object numbers', () => {
  it('a missing /Size does not make new objects collide with old ones', () => {
    const good = latin1(rawPdf(onePage({ 9: '(nine)' }), '/Root 1 0 R')).replace(/\/Size \d+ /, '');
    const d = PdfDocument.load(bytesOf(good));
    expect(d.register(new Dict()).num).toBe(10);
  });
});
