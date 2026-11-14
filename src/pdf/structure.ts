/**
 * Document structure readers and writers: outlines (bookmarks), named destinations, page labels,
 * embedded files (attachments), optional content (layers), metadata (Info and XMP), the AcroForm
 * field tree, annotations per page, and signature fields.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, dictOf, isName, latin1, parsePdfDate, pdfDate } from './objects';
import { flateStream } from './filters';
import type { PdfDocument, PageInfo } from './document';

// ------------------------------------------------------------------------------------------
// Destinations

export interface Dest { page: number; /** 'XYZ' | 'Fit' | 'FitH' … */ kind: string; x?: number; y?: number; zoom?: number }

function pageIndexOf(doc: PdfDocument, o: PdfObj): number {
  if (typeof o === 'number') return o;
  if (o instanceof Ref) { const i = doc.pages.findIndex((p) => p.ref?.num === o.num); return i; }
  return -1;
}

export function resolveDest(doc: PdfDocument, d: PdfObj): Dest | null {
  let v: PdfObj = doc.resolve(d);
  for (let i = 0; i < 8 && (v instanceof PdfString || isName(v)); i++) {
    const name = v instanceof PdfString ? v.toText() : (v as Name).name;
    v = lookupName(doc, 'Dests', name);
    if (v instanceof Dict && v.has('D')) v = doc.get(v, 'D');
  }
  if (v instanceof Dict && v.has('D')) v = doc.get(v, 'D');
  if (!Array.isArray(v) || !v.length) return null;
  const page = pageIndexOf(doc, doc.resolve(v[0]) instanceof Dict ? v[0] : doc.resolve(v[0]));
  const kind = isName(v[1]) ? v[1].name : 'Fit';
  const n = (i: number) => { const x = doc.resolve(v[i]); return typeof x === 'number' ? x : undefined; };
  const dest: Dest = { page: page < 0 ? 0 : page, kind };
  if (kind === 'XYZ') { dest.x = n(2); dest.y = n(3); dest.zoom = n(4); } else if (kind === 'FitH' || kind === 'FitBH') dest.y = n(2); else if (kind === 'FitV' || kind === 'FitBV') dest.x = n(2);
  return dest;
}

/** Looks a name up in a name tree of the catalog (Dests, EmbeddedFiles, JavaScript…), or the old /Dests dictionary. */
export function lookupName(doc: PdfDocument, tree: string, name: string): PdfObj {
  const names = doc.getDict(doc.catalog, 'Names');
  const root = names ? doc.getDict(names, tree) : null;
  if (root) {
    // The key as it may be stored: the text's own bytes, PDFDocEncoding/UTF-16 as fromText writes it, or UTF-16.
    const forms = [...new Set([name, PdfString.fromText(name).toLatin1(), PdfString.fromText(name, true).toLatin1()])];
    // First by the /Limits of each node (a tree of any size is then a short walk); a tree whose limits are
    // wrong is searched in full before the name is given up.
    const v = nameTreeLookup(doc, root, name, forms, 0) ?? nameTreeLookup(doc, root, name, null, 0);
    if (v !== undefined) return v;
  }
  if (tree === 'Dests') { const d = doc.getDict(doc.catalog, 'Dests'); if (d) return doc.get(d, name); }
  return null;
}

