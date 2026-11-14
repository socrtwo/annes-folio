/**
 * Inspecting and sanitizing: image and font lists, document statistics, a hidden-information report,
 * removal of metadata / attachments / scripts and actions / links / comments / hidden layers, and
 * preflight-style checks (archival, accessibility) reported honestly as checks rather than
 * conformance. Unused-object removal and stream recompression are the writer's full rewrite
 * (src/pdf/writer.ts); image downsampling is in src/commands/tools.ts.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, bytesOf, isName, latin1, nameObj, nameText } from '../objects';
import { PdfDocument } from '../document';
import { readAttachments, readLayers, readMetadata, pageAnnotations, readFields, readOutlines, removeAnnotation } from '../structure';
import { IMAGE_FILTERS, flateStream } from '../filters';
import { removeHiddenContent, membershipHidden, pruneUndrawn } from './redact';

export interface ImageInfo { ref: Ref | null; page: number; name: string; width: number; height: number; bpc: number; colorSpace: string; filter: string; bytes: number; /** The image has a mask or is itself a stencil mask: it cannot be re-encoded as an opaque picture. */ hasMask: boolean; /** A 1-bit stencil painted in the current fill colour (/ImageMask true). */ imageMask: boolean; stream: PdfStream }

export function listImages(doc: PdfDocument): ImageInfo[] {
  const out: ImageInfo[] = [];
  const seen = new Set<number>();
  const walk = (res: Dict | null, page: number, depth: number) => {
    if (!res || depth > 6) return;
    const xo = doc.getDict(res, 'XObject');
    if (!xo) return;
    for (const k of xo.keys()) {
      const ref = xo.get(k);
      const s = doc.resolve<PdfStream | null>(ref);
      if (!(s instanceof PdfStream)) continue;
      const sub = doc.getName(s, 'Subtype');
      if (sub === 'Form') { if (ref instanceof Ref) { if (seen.has(ref.num)) continue; seen.add(ref.num); } walk(doc.getDict(s, 'Resources'), page, depth + 1); continue; }
      if (sub !== 'Image') continue;
      if (ref instanceof Ref) { if (seen.has(ref.num)) continue; seen.add(ref.num); }
      const f = s.dict.get('Filter');
      const cs = doc.get(s, 'ColorSpace');
      const imageMask = doc.get(s, 'ImageMask') === true;
      out.push({ ref: ref instanceof Ref ? ref : null, page, name: k, width: doc.getNum(s, 'Width'), height: doc.getNum(s, 'Height'), bpc: imageMask ? 1 : doc.getNum(s, 'BitsPerComponent', 8), colorSpace: isName(cs) ? cs.name : Array.isArray(cs) && isName(cs[0]) ? cs[0].name : cs ? 'other' : '', filter: isName(f) ? f.name : Array.isArray(f) ? f.filter(nameObj).map((n) => (n as Name).name).join('+') : '', bytes: s.raw.length, hasMask: imageMask || s.dict.has('SMask') || s.dict.has('Mask'), imageMask, stream: s });
    }
  };
  doc.pages.forEach((p, i) => walk(p.resources, i, 0));
  return out;
}

export interface FontUse { name: string; subtype: string; embedded: boolean; encoding: string; pages: number[]; ref: Ref | null; type3: boolean }

