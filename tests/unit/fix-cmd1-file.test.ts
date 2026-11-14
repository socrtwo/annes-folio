import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-ins for device storage and the platform's file access.
const kv = new Map<string, any>();
const io = { writeBack: vi.fn(async (_uri: string, _blob: Blob) => true), saveAs: vi.fn(async (_blob: Blob, name: string): Promise<{ uri: string | null; name: string } | null> => ({ uri: null, name })), readUri: vi.fn(async (_uri: string): Promise<any> => null) };
vi.mock('../../src/util/store', () => ({
  kvGet: async (k: string) => kv.get(k),
  kvSet: async (k: string, v: any) => { kv.set(k, v); },
  kvDel: async (k: string) => { kv.delete(k); },
  kvKeys: async (prefix = '') => [...kv.keys()].filter((k) => k.startsWith(prefix)),
}));
vi.mock('../../src/platform/native', async (orig) => ({ ...(await orig<any>()), writeBack: (u: string, b: Blob) => io.writeBack(u, b), saveAs: (b: Blob, n: string) => io.saveAs(b, n), readUri: (u: string) => io.readUri(u) }));

import { DocTab } from '../../src/app';
import { PdfDocument } from '../../src/pdf/document';
import { addTextPages, addImagePage } from '../../src/pdf/build';
import { addRedactMark, applyRedactions, addNote } from '../../src/pdf/ops/annots';
import { analyzeContent, parseContent } from '../../src/pdf/content';
import { PdfStream, Ref, latin1 } from '../../src/pdf/objects';
import { pageAnnotations } from '../../src/pdf/structure';
import { produceBytes, effectiveMode, saveTab, replaceWithBytes, docKey, SNAPSHOTS_KEPT, pruneFileCache } from '../../src/commands/file';
import { getCommand } from '../../src/commands/registry';

function fakeApp(): any {
  const app: any = {
    prefs: { viewMode: 'continuous', saveMode: 'incremental', recent: [], author: 'Tester', confirmClose: true },
    docs: [] as DocTab[], active: null,
    ui: { tabsChanged() {}, status() {}, refresh() {}, hideBackstage() {}, showBackstage() {} },
    docChanged(tab: DocTab) { tab.dirty = true; }, refresh() {}, scheduleAutosave() {}, savePrefs() {}, activate(t: DocTab) { app.active = t; },
    isReadOnly: () => !!app.active?.readOnly,
  };
  Object.defineProperty(app, 'tab', { get: () => app.active });
  Object.defineProperty(app, 'doc', { get: () => app.active.doc });
  return app;
}
function openTab(app: any, bytes: Uint8Array, meta: Partial<DocTab> = {}): DocTab {
  const tab = new DocTab(app, PdfDocument.load(bytes), bytes);
  Object.assign(tab, meta);
  tab.ui = { reload: async () => undefined, page: 0, selectedAnnot: null } as any;
  app.docs.push(tab); app.active = tab;
  return tab;
}
function secretPdf(): Uint8Array {
  const d = PdfDocument.create();
  addTextPages(d, 'Hello world\n\nTOPSECRET 123-45-6789\n\nGoodbye', {});
  addImagePage(d, { kind: 'rgb', data: new Uint8Array(20 * 20 * 3).fill(200), width: 20, height: 20 } as any, { paper: 'image', dpi: 72 });
  return d.save({ incremental: false });
}
const startsWith = (a: Uint8Array, b: Uint8Array) => a.length >= b.length && b.every((v, i) => a[i] === v);
/** Object numbers of the streams that still hold the secret, anywhere in the file. */
function secretObjects(bytes: Uint8Array): number[] {
  const d = PdfDocument.load(bytes);
  return d.objectNumbers().filter((n) => { try { const o = d.fetch(new Ref(n, d.genOf(n))); return o instanceof PdfStream && latin1(d.decoded(o)).includes('TOPSECRET'); } catch { return false; } });
}
function redact(tab: DocTab): void {
  tab.edit('Apply Redactions', () => {
    tab.mustRewrite = true;
    const p = tab.doc.pages[0];
    const run = analyzeContent(tab.doc, parseContent(tab.doc.pageContent(p)), p.resources).runs.find((r) => r.text.includes('TOPSECRET'))!;
    addRedactMark(tab.doc, p, [run.box as any], {});
    return applyRedactions(tab.doc, [0]);
  });
}

beforeEach(() => { kv.clear(); io.writeBack.mockClear(); io.saveAs.mockClear(); io.readUri.mockClear(); io.writeBack.mockImplementation(async () => true); io.saveAs.mockImplementation(async (_b, name) => ({ uri: null, name })); });

