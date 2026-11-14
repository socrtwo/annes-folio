/** Command modules: comment, edit, review, ai, dev, view; spelling tokens and the spelling worker protocol. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/ui/dialog', async (orig) => { const m: any = await orig(); return { ...m, openDialog: vi.fn(async () => null) }; });

import '../../src/commands/index';
import { App, DocTab } from '../../src/app';
import { getCommand, registeredCommands } from '../../src/commands/registry';
import { canonicalKey } from '../../src/util/keys';
import { openDialog } from '../../src/ui/dialog';
import { PdfDocument } from '../../src/pdf/document';
import { addBlankPage } from '../../src/pdf/build';
import { bytesOf, Dict, PdfStream } from '../../src/pdf/objects';
import { addNote, addReply, addShape } from '../../src/pdf/ops/annots';
import { addField } from '../../src/pdf/ops/forms';
import { pageAnnotations, readFields, writeMetadata } from '../../src/pdf/structure';
import { pickAt, addTextAt, selectionAsMarkdown } from '../../src/commands/edit';
import { toolDone, freeFieldName, annotationState } from '../../src/commands/comment';
import { diffLines, alignPages } from '../../src/commands/review';
import { runMacro, parseMacroSteps, retargetMacro } from '../../src/commands/dev';
import { chunkPages, validBookmarks, outlineFromSuggestions, fieldLabelSuggestions } from '../../src/commands/ai';
import { wordsIn } from '../../src/proof/proofing';

const dialog = openDialog as unknown as ReturnType<typeof vi.fn>;
function freshDoc(): PdfDocument { const d = PdfDocument.create(); addBlankPage(d); return PdfDocument.load(d.save({ incremental: false })); }
function fakeView(): any {
  return { el: document.createElement('div'), layout() {}, reload: vi.fn(async () => undefined), focus() {}, destroy() {}, zoom: 1, setZoom() {}, goToPage() {}, page: 0, selectedText: '', selectionRects: null, selectedAnnot: null, setTool: vi.fn(), tool: 'select', refreshAnnotations() {}, toolOpts: {} };
}
function makeApp(): App {
  const app = new App(document.body);
  (app as any).ui = { mountTab(tab: DocTab) { tab.el = document.createElement('div'); tab.ui = fakeView(); }, tabsChanged() {}, refresh() {}, status: vi.fn(), workspace: document.createElement('div'), renderQat() {}, rebuild() {}, anchorFor: () => document.body, openPane() {}, paneOpen: () => false };
  return app;
}
const toasts = () => [...document.querySelectorAll('.ql-toast')].map((t) => t.textContent || '');
const mine = () => registeredCommands().filter((c) => /^(comment|review|edit|ai|view|dev|home|nav|help)\./.test(c.id));

beforeEach(() => { dialog.mockReset(); dialog.mockResolvedValue(null); document.querySelectorAll('.ql-toasts').forEach((t) => t.remove()); localStorage.clear(); });

describe('edit commands', () => {
  it('shows a font name from the file as text in the Edit Text dialog', async () => {
    const app = makeApp();
    const evil = '<img src=x onerror=alert(1)>';
    const enc = [...evil].map((c) => (/[A-Za-z0-9]/.test(c) ? c : '#' + c.charCodeAt(0).toString(16).padStart(2, '0'))).join('');
    const d = freshDoc();
    d.setPageContent(d.pages[0], bytesOf(`BT /${enc} 12 Tf 72 700 Td (Hello) Tj ET\n`));
    const tab = app.createTab(PdfDocument.load(d.save({ incremental: false })));
    await pickAt(app, { page: 0, x: 75, y: 703 });
    expect(dialog).toHaveBeenCalledTimes(1);
    const html = dialog.mock.calls[0][0].fields.find((f: any) => f.type === 'info').html as string;
    const el = document.createElement('div'); el.innerHTML = html;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain(evil);
    expect(tab.selection?.kind).toBe('run');
  });

  it('puts pasted text into the Add Text box', async () => {
    const app = makeApp();
    app.createTab(freshDoc());
    await addTextAt(app, 0, 72, 700, undefined, 'from the clipboard');
    expect(dialog.mock.calls[0][0].fields[0].value).toBe('from the clipboard');
  });

  it('Copy as Markdown keeps paragraphs apart and joins the lines inside them', () => {
    expect(selectionAsMarkdown('Heading\nfirst line\nsecond line\n\nNext paragraph\nmore\r\n \r\nLast')).toBe('Heading first line second line\n\nNext paragraph more\n\nLast');
  });

  it('F4 belongs to Thumbnails alone, and no key is claimed twice within these modules', () => {
    const claims = new Map<string, string[]>();
    for (const c of mine()) for (const k of c.keys || []) claims.set(canonicalKey(k), [...(claims.get(canonicalKey(k)) || []), c.id]);
    expect(claims.get('F4')).toEqual(['view.thumbnails']);
    expect(getCommand('edit.repeat')!.keys).toEqual(['Mod-Shift-y']);
    expect([...claims].filter(([, ids]) => ids.length > 1)).toEqual([]);
  });

  it('marks viewing commands edits:false and leaves modifying ones gated', () => {
    for (const id of ['nav.next', 'view.zoomIn', 'home.select', 'edit.copy', 'edit.find', 'comment.toolDone', 'comment.summarize', 'review.compare', 'ai.summarize', 'dev.runMacro', 'help.about', 'macro:anything']) expect(getCommand(id)!.edits, id).toBe(false);
    for (const id of ['edit.undo', 'edit.redo', 'edit.paste', 'comment.note', 'comment.delete', 'comment.moveAnnotation', 'review.spelling', 'ai.cleanOcr']) expect(getCommand(id)!.edits, id).not.toBe(false);
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }));
    tab.readOnly = true;
    expect(app.exec('edit.undo')).toBe(false);
    expect(tab.canUndo).toBe(true);
  });
});

describe('comment commands', () => {
  it('names each new form field differently', () => {
    const doc = freshDoc();
    const names: string[] = [];
    for (let k = 0; k < 3; k++) { const name = freeFieldName(doc, 'Text'); names.push(name); addField(doc, { name, type: 'text', page: 0, rect: [72, 700 - k * 30, 232, 722 - k * 30] } as any); }
    expect(names).toEqual(['Text1', 'Text2', 'Text3']);
    expect(readFields(doc).map((f) => f.name)).toEqual(['Text1', 'Text2', 'Text3']);
  });

  it('creates a stamp picture inside the edit, so undo leaves nothing in the file', async () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const images = () => [...tab.doc.changed.values()].filter((o) => o instanceof PdfStream && tab.doc.getName(o, 'Subtype') === 'Image').length;
    const spec = { kind: 'gray', width: 2, height: 2, data: new Uint8Array(4) } as any;
    await toolDone(app, { tool: 'stamp', page: 0, start: [100, 100], end: [100, 100], rect: [100, 100, 100, 100], pts: [[100, 100]], click: true, opts: { imageSpec: spec, width: 2, height: 2 } });
    expect(images()).toBe(1);
    expect(pageAnnotations(tab.doc, tab.doc.pages[0]).some((a) => a.subtype === 'Stamp')).toBe(true);
    tab.undo();
    expect(images()).toBe(0);
    await toolDone(app, { tool: 'stamp', page: 0, start: [100, 100], end: [100, 100], rect: [100, 100, 100, 100], pts: [[100, 100]], click: true, opts: { imageSpec: spec, width: 2, height: 2 } });
    expect(images()).toBe(1);
  });

  it('writes a gesture into the tab it was made on', async () => {
    const app = makeApp();
    const a = app.createTab(freshDoc());
    const p = toolDone(app, { tool: 'square', page: 0, start: [10, 10], end: [90, 90], rect: [10, 10, 90, 90], pts: [], click: false, opts: {} });
    const b = app.createTab(freshDoc());
    await p;
    expect(pageAnnotations(a.doc, a.doc.pages[0]).some((x) => x.subtype === 'Square')).toBe(true);
    expect(pageAnnotations(b.doc, b.doc.pages[0]).length).toBe(0);
  });

  it('sends Delete on a form field to Forms ▸ Delete Field and keeps reply, status and duplicate for comments', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const ref = tab.edit('Field', () => addField(tab.doc, { name: 'Name', type: 'text', page: 0, rect: [72, 700, 232, 722] } as any))!;
    tab.ui.selectedAnnot = { page: 0, num: ref.num };
    const exec = vi.spyOn(app, 'exec').mockImplementation(() => true);
    getCommand('comment.delete')!.run(app);
    expect(exec).toHaveBeenCalledWith('forms.deleteField');
    expect(readFields(tab.doc).length).toBe(1);
    for (const id of ['comment.reply', 'comment.setStatus', 'comment.duplicate', 'comment.flattenOne']) expect(getCommand(id)!.isEnabled!(app), id).toBe(false);
    exec.mockRestore();

    const note = tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }))!;
    tab.ui.selectedAnnot = { page: 0, num: note.num };
    expect(getCommand('comment.reply')!.isEnabled!(app)).toBe(true);
    getCommand('comment.delete')!.run(app);
    expect(pageAnnotations(tab.doc, tab.doc.pages[0]).some((a) => a.ref?.num === note.num)).toBe(false);
  });

  it('shows the status set on a comment', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const note = tab.edit('Note', () => addNote(tab.doc, tab.doc.pages[0], 10, 10, { contents: 'a' }))!;
    tab.ui.selectedAnnot = { page: 0, num: note.num };
    const checked = () => getCommand('comment.setStatus')!.menu!(app).filter((e) => e.checked).map((e) => e.arg);
    expect(checked()).toEqual([]);
    app.exec('comment.setStatus', 'Accepted');
    expect(annotationState(pageAnnotations(tab.doc, tab.doc.pages[0]), note)).toBe('Accepted');
    expect(checked()).toEqual(['Accepted']);
    tab.edit('Later', () => addReply(tab.doc, tab.doc.pages[0], note, 'Rejected', 'B', { model: 'Review', state: 'Rejected' }));
    expect(checked()).toEqual(['Rejected']);
  });

  it('changes the line width through the annotation properties, which redraws the shape', () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    const ref = tab.edit('Rect', () => addShape(tab.doc, tab.doc.pages[0], 'Square', [100, 100, 200, 200], { stroke: [1, 0, 0], width: 1 }))!;
    tab.ui.selectedAnnot = { page: 0, num: ref.num };
    const ap = () => { const d = tab.doc.resolve<Dict>(ref); const n = tab.doc.get<PdfStream>(tab.doc.getDict(d, 'AP'), 'N'); return new TextDecoder('latin1').decode(tab.doc.decoded(n)); };
    const before = ap();
    app.exec('comment.lineWidth', 6);
    expect(tab.doc.getNum(tab.doc.getDict(tab.doc.resolve<Dict>(ref), 'BS'), 'W')).toBe(6);
    expect(ap()).not.toBe(before);
  });

  it('sets the highlight color from the Highlights part of the color menu whatever tool is armed', () => {
    const app = makeApp();
    app.createTab(freshDoc());
    const pen = app.prefs.penColor;
    app.exec('comment.color', 'hl:#00ff00');
    expect(app.prefs.highlightColor).toBe('#00ff00');
    expect(app.prefs.penColor).toBe(pen);
    app.exec('comment.color', 'pen:#0070c0');
    expect(app.prefs.penColor).toBe('#0070c0');
    expect(app.prefs.highlightColor).toBe('#00ff00');
  });
});

describe('review', () => {
  it('diffs lines, also when the changed part is too large for a full table', () => {
    const d = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
    expect(d.map((x) => x.kind + x.text).join(' ')).toBe(' a -b +x  c  d +e');
    const big = Array.from({ length: 70000 }, (_, i) => `line ${i}`);
    const out = diffLines(big, [...big.slice(0, 40000), 'inserted', ...big.slice(40000)]);
    expect(out.filter((x) => x.kind !== ' ')).toEqual([{ kind: '+', text: 'inserted' }]);
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`), b = Array.from({ length: 3000 }, (_, i) => `b${i}`);
    const far = diffLines(['same', ...a, 'end'], ['same', ...b, 'end']);
    expect(far.filter((x) => x.kind === '-').length).toBe(3000);
    expect(far.filter((x) => x.kind === '+').length).toBe(3000);
    expect(far[0]).toEqual({ kind: ' ', text: 'same' });
    expect(far[far.length - 1]).toEqual({ kind: ' ', text: 'end' });
  });

  it('pairs pages by their text, so an inserted page shifts nothing', () => {
    expect(alignPages(['one', 'two', 'three'], ['one', 'NEW', 'two', 'three'])).toEqual([[0, 0], [null, 1], [1, 2], [2, 3]]);
    expect(alignPages(['one', 'two', 'three'], ['one', 'three'])).toEqual([[0, 0], [1, null], [2, 1]]);
    expect(alignPages(['one', 'two v1', 'three'], ['one', 'two v2', 'three'])).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(alignPages([], ['a'])).toEqual([[null, 0]]);
  });

  it('does not check another language against the English word lists', async () => {
    const app = makeApp();
    const d = freshDoc();
    writeMetadata(d, { language: 'fr-FR' });
    addNote(d, d.pages[0], 10, 10, { contents: 'Bonjour tout le monde' });
    app.createTab(PdfDocument.load(d.save({ incremental: false })));
    await getCommand('review.spelling')!.run(app);
    expect(toasts().some((t) => /No spelling dictionary is installed/.test(t) && /fr-FR/.test(t))).toBe(true);
    expect(dialog).not.toHaveBeenCalled();
  });
});

describe('macros', () => {
  it('keeps a JSON argument exactly as typed', () => {
    const r = parseMacroSteps('# a comment\ncomment.stamp "Top  Secret\\tNow"\nnav.next\n\nview.zoom {"a": [1,  2]}');
    expect(r.error).toBeNull();
    expect(r.steps).toEqual([{ id: 'comment.stamp', arg: 'Top  Secret\tNow' }, { id: 'nav.next' }, { id: 'view.zoom', arg: { a: [1, 2] } }]);
    expect(parseMacroSteps('no.such.command').error).toMatch(/Line 1: unknown command/);
    expect(parseMacroSteps('nav.next {oops').error).toMatch(/Line 1: the argument is not valid JSON/);
  });

  it('does not start a macro inside itself, by its name or its macro: id', async () => {
    const app = makeApp();
    app.createTab(freshDoc());
    app.prefs.macros = [{ name: 'A', steps: [{ id: 'macro:A' }], created: 0 }, { name: 'B', steps: [{ id: 'dev.runMacro', arg: 'C' }], created: 0 }, { name: 'C', steps: [{ id: 'macro:B' }], created: 0 }];
    const t0 = Date.now();
    expect(await runMacro(app, 'A')).toBe(false);
    expect(await runMacro(app, 'B')).toBe(false);
    expect(await app.exec('macro:A')).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(toasts().filter((t) => /would start itself again/.test(t)).length).toBe(3);
  });

  it('stops at the first step that fails or is refused', async () => {
    const app = makeApp();
    const tab = app.createTab(freshDoc());
    app.prefs.macros = [{ name: 'M', steps: [{ id: 'nav.next' }, { id: 'view.zoomIn' }], created: 0 }, { name: 'OK', steps: [{ id: 'view.fitWidth' }, { id: 'view.zoomIn' }], created: 0 }];
    const zoom = vi.spyOn(tab.ui, 'setZoom');
    expect(await runMacro(app, 'M')).toBe(false); // nav.next is not available on a one-page document
    expect(zoom).not.toHaveBeenCalled();
    expect(await runMacro(app, 'OK')).toBe(true);
    expect(zoom).toHaveBeenCalledTimes(2);
  });

  it('renaming or deleting a macro follows through to the bar, the shortcuts and custom tabs', () => {
    const app = makeApp();
    app.prefs.qat = ['file.save', 'macro:Old'];
    app.prefs.keymap = { 'Mod-Alt-1': 'macro:Old', 'Mod-Alt-2': 'file.save' };
    app.prefs.customTabs = [{ id: 't', label: 'T', groups: [{ id: 'g', label: 'G', items: ['macro:Old', 'nav.next'] }] }];
    retargetMacro(app, 'Old', 'New');
    expect(app.prefs.qat).toEqual(['file.save', 'macro:New']);
    expect(app.prefs.keymap).toEqual({ 'Mod-Alt-1': 'macro:New', 'Mod-Alt-2': 'file.save' });
    expect(app.prefs.customTabs[0].groups[0].items).toEqual(['macro:New', 'nav.next']);
    retargetMacro(app, 'New', null);
    expect(app.prefs.qat).toEqual(['file.save']);
    expect(app.prefs.keymap).toEqual({ 'Mod-Alt-2': 'file.save' });
    expect(app.prefs.customTabs[0].groups[0].items).toEqual(['nav.next']);
  });
});

describe('ai helpers', () => {
  it('cuts a whole document into pieces that cover every page with text', () => {
    const texts = ['x'.repeat(900), '', 'y'.repeat(2500), 'z'.repeat(100)];
    const chunks = chunkPages(texts, 1000);
    expect(chunks.every((c) => c.text.length <= 1000)).toBe(true);
    expect([...new Set(chunks.flatMap((c) => c.pages))]).toEqual([0, 2, 3]);
    const all = chunks.map((c) => c.text).join('\n');
    expect((all.match(/x/g) || []).length).toBe(900);
    expect((all.match(/y/g) || []).length).toBe(2500);
    expect((all.match(/z/g) || []).length).toBe(100);
    expect(chunks[0].text.startsWith('[Page 1]\n')).toBe(true);
    expect(chunkPages(['', '  '], 1000)).toEqual([]);
  });

  it('keeps only usable field labels, in one list for showing and applying', () => {
    const items = fieldLabelSuggestions([{ name: 'A', tooltip: 'First name' }, { name: 'B', tooltip: '' }, null, { name: 'Zed', tooltip: 'not a field' }, { name: 'C', tooltip: ' Date  of birth ', kind: 'date' }, { name: 5, tooltip: 'x' }], ['A', 'B', 'C']);
    expect(items).toEqual([{ name: 'A', tooltip: 'First name', kind: '' }, { name: 'C', tooltip: 'Date of birth', kind: 'date' }]);
    expect(fieldLabelSuggestions({ name: 'A' }, ['A'])).toEqual([]);
  });

  it('accepts only well-formed bookmark suggestions and nests them by level', () => {
    const items = validBookmarks([{ title: 'One', page: 1, level: 0 }, { title: 'One.A', page: '2', level: 1 }, { title: 'Deep', page: 2, level: 2 }, { title: { x: 1 }, page: 1 }, { title: 'Half', page: 2.5 }, { title: 'Far', page: 99 }, { title: 'Two', page: 3 }, 'junk'], 3);
    expect(items).toEqual([{ title: 'One', page: 1, level: 0 }, { title: 'One.A', page: 2, level: 1 }, { title: 'Deep', page: 2, level: 2 }, { title: 'Two', page: 3, level: 0 }]);
    const tree = outlineFromSuggestions(items);
    expect(tree.map((n) => n.title)).toEqual(['One', 'Two']);
    expect(tree[0].children!.map((n) => n.title)).toEqual(['One.A']);
    expect(tree[0].children![0].children!.map((n) => n.title)).toEqual(['Deep']);
    expect(tree[0].page).toBe(0);
    expect(outlineFromSuggestions([{ title: 'Orphan', page: 1, level: 3 }]).map((n) => n.title)).toEqual(['Orphan']);
    expect(validBookmarks({ title: 'x' }, 3)).toEqual([]);
  });
});

describe('spelling', () => {
  it('keeps words with a middle dot, joiners or soft hyphens whole', () => {
    expect(wordsIn('el col·legi i l’intel·ligent').map((w) => w.word)).toEqual(['el', 'col·legi', "l'intel·ligent"]);
    expect(wordsIn('می‌خواهم').map((w) => w.word)).toEqual(['می‌خواهم']);
    const soft = wordsIn('an exam­ple here');
    expect(soft.map((w) => w.word)).toEqual(['an', 'example', 'here']);
    expect('an exam­ple here'.slice(soft[1].start, soft[1].end)).toBe('exam­ple');
    expect(wordsIn("the dog's bone, see www.example.com/x or a@b.co").map((w) => w.word)).toEqual(['the', 'dog', 'bone', 'see', 'or']);
  });

  it('takes linear time on a very long unbroken token', () => {
    const t0 = Date.now();
    expect(wordsIn('x'.repeat(80000) + ' teh').map((w) => w.word).pop()).toBe('teh');
    expect(wordsIn('a-'.repeat(40000) + ' teh').length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('the worker answers an incomplete or unknown request with an error, never with "no misspellings"', async () => {
    const posted: any[] = [];
    (globalThis as any).self = globalThis;
    const original = (globalThis as any).postMessage;
    (globalThis as any).postMessage = (m: any) => { posted.push(m); };
    try {
      await import('../../src/proof/spell.worker');
      const send = async (data: any) => { await (globalThis as any).onmessage({ data }); return posted.find((p) => p.id === data.id); };
      expect((await send({ id: 1, type: 'load', dialect: 'dict:xx' })).error).toMatch(/missing or damaged/);
      expect((await send({ id: 2, type: 'load', dialect: 'dict:xx', aff: { 0: 1 }, dic: { 0: 1 } })).error).toBeTruthy();
      expect((await send({ id: 3, type: 'check', dialect: 'en-US' })).error).toMatch(/Bad spelling request/);
      expect((await send({ id: 4, type: 'suggest', dialect: 'en-US' })).error).toMatch(/Bad spelling request/);
      expect((await send({ id: 5, type: 'nonsense' })).error).toMatch(/Bad spelling request/);
      expect(await send({ id: 6, type: 'unload', dialect: 'dict:xx' })).toEqual({ id: 6, ok: true });
      expect((await send({ id: 7, type: 'check', dialect: 'dict:xx', words: ['a'] })).error).toMatch(/not loaded/);
    } finally { (globalThis as any).postMessage = original; (globalThis as any).onmessage = null; }
  });
});
