/**
 * The document view of one tab: pages rendered by pdf.js on demand, a selectable text layer, search
 * highlights, the annotation and form tools drawn on an overlay, a thumbnail rail with drag-reorder,
 * and the Organize Pages grid. Edits go to the engine through the commands; the viewer reloads the
 * bytes the engine produces.
 */
import type { App, DocTab, TabView, Tool } from '../app';
import { h, clear, debounce } from '../ui/dom';
import { toast, confirmDialog } from '../ui/dialog';
import { openPdfjs, pageTextItems, pageTextString, PdfjsTextLayer, AnnotationMode, type PDFDocumentProxy, type PDFPageProxy, type TextItem } from './pdfjs';
import { totalRotation, pageToCss, cssToPage, outputScale, wheelZoomFactor, drawingOnDown, searchRegex, searchItems, coalesce, jobQueue, type Drawing } from './viewutil';
import { isSafeExternalUrl } from '../util/sanitize';
import { PageChangeTracker } from './pagechange';
import type { Rect } from '../pdf/ops/annots';
import type { Dest } from '../pdf/structure';

const CSS_PER_PT = 96 / 72;
/** Largest page bitmap: iOS refuses canvases above 16.7 megapixels; desktops get more before CSS stretches the rest. */
const MAX_CANVAS_PIXELS = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 16e6 : 48e6;
const MULTI_CLICK = ['polygon', 'polyline', 'cloud'];

interface LinkArea { rect: Rect; url?: string; dest?: Dest }
interface PageSlot { i: number; el: HTMLElement; canvas: HTMLCanvasElement; text: HTMLElement; overlay: SVGSVGElement; rendered: string; painted: string; token: string; proxy: PDFPageProxy | null; task: any; gen: number; width: number; height: number; sig: string; textLayer: any; items: TextItem[] | null; links: LinkArea[] | null; selEls: HTMLElement[] | null }

/** `rect` is the first rectangle of the match; `rects` has one per text item the match covers (a match can span lines). */
export interface SearchHit { page: number; item: number; rect: Rect; rects?: Rect[] }

export class Viewer implements TabView {
  el: HTMLElement;
  private rail: HTMLElement;
  private scroll: HTMLElement;
  private pagesEl: HTMLElement;
  private grid: HTMLElement;
  pdf: PDFDocumentProxy | null = null;
  private slots: PageSlot[] = [];
  private _zoom = 1;
  private fit: 'fit-width' | 'fit-page' | null = 'fit-width';
  private observer: IntersectionObserver | null = null;
  private evictObserver: IntersectionObserver | null = null;
  private railIO: IntersectionObserver | null = null;
  private gridIO: IntersectionObserver | null = null;
  private resizeObs: ResizeObserver | null = null;
  private listeners = new AbortController();
  private _page = 0;
  private _tool: Tool = 'select';
  toolOpts: any = {};
  selectedAnnot: { page: number; num: number } | null = null;
  /** Thumbnails selected in the rail/grid (page indexes). */
  pageSel: number[] = [];
  viewRotation = 0;
  gridMode = false;
  private thumbCache = new Map<string, string>();
  private thumbJobs = jobQueue(2);
  private hits: SearchHit[] = [];
  private hitIndex = -1;
  private searchSeq = 0;
  private dragFrom: number | null = null;
  private destroyed = false;
  /**
   * One token per page that changes when the page may look different (pagechange.ts): renders and thumbnails
   * are keyed by it, so after an edit only the pages it touched are drawn again.
   */
  private tokens: string[] = [];
  private tracker = new PageChangeTracker();
  private uniq = 0;
  /** The bytes of the last load, so a reload of the same bytes draws everything again. */
  private loadedBytes: Uint8Array | null = null;
  private textCache = new Map<number, Promise<string>>();
  private drawing: Drawing | null = null;
  onSelect: (() => void) | null = null;
  presenting = false;

