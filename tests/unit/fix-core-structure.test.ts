import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, PdfString, Ref, bytesOf, cloneObj, latin1 } from '../../src/pdf/objects';
import { addBlankPage, addImagePage, ensureFont, makeTextPdf } from '../../src/pdf/build';
import { addAnnotation, addAttachment, lookupName, outlinesToInput, pageAnnotations, readAttachments, readLayers, readMetadata, readOutlines, readSignatures, removeAnnotation, removeAttachment, resolveDest, setLayerVisible, writeMetadata, writeOutlines } from '../../src/pdf/structure';
import { serialize } from '../../src/pdf/writer';
import { onePage, rawPdf, stream } from './fix-core-helpers';

describe('changes reached through a reference are written (finding 7)', () => {
  it('an attachment added to a document whose /Names is its own object survives an incremental save', () => {
    const doc = PdfDocument.load(rawPdf(onePage({ 4: '<< /Dests << /Names [(a) [3 0 R /Fit]] >> >>' }, '', '/Names 4 0 R'), '/Root 1 0 R'));
    addAttachment(doc, 'note.txt', bytesOf('hello'), { mime: 'text/plain' });
    const back = PdfDocument.load(doc.save({ incremental: true }));
    expect(readAttachments(back).map((a) => [a.name, a.mime])).toEqual([['note.txt', 'text/plain']]);
    expect(resolveDest(back, new PdfString(bytesOf('a')))?.page).toBe(0); // the other tree in /Names is untouched
    // and removing it again is written too
    removeAttachment(back, readAttachments(back)[0]);
    expect(readAttachments(PdfDocument.load(back.save({ incremental: true })))).toEqual([]);
  });
  it('a layer switched off stays off when /D is its own object', () => {
    const cat = '/OCProperties << /OCGs [4 0 R] /D 5 0 R >>';
    const doc = PdfDocument.load(rawPdf(onePage({ 4: '<< /Type /OCG /Name (L1) >>', 5: '<< /Order [4 0 R] /ON [4 0 R] >>' }, '', cat), '/Root 1 0 R'));
    setLayerVisible(doc, readLayers(doc)[0], false);
    const back = PdfDocument.load(doc.save({ incremental: true }));
    expect(readLayers(back)[0].on).toBe(false);
    expect(back.getArray(back.getDict(back.getDict(back.catalog, 'OCProperties'), 'D'), 'ON')).toEqual([]); // not listed as on and off at once
  });
});

describe('attachments and name trees (lower-priority list)', () => {
  it('writes the MIME type as the name itself, escaped once', () => {
    const doc = PdfDocument.load(makeTextPdf(['x']));
    addAttachment(doc, 'a.txt', bytesOf('hello'), { mime: 'text/plain' });
    const out = latin1(doc.save({ incremental: false }));
    expect(out).toContain('/Subtype/text#2Fplain');
    expect(out).not.toContain('#232F');
    expect(readAttachments(PdfDocument.load(bytesOf(out)))[0].mime).toBe('text/plain');
  });
  it('keeps the bytes of existing keys and sorts by bytes', () => {
    const key = (s: string) => serialize(new PdfString(bytesOf(s), true));
    const names = `[${latin1(key('b\x80'))} 5 0 R ${latin1(key('Zed'))} 5 0 R]`;
    const doc = PdfDocument.load(rawPdf(onePage({ 4: `<< /Names ${names} >>`, 5: '<< /Type /Filespec /F (old) >>' }, '', '/Names << /EmbeddedFiles 4 0 R >>'), '/Root 1 0 R'));
    addAttachment(doc, 'a.txt', bytesOf('x'));
    const back = PdfDocument.load(doc.save({ incremental: true }));
    const arr = back.getArray(back.getDict(back.getDict(back.catalog, 'Names'), 'EmbeddedFiles'), 'Names')!;
    expect(arr.filter((x): x is PdfString => x instanceof PdfString).map((k) => k.toLatin1())).toEqual(['Zed', 'a.txt', 'b\x80']);
  });
  it('looks a name up through /Limits, and still finds it when the limits are wrong', () => {
    const tree = (limits: string) => rawPdf(onePage({
      4: '<< /Kids [5 0 R 6 0 R] >>',
      5: '<< /Limits [(a) (m)] /Names [(alpha) [3 0 R /Fit] (mid) [3 0 R /FitH 10]] >>',
      6: `<< /Limits ${limits} /Names [(zulu) [3 0 R /FitH 99]] >>`,
    }, '', '/Names << /Dests 4 0 R >>'), '/Root 1 0 R');
    for (const limits of ['[(n) (zz)]', '[(a) (b)]']) {
      const doc = PdfDocument.load(tree(limits));
      expect(resolveDest(doc, new PdfString(bytesOf('zulu')))?.y, limits).toBe(99);
      expect(resolveDest(doc, new PdfString(bytesOf('mid')))?.y, limits).toBe(10);
      expect(lookupName(doc, 'Dests', 'nothing'), limits).toBeNull();
    }
  });
});

