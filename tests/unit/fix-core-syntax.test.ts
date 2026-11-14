import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfString, Ref, bytesOf, latin1, nameText, parsePdfDate, pdfDate } from '../../src/pdf/objects';
import { Lexer, parseObject } from '../../src/pdf/lexer';
import { fmtNum, serialize, serializeName } from '../../src/pdf/writer';
import { analyzeContent, encodeString, fontInfo, parseContent, serializeContent } from '../../src/pdf/content';
import { textWidth, wrapText } from '../../src/pdf/stdfonts';
import { onePage, rawPdf, runsOf, stream, text } from './fix-core-helpers';

describe('numbers (finding 2)', () => {
  it('keeps small values instead of rounding to four decimals', () => {
    expect(fmtNum(0.00048828125)).toBe('0.00048828125');
    expect(fmtNum(0.00001)).toBe('0.00001');
    expect(fmtNum(-0.00004)).toBe('-0.00004');
    expect(fmtNum(0.1 + 0.2)).toBe('0.3');
    expect(fmtNum(595.28)).toBe('595.28');
    expect(fmtNum(-0)).toBe('0');
    expect(fmtNum(NaN)).toBe('0');
  });
  it('never writes an exponent', () => {
    for (const n of [1e21, -1e21, 1.5e300, 1e-7, 123456789.123456, 2 ** 53]) expect(fmtNum(n)).toMatch(/^-?\d+(\.\d+)?$/);
    expect(fmtNum(1e21)).toBe('1000000000000000000000');
  });
  it('a content stream comes back with the scale and line width it had', () => {
    const src = 'q 0.00012 0 0 0.00012 0 0 cm 500000 500000 m 0.000049 w S Q';
    expect(text(serializeContent(parseContent(bytesOf(src)))).replace(/\s+/g, ' ').trim()).toBe(src);
  });
  it('a 1/2048 font matrix survives a full rewrite', () => {
    const doc = PdfDocument.load(rawPdf(onePage({ 4: '<< /Type /Font /Subtype /Type3 /FontMatrix [0.00048828125 0 0 0.00048828125 0 0] >>' }, '/Resources << /Font << /T3 4 0 R >> >>'), '/Root 1 0 R'));
    const again = PdfDocument.load(doc.save({ incremental: false }));
    const fm = again.getArray(again.getDict(again.getDict(again.pages[0].resources, 'Font'), 'T3'), 'FontMatrix')!;
    expect(fm[0]).toBe(0.00048828125);
  });
});

