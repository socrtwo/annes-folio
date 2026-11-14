/**
 * Anne's Folio application core: document tabs, command execution, undo/redo of engine edits,
 * macro recording and draft autosave. Each tab holds one PdfDocument (the engine's object graph,
 * the document of record) and the bytes the viewer renders from.
 */
import { isSafeExternalUrl } from './util/sanitize';
import { PdfDocument } from './pdf/document';
import { cloneObj, PdfObj, Dict, PdfStream, Ref } from './pdf/objects';
import { pageAnnotations } from './pdf/structure';
import { getCommand, allCommands, type Command } from './commands/registry';
import { loadPrefs, savePrefs, type Prefs } from './prefs';
import { kvSet, kvDel, kvKeys } from './util/store';
import { toast } from './ui/dialog';
import { canonicalKey } from './util/keys';
import type { Shell } from './ui/shell';
import type { Viewer } from './view/viewer';
import type { RepairReport } from './pdf/repair';

let tabCounter = 0;
/** This window's session: part of every tab id, so another window can tell this window's drafts from abandoned ones. */
const SESSION = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SESSION_LOCK = 'quillfolio-session:';
// Held for as long as this window lives (Web Locks are released when it closes or crashes).
try { void (navigator as any).locks?.request?.(SESSION_LOCK + SESSION, () => new Promise<void>(() => undefined))?.catch?.(() => undefined); } catch { /* no Web Locks */ }

export type ViewMode = 'continuous' | 'single' | 'facing' | 'book';
export type Tool = 'hand' | 'select' | 'zoom' | 'snapshot' | 'note' | 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'freetext' | 'callout' | 'square' | 'circle' | 'line' | 'arrow' | 'polygon' | 'polyline' | 'cloud' | 'ink' | 'highlighter' | 'eraser' | 'stamp' | 'link' | 'redact' | 'measure' | 'measureArea' | 'field-text' | 'field-checkbox' | 'field-radio' | 'field-combo' | 'field-list' | 'field-button' | 'field-signature' | 'field-date' | 'image' | 'text' | 'edit' | 'sign' | 'attach' | 'erase' | 'crop';

interface Snapshot { label: string; changed: Map<number, PdfObj | null>; trailer: Dict; nextNum: number }

/** Returned by an edit function that found nothing to change: no undo step, no re-render, the tab stays clean. */
export const NO_CHANGE: unique symbol = Symbol('no change');

/** Undo steps kept per tab, and the stream bytes they may hold beyond what the document itself needs. */
const HISTORY_STEPS = 60;
export const historyLimits = { bytes: 192 * 1024 * 1024 };

/** Snapshot copy of an overlay object: dictionaries and arrays are copied, stream bytes are shared (the engine replaces them, never writes into them). */
function snapObj(o: PdfObj): PdfObj {
  if (o instanceof PdfStream) { const s = new PdfStream(cloneObj(o.dict) as Dict, o.raw); s.decoded = o.decoded; return s; }
  return cloneObj(o);
}

/** The view mounted for a tab (view/viewer.ts). */
export interface TabView {
  el: HTMLElement;
  layout(): void;
  /** Re-renders after the document bytes changed. */
  reload(): Promise<void>;
  focus(): void;
  destroy(): void;
  readonly zoom: number;
  setZoom(z: number | 'fit-width' | 'fit-page' | 'actual'): void;
  goToPage(i: number, y?: number): void;
  readonly page: number;
  readonly selectedText: string;
  readonly selectionRects: { page: number; rects: [number, number, number, number][] } | null;
  /** Selected annotation (object number) on the current page. */
  selectedAnnot: { page: number; num: number } | null;
  setTool(t: Tool, opts?: any): void;
  readonly tool: Tool;
  pageText(i: number): Promise<string>;
  search(q: string, opts?: { caseSensitive?: boolean; wholeWord?: boolean }): Promise<{ page: number; count: number }[]>;
  findNext(dir: 1 | -1): void;
  clearSearch(): void;
  renderPagePng(i: number, dpi: number): Promise<Blob>;
  refreshAnnotations(): void;
}

