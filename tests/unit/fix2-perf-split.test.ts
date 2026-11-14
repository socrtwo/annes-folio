/** Split builds one part at a time and writes each into the ZIP before building the next. */
import { describe, it, expect, vi } from 'vitest';
const io = vi.hoisted(() => ({ saved: [] as { blob: Blob; name: string }[] }));
vi.mock('../../src/platform/native', async (orig) => ({ ...(await orig<any>()), saveAs: async (blob: Blob, name: string) => { io.saved.push({ blob, name }); return { uri: null, name }; } }));
import JSZip from 'jszip';
import { PdfDocument } from '../../src/pdf/document';
import { addTextPages } from '../../src/pdf/build';
import { splitParts, splitGroups, splitDocument } from '../../src/pdf/ops/pages';
import { saveSplitZip } from '../../src/commands/organize';
import { ZipWriter, crc32 } from '../../src/commands/zipstream';

function doc(pages: number): PdfDocument {
  const d = PdfDocument.create();
  addTextPages(d, Array.from({ length: pages }, (_, i) => `# Part page ${i + 1}\n\n` + 'Text. '.repeat(500)).join('\n\n'));
  return PdfDocument.load(d.save({ incremental: false }));
}

describe('splitParts', () => {
  it('builds each part only when it is asked for', () => {
    const src = doc(6);
    const create = vi.spyOn(PdfDocument, 'create');
    try {
      const it = splitParts(src, { kind: 'every', n: 2 });
      expect(create).not.toHaveBeenCalled();
      const first = it.next();
      expect(first.done).toBe(false);
      expect(create).toHaveBeenCalledTimes(1);
      expect(first.value!.doc.pageCount).toBe(2);
      expect([...it].length).toBe(splitGroups(src, { kind: 'every', n: 2 }).length - 1);
    } finally { create.mockRestore(); }
  });

  it('splitDocument still returns every part', () => {
    const src = doc(5);
    expect(splitDocument(src, { kind: 'every', n: 2 }).map((p) => p.doc.pageCount)).toEqual([2, 2, src.pageCount - 4]);
  });
});

describe('ZIP of the parts', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('a ZipWriter archive is read back by JSZip, with UTF-8 names', async () => {
    const z = new ZipWriter();
    z.add('a.pdf', new Uint8Array([1, 2, 3]));
    z.add('Übersicht (2).pdf', new Uint8Array(70000).fill(7));
    const bytes = new Uint8Array(await new Blob(z.finish() as BlobPart[]).arrayBuffer());
    const back = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(Object.keys(back.files)).toEqual(['a.pdf', 'Übersicht (2).pdf']);
    expect([...(await back.file('a.pdf')!.async('uint8array'))]).toEqual([1, 2, 3]);
    expect((await back.file('Übersicht (2).pdf')!.async('uint8array')).length).toBe(70000);
  });

  it('each part goes into the archive before the next part is built, and the archive holds every part', async () => {
    const src = doc(6);
    const order: string[] = [];
    const realCreate = PdfDocument.create.bind(PdfDocument);
    const c2 = vi.spyOn(PdfDocument, 'create').mockImplementation(() => { order.push('build'); return realCreate(); });
    const original = ZipWriter.prototype.add;
    ZipWriter.prototype.add = function (name: string, data: Uint8Array) { order.push('add'); return original.call(this, name, data); };
    try {
      const mode = { kind: 'every' as const, n: 2 };
      const groups = splitGroups(src, mode);
      io.saved = [];
      expect(await saveSplitZip(src, mode, groups, 'Report')).toBe(true);
      expect(order).toEqual(groups.flatMap(() => ['build', 'add']));
      expect(io.saved[0].name).toBe('Report split.zip');
      const zip = await JSZip.loadAsync(await io.saved[0].blob.arrayBuffer(), { checkCRC32: true });
      const names = Object.keys(zip.files);
      expect(names).toEqual(groups.map((g) => `Report ${g.name}.pdf`));
      for (const [k, n] of names.entries()) expect(PdfDocument.load(await zip.file(n)!.async('uint8array')).pageCount).toBe(groups[k].pages.length);
    } finally { c2.mockRestore(); ZipWriter.prototype.add = original; }
  });

  it('parts with the same name are kept apart', async () => {
    const src = doc(4);
    const mode = { kind: 'ranges' as const, ranges: '1; 1' };
    io.saved = [];
    await saveSplitZip(src, mode, splitGroups(src, mode), 'R');
    const zip = await JSZip.loadAsync(await io.saved[0].blob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(['R 1.pdf', 'R 1 (2).pdf']);
  });
});
