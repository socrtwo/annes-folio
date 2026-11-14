/**
 * Which pages an edit changed, so the viewer re-renders only those pages and their thumbnails.
 *
 * An edit is described by the object numbers whose contents differ before and after it (overlayDiff,
 * computed by the tab from its undo snapshot). A page is changed when one of those numbers is reachable
 * from the page: its dictionary, contents, resources, annotations and their appearances, and what the
 * page inherits from the page tree. Document-wide settings that change how every page draws (the form
 * dictionary, optional content) change every page. When in doubt a page counts as changed.
 */
import { Dict, PdfStream, PdfString, Name, Ref, type PdfObj } from '../pdf/objects';
import type { PdfDocument, PageInfo } from '../pdf/document';
import { serialize } from '../pdf/writer';

/** True when two objects have the same contents. Streams compare by their dictionary and the identity (or bytes) of their data. */
export function samePdfObj(a: PdfObj | undefined, b: PdfObj | undefined): boolean {
  if (a === b) return true;
  if (a instanceof Ref) return b instanceof Ref && a.num === b.num && a.gen === b.gen;
  if (a instanceof Name) return b instanceof Name && a.name === b.name;
  if (a instanceof PdfString) return b instanceof PdfString && sameBytes(a.bytes, b.bytes);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!samePdfObj(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Dict) {
    if (!(b instanceof Dict) || a.map.size !== b.map.size) return false;
    for (const [k, v] of a.map) { if (!b.map.has(k) || !samePdfObj(v, b.map.get(k))) return false; }
    return true;
  }
  if (a instanceof PdfStream) return b instanceof PdfStream && (a.raw === b.raw || sameBytes(a.raw, b.raw)) && samePdfObj(a.dict, b.dict);
  return false; // different numbers, booleans, null
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Object numbers whose contents differ between two overlays. An object in only one of them is compared with
 * its version in the file, from `original` (which returns what it could read: a number it leaves out counts
 * as changed); without `original` it counts as changed. An edit that touches an object without changing it
 * (such as making a page's inherited attributes explicit) then changes nothing on screen.
 */
export function overlayDiff(a: ReadonlyMap<number, PdfObj | null>, b: ReadonlyMap<number, PdfObj | null>, original?: (nums: number[]) => ReadonlyMap<number, PdfObj | null>): Set<number> {
  const out = new Set<number>();
  const oneSided: number[] = [];
  for (const [n, v] of a) { if (!b.has(n)) oneSided.push(n); else if (!samePdfObj(v, b.get(n)!)) out.add(n); }
  for (const n of b.keys()) if (!a.has(n)) oneSided.push(n);
  const orig = original && oneSided.length ? original(oneSided) : null;
  for (const n of oneSided) {
    const v = a.has(n) ? a.get(n)! : b.get(n)!;
    if (!orig || !orig.has(n) || !samePdfObj(v, orig.get(n)!)) out.add(n);
  }
  return out;
}

/** True when two trailers name the same catalog and encryption (the /Info object, /ID and /Size do not change how pages draw). */
export function sameTrailerForPages(a: Dict, b: Dict): boolean {
  for (const k of ['Root', 'Encrypt']) if (!samePdfObj(a.get(k), b.get(k))) return false;
  return true;
}

/** Above this many objects a page is treated as changed on every edit rather than tracked. */
const MAX_CLOSURE = 20000;
const TOO_BIG = new Set<number>();

/**
 * Object numbers reachable from `roots`. Page backlinks (/P) are not followed, and another page or page-tree
 * node is recorded but not entered (a link to page 7 does not make page 5 depend on all of page 7).
 */
function reach(doc: PdfDocument, roots: PdfObj[], out: Set<number>): boolean {
  const stack: PdfObj[] = [...roots];
  while (stack.length) {
    const v = stack.pop()!;
    if (v instanceof Ref) {
      if (out.has(v.num)) continue;
      out.add(v.num);
      if (out.size > MAX_CLOSURE) return false;
      let o: PdfObj;
      try { o = doc.fetch(v); } catch { continue; }
      const d = o instanceof Dict ? o : o instanceof PdfStream ? o.dict : null;
      if (d) { const t = d.get('Type'); if (t instanceof Name && (t.name === 'Page' || t.name === 'Pages')) continue; }
      stack.push(o);
    } else if (Array.isArray(v)) { for (const x of v) stack.push(x); }
    else if (v instanceof Dict) { for (const [k, x] of v.map) if (k !== 'P') stack.push(x); }
    else if (v instanceof PdfStream) { for (const [k, x] of v.dict.map) if (k !== 'P') stack.push(x); }
  }
  return true;
}

const latin1 = (b: Uint8Array): string => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return s; };
const sigOf = (v: PdfObj | undefined): string => (v === undefined ? '-' : latin1(serialize(v)));

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

/** The page-tree ancestors of a page (nearest first), and their object numbers (null when one is not an indirect object). */
function ancestors(doc: PdfDocument, p: PageInfo): { dicts: Dict[]; nums: number[] | null } {
  const dicts: Dict[] = [];
  let nums: number[] | null = [];
  const seen = new Set<Dict>([p.dict]);
  let ref: PdfObj | undefined = p.dict.get('Parent');
  let node = doc.resolve<PdfObj>(ref);
  while (node instanceof Dict && !seen.has(node) && dicts.length < 64) {
    seen.add(node); dicts.push(node);
    if (ref instanceof Ref) nums?.push(ref.num); else nums = null;
    ref = node.get('Parent');
    node = doc.resolve<PdfObj>(ref);
  }
  return { dicts, nums };
}

/** What a page takes from its ancestors, as text (references as references: their contents are in the closure). */
function inheritedSig(dicts: Dict[], memo: Map<Dict, string>): string {
  let s = '';
  for (const a of dicts) {
    let m = memo.get(a);
    if (m === undefined) { m = INHERITED.map((k) => (a.has(k) ? `${k}=${sigOf(a.get(k))}` : '')).join(';'); memo.set(a, m); }
    s += m + '|';
  }
  return s;
}

/** Object numbers a page draws from: its own dictionary (but not /Parent) and what it inherits. */
export function pageClosure(doc: PdfDocument, p: PageInfo): Set<number> {
  const out = new Set<number>();
  if (p.ref) out.add(p.ref.num);
  const roots: PdfObj[] = [];
  for (const [k, v] of p.dict.map) if (k !== 'Parent') roots.push(v);
  for (const a of ancestors(doc, p).dicts) for (const k of INHERITED) { const v = a.get(k); if (v !== undefined) roots.push(v); }
  return reach(doc, roots, out) ? out : TOO_BIG;
}

/** Document-wide settings every page is drawn with: the form dictionary (without its field list) and optional content. */
function globalState(doc: PdfDocument): { sig: string; closure: Set<number> } {
  let cat: Dict;
  try { cat = doc.catalog; } catch { return { sig: '', closure: new Set() }; }
  const roots: PdfObj[] = [];
  let sig = '';
  const af = doc.resolve<PdfObj>(cat.get('AcroForm'));
  if (af instanceof Dict) {
    const d = new Dict();
    for (const [k, v] of af.map) if (k !== 'Fields') { d.map.set(k, v); roots.push(v); }
    sig += sigOf(d);
  }
  const oc = cat.get('OCProperties');
  sig += '|' + sigOf(oc);
  if (oc !== undefined) roots.push(oc);
  const closure = new Set<number>();
  return { sig, closure: reach(doc, roots, closure) ? closure : TOO_BIG };
}

const meets = (a: Set<number>, touched: ReadonlySet<number>): boolean => {
  if (a === TOO_BIG) return true;
  if (touched.size < a.size) { for (const n of touched) if (a.has(n)) return true; return false; }
  for (const n of a) if (touched.has(n)) return true;
  return false;
};

/**
 * Gives every page a token that changes when the page may draw differently. `touched` is what changed in
 * the document since the previous call ('all' when unknown); `numbering` names the object numbering the
 * document uses (a different value, such as after reloading from a rewritten file, changes every page).
 */
export class PageChangeTracker {
  private gen = 0;
  private numbering: unknown = undefined;
  private started = false;
  private pages = new Map<number, { token: string; closure: Set<number> | null; inh: string; anc: number[] | null }>();
  private global: { sig: string; closure: Set<number> } | null = null;

  /** The next call changes every page. */
  reset(): void { this.started = false; }

  tokens(doc: PdfDocument, touched: ReadonlySet<number> | 'all', numbering: unknown): string[] {
    let all = touched === 'all' || !this.started || numbering !== this.numbering;
    this.started = true;
    this.numbering = numbering;
    const g = globalState(doc);
    if (!all && this.global && (g.sig !== this.global.sig || meets(this.global.closure, touched as ReadonlySet<number>))) all = true;
    this.global = g;
    const memo = new Map<Dict, string>();
    const out: string[] = [];
    const seen = new Set<number>();
    for (const p of doc.pages) {
      const num = p.ref?.num;
      if (num === undefined || seen.has(num)) { out.push(`d${++this.gen}`); continue; }
      seen.add(num);
      let e = this.pages.get(num);
      // The inherited attributes are read again only when the page or one of its ancestors was touched
      // (the page's /Parent is in the page itself).
      const t = touched as ReadonlySet<number>;
      const fresh = !e || all || !e.anc || t.has(num) || e.anc.some((n) => t.has(n));
      let inh = e?.inh ?? '', anc = e?.anc ?? null;
      if (fresh) { const a = ancestors(doc, p); inh = inheritedSig(a.dicts, memo); anc = a.nums; }
      if (!e || all) {
        e = { token: `${num}.${++this.gen}`, closure: null, inh, anc };
        this.pages.set(num, e);
      } else {
        e.anc = anc;
        let changed = inh !== e.inh;
        if (!changed) {
          // Computed now when not cached: an object reachable now and touched was reachable before the edit too.
          const c = e.closure ?? (e.closure = pageClosure(doc, p));
          changed = meets(c, touched as ReadonlySet<number>);
        }
        if (changed) { e.token = `${num}.${++this.gen}`; e.closure = null; e.inh = inh; }
      }
      out.push(e.token);
    }
    for (const n of [...this.pages.keys()]) if (!seen.has(n)) this.pages.delete(n);
    return out;
  }
}