  constructor(public app: App, public tab: DocTab) {
    this.rail = h('nav', { class: 'qf-rail', 'aria-label': 'Pages', tabindex: '0' });
    this.pagesEl = h('div', { class: 'qf-pages' });
    this.grid = h('div', { class: 'qf-grid', style: 'display:none' });
    this.scroll = h('div', { class: 'qf-scroll', tabindex: '0' }, this.pagesEl, this.grid);
    this.el = h('div', { class: 'qf-viewer' }, this.rail, this.scroll);
    const signal = this.listeners.signal;
    this.scroll.addEventListener('scroll', debounce(() => this.onScroll(), 60), { signal });
    this.scroll.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.setZoom(this._zoom * wheelZoomFactor(e.deltaY, e.deltaMode), { x: e.clientX, y: e.clientY }); } }, { passive: false, signal });
    this.scroll.addEventListener('keydown', (e) => this.keys(e), { signal });
    this.rail.addEventListener('keydown', (e) => this.railKeys(e), { signal });
    this.grid.addEventListener('keydown', (e) => this.railKeys(e), { signal });
    this.resizeObs = new ResizeObserver(() => { if (this.fit) this.applyFit(); });
    this.resizeObs.observe(this.scroll);
    // On document, so removed in destroy(): otherwise every closed tab would stay alive through this closure.
    document.addEventListener('selectionchange', () => { if (this.el.contains(document.activeElement) || this.el.contains(document.getSelection()?.anchorNode as Node)) this.onSelect?.(); }, { signal });
    // Pinch: zoom follows the distance between the fingers, around the point between them (the CSS keeps
    // the browser from zooming the whole app at the same time).
    let pinch: { d: number; zoom: number } | null = null;
    const spread = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    this.scroll.addEventListener('touchstart', (e) => { pinch = e.touches.length === 2 ? { d: spread(e), zoom: this._zoom } : null; }, { passive: true, signal });
    this.scroll.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 2 || !pinch || pinch.d < 1) return;
      const z = Math.min(8, Math.max(0.1, pinch.zoom * spread(e) / pinch.d));
      if (Math.abs(z / this._zoom - 1) > 0.01) this.setZoom(z, { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 });
    }, { passive: true, signal });
    for (const n of ['touchend', 'touchcancel'] as const) this.scroll.addEventListener(n, (e) => { if (e.touches.length < 2) pinch = null; }, { passive: true, signal });
    void this.reload();
  }

  // ------------------------------------------------------------------------------------------
  // TabView

  get zoom(): number { return this._zoom; }
  get page(): number { return this._page; }
  get tool(): Tool { return this._tool; }
  focus(): void { this.scroll.focus({ preventScroll: true }); }

  destroy(): void {
    this.destroyed = true;
    this.listeners.abort();
    this.resizeObs?.disconnect();
    for (const o of [this.observer, this.evictObserver, this.railIO, this.gridIO]) o?.disconnect();
    this.thumbJobs.clear();
    for (const s of this.slots) this.release(s);
    this.slots = [];
    this.textCache.clear(); this.thumbCache.clear(); this.hits = [];
    this.onSelect = null;
    void (this.pdf as any)?.destroy?.();
    this.pdf = null;
    this.el.remove();
  }

  layout(): void {
    const p = this.app.prefs;
    this.rail.style.display = p.showThumbnails && !this.gridMode && !this.presenting ? '' : 'none';
    this.pagesEl.style.display = this.gridMode ? 'none' : '';
    this.grid.style.display = this.gridMode ? '' : 'none';
    this.pagesEl.dataset.mode = this.tab.view;
    this.el.classList.toggle('qf-night', p.nightMode);
    this.el.classList.toggle('qf-gray', p.grayscale);
    this.el.classList.toggle('qf-grid-mode', this.gridMode);
    if (this.gridMode) this.renderGrid();
    if (this.fit) this.applyFit();
    this.renderRail();
  }

  /** Reloads the bytes. Calls made while a load runs share one following load, so quick edits never pile up documents. */
  reload: () => Promise<void> = coalesce(() => this.load());

  private async load(): Promise<void> {
    const old = this.pdf;
    // Taken together, in the same turn: the bytes and the record of which objects changed to make them.
    const bytes = this.tab.bytes;
    const changes = this.tab.takeChanges();
    let tokens: string[];
    try { tokens = this.tracker.tokens(this.tab.doc, changes.touched !== 'all' && !changes.touched.size && bytes === this.loadedBytes ? 'all' : changes.touched, changes.numbering); }
    catch (e) { console.warn('page changes', e); this.tracker.reset(); tokens = []; }
    let pdf: PDFDocumentProxy;
    try { pdf = await openPdfjs(bytes, this.tab.password || undefined); }
    catch (e: any) { this.tracker.reset(); console.error(e); toast(`The renderer could not read the document: ${e?.message || e}`); return; }
    if (this.destroyed) { void (pdf as any).destroy?.(); return; }
    this.pdf = pdf;
    this.loadedBytes = bytes;
    // The engine and pdf.js disagree about the pages: every page counts as changed.
    if (tokens.length !== pdf.numPages) { this.tracker.reset(); tokens = Array.from({ length: pdf.numPages }, () => `u${++this.uniq}`); }
    this.tokens = tokens;
    const sameCount = !!old && old.numPages === pdf.numPages;
    void (old as any)?.destroy?.();
    const live = new Set(tokens);
    for (const k of [...this.thumbCache.keys()]) if (!live.has(k.slice(0, k.lastIndexOf(':')))) this.thumbCache.delete(k);
    this.hits = []; this.hitIndex = -1; this.searchSeq++;
    if (this.slots.length === pdf.numPages) {
      // Same number of pages: keep the elements. A page whose token is unchanged keeps its bitmap and text
      // layer and is not drawn again; the others are repainted in place (a new size first, if it has one).
      let resized = false;
      for (const s of this.slots) {
        const sig = this.pageSig(s.i), same = s.token === tokens[s.i] && s.sig === sig;
        s.gen++; try { s.task?.cancel(); } catch { /* */ } s.task = null; s.proxy = null; s.links = null;
        s.token = tokens[s.i];
        if (same) { s.rendered = s.painted; continue; }
        s.items = null; s.rendered = ''; s.painted = '';
        this.textCache.delete(s.i);
        if (s.sig !== sig) { const b = this.pageBox(s.i); s.width = b.w; s.height = b.h; s.sig = sig; resized = true; }
      }
      if (resized) { if (this.fit) this.applyFit(); else this.resizeSlots(); }
      this.renderVisible();
      this.refreshAnnotations();
    } else {
      this.textCache.clear();
      const keepScroll = this.scroll.scrollTop;
      this.buildSlots();
      if (sameCount) this.scroll.scrollTop = keepScroll; else this.goToPage(Math.min(this._page, pdf.numPages - 1));
    }
    this.renderRail();
    if (this.gridMode) this.renderGrid();
    this.app.refresh();
  }

  /** Display size in points and total rotation of page i, from the engine (no pdf.js page needed). */
  private pageBox(i: number): { w: number; h: number; rot: number; box: Rect } {
    const info = this.tab.doc.pages[i];
    const rot = totalRotation(info?.rotate, this.viewRotation);
    const w = info ? info.width : 612, hh = info ? info.height : 792;
    return { w: rot % 180 ? hh : w, h: rot % 180 ? w : hh, rot, box: (info?.cropBox as Rect) || [0, 0, w, hh] };
  }
  private pageSig(i: number): string { const b = this.pageBox(i); return `${b.w.toFixed(2)}:${b.h.toFixed(2)}:${b.rot}`; }
  /** Rotation to render page s with: the page's own /Rotate plus the view rotation. */
  private rotationOf(s: PageSlot): number { return s.proxy ? totalRotation(s.proxy.rotate, this.viewRotation) : this.pageBox(s.i).rot; }

  private buildSlots(): void {
    const pdf = this.pdf!;
    this.observer?.disconnect();
    this.evictObserver?.disconnect();
    for (const s of this.slots) this.release(s);
    clear(this.pagesEl);
    this.slots = [];
    const n = pdf.numPages;
    for (let i = 0; i < n; i++) {
      // Page sizes from the engine (no proxy needed yet), with the page and view rotation.
      const b = this.pageBox(i);
      const canvas = h('canvas', { class: 'qf-canvas' }) as HTMLCanvasElement;
      canvas.width = canvas.height = 0;
      const text = h('div', { class: 'textLayer' });
      const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlay.setAttribute('class', 'qf-overlay');
      const el = h('div', { class: 'qf-page', 'data-i': String(i), 'aria-label': `Page ${i + 1}` }, canvas, text, overlay as unknown as HTMLElement);
      el.style.width = `${b.w * CSS_PER_PT * this._zoom}px`;
      el.style.height = `${b.h * CSS_PER_PT * this._zoom}px`;
      const slot: PageSlot = { i, el, canvas, text, overlay, rendered: '', painted: '', token: this.tokens[i] ?? `u${++this.uniq}`, proxy: null, task: null, gen: 0, width: b.w, height: b.h, sig: this.pageSig(i), textLayer: null, items: null, links: null, selEls: null };
      this.applyToolTo(slot);
      this.bindPointer(slot);
      this.slots.push(slot);
      this.pagesEl.appendChild(el);
    }
    const slotOf = (e: IntersectionObserverEntry) => this.slots[+(e.target as HTMLElement).dataset.i!];
    this.observer = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) void this.renderSlot(slotOf(e)); }, { root: this.scroll, rootMargin: '600px 0px' });
    // Pages far from view give their bitmap and text layer back; without this every visited page stays in memory.
    this.evictObserver = new IntersectionObserver((entries) => { for (const e of entries) if (!e.isIntersecting) { const s = slotOf(e); if (s) this.release(s); } }, { root: this.scroll, rootMargin: '2400px 0px' });
    for (const s of this.slots) { this.observer.observe(s.el); this.evictObserver.observe(s.el); }
    if (this.fit) this.applyFit(); else this.resizeSlots();
  }

  /** Frees what a page holds for display; it renders again when it comes back into view. */
  private release(s: PageSlot): void {
    s.gen++;
    try { s.task?.cancel(); } catch { /* */ }
    s.task = null;
    try { s.textLayer?.cancel?.(); } catch { /* */ }
    s.textLayer = null;
    if (s.canvas.width || s.canvas.height) s.canvas.width = s.canvas.height = 0;
    clear(s.text);
    while (s.overlay.firstChild) s.overlay.removeChild(s.overlay.firstChild);
    if (s.selEls) s.selEls[0].style.display = 'none';
    s.rendered = ''; s.painted = '';
    try { s.proxy?.cleanup(); } catch { /* still rendering elsewhere (a thumbnail) */ }
  }

  private sizeTextLayer(s: PageSlot): void {
    // The text layer keeps the page's unrotated size and is turned by CSS (data-main-rotation).
    const k = CSS_PER_PT * this._zoom, turned = this.rotationOf(s) % 180 !== 0;
    s.text.style.setProperty('--scale-factor', String(k));
    s.text.style.width = `${(turned ? s.height : s.width) * k}px`;
    s.text.style.height = `${(turned ? s.width : s.height) * k}px`;
  }

  /** Applies the zoom to every page box; `anchor` (client coordinates, default: the middle of the view) stays where it is. */
  private resizeSlots(anchor?: { x: number; y: number }): void {
    const v = this.scroll.getBoundingClientRect();
    const ax = anchor ? anchor.x : v.left + v.width / 2, ay = anchor ? anchor.y : v.top + v.height / 2;
    let at: PageSlot | null = null, fx = 0, fy = 0, best = Infinity;
    if (v.width > 0) for (const s of this.slots) {
      const r = s.el.getBoundingClientRect();
      if (r.bottom < v.top - 40 || r.top > v.bottom + 40 || r.width <= 0 || r.height <= 0) continue;
      const d = Math.max(0, r.left - ax, ax - r.right) + Math.max(0, r.top - ay, ay - r.bottom);
      if (d < best) { best = d; at = s; fx = (ax - r.left) / r.width; fy = (ay - r.top) / r.height; }
    }
    const k = CSS_PER_PT * this._zoom;
    for (const s of this.slots) {
      s.el.style.width = `${s.width * k}px`;
      s.el.style.height = `${s.height * k}px`;
      this.sizeTextLayer(s);
      if (s.textLayer && s.proxy) { try { s.textLayer.update({ viewport: s.proxy.getViewport({ scale: k, rotation: this.rotationOf(s) }) }); this.sizeTextLayer(s); } catch { /* */ } }
      if (s.selEls && s.selEls[0].style.display !== 'none') this.drawOverlay(s); // the selection frame is placed in px
    }
    if (at) {
      const r = at.el.getBoundingClientRect();
      this.scroll.scrollLeft += r.left + fx * r.width - ax;
      this.scroll.scrollTop += r.top + fy * r.height - ay;
    }
    // The old bitmaps stretch to the new size at once; the sharp ones follow when the zoom settles.
    this.renderSoon();
    this.app.refresh();
  }

  private renderSoon = debounce(() => this.renderVisible(), 90);
  private renderVisible(): void { if (!this.destroyed) for (const s of this.slots) if (this.isVisible(s)) void this.renderSlot(s); }

  private isVisible(s: PageSlot): boolean {
    const r = s.el.getBoundingClientRect(), v = this.scroll.getBoundingClientRect();
    return r.height > 0 && r.bottom > v.top - 600 && r.top < v.bottom + 600;
  }

  private async renderSlot(s: PageSlot): Promise<void> {
    const pdf = this.pdf;
    if (!s || !pdf || this.destroyed) return;
    const scale = CSS_PER_PT * this._zoom;
    const dpr = Math.min(this.app.prefs.renderDpiCap || 3, window.devicePixelRatio || 1);
    const key = `${s.token}|${scale.toFixed(5)}|${dpr}|${this.viewRotation}`;
    if (s.rendered === key) return;
    s.rendered = key;
    // Every render of a slot gets a number; after each await a render that is no longer the latest stops
    // without touching the slot, so a late result never overwrites a newer one.
    const gen = ++s.gen;
    const stale = () => gen !== s.gen || pdf !== this.pdf || this.destroyed;
    try {
      if (!s.proxy) { const proxy = await pdf.getPage(s.i + 1); if (stale()) return; s.proxy = proxy; }
      try { s.task?.cancel(); } catch { /* */ }
      const proxy = s.proxy, rotation = this.rotationOf(s);
      const cssVp = proxy.getViewport({ scale, rotation });
      s.width = cssVp.width / scale; s.height = cssVp.height / scale;
      const vp = proxy.getViewport({ scale: outputScale(s.width, s.height, scale, dpr, MAX_CANVAS_PIXELS), rotation });
      s.el.style.width = `${cssVp.width}px`; s.el.style.height = `${cssVp.height}px`;
      // Paint on a fresh canvas and swap it in when done: the page never flashes blank on zoom or after an edit.
      const canvas = h('canvas', { class: 'qf-canvas' }) as HTMLCanvasElement;
      canvas.width = Math.max(1, Math.floor(vp.width)); canvas.height = Math.max(1, Math.floor(vp.height));
      const task = proxy.render({ canvasContext: canvas.getContext('2d', { alpha: false })!, viewport: vp, annotationMode: AnnotationMode.ENABLE, background: '#ffffff' } as any);
      s.task = task;
      try { await task.promise; } finally { if (s.task === task) s.task = null; if (stale()) canvas.width = canvas.height = 0; }
      if (stale()) return;
      const before = s.canvas;
      before.replaceWith(canvas);
      before.width = before.height = 0;
      s.canvas = canvas;
      // Text layer
      const content = await proxy.getTextContent();
      if (stale()) return;
      try { s.textLayer?.cancel?.(); } catch { /* */ }
      clear(s.text);
      const layer = new PdfjsTextLayer({ textContentSource: content, container: s.text, viewport: cssVp } as any);
      s.textLayer = layer;
      this.sizeTextLayer(s);
      await layer.render();
      if (stale()) return;
      this.drawOverlay(s);
      s.painted = key;
    } catch (e: any) {
      if (stale()) return;
      if (e?.name !== 'RenderingCancelledException' && e?.name !== 'AbortException') console.warn('render', s.i, e);
      s.rendered = '';
    }
  }

  private onScroll(): void {
    // Current page: the one covering the middle of the view.
    const v = this.scroll.getBoundingClientRect();
    const mid = v.top + v.height / 3;
    let best = this._page, bestD = Infinity;
    for (const s of this.slots) { const r = s.el.getBoundingClientRect(); if (r.bottom < v.top || r.top > v.bottom) continue; const d = Math.abs(r.top - mid) < r.height ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid)); if (r.top <= mid && r.bottom >= mid) { best = s.i; bestD = -1; break; } if (d < bestD) { bestD = d; best = s.i; } }
    if (best !== this._page) { this._page = best; this.highlightRail(); this.app.refresh(); }
  }

  /** `anchor`: the client point that keeps its place (the pointer for wheel zoom, between the fingers for a pinch). */
  setZoom(z: number | 'fit-width' | 'fit-page' | 'actual', anchor?: { x: number; y: number }): void {
    if (z === 'fit-width' || z === 'fit-page') { this.fit = z; this.applyFit(); return; }
    this.fit = null;
    const nz = z === 'actual' ? 1 : Math.min(8, Math.max(0.1, z));
    if (!Number.isFinite(nz)) return;
    this._zoom = nz;
    this.resizeSlots(anchor);
  }

  private applyFit(): void {
    if (!this.slots.length || !this.fit) return;
    const avail = this.scroll.clientWidth - 40, availH = this.scroll.clientHeight - 24;
    if (avail <= 0) return; // hidden tab
    const s = this.slots[Math.min(this._page, this.slots.length - 1)];
    const cols = this.tab.view === 'facing' || this.tab.view === 'book' ? 2 : 1;
    const zw = avail / cols / (s.width * CSS_PER_PT) / (cols === 2 ? 1.02 : 1);
    const zh = availH / (s.height * CSS_PER_PT);
    const z = this.fit === 'fit-width' ? zw : Math.min(zw, zh);
    if (Math.abs(z - this._zoom) < 0.001) return;
    this._zoom = Math.min(8, Math.max(0.1, z));
    const v = this.scroll.getBoundingClientRect();
    this.resizeSlots({ x: v.left + v.width / 2, y: v.top + 1 });
  }

  goToPage(i: number, y?: number): void {
    const s = this.slots[Math.max(0, Math.min(this.slots.length - 1, i))];
    if (!s) return;
    this._page = s.i;
    const top = s.el.offsetTop - 8 + (y != null ? Math.max(0, this.toCss(s, this.pageBox(s.i).box[0], y)[1]) : 0);
    this.scroll.scrollTo({ top, behavior: this.app.prefs.smoothScroll ? 'smooth' : 'auto' });
    this.highlightRail();
    this.app.refresh();
  }

  rotateView(delta: number): void {
    this.viewRotation = ((this.viewRotation + delta) % 360 + 360) % 360;
    this.thumbCache.clear();
    const page = this._page;
    this.buildSlots();
    this.scroll.scrollTop = Math.max(0, (this.slots[page]?.el.offsetTop || 0) - 8);
    this.renderRail();
    if (this.gridMode) this.renderGrid();
  }

  async pageText(i: number): Promise<string> {
    if (!this.pdf) return '';
    let p = this.textCache.get(i);
    if (!p) {
      p = this.pdf.getPage(i + 1).then(pageTextString);
      this.textCache.set(i, p);
      p.catch(() => { if (this.textCache.get(i) === p) this.textCache.delete(i); }); // a failure is not cached
    }
    return p;
  }

  async allText(max = 2000): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < Math.min(max, this.pdf?.numPages || 0); i++) out.push(await this.pageText(i));
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Selection

  get selectedText(): string {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !this.el.contains(sel.anchorNode)) return '';
    return sel.toString();
  }

  /** Rectangles of the text selection in PDF user space, per page. */
  get selectionRects(): { page: number; rects: Rect[] } | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !this.el.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    const byPage = new Map<number, Rect[]>();
    for (const r of [...range.getClientRects()]) {
      if (r.width < 1 || r.height < 1) continue;
      const slot = this.slots.find((s) => { const b = s.el.getBoundingClientRect(); return r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1; });
      if (!slot) continue;
      const a = this.toPdf(slot, r.left, r.bottom), b = this.toPdf(slot, r.right, r.top);
      const rect: Rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      const list = byPage.get(slot.i) || [];
      // Merge with a rect on the same line.
      const same = list.find((x) => Math.abs(x[1] - rect[1]) < 2 && Math.abs(x[3] - rect[3]) < 2 && (rect[0] <= x[2] + 2 && rect[2] >= x[0] - 2));
      if (same) { same[0] = Math.min(same[0], rect[0]); same[2] = Math.max(same[2], rect[2]); } else list.push(rect);
      byPage.set(slot.i, list);
    }
    const first = [...byPage.entries()].sort((a, b) => a[0] - b[0])[0];
    return first ? { page: first[0], rects: first[1] } : null;
  }

  clearSelection(): void { document.getSelection()?.removeAllRanges(); }

  /** Client → PDF user space (unrotated page, bottom-left origin). */
  toPdf(slot: PageSlot, clientX: number, clientY: number): [number, number] {
    const b = slot.el.getBoundingClientRect();
    const k = CSS_PER_PT * this._zoom;
    const vp = slot.proxy?.getViewport({ scale: k, rotation: this.rotationOf(slot) });
    if (vp) { const p = vp.convertToPdfPoint(clientX - b.left, clientY - b.top); return [p[0], p[1]]; }
    const pb = this.pageBox(slot.i);
    return cssToPage(pb.box, pb.rot, k, clientX - b.left, clientY - b.top);
  }
  /** PDF user space → position inside the page element (CSS px). */
  toCss(slot: PageSlot, x: number, y: number): [number, number] {
    const k = CSS_PER_PT * this._zoom;
    const vp = slot.proxy?.getViewport({ scale: k, rotation: this.rotationOf(slot) });
    if (vp) { const p = vp.convertToViewportPoint(x, y); return [p[0], p[1]]; }
    const pb = this.pageBox(slot.i);
    return pageToCss(pb.box, pb.rot, k, x, y);
  }

  // ------------------------------------------------------------------------------------------
  // Tools and overlay

  setTool(t: Tool, opts: any = {}): void {
    if (this.drawing) { const page = this.drawing.page; this.drawing = null; if (this.slots[page]) this.drawOverlay(this.slots[page]); }
    this._tool = t; this.toolOpts = opts;
    this.el.dataset.tool = t;
    this.el.classList.toggle('qf-tool-hand', t === 'hand');
    this.el.classList.toggle('qf-tool-draw', !['hand', 'select', 'edit'].includes(t));
    for (const s of this.slots) this.applyToolTo(s);
    this.app.refresh();
  }
  /** The text layer takes the pointer only with the tools that select text (also for pages built after an edit). */
  private applyToolTo(s: PageSlot): void { s.text.style.pointerEvents = this._tool === 'select' || this._tool === 'edit' ? '' : 'none'; }

  /** Escape inside the page view: drops the drawing in progress, else the annotation selection. False when there was neither. */
  escape(): boolean {
    if (this.drawing) { this.drawing = null; this.refreshAnnotations(); return true; }
    if (this.selectedAnnot) { this.selectedAnnot = null; this.refreshAnnotations(); this.onSelect?.(); this.app.refresh(); return true; }
    return false;
  }

  private bindPointer(slot: PageSlot): void {
    const el = slot.el;
    let panStart: [number, number, number, number] | null = null;
    let moveAnnot: { num: number; rect: Rect; start: [number, number]; handle: string; last?: Rect } | null = null;
    let linkDown: { link: LinkArea; x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2 || !e.isPrimary) return;
      linkDown = null;
      const t = this._tool;
      this._page = slot.i; this.highlightRail();
      if (t === 'hand') { panStart = [e.clientX, e.clientY, this.scroll.scrollLeft, this.scroll.scrollTop]; el.setPointerCapture(e.pointerId); e.preventDefault(); return; }
      if (t === 'select' || t === 'edit') {
        // A plain click on a link follows it; with Ctrl, Cmd or Alt (or the context menu) the link is selected like any annotation.
        const handle = (e.target as HTMLElement).dataset?.handle;
        if (t === 'select' && !handle && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const link = this.linkAt(slot, e.clientX, e.clientY);
          if (link) { linkDown = { link, x: e.clientX, y: e.clientY }; return; }
        }
        // Annotation hit test (resize handles of the selected one first).
        const hit = handle && this.selectedAnnot ? this.selectedAnnot.num : this.annotAt(slot, e.clientX, e.clientY);
        if (hit != null) {
          const a = this.annotRect(slot.i, hit);
          if (a) { this.selectedAnnot = { page: slot.i, num: hit }; moveAnnot = { num: hit, rect: a, start: this.toPdf(slot, e.clientX, e.clientY), handle: handle || 'move' }; el.setPointerCapture(e.pointerId); this.drawOverlay(slot); this.onSelect?.(); this.app.refresh(); e.preventDefault(); return; }
        }
        if (this.selectedAnnot) { this.selectedAnnot = null; this.drawOverlay(slot); this.onSelect?.(); this.app.refresh(); }
        if (t === 'edit') { const p = this.toPdf(slot, e.clientX, e.clientY); this.app.exec('edit.pickAt', { page: slot.i, x: p[0], y: p[1] }); e.preventDefault(); }
        return;
      }
      // Drawing tools (polygon, polyline and cloud keep their points from click to click)
      this.drawing = drawingOnDown(t, this.drawing, slot.i, this.toPdf(slot, e.clientX, e.clientY));
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (panStart) { this.scroll.scrollLeft = panStart[2] - (e.clientX - panStart[0]); this.scroll.scrollTop = panStart[3] - (e.clientY - panStart[1]); return; }
      if (moveAnnot) {
        const p = this.toPdf(slot, e.clientX, e.clientY);
        const dx = p[0] - moveAnnot.start[0], dy = p[1] - moveAnnot.start[1];
        const r = moveAnnot.rect;
        let nr: Rect = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
        if (moveAnnot.handle === 'se') nr = [r[0], Math.min(r[1] + dy, r[3] - 4), Math.max(r[2] + dx, r[0] + 4), r[3]];
        else if (moveAnnot.handle === 'nw') nr = [Math.min(r[0] + dx, r[2] - 4), r[1], r[2], Math.max(r[3] + dy, r[1] + 4)];
        else if (moveAnnot.handle === 'ne') nr = [r[0], r[1], Math.max(r[2] + dx, r[0] + 4), Math.max(r[3] + dy, r[1] + 4)];
        else if (moveAnnot.handle === 'sw') nr = [Math.min(r[0] + dx, r[2] - 4), Math.min(r[1] + dy, r[3] - 4), r[2], r[3]];
        this.drawOverlay(slot, nr);
        moveAnnot.last = nr;
        return;
      }
      if (this.drawing && this.drawing.page === slot.i) {
        const p = this.toPdf(slot, e.clientX, e.clientY);
        if (this._tool === 'ink' || this._tool === 'highlighter' || this._tool === 'eraser') this.drawing.pts.push(p);
        else if (MULTI_CLICK.includes(this._tool)) this.drawing.pts[this.drawing.pts.length - 1] = p;
        else this.drawing.pts = [this.drawing.start, p];
        this.drawOverlay(slot);
        return;
      }
      if (this._tool === 'select' && e.buttons === 0) el.classList.toggle('qf-over-link', !!this.linkAt(slot, e.clientX, e.clientY));
    });
    const finish = (e: PointerEvent) => {
      if (panStart) { panStart = null; return; }
      if (linkDown) {
        const d = linkDown; linkDown = null;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5 && !this.selectedText) void this.followLink(d.link);
        return;
      }
      if (moveAnnot) {
        const last = moveAnnot.last;
        const num = moveAnnot.num;
        moveAnnot = null;
        if (last) this.app.exec('comment.moveAnnotation', { page: slot.i, num, rect: last });
        return;
      }
      const d = this.drawing;
      if (!d || d.page !== slot.i) return;
      const t = this._tool;
      const p = this.toPdf(slot, e.clientX, e.clientY);
      if (MULTI_CLICK.includes(t)) {
        // Each click fixes a corner and starts the next segment; double-click or Enter finishes.
        d.pts[d.pts.length - 1] = p;
        d.pts.push(p);
        this.drawOverlay(slot);
        return;
      }
      this.drawing = null;
      this.drawOverlay(slot);
      const dist = Math.hypot(p[0] - d.start[0], p[1] - d.start[1]);
      const rect: Rect = [Math.min(d.start[0], p[0]), Math.min(d.start[1], p[1]), Math.max(d.start[0], p[0]), Math.max(d.start[1], p[1])];
      this.app.exec('comment.toolDone', { tool: t, page: slot.i, start: d.start, end: p, rect, pts: d.pts, click: dist < 3, opts: this.toolOpts });
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', () => { panStart = null; moveAnnot = null; linkDown = null; if (!MULTI_CLICK.includes(this._tool)) this.drawing = null; this.drawOverlay(slot); });
    el.addEventListener('pointerleave', () => el.classList.remove('qf-over-link'));
    el.addEventListener('dblclick', (e) => {
      if (this.drawing && MULTI_CLICK.includes(this._tool)) { this.finishShape(); e.preventDefault(); return; }
      if (this._tool === 'select') {
        const hit = this.annotAt(slot, e.clientX, e.clientY);
        if (hit != null) { this.selectedAnnot = { page: slot.i, num: hit }; this.app.exec('comment.properties'); e.preventDefault(); }
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this.annotAt(slot, e.clientX, e.clientY);
      if (hit != null) { this.selectedAnnot = { page: slot.i, num: hit }; this.drawOverlay(slot); this.app.refresh(); }
      this.app.ui.pageContextMenu(e.clientX, e.clientY, slot.i, hit != null, !!this.selectedText);
    });
  }

  /** Ends a polygon, polyline or cloud: the corners clicked so far (without the segment still following the pointer). */
  private finishShape(): void {
    const d = this.drawing;
    if (!d) return;
    const slot = this.slots[d.page];
    this.drawing = null;
    if (slot) this.drawOverlay(slot);
    const pts = d.pts.slice(0, -1).filter((q, k, a) => k === 0 || Math.hypot(q[0] - a[k - 1][0], q[1] - a[k - 1][1]) > 0.5);
    if (pts.length < 2) { toast('Click at least two points, then double-click or press Enter.'); return; }
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    this.app.exec('comment.toolDone', { tool: this._tool, page: d.page, start: d.start, end: pts[pts.length - 1], rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pts, click: false, opts: this.toolOpts });
  }

  /** Object number of the topmost annotation under a client point, or null. */
  annotAt(slot: PageSlot, cx: number, cy: number): number | null {
    const [x, y] = this.toPdf(slot, cx, cy);
    const annots = this.annotsOf(slot.i);
    for (let i = annots.length - 1; i >= 0; i--) {
      const a = annots[i];
      if (a.hidden) continue;
      if (x >= a.rect[0] - 2 && x <= a.rect[2] + 2 && y >= a.rect[1] - 2 && y <= a.rect[3] + 2) return a.num;
    }
    return null;
  }

  annotsOf(i: number): { num: number; rect: Rect; subtype: string; hidden: boolean }[] {
    const p = this.tab.doc.pages[i];
    if (!p) return [];
    const { pageAnnotations } = requireStructure();
    return pageAnnotations(this.tab.doc, p).filter((a) => a.ref && a.subtype !== 'Popup').map((a) => ({ num: a.ref!.num, rect: a.rect, subtype: a.subtype, hidden: a.hidden }));
  }
  annotRect(i: number, num: number): Rect | null { return this.annotsOf(i).find((a) => a.num === num)?.rect || null; }

  /** Link annotations of a page that go to a place in the document or to a web, mail or phone address (read once per load). */
  private linksOf(slot: PageSlot): LinkArea[] {
    if (slot.links) return slot.links;
    const out: LinkArea[] = [];
    try {
      const doc = this.tab.doc, p = doc.pages[slot.i];
      const { pageAnnotations, resolveDest } = requireStructure();
      for (const a of p ? pageAnnotations(doc, p) : []) {
        if (a.subtype !== 'Link' || a.hidden) continue;
        const act = doc.getDict(a.dict, 'A');
        const kind = act ? doc.getName(act, 'S') : '';
        const url = act && kind === 'URI' ? doc.getText(act, 'URI') : '';
        const dest = act && kind === 'GoTo' ? resolveDest(doc, act.get('D') ?? null) : !act && a.dict.has('Dest') ? resolveDest(doc, a.dict.get('Dest')!) : null;
        if (url) out.push({ rect: a.rect, url }); else if (dest) out.push({ rect: a.rect, dest });
      }
    } catch { /* a damaged annotation list has no links */ }
    return (slot.links = out);
  }
  private linkAt(slot: PageSlot, cx: number, cy: number): LinkArea | null {
    const links = this.linksOf(slot);
    if (!links.length) return null;
    const [x, y] = this.toPdf(slot, cx, cy);
    for (let i = links.length - 1; i >= 0; i--) { const r = links[i].rect; if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return links[i]; }
    return null;
  }
  private async followLink(l: LinkArea): Promise<void> {
    if (l.dest) { this.goToPage(l.dest.page, l.dest.y); return; }
    if (!l.url) return;
    // app.followLink refuses script and file addresses; for the rest the user sees where the link really goes first.
    if (isSafeExternalUrl(l.url) && !(await confirmDialog('Open Link', `This document links to:\n${l.url.slice(0, 300)}`, 'Open'))) return;
    this.app.followLink(l.url);
  }

  /** Redraws the overlays of the pages that are on screen or near it; a page out of view gets its overlay when it renders. */
  refreshAnnotations(): void { for (const s of this.slots) if (s.canvas.width || s.overlay.firstChild || (s.selEls && s.selEls[0].style.display !== 'none')) this.drawOverlay(s); }

  /** Draws search hits, the selected annotation and the drawing in progress on the page overlay. */
  private drawOverlay(slot: PageSlot, liveRect?: Rect): void {
    const svg = slot.overlay;
    const d = this.drawing;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const W = slot.el.clientWidth, H = slot.el.clientHeight;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const ns = 'http://www.w3.org/2000/svg';
    const rectEl = (r: Rect, cls: string, extra: Record<string, string> = {}) => {
      const a = this.toCss(slot, r[0], r[3]), b = this.toCss(slot, r[2], r[1]);
      const e = document.createElementNS(ns, 'rect');
      e.setAttribute('x', String(Math.min(a[0], b[0]))); e.setAttribute('y', String(Math.min(a[1], b[1])));
      e.setAttribute('width', String(Math.abs(b[0] - a[0]))); e.setAttribute('height', String(Math.abs(b[1] - a[1])));
      e.setAttribute('class', cls);
      for (const [k, v] of Object.entries(extra)) e.setAttribute(k, v);
      svg.appendChild(e);
      return e;
    };
    // Search hits
    this.hits.forEach((hit, k) => { if (hit.page === slot.i) for (const r of hit.rects || [hit.rect]) rectEl(r, 'qf-hit' + (k === this.hitIndex ? ' qf-hit-current' : '')); });
    // Form field highlight
    if (this.app.prefs.highlightFields && this.tab.fillMode) for (const a of this.annotsOf(slot.i)) if (a.subtype === 'Widget' && !a.hidden) rectEl(a.rect, 'qf-field');
    // Selected annotation with handles
    const selRect = this.selectedAnnot && this.selectedAnnot.page === slot.i ? liveRect || this.annotRect(slot.i, this.selectedAnnot.num) : null;
    // The frame and its handles are HTML elements kept from one redraw to the next: `touch-action: none`
    // (so a finger drags the annotation instead of scrolling) does not apply to shapes inside an SVG.
    if (selRect) {
      const r = selRect;
      const els = (slot.selEls ||= (() => {
        const box = h('div', { class: 'qf-sel' });
        const handles = ['nw', 'ne', 'sw', 'se'].map((name) => h('div', { class: 'qf-handle', 'data-handle': name }));
        box.append(...handles);
        return [box, ...handles];
      })());
      const a = this.toCss(slot, r[0], r[3]), b = this.toCss(slot, r[2], r[1]);
      const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
      Object.assign(els[0].style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(b[0] - a[0])}px`, height: `${Math.abs(b[1] - a[1])}px`, display: '' });
      const corners: [number, number][] = [[r[0], r[3]], [r[2], r[3]], [r[0], r[1]], [r[2], r[1]]];
      corners.forEach(([hx, hy], k) => { const c = this.toCss(slot, hx, hy); els[k + 1].style.left = `${c[0] - x0}px`; els[k + 1].style.top = `${c[1] - y0}px`; });
      if (els[0].parentNode !== slot.el) slot.el.appendChild(els[0]);
    } else if (slot.selEls) slot.selEls[0].style.display = 'none';
    // Drawing in progress
    if (d && d.page === slot.i && d.pts.length) {
      const t = this._tool;
      if (['ink', 'highlighter', 'eraser', 'polygon', 'polyline', 'cloud', 'line', 'arrow', 'measure'].includes(t)) {
        const path = document.createElementNS(ns, 'polyline');
        path.setAttribute('points', d.pts.map((q) => this.toCss(slot, q[0], q[1]).join(',')).join(' '));
        path.setAttribute('class', t === 'highlighter' ? 'qf-draw-hl' : 'qf-draw');
        if (t === 'polygon' || t === 'cloud') path.setAttribute('fill', 'none');
        svg.appendChild(path);
        if (t === 'measure' && d.pts.length === 2) {
          const len = Math.hypot(d.pts[1][0] - d.pts[0][0], d.pts[1][1] - d.pts[0][1]);
          const label = document.createElementNS(ns, 'text');
          const c = this.toCss(slot, d.pts[1][0], d.pts[1][1]);
          label.setAttribute('x', String(c[0] + 6)); label.setAttribute('y', String(c[1] - 6)); label.setAttribute('class', 'qf-measure-label');
          label.textContent = formatLength(len, this.app.prefs.measureUnit, this.app.prefs as any);
          svg.appendChild(label);
        }
      } else if (d.pts.length === 2) {
        const [a, b] = d.pts;
        const r: Rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        rectEl(r, t === 'circle' ? 'qf-draw qf-draw-circle' : t === 'redact' ? 'qf-draw-redact' : t.startsWith('field') ? 'qf-draw-field' : 'qf-draw', t === 'circle' ? { rx: '50%' } : {});
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Search

  /**
   * Finds text on every page. A newer call (or a reload) supersedes one still reading pages: the older
   * call resolves to [] and leaves the highlights alone, so the results always belong to one query.
   */
  async search(q: string, opts: { caseSensitive?: boolean; wholeWord?: boolean } = {}): Promise<{ page: number; count: number }[]> {
    const my = ++this.searchSeq;
    const pdf = this.pdf;
    if (!q.trim() || !pdf) { this.hits = []; this.hitIndex = -1; this.refreshAnnotations(); return []; }
    const re = searchRegex(q, opts);
    const hits: SearchHit[] = [];
    const counts: { page: number; count: number }[] = [];
    for (const s of this.slots) {
      if (!s.items) {
        const proxy = s.proxy || await pdf.getPage(s.i + 1);
        const items = await pageTextItems(proxy);
        if (my !== this.searchSeq || pdf !== this.pdf) return [];
        s.proxy ||= proxy; s.items = items;
      }
      const found = searchItems(s.items, re);
      for (const f of found) hits.push({ page: s.i, item: f.item, rect: f.rects[0], rects: f.rects });
      if (found.length) counts.push({ page: s.i, count: found.length });
    }
    if (my !== this.searchSeq) return [];
    hits.sort((x, y) => x.page - y.page || y.rect[1] - x.rect[1] || x.rect[0] - y.rect[0]);
    this.hits = hits; this.hitIndex = -1;
    this.refreshAnnotations();
    if (this.hits.length) this.findNext(1);
    return counts;
  }
  get searchHits(): SearchHit[] { return this.hits; }
  get searchIndex(): number { return this.hitIndex; }
  findNext(dir: 1 | -1): void {
    if (!this.hits.length) return;
    this.hitIndex = (this.hitIndex + dir + this.hits.length) % this.hits.length;
    const hit = this.hits[this.hitIndex];
    this.goToPage(hit.page, hit.rect[3] + 60);
    this.refreshAnnotations();
    this.app.ui.status?.(`Match ${this.hitIndex + 1} of ${this.hits.length}`);
  }
  clearSearch(): void { this.searchSeq++; this.hits = []; this.hitIndex = -1; this.refreshAnnotations(); }

  // ------------------------------------------------------------------------------------------
  // Thumbnails, rail and grid

  /** Thumbnail of page i, cached by the page's token: pages an edit did not touch keep theirs. */
  async thumb(i: number, width = 120): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.tokens[i], key = `${token}:${width}`;
      const hit = this.thumbCache.get(key);
      if (hit) return hit;
      const pdf = this.pdf, rot = this.viewRotation;
      if (!pdf || token === undefined) return '';
      try {
        const page = await pdf.getPage(i + 1);
        const rotation = totalRotation(page.rotate, rot);
        const vp0 = page.getViewport({ scale: 1, rotation });
        const vp = page.getViewport({ scale: (width * 2) / vp0.width, rotation });
        const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        await page.render({ canvasContext: c.getContext('2d')!, viewport: vp, annotationMode: AnnotationMode.ENABLE } as any).promise;
        const url = c.toDataURL('image/jpeg', 0.7);
        c.width = c.height = 0;
        // A thumbnail of a page that changed meanwhile, or of another view rotation, is returned to its caller but not kept.
        if (this.tokens[i] === token && rot === this.viewRotation) this.thumbCache.set(key, url);
        return url;
      } catch {
        // A reload replaced the document while this was drawing: once more, from the new one.
        if (this.pdf === pdf || this.destroyed) return '';
      }
    }
    return '';
  }

  async renderPagePng(i: number, dpi: number): Promise<Blob> {
    if (!this.pdf) throw new Error('No document');
    const page = await this.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: AnnotationMode.ENABLE } as any).promise;
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the page'))), 'image/png'));
  }

  /** Renders a page region (PDF rect) to a PNG blob (Snapshot). */
  async renderRegion(i: number, rect: Rect, dpi = 200): Promise<Blob> {
    if (!this.pdf) throw new Error('No document');
    const page = await this.pdf.getPage(i + 1);
    const scale = dpi / 72;
    const vp = page.getViewport({ scale });
    const a = vp.convertToViewportPoint(rect[0], rect[3]), b = vp.convertToViewportPoint(rect[2], rect[1]);
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), hh = Math.abs(b[1] - a[1]);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.floor(w)); c.height = Math.max(1, Math.floor(hh));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(-x, -y);
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: AnnotationMode.ENABLE } as any).promise;
    return new Promise((res, rej) => c.toBlob((b2) => (b2 ? res(b2) : rej(new Error('Could not encode the region'))), 'image/png'));
  }

  /** Thumbnails render when they scroll into view (two at a time), not all at once. */
  private thumbObserver(root: HTMLElement, width: number): IntersectionObserver {
    return new IntersectionObserver((entries) => {
      for (const e of entries) { const t = e.target as HTMLElement; t.dataset.vis = e.isIntersecting ? '1' : ''; if (e.isIntersecting) this.loadThumb(t, width); }
    }, { root, rootMargin: '300px 0px' });
  }
  private loadThumb(t: HTMLElement, width: number): void {
    const img = t.querySelector('img');
    const now = () => `${this.tokens[+t.dataset.i!]}:${this.viewRotation}`;
    const want = now();
    if (!img || img.dataset.epoch === want || img.dataset.pending === want) return;
    img.dataset.pending = want;
    this.thumbJobs.add(async () => {
      if (t.dataset.vis !== '1' || !t.isConnected || want !== now()) { if (img.dataset.pending === want) delete img.dataset.pending; return; }
      const u = await this.thumb(+t.dataset.i!, width);
      if (img.dataset.pending === want) delete img.dataset.pending;
      if (u && want === now()) { img.src = u; img.dataset.epoch = want; }
    });
  }
  /** After a reload the old pictures stay until the visible thumbnails have been drawn again. */
  private refreshThumbs(box: HTMLElement, width: number): void { box.querySelectorAll<HTMLElement>('[data-vis="1"]').forEach((t) => this.loadThumb(t, width)); }

  private thumbEl(i: number, cls: string, label: string, alt: string): HTMLElement {
    const img = h('img', { class: `${cls}-img`, alt, draggable: 'false' }) as HTMLImageElement;
    const t = h('div', { class: cls, 'data-i': String(i), draggable: 'true', role: 'option' }, img, h('span', { class: `${cls}-n` }, label));
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!this.pageSel.includes(i)) this.selectPage(i); this.app.ui.thumbContextMenu(e.clientX, e.clientY); });
    t.addEventListener('dragstart', (e) => { this.dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); });
    t.addEventListener('dragover', (e) => { e.preventDefault(); t.classList.add('qf-dragover'); });
    t.addEventListener('dragleave', () => t.classList.remove('qf-dragover'));
    t.addEventListener('drop', (e) => { e.preventDefault(); t.classList.remove('qf-dragover'); if (this.dragFrom != null && this.dragFrom !== i) this.app.exec('organize.moveTo', { from: this.pageSel.length > 1 && this.pageSel.includes(this.dragFrom) ? this.pageSel : [this.dragFrom], to: i }); this.dragFrom = null; });
    return t;
  }

  private railKey = '';
  renderRail(): void {
    if (this.rail.style.display === 'none' || !this.pdf) return;
    const n = this.pdf.numPages;
    const labels = this.pageLabels();
    const key = `${n}:${labels.join('\u0001')}`;
    if (this.railKey !== key) {
      this.railKey = key;
      this.railIO?.disconnect();
      clear(this.rail);
      this.railIO = this.thumbObserver(this.rail, 120);
      for (let i = 0; i < n; i++) {
        const t = this.thumbEl(i, 'qf-thumb', labels[i] || String(i + 1), '');
        // Choosing pages in the rail ends an annotation selection, so Delete here means the page.
        t.addEventListener('click', (e) => { if (this.selectedAnnot) { this.selectedAnnot = null; this.refreshAnnotations(); } this.selectPage(i, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey }); this.goToPage(i); });
        this.rail.appendChild(t);
        this.railIO.observe(t);
      }
    } else this.refreshThumbs(this.rail, 120);
    this.highlightRail();
  }
  private highlightRail(): void {
    this.rail.querySelectorAll<HTMLElement>('.qf-thumb').forEach((t) => { const i = +t.dataset.i!; t.classList.toggle('qf-current', i === this._page); t.classList.toggle('qf-selected', this.pageSel.includes(i)); t.setAttribute('aria-selected', String(this.pageSel.includes(i))); });
    this.grid.querySelectorAll<HTMLElement>('.qf-gthumb').forEach((t) => { const i = +t.dataset.i!; t.classList.toggle('qf-selected', this.pageSel.includes(i)); t.classList.toggle('qf-current', i === this._page); t.setAttribute('aria-selected', String(this.pageSel.includes(i))); });
    const cur = this.rail.querySelector<HTMLElement>('.qf-current');
    cur?.scrollIntoView({ block: 'nearest' });
  }

  selectPage(i: number, opts: { extend?: boolean; toggle?: boolean } = {}): void {
    if (opts.toggle) this.pageSel = this.pageSel.includes(i) ? this.pageSel.filter((x) => x !== i) : [...this.pageSel, i];
    else if (opts.extend && this.pageSel.length) { const a = Math.min(this.pageSel[0], i), b = Math.max(this.pageSel[0], i); this.pageSel = [...Array(b - a + 1).keys()].map((k) => a + k); }
    else this.pageSel = [i];
    this._page = i;
    this.highlightRail();
    this.app.refresh();
  }
  selectAllPages(): void { this.pageSel = this.slots.map((s) => s.i); this.highlightRail(); this.app.refresh(); }

  /** Pages the organize commands act on: the selection, or the current page. */
  targetPages(): number[] { return this.pageSel.length ? [...this.pageSel].sort((a, b) => a - b) : [this._page]; }

  setGridMode(on: boolean): void { this.gridMode = on; this.layout(); if (!on) this.goToPage(this._page); }

  private gridKey = '';
  private renderGrid(): void {
    if (!this.pdf) return;
    const labels = this.pageLabels();
    const n = this.pdf.numPages;
    const key = `${n}:${labels.join('\u0001')}`;
    if (this.gridKey !== key || !this.grid.firstChild) {
      this.gridKey = key;
      this.gridIO?.disconnect();
      clear(this.grid);
      this.gridIO = this.thumbObserver(this.scroll, 180);
      for (let i = 0; i < n; i++) {
        const t = this.thumbEl(i, 'qf-gthumb', labels[i] || String(i + 1), `Page ${i + 1}`);
        t.tabIndex = 0;
        t.addEventListener('click', (e) => this.selectPage(i, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
        t.addEventListener('dblclick', () => { this.setGridMode(false); this.app.exec('view.organize'); this.goToPage(i); });
        this.grid.appendChild(t);
        this.gridIO.observe(t);
      }
    } else this.refreshThumbs(this.grid, 180);
    this.highlightRail();
  }

  pageLabels(): string[] {
    const { readPageLabels, pageLabelList } = requireStructure();
    const ranges = readPageLabels(this.tab.doc);
    return ranges.length ? pageLabelList(ranges, this.tab.doc.pageCount) : [];
  }

  // ------------------------------------------------------------------------------------------
  // Keys

  private keys(e: KeyboardEvent): void {
    if (e.defaultPrevented) return; // a shortcut already ran a command for this key
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    const n = this.pdf?.numPages || 0;
    if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { if (this.tab.view !== 'continuous' || e.key === ' ') { this.goToPage(Math.min(n - 1, this._page + 1)); e.preventDefault(); } }
    else if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { if (this.tab.view !== 'continuous' || e.key === ' ') { this.goToPage(Math.max(0, this._page - 1)); e.preventDefault(); } }
    else if (e.key === 'Home' && (e.ctrlKey || e.metaKey)) { this.goToPage(0); e.preventDefault(); }
    else if (e.key === 'End' && (e.ctrlKey || e.metaKey)) { this.goToPage(n - 1); e.preventDefault(); }
    else if (e.key === 'Escape') { if (!this.escape() && this._tool !== 'select') this.app.exec('home.select'); e.preventDefault(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedAnnot) { this.app.exec('comment.delete'); e.preventDefault(); }
    else if (e.key === 'Enter' && this.drawing && MULTI_CLICK.includes(this._tool)) { this.finishShape(); e.preventDefault(); }
  }
  private railKeys(e: KeyboardEvent): void {
    if (e.defaultPrevented) return;
    const n = this.pdf?.numPages || 0;
    const move = (to: number) => {
      if (this.selectedAnnot) { this.selectedAnnot = null; this.refreshAnnotations(); }
      this.selectPage(to, { extend: e.shiftKey });
      // In the Organize grid the focus follows the selection; in the rail the page view follows it.
      if ((e.target as HTMLElement).closest?.('.qf-grid')) this.grid.querySelector<HTMLElement>(`.qf-gthumb[data-i="${this._page}"]`)?.focus(); else this.goToPage(this._page);
      e.preventDefault();
    };
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') move(Math.min(n - 1, this._page + 1));
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') move(Math.max(0, this._page - 1));
    else if (e.key === 'Delete') { e.preventDefault(); void this.deletePagesFromRail(); }
    else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { this.selectAllPages(); e.preventDefault(); }
  }
  /** Delete in the rail: one page is confirmed here; the command itself asks before deleting several. */
  private async deletePagesFromRail(): Promise<void> {
    const pages = this.targetPages(), n = this.tab.doc.pageCount;
    if (pages.length === 1 && n > 1) {
      const label = this.pageLabels()[pages[0]];
      if (!(await confirmDialog('Delete Page', `Delete page ${label ? `${label} (${pages[0] + 1})` : pages[0] + 1} of ${n}?`, 'Delete'))) return;
      if (this.destroyed || this.app.tab !== this.tab) return;
    }
    this.app.exec('organize.delete', pages);
  }

  /** Text items of a page (cached), for commands that need positions (tables, redaction by search). */
  async items(i: number): Promise<TextItem[]> {
    const s = this.slots[i];
    const pdf = this.pdf;
    if (!s || !pdf) return [];
    if (!s.items) {
      const proxy = s.proxy || await pdf.getPage(i + 1);
      const items = await pageTextItems(proxy);
      if (pdf !== this.pdf || this.slots[i] !== s) return items; // reloaded meanwhile: correct for the bytes asked about, not cached
      s.proxy ||= proxy; s.items = items;
    }
    return s.items;
  }
}

/** Length in points formatted in the chosen unit, honoring a drawing scale (points per unit). */
export function formatLength(pt: number, unit: string, prefs: { measureScale?: number; measureScaleUnit?: string }): string {
  const scale = prefs.measureScale || 1;
  const u = prefs.measureScaleUnit || unit;
  const v = pt * scale;
  const conv: Record<string, number> = { pt: 1, in: 1 / 72, mm: 25.4 / 72, cm: 2.54 / 72, ft: 1 / 864, m: 0.0254 / 72 };
  const k = conv[u] ?? 1;
  return `${(v * k).toFixed(u === 'pt' ? 0 : 2)} ${u}`;
}

import * as structureMod from '../pdf/structure';
function requireStructure() { return structureMod; }
