import { describe, it, expect } from 'vitest';
import { PdfDocument } from '../../src/pdf/document';
import { addTextPages } from '../../src/pdf/build';
import { normalizeRange, pagesFromRange, parseCsv, csvFormData, uniqueNames, safeName, uprightMatrix, zipOf, compressRange } from '../../src/commands/util';

/** A stand-in for a DocTab: the range helpers only read `doc` (and the viewer for defaults, unused here). */
function tabWithPages(n: number): any {
  const doc = PdfDocument.create();
  addTextPages(doc, Array.from({ length: n }, (_, i) => `page ${i + 1}`).join('\f'), {});
  while (doc.pageCount < n) addTextPages(doc, 'x', {});
  return { doc: PdfDocument.load(doc.save({ incremental: false })) };
}

describe('page ranges typed by the user (finding 10)', () => {
  it('reads "1 - 3" as pages 1 to 3, not as every page', () => {
    expect(normalizeRange('1 - 3', 10)).toEqual({ spec: '1-3', bad: [] });
    expect(pagesFromRange(tabWithPages(10), '1 - 3')).toEqual([0, 1, 2]);
    expect(pagesFromRange(tabWithPages(10), '2 - 4, 7')).toEqual([1, 2, 3, 6]);
  });
  it('takes en and em dashes for a hyphen', () => {
    expect(pagesFromRange(tabWithPages(10), '1–3')).toEqual([0, 1, 2]);
    expect(pagesFromRange(tabWithPages(10), '8—')).toEqual([7, 8, 9]);
  });
  it('swaps reversed bounds and clamps ranges to the document', () => {
    expect(normalizeRange('5-3', 10).spec).toBe('3-5');
    expect(normalizeRange('8-99', 10).spec).toBe('8-10');
    expect(pagesFromRange(tabWithPages(10), '5-3')).toEqual([2, 3, 4]);
  });
  it('reports what it cannot read instead of guessing', () => {
    expect(normalizeRange('-', 10).bad).toEqual(['-']);
    expect(normalizeRange('1 3', 10).bad).toEqual(['1 3']);
    expect(normalizeRange('0, 11, x', 10).bad).toEqual(['0', '11', 'x']);
    expect(() => pagesFromRange(tabWithPages(10), '-')).toThrow(/not a page or range/);
    expect(() => pagesFromRange(tabWithPages(10), '2, 50')).toThrow(/"50"/);
    expect(() => pagesFromRange(tabWithPages(10), '12-14')).toThrow(/not a page or range/);
  });
  it('keeps all, odd, even and open ranges', () => {
    const tab = tabWithPages(6);
    expect(pagesFromRange(tab, '')).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pagesFromRange(tab, 'All')).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pagesFromRange(tab, 'odd')).toEqual([0, 2, 4]);
    expect(pagesFromRange(tab, 'even')).toEqual([1, 3, 5]);
    expect(pagesFromRange(tab, '-2; 5-')).toEqual([0, 1, 4, 5]);
    expect(compressRange([0, 1, 2, 6])).toBe('1-3, 7');
  });
});

describe('CSV form data (finding 9)', () => {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const exported = (d: Record<string, string>) => Object.keys(d).map(q).join(',') + '\n' + Object.values(d).map(q).join(',') + '\n';

  it('keeps a quoted line break inside its cell and the cells after it', () => {
    const data = { Name: 'Ann', Notes: 'line one\nline two\r\nline three', City: 'Paris' };
    expect(csvFormData(exported(data))).toEqual(data);
  });
  it('drops a byte-order mark so the first field still matches', () => {
    expect(csvFormData('﻿Name,City\nAnn,Paris\n')).toEqual({ Name: 'Ann', City: 'Paris' });
  });
  it('unescapes doubled quotes and keeps commas in quoted cells', () => {
    expect(csvFormData(exported({ Name: 'Ann "The" B', City: 'Paris, FR' }))).toEqual({ Name: 'Ann "The" B', City: 'Paris, FR' });
    expect(parseCsv('a,"b ""x"" c",d')).toEqual([['a', 'b "x" c', 'd']]);
  });
  it('has no phantom trailing cell and does not blank fields missing from the data row', () => {
    expect(parseCsv('Name,City\nAnn,Paris\n')).toEqual([['Name', 'City'], ['Ann', 'Paris']]);
    expect(csvFormData('Name,City,Zip\nAnn\n')).toEqual({ Name: 'Ann' });
    expect(csvFormData('Name,City\n"",Paris\n')).toEqual({ Name: '', City: 'Paris' });
  });
  it('keeps real trailing empty cells, skips blank lines, reads CRLF', () => {
    expect(parseCsv('a,b,\r\n\r\n1,2,3\r\n')).toEqual([['a', 'b', ''], ['1', '2', '3']]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(csvFormData('only one row\n')).toBeNull();
  });
});

describe('file and ZIP entry names (finding 17)', () => {
  it('keeps same-named results apart instead of overwriting', () => {
    expect(uniqueNames(['scan.pdf', 'scan.pdf', 'Scan.PDF', 'notes'])).toEqual(['scan.pdf', 'scan (2).pdf', 'Scan (3).PDF', 'notes']);
  });
  it('removes path parts and control characters from names taken from documents', () => {
    expect(safeName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeName('a\u0000b\nc.txt')).toBe('a_b_c.txt');
    expect(safeName('   ')).toBe('file');
    expect(uniqueNames(['../x', '..\\x'])).toEqual(['_x', '_x (2)']);
  });
  it('writes every file into the ZIP', async () => {
    const { default: JSZip } = await import('jszip');
    const z = await JSZip.loadAsync(await zipOf([{ name: 'scan.pdf', data: 'one' }, { name: 'scan.pdf', data: 'two' }, { name: '../evil.txt', data: 'three' }]));
    expect(Object.keys(z.files).sort()).toEqual(['_evil.txt', 'scan (2).pdf', 'scan.pdf']);
    expect(await z.file('scan (2).pdf')!.async('string')).toBe('two');
  });
});

describe('placing an image as the reader sees the page (image overlay)', () => {
  // Applies a cm matrix to the unit square's lower-left and upper-right corners.
  const corners = (m: number[]) => [[m[4], m[5]], [m[0] + m[2] + m[4], m[1] + m[3] + m[5]]];
  it('uses the crop box origin on an upright page', () => {
    expect(uprightMatrix({ cropBox: [10, 20, 310, 420], rotate: 0 }, 5, 7, 100, 50)).toEqual([100, 0, 0, 50, 15, 27]);
  });
  it('turns with a rotated page so the image stays upright and in the same visible corner', () => {
    // /Rotate 90: the visible lower-left corner is the crop box's lower-right corner.
    const m = uprightMatrix({ cropBox: [0, 0, 300, 400], rotate: 90 }, 0, 0, 100, 50);
    expect(corners(m)).toEqual([[300, 0], [250, 100]]);
    expect(corners(uprightMatrix({ cropBox: [0, 0, 300, 400], rotate: 180 }, 0, 0, 100, 50))).toEqual([[300, 400], [200, 350]]);
    expect(corners(uprightMatrix({ cropBox: [0, 0, 300, 400], rotate: 270 }, 0, 0, 100, 50))).toEqual([[0, 400], [50, 300]]);
  });
});
