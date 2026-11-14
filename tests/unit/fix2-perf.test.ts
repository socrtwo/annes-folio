/** Per-edit cost: which pages an edit changed (page tokens), the tab's change record, drafts and autosave. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { App, DocTab } from '../../src/app';
import { PdfDocument } from '../../src/pdf/document';
import { addBlankPage, addTextPages } from '../../src/pdf/build';
import { Dict, Name, PdfStream, PdfString, Ref, type PdfObj } from '../../src/pdf/objects';
import { addTextMarkup, addNote } from '../../src/pdf/ops/annots';
import { rotatePages, deletePages, movePages } from '../../src/pdf/ops/pages';
import { PageChangeTracker, overlayDiff, samePdfObj, pageClosure } from '../../src/view/pagechange';
import * as store from '../../src/util/store';

function fortyPages(): PdfDocument {
  const d = PdfDocument.create();
  addTextPages(d, Array.from({ length: 40 }, (_, i) => `# Page ${i + 1}\n\n` + 'Words on the page. '.repeat(300)).join('\n\n'));
  const out = PdfDocument.load(d.save({ incremental: false }));
  expect(out.pageCount).toBeGreaterThanOrEqual(40);
  return out;
}
function makeApp(): App {
  const app = new App(document.body);
  (app as any).ui = { mountTab(tab: DocTab) { tab.el = document.createElement('div'); tab.ui = { el: tab.el, layout() {}, reload: vi.fn(async () => undefined), focus() {}, destroy() {}, refreshAnnotations() {}, selectedAnnot: null } as any; }, tabsChanged() {}, refresh() {}, status: vi.fn(), workspace: document.createElement('div') };
  app.prefs.autosave = false;
  return app;
}
/** Tokens before and after a change, through the tab's change record, as the viewer takes them. */
function changedPages(tab: DocTab, tracker: PageChangeTracker, act: () => void): number[] {
  let c = tab.takeChanges();
  const before = tracker.tokens(tab.doc, c.touched, c.numbering);
  act();
  c = tab.takeChanges();
  const after = tracker.tokens(tab.doc, c.touched, c.numbering);
  return after.map((t, i) => (t !== before[i] ? i : -1)).filter((i) => i >= 0);
}

describe('samePdfObj and overlayDiff', () => {
  it('compares contents, not identity', () => {
    const a = new Dict({ Type: Name.get('Annot'), Rect: [1, 2, 3, 4], T: new PdfString(new Uint8Array([65])), P: new Ref(3, 0) });
    const b = new Dict({ Type: Name.get('Annot'), Rect: [1, 2, 3, 4], T: new PdfString(new Uint8Array([65])), P: new Ref(3, 0) });
    expect(samePdfObj(a, b)).toBe(true);
    b.set('Rect', [1, 2, 3, 5]);
    expect(samePdfObj(a, b)).toBe(false);
    const raw = new Uint8Array([1, 2, 3]);
    expect(samePdfObj(new PdfStream(new Dict(), raw), new PdfStream(new Dict(), raw))).toBe(true);
    expect(samePdfObj(new PdfStream(new Dict(), raw), new PdfStream(new Dict(), new Uint8Array([1, 2, 4])))).toBe(false);
  });

  it('an object touched without being changed is compared with the file and counts as unchanged', () => {
    const file = new Map<number, PdfObj | null>([[7, new Dict({ A: 1 })]]);
    const before = new Map<number, PdfObj | null>();
    const after = new Map<number, PdfObj | null>([[7, new Dict({ A: 1 })], [8, new Dict({ B: 2 })]]);
    expect([...overlayDiff(before, after)].sort()).toEqual([7, 8]);
    expect([...overlayDiff(before, after, (nums) => new Map(nums.filter((n) => file.has(n)).map((n) => [n, file.get(n)!])))]).toEqual([8]);
  });
});

