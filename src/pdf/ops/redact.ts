/**
 * Content redaction: rewrites a page's content stream (and the Form XObjects it draws) so that text
 * glyphs, images and vector paths under the redaction areas are gone from the content, not covered.
 * Removed text keeps its advance, so what follows stays where it was. XObjects that are no longer
 * drawn are taken out of the resources, so a full rewrite of the file drops their data.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, isName } from '../objects';
import { flateStream } from '../filters';
import type { PdfDocument, PageInfo } from '../document';
import { ownResources } from './shared';
import { parseContent, serializeContent, fontInfo, decodeString, mul, apply, IDENTITY, rectsOverlap, type Op, type Matrix, type FontInfo } from '../content';

type Rect = [number, number, number, number];

export interface RedactStats { text: number; images: number; paths: number; forms: number }

/**
 * How much work in Form XObjects one page may still take (in operators, as in content.ts: about twenty
 * million), and whether some form was left unchecked because it ran out: forms that draw each other many
 * times over would otherwise be rewritten without end.
 */
export interface RedactWork { opsLeft: number; cutShort: boolean }
export const redactWork = (): RedactWork => ({ opsLeft: 2e7, cutShort: false });

interface Ctx { doc: PdfDocument; rects: Rect[]; stats: RedactStats; /** Object numbers of XObjects a rewritten container stopped drawing. */ dropped: Set<number>; /** Text-showing operators to blank whatever their position, each replaced by exactly one operator. */ force?: Set<Op>; /** Object numbers of optional content groups (layers) that are hidden: what they hold is removed. */ hidden?: Set<number>; work?: RedactWork }

/** Hands out a container's private copy of a resource sub-dictionary, made on first use. */
type Own = (kind: 'XObject' | 'Properties') => Dict;

interface GState { ctm: Matrix; font: FontInfo | null; exact: boolean; size: number; charSp: number; wordSp: number; hscale: number; leading: number; rise: number }

const num = (v: PdfObj | undefined, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d);
const boxOf = (pts: [number, number][]): Rect => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const inside = (b: Rect, r: Rect): boolean => b[0] >= r[0] - 0.01 && b[1] >= r[1] - 0.01 && b[2] <= r[2] + 0.01 && b[3] <= r[3] + 0.01;
const PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);
const MAX_FORM_DEPTH = 8;

/** True when optional-content membership `v` (a group or a membership dictionary) is hidden. */
function ocHidden(c: Ctx, v: PdfObj | undefined): boolean {
  if (!c.hidden || v == null) return false;
  if (v instanceof Ref && c.hidden.has(v.num)) return true;
  const d = c.doc.resolve<PdfObj>(v);
  if (!(d instanceof Dict) || c.doc.getName(d, 'Type') !== 'OCMD' || d.has('VE')) return false;
  const g = c.doc.resolve<PdfObj>(d.get('OCGs'));
  const groups = (Array.isArray(g) ? g : d.get('OCGs') instanceof Ref ? [d.get('OCGs')!] : []).filter((x): x is Ref => x instanceof Ref);
  if (!groups.length) return false;
  const off = groups.filter((r) => c.hidden!.has(r.num)).length, on = groups.length - off;
  const policy = c.doc.getName(d, 'P') || 'AnyOn';
  const visible = policy === 'AllOn' ? off === 0 : policy === 'AnyOff' ? off > 0 : policy === 'AllOff' ? on === 0 : on > 0;
  return !visible;
}