describe('saving after content was removed (finding 1, contract C1)', () => {
  it('an incremental update would keep the redacted text; the flag turns it into a rewrite', async () => {
    const app = fakeApp(), orig = secretPdf(), tab = openTab(app, orig);
    // The defect being guarded against: an appended update leaves the original bytes, secret included, in front.
    const leaky = PdfDocument.load(orig);
    const lp = leaky.pages[0];
    addRedactMark(leaky, lp, [analyzeContent(leaky, parseContent(leaky.pageContent(lp)), lp.resources).runs.find((r) => r.text.includes('TOPSECRET'))!.box as any], {});
    applyRedactions(leaky, [0]);
    const appended = leaky.save({ incremental: true });
    expect(startsWith(appended, orig)).toBe(true);
    expect(latin1(PdfDocument.load(appended.subarray(0, orig.length)).pageContent(PdfDocument.load(appended.subarray(0, orig.length)).pages[0]))).toContain('TOPSECRET');

    redact(tab);
    expect(effectiveMode(tab, 'incremental')).toBe('rewrite');
    for (const mode of ['incremental', 'rewrite', 'optimized', 'flat'] as const) {
      const out = await produceBytes(app, tab, mode);
      expect(startsWith(out.data, orig), mode).toBe(false);
      expect(secretObjects(out.data), mode).toEqual([]);
    }
    // The bytes the viewer, drafts and snapshots hold are rewritten too.
    expect(startsWith(tab.bytes, orig)).toBe(false);
    expect(secretObjects(tab.bytes)).toEqual([]);
  });
  it('the review package carries a rewritten PDF as well', async () => {
    const app = fakeApp(), orig = secretPdf(), tab = openTab(app, orig, { title: 'Doc' });
    redact(tab);
    const out = await produceBytes(app, tab, 'qfr');
    const { default: JSZip } = await import('jszip');
    const pdf = await (await JSZip.loadAsync(out.data)).file('Doc.pdf')!.async('uint8array');
    expect(startsWith(pdf, orig)).toBe(false);
    expect(secretObjects(pdf)).toEqual([]);
  });
  it('Save writes the rewrite to the file and only then clears the flag', async () => {
    const app = fakeApp(), orig = secretPdf(), tab = openTab(app, orig, { uri: 'content://doc/1', fileName: 'a.pdf' });
    redact(tab);
    let written: Uint8Array | null = null;
    io.writeBack.mockImplementation(async (_u, blob) => { written = new Uint8Array(await blob.arrayBuffer()); return true; });
    expect(await saveTab(app, tab)).toBe(true);
    expect(startsWith(written!, orig)).toBe(false);
    expect(secretObjects(written!)).toEqual([]);
    expect(tab.mustRewrite).toBe(false);
    expect(tab.dirty).toBe(false);
    // A cancelled Save As leaves the flag set.
    const tab2 = openTab(app, orig);
    redact(tab2);
    io.saveAs.mockImplementation(async () => null);
    expect(await saveTab(app, tab2)).toBe(false);
    expect(tab2.mustRewrite).toBe(true);
  });
  it('without the flag, Save still appends', async () => {
    const app = fakeApp(), orig = secretPdf(), tab = openTab(app, orig);
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 100, 100, { contents: 'hi' }));
    expect(startsWith((await produceBytes(app, tab, 'incremental')).data, orig)).toBe(true);
  });
});

describe('saving while the document is being edited (finding 2)', () => {
  it('keeps an edit made while the file was being written, and stays unsaved', async () => {
    const app = fakeApp(), tab = openTab(app, secretPdf(), { uri: 'content://doc/1', fileName: 'a.pdf' });
    tab.edit('Note 1', () => addNote(tab.doc, tab.doc.pages[0], 100, 100, { contents: 'first' }));
    io.writeBack.mockImplementation(async () => { tab.edit('Note 2', () => addNote(tab.doc, tab.doc.pages[0], 200, 200, { contents: 'second' })); return true; });
    const doc0 = tab.doc;
    expect(await saveTab(app, tab)).toBe(true);
    expect(tab.doc).toBe(doc0); // not replaced by the bytes that were written before the second note
    expect(tab.dirty).toBe(true);
    expect(tab.canUndo).toBe(true);
    const notes = (d: PdfDocument) => pageAnnotations(d, d.pages[0]).filter((a) => a.subtype === 'Text').length;
    expect(notes(tab.doc)).toBe(2);
    expect(notes(PdfDocument.load(tab.bytes))).toBe(2);
  });
  it('adopts the written bytes when nothing changed meanwhile', async () => {
    const app = fakeApp(), tab = openTab(app, secretPdf(), { uri: 'content://doc/1', fileName: 'a.pdf' });
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 100, 100, { contents: 'first' }));
    const doc0 = tab.doc;
    expect(await saveTab(app, tab)).toBe(true);
    expect(tab.doc).not.toBe(doc0);
    expect(tab.dirty).toBe(false);
  });
});