describe('page tokens', () => {
  it('annotating page 5 of 40 changes only page 5', () => {
    const tab = makeApp().createTab(fortyPages());
    const tr = new PageChangeTracker();
    expect(changedPages(tab, tr, () => tab.edit('Highlight', () => addTextMarkup(tab.doc, tab.doc.pages[4], 'Highlight', [[72, 700, 200, 712]], {})))).toEqual([4]);
    expect(changedPages(tab, tr, () => tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[4], 100, 100, { contents: 'x' })))).toEqual([4]);
  });

  it('rotating page 5 changes only page 5, and undo and redo only page 5 again', () => {
    const tab = makeApp().createTab(fortyPages());
    const tr = new PageChangeTracker();
    expect(changedPages(tab, tr, () => tab.edit('Rotate', () => rotatePages(tab.doc, [4], 90)))).toEqual([4]);
    expect(changedPages(tab, tr, () => tab.undo())).toEqual([4]);
    expect(changedPages(tab, tr, () => tab.redo())).toEqual([4]);
    expect(tab.doc.pages[4].rotate).toBe(90);
  });

  it('an edit that touches every page without changing it (deleting page 1 flattens the tree) changes no other page', () => {
    const tab = makeApp().createTab(fortyPages());
    const tr = new PageChangeTracker();
    let c = tab.takeChanges();
    const before = tr.tokens(tab.doc, c.touched, c.numbering);
    tab.edit('Delete', () => deletePages(tab.doc, [0]));
    c = tab.takeChanges();
    const after = tr.tokens(tab.doc, c.touched, c.numbering);
    expect(after).toEqual(before.slice(1)); // every remaining page keeps its token, at its new place
  });

  it('moving pages keeps their tokens', () => {
    const tab = makeApp().createTab(fortyPages());
    const tr = new PageChangeTracker();
    let c = tab.takeChanges();
    const before = tr.tokens(tab.doc, c.touched, c.numbering);
    tab.edit('Move', () => movePages(tab.doc, [0], 3));
    c = tab.takeChanges();
    expect(new Set(tr.tokens(tab.doc, c.touched, c.numbering))).toEqual(new Set(before));
  });

  it('a change to something pages share (a font) changes every page that uses it', () => {
    const tab = makeApp().createTab(fortyPages());
    const tr = new PageChangeTracker();
    const fontRef = (() => { for (const p of tab.doc.pages) { const f = tab.doc.getDict(p.resources, 'Font'); for (const v of f?.map.values() || []) if (v instanceof Ref) return v; } return null; })()!;
    expect(fontRef).toBeInstanceOf(Ref);
    const users = tab.doc.pages.map((p, i) => (pageClosure(tab.doc, p).has(fontRef.num) ? i : -1)).filter((i) => i >= 0);
    expect(users.length).toBeGreaterThan(1);
    expect(changedPages(tab, tr, () => tab.edit('Font', () => { const f = tab.doc.fetch(fontRef) as Dict; f.set('BaseFont', Name.get('Courier')); tab.doc.touch(fontRef); }))).toEqual(users);
  });

  it('a change to the form dictionary or an unknown change redraws every page', () => {
    const tab = makeApp().createTab(fortyPages());
    const tr = new PageChangeTracker();
    const n = tab.doc.pageCount;
    expect(changedPages(tab, tr, () => tab.edit('Form', () => { tab.doc.catalog.set('AcroForm', new Dict({ NeedAppearances: true, Fields: [] })); tab.doc.touch(tab.doc.catalogRef); }))).toHaveLength(n);
    expect(changedPages(tab, tr, () => tab.afterChange())).toHaveLength(n);
  });

  it('a document numbered differently (reloaded from a rewrite) redraws every page; one carried over with its history does not', () => {
    const tab = makeApp().createTab(fortyPages());
    const tr = new PageChangeTracker();
    const n = tab.doc.pageCount;
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[2], 100, 100, { contents: 'x' }));
    // An incremental save of exactly this tab's changes: the history is kept and the numbering is the same.
    expect(changedPages(tab, tr, () => { const b = tab.doc.save({ incremental: true }); tab.replace(PdfDocument.load(b), b); })).toEqual([]);
    expect(changedPages(tab, tr, () => { const b = tab.doc.save({ incremental: false }); tab.clearHistory(); tab.replace(PdfDocument.load(b), b); })).toHaveLength(n);
  });

  it('the first call, and the call after reset(), change every page', () => {
    const doc = fortyPages();
    const tr = new PageChangeTracker();
    const a = tr.tokens(doc, new Set(), 0);
    expect(new Set(tr.tokens(doc, new Set(), 0))).toEqual(new Set(a));
    tr.reset();
    const b = tr.tokens(doc, new Set(), 0);
    expect(b.every((t, i) => t !== a[i])).toBe(true);
  });

  it('a change to what pages inherit from the page tree changes the pages below it', () => {
    const d = PdfDocument.create();
    for (let i = 0; i < 3; i++) addBlankPage(d);
    const doc = PdfDocument.load(d.save({ incremental: false }));
    const tab = makeApp().createTab(doc);
    const tr = new PageChangeTracker();
    expect(changedPages(tab, tr, () => tab.edit('Inherit', () => { const root = tab.doc.pagesRoot!; root.set('Rotate', 90); tab.doc.update(tab.doc.pagesRootRef!, root); for (const p of tab.doc.pages) p.dict.delete('Rotate'); }))).toEqual([0, 1, 2]);
  });
});

