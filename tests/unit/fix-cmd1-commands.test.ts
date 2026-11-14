import { describe, it, expect, vi, beforeEach } from 'vitest';

// Scripted answers for the dialogs a command opens, in order; platform file access and file picking are stand-ins.
const answers: any[] = [];
const asked: any[] = [];
const toasts: string[] = [];
const next = (opts: any) => { asked.push(opts); const a = answers.shift(); return typeof a === 'function' ? a(opts) : a; };
const io = { saveAs: vi.fn(async (_b: Blob, name: string): Promise<{ uri: string | null; name: string } | null> => ({ uri: null, name })), files: [] as any[] };
vi.mock('../../src/ui/dialog', async (orig) => ({
  ...(await orig<any>()),
  openDialog: async (opts: any) => next(opts),
  confirmDialog: async (title: string, message: string) => next({ confirm: title, message }),
  promptDialog: async (title: string, label: string) => next({ prompt: title, label }),
  toast: (msg: string) => { toasts.push(msg); },
}));
vi.mock('../../src/ui/dom', async (orig) => ({ ...(await orig<any>()), pickFile: async () => io.files }));
vi.mock('../../src/platform/native', async (orig) => ({ ...(await orig<any>()), saveAs: (b: Blob, n: string) => io.saveAs(b, n), writeClipboardText: async () => true }));
vi.mock('../../src/util/store', () => ({ kvGet: async () => undefined, kvSet: async () => undefined, kvDel: async () => undefined, kvKeys: async () => [] }));

import '../../src/commands/index';
import { DocTab } from '../../src/app';
import { getCommand, allCommands } from '../../src/commands/registry';
import { PdfDocument } from '../../src/pdf/document';
import { addTextPages } from '../../src/pdf/build';
import { analyzeContent, parseContent } from '../../src/pdf/content';
import { addRedactMark } from '../../src/pdf/ops/annots';
import * as util from '../../src/commands/util';

