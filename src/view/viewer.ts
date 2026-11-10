/**
 * The document view of one tab: pages rendered by pdf.js on demand, a selectable text layer, search
 * highlights, the annotation and form tools drawn on an overlay, a thumbnail rail with drag-reorder,
 * and the Organize Pages grid. Edits go to the engine through the commands; the viewer reloads the
 * bytes the engine produces.
 */
import type { App, DocTab, TabView, Tool } from '../app';
import { h, clear, icon, debounce } from '../ui/dom';
import { showMenu, toast } from '../ui/dialog';
import { openPdfjs, pageTextItems, pageTextString, PdfjsTextLayer, AnnotationMode, type PDFDocumentProxy, type PDFPageProxy, type TextItem } from './pdfjs';
import type { Rect } from '../pdf/ops/annots';

const CSS_PER_PT = 96 / 72;

interface PageSlot { i: number; el: HTMLElement; canvas: HTMLCanvasElement; text: HTMLElement; overlay: SVGSVGElement; rendered: number; proxy: PDFPageProxy | null; task: any; width: number; height: number; textLayer: any; items: TextItem[] | null }

export interface SearchHit { page: number; item: number; rect: Rect }

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
  private _page = 0;
  private _tool: Tool = 'select';
  toolOpts: any = {};
  selectedAnnot: { page: number; num: number } | null = null;
  /** Thumbnails selected in the rail/grid (page indexes). */
  pageSel: number[] = [];
  viewRotation = 0;
  gridMode = false;
  private thumbCache = new Map<number, string>();
  private hits: SearchHit[] = [];
  private hitIndex = -1;
  private dragFrom: number | null = null;
  private destroyed = false;
  private textCache = new Map<number, Promise<string>>();
  private drawing: { pts: [number, number][]; page: number; start: [number, number] } | null = null;
  private loading: Promise<void> | null = null;
  onSelect: (() => void) | null = null;
  presenting = false;

  constructor(public app: App, public tab: DocTab) {
    this.rail = h('nav', { class: 'qf-rail', 'aria-label': 'Pages', tabindex: '0' });
    this.pagesEl = h('div', { class: 'qf-pages' });
    this.grid = h('div', { class: 'qf-grid', style: 'display:none' });
    this.scroll = h('div', { class: 'qf-scroll', tabindex: '0' }, this.pagesEl, this.grid);
    this.el = h('div', { class: 'qf-viewer' }, this.rail, this.scroll);
    this.scroll.addEventListener('scroll', debounce(() => this.onScroll(), 60));
    this.scroll.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.setZoom(Math.min(8, Math.max(0.1, this._zoom * (e.deltaY < 0 ? 1.1 : 0.9)))); } }, { passive: false });
    this.scroll.addEventListener('keydown', (e) => this.keys(e));
    this.rail.addEventListener('keydown', (e) => this.railKeys(e));
    new ResizeObserver(() => { if (this.fit) this.applyFit(); }).observe(this.scroll);
    document.addEventListener('selectionchange', () => { if (this.el.contains(document.activeElement) || this.el.contains(document.getSelection()?.anchorNode as Node)) this.onSelect?.(); });
    let pinch = 0;
    this.scroll.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }, { passive: true });
    this.scroll.addEventListener('touchmove', (e) => { if (e.touches.length === 2 && pinch) { const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); if (Math.abs(d - pinch) > 12) { this.setZoom(Math.min(8, Math.max(0.1, this._zoom * (d > pinch ? 1.05 : 0.95)))); pinch = d; } } }, { passive: true });
    void this.reload();
  }

  // ------------------------------------------------------------------------------------------
  // TabView

  get zoom(): number { return this._zoom; }
  get page(): number { return this._page; }
  get tool(): Tool { return this._tool; }
  focus(): void { this.scroll.focus({ preventScroll: true }); }
  destroy(): void { this.destroyed = true; this.observer?.disconnect(); void (this.pdf as any)?.destroy?.(); this.el.remove(); }

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

  async reload(): Promise<void> {
    if (this.loading) await this.loading.catch(() => undefined);
    const run = async () => {
      const old = this.pdf;
      let pdf: PDFDocumentProxy;
      try { pdf = await openPdfjs(this.tab.bytes, this.tab.password || undefined); }
      catch (e: any) { console.error(e); toast(`The renderer could not read the document: ${e?.message || e}`); return; }
      if (this.destroyed) { void (pdf as any).destroy?.(); return; }
      this.pdf = pdf;
      const keepScroll = this.scroll.scrollTop;
      const sameCount = old && old.numPages === pdf.numPages;
      void (old as any)?.destroy?.();
      this.textCache.clear();
      this.thumbCache.clear();
      this.hits = [];
      await this.buildSlots();
      if (sameCount) this.scroll.scrollTop = keepScroll; else this.goToPage(Math.min(this._page, pdf.numPages - 1));
      this.renderRail();
      if (this.gridMode) this.renderGrid();
      this.app.refresh();
    };
    this.loading = run();
    try { await this.loading; } finally { this.loading = null; }
  }

  private async buildSlots(): Promise<void> {
    const pdf = this.pdf!;
    this.observer?.disconnect();
    clear(this.pagesEl);
    this.slots = [];
    const n = pdf.numPages;
    const widths: number[] = [];
    for (let i = 0; i < n; i++) {
      // Page sizes from the engine (no proxy needed yet), with the view rotation.
      const info = this.tab.doc.pages[i];
      const rot = ((info?.rotate || 0) + this.viewRotation) % 180;
      const w = info ? (rot ? info.height : info.width) : 612, hh = info ? (rot ? info.width : info.height) : 792;
      widths.push(w);
      const canvas = h('canvas', { class: 'qf-canvas' }) as HTMLCanvasElement;
      const text = h('div', { class: 'textLayer' });
      const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      overlay.setAttribute('class', 'qf-overlay');
      const el = h('div', { class: 'qf-page', 'data-i': String(i), 'aria-label': `Page ${i + 1}` }, canvas, text, overlay as unknown as HTMLElement);
      el.style.width = `${w * CSS_PER_PT * this._zoom}px`;
      el.style.height = `${hh * CSS_PER_PT * this._zoom}px`;
      const slot: PageSlot = { i, el, canvas, text, overlay, rendered: 0, proxy: null, task: null, width: w, height: hh, textLayer: null, items: null };
      this.bindPointer(slot);
      this.slots.push(slot);
      this.pagesEl.appendChild(el);
    }
    this.observer = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) void this.renderSlot(this.slots[+(e.target as HTMLElement).dataset.i!]); }, { root: this.scroll, rootMargin: '600px 0px' });
    for (const s of this.slots) this.observer.observe(s.el);
    if (this.fit) this.applyFit(); else this.resizeSlots();
  }

  private resizeSlots(): void {
    for (const s of this.slots) {
      s.el.style.width = `${s.width * CSS_PER_PT * this._zoom}px`;
      s.el.style.height = `${s.height * CSS_PER_PT * this._zoom}px`;
      s.rendered = 0;
      s.text.style.setProperty('--scale-factor', String(CSS_PER_PT * this._zoom));
      if (s.textLayer && s.proxy) { try { s.textLayer.update({ viewport: s.proxy.getViewport({ scale: CSS_PER_PT * this._zoom, rotation: this.viewRotation }) }); } catch { /* */ } }
    }
    for (const s of this.slots) if (this.isVisible(s)) void this.renderSlot(s);
    this.app.refresh();
  }

  private isVisible(s: PageSlot): boolean {
    const r = s.el.getBoundingClientRect(), v = this.scroll.getBoundingClientRect();
    return r.bottom > v.top - 600 && r.top < v.bottom + 600;
  }

  private async renderSlot(s: PageSlot): Promise<void> {
    if (!this.pdf || this.destroyed) return;
    const scale = CSS_PER_PT * this._zoom;
    const dpr = Math.min(this.app.prefs.renderDpiCap || 3, window.devicePixelRatio || 1);
    const key = scale * dpr * 1000 + this.viewRotation;
    if (s.rendered === key) return;
    s.rendered = key;
    try {
      if (!s.proxy) s.proxy = await this.pdf.getPage(s.i + 1);
      if (s.task) { try { s.task.cancel(); } catch { /* */ } }
      const vp = s.proxy.getViewport({ scale: scale * dpr, rotation: this.viewRotation });
      const canvas = s.canvas;
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      canvas.style.width = `${vp.width / dpr}px`; canvas.style.height = `${vp.height / dpr}px`;
      s.el.style.width = `${vp.width / dpr}px`; s.el.style.height = `${vp.height / dpr}px`;
      const ctx = canvas.getContext('2d', { alpha: false })!;
      s.task = s.proxy.render({ canvasContext: ctx, viewport: vp, annotationMode: AnnotationMode.ENABLE, background: '#ffffff' } as any);
      await s.task.promise;
      s.task = null;
      // Text layer
      const cssVp = s.proxy.getViewport({ scale, rotation: this.viewRotation });
      s.text.style.setProperty('--scale-factor', String(scale));
      clear(s.text);
      s.textLayer = new PdfjsTextLayer({ textContentSource: await s.proxy.getTextContent(), container: s.text, viewport: cssVp } as any);
      await s.textLayer.render();
      this.drawOverlay(s);
    } catch (e: any) {
      if (e?.name !== 'RenderingCancelledException') { console.warn('render', s.i, e); }
      s.rendered = 0;
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

  setZoom(z: number | 'fit-width' | 'fit-page' | 'actual'): void {
    if (z === 'fit-width' || z === 'fit-page') { this.fit = z; this.applyFit(); return; }
    this.fit = null;
    this._zoom = z === 'actual' ? 1 : Math.min(8, Math.max(0.1, z));
    this.resizeSlots();
  }

  private applyFit(): void {
    if (!this.slots.length || !this.fit) return;
    const avail = this.scroll.clientWidth - 40, availH = this.scroll.clientHeight - 24;
    const s = this.slots[Math.min(this._page, this.slots.length - 1)];
    const cols = this.tab.view === 'facing' || this.tab.view === 'book' ? 2 : 1;
    const zw = avail / cols / (s.width * CSS_PER_PT) / (cols === 2 ? 1.02 : 1);
    const zh = availH / (s.height * CSS_PER_PT);
    const z = this.fit === 'fit-width' ? zw : Math.min(zw, zh);
    if (Math.abs(z - this._zoom) < 0.001) return;
    this._zoom = Math.min(8, Math.max(0.1, z));
    this.resizeSlots();
  }

  goToPage(i: number, y?: number): void {
    const s = this.slots[Math.max(0, Math.min(this.slots.length - 1, i))];
    if (!s) return;
    this._page = s.i;
    const top = s.el.offsetTop - 8 + (y != null ? (s.height - y) * CSS_PER_PT * this._zoom : 0);
    this.scroll.scrollTo({ top, behavior: this.app.prefs.smoothScroll ? 'smooth' : 'auto' });
    this.highlightRail();
    this.app.refresh();
  }

  rotateView(delta: number): void { this.viewRotation = ((this.viewRotation + delta) % 360 + 360) % 360; this.thumbCache.clear(); void this.buildSlots(); this.renderRail(); }

  async pageText(i: number): Promise<string> {
    if (!this.pdf) return '';
    let p = this.textCache.get(i);
    if (!p) { p = this.pdf.getPage(i + 1).then(pageTextString); this.textCache.set(i, p); }
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
    const vp = (slot.proxy || null)?.getViewport({ scale: CSS_PER_PT * this._zoom, rotation: this.viewRotation });
    if (vp) { const p = vp.convertToPdfPoint(clientX - b.left, clientY - b.top); return [p[0], p[1]]; }
    const info = this.tab.doc.pages[slot.i];
    return [(clientX - b.left) / (CSS_PER_PT * this._zoom) + (info?.cropBox[0] || 0), info ? info.cropBox[3] - (clientY - b.top) / (CSS_PER_PT * this._zoom) : 0];
  }
  /** PDF user space → position inside the page element (CSS px). */
  toCss(slot: PageSlot, x: number, y: number): [number, number] {
    const vp = slot.proxy?.getViewport({ scale: CSS_PER_PT * this._zoom, rotation: this.viewRotation });
    if (vp) { const p = vp.convertToViewportPoint(x, y); return [p[0], p[1]]; }
    const info = this.tab.doc.pages[slot.i];
    return [(x - (info?.cropBox[0] || 0)) * CSS_PER_PT * this._zoom, ((info?.cropBox[3] || 0) - y) * CSS_PER_PT * this._zoom];
  }

  // ------------------------------------------------------------------------------------------
  // Tools and overlay

  setTool(t: Tool, opts: any = {}): void {
    this._tool = t; this.toolOpts = opts;
    this.el.dataset.tool = t;
    this.el.classList.toggle('qf-tool-hand', t === 'hand');
    this.el.classList.toggle('qf-tool-draw', !['hand', 'select', 'edit'].includes(t));
    for (const s of this.slots) s.text.style.pointerEvents = t === 'select' || t === 'edit' ? '' : 'none';
    this.app.refresh();
  }

  private bindPointer(slot: PageSlot): void {
    const el = slot.el;
    let panStart: [number, number, number, number] | null = null;
    let moveAnnot: { num: number; rect: Rect; start: [number, number]; handle: string } | null = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      const t = this._tool;
      this._page = slot.i; this.highlightRail();
      if (t === 'hand') { panStart = [e.clientX, e.clientY, this.scroll.scrollLeft, this.scroll.scrollTop]; el.setPointerCapture(e.pointerId); e.preventDefault(); return; }
      if (t === 'select' || t === 'edit') {
        // Annotation hit test (resize handles of the selected one first).
        const handle = (e.target as HTMLElement).dataset?.handle;
        const hit = handle && this.selectedAnnot ? this.selectedAnnot.num : this.annotAt(slot, e.clientX, e.clientY);
        if (hit != null) {
          const a = this.annotRect(slot.i, hit);
          if (a) { this.selectedAnnot = { page: slot.i, num: hit }; moveAnnot = { num: hit, rect: a, start: this.toPdf(slot, e.clientX, e.clientY), handle: handle || 'move' }; el.setPointerCapture(e.pointerId); this.drawOverlay(slot); this.onSelect?.(); this.app.refresh(); e.preventDefault(); return; }
        }
        if (this.selectedAnnot) { this.selectedAnnot = null; this.drawOverlay(slot); this.onSelect?.(); this.app.refresh(); }
        if (t === 'edit') { const p = this.toPdf(slot, e.clientX, e.clientY); this.app.exec('edit.pickAt', { page: slot.i, x: p[0], y: p[1] }); e.preventDefault(); }
        return;
      }
      // Drawing tools
      const p = this.toPdf(slot, e.clientX, e.clientY);
      this.drawing = { pts: [p], page: slot.i, start: p };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
      if (t === 'note' || t === 'stamp' || t === 'attach' || t === 'sign' || t === 'image' || t === 'text' || t === 'field-signature' && false) { /* click tools finish on pointerup */ }
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
        (moveAnnot as any).last = nr;
        return;
      }
      if (this.drawing && this.drawing.page === slot.i) {
        const p = this.toPdf(slot, e.clientX, e.clientY);
        if (['ink', 'highlighter', 'eraser', 'polygon', 'polyline', 'cloud'].includes(this._tool)) { if (this._tool === 'ink' || this._tool === 'highlighter' || this._tool === 'eraser') this.drawing.pts.push(p); else this.drawing.pts[this.drawing.pts.length - 1] = p; }
        else { this.drawing.pts = [this.drawing.start, p]; }
        this.drawOverlay(slot);
      }
    });
    const finish = (e: PointerEvent) => {
      if (panStart) { panStart = null; return; }
      if (moveAnnot) {
        const last = (moveAnnot as any).last as Rect | undefined;
        const num = moveAnnot.num;
        moveAnnot = null;
        if (last) this.app.exec('comment.moveAnnotation', { page: slot.i, num, rect: last });
        return;
      }
      const d = this.drawing;
      if (!d || d.page !== slot.i) return;
      const t = this._tool;
      const p = this.toPdf(slot, e.clientX, e.clientY);
      if (t === 'polygon' || t === 'polyline' || t === 'cloud') {
        // Click adds a point; double-click (or Enter) finishes: handled by dblclick.
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
    el.addEventListener('pointercancel', () => { panStart = null; moveAnnot = null; this.drawing = null; this.drawOverlay(slot); });
    // The page scrolls natively under a finger, which cancels the pointer after a few pixels. A
    // touch that began (pointerdown runs first) a drawing stroke, a marquee or an annotation move
    // or resize has to claim the gesture instead. Tools that place something with a tap (note,
    // stamp, attachment, signature) still let the page scroll.
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || !e.cancelable) return;
      const dragging = !!moveAnnot || (!!this.drawing && this.drawing.page === slot.i && !['note', 'stamp', 'attach', 'sign'].includes(this._tool));
      if (dragging) e.preventDefault();
    }, { passive: false });
    el.addEventListener('dblclick', (e) => {
      const d = this.drawing;
      if (d && (this._tool === 'polygon' || this._tool === 'polyline' || this._tool === 'cloud')) {
        this.drawing = null; this.drawOverlay(slot);
        const pts = d.pts.slice(0, -1);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        this.app.exec('comment.toolDone', { tool: this._tool, page: slot.i, start: d.start, end: pts[pts.length - 1], rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pts, click: false, opts: this.toolOpts });
        e.preventDefault();
        return;
      }
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

  refreshAnnotations(): void { for (const s of this.slots) this.drawOverlay(s); }

  /** Draws search hits, the selected annotation and the drawing in progress on the page overlay. */
  private drawOverlay(slot: PageSlot, liveRect?: Rect): void {
    const svg = slot.overlay;
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
    this.hits.forEach((hit, k) => { if (hit.page === slot.i) rectEl(hit.rect, 'qf-hit' + (k === this.hitIndex ? ' qf-hit-current' : '')); });
    // Form field highlight
    if (this.app.prefs.highlightFields && this.tab.fillMode) for (const a of this.annotsOf(slot.i)) if (a.subtype === 'Widget' && !a.hidden) rectEl(a.rect, 'qf-field');
    // Selected annotation with handles
    if (this.selectedAnnot && this.selectedAnnot.page === slot.i) {
      const r = liveRect || this.annotRect(slot.i, this.selectedAnnot.num);
      if (r) {
        rectEl(r, 'qf-sel');
        for (const [hx, hy, name] of [[r[0], r[3], 'nw'], [r[2], r[3], 'ne'], [r[0], r[1], 'sw'], [r[2], r[1], 'se']] as [number, number, string][]) {
          const c = this.toCss(slot, hx, hy);
          const e = document.createElementNS(ns, 'rect');
          e.setAttribute('x', String(c[0] - 5)); e.setAttribute('y', String(c[1] - 5)); e.setAttribute('width', '10'); e.setAttribute('height', '10');
          e.setAttribute('class', 'qf-handle'); e.dataset.handle = name;
          svg.appendChild(e);
        }
      }
    }
    // Drawing in progress
    const d = this.drawing;
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

  async search(q: string, opts: { caseSensitive?: boolean; wholeWord?: boolean } = {}): Promise<{ page: number; count: number }[]> {
    this.hits = []; this.hitIndex = -1;
    if (!q || !this.pdf) { this.refreshAnnotations(); return []; }
    const re = new RegExp((opts.wholeWord ? '\\b' : '') + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (opts.wholeWord ? '\\b' : ''), opts.caseSensitive ? 'g' : 'gi');
    const counts: { page: number; count: number }[] = [];
    for (const s of this.slots) {
      if (!s.items) { if (!s.proxy) s.proxy = await this.pdf.getPage(s.i + 1); s.items = await pageTextItems(s.proxy); }
      let n = 0;
      for (let k = 0; k < s.items.length; k++) {
        const it = s.items[k];
        if (!it.str) continue;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(it.str))) {
          const frac0 = m.index / it.str.length, frac1 = (m.index + m[0].length) / it.str.length;
          this.hits.push({ page: s.i, item: k, rect: [it.x + it.w * frac0, it.y - it.h * 0.2, it.x + it.w * frac1, it.y + it.h * 0.85] });
          n++;
          if (!m[0].length) break;
        }
      }
      if (n) counts.push({ page: s.i, count: n });
      // Matches across item boundaries: check the joined text of consecutive items.
      for (let k = 0; k + 1 < s.items.length; k++) {
        const a = s.items[k], b = s.items[k + 1];
        if (!a.str || !b.str) continue;
        const joined = a.str + b.str;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(joined))) { if (m.index < a.str.length && m.index + m[0].length > a.str.length) { this.hits.push({ page: s.i, item: k, rect: [a.x + a.w * (m.index / a.str.length), a.y - a.h * 0.2, b.x + b.w * ((m.index + m[0].length - a.str.length) / b.str.length), a.y + a.h * 0.85] }); const c = counts.find((x) => x.page === s.i); if (c) c.count++; else counts.push({ page: s.i, count: 1 }); } if (!m[0].length) break; }
      }
    }
    this.hits.sort((x, y) => x.page - y.page || y.rect[1] - x.rect[1] || x.rect[0] - y.rect[0]);
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
  clearSearch(): void { this.hits = []; this.hitIndex = -1; this.refreshAnnotations(); }

  // ------------------------------------------------------------------------------------------
  // Thumbnails, rail and grid

  async thumb(i: number, width = 120): Promise<string> {
    const key = i;
    const hit = this.thumbCache.get(key);
    if (hit) return hit;
    if (!this.pdf) return '';
    try {
      const page = await this.pdf.getPage(i + 1);
      const vp0 = page.getViewport({ scale: 1, rotation: this.viewRotation });
      const scale = (width * 2) / vp0.width;
      const vp = page.getViewport({ scale, rotation: this.viewRotation });
      const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d')!, viewport: vp, annotationMode: AnnotationMode.ENABLE } as any).promise;
      const url = c.toDataURL('image/jpeg', 0.7);
      this.thumbCache.set(key, url);
      return url;
    } catch { return ''; }
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

  private railKey = '';
  renderRail(): void {
    if (this.rail.style.display === 'none' || !this.pdf) return;
    const n = this.pdf.numPages;
    const key = `${n}:${this.tab.bytes.length}:${this.viewRotation}`;
    if (this.railKey !== key) {
      this.railKey = key;
      clear(this.rail);
      const labels = this.pageLabels();
      for (let i = 0; i < n; i++) {
        const img = h('img', { class: 'qf-thumb-img', alt: '', draggable: 'false' }) as HTMLImageElement;
        const t = h('div', { class: 'qf-thumb', 'data-i': String(i), draggable: 'true', role: 'option' }, img, h('span', { class: 'qf-thumb-n' }, labels[i] || String(i + 1)));
        t.addEventListener('click', (e) => { this.selectPage(i, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey }); this.goToPage(i); });
        t.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!this.pageSel.includes(i)) this.selectPage(i); this.app.ui.thumbContextMenu(e.clientX, e.clientY); });
        t.addEventListener('dragstart', (e) => { this.dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); });
        t.addEventListener('dragover', (e) => { e.preventDefault(); t.classList.add('qf-dragover'); });
        t.addEventListener('dragleave', () => t.classList.remove('qf-dragover'));
        t.addEventListener('drop', (e) => { e.preventDefault(); t.classList.remove('qf-dragover'); if (this.dragFrom != null && this.dragFrom !== i) this.app.exec('organize.moveTo', { from: this.pageSel.length > 1 && this.pageSel.includes(this.dragFrom) ? this.pageSel : [this.dragFrom], to: i }); this.dragFrom = null; });
        this.rail.appendChild(t);
        void this.thumb(i).then((u) => { if (u) img.src = u; });
      }
    }
    this.highlightRail();
  }
  private highlightRail(): void {
    this.rail.querySelectorAll<HTMLElement>('.qf-thumb').forEach((t) => { const i = +t.dataset.i!; t.classList.toggle('qf-current', i === this._page); t.classList.toggle('qf-selected', this.pageSel.includes(i)); });
    this.grid.querySelectorAll<HTMLElement>('.qf-gthumb').forEach((t) => { const i = +t.dataset.i!; t.classList.toggle('qf-selected', this.pageSel.includes(i)); t.classList.toggle('qf-current', i === this._page); });
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

  private renderGrid(): void {
    if (!this.pdf) return;
    clear(this.grid);
    const labels = this.pageLabels();
    const n = this.pdf.numPages;
    for (let i = 0; i < n; i++) {
      const img = h('img', { class: 'qf-gthumb-img', alt: `Page ${i + 1}`, draggable: 'false' }) as HTMLImageElement;
      const t = h('div', { class: 'qf-gthumb', 'data-i': String(i), draggable: 'true', tabindex: '0', role: 'option' }, img, h('span', { class: 'qf-gthumb-n' }, labels[i] || String(i + 1)));
      t.addEventListener('click', (e) => this.selectPage(i, { extend: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
      t.addEventListener('dblclick', () => { this.setGridMode(false); this.app.exec('view.organize'); this.goToPage(i); });
      t.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!this.pageSel.includes(i)) this.selectPage(i); this.app.ui.thumbContextMenu(e.clientX, e.clientY); });
      t.addEventListener('dragstart', (e) => { this.dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); });
      t.addEventListener('dragover', (e) => { e.preventDefault(); t.classList.add('qf-dragover'); });
      t.addEventListener('dragleave', () => t.classList.remove('qf-dragover'));
      t.addEventListener('drop', (e) => { e.preventDefault(); t.classList.remove('qf-dragover'); if (this.dragFrom != null && this.dragFrom !== i) this.app.exec('organize.moveTo', { from: this.pageSel.length > 1 && this.pageSel.includes(this.dragFrom) ? this.pageSel : [this.dragFrom], to: i }); this.dragFrom = null; });
      this.grid.appendChild(t);
      void this.thumb(i, 180).then((u) => { if (u) img.src = u; });
    }
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
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
    const n = this.pdf?.numPages || 0;
    if (e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) { if (this.tab.view !== 'continuous' || e.key === ' ') { this.goToPage(Math.min(n - 1, this._page + 1)); e.preventDefault(); } }
    else if (e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) { if (this.tab.view !== 'continuous' || e.key === ' ') { this.goToPage(Math.max(0, this._page - 1)); e.preventDefault(); } }
    else if (e.key === 'Home' && (e.ctrlKey || e.metaKey)) { this.goToPage(0); e.preventDefault(); }
    else if (e.key === 'End' && (e.ctrlKey || e.metaKey)) { this.goToPage(n - 1); e.preventDefault(); }
    else if (e.key === 'Escape') { if (this.drawing) { this.drawing = null; this.refreshAnnotations(); } else if (this.selectedAnnot) { this.selectedAnnot = null; this.refreshAnnotations(); this.app.refresh(); } else if (this._tool !== 'select') this.app.exec('home.select'); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedAnnot) { this.app.exec('comment.delete'); e.preventDefault(); }
    else if (e.key === 'Enter' && this.drawing && (this._tool === 'polygon' || this._tool === 'polyline' || this._tool === 'cloud')) { const slot = this.slots[this.drawing.page]; slot.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 })); }
  }
  private railKeys(e: KeyboardEvent): void {
    const n = this.pdf?.numPages || 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { this.selectPage(Math.min(n - 1, this._page + 1), { extend: e.shiftKey }); this.goToPage(this._page); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { this.selectPage(Math.max(0, this._page - 1), { extend: e.shiftKey }); this.goToPage(this._page); e.preventDefault(); }
    else if (e.key === 'Delete') { this.app.exec('organize.delete'); e.preventDefault(); }
    else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { this.selectAllPages(); e.preventDefault(); }
  }

  /** Text items of a page (cached), for commands that need positions (tables, redaction by search). */
  async items(i: number): Promise<TextItem[]> {
    const s = this.slots[i];
    if (!s || !this.pdf) return [];
    if (!s.items) { if (!s.proxy) s.proxy = await this.pdf.getPage(i + 1); s.items = await pageTextItems(s.proxy); }
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
