/**
 * Page operations: insert, delete, move, rotate, duplicate, crop, scale, extract, split, merge,
 * headers/footers, Bates numbering, watermarks, backgrounds, N-up and booklet imposition.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, cloneObj } from '../objects';
import { flateStream } from '../filters';
import { PdfDocument, PageInfo } from '../document';
import { remapRefs, fmtNum } from '../writer';
import { addBlankPage, ensureFont, ensureXObject, ensureExtGState, litText, PAPER } from '../build';
import { textWidth, type StdFont } from '../stdfonts';
import { bytesOf, concat } from '../objects';
import { detachWidget, isWidget, mapAnnotGeometry, ownResources } from './shared';

function kidsOf(doc: PdfDocument, node: Dict): PdfObj[] { return (doc.getArray(node, 'Kids') || []).slice(); }

/** Flattens the page tree: every page becomes a direct kid of the root (simplest correct structure for edits). */
export function flattenPageTree(doc: PdfDocument): void {
  const rootRef = doc.pagesRootRef;
  const root = doc.pagesRoot;
  if (!root || !rootRef) return;
  const pages = doc.pages;
  const kids = pages.map((p) => p.ref).filter((r): r is Ref => !!r);
  if (kids.length !== pages.length) return;
  for (const p of pages) {
    p.dict.set('Parent', rootRef);
    // Make inherited attributes explicit so flattening loses nothing.
    if (!p.dict.has('MediaBox')) p.dict.set('MediaBox', [...p.mediaBox]);
    if (!p.dict.has('CropBox') && p.cropBox.some((v, i) => v !== p.mediaBox[i])) p.dict.set('CropBox', [...p.cropBox]);
    if (!p.dict.has('Resources') && p.resources) p.dict.set('Resources', p.resources);
    if (!p.dict.has('Rotate') && p.rotate) p.dict.set('Rotate', p.rotate);
    if (p.ref) doc.touch(p.ref);
  }
  root.set('Kids', kids);
  root.set('Count', kids.length);
  for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) root.delete(k);
  doc.update(rootRef, root);
  doc.invalidatePages();
}

export function setPageOrder(doc: PdfDocument, order: number[]): void {
  flattenPageTree(doc);
  const root = doc.pagesRoot!, rootRef = doc.pagesRootRef!;
  const pages = doc.pages;
  const kids = order.map((i) => pages[i]?.ref).filter((r): r is Ref => !!r);
  root.set('Kids', kids); root.set('Count', kids.length);
  doc.update(rootRef, root);
  doc.invalidatePages();
}

export function deletePages(doc: PdfDocument, indexes: number[]): void {
  const del = new Set(indexes);
  const keep = doc.pages.map((_, i) => i).filter((i) => !del.has(i));
  if (!keep.length) throw new Error('A document must keep at least one page.');
  const removed = doc.pages.filter((_, i) => del.has(i));
  setPageOrder(doc, keep);
  const gone = new Set<number>();
  for (const p of removed) {
    // The page's form fields leave the AcroForm with it; otherwise their values stay in the file.
    for (const a of doc.getArray(p.dict, 'Annots') || []) if (a instanceof Ref && isWidget(doc, doc.resolve<PdfObj>(a))) { detachWidget(doc, a); doc.remove(a); }
    if (p.ref) { gone.add(p.ref.num); doc.remove(p.ref); }
  }
  dropDestinationsTo(doc, gone);
}

/** Removes explicit destinations (outline items, link annotations) that point at deleted page objects. */
function dropDestinationsTo(doc: PdfDocument, gone: Set<number>): void {
  if (!gone.size) return;
  const pointsAway = (d: PdfObj | undefined): boolean => { const a = doc.resolve<PdfObj>(d); return Array.isArray(a) && a[0] instanceof Ref && gone.has(a[0].num); };
  const strip = (d: Dict): boolean => {
    let ch = false;
    if (pointsAway(d.get('Dest'))) { d.delete('Dest'); ch = true; }
    const act = doc.getDict(d, 'A');
    if (act && doc.getName(act, 'S') === 'GoTo' && pointsAway(act.get('D'))) { d.delete('A'); ch = true; }
    return ch;
  };
  const seen = new Set<number>();
  const walk = (first: PdfObj | undefined, depth: number) => {
    let cur = first;
    for (let guard = 0; cur instanceof Ref && guard < 100000 && depth < 64; guard++) {
      if (seen.has(cur.num)) break;
      seen.add(cur.num);
      const d = doc.resolve<PdfObj>(cur);
      if (!(d instanceof Dict)) break;
      if (strip(d)) doc.touch(cur);
      walk(d.get('First'), depth + 1);
      cur = d.get('Next');
    }
  };
  const outlines = doc.getDict(doc.catalog, 'Outlines');
  if (outlines) walk(outlines.get('First'), 0);
  for (const p of doc.pages) for (const a of doc.getArray(p.dict, 'Annots') || []) { const d = doc.resolve<PdfObj>(a); if (d instanceof Dict && doc.getName(d, 'Subtype') === 'Link' && strip(d)) { if (a instanceof Ref) doc.touch(a); else if (p.ref) doc.touch(p.ref); } }
}