/** Redacts one content stream. `own` hands out the container's private resource dictionaries when a name must change or go. */
function redactOps(c: Ctx, ops: Op[], resources: Dict | null, ctm0: Matrix, depth: number, own: Own): { ops: Op[]; changed: boolean } {
  const { doc, rects } = c;
  const hit = (b: Rect) => rects.some((r) => rectsOverlap(r, b));
  const fontRes = resources ? doc.getDict(resources, 'Font') : null;
  const xobjRes = resources ? doc.getDict(resources, 'XObject') : null;
  const propRes = resources ? doc.getDict(resources, 'Properties') : null;
  const fonts = new Map<string, { info: FontInfo; exact: boolean }>();
  const fontOf = (n: string) => {
    let f = fonts.get(n);
    if (!f) {
      const fd = fontRes ? doc.getDict(fontRes, n) : null;
      const info = fontInfo(doc, n, fd);
      // Glyph positions are only trusted when the font states its widths; otherwise a hit removes the whole string.
      const exact = !!fd && info.subtype !== 'Type3' && (info.twoByte || !!doc.getArray(fd, 'Widths')?.length);
      f = { info, exact }; fonts.set(n, f);
    }
    return f;
  };
  let g: GState = { ctm: ctm0, font: null, exact: false, size: 0, charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0 };
  const stack: GState[] = [];
  let tm: Matrix = IDENTITY, tlm: Matrix = IDENTITY;
  const out: Op[] = [];
  const gone = new Set<Op>();
  let changed = false;
  // Marked-content sequences open right now; one that loses text also loses its /ActualText, /Alt and /E.
  const marked: Op[] = [];
  const touchedMarks = new Set<Op>();
  // Hidden optional content: how many enclosing sequences are hidden, and which open sequences started one.
  let hiddenDepth = 0;
  const hiddenStart: boolean[] = [];
  const droppedProps = new Set<string>();
  // The path under construction.
  let path: Op[] = [], pathPts: [number, number][] = [], clip = false;
  const droppedNames = new Set<string>();

  /** Shows text; returns the replacement operand array when glyphs under a redaction area were removed, else null. */
  const showText = (items: PdfObj[], force: boolean): PdfObj[] | null => {
    if (!g.font) { const f = fontOf('__none'); g.font = f.info; g.exact = f.exact; }
    const font = g.font, unit = g.size * g.hscale;
    const pieces: { item: PdfObj; glyphs?: { from: number; to: number; adv: number; hit: boolean }[] }[] = [];
    let any = force;
    for (const it of items) {
      if (typeof it === 'number') { tm = mul([1, 0, 0, 1, (-it / 1000) * unit, 0], tm); pieces.push({ item: it }); continue; }
      if (!(it instanceof PdfString)) { pieces.push({ item: it }); continue; }
      const { codes } = decodeString(font, it);
      const step = font.twoByte ? 2 : 1;
      const glyphs: { from: number; to: number; adv: number; hit: boolean }[] = [];
      codes.forEach((code, k) => {
        const w = (font.widths.get(code) ?? font.defaultWidth) / 1000;
        const adv = (w * g.size + g.charSp + (!font.twoByte && code === 32 ? g.wordSp : 0)) * g.hscale;
        const m = mul(mul([unit, 0, 0, g.size, 0, g.rise], tm), g.ctm);
        const bw = w > 0 ? w : 0.5;
        const isHit = hit(boxOf([apply(m, 0, -0.25), apply(m, bw, -0.25), apply(m, 0, 0.85), apply(m, bw, 0.85)]));
        if (isHit) any = true;
        glyphs.push({ from: k * step, to: (k + 1) * step, adv, hit: isHit });
        tm = mul([1, 0, 0, 1, adv, 0], tm);
      });
      pieces.push({ item: it, glyphs });
    }
    if (!any) return null;
    const arr: PdfObj[] = [];
    const shift = (adv: number) => { if (!unit || !adv) return; const n = (-adv * 1000) / unit; if (typeof arr[arr.length - 1] === 'number') arr[arr.length - 1] = (arr[arr.length - 1] as number) + n; else arr.push(n); };
    for (const pc of pieces) {
      if (typeof pc.item === 'number') { if (typeof arr[arr.length - 1] === 'number') arr[arr.length - 1] = (arr[arr.length - 1] as number) + pc.item; else arr.push(pc.item); continue; }
      if (!pc.glyphs) continue;
      const s = pc.item as PdfString;
      let keepFrom = -1;
      const flush = (to: number) => { if (keepFrom >= 0) { arr.push(new PdfString(s.bytes.slice(keepFrom, to), s.hex)); keepFrom = -1; } };
      for (const gl of pc.glyphs) {
        if (gl.hit || force || !g.exact) { flush(gl.from); shift(gl.adv); }
        else if (keepFrom < 0) keepFrom = gl.from;
      }
      flush(pc.glyphs.length ? pc.glyphs[pc.glyphs.length - 1].to : 0);
    }
    c.stats.text++;
    changed = true;
    for (const m of marked) touchedMarks.add(m);
    return arr;
  };
  const nextLine = () => { tlm = mul([1, 0, 0, 1, 0, -g.leading], tlm); tm = tlm; };
  const endPath = () => { path = []; pathPts = []; clip = false; };
  const unitBox = (): Rect => boxOf([apply(g.ctm, 0, 0), apply(g.ctm, 1, 0), apply(g.ctm, 0, 1), apply(g.ctm, 1, 1)]);

  for (const o of ops) {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push({ ...g }); if (stack.length > 256) stack.shift(); break;
      case 'Q': g = stack.pop() || g; break;
      case 'cm': if (a.length >= 6) g.ctm = mul([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])], g.ctm); break;
      case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
      case 'Tf': if (isName(a[0])) { const f = fontOf(a[0].name); g.font = f.info; g.exact = f.exact; g.size = num(a[1]); } break;
      case 'Td': tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm); tm = tlm; break;
      case 'TD': g.leading = -num(a[1]); tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm); tm = tlm; break;
      case 'Tm': if (a.length >= 6) { tlm = [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]; tm = tlm; } break;
      case 'T*': nextLine(); break;
      case 'TL': g.leading = num(a[0]); break;
      case 'Tc': g.charSp = num(a[0]); break;
      case 'Tw': g.wordSp = num(a[0]); break;
      case 'Tz': g.hscale = num(a[0], 100) / 100; break;
      case 'Ts': g.rise = num(a[0]); break;
      case 'BMC': case 'BDC': {
        marked.push(o);
        const oc = o.op === 'BDC' && isName(a[0], 'OC') && isName(a[1]) && propRes ? propRes.get(a[1].name) : undefined;
        const hide = ocHidden(c, oc);
        hiddenStart.push(hide);
        if (hide) { hiddenDepth++; droppedProps.add((a[1] as Name).name); changed = true; continue; } // the marker goes with what it held
        break;
      }
      case 'EMC': { marked.pop(); if (hiddenStart.pop()) { hiddenDepth--; continue; } break; }
      case 'sh': if (hiddenDepth > 0) { changed = true; continue; } break;
      case 'm': case 'l': for (let k = 0; k + 1 < a.length; k += 2) pathPts.push(apply(g.ctm, num(a[k]), num(a[k + 1]))); path.push(o); break;
      case 'c': case 'v': case 'y': for (let k = 0; k + 1 < a.length; k += 2) pathPts.push(apply(g.ctm, num(a[k]), num(a[k + 1]))); path.push(o); break;
      case 're': { const x = num(a[0]), y = num(a[1]), w = num(a[2]), h = num(a[3]); pathPts.push(apply(g.ctm, x, y), apply(g.ctm, x + w, y), apply(g.ctm, x, y + h), apply(g.ctm, x + w, y + h)); path.push(o); break; }
      case 'h': path.push(o); break;
      case 'W': case 'W*': clip = true; break;
    }
    if (TEXT_SHOW.has(o.op)) {
      // The line move and spacing of ' and " happen whether or not the string survives.
      if (o.op === '"') { g.wordSp = num(a[0]); g.charSp = num(a[1]); }
      if (o.op !== 'Tj' && o.op !== 'TJ') nextLine();
      const operand = o.op === 'TJ' ? a[0] : o.op === '"' ? a[2] : a[0];
      const forced = !!c.force?.has(o);
      const arr = showText(Array.isArray(operand) ? operand : [operand ?? null], forced || hiddenDepth > 0);
      if (!arr) { out.push(o); continue; }
      if (forced) {
        // One operator in, one out (callers hold operator indexes): ' and " keep their line move and lose the advance.
        const empty = new PdfString(new Uint8Array(0));
        out.push(o.op === "'" ? { op: "'", args: [empty] } : o.op === '"' ? { op: '"', args: [num(a[0]), num(a[1]), empty] } : { op: 'TJ', args: [arr] });
        continue;
      }
      if (o.op === '"') out.push({ op: 'Tw', args: [num(a[0])] }, { op: 'Tc', args: [num(a[1])] });
      if (o.op !== 'Tj' && o.op !== 'TJ') out.push({ op: 'T*', args: [] });
      if (arr.length) out.push({ op: 'TJ', args: [arr] });
      continue;
    }
    if (PAINT.has(o.op)) {
      // Hidden optional content is not painted; its path may still set a clip, so it ends with `n`.
      if (hiddenDepth > 0 && o.op !== 'n') { endPath(); out.push({ op: 'n', args: [] }); changed = true; continue; }
      // A drawn path that lies wholly inside a redaction area is removed (clipping paths stay).
      if (path.length && pathPts.length && !clip && o.op !== 'n') {
        const b = boxOf(pathPts);
        if (rects.some((r) => inside(b, r))) { for (const po of path) gone.add(po); endPath(); c.stats.paths++; changed = true; continue; }
      }
      endPath();
      out.push(o);
      continue;
    }
    if (o.op === 'INLINE_IMAGE') {
      if (hiddenDepth > 0 || hit(unitBox())) { c.stats.images++; changed = true; continue; }
      out.push(o);
      continue;
    }
    if (o.op === 'Do' && isName(a[0])) {
      const name = a[0].name;
      const ref = xobjRes ? xobjRes.get(name) : undefined;
      const x = doc.resolve<PdfObj>(ref);
      if (x instanceof PdfStream) {
        const sub = doc.getName(x, 'Subtype');
        if (hiddenDepth > 0 || ocHidden(c, x.dict.get('OC'))) { changed = true; droppedNames.add(name); continue; }
        if (sub === 'Image') {
          if (hit(unitBox())) { c.stats.images++; changed = true; droppedNames.add(name); continue; }
        } else if (sub === 'Form') {
          const mtx = doc.getArray(x, 'Matrix');
          const fm: Matrix = mtx && mtx.length >= 6 ? (mtx.map((v) => num(doc.resolve<PdfObj>(v))) as Matrix) : IDENTITY;
          const inner = mul(fm, g.ctm);
          const bb = doc.rect(x.dict.get('BBox'));
          const underMark = rects.length > 0 && (!bb || hit(boxOf([apply(inner, bb[0], bb[1]), apply(inner, bb[2], bb[1]), apply(inner, bb[0], bb[3]), apply(inner, bb[2], bb[3])])));
          if (underMark && depth >= MAX_FORM_DEPTH) { c.stats.forms++; changed = true; droppedNames.add(name); continue; } // too deep to rewrite safely: the form goes
          if (c.hidden && !underMark && depth >= MAX_FORM_DEPTH && c.work) c.work.cutShort = true; // too deep to look into for hidden layers
          if ((underMark || c.hidden) && depth < MAX_FORM_DEPTH) {
            // Rewrite a private copy of the form; the original stays for whoever else draws it.
            const priv: { res: Dict | null; subs: Map<string, Dict> } = { res: null, subs: new Map() };
            const innerRes = doc.getDict(x, 'Resources') || resources;
            const innerOwn: Own = (kind) => {
              let sub2 = priv.subs.get(kind);
              if (!sub2) { if (!priv.res) priv.res = innerRes ? innerRes.clone() : new Dict(); const cur = doc.getDict(priv.res, kind); sub2 = cur ? cur.clone() : new Dict(); priv.res.set(kind, sub2); priv.subs.set(kind, sub2); }
              return sub2;
            };
            let r: { ops: Op[]; changed: boolean } | null;
            try {
              const formOps = parseContent(doc.decoded(x));
              // Rewriting a form costs about as much as walking a thousand of its operators. Out of budget, the
              // form stays as it is and the page is reported as not fully checked.
              if (c.work && (c.work.opsLeft -= formOps.length + 1000) < 0) { c.work.cutShort = true; r = null; }
              else r = redactOps(c, formOps, innerRes, inner, depth + 1, innerOwn);
            } catch { if (!underMark) { out.push(o); continue; } c.stats.forms++; changed = true; droppedNames.add(name); continue; } // unreadable form under a mark: remove it rather than keep it
            if (!r) { out.push(o); continue; }
            if (r.changed) {
              const entries: Record<string, PdfObj> = {};
              for (const [k, v] of x.dict.map) if (!['Filter', 'DecodeParms', 'Length', 'DL', 'F', 'FFilter', 'FDecodeParms'].includes(k)) entries[k] = v;
              if (priv.res) entries.Resources = priv.res;
              const nref = doc.register(flateStream(serializeContent(r.ops), entries));
              const d = own('XObject');
              let k = 1; while (d.has(`${name}_r${k}`)) k++;
              d.set(`${name}_r${k}`, nref);
              out.push({ op: 'Do', args: [Name.get(`${name}_r${k}`)] });
              droppedNames.add(name);
              c.stats.forms++;
              changed = true;
              continue;
            }
          }
        }
      }
    }
    out.push(o);
  }
  // Text removed from a marked-content sequence: its replacement text must not survive in the property list.
  for (const m of touchedMarks) {
    if (m.op !== 'BDC') continue;
    const props = m.args[1];
    const leak = (d: PdfObj | undefined): d is Dict => d instanceof Dict && (d.has('ActualText') || d.has('Alt') || d.has('E'));
    if (leak(props)) { const d = props.clone(); d.delete('ActualText'); d.delete('Alt'); d.delete('E'); m.args = [m.args[0], d]; }
    else if (isName(props) && propRes && leak(doc.get<PdfObj>(propRes, props.name))) { m.op = 'BMC'; m.args = [m.args[0]]; } // a named property list is shared: keep the tag only
  }
  const kept = gone.size ? out.filter((o) => !gone.has(o)) : out;
  // XObjects this container no longer draws leave its resources.
  if (droppedNames.size) {
    const still = new Set(kept.filter((o) => o.op === 'Do' && isName(o.args[0])).map((o) => (o.args[0] as Name).name));
    for (const n of droppedNames) {
      if (still.has(n)) continue;
      const d = own('XObject');
      const r = d.get(n);
      if (r instanceof Ref) c.dropped.add(r.num);
      d.delete(n);
    }
  }
  // Property-list names of removed layers leave the resources too (they point at the layer's dictionary).
  if (droppedProps.size) {
    const still = new Set(kept.filter((o) => (o.op === 'BDC' || o.op === 'DP') && isName(o.args[1])).map((o) => (o.args[1] as Name).name));
    for (const n of droppedProps) if (!still.has(n)) own('Properties').delete(n);
  }
  return { ops: kept, changed };
}