export function listFonts(doc: PdfDocument): FontUse[] {
  const map = new Map<string, FontUse>();
  // Each resources dictionary is walked once per page: forms that share (or point back at) a
  // resources dictionary would otherwise multiply the work at every level.
  let seen = new Set<Dict>(), seenPage = -1;
  const walk = (res: Dict | null, page: number, depth: number) => {
    if (!res || depth > 6) return;
    if (page !== seenPage) { seen = new Set(); seenPage = page; }
    if (seen.has(res)) return;
    seen.add(res);
    const fonts = doc.getDict(res, 'Font');
    if (fonts) for (const k of fonts.keys()) {
      const ref = fonts.get(k);
      const f = doc.resolve<Dict | null>(ref);
      if (!(f instanceof Dict)) continue;
      const base = doc.getName(f, 'BaseFont') || k;
      const key = ref instanceof Ref ? `R${ref.num}` : base;
      let fd = doc.getDict(f, 'FontDescriptor');
      const desc = doc.getArray(f, 'DescendantFonts');
      if (!fd && desc && desc.length) { const d0 = doc.resolve<Dict | null>(desc[0]); if (d0 instanceof Dict) fd = doc.getDict(d0, 'FontDescriptor'); }
      const sub = doc.getName(f, 'Subtype');
      const enc = doc.get(f, 'Encoding');
      const cur = map.get(key);
      if (cur) { if (!cur.pages.includes(page)) cur.pages.push(page); continue; }
      map.set(key, { name: nameText(base), subtype: sub, embedded: !!fd && (fd.has('FontFile') || fd.has('FontFile2') || fd.has('FontFile3')), encoding: isName(enc) ? nameText(enc.name) : enc instanceof Dict ? 'Custom' : enc instanceof PdfStream ? 'CMap' : '', pages: [page], ref: ref instanceof Ref ? ref : null, type3: sub === 'Type3' });
    }
    const xo = doc.getDict(res, 'XObject');
    if (xo) for (const k of xo.keys()) { const s = doc.resolve<PdfStream | null>(xo.get(k)); if (s instanceof PdfStream && doc.getName(s, 'Subtype') === 'Form') walk(doc.getDict(s, 'Resources'), page, depth + 1); }
  };
  doc.pages.forEach((p, i) => walk(p.resources, i, 0));
  for (const p of doc.pages) for (const a of doc.getArray(p.dict, 'Annots') || []) { const d = doc.resolve<Dict | null>(a); const ap = d instanceof Dict ? doc.getDict(d, 'AP') : null; const n = ap ? doc.get(ap, 'N') : null; if (n instanceof PdfStream) walk(doc.getDict(n, 'Resources'), p.index, 1); }
  return [...map.values()];
}

export interface DocStats { pages: number; words: number; characters: number; images: number; fonts: number; annotations: number; fields: number; attachments: number; bookmarks: number; bytes: number; objects: number; version: string; encrypted: boolean; tagged: boolean; linearized: boolean; incrementalUpdates: number; javascript: number; links: number }

export function stats(doc: PdfDocument, text?: string): DocStats {
  const m = readMetadata(doc);
  const words = text ? (text.match(/\S+/g) || []).length : 0;
  const annots = doc.pages.flatMap((p) => pageAnnotations(doc, p));
  const countBm = (items: ReturnType<typeof readOutlines>): number => items.reduce((n, i) => n + 1 + countBm(i.children), 0);
  return { pages: doc.pageCount, words, characters: text ? text.length : 0, images: listImages(doc).length, fonts: listFonts(doc).length, annotations: annots.filter((a) => a.subtype !== 'Widget' && a.subtype !== 'Popup' && a.subtype !== 'Link').length, fields: readFields(doc).length, attachments: readAttachments(doc).length, bookmarks: countBm(readOutlines(doc)), bytes: doc.buf.length, objects: doc.objectNumbers().length, version: m.version, encrypted: !!doc.security, tagged: m.tagged, linearized: isLinearized(doc.buf), incrementalUpdates: earlierVersions(doc.buf), javascript: countJavaScript(doc), links: annots.filter((a) => a.subtype === 'Link').length };
}

const isLinearized = (buf: Uint8Array): boolean => /\/Linearized/.test(new TextDecoder('latin1').decode(buf.subarray(0, 1024)));

/**
 * How many earlier versions the file holds: end-of-file markers that close a cross-reference section
 * ("startxref … %%EOF"), minus the current one, minus the extra one every linearized file has.
 * Scans bytes; the file is not turned into a string.
 */
export function earlierVersions(buf: Uint8Array): number {
  const eof = [0x25, 0x25, 0x45, 0x4f, 0x46], sx = [0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66];
  const at = (i: number, pat: number[]) => { for (let k = 0; k < pat.length; k++) if (buf[i + k] !== pat[k]) return false; return true; };
  const space = (c: number) => c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09;
  let n = 0;
  for (let i = buf.indexOf(0x25); i >= 0 && i + 5 <= buf.length; i = buf.indexOf(0x25, i + 1)) {
    if (!at(i, eof)) continue;
    // Exactly "startxref <offset> %%EOF": the same bytes inside stream data do not count.
    let j = i - 1, digits = 0;
    while (j >= 0 && space(buf[j])) j--;
    while (j >= 0 && buf[j] >= 0x30 && buf[j] <= 0x39) { j--; digits++; }
    while (j >= 0 && space(buf[j])) j--;
    if (digits && j >= 8 && at(j - 8, sx)) n++;
  }
  return Math.max(0, n - 1 - (isLinearized(buf) ? 1 : 0));
}