function fakeApp(): any {
  const app: any = {
    prefs: { viewMode: 'continuous', saveMode: 'incremental', recent: [], author: 'Tester', confirmClose: true, ocrLanguage: 'eng' },
    docs: [] as DocTab[], active: null,
    ui: { tabsChanged() {}, status() {}, refresh() {}, hideBackstage() {}, openPane() {}, paneOpen: () => true },
    docChanged(tab: DocTab) { tab.dirty = true; }, refresh() {}, scheduleAutosave() {}, savePrefs() {}, activate(t: DocTab) { app.active = t; }, focus() {},
    isReadOnly: () => !!app.active?.readOnly,
    createTab(doc: PdfDocument, meta: Partial<DocTab>, bytes: Uint8Array) { const t = mount(app, new DocTab(app, doc, bytes)); Object.assign(t, meta); return t; },
    edit(label: string, fn: any) { const t = app.active; return t.edit(label, () => fn(t.doc, t)); },
    exec() {},
  };
  Object.defineProperty(app, 'tab', { get: () => app.active });
  Object.defineProperty(app, 'doc', { get: () => app.active.doc });
  Object.defineProperty(app, 'page', { get: () => app.active.ui.page });
  Object.defineProperty(app, 'viewer', { get: () => app.active.ui });
  return app;
}
function mount(app: any, tab: DocTab): DocTab {
  tab.ui = { page: 0, pageSel: [] as number[], selectedAnnot: null, selectedText: '', reload: async () => undefined, goToPage() {}, setTool() {}, targetPages() { return this.pageSel.length ? [...this.pageSel].sort((a: number, b: number) => a - b) : [this.page]; }, pageLabels: () => [] } as any;
  app.docs.push(tab); app.active = tab;
  return tab;
}
function pdf(pages: number, text = 'page'): Uint8Array {
  const d = PdfDocument.create();
  for (let i = 0; i < pages; i++) addTextPages(d, `${text} ${i + 1}`, {});
  return d.save({ incremental: false });
}
const open = (app: any, bytes: Uint8Array, meta: Partial<DocTab> = {}) => Object.assign(mount(app, new DocTab(app, PdfDocument.load(bytes), bytes)), meta);
const file = (name: string, bytes: Uint8Array, type = 'application/pdf'): any => ({ name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const run = (id: string, app: any, arg?: any) => getCommand(id)!.run(app, arg) as Promise<unknown>;
const pageTexts = (d: PdfDocument) => d.pages.map((p) => analyzeContent(d, parseContent(d.pageContent(p)), p.resources).runs.map((r) => r.text).join(' '));

beforeEach(() => { answers.length = 0; asked.length = 0; toasts.length = 0; io.files = []; io.saveAs.mockReset(); io.saveAs.mockImplementation(async (_b, name) => ({ uri: null, name })); });

describe('Extract Pages with "remove the pages" (finding 8)', () => {
  it('keeps the pages when the save was cancelled', async () => {
    const app = fakeApp(), tab = open(app, pdf(5));
    answers.push({ range: '2-3', what: 'save', remove: true });
    io.saveAs.mockImplementation(async () => null);
    await run('organize.extract', app);
    expect(tab.doc.pageCount).toBe(5);
    expect(tab.canUndo).toBe(false);
  });
  it('removes them after a successful save and clears the selection of the document they came from', async () => {
    const app = fakeApp(), tab = open(app, pdf(5));
    (tab.ui as any).pageSel = [1, 2];
    answers.push({ range: '2-3', what: 'open', remove: true });
    await run('organize.extract', app);
    expect(app.docs.length).toBe(2);
    expect(app.active).not.toBe(tab); // the extract opened in a new tab
    expect(app.active.doc.pageCount).toBe(2);
    expect(tab.doc.pageCount).toBe(3);
    expect((tab.ui as any).pageSel).toEqual([]);
  });
  it('does not remove pages from a read-only document', async () => {
    const app = fakeApp(), tab = open(app, pdf(5), { readOnly: true });
    answers.push({ range: '2-3', what: 'save', remove: true });
    await run('organize.extract', app);
    expect(io.saveAs).toHaveBeenCalledTimes(1);
    expect(tab.doc.pageCount).toBe(5);
  });
});

describe('Replace Pages (finding 12)', () => {
  it('deletes nothing when the source range names no page', async () => {
    for (const range of ['0', 'abc', '', '9-12']) {
      const app = fakeApp(), tab = open(app, pdf(5));
      (tab.ui as any).pageSel = [1, 2];
      io.files = [file('src.pdf', pdf(3, 'new'))];
      answers.push({ range });
      await run('organize.replace', app);
      expect(tab.doc.pageCount, range).toBe(5);
      expect(tab.canUndo, range).toBe(false);
    }
  });
  it('replaces the selection with the chosen pages', async () => {
    const app = fakeApp(), tab = open(app, pdf(5));
    (tab.ui as any).pageSel = [1, 2];
    io.files = [file('src.pdf', pdf(3, 'new'))];
    answers.push({ range: '1 - 2' });
    await run('organize.replace', app);
    expect(pageTexts(tab.doc)).toEqual(['page 1', 'new 1', 'new 2', 'page 4', 'page 5']);
  });
});

describe('Bates numbering start (lower-priority list)', () => {
  it('starts at 0 when asked to', async () => {
    const app = fakeApp(), tab = open(app, pdf(2));
    answers.push({ range: '1-2', prefix: 'ABC', suffix: '', start: 0, digits: 4, pos: 'bottom-right', size: 9 });
    await run('organize.bates', app);
    expect(pageTexts(tab.doc)[0]).toContain('ABC0000');
    expect(pageTexts(tab.doc)[1]).toContain('ABC0001');
  });
});

describe('Batch (findings 5e and 17)', () => {
  it('says which files are missing from a merge', async () => {
    const app = fakeApp(); open(app, pdf(1));
    const locked = PdfDocument.load(pdf(2)).save({ incremental: false, encrypt: { userPassword: 'pw', ownerPassword: 'own', permissions: {} } });
    io.files = [file('a.pdf', pdf(2)), file('locked.pdf', locked), file('b.pdf', pdf(1))];
    answers.push({ op: 'merge' });
    await run('tools.batch', app);
    expect(app.active.doc.pageCount).toBe(3);
    expect(toasts.join('\n')).toMatch(/2 of 3 file\(s\) merged; 1 could not be read and is missing/);
  });
  it('refuses to encrypt without an open password and never uses a built-in owner password', async () => {
    const app = fakeApp(); open(app, pdf(1));
    io.files = [file('a.pdf', pdf(1))];
    let saved: Uint8Array | null = null;
    io.saveAs.mockImplementation(async (b, name) => { saved = new Uint8Array(await b.arrayBuffer()); return { uri: null, name }; });
    answers.push((opts: any) => {
      expect(opts.validate({ op: 'encrypt', pw: '', pw2: '', opw: '' })).toMatch(/Enter an open password/);
      expect(opts.validate({ op: 'encrypt', pw: 'a', pw2: 'b', opw: '' })).toMatch(/do not match/);
      expect(opts.validate({ op: 'encrypt', pw: 'a', pw2: 'a', opw: 'a' })).toMatch(/must differ/);
      expect(opts.validate({ op: 'encrypt', pw: 'a', pw2: 'a', opw: '' })).toBeNull();
      return { op: 'encrypt', pw: 'a', pw2: 'a', opw: '' };
    });
    answers.push(null); // the generated permissions password is shown
    await run('tools.batch', app);
    const { default: JSZip } = await import('jszip');
    const out = await (await JSZip.loadAsync(saved!)).file('a.pdf')!.async('uint8array');
    expect(() => PdfDocument.load(out)).toThrow();
    expect(PdfDocument.load(out, { password: 'a' }).securityInfo!.ownerAccess).toBe(false);
    expect(() => PdfDocument.load(out, { password: 'owner' })).toThrow();
    const shown = asked[asked.length - 1];
    expect(shown.title).toBe('Permissions Password');
    expect(PdfDocument.load(out, { password: shown.fields[0].value }).securityInfo!.ownerAccess).toBe(true);
  });
  it('keeps results with the same name apart', async () => {
    const app = fakeApp(); open(app, pdf(1));
    io.files = [file('scan.pdf', pdf(1)), file('scan.txt', new TextEncoder().encode('hello'), 'text/plain')];
    let saved: Uint8Array | null = null;
    io.saveAs.mockImplementation(async (b, name) => { saved = new Uint8Array(await b.arrayBuffer()); return { uri: null, name }; });
    answers.push({ op: 'optimize' });
    await run('tools.batch', app);
    const { default: JSZip } = await import('jszip');
    expect(Object.keys((await JSZip.loadAsync(saved!)).files).sort()).toEqual(['batch-log.txt', 'scan (2).pdf', 'scan.pdf']);
  });
});

describe('passwords (finding 5)', () => {
  const perms = { print: true, printHigh: true, copy: true, accessibility: true, modify: true, annotate: true, fillForms: true, assemble: true, meta: true };
  it('Encrypt with only an open password generates and shows a permissions password, and the security can be removed again', async () => {
    const app = fakeApp(), tab = open(app, pdf(1));
    answers.push((opts: any) => {
      expect(opts.validate({ user: 'abc', user2: 'abc', owner: 'abc', owner2: 'abc' })).toMatch(/must differ/);
      return { user: 'abc', user2: 'abc', owner: '', owner2: '', ...perms };
    });
    answers.push(null); // the generated password dialog
    await run('protect.encrypt', app);
    const shown = asked[asked.length - 1];
    expect(shown.title).toBe('Permissions Password');
    const owner = shown.fields[0].value as string;
    expect(owner).toMatch(/^[A-HJ-NP-Z2-9-]{23}$/);
    expect(() => PdfDocument.load(tab.bytes)).toThrow();
    expect(PdfDocument.load(tab.bytes, { password: 'abc' }).securityInfo!.ownerAccess).toBe(false);
    expect(PdfDocument.load(tab.bytes, { password: owner }).securityInfo!.ownerAccess).toBe(true);
    // Whoever just set the protection can take it off again without being locked out.
    await run('protect.removeSecurity', app);
    expect(tab.doc.security).toBeNull();
    expect(PdfDocument.load(tab.bytes).pageCount).toBe(1);
  });
  it('Remove Security on a reopened file asks for the permissions password and rejects the open password', async () => {
    const app = fakeApp();
    const enc = PdfDocument.load(pdf(1)).save({ incremental: false, encrypt: { userPassword: 'u', ownerPassword: 'o', permissions: {} } });
    const tab = mount(app, new DocTab(app, PdfDocument.load(enc, { password: 'u' }), enc)); tab.password = 'u';
    answers.push('u');
    await run('protect.removeSecurity', app);
    expect(tab.doc.security).not.toBeNull();
    expect(toasts.join('\n')).toMatch(/password to open the document/);
    answers.push('o');
    await run('protect.removeSecurity', app);
    expect(tab.doc.security).toBeNull();
  });
  it('Permissions keeps a file without an open password openable when it was opened with its permissions password', async () => {
    const app = fakeApp();
    const enc = PdfDocument.load(pdf(1)).save({ incremental: false, encrypt: { userPassword: '', ownerPassword: 'own', permissions: { print: false } } });
    const tab = mount(app, new DocTab(app, PdfDocument.load(enc, { password: 'own' }), enc)); tab.password = 'own';
    answers.push((opts: any) => { expect(opts.fields.some((f: any) => f.key === 'user')).toBe(false); return { owner: '', owner2: '', ...perms }; });
    await run('protect.permissions', app);
    const again = PdfDocument.load(tab.bytes); // still opens with no password: the permissions password did not become the open password
    expect(again.securityInfo!.permissions.print).toBe(true);
    expect(PdfDocument.load(tab.bytes, { password: 'own' }).securityInfo!.ownerAccess).toBe(true);
  });
  it('Permissions asks for the open password when it cannot be known, instead of using the permissions password', async () => {
    const app = fakeApp();
    const enc = PdfDocument.load(pdf(1)).save({ incremental: false, encrypt: { userPassword: 'u', ownerPassword: 'o', permissions: {} } });
    const tab = mount(app, new DocTab(app, PdfDocument.load(enc, { password: 'o' }), enc)); tab.password = 'o';
    answers.push((opts: any) => { expect(opts.fields.some((f: any) => f.key === 'user')).toBe(true); return { user: 'u', user2: 'u', owner: '', owner2: '', ...perms }; });
    await run('protect.permissions', app);
    expect(PdfDocument.load(tab.bytes, { password: 'u' }).securityInfo!.ownerAccess).toBe(false);
    expect(PdfDocument.load(tab.bytes, { password: 'o' }).securityInfo!.ownerAccess).toBe(true);
  });
  it('Change Open Password keeps the permissions password', async () => {
    const app = fakeApp();
    const enc = PdfDocument.load(pdf(1)).save({ incremental: false, encrypt: { userPassword: 'u', ownerPassword: 'o', permissions: {} } });
    const tab = mount(app, new DocTab(app, PdfDocument.load(enc, { password: 'o' }), enc)); tab.password = 'o';
    answers.push((opts: any) => { expect(opts.fields.some((f: any) => f.key === 'o1')).toBe(false); return { p1: 'new', p2: 'new' }; });
    await run('protect.setOpenPassword', app);
    expect(() => PdfDocument.load(tab.bytes, { password: 'u' })).toThrow();
    expect(PdfDocument.load(tab.bytes, { password: 'new' }).securityInfo!.ownerAccess).toBe(false);
    expect(PdfDocument.load(tab.bytes, { password: 'o' }).securityInfo!.ownerAccess).toBe(true);
  });
});

describe('removal commands mark the tab for a rewrite (finding 1, contract C1)', () => {
  it('Apply Redactions, Sanitize and the Remove commands set mustRewrite; marking does not', async () => {
    const orig = pdf(2);
    const marked = () => { const app = fakeApp(), tab = open(app, orig); return { app, tab }; };
    let { app, tab } = marked();
    tab.edit('mark', () => addRedactMark(tab.doc, tab.doc.pages[0], [[72, 600, 300, 720]], {}));
    expect(tab.mustRewrite).toBe(false);
    answers.push((opts: any) => { expect(opts.fields.find((f: any) => f.key === 'log').value).toBe(false); return { sanitize: false, log: false }; });
    await run('protect.applyRedactions', app);
    expect(tab.mustRewrite).toBe(true);
    expect(tab.bytes.subarray(0, orig.length).every((v, i) => v === orig[i])).toBe(false);
    for (const id of ['protect.removeMetadata', 'protect.removeJavaScript']) {
      ({ app, tab } = marked());
      await run(id, app);
      expect(tab.mustRewrite, id).toBe(true);
    }
    ({ app, tab } = marked());
    answers.push((opts: any) => {
      const layers = opts.fields.find((f: any) => f.key === 'hiddenLayers');
      expect(layers.value).toBe(false);
      expect(layers.label).toMatch(/not removed/);
      return { metadata: true };
    });
    await run('protect.sanitize', app);
    expect(tab.mustRewrite).toBe(true);
  });
});

describe('read-only gate and shortcuts (finding 19, contract C2, lower-priority list)', () => {
  it('marks commands that do not change the document, and only those', () => {
    const viewing = ['file.save', 'file.saveAs', 'file.open', 'file.print', 'file.share', 'file.close', 'file.options', 'file.export.text', 'organize.extract', 'organize.split', 'organize.combineFiles', 'organize.selectAll', 'protect.securityInfo', 'protect.hiddenInfo', 'protect.markFinal', 'sign.verify', 'sign.manageSignatures', 'forms.exportData', 'forms.fillMode', 'scan.fromImages', 'scan.languages', 'scan.exportText', 'tools.extractText', 'tools.extractImages', 'tools.batch', 'tools.openAttachment', 'tools.pageInfo'];
    const editing = ['file.revert', 'organize.delete', 'organize.insertBlank', 'organize.rotateLeft', 'organize.watermark', 'protect.encrypt', 'protect.permissions', 'protect.removeSecurity', 'protect.setOpenPassword', 'protect.applyRedactions', 'protect.sanitize', 'protect.redactArea', 'sign.signature', 'sign.requestSignatures', 'forms.importData', 'forms.flatten', 'forms.textField', 'scan.recognize', 'scan.despeckle', 'scan.fromCamera', 'tools.optimize', 'tools.reduceSize', 'tools.compressImages', 'tools.rewrite', 'tools.addBookmark', 'tools.editXmp'];
    for (const id of viewing) expect(getCommand(id)?.edits, id).toBe(false);
    for (const id of editing) expect(getCommand(id)?.edits, id).not.toBe(false);
    // Every File (backstage) command except Revert leaves the document alone.
    for (const c of allCommands().filter((x) => x.id.startsWith('file.') && x.id !== 'file.revert')) expect(c.edits, c.id).toBe(false);
  });
  it('rewriting commands leave a read-only document alone even when run directly', async () => {
    const app = fakeApp(), tab = open(app, pdf(2), { readOnly: true });
    const doc0 = tab.doc, bytes0 = tab.bytes;
    for (const id of ['tools.rewrite', 'tools.optimize', 'protect.encrypt', 'protect.permissions']) await run(id, app);
    await run('tools.reduceSize', app, 'lossless');
    expect(tab.doc).toBe(doc0);
    expect(tab.bytes).toBe(bytes0);
    expect(asked.length).toBe(0);
  });
  it('Ctrl+Shift+S is Save As; Sign moved to Ctrl+Alt+G, and neither key is bound twice', () => {
    expect(getCommand('file.saveAs')!.keys).toContain('Mod-Shift-s');
    expect(getCommand('sign.signature')!.keys).toEqual(['Mod-Alt-g']);
    const all = allCommands().flatMap((c) => (c.keys || []).map((k) => k.toLowerCase()));
    expect(all.filter((k) => k === 'mod-shift-s').length).toBe(1);
    expect(all.filter((k) => k === 'mod-alt-g').length).toBe(1);
  });
});

describe('image placement helpers (finding 7, contract C3)', () => {
  it('imageRefFromFile is gone; imageSpecFromFile takes no document', () => {
    expect((util as any).imageRefFromFile).toBeUndefined();
    expect(util.imageSpecFromFile.length).toBe(1);
  });
});
