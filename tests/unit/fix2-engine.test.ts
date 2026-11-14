/** Second fix round, engine: XFA scripts, free lists of updates, cut-short content analysis, direct catalogs, XMP merging, OCR beyond the BMP, names for display. */
import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfStream, Ref, bytesOf, concat, latin1, utf8 } from '../../src/pdf/objects';
import { flateStream } from '../../src/pdf/filters';
import { analyzeContent, parseContent } from '../../src/pdf/content';
import { parseXref } from '../../src/pdf/xref';
import { readMetadata, writeMetadata, decodeXmp } from '../../src/pdf/structure';
import { hiddenInformation, sanitize, listFonts } from '../../src/pdf/ops/optimize';
import { applyRedactions, addRedactMark, exportXfdf } from '../../src/pdf/ops/annots';
import { formData, setFieldValue, exportFormXfdf } from '../../src/pdf/ops/forms';
import { readFields } from '../../src/pdf/structure';
import { addImagePage } from '../../src/pdf/build';
import { writeTextLayer, invisibleRuns, applyOcrCorrections, ocrLayerText, identityToUnicode, type OcrWord } from '../../src/commands/ocrlayer';
import { rawPdf, onePage, stream } from './fix-core-helpers';

const reload = (d: PdfDocument, incremental = false) => PdfDocument.load(d.save({ incremental }));