/**
 * Object numbers of every XObject some content of the document still draws: page content, annotation
 * appearances, and the forms, tiling patterns, soft-mask groups and Type 3 glyphs they use in turn.
 */
function drawnObjects(doc: PdfDocument): Set<number> {
  const drawn = new Set<number>();
  // A stream is scanned once per resources dictionary it resolves names in.
  const seen = new Map<PdfStream, Set<Dict | null>>();
  const seenRes = new Set<Dict>();
  const once = (s: PdfStream, res: Dict | null): boolean => { let set = seen.get(s); if (!set) { set = new Set(); seen.set(s, set); } if (set.has(res)) return false; set.add(res); return true; };
  const scanStream = (s: PdfObj | undefined, inherited: Dict | null, depth: number) => {
    if (!(s instanceof PdfStream) || depth > 16) return;
    const res = doc.getDict(s, 'Resources') || inherited;
    if (!once(s, res)) return;
    try { scan(doc.decoded(s), res, depth); } catch { /* damaged stream */ }
  };
  const scanResources = (res: Dict, depth: number) => {
    if (seenRes.has(res) || depth > 16) return;
    seenRes.add(res);
    const pat = doc.getDict(res, 'Pattern');
    if (pat) for (const k of pat.keys()) scanStream(doc.get<PdfObj>(pat, k), res, depth + 1);
    const eg = doc.getDict(res, 'ExtGState');
    if (eg) for (const k of eg.keys()) { const sm = doc.getDict(doc.getDict(eg, k), 'SMask'); if (sm) scanStream(doc.get<PdfObj>(sm, 'G'), res, depth + 1); }
    const fonts = doc.getDict(res, 'Font');
    if (fonts) for (const k of fonts.keys()) {
      const f = doc.getDict(fonts, k);
      if (!f || doc.getName(f, 'Subtype') !== 'Type3') continue;
      const cp = doc.getDict(f, 'CharProcs'), fr = doc.getDict(f, 'Resources') || res;
      if (cp) for (const g of cp.keys()) { const s = doc.get<PdfObj>(cp, g); if (s instanceof PdfStream && once(s, fr)) { try { scan(doc.decoded(s), fr, depth + 1); } catch { /* damaged glyph */ } } }
    }
  };
  const scan = (data: Uint8Array, res: Dict | null, depth: number) => {
    if (res) scanResources(res, depth);
    const xo = res ? doc.getDict(res, 'XObject') : null;
    if (!xo) return;
    let ops: Op[];
    try { ops = parseContent(data); } catch { return; }
    for (const o of ops) {
      if (o.op !== 'Do' || !isName(o.args[0])) continue;
      const v = xo.get(o.args[0].name);
      if (v instanceof Ref) drawn.add(v.num);
      const x = doc.resolve<PdfObj>(v);
      if (x instanceof PdfStream && doc.getName(x, 'Subtype') === 'Form') scanStream(x, res, depth + 1);
    }
  };
  for (const p of doc.pages) {
    try { scan(doc.pageContent(p), p.resources, 0); } catch { /* unreadable page */ }
    for (const a of doc.getArray(p.dict, 'Annots') || []) {
      const ap = doc.getDict(doc.resolve<Dict | null>(a), 'AP');
      if (!ap) continue;
      for (const k of ap.keys()) { const v = doc.get<PdfObj>(ap, k); if (v instanceof Dict) { for (const st of v.keys()) scanStream(doc.get<PdfObj>(v, st), p.resources, 1); } else scanStream(v, p.resources, 1); }
    }
  }
  return drawn;
}