export function movePages(doc: PdfDocument, indexes: number[], to: number): void {
  const n = doc.pages.length;
  const moving = [...new Set(indexes)].sort((a, b) => a - b);
  const rest = [...Array(n).keys()].filter((i) => !moving.includes(i));
  const before = moving.filter((i) => i < to).length;
  const at = Math.max(0, Math.min(rest.length, to - before));
  rest.splice(at, 0, ...moving);
  setPageOrder(doc, rest);
}

export function rotatePages(doc: PdfDocument, indexes: number[], delta: number): void {
  const pages = doc.pages; // touch() drops the page cache: read the list once
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    p.dict.set('Rotate', ((p.rotate + delta) % 360 + 360) % 360);
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

export function duplicatePages(doc: PdfDocument, indexes: number[]): void {
  flattenPageTree(doc);
  const root = doc.pagesRoot!, rootRef = doc.pagesRootRef!;
  const kids = kidsOf(doc, root);
  const pages = doc.pages;
  let added = 0;
  for (const i of [...indexes].sort((a, b) => a - b)) {
    const p = pages[i];
    const copy = cloneObj(p.dict) as Dict;
    copy.delete('Annots'); // annotations belong to one page
    const ref = doc.register(copy);
    kids.splice(i + 1 + added, 0, ref);
    added++;
  }
  root.set('Kids', kids); root.set('Count', kids.length);
  doc.update(rootRef, root);
  doc.invalidatePages();
}

export function insertBlankPages(doc: PdfDocument, at: number, count: number, size: [number, number]): void {
  for (let i = 0; i < count; i++) addBlankPage(doc, size, at + i);
}

export function setPageBox(doc: PdfDocument, indexes: number[], box: 'MediaBox' | 'CropBox' | 'BleedBox' | 'TrimBox' | 'ArtBox', rect: [number, number, number, number] | null): void {
  const pages = doc.pages;
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    if (rect) p.dict.set(box, rect); else p.dict.delete(box);
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

/** Crops pages by margins (points) from each edge of the current crop box. */
export function cropPages(doc: PdfDocument, indexes: number[], m: { left: number; top: number; right: number; bottom: number }): void {
  const pages = doc.pages;
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    const [x0, y0, x1, y1] = p.cropBox;
    const r: [number, number, number, number] = [x0 + m.left, y0 + m.bottom, x1 - m.right, y1 - m.top];
    if (r[2] - r[0] < 10 || r[3] - r[1] < 10) continue;
    p.dict.set('CropBox', r);
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

/** Scales page content (and boxes) by a factor, or to fit a paper size. */
export function scalePages(doc: PdfDocument, indexes: number[], target: { factor?: number; paper?: [number, number] }): void {
  const pages = doc.pages;
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    // The visible page is the crop box; what it hides stays hidden (clipped) after scaling.
    const [x0, y0, x1, y1] = p.cropBox;
    const w = x1 - x0, h = y1 - y0;
    let s = target.factor ?? 1, nw = w * s, nh = h * s, dx = 0, dy = 0;
    if (target.paper) {
      // The paper size is what the reader sees, so a page turned by /Rotate gets the paper turned too.
      const [pw, ph] = p.rotate % 180 ? [target.paper[1], target.paper[0]] : target.paper;
      s = Math.min(pw / w, ph / h); nw = pw; nh = ph; dx = (nw - w * s) / 2; dy = (nh - h * s) / 2;
    }
    const content = doc.pageContent(p);
    const pre = bytesOf(`q ${fmtNum(s)} 0 0 ${fmtNum(s)} ${fmtNum(dx - x0 * s)} ${fmtNum(dy - y0 * s)} cm ${fmtNum(x0)} ${fmtNum(y0)} ${fmtNum(w)} ${fmtNum(h)} re W n\n`);
    doc.setPageContent(p, concat([pre, content, bytesOf('\nQ\n')]));
    p.dict.set('MediaBox', [0, 0, nw, nh]);
    for (const b of ['CropBox', 'BleedBox', 'TrimBox', 'ArtBox']) p.dict.delete(b);
    // Annotations move with the content.
    const map = (x: number, y: number): [number, number] => [(x - x0) * s + dx, (y - y0) * s + dy];
    for (const a of doc.getArray(p.dict, 'Annots') || []) {
      const d = doc.resolve<Dict | null>(a);
      const r = d instanceof Dict ? doc.rect(d.get('Rect')) : null;
      if (d && r) { d.set('Rect', [...map(r[0], r[1]), ...map(r[2], r[3])]); mapAnnotGeometry(doc, d, map); if (a instanceof Ref) doc.touch(a); }
    }
    if (p.ref) doc.touch(p.ref);
  }
  doc.invalidatePages();
}

// ------------------------------------------------------------------------------------------
// Copying pages between documents

const MEMBER_KEYS = new Set(['Kids', 'Annots', 'Fields', 'CO']);
const NO_SKIP = new Set<string>();

/**
 * Copies an object graph from `src` into `dst`, remapping references (streams keep their raw bytes).
 * Objects whose number is in `block` are never copied: references to them become null, dictionary
 * entries holding them are left out, member arrays (/Kids, /Annots, /Fields, /CO) lose them, and
 * destinations that point at them are dropped. `skipKeys` are left out of every dictionary.
 */
export function copyGraph(src: PdfDocument, dst: PdfDocument, obj: PdfObj, map = new Map<number, Ref>(), skipKeys = new Set<string>(), block?: Set<number>): PdfObj {
  // A work list instead of recursion per reference: long reference chains cannot overflow the stack.
  const queue: [Ref, Ref][] = [];
  const blocked = (o: PdfObj | undefined): boolean => !!block && o instanceof Ref && block.has(o.num) && !map.has(o.num);
  const deadDest = (v: PdfObj | undefined): boolean => { const a = src.resolve<PdfObj>(v); return Array.isArray(a) && blocked(a[0]); };
  const mapRef = (r: Ref): PdfObj => {
    const got = map.get(r.num);
    if (got) return got;
    if (blocked(r)) return null;
    const placeholder = dst.register(null);
    map.set(r.num, placeholder);
    queue.push([r, placeholder]);
    return placeholder;
  };
  const walk = (o: PdfObj): PdfObj => {
    if (o instanceof Ref) return mapRef(o);
    if (Array.isArray(o)) return o.map(walk);
    if (o instanceof Dict) {
      const d = new Dict();
      for (const [k, v] of o.map) {
        if (skipKeys.has(k) || blocked(v)) continue;
        if (block) {
          if ((k === 'Dest' || k === 'D') && deadDest(v)) continue;
          if (k === 'A') { const act = src.resolve<PdfObj>(v); if (act instanceof Dict && src.getName(act, 'S') === 'GoTo' && deadDest(act.get('D'))) continue; }
          if (MEMBER_KEYS.has(k)) { const arr = src.resolve<PdfObj>(v); if (Array.isArray(arr) && arr.some(blocked)) { d.map.set(k, arr.filter((x) => !blocked(x)).map(walk)); continue; } }
        }
        d.map.set(k, walk(v));
      }
      return d;
    }
    if (o instanceof PdfStream) {
      // Streams keep their raw bytes (already decrypted by the source document).
      const s = new PdfStream(walk(o.dict) as Dict, o.raw);
      s.decoded = o.decoded;
      return s;
    }
    if (o instanceof PdfString) return new PdfString(o.bytes.slice(), o.hex);
    return o;
  };
  const out = walk(obj);
  while (queue.length) { const [r, placeholder] = queue.pop()!; dst.update(placeholder, walk(src.fetch(r))); }
  return out;
}

const PAGE_SKIP = new Set(['Parent', 'StructParents', 'B', 'PieceInfo', 'Annots']);

/** Appends pages of `src` (by index) to `dst` at position `at` (default end). Returns the new PageInfos. */
export function importPages(src: PdfDocument, dst: PdfDocument, indexes: number[], at?: number, opts: { keepAnnots?: boolean } = {}): PageInfo[] {
  flattenPageTree(dst);
  const root = dst.pagesRoot!, rootRef = dst.pagesRootRef!;
  const kids = kidsOf(dst, root);
  const map = new Map<number, Ref>();
  const keepAnnots = opts.keepAnnots !== false;
  const srcPages = src.pages;
  const wanted = indexes.map((i) => srcPages[i]).filter(Boolean);
  // Only the chosen pages come along: other pages, the page tree and other pages' annotations are
  // blocked, so a link, a /P entry or a field's /Kids cannot drag their content into `dst`.
  const importing = new Set(wanted.map((p) => p.ref?.num));
  const block = new Set<number>();
  for (const p of srcPages) {
    const own = !!p.ref && importing.has(p.ref.num);
    if (p.ref && !own) block.add(p.ref.num);
    if (!own || !keepAnnots) for (const a of src.getArray(p.dict, 'Annots') || []) if (a instanceof Ref) block.add(a.num);
    let par = p.dict.get('Parent');
    for (let g = 0; par instanceof Ref && g < 64 && !block.has(par.num); g++) { block.add(par.num); const d = src.resolve<PdfObj>(par); par = d instanceof Dict ? d.get('Parent') : undefined; }
  }
  // New page objects exist before anything is copied, so references between imported pages are remapped.
  const newRefs = wanted.map((p) => { const ref = dst.register(null); if (p.ref && !map.has(p.ref.num)) map.set(p.ref.num, ref); return ref; });
  const copy = (o: PdfObj): PdfObj => copyGraph(src, dst, o, map, NO_SKIP, block);
  const topFields: number[] = [];
  wanted.forEach((p, k) => {
    const copied = new Dict();
    for (const [key, v] of p.dict.map) if (!PAGE_SKIP.has(key)) copied.set(key, copy(v));
    // Inherited attributes become explicit.
    if (!copied.has('MediaBox')) copied.set('MediaBox', [...p.mediaBox]);
    if (!copied.has('Resources') && p.resources) copied.set('Resources', copy(p.resources));
    if (!copied.has('Rotate') && p.rotate) copied.set('Rotate', p.rotate);
    if (!copied.has('CropBox') && p.cropBox.some((v, i) => v !== p.mediaBox[i])) copied.set('CropBox', [...p.cropBox]);
    copied.set('Parent', rootRef);
    // A page imported twice in one call carries its annotations once: an annotation belongs to one page.
    const first = !p.ref || map.get(p.ref.num) === newRefs[k];
    if (keepAnnots && first) {
      const annots: Ref[] = [];
      for (const a of src.getArray(p.dict, 'Annots') || []) {
        const ad = src.resolve<PdfObj>(a);
        if (!(ad instanceof Dict)) continue;
        if (a instanceof Ref) {
          const r = copy(a);
          if (!(r instanceof Ref)) continue;
          annots.push(r);
          if (isWidget(src, ad)) {
            let top = a;
            for (let g = 0; g < 32; g++) { const d = src.resolve<PdfObj>(top); const par = d instanceof Dict ? d.get('Parent') : undefined; if (par instanceof Ref && !block.has(par.num) && src.resolve<PdfObj>(par) instanceof Dict) top = par; else break; }
            if (!topFields.includes(top.num)) topFields.push(top.num);
          }
        } else { const c = copy(ad) as Dict; c.set('P', newRefs[k]); annots.push(dst.register(c)); }
      }
      if (annots.length) copied.set('Annots', annots);
    }
    dst.update(newRefs[k], copied);
  });
  const pos = at == null ? kids.length : Math.max(0, Math.min(kids.length, at));
  kids.splice(pos, 0, ...newRefs);
  root.set('Kids', kids); root.set('Count', kids.length);
  dst.update(rootRef, root);
  // Form fields of imported pages: the same copies that sit on the pages join the destination AcroForm.
  if (topFields.length) {
    const srcAf = src.getDict(src.catalog, 'AcroForm');
    let dstAf = dst.getDict(dst.catalog, 'AcroForm');
    if (!dstAf) { dstAf = new Dict({ Fields: [] }); dst.catalog.set('AcroForm', dst.register(dstAf)); dst.update(dst.catalogRef, dst.catalog); }
    const dstFields = (dst.getArray(dstAf, 'Fields') || []).slice();
    for (const n of topFields) { const r = map.get(n); if (r && !dstFields.some((f) => f instanceof Ref && f.num === r.num)) dstFields.push(r); }
    dstAf.set('Fields', dstFields);
    if (srcAf) {
      if (!dstAf.has('DA') && srcAf.has('DA')) dstAf.set('DA', copy(srcAf.get('DA')!));
      const srcDr = src.getDict(srcAf, 'DR');
      if (srcDr && !dstAf.has('DR')) dstAf.set('DR', copy(srcDr));
      else if (srcDr) {
        // Field /DA strings name fonts of the source /DR: bring over the ones the destination lacks.
        const srcFonts = src.getDict(srcDr, 'Font'), dr = dst.getDict(dstAf, 'DR')!;
        if (srcFonts) {
          const cur = dst.getDict(dr, 'Font');
          const fonts = cur ? cur.clone() : new Dict();
          for (const [name, v] of srcFonts.map) if (!fonts.has(name)) fonts.set(name, copy(v));
          const own = dr.clone(); own.set('Font', fonts); dstAf.set('DR', own);
        }
      }
      if (src.get(srcAf, 'NeedAppearances') === true) dstAf.set('NeedAppearances', true);
    }
    const afRef = dst.catalog.get('AcroForm');
    if (afRef instanceof Ref) dst.touch(afRef); else dst.update(dst.catalogRef, dst.catalog);
  }
  importLayers(src, dst, map);
  dst.invalidatePages();
  const pages = dst.pages;
  return newRefs.map((r) => pages.find((p) => p.ref?.num === r.num)!).filter(Boolean);
}

/** Layers (optional content groups) used by copied content keep their visibility: a layer hidden in `src` stays hidden. */
function importLayers(src: PdfDocument, dst: PdfDocument, map: Map<number, Ref>): void {
  const srcOc = src.getDict(src.catalog, 'OCProperties');
  if (!srcOc) return;
  const groups = (src.getArray(srcOc, 'OCGs') || []).filter((r): r is Ref => r instanceof Ref && map.has(r.num));
  if (!groups.length) return;
  const sd = src.getDict(srcOc, 'D');
  const nums = (key: string) => new Set((sd ? src.getArray(sd, key) || [] : []).filter((r): r is Ref => r instanceof Ref).map((r) => r.num));
  const off = nums('OFF'), on = nums('ON'), baseOff = !!sd && src.getName(sd, 'BaseState') === 'OFF';
  const cur = dst.getDict(dst.catalog, 'OCProperties');
  const oc = cur ? cur.clone() : new Dict();
  const curD = dst.getDict(oc, 'D');
  const d = curD ? curD.clone() : new Dict();
  const list = (holder: Dict, key: string) => (dst.getArray(holder, key) || []).slice();
  const ocgs = list(oc, 'OCGs'), dOff = list(d, 'OFF'), dOn = list(d, 'ON'), order = list(d, 'Order');
  const dstBaseOff = dst.getName(d, 'BaseState') === 'OFF';
  for (const g of groups) {
    const r = map.get(g.num)!;
    if (ocgs.some((x) => x instanceof Ref && x.num === r.num)) continue;
    ocgs.push(r); order.push(r);
    const hidden = baseOff ? !on.has(g.num) : off.has(g.num);
    if (hidden && !dstBaseOff) dOff.push(r);
    if (!hidden && dstBaseOff) dOn.push(r);
  }
  oc.set('OCGs', ocgs);
  if (dOff.length) d.set('OFF', dOff);
  if (dOn.length) d.set('ON', dOn);
  d.set('Order', order);
  oc.set('D', d);
  dst.catalog.set('OCProperties', oc);
  dst.update(dst.catalogRef, dst.catalog);
}

/** A new document holding the given pages of `src`. */
export function extractPages(src: PdfDocument, indexes: number[]): PdfDocument {
  const dst = PdfDocument.create();
  importPages(src, dst, indexes);
  const info = src.info;
  if (info) { const di = dst.ensureInfo(); for (const k of ['Title', 'Author', 'Subject', 'Keywords']) if (info.has(k)) di.set(k, info.get(k)!); }
  return dst;
}

/**
 * Page ranges like "1-3, 5, 8-" (1-based) → indexes, in the order written, without duplicates.
 * Parts are separated by commas or semicolons; spaces around the dash and en/em dashes are accepted;
 * "5-3" means 3-5; range ends beyond the document are clamped; a single page that does not exist is ignored.
 */
export function parseRanges(spec: string, count: number): number[] {
  const out = new Set<number>();
  if (count < 1) return [];
  for (const raw of String(spec).replace(/[–—]/g, '-').split(/[,;]/)) {
    const part = raw.trim();
    if (!part || part === '-') continue;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      let a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : count;
      if (a > b) [a, b] = [b, a];
      a = Math.max(1, Math.min(count, a)); b = Math.max(1, Math.min(count, b));
      for (let i = a; i <= b; i++) out.add(i - 1);
      continue;
    }
    if (/^\d+$/.test(part)) { const n = +part; if (n >= 1 && n <= count) out.add(n - 1); continue; }
    if (/^(odd|even)$/i.test(part)) { for (let i = 0; i < count; i++) if ((i % 2 === 0) === (part.toLowerCase() === 'odd')) out.add(i); }
  }
  return [...out];
}

export type SplitMode = { kind: 'every'; n: number } | { kind: 'ranges'; ranges: string } | { kind: 'bookmarks'; items: { title: string; page: number }[] } | { kind: 'size'; maxBytes: number };

/** The parts a split makes: a file-safe name and the page indexes of each. */
export function splitGroups(src: PdfDocument, mode: SplitMode): { name: string; pages: number[] }[] {
  const n = src.pageCount;
  const groups: { name: string; pages: number[] }[] = [];
  if (mode.kind === 'every') { const step = Math.max(1, Math.floor(mode.n) || 1); for (let i = 0; i < n; i += step) groups.push({ name: `pages ${i + 1}-${Math.min(n, i + step)}`, pages: [...Array(Math.min(step, n - i)).keys()].map((k) => i + k) }); }
  else if (mode.kind === 'ranges') { for (const r of mode.ranges.split(/[;|]/)) { const pages = parseRanges(r, n); if (pages.length) groups.push({ name: r.trim(), pages }); } }
  else if (mode.kind === 'bookmarks') {
    const items = [...mode.items].sort((a, b) => a.page - b.page);
    if (!items.length || items[0].page > 0) items.unshift({ title: 'Front matter', page: 0 });
    items.forEach((it, i) => { const end = i + 1 < items.length ? items[i + 1].page : n; const pages = [...Array(Math.max(0, end - it.page)).keys()].map((k) => it.page + k); if (pages.length) groups.push({ name: it.title, pages }); });
  } else {
    // By size: add pages until the estimated size exceeds the limit (estimated from the page's content + image bytes).
    let cur: number[] = [], size = 0;
    for (let i = 0; i < n; i++) {
      const est = estimatePageBytes(src, src.pages[i]);
      if (cur.length && size + est > mode.maxBytes) { groups.push({ name: `part ${groups.length + 1}`, pages: cur }); cur = []; size = 0; }
      cur.push(i); size += est;
    }
    if (cur.length) groups.push({ name: `part ${groups.length + 1}`, pages: cur });
  }
  return groups.map((g) => ({ name: g.name.replace(/[\\/:*?"<>|]/g, '_'), pages: g.pages }));
}

/**
 * The parts of a split, built one at a time as they are asked for: a caller that writes each part and lets
 * it go holds one part's document at a time, not all of them. `src` must not change while this runs.
 */
export function* splitParts(src: PdfDocument, mode: SplitMode, groups = splitGroups(src, mode)): Generator<{ name: string; doc: PdfDocument }> {
  for (const g of groups) yield { name: g.name, doc: extractPages(src, g.pages) };
}

/** Every part of a split at once (splitParts holds less in memory). */
export function splitDocument(src: PdfDocument, mode: SplitMode): { name: string; doc: PdfDocument }[] {
  return [...splitParts(src, mode)];
}

export function estimatePageBytes(doc: PdfDocument, p: PageInfo): number {
  let total = 0;
  const seen = new Set<number>();
  const walk = (o: PdfObj, depth: number) => {
    if (depth > 6) return;
    if (o instanceof Ref) { if (seen.has(o.num)) return; seen.add(o.num); walk(doc.fetch(o), depth + 1); }
    else if (o instanceof PdfStream) { total += o.raw.length; walk(o.dict, depth + 1); }
    else if (o instanceof Dict) { for (const [k, v] of o.map) if (k !== 'Parent') walk(v, depth + 1); }
    else if (Array.isArray(o)) for (const v of o) walk(v, depth + 1);
  };
  walk(p.dict, 0);
  return total + 200;
}

// ------------------------------------------------------------------------------------------
// Overlays: headers/footers, Bates, watermarks, backgrounds

export interface OverlayText { text: string; font?: StdFont; size?: number; color?: [number, number, number]; position: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'center'; margin?: number; opacity?: number; rotate?: number; underlay?: boolean }

/** Expands {page} {pages} {date} {bates:000001} {label} {title} in overlay text. */
export function expandTemplate(t: string, ctx: { page: number; pages: number; label?: string; title?: string; bates?: number }): string {
  return t.replace(/\{page\}/g, String(ctx.page)).replace(/\{pages\}/g, String(ctx.pages)).replace(/\{date\}/g, new Date().toLocaleDateString()).replace(/\{label\}/g, ctx.label ?? String(ctx.page)).replace(/\{title\}/g, ctx.title ?? '').replace(/\{bates(?::(\d+))?\}/g, (_m, pad) => String(ctx.bates ?? ctx.page).padStart(pad ? pad.length : 6, '0'));
}

export function addOverlayText(doc: PdfDocument, indexes: number[], spec: OverlayText, ctx: (i: number) => { label?: string; title?: string; bates?: number } = () => ({})): void {
  const font = spec.font || 'Helvetica', size = spec.size || 10, margin = spec.margin ?? 36;
  const rgb = spec.color || [0, 0, 0];
  const pages = doc.pages;
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    const text = expandTemplate(spec.text, { page: i + 1, pages: pages.length, ...ctx(i) });
    const w = textWidth(text, font, size);
    // Placed in the page as the reader sees it (after /Rotate), then mapped back to user space.
    const W = p.width, H = p.height;
    const sx = spec.position.endsWith('left') ? margin : spec.position.endsWith('right') ? W - margin - w : W / 2 - w / 2;
    const sy = spec.position.startsWith('top') ? H - margin : spec.position.startsWith('bottom') ? margin : H / 2;
    const [cx, cy] = displayToUser(p, sx + w / 2, sy);
    ownResources(doc, p);
    const fname = ensureFont(doc, p, font);
    let gs = '';
    if (spec.opacity != null && spec.opacity < 1) gs = `/${ensureExtGState(doc, p, new Dict({ Type: Name.get('ExtGState'), CA: spec.opacity, ca: spec.opacity }))} gs `;
    const deg = (((p.rotate + (spec.rotate || 0)) % 360) + 360) % 360;
    const rad = (deg * Math.PI) / 180, snap = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v), cos = snap(Math.cos(rad)), sin = snap(Math.sin(rad));
    const tx = cx - (w / 2) * cos, ty = cy - (w / 2) * sin;
    const mtx = deg ? `${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} ${fmtNum(tx)} ${fmtNum(ty)} Tm` : `${fmtNum(tx)} ${fmtNum(ty)} Td`;
    const ops = `q ${gs}BT /${fname} ${fmtNum(size)} Tf ${fmtNum(rgb[0])} ${fmtNum(rgb[1])} ${fmtNum(rgb[2])} rg ${mtx} ${litText(text)} Tj ET Q`;
    appendContent(doc, p, bytesOf(ops), !!spec.underlay);
  }
}

/** A point of the page as displayed (origin bottom-left of the rotated crop box) in the page's user space. */
export function displayToUser(p: PageInfo, x: number, y: number): [number, number] {
  const [x0, y0, x1, y1] = p.cropBox;
  return p.rotate === 90 ? [x1 - y, y0 + x] : p.rotate === 180 ? [x1 - x, y1 - y] : p.rotate === 270 ? [x0 + y, y1 - x] : [x0 + x, y0 + y];
}

/** Appends (or prepends) content to a page, isolating the existing content in q…Q so its state leaks nowhere. */
export function appendContent(doc: PdfDocument, p: PageInfo, data: Uint8Array, prepend = false): void {
  const cur = doc.get(p.dict, 'Contents');
  const list: PdfObj[] = Array.isArray(cur) ? cur.slice() : cur ? [p.dict.get('Contents')!] : [];
  // Wrap existing content in q/Q once (marked by a tiny stream).
  const wrapped = (p.dict as any).__qfWrapped;
  if (!wrapped && list.length) { list.unshift(doc.register(flateStream(bytesOf('q\n'), {}, false))); list.push(doc.register(flateStream(bytesOf('\nQ\n'), {}, false))); (p.dict as any).__qfWrapped = true; }
  const s = doc.register(flateStream(concat([bytesOf('\n'), data, bytesOf('\n')])));
  if (prepend) list.unshift(s); else list.push(s);
  p.dict.set('Contents', list);
  if (p.ref) doc.touch(p.ref);
}

export function addBates(doc: PdfDocument, indexes: number[], opts: { prefix?: string; suffix?: string; start: number; digits: number; position: OverlayText['position']; size?: number }): void {
  const digits = Math.max(1, opts.digits);
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const seq = new Map(sorted.map((i, k) => [i, k]));
  addOverlayText(doc, sorted, { text: `${opts.prefix || ''}{bates:${'0'.repeat(digits)}}${opts.suffix || ''}`, position: opts.position, size: opts.size || 10, font: 'Helvetica' }, (i) => ({ bates: opts.start + (seq.get(i) || 0) }));
}

export function addWatermark(doc: PdfDocument, indexes: number[], text: string, opts: { size?: number; opacity?: number; color?: [number, number, number]; rotate?: number; underlay?: boolean } = {}): void {
  addOverlayText(doc, indexes, { text, position: 'center', size: opts.size || 60, opacity: opts.opacity ?? 0.25, color: opts.color || [0.6, 0.6, 0.6], rotate: opts.rotate ?? 45, font: 'Helvetica-Bold', underlay: opts.underlay });
}

export function addImageOverlay(doc: PdfDocument, indexes: number[], image: Ref, box: { x: number; y: number; w: number; h: number }, opts: { opacity?: number; underlay?: boolean } = {}): void {
  const pages = doc.pages;
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    ownResources(doc, p);
    const name = ensureXObject(doc, p, 'QFIm', image);
    let gs = '';
    if (opts.opacity != null && opts.opacity < 1) gs = `/${ensureExtGState(doc, p, new Dict({ Type: Name.get('ExtGState'), CA: opts.opacity, ca: opts.opacity }))} gs `;
    appendContent(doc, p, bytesOf(`q ${gs}${fmtNum(box.w)} 0 0 ${fmtNum(box.h)} ${fmtNum(box.x)} ${fmtNum(box.y)} cm /${name} Do Q`), !!opts.underlay);
  }
}

export function setBackgroundColor(doc: PdfDocument, indexes: number[], rgb: [number, number, number]): void {
  const pages = doc.pages;
  for (const i of indexes) {
    const p = pages[i];
    if (!p) continue;
    const [x0, y0, x1, y1] = p.mediaBox;
    appendContent(doc, p, bytesOf(`q ${fmtNum(rgb[0])} ${fmtNum(rgb[1])} ${fmtNum(rgb[2])} rg ${fmtNum(x0)} ${fmtNum(y0)} ${fmtNum(x1 - x0)} ${fmtNum(y1 - y0)} re f Q`), true);
  }
}

// ------------------------------------------------------------------------------------------
// Imposition: pages as form XObjects on new sheets

/**
 * A page as a Form XObject stream (content + resources + bbox), not yet part of any document. Its
 * Matrix turns the page by /Rotate and moves the crop box to the origin, so `Do` draws the page as
 * displayed in [0, p.width] × [0, p.height].
 */
function pageFormStream(doc: PdfDocument, p: PageInfo): PdfStream {
  const content = doc.pageContent(p);
  const [x0, y0, x1, y1] = p.cropBox;
  const rot = p.rotate;
  const matrix = rot === 90 ? [0, -1, 1, 0, -y0, x1] : rot === 180 ? [-1, 0, 0, -1, x1, y1] : rot === 270 ? [0, 1, -1, 0, y1, -x0] : [1, 0, 0, 1, -x0, -y0];
  return flateStream(content, { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [x0, y0, x1, y1], Matrix: matrix, Resources: p.resources ? cloneObj(p.resources) : new Dict() });
}

/** Turns a page into a Form XObject of its own document (see pageFormStream for the coordinate convention). */
export function pageAsForm(doc: PdfDocument, p: PageInfo): Ref { return doc.register(pageFormStream(doc, p)); }

export function nUp(src: PdfDocument, opts: { cols: number; rows: number; paper: [number, number]; margin?: number; gap?: number; pages?: number[]; order?: 'across' | 'down' }): PdfDocument {
  const dst = PdfDocument.create();
  const map = new Map<number, Ref>();
  const indexes = opts.pages || src.pages.map((_, i) => i);
  const cols = Math.max(1, Math.floor(opts.cols) || 1), rows = Math.max(1, Math.floor(opts.rows) || 1);
  const per = cols * rows;
  const margin = opts.margin ?? 18, gap = opts.gap ?? 12;
  const cellW = (opts.paper[0] - margin * 2 - gap * (cols - 1)) / cols, cellH = (opts.paper[1] - margin * 2 - gap * (rows - 1)) / rows;
  if (!(cellW > 0 && cellH > 0)) throw new Error('The margins and gaps leave no room for the pages on this paper.');
  const srcPages = src.pages;
  for (let s = 0; s < indexes.length; s += per) {
    const sheet = addBlankPage(dst, opts.paper);
    const ops: string[] = [];
    for (let k = 0; k < per && s + k < indexes.length; k++) {
      const p = srcPages[indexes[s + k]];
      if (!p) continue;
      // The form is built straight into the new document: the source is not modified.
      const form = copyGraph(src, dst, pageFormStream(src, p), map) as PdfStream;
      const fref = dst.register(form);
      const name = ensureXObject(dst, sheet, 'Pg', fref);
      const col = opts.order === 'down' ? Math.floor(k / rows) : k % cols, row = opts.order === 'down' ? k % rows : Math.floor(k / cols);
      const pw = p.width, ph = p.height;
      const sc = Math.min(cellW / pw, cellH / ph);
      const x = margin + col * (cellW + gap) + (cellW - pw * sc) / 2, y = opts.paper[1] - margin - (row + 1) * cellH - row * gap + (cellH - ph * sc) / 2;
      ops.push(`q ${fmtNum(sc)} 0 0 ${fmtNum(sc)} ${fmtNum(x)} ${fmtNum(y)} cm /${name} Do Q`);
    }
    dst.setPageContent(sheet, bytesOf(ops.join('\n')));
  }
  return dst;
}

/** Booklet order (saddle stitch): sheets with 2 pages per side, printed duplex. */
export function booklet(src: PdfDocument, paper: [number, number] = [PAPER.letter[1], PAPER.letter[0]]): PdfDocument {
  const n = src.pageCount;
  const total = Math.ceil(n / 4) * 4;
  const order: (number | null)[] = [];
  for (let i = 0; i < total / 2; i++) {
    const a = total - 1 - i, b = i;
    if (i % 2 === 0) order.push(a < n ? a : null, b < n ? b : null); else order.push(b < n ? b : null, a < n ? a : null);
  }
  const dst = PdfDocument.create();
  const map = new Map<number, Ref>();
  const srcPages = src.pages;
  for (let s = 0; s < order.length; s += 2) {
    const sheet = addBlankPage(dst, paper);
    const ops: string[] = [];
    [order[s], order[s + 1]].forEach((pi, k) => {
      if (pi == null) return;
      const p = srcPages[pi];
      const form = copyGraph(src, dst, pageFormStream(src, p), map) as PdfStream;
      const name = ensureXObject(dst, sheet, 'Pg', dst.register(form));
      const cellW = paper[0] / 2, cellH = paper[1];
      const sc = Math.min((cellW - 24) / p.width, (cellH - 24) / p.height);
      const x = k * cellW + (cellW - p.width * sc) / 2, y = (cellH - p.height * sc) / 2;
      ops.push(`q ${fmtNum(sc)} 0 0 ${fmtNum(sc)} ${fmtNum(x)} ${fmtNum(y)} cm /${name} Do Q`);
    });
    dst.setPageContent(sheet, bytesOf(ops.join('\n')));
  }
  return dst;
}

/** Reverses page order. */
export function reversePages(doc: PdfDocument): void { setPageOrder(doc, doc.pages.map((_, i) => i).reverse()); }

export { remapRefs, PAPER };