export class DocTab {
  id = `t${SESSION}_${tabCounter++}`;
  title = 'Document';
  fileName = '';
  format = 'pdf';
  uri: string | null = null;
  dirty = false;
  created = Date.now();
  saved = 0;
  readOnly = false;
  key = '';
  password = '';
  view: ViewMode;
  el!: HTMLElement;
  ui!: TabView;
  repair: RepairReport | null = null;
  /** Content was removed (redaction, sanitizing): until the next rewriting save nothing may be written as an incremental update. */
  mustRewrite = false;
  /** The bytes the viewer shows (original file, or the document with its edits applied). */
  bytes: Uint8Array;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  /** Form-fill mode: clicking a field opens its editor. */
  fillMode = true;
  /** Page content selected with the Edit tool: a text run or an image (content-stream operator index). */
  selection: { kind: 'run' | 'image'; page: number; index: number; box: [number, number, number, number]; text?: string } | null = null;
  constructor(public app: App, public doc: PdfDocument, bytes?: Uint8Array) {
    this.view = app.prefs.viewMode;
    this.bytes = bytes || doc.save({ incremental: false });
  }
  get displayName(): string { return this.fileName || this.title; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string { return this.undoStack[this.undoStack.length - 1]?.label || ''; }
  get redoLabel(): string { return this.redoStack[this.redoStack.length - 1]?.label || ''; }

  private snapshot(label: string): Snapshot {
    const changed = new Map<number, PdfObj | null>();
    for (const [k, v] of this.doc.changed) changed.set(k, v === null ? null : snapObj(v));
    return { label, changed, trailer: cloneObj(this.doc.trailer) as Dict, nextNum: this.doc.size };
  }
  private restore(s: Snapshot): void {
    const d = this.doc as any;
    d.changed = s.changed;
    d.trailer = s.trailer;
    // Object numbers are never handed out twice: a reference kept from an undone step can only point at nothing.
    d.nextNum = Math.max(d.nextNum, s.nextNum);
    d.cache.clear(); d.objStmCache.clear(); d.pageCache = null;
    this.doc.dirty = true;
  }
  /** Drops what the selection pointed at when it is no longer there (after undo, redo or a reload). */
  private dropStaleSelection(all = false): void {
    this.selection = null;
    const s = this.ui?.selectedAnnot;
    if (!s) return;
    const p = all ? undefined : this.doc.pages[s.page];
    if (!p || !pageAnnotations(this.doc, p).some((a) => a.ref?.num === s.num)) this.ui.selectedAnnot = null;
  }
  /** Keeps at most HISTORY_STEPS undo steps and historyLimits.bytes of stream data that only the history still holds. */
  private trimHistory(): void {
    if (this.undoStack.length > HISTORY_STEPS) this.undoStack.splice(0, this.undoStack.length - HISTORY_STEPS);
    const seen = new Set<Uint8Array>();
    for (const o of this.doc.changed.values()) if (o instanceof PdfStream) seen.add(o.raw);
    let held = 0;
    const count = (stack: Snapshot[], keep: number): void => {
      for (let i = stack.length - 1; i >= 0; i--) {
        for (const o of stack[i].changed.values()) if (o instanceof PdfStream && !seen.has(o.raw)) { seen.add(o.raw); held += o.raw.length; }
        if (held > historyLimits.bytes && i < stack.length - keep) { stack.splice(0, i + 1); return; }
      }
    };
    count(this.redoStack, 0);
    count(this.undoStack, 1);
  }
  /**
   * Runs an edit as one undoable step and refreshes the viewer bytes. Refused (undefined) on a read-only
   * tab; an edit function that returns NO_CHANGE leaves no undo step and returns undefined.
   */
  edit<T>(label: string, fn: () => T | typeof NO_CHANGE): T | undefined {
    if (this.readOnly) { toast('This document is read-only.'); return undefined; }
    const before = this.snapshot(label);
    let r: T | typeof NO_CHANGE;
    try { r = fn(); }
    catch (e) { this.restore(before); throw e; }
    if (r === NO_CHANGE) return undefined;
    this.undoStack.push(before);
    this.redoStack = [];
    this.trimHistory();
    this.afterChange();
    return r;
  }
  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.dropStaleSelection();
    this.afterChange();
    return true;
  }
  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.dropStaleSelection();
    this.afterChange();
    return true;
  }
  clearHistory(): void { this.undoStack = []; this.redoStack = []; }
  /** Rebuilds the viewer bytes from the engine and marks the tab dirty. */
  afterChange(): void {
    try { this.bytes = this.doc.save({ incremental: !this.mustRewrite && (this.app.prefs.saveMode !== 'rewrite' || !!this.doc.security) }); }
    catch (e) { console.error(e); toast(`Could not apply the change: ${(e as any)?.message || e}`); }
    this.app.docChanged(this);
  }
  /**
   * Replaces the engine document (after a save or a rewrite). When the new document is the old file plus exactly
   * this tab's changes (an incremental save), the undo history is carried over; otherwise it starts again.
   */
  replace(doc: PdfDocument, bytes: Uint8Array): void {
    const had = this.undoStack.length + this.redoStack.length > 0;
    const kept = had && this.rebaseHistory(doc);
    this.doc = doc; this.bytes = bytes;
    if (!kept) {
      this.clearHistory();
      if (had && !this.app.toldHistoryReset) { this.app.toldHistoryReset = true; toast('The document was reloaded from newly written bytes, so Undo starts again from here.', { ms: 6000 }); }
    }
    this.dropStaleSelection(!kept);
  }

  /**
   * Re-expresses every undo and redo snapshot against a document loaded from an incremental save of this one.
   * A snapshot lists the objects that differed from the old file; against the new file it must also list, with
   * their old-file contents, the objects the save wrote. False (nothing changed) when `next` is anything else.
   */
  private rebaseHistory(next: PdfDocument): boolean {
    const old = this.doc;
    const o = old as any;
    const base = old.buf.length;
    if (!base || old.security || next.security || old.report.reconstructed || next.report.reconstructed || next.buf.length <= base) return false;
    for (let i = 0; i < base; i += Math.max(1, base >> 12)) if (next.buf[i] !== old.buf[i]) return false;
    for (let i = Math.max(0, base - 1024); i < base; i++) if (next.buf[i] !== old.buf[i]) return false;
    const live: Map<number, PdfObj | null> = old.changed;
    // The appended part must define the objects of this tab's overlay and nothing else (but its own cross-reference stream).
    let extra = 0;
    for (const [n, e] of next.xref) {
      if (e.type !== 1 || e.offset < base || live.has(n)) continue;
      const x = next.fetch(new Ref(n, e.gen));
      if (!(x instanceof PdfStream) || next.getName(x, 'Type') !== 'XRef' || ++extra > 1) return false;
    }
    for (const [n, v] of live) { const e = next.xref.get(n); if (v !== null && !(e && e.type === 1 && e.offset >= base)) return false; }
    // Old-file contents of the objects the save wrote (null for objects the old file did not have).
    const original = new Map<number, PdfObj | null>();
    o.changed = new Map(); o.cache.clear(); o.objStmCache.clear();
    try { for (const n of live.keys()) original.set(n, old.xref.has(n) ? old.fetch(new Ref(n, old.genOf(n))) : null); }
    catch { return false; }
    finally { o.changed = live; o.cache.clear(); o.objStmCache.clear(); }
    for (const s of [...this.undoStack, ...this.redoStack]) {
      for (const [n, v] of original) if (!s.changed.has(n)) s.changed.set(n, v === null ? null : snapObj(v));
    }
    return true;
  }
}

