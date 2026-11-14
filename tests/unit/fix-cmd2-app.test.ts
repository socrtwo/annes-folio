/** App core: undo snapshots, read-only gate, key dispatch, macro recording, drafts, reload coalescing. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App, DocTab, NO_CHANGE, historyLimits, recoverableDraftKeys } from '../../src/app';
import { def } from '../../src/commands/registry';
import { PdfDocument } from '../../src/pdf/document';
import { addBlankPage, imageXObject } from '../../src/pdf/build';
import { PdfStream, Dict } from '../../src/pdf/objects';
import { addNote, addTextMarkup, addImageStamp } from '../../src/pdf/ops/annots';
import { pageAnnotations } from '../../src/pdf/structure';
import { kvGet, kvKeys } from '../../src/util/store';

function freshDoc(): PdfDocument { const d = PdfDocument.create(); addBlankPage(d); return PdfDocument.load(d.save({ incremental: false })); }

function fakeView(): any {
  return { el: document.createElement('div'), layout() {}, reload: vi.fn(async () => undefined), focus() {}, destroy() {}, zoom: 1, setZoom() {}, goToPage() {}, page: 0, selectedText: '', selectionRects: null, selectedAnnot: null, setTool() {}, tool: 'select', refreshAnnotations() {} };
}
function makeApp(): App {
  const app = new App(document.body);
  (app as any).ui = { mountTab(tab: DocTab) { tab.el = document.createElement('div'); tab.ui = fakeView(); }, tabsChanged() {}, refresh() {}, status: vi.fn(), workspace: document.createElement('div') };
  return app;
}
const toasts = () => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent || '');
const startsWith = (a: Uint8Array, b: Uint8Array) => a.length >= b.length && b.every((x, i) => a[i] === x);
const gray = { kind: 'gray', width: 1, height: 1, data: new Uint8Array([0]) } as any;

beforeEach(() => { document.querySelectorAll('.ql-toasts').forEach((t) => t.remove()); localStorage.clear(); });

describe('DocTab undo', () => {
  it('never hands out an object number twice, so a reference kept across undo cannot point at another object', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    tab.edit('Highlight', () => addTextMarkup(tab.doc, tab.doc.pages[0], 'Highlight', [[72, 700, 200, 712]], {}));
    const stale = imageXObject(tab.doc, gray); // what the old image tools did: an object made outside any edit
    tab.edit('Stamp', () => addImageStamp(tab.doc, tab.doc.pages[0], [100, 100, 150, 150], stale, {}));
    tab.undo(); tab.undo();
    expect(tab.doc.size).toBeGreaterThan(stale.num);
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 300, 300, { contents: 'a' }));
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 320, 300, { contents: 'b' }));
    expect(tab.doc.resolve(stale)).toBeNull();
  });

  it('an image created inside the edit is gone from the file after undo', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    let ref: any;
    tab.edit('Stamp', () => { ref = imageXObject(tab.doc, gray); return addImageStamp(tab.doc, tab.doc.pages[0], [100, 100, 150, 150], ref, {}); });
    expect(tab.doc.changed.has(ref.num)).toBe(true);
    tab.undo();
    expect(tab.doc.changed.has(ref.num)).toBe(false);
    expect(new TextDecoder('latin1').decode(tab.bytes)).not.toContain(`${ref.num} 0 obj`);
  });

  it('snapshots share stream bytes with the document instead of copying them', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const ref = tab.edit('Image', () => imageXObject(tab.doc, { kind: 'gray', width: 4, height: 4, data: new Uint8Array(16) } as any))!;
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'x' }));
    const snap = (tab as any).undoStack[1].changed.get(ref.num) as PdfStream;
    expect(snap).toBeInstanceOf(PdfStream);
    expect(snap.raw).toBe((tab.doc.changed.get(ref.num) as PdfStream).raw);
    expect(snap.dict).not.toBe((tab.doc.changed.get(ref.num) as PdfStream).dict);
  });

  it('caps the history by the stream bytes only it still holds, always keeping the latest step', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const blob = (k: number) => new PdfStream(new Dict({ Length: 600 }), new Uint8Array(600).fill(k));
    const ref = tab.edit('Make', () => tab.doc.register(blob(0)))!;
    const steps = () => (tab as any).undoStack.length as number;
    for (let k = 1; k <= 4; k++) tab.edit('Replace', () => tab.doc.update(ref, blob(k)));
    expect(steps()).toBe(5);
    const before = historyLimits.bytes;
    historyLimits.bytes = 1000;
    try {
      tab.edit('Replace', () => tab.doc.update(ref, blob(5)));
      expect(steps()).toBe(1);
      tab.undo();
      expect((tab.doc.resolve(ref) as PdfStream).raw[0]).toBe(4);
    } finally { historyLimits.bytes = before; }
  });

  it('an edit that reports NO_CHANGE leaves no undo step and does not mark the tab changed', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    tab.dirty = false;
    expect(tab.edit('Nothing', () => NO_CHANGE)).toBeUndefined();
    expect(tab.canUndo).toBe(false);
    expect(tab.dirty).toBe(false);
  });

  it('drops a selection that undo removed, and keeps one that is still there', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const a = tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }))!;
    const b = tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 50, 10, { contents: 'b' }))!;
    tab.selection = { kind: 'image', page: 0, index: 3, box: [0, 0, 1, 1] };
    tab.ui.selectedAnnot = { page: 0, num: a.num };
    tab.undo();
    expect(tab.ui.selectedAnnot).toEqual({ page: 0, num: a.num });
    expect(tab.selection).toBeNull();
    tab.redo();
    tab.ui.selectedAnnot = { page: 0, num: b.num };
    tab.undo();
    expect(tab.ui.selectedAnnot).toBeNull();
  });

  it('writes a full rewrite, not an incremental update, while mustRewrite is set', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const base = tab.doc.buf;
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }));
    expect(startsWith(tab.bytes, base)).toBe(true);
    tab.mustRewrite = true;
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 50, 10, { contents: 'b' }));
    expect(startsWith(tab.bytes, base)).toBe(false);
    expect(PdfDocument.load(tab.bytes).pageCount).toBe(1);
  });

  it('keeps the undo history across an incremental save and reload', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const notes = () => pageAnnotations(tab.doc, tab.doc.pages[0]).filter((a) => a.subtype === 'Text').map((a) => a.contents);
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'one' }));
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 50, 10, { contents: 'two' }));
    tab.undo();
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 90, 10, { contents: 'three' }));
    // What Save does: write an incremental update, load it, replace the tab's document.
    const saved = tab.doc.save({ incremental: true });
    tab.replace(PdfDocument.load(saved), saved);
    expect(notes()).toEqual(['one', 'three']);
    expect(tab.canUndo).toBe(true);
    tab.undo();
    expect(notes()).toEqual(['one']);
    tab.undo();
    expect(notes()).toEqual([]);
    // The undone state saves and reloads as a valid file, and redo brings the notes back.
    expect(pageAnnotations(PdfDocument.load(tab.bytes), PdfDocument.load(tab.bytes).pages[0]).length).toBe(0);
    tab.redo(); tab.redo();
    expect(notes()).toEqual(['one', 'three']);
    const again = PdfDocument.load(tab.bytes);
    expect(pageAnnotations(again, again.pages[0]).filter((a) => a.subtype === 'Text').map((a) => a.contents)).toEqual(['one', 'three']);
  });

  it('keeps the undo history across a save of a file with object and cross-reference streams', () => {
    const app = makeApp();
    const d = PdfDocument.create(); addBlankPage(d);
    const tab = app.createTab(PdfDocument.load(d.save({ incremental: false, objectStreams: true })));
    expect(tab.doc.usesXrefStream).toBe(true);
    const notes = () => pageAnnotations(tab.doc, tab.doc.pages[0]).filter((a) => a.subtype === 'Text').map((a) => a.contents);
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'one' }));
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 50, 10, { contents: 'two' }));
    const saved = tab.doc.save({ incremental: true });
    tab.replace(PdfDocument.load(saved), saved);
    expect(notes()).toEqual(['one', 'two']);
    tab.undo();
    expect(notes()).toEqual(['one']);
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 90, 10, { contents: 'three' }));
    const again = PdfDocument.load(tab.bytes);
    expect(pageAnnotations(again, again.pages[0]).filter((a) => a.subtype === 'Text').map((a) => a.contents)).toEqual(['one', 'three']);
    tab.undo(); tab.undo();
    const empty = PdfDocument.load(tab.bytes);
    expect(pageAnnotations(empty, empty.pages[0]).length).toBe(0);
  });

  it('starts the history again, and says so once, when the document is replaced by other bytes', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'one' }));
    const rewritten = tab.doc.save({ incremental: false });
    tab.replace(PdfDocument.load(rewritten), rewritten);
    expect(tab.canUndo).toBe(false);
    expect(toasts().some((t) => /Undo starts again/.test(t))).toBe(true);
    // Reverting to the saved file (same base, no appended changes) must not be mistaken for a save.
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'two' }));
    tab.replace(PdfDocument.load(rewritten), rewritten);
    expect(tab.canUndo).toBe(false);
  });
});

describe('read-only documents', () => {
  it('refuses every command that is not marked edits:false, and DocTab.edit itself', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const ran: string[] = [];
    def([{ id: 'test.modify', label: 'Modify', tab: 'T', run: () => { ran.push('modify'); } }, { id: 'test.look', label: 'Look', tab: 'T', edits: false, run: () => { ran.push('look'); } }]);
    tab.readOnly = true;
    expect(app.exec('test.modify')).toBe(false);
    app.exec('test.look');
    expect(ran).toEqual(['look']);
    expect(tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }))).toBeUndefined();
    expect(pageAnnotations(tab.doc, tab.doc.pages[0]).length).toBe(0);
    expect(toasts().filter((t) => /read-only/.test(t)).length).toBeGreaterThan(0);
  });

  it('editTab writes to the tab it was given, not the active one, and refuses a closed tab', () => {
    const app = makeApp();
    const a = app.createTab(freshDoc());
    const b = app.createTab(freshDoc());
    expect(app.tab).toBe(b);
    app.editTab(a, 'Note', (doc) => addNote(doc, doc.pages[0], 10, 10, { contents: 'for a' }));
    expect(pageAnnotations(a.doc, a.doc.pages[0]).filter((x) => x.subtype === 'Text').length).toBe(1);
    expect(pageAnnotations(b.doc, b.doc.pages[0]).length).toBe(0);
    app.closeTab(a);
    expect(app.editTab(a, 'Note', (doc) => addNote(doc, doc.pages[0], 10, 10, { contents: 'late' }))).toBeUndefined();
    expect(app.stillOpen(b, new Uint8Array(1))).toBe(false);
  });
});

describe('commands and keys', () => {
  it('handleKey runs an available command and leaves the key alone otherwise', () => {
    const app = makeApp();
    app.createTab(freshDoc());
    let on = false, runs = 0;
    def({ id: 'test.keyed', label: 'Keyed', tab: 'T', edits: false, keys: ['Mod-Alt-F9'], isEnabled: () => on, run: () => { runs++; } });
    app.rebuildKeyIndex();
    expect(app.handleKey('Mod-Alt-F9')).toBe(false);
    expect(toasts()).toEqual([]);
    on = true;
    expect(app.handleKey('Mod-Alt-F9')).toBe(true);
    expect(runs).toBe(1);
    expect(app.handleKey('Mod-Alt-F10')).toBe(false);
    expect(app.commandForKey('Mod-Alt-F9')?.id).toBe('test.keyed');
  });

  it('records a step whose argument cannot be written as JSON without stopping the command', () => {
    const app = makeApp();
    app.createTab(freshDoc());
    let runs = 0;
    def({ id: 'test.arg', label: 'Arg', tab: 'T', edits: false, run: () => { runs++; } });
    app.recording = { name: 'R', steps: [] };
    const circ: any = {}; circ.self = circ;
    app.exec('test.arg', circ);
    app.exec('test.arg', { n: 1 });
    app.recordingPaused = true;
    app.exec('test.arg', { n: 2 });
    expect(runs).toBe(3);
    expect(app.recording!.steps).toEqual([{ id: 'test.arg' }, { id: 'test.arg', arg: { n: 1 } }]);
  });

  it('folds reload requests that arrive during a reload into one more reload', async () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    let active = 0, max = 0, total = 0;
    tab.ui.reload = vi.fn(async () => { active++; total++; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 15)); active--; });
    for (let i = 0; i < 6; i++) app.docChanged(tab);
    await new Promise((r) => setTimeout(r, 120));
    expect(max).toBe(1);
    expect(total).toBe(2);
    app.docChanged(tab);
    await new Promise((r) => setTimeout(r, 40));
    expect(total).toBe(3);
  });

  it('closing a tab that is not in front keeps the front tab, and closing a side-by-side tab ends the split', () => {
    const app = makeApp();
    const a = app.createTab(freshDoc());
    const b = app.createTab(freshDoc());
    const c = app.createTab(freshDoc());
    app.split = a.id; a.el.classList.add('ql-split-pane'); (app.ui as any).workspace.classList.add('ql-split');
    app.closeTab(a);
    expect(app.tab).toBe(c);
    expect(app.split).toBeNull();
    expect((app.ui as any).workspace.classList.contains('ql-split')).toBe(false);
    app.closeTab(c);
    expect(app.tab).toBe(b);
  });
});

describe('drafts', () => {
  it('stores the bytes but never the password, and reports only what was stored', async () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    tab.password = 'secret';
    tab.dirty = false;
    expect(await app.saveDrafts()).toBe(0);
    expect((app.ui as any).status).not.toHaveBeenCalled();
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }));
    expect(await app.saveDrafts()).toBe(1);
    expect((app.ui as any).status).toHaveBeenCalledWith('Draft saved');
    const d = await kvGet('draft:' + tab.id);
    expect(d.password).toBeUndefined();
    expect(JSON.stringify(Object.keys(d))).not.toContain('password');
    expect(new Uint8Array(d.bytes).length).toBe(tab.bytes.length);
    expect(PdfDocument.load(new Uint8Array(d.bytes)).pageCount).toBe(1);
  });

  it('says so when a draft cannot be stored', async () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }));
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try { expect(await app.saveDrafts()).toBe(0); } finally { spy.mockRestore(); }
    expect((app.ui as any).status).not.toHaveBeenCalledWith('Draft saved');
    expect(toasts().some((t) => /could not be stored/.test(t))).toBe(true);
  });

  it('offers drafts of earlier sessions for recovery, not this window\'s own tabs', async () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }));
    await app.saveDrafts();
    localStorage.setItem('qlkv:draft:tabc1230', JSON.stringify({ title: 'old' }));
    expect((await kvKeys('draft:')).length).toBe(2);
    expect(await recoverableDraftKeys(app)).toEqual(['draft:tabc1230']);
  });
});