/**
 * After redaction, once the pages' new content is stored. An XObject that was taken out of a
 * rewritten page or form may still be listed in resource dictionaries elsewhere (shared resources,
 * the resources of other forms). When no content of the document draws it any more, the object
 * itself is replaced by an empty stand-in, so its data is gone wherever it is still listed.
 */
export function pruneUndrawn(doc: PdfDocument, dropped: Set<number>): void {
  if (!dropped.size) return;
  doc.invalidatePages();
  const drawn = drawnObjects(doc);
  for (const n of dropped) {
    if (drawn.has(n)) continue;
    const ref = new Ref(n, doc.genOf(n));
    const o = doc.fetch(ref);
    if (!(o instanceof PdfStream)) continue;
    const image = doc.getName(o, 'Subtype') === 'Image';
    doc.update(ref, image
      ? flateStream(new Uint8Array([255]), { Type: Name.get('XObject'), Subtype: Name.get('Image'), Width: 1, Height: 1, BitsPerComponent: 8, ColorSpace: Name.get('DeviceGray') })
      : flateStream(new Uint8Array(0), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, 1, 1] }));
  }
}

function pageOwn(doc: PdfDocument, p: PageInfo): Own {
  const subs = new Map<string, Dict>();
  return (kind) => {
    let d = subs.get(kind);
    if (!d) { const res = ownResources(doc, p); const cur = doc.getDict(res, kind); d = cur ? cur.clone() : new Dict(); res.set(kind, d); subs.set(kind, d); }
    return d;
  };
}

