/** Pure helpers of the viewer (no DOM, no pdf.js), so they can be unit-tested. */
export type Rect4 = [number, number, number, number];

export interface TextItemLike { str: string; x: number; y: number; w: number; h: number; hasEOL?: boolean }

/** Total clockwise rotation in 0/90/180/270 from the page's /Rotate and the view rotation. */
export function totalRotation(pageRotate: number | undefined, viewRotation: number): number {
  const r = Math.round(((pageRotate || 0) + viewRotation) / 90) * 90;
  return ((r % 360) + 360) % 360;
}

/** PDF user space → CSS px inside the page element, for a page shown with `rotation` at `k` px per point. */
export function pageToCss(box: Rect4, rotation: number, k: number, x: number, y: number): [number, number] {
  const [x0, y0, x1, y1] = box;
  switch (rotation) {
    case 90: return [(y - y0) * k, (x - x0) * k];
    case 180: return [(x1 - x) * k, (y - y0) * k];
    case 270: return [(y1 - y) * k, (x1 - x) * k];
    default: return [(x - x0) * k, (y1 - y) * k];
  }
}

/** Inverse of pageToCss. */
export function cssToPage(box: Rect4, rotation: number, k: number, cx: number, cy: number): [number, number] {
  const [x0, y0, x1, y1] = box;
  switch (rotation) {
    case 90: return [cy / k + x0, cx / k + y0];
    case 180: return [x1 - cx / k, cy / k + y0];
    case 270: return [x1 - cy / k, y1 - cx / k];
    default: return [cx / k + x0, y1 - cy / k];
  }
}

/** Canvas pixels per point: scale × devicePixelRatio, lowered so that the bitmap stays under `maxPixels`. */
export function outputScale(widthPt: number, heightPt: number, scale: number, dpr: number, maxPixels: number): number {
  const out = scale * dpr;
  const area = widthPt * heightPt * out * out;
  return area > maxPixels && area > 0 ? Math.sqrt(maxPixels / (widthPt * heightPt)) : out;
}

/** Zoom factor of one Ctrl+wheel event: trackpad pinches send many small deltas, wheels send notches. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 300 : deltaY;
  if (Math.abs(px) < 50) return Math.exp(-px / 100);
  return Math.pow(1.1, -Math.max(-3, Math.min(3, px / 100)));
}

export interface Drawing { pts: [number, number][]; page: number; start: [number, number] }

/** The drawing after a pointer goes down: click-by-click tools keep collecting points on the same page. */
export function drawingOnDown(tool: string, cur: Drawing | null, page: number, p: [number, number]): Drawing {
  const multi = tool === 'polygon' || tool === 'polyline' || tool === 'cloud';
  if (multi && cur && cur.page === page && cur.pts.length) return cur;
  return { pts: [p], page, start: p };
}

/** Plain text from pdf.js text items: one line break per line, a blank line where the gap is a paragraph's. */
export function textFromItems(items: { str?: string; transform?: number[]; height?: number; hasEOL?: boolean }[]): string {
  let s = '';
  let lastY: number | null = null, lastH = 0;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = it.transform ? it.transform[5] : 0;
    const hh = it.height || lastH || 10;
    if (lastY != null && it.str && Math.abs(y - lastY) > hh * 0.6) {
      if (!s.endsWith('\n')) s += '\n';
      // More than a line and a half down: a paragraph break.
      if (Math.abs(y - lastY) > Math.max(hh, lastH) * 1.9 && !s.endsWith('\n\n')) s += '\n';
    }
    s += it.str;
    if (it.hasEOL && !s.endsWith('\n')) s += '\n';
    if (it.str) { lastY = y; lastH = hh; }
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/** The search expression: literal text, any run of white space in the query matches any white space. */
export function searchRegex(q: string, opts: { caseSensitive?: boolean; wholeWord?: boolean } = {}): RegExp {
  const body = q.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  const flags = opts.caseSensitive ? 'gu' : 'giu';
  if (!opts.wholeWord) return new RegExp(body, flags);
  try { return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, flags); }
  catch { return new RegExp(`\\b${body}\\b`, flags); } // engines without lookbehind
}

export interface ItemMatch { item: number; rects: Rect4[] }

/**
 * Matches over the text of a whole page. Items are joined with a space where a line ends (or the next
 * item starts on another line), so a phrase is found across a line break and words on two lines are
 * never glued into one. Each match gets one rectangle per item it covers.
 */
export function searchItems(items: TextItemLike[], re: RegExp): ItemMatch[] {
  let text = '';
  const spans: { k: number; start: number; end: number }[] = [];
  let prev: TextItemLike | null = null;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (!it.str) { if (it.hasEOL && prev && !/\s$/.test(text)) text += ' '; continue; }
    if (prev && !/\s$/.test(text) && !/^\s/.test(it.str) && (prev.hasEOL || Math.abs(it.y - prev.y) > (it.h || prev.h || 10) * 0.6)) text += ' ';
    spans.push({ k, start: text.length, end: text.length + it.str.length });
    text += it.str;
    prev = it;
  }
  const out: ItemMatch[] = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  let si = 0;
  while ((m = rx.exec(text))) {
    if (!m[0].length) { rx.lastIndex++; continue; }
    const a = m.index, b = a + m[0].length;
    while (si < spans.length && spans[si].end <= a) si++;
    const rects: Rect4[] = [];
    let first = -1;
    for (let j = si; j < spans.length && spans[j].start < b; j++) {
      const sp = spans[j], it = items[sp.k], len = sp.end - sp.start;
      const f0 = (Math.max(a, sp.start) - sp.start) / len, f1 = (Math.min(b, sp.end) - sp.start) / len;
      if (f1 <= f0) continue;
      if (first < 0) first = sp.k;
      rects.push([it.x + it.w * f0, it.y - it.h * 0.2, it.x + it.w * f1, it.y + it.h * 0.85]);
    }
    if (rects.length) out.push({ item: first, rects });
  }
  return out;
}

/**
 * Wraps an async job so that calls made while it runs share ONE following run (which sees the latest
 * state) instead of each starting their own. Every caller's promise settles when the state it asked for
 * has been processed.
 */
export function coalesce(run: () => Promise<void>): () => Promise<void> {
  let active: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const call = (): Promise<void> => {
    if (!active) {
      const p: Promise<void> = run().finally(() => { if (active === p) active = null; });
      active = p;
      return p;
    }
    if (!queued) queued = active.catch(() => undefined).then(() => { queued = null; return call(); });
    return queued;
  };
  return call;
}

/** Runs queued jobs a few at a time (thumbnail rendering). */
export function jobQueue(limit: number): { add(job: () => Promise<void>): void; clear(): void } {
  let running = 0;
  let jobs: (() => Promise<void>)[] = [];
  const next = () => {
    while (running < limit && jobs.length) {
      const j = jobs.shift()!;
      running++;
      j().catch(() => undefined).finally(() => { running--; next(); });
    }
  };
  return { add(job) { jobs.push(job); next(); }, clear() { jobs = []; } };
}