// ------------------------------------------------------------------------------------------
describe('sanitize removes XFA scripts (item 1)', () => {
  const template = '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><field name="a"><ui><textEdit/></ui>'
    + '<event activity="click"><script contentType="application/x-javascript"><![CDATA[app.alert("</script>");]]></script></event>'
    + '<event activity="ready"><xfa:script xmlns:xfa="http://www.xfa.org/schema/xfa-template/3.3/" contentType="application/x-javascript">xfa.host.beep();</xfa:script></event>'
    + '<event activity="change"><execute connection="db" runAt="server" executeType="import"/></event>'
    + '<event activity="click"><submit format="xml" target="http://example.invalid/collect" textEncoding="UTF-8"><encrypt/></submit></event>'
    + '<variables><script name="lib" contentType="application/x-javascript">function f(){}</script><text name="t">keep me</text></variables>'
    + '</field></subform></template>';
  const config = '<config xmlns="http://www.xfa.org/schema/xci/3.1/"><present><script><runScripts>both</runScripts></script><pdf><version>1.7</version></pdf></present></config>';
  const datasets = '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><script>user data named script</script></form1></xfa:data></xfa:datasets>';
  const packets = (): Record<number, string> => ({
    10: stream('', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'),
    11: stream('', config), 12: stream('', template), 13: stream('', datasets), 14: stream('', '</xdp:xdp>'),
  });
  const arrayDoc = () => PdfDocument.load(rawPdf(onePage(packets(), '', '/AcroForm << /Fields [] /XFA [(preamble) 10 0 R (config) 11 0 R (template) 12 0 R (datasets) 13 0 R (postamble) 14 0 R] >>'), '/Root 1 0 R'));
  const packetText = (d: PdfDocument, i: number) => latin1(d.decoded(d.resolve<PdfStream>(d.getArray(d.getDict(d.catalog, 'AcroForm'), 'XFA')![i])));

  it('counts them in the hidden-information report', () => {
    const item = hiddenInformation(arrayDoc()).items.find((x) => x.kind === 'XFA scripts');
    // Template: two scripts, execute, submit, the script object; config: one script element.
    expect(item?.count).toBe(6);
  });
  it('takes script, execute and submit elements out of the template and config packets, and keeps the rest', () => {
    const d = arrayDoc();
    const done = sanitize(d, { javascript: true });
    expect(done).toContain('XFA scripts');
    const r = reload(d);
    const t = packetText(r, 5), c = packetText(r, 3), ds = packetText(r, 7);
    expect(t).not.toMatch(/script|execute|submit|alert|beep|example\.invalid/);
    expect(t).toContain('<field name="a"><ui><textEdit/></ui>');
    expect(t).toContain('<event activity="click"></event>');
    expect(t).toContain('<text name="t">keep me</text>');
    expect(c).toBe('<config xmlns="http://www.xfa.org/schema/xci/3.1/"><present><pdf><version>1.7</version></pdf></present></config>');
    // The data packet is not a script packet: an element that happens to be called "script" stays.
    expect(ds).toBe(datasets);
    expect(packetText(r, 1)).toBe('<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">');
    expect(hiddenInformation(r).items.find((x) => x.kind === 'XFA scripts')).toBeUndefined();
  });
  it('works on an XFA form kept in one stream, inside its template and config only', () => {
    const xdp = `<?xml version="1.0"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">${config}${template}${datasets}</xdp:xdp>`;
    const d = PdfDocument.load(rawPdf(onePage({ 10: stream('', xdp) }, '', '/AcroForm << /Fields [] /XFA 10 0 R >>'), '/Root 1 0 R'));
    expect(sanitize(d, { javascript: true })).toContain('XFA scripts');
    const r = reload(d);
    const x = latin1(r.decoded(r.resolve<PdfStream>(r.getDict(r.catalog, 'AcroForm')!.get('XFA'))));
    expect(x).not.toMatch(/alert|beep|runScripts|<execute|<submit/);
    expect(x).toContain('<script>user data named script</script>');
    expect(x).toContain('<text name="t">keep me</text>');
  });
});

// ------------------------------------------------------------------------------------------
describe('incremental updates continue the free list (item 2)', () => {
  /** Objects 1, 2, 3 and 5; object 4 was deleted in this revision (generation 1, the head of the free list). */
  function withFree(): Uint8Array {
    const head = rawPdf(onePage({ 5: '<< /Kept true >>' }), '', { noXref: true });
    const offs: number[] = [];
    const t = latin1(head);
    for (const n of [1, 2, 3, 5]) offs[n] = t.indexOf(`\n${n} 0 obj`) + 1;
    const row = (o: number, g: number, k: string) => `${String(o).padStart(10, '0')} ${String(g).padStart(5, '0')} ${k} \n`;
    const x = `xref\n0 6\n${row(4, 65535, 'f')}${row(offs[1], 0, 'n')}${row(offs[2], 0, 'n')}${row(offs[3], 0, 'n')}${row(0, 1, 'f')}${row(offs[5], 0, 'n')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${head.length}\n%%EOF\n`;
    return concat([head, bytesOf(x)]);
  }
  /** The rows of the last cross-reference table: number → [field 1, generation, type]. */
  function lastTable(b: Uint8Array): Map<number, [number, number, string]> {
    const t = latin1(b);
    const at = t.lastIndexOf('\nxref\n') + 6;
    const out = new Map<number, [number, number, string]>();
    const lines = t.slice(at, t.indexOf('trailer', at)).split('\n');
    let n = 0, left = 0;
    for (const l of lines) {
      const m = /^(\d+) (\d+)$/.exec(l.trim());
      if (m && !left) { n = +m[1]; left = +m[2]; continue; }
      const e = /^(\d{10}) (\d{5}) ([nf])/.exec(l);
      if (e) { out.set(n++, [+e[1], +e[2], e[3]]); left--; }
    }
    return out;
  }
  it('reads the free entries of the newest revision', () => {
    const d = PdfDocument.load(withFree());
    expect(d.report.reconstructed).toBe(false);
    expect([...d.prevFree]).toEqual([[4, 1]]);
  });
  it('links objects freed now and the earlier free ones from object 0', () => {
    const d = PdfDocument.load(withFree());
    d.remove(new Ref(5, 0));
    const out = d.save({ incremental: true });
    const tab = lastTable(out);
    expect(tab.get(0)).toEqual([4, 65535, 'f']);
    expect(tab.get(4)).toEqual([5, 1, 'f']);
    expect(tab.get(5)).toEqual([0, 1, 'f']);
    const xr = parseXref(out);
    expect([...xr.free.keys()].sort()).toEqual([4, 5]);
    const r = PdfDocument.load(out);
    expect(r.report.reconstructed).toBe(false);
    expect(r.fetch(new Ref(5, 0))).toBe(null);
  });
  it('keeps the earlier free entries in the list when nothing is freed now', () => {
    const d = PdfDocument.load(withFree());
    d.register(new Dict({ New: true }));
    const tab = lastTable(d.save({ incremental: true }));
    expect(tab.get(0)).toEqual([4, 65535, 'f']);
    expect(tab.get(4)).toEqual([0, 1, 'f']);
  });
  it('does the same in an update written as a cross-reference stream', () => {
    const base = PdfDocument.create();
    base.catalog.set('QFTest', [base.register(new Dict({ A: 1 })), base.register(new Dict({ B: 2 }))]);
    const first = PdfDocument.load(base.save({ incremental: false, objectStreams: true }));
    expect(first.usesXrefStream).toBe(true);
    const [a, b] = first.getArray(first.catalog, 'QFTest') as Ref[];
    first.remove(b);
    const second = PdfDocument.load(first.save({ incremental: true }));
    expect([...second.prevFree.keys()]).toEqual([b.num]);
    second.remove(a);
    const third = second.save({ incremental: true });
    expect([...parseXref(third).free.keys()].sort((x, y) => x - y)).toEqual([a.num, b.num].sort((x, y) => x - y));
    expect(PdfDocument.load(third).report.reconstructed).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------
describe('content analysis that runs out of work says so (item 3)', () => {
  /** Forms F0…F6, each drawing the next ten times; F7 shows text. Ten million forms in all. */
  function runaway(): Record<number, string> {
    const objs: Record<number, string> = {};
    for (let k = 0; k < 7; k++) objs[10 + k] = stream(`/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /X ${11 + k} 0 R >> >>`, '/X Do '.repeat(10));
    objs[17] = stream('/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 20 0 R >> >>', 'BT /F1 12 Tf 72 700 Td (secret) Tj ET');
    objs[20] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    objs[21] = stream('', 'BT /F1 12 Tf 72 600 Td (plain) Tj ET /F0 Do');
    return objs;
  }
  const doc = () => PdfDocument.load(rawPdf(onePage(runaway(), '/Contents 21 0 R /Resources << /Font << /F1 20 0 R >> /XObject << /F0 10 0 R >> >>'), '/Root 1 0 R'));
  it('analyzeContent marks its result incomplete', () => {
    const d = doc();
    const r = analyzeContent(d, parseContent(d.pageContent(d.pages[0])), d.pages[0].resources);
    expect(r.incomplete).toBe(true);
    expect(r.runs.some((x) => x.text === 'plain')).toBe(true);
  });
  it('an ordinary page is complete', () => {
    const d = PdfDocument.load(rawPdf(onePage({ 21: stream('', 'BT /F1 12 Tf 72 600 Td (plain) Tj ET') }, '/Contents 21 0 R /Resources << /Font << /F1 20 0 R >> >>'), '/Root 1 0 R'));
    expect(analyzeContent(d, parseContent(d.pageContent(d.pages[0])), d.pages[0].resources).incomplete).toBe(false);
  });
  it('applyRedactions removes what it reached and reports the page as not fully checked', () => {
    const d = doc();
    addRedactMark(d, d.pages[0], [[0, 0, 612, 792]]);
    const res = applyRedactions(d, [0]);
    expect(res.incompletePages).toEqual([0]);
    expect(res.textRemoved).toBeGreaterThan(0);
  });
  it('a page it could check completely is not reported', () => {
    const d = PdfDocument.load(rawPdf(onePage({ 20: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 21: stream('', 'BT /F1 12 Tf 72 600 Td (plain) Tj ET') }, '/Contents 21 0 R /Resources << /Font << /F1 20 0 R >> >>'), '/Root 1 0 R'));
    addRedactMark(d, d.pages[0], [[60, 590, 200, 620]]);
    const res = applyRedactions(d, [0]);
    expect(res.incompletePages).toEqual([]);
    expect(res.textRemoved).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------
describe('a catalog written directly in the trailer (item 5)', () => {
  const bytes = () => rawPdf({ 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>' }, '/Root << /Type /Catalog /Pages 2 0 R /PageMode /UseOutlines >>');
  it('loads without rebuilding the cross-reference table, and the document is not marked changed', () => {
    const d = PdfDocument.load(bytes());
    expect(d.report.reconstructed).toBe(false);
    expect(d.dirty).toBe(false);
    expect(d.pageCount).toBe(1);
    const ref = d.catalogRef;
    expect(d.catalogRef).toBe(ref);
    expect(d.trailer.get('Root')).toBe(ref);
    expect(d.getName(d.catalog, 'PageMode')).toBe('UseOutlines');
  });
  it('is saved as an object of its own, incrementally and in full', () => {
    for (const incremental of [true, false]) {
      const out = PdfDocument.load(bytes()).save({ incremental });
      const r = PdfDocument.load(out);
      expect(r.report.reconstructed).toBe(false);
      expect(r.trailer.get('Root')).toBeInstanceOf(Ref);
      expect(r.pageCount).toBe(1);
      expect(r.getName(r.catalog, 'PageMode')).toBe('UseOutlines');
    }
  });
});

// ------------------------------------------------------------------------------------------
describe('XMP packets are merged, whatever their encoding (item 6)', () => {
  const packet = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="uuid:1234" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="2" pdfaid:conformance="B"/>
<rdf:Description rdf:about="uuid:1234" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<xmpRights:Marked>True</xmpRights:Marked>
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Ünïcødé Press</rdf:li></rdf:Alt></dc:rights>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old title</rdf:li></rdf:Alt></dc:title>
<dc:language><rdf:Bag><rdf:li>fr</rdf:li></rdf:Bag></dc:language>
</rdf:Description>
<rdf:Description rdf:about="uuid:1234" xmlns:xap="http://ns.adobe.com/xap/1.0/" xmlns:my="http://example.com/ns/my/" xap:CreatorTool="Old tool">
<my:Thing my:attr="1">custom &amp; kept</my:Thing>
<xap:MetadataDate>2001-01-01T00:00:00Z</xap:MetadataDate>
</rdf:Description>
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const enc = (s: string, how: 'utf8' | 'be-bom' | 'le' | 'be' | 'le-bom'): Uint8Array => {
    if (how === 'utf8') return utf8(s);
    const be = how.startsWith('be'), bom = how.endsWith('bom');
    const out: number[] = bom ? (be ? [0xfe, 0xff] : [0xff, 0xfe]) : [];
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (be) out.push(c >> 8, c & 255); else out.push(c & 255, c >> 8); }
    return Uint8Array.from(out);
  };
  const docWith = (xmp: Uint8Array) => {
    const d = PdfDocument.create();
    d.catalog.set('Metadata', d.register(flateStream(xmp, { Type: Name.get('Metadata'), Subtype: Name.get('XML') }, false)));
    return PdfDocument.load(d.save({ incremental: false }));
  };
  for (const how of ['utf8', 'be-bom', 'le', 'be', 'le-bom'] as const) {
    it(`decodes and merges a ${how} packet, keeping every other element, and writes UTF-8`, () => {
      expect(decodeXmp(enc(packet, how))).toBe(packet);
      const d = docWith(enc(packet, how));
      writeMetadata(d, { title: 'New title', creator: 'New tool' });
      const r = reload(d);
      const raw = r.decoded(r.resolve<PdfStream>(r.catalog.get('Metadata')));
      expect(raw.includes(0)).toBe(false);
      const x = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      expect(x).toContain('pdfaid:part="2"');
      expect(x).toContain('pdfaid:conformance="B"');
      expect(x).toContain('<xmpRights:Marked>True</xmpRights:Marked>');
      expect(x).toContain('© Ünïcødé Press');
      expect(x).toContain('<my:Thing my:attr="1">custom &amp; kept</my:Thing>');
      expect(x).toContain('<dc:language><rdf:Bag><rdf:li>fr</rdf:li></rdf:Bag></dc:language>');
      expect(x).not.toContain('Old title');
      expect(x).not.toContain('Old tool');
      expect(x).not.toContain('2001-01-01');
      expect(x.match(/<dc:title>/g)!.length).toBe(1);
      expect(x).toContain('<xmp:CreatorTool>New tool</xmp:CreatorTool>');
      expect(x).toMatch(/<xmp:MetadataDate>\d{4}-/);
      expect(x).toContain('rdf:about="uuid:1234" xmlns:dc=');
      expect(readMetadata(r).title).toBe('New title');
    });
  }
  it('replaces dc:language only when the language is set', () => {
    const d = docWith(enc(packet, 'utf8'));
    writeMetadata(d, { language: 'de-CH' });
    const x = readMetadata(reload(d)).xmp;
    expect(x).not.toContain('<rdf:li>fr</rdf:li>');
    expect(x).toContain('<dc:language><rdf:Bag><rdf:li>de-CH</rdf:li></rdf:Bag></dc:language>');
    expect(x).toContain('pdfaid:part="2"');
  });
  it('treats an empty element with a space before "/>" as empty', () => {
    const p = packet.replace('<xmpRights:Marked>True</xmpRights:Marked>', '<dc:description />\n<xmpRights:Marked>True</xmpRights:Marked>');
    const d = docWith(enc(p, 'utf8'));
    writeMetadata(d, { subject: 'About' });
    const x = readMetadata(reload(d)).xmp;
    expect(x).toContain('<xmpRights:Marked>True</xmpRights:Marked>');
    expect(x).not.toContain('<dc:description />');
  });
  it('a UTF-16 packet that declares its encoding is declared UTF-8 afterwards', () => {
    const p = '<?xml version="1.0" encoding="UTF-16"?>\n' + packet;
    const d = docWith(enc(p, 'be-bom'));
    writeMetadata(d, { title: 'T' });
    expect(readMetadata(reload(d)).xmp).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });
});

// ------------------------------------------------------------------------------------------
describe('OCR words beyond the Basic Multilingual Plane (item 7)', () => {
  const word = (text: string, x: number, y: number, w: number, h = 14): OcrWord => ({ text, x0: x, y0: y, x1: x + w, y1: y + h, conf: 90 });
  function imageDoc(): PdfDocument {
    const d = PdfDocument.create();
    addImagePage(d, { kind: 'rgb', data: new Uint8Array(20 * 20 * 3).fill(255), width: 20, height: 20 } as any, { paper: [612, 792], dpi: 72 });
    addImagePage(d, { kind: 'rgb', data: new Uint8Array(20 * 20 * 3).fill(255), width: 20, height: 20 } as any, { paper: [612, 792], dpi: 72 });
    return PdfDocument.load(d.save({ incremental: false }));
  }
  const texts = (d: PdfDocument, i = 0) => invisibleRuns(d, d.pages[i]).map((r) => r.text);
  it('keeps the characters (no U+FFFD), through a save, and gives each one code', () => {
    expect(ocrLayerText('𠀋😀')).toBe('𠀋😀');
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [word('𠀋😀', 72, 700, 40), word('Привет', 72, 680, 60), word('𐎀a', 72, 660, 20)], 'eng');
    const r = reload(d);
    expect(texts(r)).toEqual(['𠀋😀', 'Привет', '𐎀a']);
    const runs = invisibleRuns(r, r.pages[0]);
    expect(runs[0].strings[0].bytes.length).toBe(4);
    expect(runs[0].box[2] - runs[0].box[0]).toBeCloseTo(40, 0);
  });
  it('maps the codes to surrogate pairs in the ToUnicode CMap and reuses them on later pages and runs', () => {
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [word('😀', 72, 700, 20)], 'eng');
    writeTextLayer(d, d.pages[1], [word('😀𠀋', 72, 700, 20)], 'eng');
    const r = reload(d, true);
    const font = r.resolve<Dict>(r.getDict(r.pages[1].resources, 'Font')!.get('QFOcrU'));
    const cmap = latin1(r.decoded(r.resolve<PdfStream>(font.get('ToUnicode'))));
    expect(cmap).toContain('<D800> <D83DDE00>');
    expect(cmap).toContain('<D801> <D840DC0B>');
    expect(cmap).not.toContain('<D800> <D8FF> <D800>');
    expect(texts(r, 0)).toEqual(['😀']);
    expect(texts(r, 1)).toEqual(['😀𠀋']);
  });
  it('corrections may bring such characters in', () => {
    const d = imageDoc();
    writeTextLayer(d, d.pages[0], [word('Привет', 72, 700, 60)], 'rus');
    const run = invisibleRuns(d, d.pages[0])[0];
    expect(applyOcrCorrections(d, d.pages[0], [{ run, text: 'При😀' }])).toBe(1);
    expect(texts(reload(d))).toEqual(['При😀']);
  });
  it('without such characters the CMap is the plain 256 ranges', () => {
    expect(identityToUnicode().match(/^<[0-9A-F]{2}00> <[0-9A-F]{2}FF> <[0-9A-F]{2}00>$/gm)!.length).toBe(256);
    expect(identityToUnicode(new Map([['😀', 0xd800]])).match(/^<[0-9A-F]{2}00> <[0-9A-F]{2}FF> <[0-9A-F]{2}00>$/gm)!.length).toBe(248);
  });
});

// ------------------------------------------------------------------------------------------
describe('names shown to a person are decoded (item 8)', () => {
  const nameBytes = latin1(utf8('Grün'));
  it('radio states in UTF-8 are exported as text and accepted as text', () => {
    const objs = onePage({
      10: `<< /FT /Btn /Ff 49152 /T (choice) /V /${'Gr#C3#BCn'} /Kids [11 0 R] >>`,
      11: `<< /Type /Annot /Subtype /Widget /Parent 10 0 R /Rect [0 0 10 10] /P 3 0 R /AS /Gr#C3#BCn /AP << /N << /Gr#C3#BCn 12 0 R /Off 12 0 R >> >> >>`,
      12: stream('/Type /XObject /Subtype /Form /BBox [0 0 10 10]', ''),
    }, '/Annots [11 0 R]', '/AcroForm << /Fields [10 0 R] >>');
    const d = PdfDocument.load(rawPdf(objs, '/Root 1 0 R'));
    const f = readFields(d)[0];
    expect(f.value).toBe(nameBytes);
    expect(formData(d).choice).toBe('Grün');
    expect(exportFormXfdf(d)).toContain('<value>Grün</value>');
    setFieldValue(d, f, 'Off');
    setFieldValue(d, readFields(d)[0], 'Grün');
    expect(readFields(d)[0].value).toBe(nameBytes);
  });
  it('a note icon name is decoded in XFDF', () => {
    const objs = onePage({ 10: '<< /Type /Annot /Subtype /Text /Rect [0 0 20 20] /Name /Sch#C3#B6n /Contents (x) >>' }, '/Annots [10 0 R]');
    expect(exportXfdf(PdfDocument.load(rawPdf(objs, '/Root 1 0 R')))).toContain('icon="Schön"');
  });
  it('font lists show the encoding name decoded', () => {
    const objs = onePage({ 10: '<< /Type /Font /Subtype /Type1 /BaseFont /B#C3#A4ck /Encoding /M#C3#BCnz >>' }, '/Resources << /Font << /F1 10 0 R >> >>');
    const f = listFonts(PdfDocument.load(rawPdf(objs, '/Root 1 0 R')))[0];
    expect([f.name, f.encoding]).toEqual(['Bäck', 'Münz']);
  });
});
