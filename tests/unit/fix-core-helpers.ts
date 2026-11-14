/** Helpers for the fix-core tests: hand-written PDFs, so that a test controls every byte of its input. */
import { PdfDocument } from '../../src/pdf/document';
import { bytesOf, concat, latin1 } from '../../src/pdf/objects';
import { analyzeContent, parseContent } from '../../src/pdf/content';

/** A PDF with a classic cross-reference table from object bodies (number → what goes between "obj" and "endobj"). */
export function rawPdf(objs: Record<number, string | Uint8Array>, trailer: string, opts: { noXref?: boolean; header?: string } = {}): Uint8Array {
  const parts: Uint8Array[] = [bytesOf(`%PDF-${opts.header || '1.7'}\n%\xe2\xe3\xcf\xd3\n`)];
  let pos = parts[0].length;
  const offs: Record<number, number> = {};
  const nums = Object.keys(objs).map(Number).sort((a, b) => a - b);
  for (const n of nums) {
    offs[n] = pos;
    const body = objs[n];
    const b = concat([bytesOf(`${n} 0 obj\n`), typeof body === 'string' ? bytesOf(body) : body, bytesOf('\nendobj\n')]);
    parts.push(b); pos += b.length;
  }
  const size = nums[nums.length - 1] + 1;
  if (!opts.noXref) {
    const rows = ['0000000000 65535 f \n'];
    for (let n = 1; n < size; n++) rows.push(offs[n] != null ? `${String(offs[n]).padStart(10, '0')} 00000 n \n` : '0000000000 65535 f \n');
    parts.push(bytesOf(`xref\n0 ${size}\n${rows.join('')}trailer\n<< /Size ${size} ${trailer} >>\nstartxref\n${pos}\n%%EOF\n`));
  }
  return concat(parts);
}

export const stream = (dict: string, data: string): string => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
export const binStream = (dict: string, data: Uint8Array): Uint8Array => concat([bytesOf(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, bytesOf('\nendstream')]);

/** The usual three objects (catalog 1, pages 2, page 3) plus whatever a test adds or overrides. */
export function onePage(extra: Record<number, string | Uint8Array> = {}, pageExtra = '', catalogExtra = ''): Record<number, string | Uint8Array> {
  return { 1: `<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>`, 2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 3: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${pageExtra} >>`, ...extra };
}

export const eq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
export const text = (b: Uint8Array): string => latin1(b);
export const runsOf = (doc: PdfDocument, page = 0) => analyzeContent(doc, parseContent(doc.pageContent(doc.pages[page])), doc.pages[page].resources).runs;
