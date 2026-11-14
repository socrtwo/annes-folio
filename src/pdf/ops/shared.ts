/**
 * Helpers shared by the operation modules: annotation geometry that must move with /Rect, and
 * keeping the AcroForm field tree consistent when widgets leave a document.
 */
import { Dict, PdfObj, Ref } from '../objects';
import type { PdfDocument, PageInfo } from '../document';

const FLAT_GEOMETRY = ['QuadPoints', 'L', 'Vertices', 'CL'];

/** Applies a point mapping to every coordinate an annotation stores besides /Rect (QuadPoints, InkList, L, Vertices, CL). */
export function mapAnnotGeometry(doc: PdfDocument, d: Dict, f: (x: number, y: number) => [number, number]): void {
  const pairs = (a: PdfObj[]): number[] => { const v = a.map((x) => { const n = doc.resolve<PdfObj>(x); return typeof n === 'number' ? n : 0; }); const out: number[] = []; for (let i = 0; i + 1 < v.length; i += 2) out.push(...f(v[i], v[i + 1])); return out; };
  for (const k of FLAT_GEOMETRY) { const a = doc.getArray(d, k); if (a) d.set(k, pairs(a)); }
  const ink = doc.getArray(d, 'InkList');
  if (ink) d.set('InkList', ink.map((g) => { const a = doc.resolve<PdfObj>(g); return Array.isArray(a) ? pairs(a) : []; }));
}

/**
 * Takes a widget (or a merged field/widget) out of the AcroForm field tree: out of its parent's /Kids,
 * and, when that leaves a field without widgets, the field out of its own parent or of /Fields and /CO.
 * The widget object itself is left to the caller (removeAnnotation deletes it).
 */
export function detachWidget(doc: PdfDocument, ref: Ref): void {
  const af = doc.getDict(doc.catalog, 'AcroForm');
  const sameRef = (r: PdfObj, n: number) => r instanceof Ref && r.num === n;
  const dropFromForm = (n: number) => {
    if (!af) return;
    let changed = false;
    for (const k of ['Fields', 'CO']) { const a = doc.getArray(af, k); if (a && a.some((r) => sameRef(r, n))) { af.set(k, a.filter((r) => !sameRef(r, n))); changed = true; } }
    if (!changed) return;
    const r = doc.catalog.get('AcroForm');
    if (r instanceof Ref) doc.touch(r); else doc.update(doc.catalogRef, doc.catalog);
  };
  let cur = ref, d = doc.resolve<PdfObj>(cur);
  for (let depth = 0; depth < 32; depth++) {
    dropFromForm(cur.num);
    const parent = d instanceof Dict ? d.get('Parent') : undefined;
    if (!(parent instanceof Ref)) return;
    const pd = doc.resolve<PdfObj>(parent);
    if (!(pd instanceof Dict)) return;
    const n = cur.num;
    const kids = (doc.getArray(pd, 'Kids') || []).filter((r) => !sameRef(r, n));
    pd.set('Kids', kids);
    doc.touch(parent);
    if (kids.length) return;
    // The field has no widgets left: it goes too.
    doc.remove(parent);
    cur = parent; d = pd;
  }
}

/** True for a widget annotation or a merged field/widget dictionary. */
export const isWidget = (doc: PdfDocument, d: PdfObj): d is Dict => d instanceof Dict && doc.getName(d, 'Subtype') === 'Widget';

/**
 * The page's own /Resources dictionary, ready to be changed. A page that inherits its resources from
 * the page tree gets a copy of them first (PdfDocument.pageResources would start from an empty one).
 */
export function ownResources(doc: PdfDocument, p: PageInfo): Dict {
  if (!p.dict.has('Resources') && p.resources) p.dict.set('Resources', p.resources.clone());
  return doc.pageResources(p);
}