/** Actions that do something beyond moving the view or following a link; "scripts and actions" removal takes them out. */
const ACTIVE_ACTIONS = new Set(['JavaScript', 'Launch', 'SubmitForm', 'ImportData', 'Rendition', 'Movie', 'Sound', 'Hide', 'SetOCGState', 'Trans', 'GoTo3DView']);

/**
 * An action with every active action taken out of it and of its /Next chain. Returns the value
 * unchanged when it holds none, a cleaned copy when it does, or null when nothing harmless is left.
 */
function cleanAction(doc: PdfDocument, v: PdfObj | undefined, depth = 0): { value: PdfObj | undefined; removed: number } {
  const a = doc.resolve<PdfObj>(v);
  if (!(a instanceof Dict) || depth > 64) return { value: v, removed: 0 };
  let removed = 0;
  // /Next: one action or an array of them.
  const next = a.get('Next'), nextVal = doc.resolve<PdfObj>(next);
  let newNext: PdfObj | undefined = next;
  if (Array.isArray(nextVal)) {
    const kept: PdfObj[] = [];
    for (const x of nextVal) { const r = cleanAction(doc, x, depth + 1); removed += r.removed; if (r.value != null) kept.push(r.value); }
    if (removed) newNext = kept.length ? kept : undefined;
  } else if (nextVal instanceof Dict) { const r = cleanAction(doc, next, depth + 1); removed += r.removed; if (r.removed) newNext = r.value ?? undefined; }
  if (ACTIVE_ACTIONS.has(doc.getName(a, 'S'))) {
    // This action goes; what is left of its chain takes its place.
    const rest = doc.resolve<PdfObj>(newNext);
    return { value: Array.isArray(rest) ? (rest.length ? rest[0] : null) : newNext ?? null, removed: removed + 1 };
  }
  if (!removed) return { value: v, removed: 0 };
  const c = a.clone();
  if (newNext === undefined) c.delete('Next'); else c.set('Next', newNext);
  return { value: c, removed };
}

/** Every dictionary of the outline tree and of the form field tree (fields, non-terminal nodes and widgets), with its reference. */
function actionHolders(doc: PdfDocument): [Ref, Dict][] {
  const out: [Ref, Dict][] = [];
  const seen = new Set<number>();
  const visit = (r: PdfObj | undefined, kidsKey: 'Kids' | null, depth: number) => {
    let cur = r;
    for (let guard = 0; cur instanceof Ref && guard < 200000 && depth < 64; guard++) {
      if (seen.has(cur.num)) return;
      seen.add(cur.num);
      const d = doc.resolve<PdfObj>(cur);
      if (!(d instanceof Dict)) return;
      out.push([cur, d]);
      if (kidsKey) { for (const k of doc.getArray(d, kidsKey) || []) visit(k, kidsKey, depth + 1); return; }
      visit(d.get('First'), null, depth + 1);
      cur = d.get('Next');
    }
  };
  const outlines = doc.getDict(doc.catalog, 'Outlines');
  if (outlines) visit(outlines.get('First'), null, 0);
  const af = doc.getDict(doc.catalog, 'AcroForm');
  for (const f of af ? doc.getArray(af, 'Fields') || [] : []) visit(f, 'Kids', 0);
  return out;
}

/** Scripts and active actions in the document: document-level scripts, open and event actions, and actions on annotations, fields and bookmarks. */
function countJavaScript(doc: PdfDocument): number {
  let n = 0;
  const names = doc.getDict(doc.catalog, 'Names');
  if (names && doc.getDict(names, 'JavaScript')) n++;
  n += cleanAction(doc, doc.catalog.get('OpenAction')).removed;
  const aa = doc.getDict(doc.catalog, 'AA'); if (aa) n += aa.size;
  const holder = (d: Dict) => { n += cleanAction(doc, d.get('A')).removed; if (d.has('AA')) n++; };
  const counted = new Set<Dict>();
  for (const p of doc.pages) { if (p.dict.has('AA')) n++; for (const a of pageAnnotations(doc, p)) { counted.add(a.dict); holder(a.dict); } }
  for (const [, d] of actionHolders(doc)) if (!counted.has(d)) holder(d);
  return n;
}

// ------------------------------------------------------------------------------------------
// XFA scripts