function nameTreeLookup(doc: PdfDocument, node: Dict, name: string, forms: string[] | null, depth: number): PdfObj | undefined {
  if (depth > 32) return undefined;
  const names = doc.getArray(node, 'Names');
  if (names) for (let i = 0; i + 1 < names.length; i += 2) { const k = doc.resolve(names[i]); if (k instanceof PdfString && (k.toText() === name || k.toLatin1() === name)) return names[i + 1]; }
  const kids = doc.getArray(node, 'Kids') || [];
  for (const k of kids) {
    const kd = doc.resolve<Dict | null>(k);
    if (!(kd instanceof Dict)) continue;
    if (forms) {
      const lim = doc.getArray(kd, 'Limits');
      const lo = lim ? doc.resolve(lim[0]) : null, hi = lim ? doc.resolve(lim[1]) : null;
      if (lo instanceof PdfString && hi instanceof PdfString) { const a = lo.toLatin1(), b = hi.toLatin1(); if (!forms.some((f) => f >= a && f <= b)) continue; }
    }
    const r = nameTreeLookup(doc, kd, name, forms, depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** Every (key, value) of a name tree, keys as the objects stored (so they can be written back unchanged). */
function nameTreePairs(doc: PdfDocument, root: Dict | null): [PdfObj, PdfObj][] {
  const out: [PdfObj, PdfObj][] = [];
  const seen = new Set<Dict>();
  const walk = (node: Dict, depth: number) => {
    if (depth > 32 || seen.has(node)) return;
    seen.add(node);
    const names = doc.getArray(node, 'Names');
    if (names) for (let i = 0; i + 1 < names.length; i += 2) out.push([names[i], names[i + 1]]);
    for (const k of doc.getArray(node, 'Kids') || []) { const kd = doc.resolve<Dict | null>(k); if (kd instanceof Dict) walk(kd, depth + 1); }
  };
  if (root) walk(root, 0);
  return out;
}

/** Every (name, value) of a name tree. */
export function nameTreeEntries(doc: PdfDocument, root: Dict | null): [string, PdfObj][] {
  return nameTreePairs(doc, root).map(([k, v]) => { const r = doc.resolve(k); return [r instanceof PdfString ? r.toText() : String(r), v]; });
}

/** Writes a name tree as one sorted /Names array. Existing keys keep their bytes; the order is by bytes, as readers search. */
function writeNameTree(doc: PdfDocument, tree: string, pairs: [PdfObj, PdfObj][]): void {
  const bytes = (k: PdfObj): string => { const r = doc.resolve(k); return r instanceof PdfString ? r.toLatin1() : ''; };
  const sorted = pairs.map(([k, v]) => ({ k, v, b: bytes(k) })).sort((x, y) => (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  const flat: PdfObj[] = [];
  for (const { k, v } of sorted) flat.push(k, v);
  const nd = new Dict({ Names: flat });
  const namesRef = doc.catalog.get('Names');
  let names = doc.getDict(doc.catalog, 'Names');
  if (!names) { names = new Dict(); doc.catalog.set('Names', names); }
  const cur = names.get(tree);
  if (cur instanceof Ref) doc.update(cur, nd);
  else {
    names.set(tree, doc.register(nd));
    // /Names may be its own object: the change is in that object, which then has to be written too.
    if (namesRef instanceof Ref) doc.touch(namesRef);
  }
  doc.update(doc.catalogRef, doc.catalog);
}
const nameKeyText = (doc: PdfDocument, k: PdfObj): string => { const r = doc.resolve(k); return r instanceof PdfString ? r.toText() : String(r); };

function setNameTreeEntry(doc: PdfDocument, tree: string, name: string, value: PdfObj): void {
  const names = doc.getDict(doc.catalog, 'Names');
  const pairs = nameTreePairs(doc, names ? doc.getDict(names, tree) : null).filter(([k]) => nameKeyText(doc, k) !== name);
  pairs.push([PdfString.fromText(name), value]);
  writeNameTree(doc, tree, pairs);
}
function deleteNameTreeEntry(doc: PdfDocument, tree: string, name: string): boolean {
  const names = doc.getDict(doc.catalog, 'Names');
  const root = names ? doc.getDict(names, tree) : null;
  if (!names || !root) return false;
  const pairs = nameTreePairs(doc, root);
  const keep = pairs.filter(([k]) => nameKeyText(doc, k) !== name);
  if (keep.length === pairs.length) return false;
  writeNameTree(doc, tree, keep);
  return true;
}

// ------------------------------------------------------------------------------------------
// Outlines (bookmarks)

export interface OutlineItem { title: string; dest: Dest | null; url?: string; children: OutlineItem[]; ref: Ref | null; open: boolean; color?: [number, number, number]; bold?: boolean; italic?: boolean }

export function readOutlines(doc: PdfDocument): OutlineItem[] {
  const root = doc.getDict(doc.catalog, 'Outlines');
  if (!root) return [];
  const seen = new Set<string>();
  const walk = (first: PdfObj | undefined, depth: number): OutlineItem[] => {
    const out: OutlineItem[] = [];
    let cur = first;
    for (let guard = 0; cur && guard < 5000 && depth < 32; guard++) {
      const ref = cur instanceof Ref ? cur : null;
      if (ref) { if (seen.has(ref.key)) break; seen.add(ref.key); }
      const d = doc.resolve<Dict | null>(cur);
      if (!(d instanceof Dict)) break;
      const item: OutlineItem = { title: doc.getText(d, 'Title'), dest: null, children: [], ref, open: doc.getNum(d, 'Count', 0) >= 0 };
      const a = doc.getDict(d, 'A');
      if (a && doc.getName(a, 'S') === 'URI') item.url = doc.getText(a, 'URI');
      else if (a && doc.getName(a, 'S') === 'GoTo') item.dest = resolveDest(doc, a.get('D') ?? null);
      else if (d.has('Dest')) item.dest = resolveDest(doc, d.get('Dest')!);
      const c = doc.getArray(d, 'C');
      if (c && c.length === 3) item.color = c.map((x) => doc.resolve<number>(x)) as [number, number, number];
      const f = doc.getNum(d, 'F', 0);
      if (f & 1) item.italic = true; if (f & 2) item.bold = true;
      item.children = walk(d.get('First'), depth + 1);
      out.push(item);
      cur = d.get('Next');
    }
    return out;
  };
  return walk(root.get('First'), 0);
}

export interface OutlineInput {
  title: string; page: number; y?: number; children?: OutlineInput[]; url?: string; open?: boolean;
  /**
   * The existing bookmark this one stands for (outlinesToInput sets it). Its action or destination is kept
   * exactly (fit mode, zoom, links to other files, scripts) unless `page`, `y` or `url` now say otherwise,
   * and so are its colour, style and any other entries.
   */
  source?: Ref | null;
  color?: [number, number, number]; bold?: boolean; italic?: boolean;
}

// The entries of an outline item that writeOutlines builds itself; everything else is carried over from `source`.
const OUTLINE_OWN = new Set(['Title', 'Parent', 'Prev', 'Next', 'First', 'Last', 'Count', 'Dest', 'A', 'C', 'F']);

/** Replaces the document's outline tree. */
export function writeOutlines(doc: PdfDocument, items: OutlineInput[]): void {
  const mode = doc.getName(doc.catalog, 'PageMode');
  if (!items.length) {
    doc.catalog.delete('Outlines');
    if (mode === 'UseOutlines') doc.catalog.delete('PageMode'); // nothing left for the bookmarks pane to show
    doc.update(doc.catalogRef, doc.catalog);
    return;
  }
  const rootRef = doc.register(new Dict({ Type: Name.get('Outlines') }));
  const root = doc.resolve<Dict>(rootRef);
  // `visible` is what /Count means: the items shown when this level is open (a closed item hides its own).
  const build = (list: OutlineInput[], parent: Ref): { first: Ref | null; last: Ref | null; visible: number } => {
    let first: Ref | null = null, prev: Ref | null = null, visible = 0;
    for (const it of list) {
      const d = new Dict({ Title: PdfString.fromText(it.title), Parent: parent });
      const ref = doc.register(d);
      const src = it.source ? dictOf(doc.resolve(it.source)) : null;
      if (src) for (const [k, v] of src.map) if (!OUTLINE_OWN.has(k)) d.set(k, v);
      const srcA = src ? doc.getDict(src, 'A') : null;
      const srcUrl = srcA && doc.getName(srcA, 'S') === 'URI' ? doc.getText(srcA, 'URI') : undefined;
      const srcDest = !src ? null : srcA && doc.getName(srcA, 'S') === 'GoTo' ? resolveDest(doc, srcA.get('D') ?? null) : src.has('Dest') ? resolveDest(doc, src.get('Dest')!) : null;
      const same = !!src && (it.url ? it.url === srcUrl : !srcUrl && (srcDest?.page ?? 0) === it.page && (it.y === undefined || it.y === srcDest?.y));
      const page = doc.pages[Math.max(0, Math.min(doc.pages.length - 1, it.page))];
      if (same) { if (src!.has('Dest')) d.set('Dest', src!.get('Dest')); if (src!.has('A')) d.set('A', src!.get('A')); }
      else if (it.url) d.set('A', new Dict({ S: Name.get('URI'), URI: PdfString.fromText(it.url) }));
      else if (page?.ref) d.set('Dest', [page.ref, Name.get('XYZ'), null, it.y ?? page.cropBox[3], null]);
      if (it.color) d.set('C', [...it.color]); else if (src?.has('C')) d.set('C', src.get('C'));
      if (it.bold !== undefined || it.italic !== undefined) { const f = (it.italic ? 1 : 0) | (it.bold ? 2 : 0); if (f) d.set('F', f); }
      else if (src?.has('F')) d.set('F', src.get('F'));
      visible++;
      if (it.children?.length) {
        const c = build(it.children, ref);
        d.set('First', c.first); d.set('Last', c.last);
        d.set('Count', it.open === false ? -c.visible : c.visible);
        if (it.open !== false) visible += c.visible;
      }
      if (prev) { doc.resolve<Dict>(prev).set('Next', ref); d.set('Prev', prev); }
      if (!first) first = ref;
      prev = ref;
    }
    return { first, last: prev, visible };
  };
  const b = build(items, rootRef);
  root.set('First', b.first); root.set('Last', b.last); root.set('Count', b.visible);
  doc.catalog.set('Outlines', rootRef);
  // Show the bookmarks pane on opening, unless the document already asks for another view (thumbnails, full screen…).
  if (!mode || mode === 'UseNone') doc.catalog.set('PageMode', Name.get('UseOutlines'));
  doc.update(doc.catalogRef, doc.catalog);
}

export function outlinesToInput(items: OutlineItem[]): OutlineInput[] {
  return items.map((i) => ({ title: i.title, page: i.dest?.page ?? 0, y: i.dest?.y, url: i.url, open: i.open, children: outlinesToInput(i.children), source: i.ref, color: i.color, bold: i.bold, italic: i.italic }));
}

// ------------------------------------------------------------------------------------------
// Page labels

export interface LabelRange { start: number; style?: 'D' | 'R' | 'r' | 'A' | 'a'; prefix?: string; first?: number }

export function readPageLabels(doc: PdfDocument): LabelRange[] {
  const pl = doc.getDict(doc.catalog, 'PageLabels');
  if (!pl) return [];
  const out: LabelRange[] = [];
  const walk = (node: Dict, depth: number) => {
    if (depth > 32) return;
    const nums = doc.getArray(node, 'Nums');
    if (nums) for (let i = 0; i + 1 < nums.length; i += 2) { const k = doc.resolve<number>(nums[i]); const v = doc.resolve<Dict | null>(nums[i + 1]); if (typeof k === 'number' && v instanceof Dict) out.push({ start: k, style: (doc.getName(v, 'S') || undefined) as any, prefix: doc.getText(v, 'P') || undefined, first: v.has('St') ? doc.getNum(v, 'St', 1) : undefined }); }
    for (const kid of doc.getArray(node, 'Kids') || []) { const kd = doc.resolve<Dict | null>(kid); if (kd instanceof Dict) walk(kd, depth + 1); }
  };
  walk(pl, 0);
  return out.sort((a, b) => a.start - b.start);
}

export function writePageLabels(doc: PdfDocument, ranges: LabelRange[]): void {
  if (!ranges.length) { doc.catalog.delete('PageLabels'); doc.update(doc.catalogRef, doc.catalog); return; }
  const nums: PdfObj[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const d = new Dict();
    if (r.style) d.set('S', Name.get(r.style));
    if (r.prefix) d.set('P', PdfString.fromText(r.prefix));
    if (r.first && r.first !== 1) d.set('St', r.first);
    nums.push(r.start, d);
  }
  doc.catalog.set('PageLabels', new Dict({ Nums: nums }));
  doc.update(doc.catalogRef, doc.catalog);
}

const roman = (n: number): string => { const t: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let s = ''; for (const [v, r] of t) while (n >= v) { s += r; n -= v; } return s; };
const alpha = (n: number): string => { let s = ''; n--; const l = String.fromCharCode(65 + (n % 26)); return s + l.repeat(Math.floor(n / 26) + 1); };

/** The label of each page (as readers show them), from the ranges. */
export function pageLabelList(ranges: LabelRange[], count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const r = [...ranges].reverse().find((x) => x.start <= i);
    if (!r) { out.push(String(i + 1)); continue; }
    const n = (r.first ?? 1) + (i - r.start);
    const num = r.style === 'R' ? roman(n) : r.style === 'r' ? roman(n).toLowerCase() : r.style === 'A' ? alpha(n) : r.style === 'a' ? alpha(n).toLowerCase() : r.style === 'D' ? String(n) : '';
    out.push((r.prefix || '') + num || String(i + 1));
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Embedded files (attachments) and portfolios

export interface Attachment { name: string; description: string; size: number; mime: string; modified: Date | null; fileSpec: Dict; stream: PdfStream | null; /** 'names' (document level) or page index for FileAttachment annotations. */ where: 'document' | number; annot?: Ref | null; key?: string }

export function readAttachments(doc: PdfDocument): Attachment[] {
  const out: Attachment[] = [];
  const fromSpec = (fs: Dict, where: 'document' | number, key?: string, annot?: Ref | null): Attachment | null => {
    const ef = doc.getDict(fs, 'EF');
    const s = ef ? (doc.get(ef, 'UF') ?? doc.get(ef, 'F')) : null;
    const stream = s instanceof PdfStream ? s : null;
    const params = stream ? doc.getDict(stream, 'Params') : null;
    const name = doc.getText(fs, 'UF') || doc.getText(fs, 'F') || key || 'attachment';
    return { name, description: doc.getText(fs, 'Desc'), size: params ? doc.getNum(params, 'Size', stream ? stream.raw.length : 0) : stream ? stream.raw.length : 0, mime: stream ? doc.getName(stream, 'Subtype').replace('#2F', '/') : '', modified: params ? parsePdfDate(doc.getText(params, 'ModDate')) : null, fileSpec: fs, stream, where, annot, key };
  };
  const names = doc.getDict(doc.catalog, 'Names');
  for (const [k, v] of nameTreeEntries(doc, names ? doc.getDict(names, 'EmbeddedFiles') : null)) {
    const fs = doc.resolve<Dict | null>(v);
    if (fs instanceof Dict) { const a = fromSpec(fs, 'document', k); if (a) out.push(a); }
  }
  doc.pages.forEach((p, i) => {
    for (const ar of doc.getArray(p.dict, 'Annots') || []) {
      const a = doc.resolve<Dict | null>(ar);
      if (a instanceof Dict && doc.getName(a, 'Subtype') === 'FileAttachment') { const fs = doc.getDict(a, 'FS'); if (fs) { const att = fromSpec(fs, i, undefined, ar instanceof Ref ? ar : null); if (att) out.push(att); } }
    }
  });
  return out;
}

export function addAttachment(doc: PdfDocument, name: string, data: Uint8Array, opts: { description?: string; mime?: string } = {}): void {
  // The MIME type is the name itself; the writer escapes the "/" as #2F (escaping it here made it "#232F").
  const stream = flateStream(data, { Type: Name.get('EmbeddedFile'), Subtype: Name.get(opts.mime || 'application/octet-stream'), Params: new Dict({ Size: data.length, ModDate: pdfDate() }) });
  const sref = doc.register(stream);
  const fs = new Dict({ Type: Name.get('Filespec'), F: PdfString.fromText(name), UF: PdfString.fromText(name, true), EF: new Dict({ F: sref, UF: sref }) });
  if (opts.description) fs.set('Desc', PdfString.fromText(opts.description));
  setNameTreeEntry(doc, 'EmbeddedFiles', name, doc.register(fs));
}

export function removeAttachment(doc: PdfDocument, a: Attachment): void {
  if (a.where === 'document' && a.key != null) deleteNameTreeEntry(doc, 'EmbeddedFiles', a.key);
  else if (typeof a.where === 'number' && a.annot) removeAnnotation(doc, doc.pages[a.where], a.annot);
}

export function isPortfolio(doc: PdfDocument): boolean { return !!doc.getDict(doc.catalog, 'Collection'); }

// ------------------------------------------------------------------------------------------
// Optional content (layers)

export interface Layer { name: string; ref: Ref; on: boolean }

export function readLayers(doc: PdfDocument): Layer[] {
  const oc = doc.getDict(doc.catalog, 'OCProperties');
  if (!oc) return [];
  const d = doc.getDict(oc, 'D');
  const nums = (key: string) => new Set((d ? doc.getArray(d, key) || [] : []).filter((x): x is Ref => x instanceof Ref).map((r) => r.num));
  // /BaseState /OFF turns every layer off unless /ON lists it; otherwise every layer is on unless /OFF lists it.
  const off = nums('OFF'), on = nums('ON'), baseOff = !!d && doc.getName(d, 'BaseState') === 'OFF';
  const out: Layer[] = [];
  for (const r of doc.getArray(oc, 'OCGs') || []) {
    if (!(r instanceof Ref)) continue;
    const g = doc.resolve<Dict | null>(r);
    if (g instanceof Dict) out.push({ name: doc.getText(g, 'Name') || `Layer ${r.num}`, ref: r, on: baseOff ? on.has(r.num) : !off.has(r.num) });
  }
  return out;
}

export function setLayerVisible(doc: PdfDocument, layer: Layer, on: boolean): void {
  const oc = doc.getDict(doc.catalog, 'OCProperties');
  if (!oc) return;
  let d = doc.getDict(oc, 'D');
  if (!d) { d = new Dict(); oc.set('D', d); }
  // The layer is taken out of both lists and put back in the one that says what is wanted: /OFF when
  // layers are on by default, /ON when the base state is /OFF. (Left in the other list it would be
  // switched back, since /ON and /OFF are applied after the base state.)
  const baseOff = doc.getName(d, 'BaseState') === 'OFF';
  const others = (key: string) => (doc.getArray(d!, key) || []).filter((x) => !(x instanceof Ref && x.num === layer.ref.num));
  const off = others('OFF'), onList = others('ON');
  if (!on && !baseOff) off.push(layer.ref);
  if (on && baseOff) onList.push(layer.ref);
  d.set('OFF', off);
  if (d.has('ON') || onList.length) d.set('ON', onList);
  // Mark whichever objects hold what was changed: /D and /OCProperties may each be their own object.
  const dRef = oc.get('D'), ocRef = doc.catalog.get('OCProperties');
  if (dRef instanceof Ref) doc.touch(dRef);
  if (ocRef instanceof Ref) doc.touch(ocRef); else doc.update(doc.catalogRef, doc.catalog);
}

// ------------------------------------------------------------------------------------------
// Metadata

export interface Metadata { title: string; author: string; subject: string; keywords: string; creator: string; producer: string; created: Date | null; modified: Date | null; custom: Record<string, string>; xmp: string; language: string; version: string; tagged: boolean }

export function readMetadata(doc: PdfDocument): Metadata {
  const info = doc.info;
  const custom: Record<string, string> = {};
  const std = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']);
  if (info) for (const k of info.keys()) if (!std.has(k)) custom[k] = doc.getText(info, k);
  const m = doc.get(doc.catalog, 'Metadata');
  let xmp = '';
  if (m instanceof PdfStream) { try { xmp = new TextDecoder().decode(doc.decoded(m)); } catch { xmp = ''; } }
  const x = (tag: string): string => { const r = new RegExp(`<${tag}[^>]*>(?:\\s*<rdf:(?:Alt|Seq|Bag)>\\s*<rdf:li[^>]*>)?([^<]*)`, 'i').exec(xmp); return r ? r[1].trim() : ''; };
  const mi = doc.getDict(doc.catalog, 'MarkInfo');
  // An XMP date that does not parse is no date (an Invalid Date object would throw later, in toISOString).
  const xmpDate = (s: string): Date | null => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; };
  return {
    title: doc.getText(info, 'Title') || x('dc:title'), author: doc.getText(info, 'Author') || x('dc:creator'), subject: doc.getText(info, 'Subject') || x('dc:description'),
    keywords: doc.getText(info, 'Keywords') || x('pdf:Keywords'), creator: doc.getText(info, 'Creator') || x('xmp:CreatorTool'), producer: doc.getText(info, 'Producer') || x('pdf:Producer'),
    created: parsePdfDate(doc.getText(info, 'CreationDate')) || xmpDate(x('xmp:CreateDate')), modified: parsePdfDate(doc.getText(info, 'ModDate')),
    custom, xmp, language: doc.getText(doc.catalog, 'Lang'), version: doc.report.header.replace('%PDF-', ''), tagged: !!mi && doc.get(mi, 'Marked') === true,
  };
}

const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function writeMetadata(doc: PdfDocument, m: Partial<Metadata>): void {
  const info = doc.ensureInfo();
  const set = (k: string, v: string | undefined) => { if (v === undefined) return; if (v) info.set(k, PdfString.fromText(v)); else info.delete(k); };
  set('Title', m.title); set('Author', m.author); set('Subject', m.subject); set('Keywords', m.keywords); set('Creator', m.creator); set('Producer', m.producer);
  if (m.custom) { for (const k of info.keys()) if (!['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped'].includes(k)) info.delete(k); for (const [k, v] of Object.entries(m.custom)) if (k && v) info.set(k, PdfString.fromText(v)); }
  if (m.language !== undefined) { if (m.language) doc.catalog.set('Lang', PdfString.fromText(m.language)); else doc.catalog.delete('Lang'); }
  const cur = readMetadata(doc);
  // A value given in `m` wins, also when it is empty: readMetadata falls back to the old XMP for a field the
  // Info dictionary no longer has, which would put a cleared title straight back.
  const val = (k: 'title' | 'author' | 'subject' | 'keywords' | 'producer' | 'creator'): string => xmlEsc(m[k] ?? cur[k]);
  // The properties this function keeps in step with the Info dictionary: [tag, content, whether to write it].
  // An empty value is left out, and a creation date is written only when one is known (never today's
  // date in its place; an existing date that could not be read stays as it is).
  const alt = (v: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${v}</rdf:li></rdf:Alt>`;
  const all: [string, string, boolean][] = [
    ['dc:title', alt(val('title')), !!val('title')],
    ['dc:creator', `<rdf:Seq><rdf:li>${val('author')}</rdf:li></rdf:Seq>`, !!val('author')],
    ['dc:description', alt(val('subject')), !!val('subject')],
    ['pdf:Keywords', val('keywords'), !!val('keywords')], ['pdf:Producer', val('producer'), !!val('producer')], ['xmp:CreatorTool', val('creator'), !!val('creator')],
    ...(cur.created ? [['xmp:CreateDate', cur.created.toISOString(), true] as [string, string, boolean]] : []),
    ['xmp:ModifyDate', new Date().toISOString(), true],
  ];
  const props = all.map(([t]) => [t] as [string]);
  const block = `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n${all.filter((p) => p[2]).map(([t, v]) => `<${t}>${v}</${t}>`).join('\n')}\n</rdf:Description>`;
  let xmp: string;
  if (/<rdf:RDF[\s>][\s\S]*<\/rdf:RDF>/.test(cur.xmp)) {
    // An existing packet is kept (PDF/A identification, rights, custom schemas…): only these properties are
    // taken out, as elements or as attributes, and the new values are added as one more description.
    let old = cur.xmp;
    for (const [t] of props) {
      old = old.replace(new RegExp(`<${t}(\\s[^>]*)?>[\\s\\S]*?</${t}>|<${t}(\\s[^>]*)?/>`, 'g'), '');
      old = old.replace(new RegExp(`(<rdf:Description\\b[^>]*?)\\s+${t}=("[^"]*"|'[^']*')`, 'g'), '$1');
    }
    // Descriptions left with nothing in them (ours from the last time, usually) go too.
    old = old.replace(/<rdf:Description\b([^>]*)>\s*<\/rdf:Description>/g, (m, attrs: string) => (attrs.replace(/\s+(rdf:about|xmlns:[\w.-]+)=("[^"]*"|'[^']*')/g, '').trim() ? m : ''));
    const at = old.lastIndexOf('</rdf:RDF>');
    xmp = old.slice(0, at) + block + '\n' + old.slice(at);
  } else {
    xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${block}
</rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  }
  const s = new PdfStream(new Dict({ Type: Name.get('Metadata'), Subtype: Name.get('XML') }), new TextEncoder().encode(xmp));
  s.dict.set('Length', s.raw.length);
  const old = doc.catalog.get('Metadata');
  if (old instanceof Ref) doc.update(old, s); else doc.catalog.set('Metadata', doc.register(s));
  doc.update(doc.catalogRef, doc.catalog);
}

// ------------------------------------------------------------------------------------------
// Annotations

export interface AnnotInfo { ref: Ref | null; dict: Dict; page: number; subtype: string; rect: [number, number, number, number]; contents: string; author: string; date: Date | null; name: string; color: [number, number, number] | null; hidden: boolean; irt: Ref | null; state?: string; opacity: number; fieldType?: string }

export function pageAnnotations(doc: PdfDocument, p: PageInfo): AnnotInfo[] {
  const out: AnnotInfo[] = [];
  for (const ar of doc.getArray(p.dict, 'Annots') || []) {
    const d = doc.resolve<Dict | null>(ar);
    if (!(d instanceof Dict)) continue;
    const rect = doc.rect(d.get('Rect')) || [0, 0, 0, 0];
    const c = doc.getArray(d, 'C');
    const color = c && c.length === 3 ? (c.map((x) => doc.resolve<number>(x)) as [number, number, number]) : c && c.length === 1 ? [doc.resolve<number>(c[0]), doc.resolve<number>(c[0]), doc.resolve<number>(c[0])] as [number, number, number] : null;
    const f = doc.getNum(d, 'F', 0);
    const irt = d.get('IRT');
    out.push({ ref: ar instanceof Ref ? ar : null, dict: d, page: p.index, subtype: doc.getName(d, 'Subtype'), rect, contents: doc.getText(d, 'Contents'), author: doc.getText(d, 'T'), date: parsePdfDate(doc.getText(d, 'M')) || parsePdfDate(doc.getText(d, 'CreationDate')), name: doc.getText(d, 'NM'), color, hidden: !!(f & 2), irt: irt instanceof Ref ? irt : null, state: doc.getText(d, 'State') || undefined, opacity: doc.getNum(d, 'CA', 1), fieldType: doc.getName(d, 'FT') || undefined });
  }
  return out;
}

export function allAnnotations(doc: PdfDocument): AnnotInfo[] { return doc.pages.flatMap((p) => pageAnnotations(doc, p)); }

export function addAnnotation(doc: PdfDocument, p: PageInfo, annot: Dict): Ref {
  annot.set('P', p.ref);
  const ref = doc.register(annot);
  const annots = (doc.getArray(p.dict, 'Annots') || []).slice();
  annots.push(ref);
  p.dict.set('Annots', annots);
  if (p.ref) doc.touch(p.ref);
  return ref;
}

export function removeAnnotation(doc: PdfDocument, p: PageInfo, ref: Ref): void {
  const annots = (doc.getArray(p.dict, 'Annots') || []).filter((a) => !(a instanceof Ref && a.num === ref.num));
  // Popups and replies of the annotation go too.
  const toRemove = new Set([ref.num]);
  // Repeated until nothing is added: a reply to a reply (and its popup) goes with the thread.
  for (let grew = true; grew;) {
    grew = false;
    for (const a of doc.getArray(p.dict, 'Annots') || []) {
      const d = doc.resolve<Dict | null>(a);
      if (!(d instanceof Dict) || !(a instanceof Ref) || toRemove.has(a.num)) continue;
      const parent = d.get('Parent'), irt = d.get('IRT');
      if ((parent instanceof Ref && toRemove.has(parent.num)) || (irt instanceof Ref && toRemove.has(irt.num))) { toRemove.add(a.num); grew = true; }
    }
  }
  p.dict.set('Annots', annots.filter((a) => !(a instanceof Ref && toRemove.has(a.num))));
  for (const n of toRemove) doc.remove(new Ref(n, doc.genOf(n)));
  if (p.ref) doc.touch(p.ref);
}

// ------------------------------------------------------------------------------------------
// Forms

export type FieldType = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature' | 'unknown';

export interface FieldInfo {
  ref: Ref; dict: Dict; name: string; type: FieldType; value: string | string[] | boolean; options: { value: string; label: string }[];
  flags: number; required: boolean; readOnly: boolean; multiline: boolean; password: boolean; maxLen: number;
  widgets: { ref: Ref; dict: Dict; page: number; rect: [number, number, number, number]; onState?: string }[];
  defaultAppearance: string; tooltip: string;
}

export function readFields(doc: PdfDocument): FieldInfo[] {
  const af = doc.getDict(doc.catalog, 'AcroForm');
  const out: FieldInfo[] = [];
  const pageOfAnnot = new Map<number, number>();
  doc.pages.forEach((p, i) => { for (const a of doc.getArray(p.dict, 'Annots') || []) if (a instanceof Ref) pageOfAnnot.set(a.num, i); });
  const seen = new Set<number>();
  const walk = (ref: PdfObj, inherited: Dict | null, prefix: string, depth: number) => {
    if (!(ref instanceof Ref) || seen.has(ref.num) || depth > 32) return;
    seen.add(ref.num);
    const d = doc.resolve<Dict | null>(ref);
    if (!(d instanceof Dict)) return;
    const inh = (k: string): PdfObj => (d.has(k) ? doc.get(d, k) : inherited ? doc.get(inherited, k) : null);
    const partial = doc.getText(d, 'T');
    const name = partial ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
    const kids = doc.getArray(d, 'Kids') || [];
    const ft = inh('FT');
    const ftName = isName(ft) ? ft.name : '';
    const isField = !!ftName && (!kids.length || kids.every((k) => { const kd = doc.resolve<Dict | null>(k); return kd instanceof Dict && !kd.has('T'); }));
    if (isField) {
      const flags = typeof inh('Ff') === 'number' ? (inh('Ff') as number) : 0;
      let type: FieldType = 'unknown';
      if (ftName === 'Tx') type = 'text'; else if (ftName === 'Btn') type = flags & (1 << 16) ? 'button' : flags & (1 << 15) ? 'radio' : 'checkbox'; else if (ftName === 'Ch') type = flags & (1 << 17) ? 'combo' : 'list'; else if (ftName === 'Sig') type = 'signature';
      const v = inh('V');
      let value: string | string[] | boolean = '';
      if (type === 'checkbox') value = isName(v) ? v.name !== 'Off' : false;
      else if (type === 'radio') value = isName(v) && v.name !== 'Off' ? v.name : '';
      else if (Array.isArray(v)) value = v.map((x) => { const r = doc.resolve(x); return r instanceof PdfString ? r.toText() : isName(r) ? r.name : ''; });
      else if (v instanceof PdfString) value = v.toText(); else if (isName(v)) value = v.name;
      const opts = (inh('Opt') as PdfObj[] | null) || [];
      const options = Array.isArray(opts) ? opts.map((o) => { const r = doc.resolve(o); if (Array.isArray(r)) { const a = doc.resolve(r[0]), b = doc.resolve(r[1]); return { value: a instanceof PdfString ? a.toText() : '', label: b instanceof PdfString ? b.toText() : '' }; } const t = r instanceof PdfString ? r.toText() : ''; return { value: t, label: t }; }) : [];
      const widgets: FieldInfo['widgets'] = [];
      const widgetDicts: [Ref, Dict][] = kids.length ? kids.filter((k): k is Ref => k instanceof Ref).map((k) => [k, doc.resolve<Dict>(k)] as [Ref, Dict]).filter(([, kd]) => kd instanceof Dict) : [[ref, d]];
      for (const [wr, wd] of widgetDicts) {
        const page = pageOfAnnot.get(wr.num);
        const ap = doc.getDict(wd, 'AP'); const n = ap ? doc.getDict(ap, 'N') : null;
        const onState = n ? n.keys().find((k) => k !== 'Off') : undefined;
        widgets.push({ ref: wr, dict: wd, page: page ?? -1, rect: doc.rect(wd.get('Rect')) || [0, 0, 0, 0], onState });
      }
      const da = inh('DA');
      out.push({ ref, dict: d, name, type, value, options, flags, required: !!(flags & 2), readOnly: !!(flags & 1), multiline: !!(flags & (1 << 12)), password: !!(flags & (1 << 13)), maxLen: typeof inh('MaxLen') === 'number' ? (inh('MaxLen') as number) : 0, widgets, defaultAppearance: da instanceof PdfString ? da.toLatin1() : af ? doc.getText(af, 'DA') : '', tooltip: doc.getText(d, 'TU') });
      return;
    }
    for (const k of kids) walk(k, d, name, depth + 1);
  };
  for (const f of af ? doc.getArray(af, 'Fields') || [] : []) walk(f, null, '', 0);
  // Widgets not in /Fields (orphans): list them from the pages so they can be filled anyway.
  doc.pages.forEach((p) => { for (const a of doc.getArray(p.dict, 'Annots') || []) { if (!(a instanceof Ref) || seen.has(a.num)) continue; const d = doc.resolve<Dict | null>(a); if (d instanceof Dict && doc.getName(d, 'Subtype') === 'Widget') { const parent = d.get('Parent'); walk(parent instanceof Ref ? parent : a, null, '', 0); } } });
  return out;
}

export function ensureAcroForm(doc: PdfDocument): Dict {
  let af = doc.getDict(doc.catalog, 'AcroForm');
  if (!af) {
    af = new Dict({ Fields: [], DA: PdfString.fromText('/Helv 0 Tf 0 g'), DR: new Dict({ Font: new Dict({ Helv: doc.register(new Dict({ Type: Name.get('Font'), Subtype: Name.get('Type1'), BaseFont: Name.get('Helvetica'), Encoding: Name.get('WinAnsiEncoding') })) }) }) });
    doc.catalog.set('AcroForm', doc.register(af));
    doc.update(doc.catalogRef, doc.catalog);
  }
  return af;
}
export function touchAcroForm(doc: PdfDocument): void { const r = doc.catalog.get('AcroForm'); if (r instanceof Ref) doc.touch(r); else doc.update(doc.catalogRef, doc.catalog); }

// ------------------------------------------------------------------------------------------
// Signatures

export interface SignatureInfo {
  field: string; signer: string; reason: string; location: string; date: Date | null; filter: string; subFilter: string; byteRange: number[]; coversWholeFile: boolean; signed: boolean; contactInfo: string;
  /** The signed bytes begin at the start of the file (ByteRange[0] is 0). */
  byteRangeStartsAtZero: boolean;
  /**
   * The one stretch of the file the ByteRange leaves out is exactly a hex string `<…>` (and, in a file
   * that is not encrypted, the one holding this signature's /Contents). False means bytes other than the
   * signature value are outside what was signed.
   */
  gapIsContents: boolean;
}

export function readSignatures(doc: PdfDocument): SignatureInfo[] {
  const out: SignatureInfo[] = [];
  for (const f of readFields(doc)) {
    if (f.type !== 'signature') continue;
    const v = doc.getDict(f.dict, 'V');
    if (!v) { out.push({ field: f.name, signer: '', reason: '', location: '', date: null, filter: '', subFilter: '', byteRange: [], coversWholeFile: false, signed: false, contactInfo: '', byteRangeStartsAtZero: false, gapIsContents: false }); continue; }
    const br = (doc.getArray(v, 'ByteRange') || []).map((x) => doc.resolve<number>(x)).filter((x) => typeof x === 'number');
    const total = br.length === 4 ? br[2] + br[3] : 0;
    out.push({ field: f.name, signer: doc.getText(v, 'Name'), reason: doc.getText(v, 'Reason'), location: doc.getText(v, 'Location'), date: parsePdfDate(doc.getText(v, 'M')), filter: doc.getName(v, 'Filter'), subFilter: doc.getName(v, 'SubFilter'), byteRange: br, coversWholeFile: total === doc.buf.length, signed: true, contactInfo: doc.getText(v, 'ContactInfo'), byteRangeStartsAtZero: br.length === 4 && br[0] === 0, gapIsContents: br.length === 4 && gapIsHexString(doc, br[0] + br[1], br[2], doc.security ? null : v.get('Contents')) });
  }
  return out;
}

/** Whether file bytes [from, to) are one hex string, and (when `contents` is a string) decode to its bytes. */
function gapIsHexString(doc: PdfDocument, from: number, to: number, contents: PdfObj | null | undefined): boolean {
  const b = doc.buf;
  if (!(from >= 0 && from + 2 <= to && to <= b.length) || b[from] !== 0x3c || b[to - 1] !== 0x3e) return false;
  const bytes: number[] = [];
  let hi = -1;
  for (let i = from + 1; i < to - 1; i++) {
    const c = b[i];
    const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
    if (v < 0) { if (c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0) continue; return false; }
    if (hi < 0) hi = v; else { bytes.push(hi * 16 + v); hi = -1; }
  }
  if (hi >= 0) bytes.push(hi * 16);
  const want = doc.resolve(contents ?? null);
  if (!(want instanceof PdfString)) return true;
  return want.bytes.length === bytes.length && want.bytes.every((x, i) => x === bytes[i]);
}

export { latin1 };
export const docTitle = (doc: PdfDocument): string => readMetadata(doc).title;
export const isDict = (o: unknown): o is Dict => o instanceof Dict;
export { dictOf };