/**
 * Removes what the hidden layers (optional content groups in `hidden`, by object number) hold from one
 * page: text, images, painted paths and XObjects inside their marked content or carrying their /OC
 * entry, also inside Form XObjects. Graphics-state operators stay, as the standard asks. Returns
 * whether the page changed; `dropped` collects XObjects for pruneUndrawn.
 */
export function removeHiddenContent(doc: PdfDocument, p: PageInfo, hidden: Set<number>, dropped: Set<number>): boolean {
  const r = redactOps({ doc, rects: [], stats: { text: 0, images: 0, paths: 0, forms: 0 }, dropped, hidden, work: redactWork() }, parseContent(doc.pageContent(p)), p.resources, IDENTITY, 0, pageOwn(doc, p));
  if (r.changed) doc.setPageContent(p, serializeContent(r.ops));
  return r.changed;
}

/** For callers that test a /OC entry (annotations): hidden under the given set of hidden groups? */
export function membershipHidden(doc: PdfDocument, oc: PdfObj | undefined, hidden: Set<number>): boolean {
  return ocHidden({ doc, rects: [], stats: { text: 0, images: 0, paths: 0, forms: 0 }, dropped: new Set(), hidden }, oc);
}

/**
 * Removes everything under `rects` (user space) from the content of one page. Returns the rewritten
 * operators, isolated in q…Q so the caller can append drawing in clean user space, and the object
 * numbers of XObjects the page stopped drawing (for pruneUndrawn).
 */
export function redactPageContent(doc: PdfDocument, p: PageInfo, rects: Rect[], stats: RedactStats, dropped: Set<number>, work: RedactWork = redactWork()): Op[] {
  const r = redactOps({ doc, rects, stats, dropped, work }, parseContent(doc.pageContent(p)), p.resources, IDENTITY, 0, pageOwn(doc, p));
  // The embedded thumbnail still shows the page as it was.
  if (p.dict.has('Thumb')) { p.dict.delete('Thumb'); if (p.ref) doc.touch(p.ref); }
  return [{ op: 'q', args: [] }, ...r.ops, { op: 'Q', args: [] }];
}

/**
 * Blanks the given text-showing operators of a content stream. The result has the same length and
 * order as `ops`: Tj/TJ become a displacement of the same advance, so the text that follows stays
 * where it was; ' and " keep their line move.
 */
export function blankText(doc: PdfDocument, ops: Op[], resources: Dict | null, targets: Set<Op>): Op[] {
  if (!targets.size) return ops;
  const noXo: Own = () => new Dict();
  return redactOps({ doc, rects: [], stats: { text: 0, images: 0, paths: 0, forms: 0 }, dropped: new Set(), force: targets }, ops, resources, IDENTITY, 0, noXo).ops;
}