/** The packets of the XFA form (/AcroForm /XFA): one stream holding the whole XDP document (name ''), or [name stream …] pairs. */
function xfaPackets(doc: PdfDocument): { name: string; ref: Ref | null; stream: PdfStream }[] {
  const af = doc.getDict(doc.catalog, 'AcroForm');
  const x = af ? af.get('XFA') : undefined;
  const v = doc.resolve<PdfObj>(x);
  if (v instanceof PdfStream) return [{ name: '', ref: x instanceof Ref ? x : null, stream: v }];
  if (!Array.isArray(v)) return [];
  const out: { name: string; ref: Ref | null; stream: PdfStream }[] = [];
  for (let i = 0; i + 1 < v.length; i += 2) {
    const n = doc.resolve<PdfObj>(v[i]), s = doc.resolve<PdfObj>(v[i + 1]);
    if (s instanceof PdfStream) out.push({ name: n instanceof PdfString ? n.toText() : isName(n) ? n.name : '', ref: v[i + 1] instanceof Ref ? (v[i + 1] as Ref) : null, stream: s });
  }
  return out;
}

/** Where markup at `i` (a '<') ends: comments, CDATA sections and processing instructions are skipped whole; a tag ends at its '>' outside quotes. */
function markupEnd(xml: string, i: number): number {
  const skip = (open: string, close: string) => (xml.startsWith(open, i) ? (xml.indexOf(close, i + open.length) < 0 ? xml.length : xml.indexOf(close, i + open.length) + close.length) : -1);
  for (const [o, c] of [['<!--', '-->'], ['<![CDATA[', ']]>'], ['<?', '?>']]) { const e = skip(o, c); if (e >= 0) return e; }
  let q = '';
  for (let k = i + 1; k < xml.length; k++) {
    const ch = xml[k];
    if (q) { if (ch === q) q = ''; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') return k + 1;
  }
  return xml.length;
}

/**
 * The elements (outermost only) whose local name (any namespace prefix) is in `names`, as [start, end)
 * ranges: an empty element, or the element up to its matching end tag. An element left open runs to the end.
 */
function xmlElements(xml: string, names: Set<string>): [number, number][] {
  const out: [number, number][] = [];
  const tag = /^<(\/?)([\w.:-]+)/;
  for (let i = xml.indexOf('<'); i >= 0 && i < xml.length; ) {
    const end = markupEnd(xml, i);
    const m = tag.exec(xml.slice(i, i + 200));
    const local = m ? m[2].slice(m[2].lastIndexOf(':') + 1) : '';
    if (m && !m[1] && names.has(local)) {
      if (xml[end - 2] === '/') { out.push([i, end]); i = xml.indexOf('<', end); continue; }
      // Find the matching end tag of the same qualified name, counting nested ones.
      let depth = 1, k = xml.indexOf('<', end), stop = xml.length;
      while (k >= 0) {
        const e = markupEnd(xml, k);
        const t = tag.exec(xml.slice(k, k + 200));
        if (t && t[2] === m[2] && xml[e - 2] !== '/') { depth += t[1] ? -1 : 1; if (!depth) { stop = e; break; } }
        k = xml.indexOf('<', e);
      }
      out.push([i, stop]);
      i = xml.indexOf('<', stop);
      continue;
    }
    i = xml.indexOf('<', end);
  }
  return out;
}

const XFA_ACTIVE = new Set(['script', 'execute', 'submit']);
const XFA_SECTIONS = new Set(['template', 'config']);

/** Takes scripts and event-driven execute/submit elements out of XFA XML (as bytes, one char per byte); `sections` limits it to template/config. */
function stripXfa(xml: string, sections: boolean): { xml: string; removed: number } {
  let removed = 0;
  const strip = (part: string): string => {
    const r = xmlElements(part, XFA_ACTIVE);
    removed += r.length;
    let s = '', at = 0;
    for (const [a, b] of r) { s += part.slice(at, a); at = b; }
    return s + part.slice(at);
  };
  if (!sections) return { xml: strip(xml), removed };
  let s = '', at = 0;
  for (const [a, b] of xmlElements(xml, XFA_SECTIONS)) { s += xml.slice(at, a) + strip(xml.slice(a, b)); at = b; }
  return { xml: s + xml.slice(at), removed };
}

/** The XFA packets that can hold scripts (template and config; a single-stream XDP is searched in those sections). */
function scriptPackets(doc: PdfDocument) { return xfaPackets(doc).filter((p) => p.name === '' || p.name === 'template' || p.name === 'config'); }

/** How many script, execute and submit elements the XFA form holds. */
function countXfaScripts(doc: PdfDocument): number {
  let n = 0;
  for (const p of scriptPackets(doc)) { try { n += stripXfa(latin1(doc.decoded(p.stream)), p.name === '').removed; } catch { /* unreadable packet */ } }
  return n;
}

/** Removes the XFA form's scripts (rewriting each changed packet); returns how many elements went. */
function removeXfaScripts(doc: PdfDocument): number {
  let n = 0;
  // A stream is always an indirect object, so every packet has a reference to replace it under.
  for (const p of scriptPackets(doc)) {
    if (!p.ref) continue;
    let r: { xml: string; removed: number };
    try { r = stripXfa(latin1(doc.decoded(p.stream)), p.name === ''); } catch { continue; }
    if (!r.removed) continue;
    const entries: Record<string, PdfObj> = {};
    for (const [k, v] of p.stream.dict.map) if (!['Filter', 'DecodeParms', 'Length', 'DL'].includes(k)) entries[k] = v;
    doc.update(p.ref, flateStream(bytesOf(r.xml), entries));
    n += r.removed;
  }
  return n;
}

/** Object numbers of the layers (optional content groups) that the default configuration hides. */
export function hiddenLayers(doc: PdfDocument): { ref: Ref; name: string }[] {
  const oc = doc.getDict(doc.catalog, 'OCProperties');
  if (!oc) return [];
  const d = doc.getDict(oc, 'D');
  const nums = (key: string) => new Set((d ? doc.getArray(d, key) || [] : []).filter((x): x is Ref => x instanceof Ref).map((r) => r.num));
  const off = nums('OFF'), on = nums('ON'), baseOff = !!d && doc.getName(d, 'BaseState') === 'OFF';
  const out: { ref: Ref; name: string }[] = [];
  for (const r of doc.getArray(oc, 'OCGs') || []) {
    if (!(r instanceof Ref)) continue;
    if (baseOff ? !on.has(r.num) : off.has(r.num)) out.push({ ref: r, name: doc.getText(doc.resolve<Dict | null>(r), 'Name') || `Layer ${r.num}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Sanitize

export interface SanitizeOptions { metadata?: boolean; attachments?: boolean; javascript?: boolean; links?: boolean; hiddenLayers?: boolean; comments?: boolean; forms?: boolean; embeddedSearchIndex?: boolean; bookmarks?: boolean; thumbnails?: boolean; privateData?: boolean }

export interface HiddenInfoReport { items: { kind: string; count: number; detail: string }[] }

export function hiddenInformation(doc: PdfDocument): HiddenInfoReport {
  const items: HiddenInfoReport['items'] = [];
  const m = readMetadata(doc);
  const metaFields = [m.title && 'title', m.author && 'author', m.subject && 'subject', m.keywords && 'keywords', m.creator && 'creator', m.producer && 'producer', ...Object.keys(m.custom)].filter(Boolean) as string[];
  if (metaFields.length) items.push({ kind: 'Metadata', count: metaFields.length, detail: metaFields.join(', ') });
  if (m.xmp) items.push({ kind: 'XMP metadata', count: 1, detail: `${m.xmp.length} characters` });
  const att = readAttachments(doc); if (att.length) items.push({ kind: 'Attachments', count: att.length, detail: att.map((a) => a.name).join(', ') });
  const js = countJavaScript(doc); if (js) items.push({ kind: 'JavaScript / actions', count: js, detail: 'scripts or actions that run on events' });
  const xfa = countXfaScripts(doc); if (xfa) items.push({ kind: 'XFA scripts', count: xfa, detail: 'scripts, execute and submit elements in the XFA form' });
  const annots = doc.pages.flatMap((p) => pageAnnotations(doc, p));
  const comments = annots.filter((a) => !['Widget', 'Popup', 'Link'].includes(a.subtype)); if (comments.length) items.push({ kind: 'Comments and markup', count: comments.length, detail: [...new Set(comments.map((a) => a.author).filter(Boolean))].join(', ') });
  const hidden = annots.filter((a) => a.hidden); if (hidden.length) items.push({ kind: 'Hidden annotations', count: hidden.length, detail: '' });
  const links = annots.filter((a) => a.subtype === 'Link'); if (links.length) items.push({ kind: 'Links', count: links.length, detail: '' });
  const fields = readFields(doc); if (fields.length) items.push({ kind: 'Form fields', count: fields.length, detail: fields.filter((f) => f.value && f.value !== '').length + ' with values' });
  const layers = hiddenLayers(doc); if (layers.length) items.push({ kind: 'Hidden layers', count: layers.length, detail: layers.map((l) => l.name).join(', ') });
  const bm = readOutlines(doc); if (bm.length) items.push({ kind: 'Bookmarks', count: bm.length, detail: '' });
  if (doc.pages.some((p) => p.dict.has('Thumb'))) items.push({ kind: 'Embedded page thumbnails', count: doc.pages.filter((p) => p.dict.has('Thumb')).length, detail: '' });
  if (doc.catalog.has('PieceInfo') || doc.pages.some((p) => p.dict.has('PieceInfo'))) items.push({ kind: 'Private application data', count: 1, detail: 'PieceInfo' });
  const updates = earlierVersions(doc.buf); if (updates) items.push({ kind: 'Earlier versions (incremental updates)', count: updates, detail: 'a full rewrite removes them' });
  return { items };
}

/** Removes hidden information; returns what was removed. The caller saves with a full rewrite so earlier versions disappear. */
export function sanitize(doc: PdfDocument, o: SanitizeOptions): string[] {
  const done: string[] = [];
  const cat = doc.catalog;
  if (o.metadata) {
    const info = doc.trailer.get('Info');
    if (info instanceof Ref) doc.update(info, new Dict({ Producer: PdfString.fromText('Anne\'s Folio') })); else doc.trailer.delete('Info');
    if (cat.has('Metadata')) { const m = cat.get('Metadata'); cat.delete('Metadata'); if (m instanceof Ref) doc.remove(m); }
    for (const p of doc.pages) if (p.dict.has('Metadata')) { p.dict.delete('Metadata'); if (p.ref) doc.touch(p.ref); }
    done.push('metadata');
  }
  // /Names may be an indirect object or shared: entries are removed on a copy that the catalog then holds
  // directly, so the change is written by an incremental save too.
  const dropName = (key: string): boolean => { const names = doc.getDict(cat, 'Names'); if (!names || !names.has(key)) return false; const c = names.clone(); c.delete(key); cat.set('Names', c); return true; };
  if (o.attachments) {
    for (const a of readAttachments(doc)) { const { removeAttachment } = requireStructure(); removeAttachment(doc, a); }
    dropName('EmbeddedFiles');
    cat.delete('Collection'); cat.delete('AF');
    done.push('attachments');
  }
  if (o.javascript) {
    let n = 0;
    if (dropName('JavaScript')) n++;
    // Active actions go wherever they hang, also further down a /Next chain; navigation (GoTo, URI) stays.
    const strip = (d: Dict): boolean => {
      let ch = false;
      const r = cleanAction(doc, d.get('A'));
      if (r.removed) { n += r.removed; if (r.value == null) d.delete('A'); else d.set('A', r.value); ch = true; }
      if (d.has('AA')) { d.delete('AA'); n++; ch = true; }
      return ch;
    };
    const oa = cleanAction(doc, cat.get('OpenAction'));
    if (oa.removed) { n += oa.removed; if (oa.value == null) cat.delete('OpenAction'); else cat.set('OpenAction', oa.value); }
    if (cat.has('AA')) { cat.delete('AA'); n++; }
    for (const p of doc.pages) {
      let changed = false;
      if (p.dict.has('AA')) { p.dict.delete('AA'); changed = true; n++; }
      for (const a of pageAnnotations(doc, p)) if (strip(a.dict)) { if (a.ref) doc.update(a.ref, a.dict); else changed = true; }
      if (changed && p.ref) doc.touch(p.ref);
    }
    // Bookmarks, and every node of the field tree (not only the fields that hold values).
    for (const [ref, d] of actionHolders(doc)) if (strip(d)) doc.touch(ref);
    if (n) done.push('JavaScript and actions');
    if (removeXfaScripts(doc)) done.push('XFA scripts');
  }
  if (o.links) { for (const p of doc.pages) { const keep = (doc.getArray(p.dict, 'Annots') || []).filter((a) => { const d = doc.resolve<Dict | null>(a); return !(d instanceof Dict && doc.getName(d, 'Subtype') === 'Link'); }); p.dict.set('Annots', keep); if (p.ref) doc.touch(p.ref); } done.push('links'); }
  if (o.comments) { for (const p of doc.pages) { const keep = (doc.getArray(p.dict, 'Annots') || []).filter((a) => { const d = doc.resolve<Dict | null>(a); const st = d instanceof Dict ? doc.getName(d, 'Subtype') : ''; return st === 'Widget' || st === 'Link'; }); p.dict.set('Annots', keep); if (p.ref) doc.touch(p.ref); } done.push('comments'); }
  if (o.forms) { const { flattenForm } = requireForms(); flattenForm(doc); done.push('form fields (flattened)'); }
  if (o.hiddenLayers) {
    // Hidden layers are removed with what they hold: showing them would publish the hidden content,
    // and leaving them leaves it in the file.
    const hidden = hiddenLayers(doc);
    if (hidden.length) {
      const set = new Set(hidden.map((l) => l.ref.num));
      const dropped = new Set<number>();
      for (const p of doc.pages) {
        removeHiddenContent(doc, p, set, dropped);
        for (const a of pageAnnotations(doc, p)) if (a.ref && membershipHidden(doc, a.dict.get('OC'), set)) removeAnnotation(doc, p, a.ref);
      }
      pruneUndrawn(doc, dropped);
      // The groups leave the layer list and every configuration.
      const without = (v: PdfObj | undefined, depth = 0): PdfObj => {
        const x = doc.resolve<PdfObj>(v);
        // Layer dictionaries themselves (and anything that is not a list or a dictionary) stay as they are referenced.
        if (v instanceof Ref && ((x instanceof Dict && doc.getName(x, 'Type') === 'OCG') || (!(x instanceof Dict) && !Array.isArray(x)))) return v;
        if (depth > 16) return v ?? null;
        if (Array.isArray(x)) return x.filter((e) => !(e instanceof Ref && set.has(e.num))).map((e) => without(e, depth + 1));
        if (x instanceof Dict) { const c = new Dict(); for (const [k, e] of x.map) c.set(k, without(e, depth + 1)); return c; }
        return x;
      };
      cat.set('OCProperties', without(cat.get('OCProperties')));
      done.push(`hidden layers (${hidden.length} removed with their content)`);
    }
  }
  if (o.bookmarks) { if (cat.has('Outlines')) { cat.delete('Outlines'); if (doc.getName(cat, 'PageMode') === 'UseOutlines') cat.delete('PageMode'); done.push('bookmarks'); } }
  if (o.thumbnails) { for (const p of doc.pages) if (p.dict.has('Thumb')) { p.dict.delete('Thumb'); if (p.ref) doc.touch(p.ref); } done.push('page thumbnails'); }
  if (o.privateData) { cat.delete('PieceInfo'); for (const p of doc.pages) if (p.dict.has('PieceInfo')) { p.dict.delete('PieceInfo'); if (p.ref) doc.touch(p.ref); } done.push('private application data'); }
  if (o.embeddedSearchIndex && dropName('EmbeddedSearch')) done.push('embedded search index');
  doc.update(doc.catalogRef, cat);
  return done;
}

// Lazy requires to avoid import cycles at module evaluation time.
import * as structureMod from '../structure';
import * as formsMod from './forms';
function requireStructure() { return structureMod; }
function requireForms() { return formsMod; }

// ------------------------------------------------------------------------------------------
// Checks

export interface CheckItem { level: 'error' | 'warning' | 'info'; text: string; page?: number; fix?: string }

/** Archival-readiness checks in the spirit of PDF/A (not a conformance test; says what it cannot verify). */
export function archivalCheck(doc: PdfDocument): CheckItem[] {
  const out: CheckItem[] = [];
  if (doc.security) out.push({ level: 'error', text: 'The document is encrypted; archival PDF forbids encryption.', fix: 'Protect ▸ Remove Security' });
  const fonts = listFonts(doc);
  for (const f of fonts) if (!f.embedded && !f.type3) out.push({ level: 'error', text: `Font ${f.name} is not embedded (pages ${f.pages.map((p) => p + 1).slice(0, 8).join(', ')}).`, fix: 'Fonts can only be embedded by the program that created the document' });
  const m = readMetadata(doc);
  if (!m.xmp) out.push({ level: 'error', text: 'No XMP metadata stream.', fix: 'File ▸ Properties writes one when you save' });
  if (!m.title) out.push({ level: 'warning', text: 'The document has no title.', fix: 'File ▸ Properties' });
  if (countJavaScript(doc)) out.push({ level: 'error', text: 'JavaScript or actions are present.', fix: 'Protect ▸ Sanitize' });
  if (readAttachments(doc).some((a) => !/pdf/i.test(a.mime))) out.push({ level: 'warning', text: 'Non-PDF attachments are present (allowed only in some archival levels).' });
  for (const im of listImages(doc)) if (/JPX/.test(im.filter)) out.push({ level: 'warning', text: `Image ${nameText(im.name)} on page ${im.page + 1} uses JPEG 2000 (allowed only in PDF/A-2 and later).`, page: im.page });
  if (readLayers(doc).length) out.push({ level: 'warning', text: 'Optional content (layers) is present (forbidden in PDF/A-1).' });
  const transp = doc.pages.some((p) => { const res = p.resources; const eg = res ? doc.getDict(res, 'ExtGState') : null; return !!eg && eg.keys().some((k) => { const g = doc.getDict(eg, k); return !!g && ((doc.getNum(g, 'CA', 1) < 1) || doc.getNum(g, 'ca', 1) < 1 || (g.has('SMask') && !isName(g.get('SMask'), 'None'))); }); });
  if (transp) out.push({ level: 'warning', text: 'Transparency is used (forbidden in PDF/A-1, allowed from PDF/A-2).' });
  if (!out.some((x) => x.level === 'error')) out.push({ level: 'info', text: 'No blocking problems found. Anne\'s Folio checks structure only; color profiles and font program validity are not verified.' });
  return out;
}

export function accessibilityCheck(doc: PdfDocument, pageTexts?: string[]): CheckItem[] {
  const out: CheckItem[] = [];
  const m = readMetadata(doc);
  if (!m.title) out.push({ level: 'error', text: 'No document title (screen readers announce the file name instead).', fix: 'Review ▸ Accessibility Fixer sets it' });
  if (!m.language) out.push({ level: 'error', text: 'No document language.', fix: 'Review ▸ Accessibility Fixer sets it' });
  if (!m.tagged) out.push({ level: 'error', text: 'The document is not tagged: reading order and headings are not available to assistive technology. Anne\'s Folio cannot add tags to existing content; create a tagged PDF from the source document.' });
  const images = listImages(doc);
  if (images.length && !m.tagged) out.push({ level: 'warning', text: `${images.length} image(s) have no alternative text (alt text needs a tagged structure).` });
  const vp = doc.getDict(doc.catalog, 'ViewerPreferences');
  if (!vp || doc.get(vp, 'DisplayDocTitle') !== true) out.push({ level: 'warning', text: 'Viewers show the file name rather than the title.', fix: 'Review ▸ Accessibility Fixer turns on Display Document Title' });
  if (pageTexts) pageTexts.forEach((t, i) => { if (!t.trim() && images.some((im) => im.page === i)) out.push({ level: 'warning', text: `Page ${i + 1} has no text (scanned?).`, page: i, fix: 'Scan/OCR ▸ Recognize Text' }); });
  for (const f of readFields(doc)) if (!f.tooltip && f.type !== 'button') out.push({ level: 'warning', text: `Form field "${f.name}" has no tooltip (its accessible name).`, fix: 'Forms ▸ Field Properties' });
  if (!out.length) out.push({ level: 'info', text: 'No problems found in what Anne\'s Folio can check.' });
  return out;
}

/** Applies the automatic accessibility fixes: title, language, display title, field tooltips from names. */
export function accessibilityFix(doc: PdfDocument, o: { title?: string; language?: string }): string[] {
  const done: string[] = [];
  const m = readMetadata(doc);
  if (!m.title && o.title) { doc.ensureInfo().set('Title', PdfString.fromText(o.title)); done.push('title'); }
  if (!m.language && o.language) { doc.catalog.set('Lang', PdfString.fromText(o.language)); done.push('language'); }
  const vp = doc.getDict(doc.catalog, 'ViewerPreferences');
  // Written on a copy held by the catalog: the original may be an indirect object the save would not rewrite.
  if (!vp || doc.get(vp, 'DisplayDocTitle') !== true) { const own = vp ? vp.clone() : new Dict(); own.set('DisplayDocTitle', true); doc.catalog.set('ViewerPreferences', own); done.push('display document title'); }
  for (const f of readFields(doc)) if (!f.tooltip && f.type !== 'button') { f.dict.set('TU', PdfString.fromText(f.name.split('.').pop()!.replace(/[_-]+/g, ' '))); doc.update(f.ref, f.dict); done.push(`tooltip for ${f.name}`); }
  doc.update(doc.catalogRef, doc.catalog);
  return done;
}

export const isImageFilter = (n: string): boolean => IMAGE_FILTERS.has(n);
export type { PdfObj };