describe('outlines (finding 14)', () => {
  const pdf = () => rawPdf({
    1: '<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R /PageMode /UseThumbs >>', 2: '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>', 8: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
    4: '<< /Type /Outlines /First 5 0 R /Last 7 0 R /Count 3 >>',
    5: '<< /Title (Styled) /Parent 4 0 R /Next 6 0 R /Dest [8 0 R /FitH 50] /C [1 0 0] /F 2 /SE 9 0 R >>',
    6: '<< /Title (Other file) /Parent 4 0 R /Prev 5 0 R /Next 7 0 R /A << /S /GoToR /F (other.pdf) /D [3 /Fit] >> >>',
    7: '<< /Title (Script) /Parent 4 0 R /Prev 6 0 R /A << /S /JavaScript /JS (app.alert\\(1\\)) >> >>',
    9: '<< /Type /StructElem /S /H1 >>',
  }, '/Root 1 0 R');
  const items = (d: PdfDocument) => { const out: Dict[] = []; let cur = d.getDict(d.getDict(d.catalog, 'Outlines'), 'First'); while (cur) { out.push(cur); cur = d.getDict(cur, 'Next'); } return out; };
  it('adding a bookmark leaves the others as they were: fit mode, colour, style, actions', () => {
    const doc = PdfDocument.load(pdf());
    const input = outlinesToInput(readOutlines(doc));
    input.push({ title: 'New', page: 0 });
    writeOutlines(doc, input);
    const back = PdfDocument.load(doc.save({ incremental: true }));
    const [styled, other, script, added] = items(back);
    expect(latin1(serialize(styled.get('Dest')!))).toMatch(/^\[\d+ 0 R \/FitH 50\]$/);
    expect(latin1(serialize(styled.get('C')!))).toBe('[1 0 0]');
    expect(styled.get('F')).toBe(2);
    expect(styled.get('SE')).toBeInstanceOf(Ref);
    expect(back.getName(back.getDict(other, 'A'), 'S')).toBe('GoToR');
    expect(other.has('Dest')).toBe(false);
    expect(back.getName(back.getDict(script, 'A'), 'S')).toBe('JavaScript');
    expect(back.getText(added, 'Title')).toBe('New');
    expect(readOutlines(back).map((o) => [o.title, o.bold === true, o.dest?.kind])).toEqual([['Styled', true, 'FitH'], ['Other file', false, undefined], ['Script', false, undefined], ['New', false, 'XYZ']]);
    expect(back.getName(back.catalog, 'PageMode')).toBe('UseThumbs'); // the document's own choice is kept
  });
  it('a bookmark whose page or address is changed gets a new destination', () => {
    const doc = PdfDocument.load(pdf());
    const input = outlinesToInput(readOutlines(doc));
    input[0].page = 0; input[1].url = 'https://example.com/';
    writeOutlines(doc, input);
    const [moved, link] = readOutlines(doc);
    expect([moved.dest?.page, moved.dest?.kind, moved.bold]).toEqual([0, 'XYZ', true]);
    expect(link.url).toBe('https://example.com/');
  });
  it('/Count is the number of items shown: a closed item hides its children from its ancestors', () => {
    const doc = PdfDocument.load(makeTextPdf(['One', 'Two']));
    writeOutlines(doc, [{ title: 'A', page: 0, open: false, children: [{ title: 'A1', page: 0 }, { title: 'A2', page: 1 }] }, { title: 'B', page: 1, children: [{ title: 'B1', page: 1 }] }]);
    const root = doc.getDict(doc.catalog, 'Outlines')!;
    const [a, b] = items(doc);
    expect([doc.getNum(a, 'Count'), doc.getNum(b, 'Count'), doc.getNum(root, 'Count')]).toEqual([-2, 1, 3]);
    expect(doc.getName(doc.catalog, 'PageMode')).toBe('UseOutlines');
    writeOutlines(doc, []);
    expect(doc.catalog.has('Outlines')).toBe(false);
    expect(doc.catalog.has('PageMode')).toBe(false);
  });
});