describe('DocTab change record', () => {
  it('records the objects an edit changed, and nothing for an edit that changed nothing', () => {
    const tab = makeApp().createTab(fortyPages());
    expect(tab.takeChanges().touched).toBe('all'); // nothing known about a new tab
    const ref = tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[1], 10, 10, { contents: 'a' }))!;
    const t = tab.takeChanges().touched as Set<number>;
    expect(t).toBeInstanceOf(Set);
    expect(t.has(ref.num)).toBe(true);
    expect(t.has(tab.doc.pages[1].ref!.num)).toBe(true);
    expect(t.has(tab.doc.pages[0].ref!.num)).toBe(false);
    expect((tab.takeChanges().touched as Set<number>).size).toBe(0);
  });

  it('changes not taken yet add up', () => {
    const tab = makeApp().createTab(fortyPages());
    tab.takeChanges();
    const a = tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[1], 10, 10, { contents: 'a' }))!;
    const b = tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[3], 10, 10, { contents: 'b' }))!;
    const t = tab.takeChanges().touched as Set<number>;
    expect(t.has(a.num) && t.has(b.num)).toBe(true);
  });
});

describe('drafts', () => {
  beforeEach(() => localStorage.clear());
  it('a tab whose draft already holds its bytes is not written again, and the bytes are stored without a copy', async () => {
    const app = makeApp();
    const tab = app.createTab(fortyPages());
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }));
    const spy = vi.spyOn(store, 'kvSet');
    try {
      expect(await app.saveDrafts()).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1].bytes).toBe(tab.bytes.buffer);
      expect(await app.saveDrafts()).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
      tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 20, 20, { contents: 'b' }));
      expect(await app.saveDrafts()).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
      // Saved, then changed back to dirty with the same bytes: written again.
      tab.saved = Date.now() + 1; tab.dirty = true;
      expect(await app.saveDrafts()).toBe(1);
    } finally { spy.mockRestore(); }
  });
});

describe('autosave', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => vi.useRealTimers());
  it('waits for a pause in editing, but no longer than a second interval', () => {
    const app = makeApp();
    app.prefs.autosave = true; app.prefs.autosaveSeconds = 10;
    const save = vi.spyOn(app, 'saveDrafts').mockResolvedValue(0);
    app.scheduleAutosave();
    vi.advanceTimersByTime(9000);
    app.scheduleAutosave(); // still editing at 9 s
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled(); // 10 s, but the last edit was 1 s ago
    vi.advanceTimersByTime(600);
    expect(save).toHaveBeenCalledTimes(1);
    // Edits every second for a long time: written at twice the interval at the latest.
    save.mockClear();
    app.scheduleAutosave();
    for (let t = 0; t < 25; t++) { vi.advanceTimersByTime(1000); app.scheduleAutosave(); }
    expect(save).toHaveBeenCalledTimes(1);
  });
});