describe('the copy Revert and Open Recent fall back on (finding 3, contract C4)', () => {
  it('is updated by a write-back save', async () => {
    const app = fakeApp(), orig = secretPdf(), tab = openTab(app, orig, { uri: 'content://doc/1', fileName: 'a.pdf' });
    kv.set('file:' + docKey(tab), { name: 'a.pdf', data: orig.buffer, uri: tab.uri, when: 1 });
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 100, 100, { contents: 'saved note' }));
    let written: Uint8Array | null = null;
    io.writeBack.mockImplementation(async (_u, blob) => { written = new Uint8Array(await blob.arrayBuffer()); return true; });
    await saveTab(app, tab);
    const cached = new Uint8Array(kv.get('file:' + docKey(tab)).data);
    expect(cached.length).toBe(written!.length);
    expect(cached.length).toBeGreaterThan(orig.length);
  });
  it('Revert reads the file itself when the platform can, and clears the draft', async () => {
    const app = fakeApp(), orig = secretPdf(), tab = openTab(app, orig, { uri: 'content://doc/1', fileName: 'a.pdf' });
    kv.set('draft:' + tab.id, { bytes: orig.buffer });
    const onDisk = PdfDocument.load(orig); addNote(onDisk, onDisk.pages[0], 100, 100, { contents: 'on disk' });
    const disk = onDisk.save({ incremental: true });
    io.readUri.mockImplementation(async () => ({ name: 'a.pdf', data: disk.buffer.slice(disk.byteOffset, disk.byteOffset + disk.byteLength), uri: tab.uri }));
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 50, 50, { contents: 'unsaved' }));
    const run = getCommand('file.revert')!.run(app) as Promise<void>;
    // The confirmation dialog: press its primary button.
    await vi.waitFor(() => { const b = document.querySelector<HTMLButtonElement>('.ql-dialog .ql-primary'); if (!b) throw new Error('no dialog'); b.click(); });
    await run;
    expect(tab.bytes.length).toBe(disk.length);
    expect(tab.dirty).toBe(false);
    expect(kv.has('draft:' + tab.id)).toBe(false);
  });
  it('snapshots hold no password and old automatic ones are pruned; named ones stay', async () => {
    const app = fakeApp(), tab = openTab(app, secretPdf(), { uri: 'content://doc/1', fileName: 'a.pdf', password: 'hunter2' });
    const prefix = `snap:${docKey(tab)}:`;
    kv.set(`${prefix}1`, { label: 'My milestone', bytes: new ArrayBuffer(1), when: 1 });
    for (let i = 2; i <= SNAPSHOTS_KEPT + 3; i++) kv.set(`${prefix}${i}`, { label: 'Saved', bytes: new ArrayBuffer(1), when: i, password: 'old' });
    await saveTab(app, tab);
    const keys = [...kv.keys()].filter((k) => k.startsWith(prefix));
    expect(keys).toContain(`${prefix}1`);
    expect(keys.length).toBe(SNAPSHOTS_KEPT + 1); // the named one plus the newest automatic ones
    const newest = keys.map((k) => +k.slice(prefix.length)).sort((a, b) => b - a)[0];
    expect(kv.get(`${prefix}${newest}`).password).toBeUndefined();
    expect(JSON.stringify([...kv.entries()].filter(([k]) => +k.slice(prefix.length) === newest))).not.toContain('hunter2');
  });
  it('cached file copies go when they are neither recent nor open', async () => {
    const app = fakeApp(), tab = openTab(app, secretPdf(), { uri: 'content://doc/1' });
    kv.set('file:content://doc/1', {}); kv.set('file:doc:kept', {}); kv.set('file:doc:gone', {}); kv.set('draft:x', {});
    app.prefs.recent = [{ key: 'doc:kept', name: 'k', when: 1 }];
    await pruneFileCache(app);
    expect([...kv.keys()].sort()).toEqual(['draft:x', 'file:content://doc/1', 'file:doc:kept']);
    void tab;
  });
  it('a storage failure does not fail the save', async () => {
    const app = fakeApp(), tab = openTab(app, secretPdf(), { uri: 'content://doc/1', fileName: 'a.pdf' });
    const set = kv.set.bind(kv);
    kv.set = () => { throw new Error('QuotaExceededError'); };
    try { expect(await saveTab(app, tab)).toBe(true); } finally { kv.set = set; }
    expect(tab.dirty).toBe(false);
  });
});

describe('read-only documents (finding 19, contract C2)', () => {
  it('replaceWithBytes refuses a read-only or closed tab', () => {
    const app = fakeApp(), bytes = secretPdf(), tab = openTab(app, bytes);
    const doc0 = tab.doc;
    tab.readOnly = true;
    expect(replaceWithBytes(app, tab, tab.doc.save({ incremental: false }))).toBe(false);
    expect(tab.doc).toBe(doc0);
    tab.readOnly = false;
    expect(replaceWithBytes(app, tab, tab.doc.save({ incremental: false }))).toBe(true);
    expect(tab.doc).not.toBe(doc0);
    app.docs.length = 0;
    expect(replaceWithBytes(app, tab, bytes)).toBe(false);
  });
});