describe('metadata (lower-priority list)', () => {
  const xmp = (date: string) => `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Producer="Old producer"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old title</rdf:li></rdf:Alt></dc:title><xmp:CreateDate>${date}</xmp:CreateDate><dc:rights><rdf:Alt><rdf:li xml:lang="x-default">All mine</rdf:li></rdf:Alt></dc:rights></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const load = (date: string) => PdfDocument.load(rawPdf(onePage({ 4: stream('/Type /Metadata /Subtype /XML', xmp(date)) }, '', '/Metadata 4 0 R'), '/Root 1 0 R'));
  it('keeps the rest of an existing XMP packet', () => {
    const doc = load('2020-05-06T07:08:09Z');
    writeMetadata(doc, { title: 'New & improved', author: 'Anne' });
    const out = readMetadata(PdfDocument.load(doc.save({ incremental: true })));
    expect(out.xmp).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(out.xmp).toContain('All mine');
    expect(out.xmp).toContain('New &amp; improved');
    expect(out.xmp).not.toContain('Old title');
    expect(out.xmp).not.toContain('Old producer');
    expect(out.xmp).toContain('<xmp:CreateDate>2020-05-06T07:08:09.000Z</xmp:CreateDate>');
    expect(out.xmp.match(/<dc:title>/g)!.length).toBe(1);
    expect(out.title).toBe('New & improved');
  });
  it('writing twice does not pile up descriptions', () => {
    const doc = load('2020-05-06T07:08:09Z');
    writeMetadata(doc, { title: 'One' }); writeMetadata(doc, { title: 'Two' }); writeMetadata(doc, { title: 'Three' });
    const x = readMetadata(doc).xmp;
    expect(x.match(/<rdf:Description/g)!.length).toBe(3);
    expect(x.match(/<dc:title>/g)!.length).toBe(1);
  });
  it('a creation date that does not parse is no date, and not an exception', () => {
    const doc = load('not a date');
    expect(readMetadata(doc).created).toBeNull();
    expect(() => writeMetadata(doc, { title: 'T' })).not.toThrow();
    const x = readMetadata(doc).xmp;
    expect(x.match(/<xmp:CreateDate>/g)!.length).toBe(1); // the unreadable one is kept, and no made-up date is added
    expect(x).toContain('<xmp:CreateDate>not a date</xmp:CreateDate>');
    expect(x).not.toContain('<dc:creator>'); // nothing is written for a value that is empty
  });
  it('a title that is cleared does not come back from the old packet', () => {
    const doc = load('2020-05-06T07:08:09Z');
    writeMetadata(doc, { title: '' });
    expect(readMetadata(doc).title).toBe('');
  });
});

describe('annotations and signatures', () => {
  it('removing a note removes replies to its replies as well', () => {
    const doc = PdfDocument.load(makeTextPdf(['x']));
    const p = doc.pages[0];
    const note = addAnnotation(doc, p, new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Text'), Rect: [0, 0, 10, 10] }));
    const reply = addAnnotation(doc, doc.pages[0], new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Text'), Rect: [0, 0, 10, 10], IRT: note }));
    addAnnotation(doc, doc.pages[0], new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Text'), Rect: [0, 0, 10, 10], IRT: reply }));
    addAnnotation(doc, doc.pages[0], new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Popup'), Rect: [0, 0, 10, 10], Parent: reply }));
    const other = addAnnotation(doc, doc.pages[0], new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Text'), Rect: [0, 0, 10, 10] }));
    removeAnnotation(doc, doc.pages[0], note);
    expect(pageAnnotations(doc, doc.pages[0]).map((a) => a.ref!.num)).toEqual([other.num]);
  });
  it('reports whether a signature covers the file from byte 0 and leaves out only its own /Contents', () => {
    const num = (n: number) => String(n).padStart(10, '0');
    const build = (contents: string, tweak = (s: string) => s) => {
      const objs = onePage({ 4: '<< /FT /Sig /T (Sig1) /Subtype /Widget /Rect [0 0 0 0] /V 5 0 R >>', 5: `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [AAAAAAAAAA BBBBBBBBBB CCCCCCCCCC DDDDDDDDDD] /Contents ${contents} >>` }, '/Annots [4 0 R]', '/AcroForm << /Fields [4 0 R] >>');
      let s = latin1(rawPdf(objs, '/Root 1 0 R'));
      const from = s.indexOf('/Contents <') + 10, to = s.indexOf('>', from) + 1;
      s = s.replace('AAAAAAAAAA', num(0)).replace('BBBBBBBBBB', num(from)).replace('CCCCCCCCCC', num(to)).replace('DDDDDDDDDD', num(s.length - to));
      return PdfDocument.load(bytesOf(tweak(s)));
    };
    const good = readSignatures(build('<00112233445566778899aabbccddeeff>'))[0];
    expect([good.signed, good.coversWholeFile, good.byteRangeStartsAtZero, good.gapIsContents]).toEqual([true, true, true, true]);
    // The gap takes in one byte more than the hex string: something other than the signature is unsigned.
    const wide = readSignatures(build('<00112233445566778899aabbccddeeff>', (s) => s.replace(/(\/ByteRange \[\d+ \d+ )(\d+) (\d+)/, (_m, a, c, d) => `${a}${num(+c + 1)} ${num(+d - 1)}`)))[0];
    expect([wide.byteRangeStartsAtZero, wide.gapIsContents, wide.coversWholeFile]).toEqual([true, false, true]);
    // The signed range starts after the header.
    const late = readSignatures(build('<00112233445566778899aabbccddeeff>', (s) => s.replace(/(\/ByteRange \[)(\d+) (\d+)/, (_m, a, _z, b) => `${a}${num(9)} ${num(+b - 9)}`)))[0];
    expect([late.byteRangeStartsAtZero, late.gapIsContents]).toEqual([false, true]);
    const unsigned = readSignatures(PdfDocument.load(rawPdf(onePage({ 4: '<< /FT /Sig /T (Sig1) /Subtype /Widget /Rect [0 0 0 0] >>' }, '/Annots [4 0 R]', '/AcroForm << /Fields [4 0 R] >>'), '/Root 1 0 R')))[0];
    expect([unsigned.signed, unsigned.byteRangeStartsAtZero, unsigned.gapIsContents]).toEqual([false, false, false]);
  });
});

describe('building pages (findings 8 and 10)', () => {
  const nested = () => {
    const objs: Record<number, string> = { 1: '<< /Type /Catalog /Pages 2 0 R >>', 2: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 6 /MediaBox [0 0 100 100] >>', 3: '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R 6 0 R 7 0 R] /Count 3 /Rotate 90 >>', 4: '<< /Type /Pages /Parent 2 0 R /Kids [8 0 R 9 0 R 10 0 R] /Count 3 /CropBox [10 10 90 90] >>' };
    for (let i = 5; i <= 10; i++) objs[i] = `<< /Type /Page /Parent ${i <= 7 ? 3 : 4} 0 R /N ${i - 4} >>`;
    return PdfDocument.load(rawPdf(objs, '/Root 1 0 R'));
  };
  const order = (d: PdfDocument) => d.pages.map((p) => (p.dict.has('N') ? p.dict.get('N') : 'new')).join(' ');
  it('inserts at a page index in a nested page tree, and keeps every /Count right', () => {
    for (const [at, want] of [[0, 'new 1 2 3 4 5 6'], [1, '1 new 2 3 4 5 6'], [3, '1 2 3 new 4 5 6'], [5, '1 2 3 4 5 new 6'], [6, '1 2 3 4 5 6 new'], [99, '1 2 3 4 5 6 new']] as [number, string][]) {
      const doc = nested();
      const p = addBlankPage(doc, [200, 300], at);
      expect(order(doc), `at ${at}`).toBe(want);
      expect([p.rotate, p.width, p.height], `at ${at}`).toEqual([0, 200, 300]); // not rotated or cropped by the node it went into
      const back = PdfDocument.load(doc.save({ incremental: true }));
      expect(order(back), `at ${at}`).toBe(want);
      expect(back.getNum(back.pagesRoot, 'Count')).toBe(7);
      const kids = back.getArray(back.pagesRoot, 'Kids')!.map((k) => back.resolve<Dict>(k));
      expect(kids.reduce((n, k) => n + (back.getName(k, 'Type') === 'Pages' ? back.getNum(k, 'Count') : 1), 0)).toBe(7);
    }
  });
  it('an image page goes where it was asked to go', () => {
    const doc = nested();
    addImagePage(doc, { kind: 'gray', data: new Uint8Array(4), width: 2, height: 2 }, { paper: 'image', at: 4 });
    expect(order(doc)).toBe('1 2 3 4 new 5 6');
  });
  it('a font remembered from an edit that was undone is registered again', () => {
    const doc = PdfDocument.load(makeTextPdf(['Hello']));
    // What DocTab.snapshot / restore do around an edit:
    const changed = new Map([...doc.changed].map(([k, v]) => [k, v === null ? null : cloneObj(v)]));
    const before = { changed, trailer: cloneObj(doc.trailer) as Dict, nextNum: doc.size };
    ensureFont(doc, doc.pages[0], 'Times-Bold');
    const d = doc as unknown as { changed: unknown; trailer: Dict; nextNum: number; cache: Map<number, unknown>; pageCache: unknown };
    d.changed = before.changed; d.trailer = before.trailer; d.nextNum = before.nextNum; d.cache.clear(); d.pageCache = null;
    const name = ensureFont(doc, doc.pages[0], 'Times-Bold');
    doc.setPageContent(doc.pages[0], bytesOf(`BT /${name} 12 Tf 72 700 Td (Stamp) Tj ET`));
    const back = PdfDocument.load(doc.save({ incremental: true }));
    const font = back.resolve(back.getDict(back.pages[0].resources, 'Font')!.get(name));
    expect(font).toBeInstanceOf(Dict);
    expect(font).not.toBeInstanceOf(PdfStream);
    expect(back.getName(font as Dict, 'BaseFont')).toBe('Times-Bold');
  });
});