describe('names (finding 6)', () => {
  it('are read as their bytes and written back byte for byte', () => {
    for (const src of ['/#E5#AE#8B#E4#BD#93', '/caf#C3#A9', '/Stra#DFe', '/A#20B', '/x#23y#2Fz']) {
      const n = parseObject(bytesOf(src)) as Name;
      expect(text(serialize(n)), src).toBe(src);
    }
  });
  it('decode as UTF-8 for display only', () => {
    const n = parseObject(bytesOf('/#E5#AE#8B#E4#BD#93')) as Name;
    expect(n.name.length).toBe(6);
    expect(nameText(n.name)).toBe('宋体');
    expect(nameText('Straße')).toBe('Straße'); // Latin-1 bytes that are not UTF-8 stay as they are
    expect(nameText('Helvetica')).toBe('Helvetica');
  });
  it('a name made in code with wide characters is written as UTF-8', () => {
    expect(serializeName('宋体')).toBe('/#E5#AE#8B#E4#BD#93');
  });
  it('a "#" without two hex digits is a "#"', () => {
    expect((parseObject(bytesOf('/A#4GB')) as Name).name).toBe('A#4GB');
    expect((parseObject(bytesOf('/a#')) as Name).name).toBe('a#');
  });
  it('a resource name in UTF-8 still matches the content stream after a full rewrite', () => {
    const page = '/Contents 4 0 R /Resources << /Font << /caf#C3#A9 5 0 R >> >>';
    const pdf = rawPdf(onePage({ 4: stream('', 'BT /caf#C3#A9 12 Tf 72 700 Td (Hi) Tj ET'), 5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' }, page), '/Root 1 0 R');
    const out = PdfDocument.load(pdf).save({ incremental: false });
    expect(latin1(out)).toContain('/caf#C3#A9 ');
    expect(latin1(out)).not.toContain('/caf#E9');
  });
});

describe('text strings (finding 13)', () => {
  it('round trip characters that PDFDocEncoding does not share with Latin-1', () => {
    for (const t of ['a b', '\u0080x', 'soft­hyphen', 'þÿab', 'café', 'tab\tline\nbreak', 'Ünïcödé ✓', '€ • —']) expect(PdfString.fromText(t).toText(), JSON.stringify(t)).toBe(t);
  });
  it('still writes plain Latin text as one byte per character', () => {
    expect(PdfString.fromText('café').bytes.length).toBe(4);
    expect(PdfString.fromText('Plain ASCII').bytes.length).toBe(11);
  });
  it('dates: four-digit years out, years below 100 in', () => {
    expect(pdfDate(new Date(999, 0, 1)).toText()).toMatch(/^D:0999/);
    expect(parsePdfDate('D:0024')!.getFullYear()).toBe(24);
    expect(parsePdfDate("D:20240102030405+02'00'")!.toISOString()).toBe('2024-01-02T01:04:05.000Z');
  });
});

describe('lexer (finding 20, performance list)', () => {
  it('a long run of stray delimiters does not overflow the stack', () => {
    expect(new Lexer(bytesOf(')'.repeat(200000) + '> '.repeat(100000) + ' 7')).next()).toEqual({ t: 'num', v: 7 });
  });
  it('references are still recognized, with and without comments between the tokens', () => {
    const show = (v: unknown): string => (v instanceof Ref ? `R${v.num}.${v.gen}` : Array.isArray(v) ? `[${v.map(show).join(' ')}]` : String(v));
    expect(show(parseObject(bytesOf('[1 0 R 2 0 R 3 4 5 0 R 6]')))).toBe('[R1.0 R2.0 3 4 R5.0 6]');
    expect(show(parseObject(bytesOf('[1 0 R%c\n 7 % x\n 0 % y\n R 12 13]')))).toBe('[R1.0 R7.0 12 13]');
    expect(show(parseObject(bytesOf('[5 0 Rx 6 0 RG 1.5 0 R -1 0 R]')))).toBe('[5 0 6 0 1.5 R0.0 -1 R0.0]'.replace('1.5 R0.0', '1.5 0').replace('-1 R0.0', '-1 0'));
    const d = parseObject(bytesOf('<< /A 1 0 R/B 2 /C 3 0 R >>')) as Dict;
    expect(show(d.get('A'))).toBe('R1.0'); expect(d.get('B')).toBe(2); expect(show(d.get('C'))).toBe('R3.0');
  });
  it('a backslash at the very end of the data ends the string', () => {
    expect((parseObject(bytesOf('(ab\\')) as PdfString).toLatin1()).toBe('ab');
  });
});

describe('content streams (findings 12, 15, 16; inline images)', () => {
  it('parses every operator of a very long stream', () => {
    const n = 1_666_670; // 5,000,010 tokens: more than the old cut-off of 5,000,000
    const ops = parseContent(bytesOf('1 2 m\n'.repeat(n)));
    expect(ops.length).toBe(n);
  }, 60000);
  it('q and Q restore the font, size and spacing', () => {
    const page = '/Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >>';
    const pdf = rawPdf(onePage({ 4: stream('', 'BT /F1 10 Tf ET q BT /F2 40 Tf 3 Tc 10 100 Td (in) Tj ET Q BT 10 50 Td (AAAA) Tj ET'), 5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 6: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>' }, page), '/Root 1 0 R');
    const r = runsOf(PdfDocument.load(pdf));
    expect([r[0].font, r[0].size]).toEqual(['F2', 40]);
    expect([r[1].font, r[1].size]).toEqual(['F1', 10]);
    expect(r[1].box[2] - r[1].box[0]).toBeCloseTo(textWidth('AAAA', 'Helvetica', 10), 3);
  });
  it('reads StandardEncoding for a Type 1 font that names no encoding', () => {
    const page = '/Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >>';
    const pdf = rawPdf(onePage({
      4: stream('', 'BT /F1 10 Tf 10 100 Td (\\256nd \\252quote\\272 it\\047s) Tj ET'),
      5: '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
      6: '<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Custom /FontDescriptor << /Type /FontDescriptor /FontFile3 4 0 R >> /FirstChar 32 /Widths [250] >>',
      7: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    }, page), '/Root 1 0 R');
    const doc = PdfDocument.load(pdf);
    expect(runsOf(doc)[0].text).toBe('ﬁnd “quote” it’s');
    const fonts = doc.getDict(doc.pages[0].resources, 'Font');
    const f1 = fontInfo(doc, 'F1', doc.getDict(fonts, 'F1'));
    expect(f1.editable).toBe(true);
    expect(Array.from(encodeString(f1, '’ﬁ')!.bytes)).toEqual([0o047, 0o256]);
    // An embedded font with no named encoding may use any table of its own: no re-encoding of new text.
    expect(fontInfo(doc, 'F2', doc.getDict(fonts, 'F2')).editable).toBe(false);
    expect(fontInfo(doc, 'F3', doc.getDict(fonts, 'F3')).editable).toBe(true);
  });
  it('an inline image keeps bytes that happen to spell " EI "', () => {
    const img = '\x01\x02 EI \x03\x04\x05\x06'; // 10 bytes: 5 x 2 gray samples
    for (const dict of ['/W 5 /H 2 /BPC 8 /CS /G', '/W 5 /H 2 /BPC 8 /CS /G /F /LZW']) {
      const ops = parseContent(bytesOf(`q BI ${dict} ID ${img}\nEI Q 1 0 0 RG`));
      expect(ops.map((o) => o.op), dict).toEqual(['q', 'INLINE_IMAGE', 'Q', 'RG']);
      expect(latin1(ops[1].inline!.data), dict).toBe(img);
      const again = parseContent(serializeContent(ops));
      expect(latin1(again[1].inline!.data), dict).toBe(img);
    }
  });
  it('analysis stops at a work budget when forms draw each other many times over', () => {
    // 8 levels, each drawing the next 12 times: 12^8 form runs if nothing stopped it.
    const objs: Record<number, string> = {};
    for (let i = 0; i < 8; i++) objs[10 + i] = stream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /XObject << /X ${11 + i} 0 R >> /Font << /F1 5 0 R >> >>`, i < 7 ? '/X Do '.repeat(12) : 'BT /F1 1 Tf (x) Tj ET');
    const page = '/Contents 4 0 R /Resources << /XObject << /X 10 0 R >> >>';
    const doc = PdfDocument.load(rawPdf(onePage({ 4: stream('', '/X Do'), 5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', ...objs }, page), '/Root 1 0 R'));
    const t0 = Date.now();
    const r = analyzeContent(doc, parseContent(doc.pageContent(doc.pages[0])), doc.pages[0].resources);
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(r.runs.length).toBeGreaterThan(0);
  }, 60000);
});

describe('text wrapping (finding 18)', () => {
  it('breaks a very long unbroken token quickly and loses nothing', () => {
    const token = Array.from({ length: 20000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const t0 = Date.now();
    const lines = wrapText(token, 'Helvetica', 11, 468);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(lines.join('')).toBe(token);
    expect(lines.length).toBeGreaterThan(100);
    for (const l of lines) expect(textWidth(l, 'Helvetica', 11)).toBeLessThanOrEqual(468 + 1e-6);
  });
  it('wraps ordinary text as before', () => {
    expect(wrapText('aaa bbb ccc', 'Courier', 10, 6.6 * 7)).toEqual(['aaa bbb', 'ccc']);
    expect(wrapText('one\n\ntwo', 'Helvetica', 10, 100)).toEqual(['one', '', 'two']);
  });
});