export class App {
  prefs: Prefs = loadPrefs();
  docs: DocTab[] = [];
  active!: DocTab;
  ui!: Shell;
  recording: { name: string; steps: { id: string; arg?: any }[] } | null = null;
  recordingPaused = false;
  /** Id of the tab shown beside the active one (View ▸ Side by Side), or null. */
  split: string | null = null;
  /** The "Undo starts again" notice is shown once per session. */
  toldHistoryReset = false;
  private refreshQueued = false;
  private autosaveTimer: any = null;
  private draftFailureTold = false;
  private reloads = new Map<DocTab, { again: boolean }>();
  private listeners = new Set<(app: App) => void>();
  lastCommand: { id: string; arg?: any } | null = null;
  keyIndex = new Map<string, string>();
  /** Copied text or image (for Paste into a new document). */
  clip: { text?: string; image?: { data: Uint8Array; mime: string; width: number; height: number } } | null = null;

  constructor(public host: HTMLElement) { this.rebuildKeyIndex(); }

  get tab(): DocTab { return this.active; }
  get doc(): PdfDocument { return this.active.doc; }
  get viewer(): Viewer { return this.active.ui as unknown as Viewer; }
  /** Current page index. */
  get page(): number { return this.active?.ui?.page ?? 0; }

  onRefresh(fn: (app: App) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  savePrefs(): void { savePrefs(this.prefs); this.rebuildKeyIndex(); }

  rebuildKeyIndex(): void {
    this.keyIndex.clear();
    for (const c of allCommands()) for (const k of c.keys || []) {
      const ck = canonicalKey(k);
      if (import.meta.env?.DEV && this.keyIndex.has(ck) && this.keyIndex.get(ck) !== c.id) console.warn(`Shortcut ${ck} is claimed by ${this.keyIndex.get(ck)} and ${c.id}; the later one wins.`);
      this.keyIndex.set(ck, c.id);
    }
    for (const [k, id] of Object.entries(this.prefs.keymap)) { if (id) this.keyIndex.set(canonicalKey(k), id); else this.keyIndex.delete(canonicalKey(k)); }
  }

  // ------------------------------------------------------------------------------------------
  // Tabs

  createTab(doc?: PdfDocument, meta: Partial<DocTab> = {}, bytes?: Uint8Array): DocTab {
    if (!doc) {
      doc = PdfDocument.create();
      const { addBlankPage } = requireBuild();
      addBlankPage(doc);
      bytes = doc.save({ incremental: false });
      doc = PdfDocument.load(bytes);
    }
    const tab = new DocTab(this, doc, bytes);
    Object.assign(tab, meta);
    this.ui.mountTab(tab);
    this.docs.push(tab);
    this.activate(tab);
    return tab;
  }

  activate(tab: DocTab): void {
    this.active = tab;
    for (const d of this.docs) d.el.classList.toggle('ql-hidden-tab', d !== tab);
    this.ui.tabsChanged();
    tab.ui.layout();
    this.refresh();
    document.title = `${tab.displayName}${tab.dirty ? ' •' : ''} – Anne's Folio`;
  }

  /** Ends the side-by-side view (View ▸ Side by Side). */
  endSplit(): void {
    if (!this.split) return;
    this.split = null;
    for (const d of this.docs) d.el.classList.remove('ql-split-pane');
    this.ui.workspace?.classList.remove('ql-split');
  }

  closeTab(tab: DocTab): void {
    const i = this.docs.indexOf(tab);
    if (i < 0) return;
    // Closing either side of a side-by-side view ends it.
    if (this.split && (this.split === tab.id || tab === this.active)) this.endSplit();
    const wasActive = tab === this.active;
    tab.ui.destroy();
    tab.el.remove();
    this.docs.splice(i, 1);
    this.reloads.delete(tab);
    kvDel('draft:' + tab.id).catch(() => undefined);
    if (!this.docs.length) this.createTab();
    else this.activate(wasActive || !this.docs.includes(this.active) ? this.docs[Math.max(0, i - 1)] : this.active);
  }

  /** Called after every edit, undo and redo. */
  docChanged(tab: DocTab): void {
    if (!tab.dirty) { tab.dirty = true; this.ui.tabsChanged(); if (tab === this.active) document.title = `${tab.displayName} • – Anne's Folio`; }
    this.scheduleAutosave();
    this.requestReload(tab);
    this.refresh();
  }

  /** Re-renders a tab from its bytes. Requests that arrive while a reload runs are folded into one more reload after it. */
  requestReload(tab: DocTab): void {
    const st = this.reloads.get(tab);
    if (st) { st.again = true; return; }
    const state = { again: false };
    this.reloads.set(tab, state);
    const run = (): void => {
      state.again = false;
      let p: Promise<void>;
      try { p = Promise.resolve(tab.ui.reload()); } catch (e) { p = Promise.reject(e); }
      p.catch((e) => console.error(e)).then(() => {
        if (state.again && this.docs.includes(tab)) run(); else this.reloads.delete(tab);
      });
    };
    run();
  }

  /** The edit helper commands use: one undoable step on the active document. */
  edit<T>(label: string, fn: (doc: PdfDocument, tab: DocTab) => T | typeof NO_CHANGE): T | undefined {
    const t = this.active;
    if (!t) return undefined;
    return t.edit(label, () => fn(t.doc, t));
  }

  /**
   * True while `tab` is open and, when `rev` is given (its `bytes` taken before an await), unchanged since.
   * Says why not otherwise, so a slow command never writes into another document or over newer edits.
   */
  stillOpen(tab: DocTab, rev?: Uint8Array): boolean {
    if (!this.docs.includes(tab)) { toast(`"${tab.displayName}" was closed; nothing was changed.`); return false; }
    if (rev && tab.bytes !== rev) { toast(`"${tab.displayName}" changed while this was running; nothing was applied. Run it again.`, { ms: 6000 }); return false; }
    return true;
  }

  /** One undoable step on a tab captured before an await (the active tab may have changed since). */
  editTab<T>(tab: DocTab, label: string, fn: (doc: PdfDocument, tab: DocTab) => T | typeof NO_CHANGE): T | undefined {
    if (!this.stillOpen(tab)) return undefined;
    return tab.edit(label, () => fn(tab.doc, tab));
  }

  refresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    requestAnimationFrame(() => {
      this.refreshQueued = false;
      if (!this.active) return;
      this.ui.refresh();
      for (const l of this.listeners) l(this);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Commands

  /** The command a key combination is bound to (a keyName()/binding string), or undefined. */
  commandForKey(key: string): Command | undefined {
    const id = this.keyIndex.get(canonicalKey(key));
    return id ? getCommand(id) : undefined;
  }

  /**
   * Runs the command bound to a key. False when the key is not bound or its command is not available right
   * now: the caller must then leave the key event alone (no preventDefault), so the key keeps its normal meaning.
   */
  handleKey(key: string): boolean {
    const c = this.commandForKey(key);
    if (!c) return false;
    if (c.isEnabled && !c.isEnabled(this)) return false;
    this.exec(c.id);
    return true;
  }

  isReadOnly(): boolean { return !!this.tab?.readOnly; }

  exec(id: string, arg?: any): unknown {
    const c = getCommand(id);
    if (!c) { toast(`Unknown command: ${id}`); return false; }
    if (c.edits !== false && this.isReadOnly()) { toast('This document is read-only.'); return false; }
    if (c.isEnabled && !c.isEnabled(this)) { toast(`${c.label} is not available here.`); return false; }
    try {
      if (this.recording && !c.noRecord && id !== 'dev.recordMacro' && id !== 'dev.stopRecording') this.recordStep(id, arg);
      if (!c.noRecord && id !== 'edit.repeat') this.lastCommand = { id, arg };
      const r = c.run(this, arg);
      if (r instanceof Promise) r.catch((e) => this.reportError(c, e)).finally(() => this.refresh());
      this.refresh();
      return r;
    } catch (e) {
      this.reportError(c, e);
      return false;
    }
  }

  private reportError(c: Command, e: unknown): void {
    console.error(e);
    toast(`${c.label}: ${(e as any)?.message || e}`, { ms: 6000 });
  }

  /** Adds a step to the macro being recorded. An argument that cannot be written as JSON (a file, a page element) is left out. */
  recordStep(id: string, arg?: any): void {
    if (!this.recording || this.recordingPaused) return;
    let step: { id: string; arg?: any } = { id };
    if (arg !== undefined) {
      try { const text = JSON.stringify(arg); if (text !== undefined && text.length <= 20000) step = { id, arg: JSON.parse(text) }; } catch { /* not serializable: record the command alone */ }
    }
    this.recording.steps.push(step);
  }

  // ------------------------------------------------------------------------------------------
  // Autosave and drafts

  scheduleAutosave(): void {
    if (!this.prefs.autosave || this.autosaveTimer) return;
    this.autosaveTimer = setTimeout(() => { this.autosaveTimer = null; void this.saveDrafts(); }, Math.max(3, this.prefs.autosaveSeconds) * 1000);
  }

  /** Stores a draft of every changed tab. The password of an encrypted document is never stored: recovery asks for it. */
  async saveDrafts(): Promise<number> {
    let saved = 0, failed = 0;
    for (const tab of [...this.docs]) {
      if (!tab.dirty) continue;
      try {
        await kvSet('draft:' + tab.id, { id: tab.id, bytes: tab.bytes.buffer.slice(tab.bytes.byteOffset, tab.bytes.byteOffset + tab.bytes.byteLength), title: tab.title, fileName: tab.fileName, uri: tab.uri, key: tab.key, time: Date.now(), encrypted: !!tab.doc.security });
        // The tab may have been saved or closed while the draft was being written.
        if (!tab.dirty || !this.docs.includes(tab)) await kvDel('draft:' + tab.id).catch(() => undefined); else saved++;
      } catch (e) { failed++; console.warn('draft', e); }
    }
    if (failed && !this.draftFailureTold) { this.draftFailureTold = true; toast('Drafts could not be stored on this device (storage is full or unavailable). Save your documents to keep your changes.', { ms: 9000 }); }
    if (saved) { this.draftFailureTold = false; this.ui.status?.(saved === 1 ? 'Draft saved' : `${saved} drafts saved`); }
    return saved;
  }

  followLink(href: string): void {
    if (!isSafeExternalUrl(href)) { toast(`Blocked a link with an unsupported or unsafe address: ${href.slice(0, 60)}`); return; }
    import('./platform/native').then(({ openExternal }) => openExternal(href));
  }

  focus(): void { this.active?.ui.focus(); }
}

/**
 * Draft keys that can be offered for recovery: not a tab of this window, and not a tab of another window
 * of the app that is open right now (where Web Locks can tell).
 */
export async function recoverableDraftKeys(app: App): Promise<string[]> {
  const keys = (await kvKeys('draft:')).filter((k) => !app.docs.some((d) => 'draft:' + d.id === k));
  const live = new Set<string>();
  try {
    const q = await (navigator as any).locks?.query?.();
    for (const l of q?.held || []) if (String(l.name).startsWith(SESSION_LOCK)) live.add(String(l.name).slice(SESSION_LOCK.length));
  } catch { /* no Web Locks: every draft is offered */ }
  return keys.filter((k) => { const m = /^draft:t([0-9a-z]+)_\d+$/.exec(k); return !m || !live.has(m[1]); });
}

import * as buildMod from './pdf/build';
function requireBuild() { return buildMod; }
