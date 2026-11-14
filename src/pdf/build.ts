/**
 * Building PDF content from scratch: standard-font text pages (Create PDF from text/Markdown, OCR
 * layers, headers and footers, Bates numbers, stamps) and image pages. Everything here writes plain
 * ISO 32000 objects into a PdfDocument.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref } from './objects';
import { flateStream } from './filters';
import { PdfDocument, PageInfo } from './document';
import { stdWidths, textWidth, winAnsiBytes, wrapText, type StdFont } from './stdfonts';
import { fmtNum } from './writer';

export const PAPER: Record<string, [number, number]> = { letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224], a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28], b5: [498.9, 708.66] };

/** Adds a standard-14 font to a document (once per name) and returns its reference. */
export function stdFontRef(doc: PdfDocument, font: StdFont | string): Ref {
  const key = `__font_${font}`;
  const d = doc as any;
  // The remembered reference is used only while it still names this font: after an undo the object is
  // gone and its number may have been given to something else.
  if (d[key] instanceof Ref) { const o = doc.resolve<PdfObj>(d[key]); if (o instanceof Dict && doc.getName(o, 'Type') === 'Font' && doc.getName(o, 'BaseFont') === font) return d[key]; }
  const f = new Dict({ Type: Name.get('Font'), Subtype: Name.get('Type1'), BaseFont: Name.get(font) });
  if (!/Symbol|Dingbats/.test(font)) f.set('Encoding', Name.get('WinAnsiEncoding'));
  const ref = doc.register(f);
  d[key] = ref;
  return ref;
}

/** Makes a font resource name available on a page; returns the resource name to use in content. */
export function ensureFont(doc: PdfDocument, page: PageInfo, font: StdFont | string): string {
  const res = doc.pageResources(page);
  let fonts = doc.getDict(res, 'Font');
  if (!fonts) { fonts = new Dict(); res.set('Font', fonts); }
  else if (!(res.get('Font') instanceof Dict)) { fonts = fonts.clone(); res.set('Font', fonts); }
  const name = 'QF' + font.replace(/[^A-Za-z]/g, '');
  if (!fonts.has(name)) fonts.set(name, stdFontRef(doc, font));
  if (page.ref) doc.touch(page.ref);
  return name;
}

export function ensureXObject(doc: PdfDocument, page: PageInfo, prefix: string, obj: Ref): string {
  const res = doc.pageResources(page);
  let xo = doc.getDict(res, 'XObject');
  if (!xo) { xo = new Dict(); res.set('XObject', xo); }
  else if (!(res.get('XObject') instanceof Dict)) { xo = xo.clone(); res.set('XObject', xo); }
  let i = 1;
  while (xo.has(`${prefix}${i}`)) i++;
  const name = `${prefix}${i}`;
  xo.set(name, obj);
  if (page.ref) doc.touch(page.ref);
  return name;
}

export function ensureExtGState(doc: PdfDocument, page: PageInfo, gs: Dict): string {
  const res = doc.pageResources(page);
  let eg = doc.getDict(res, 'ExtGState');
  if (!eg) { eg = new Dict(); res.set('ExtGState', eg); }
  else if (!(res.get('ExtGState') instanceof Dict)) { eg = eg.clone(); res.set('ExtGState', eg); }
  let i = 1;
  while (eg.has(`QFGS${i}`)) i++;
  eg.set(`QFGS${i}`, doc.register(gs));
  if (page.ref) doc.touch(page.ref);
  return `QFGS${i}`;
}

/** Escapes bytes for a literal string in a content stream. */
export function lit(bytes: Uint8Array): string {
  let out = '(';
  for (const c of bytes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}
export const litText = (s: string): string => lit(winAnsiBytes(s));

/** Appends a new blank page (optionally at an index) and returns its PageInfo. */
export function addBlankPage(doc: PdfDocument, size: [number, number] = PAPER.letter, at?: number): PageInfo {
  const pagesRef = doc.pagesRootRef || doc.register(new Dict({ Type: Name.get('Pages'), Kids: [], Count: 0 }));
  if (!doc.pagesRootRef) { doc.catalog.set('Pages', pagesRef); doc.update(doc.catalogRef, doc.catalog); }
  const root = doc.resolve<Dict>(pagesRef);
  // `at` is a page index. The page tree may be nested, so the new page goes before the page that is at
  // that index now, in that page's own parent node; with no such page it is added at the end of the root.
  const target = at != null ? doc.pages[Math.max(0, at)] : undefined;
  let parentRef = pagesRef, parent = root, idx = -1;
  if (target?.ref) {
    const pr = target.dict.get('Parent');
    const pd = pr instanceof Ref ? doc.resolve<PdfObj>(pr) : null;
    const i = pd instanceof Dict ? (doc.getArray(pd, 'Kids') || []).findIndex((k) => k instanceof Ref && k.num === target.ref!.num) : -1;
    if (pr instanceof Ref && pd instanceof Dict && i >= 0) { parentRef = pr; parent = pd; idx = i; }
    else idx = (doc.getArray(root, 'Kids') || []).findIndex((k) => k instanceof Ref && k.num === target.ref!.num);
  }
  const page = new Dict({ Type: Name.get('Page'), Parent: parentRef, MediaBox: [0, 0, size[0], size[1]], Resources: new Dict() });
  const ref = doc.register(page);
  const kids = (doc.getArray(parent, 'Kids') || []).slice();
  if (idx >= 0) kids.splice(idx, 0, ref); else kids.push(ref);
  parent.set('Kids', kids);
  // One more page in this node and in every node above it. A blank page must not pick up a rotation or a
  // crop box that those nodes hand down.
  const seen = new Set<number>();
  let nodeRef: PdfObj | undefined = parentRef, node: Dict | null = parent;
  while (node && nodeRef instanceof Ref && !seen.has(nodeRef.num)) {
    seen.add(nodeRef.num);
    if (node.has('Rotate') && !page.has('Rotate')) page.set('Rotate', 0);
    if (node.has('CropBox') && !page.has('CropBox')) page.set('CropBox', [0, 0, size[0], size[1]]);
    node.set('Count', doc.getNum(node, 'Count') + 1);
    doc.update(nodeRef, node);
    nodeRef = node.get('Parent');
    const up: PdfObj = nodeRef instanceof Ref ? doc.resolve<PdfObj>(nodeRef) : null;
    node = up instanceof Dict ? up : null;
  }
  doc.invalidatePages();
  return doc.pages.find((p) => p.ref?.num === ref.num)!;
}

export interface TextPageOptions { font?: StdFont; size?: number; margin?: number; paper?: [number, number]; leading?: number; title?: string }

/** Lays text out across as many pages as needed (simple Markdown: # headings, blank-line paragraphs, - bullets). */
export function addTextPages(doc: PdfDocument, text: string, o: TextPageOptions = {}): PageInfo[] {
  const paper = o.paper || PAPER.letter, margin = o.margin ?? 72, size = o.size ?? 11, leading = o.leading ?? size * 1.4;
  const width = paper[0] - margin * 2;
  const pages: PageInfo[] = [];
  let ops: string[] = [];
  let y = 0;
  let page: PageInfo | null = null;
  const fontNames = new Map<string, string>();
  const newPage = () => { page = addBlankPage(doc, paper); pages.push(page); y = paper[1] - margin; ops = []; fontNames.clear(); };
  const flush = () => { if (page && ops.length) doc.setPageContent(page, new TextEncoder().encode(ops.join('\n'))); };
  const fontName = (f: string) => { let n = fontNames.get(f); if (!n) { n = ensureFont(doc, page!, f); fontNames.set(f, n); } return n; };
  newPage();
  const lines: { text: string; font: StdFont; size: number; indent: number; gapBefore: number }[] = [];
  const base = o.font || 'Helvetica';
  const bold = (base.startsWith('Times') ? 'Times-Bold' : base.startsWith('Courier') ? 'Courier-Bold' : 'Helvetica-Bold') as StdFont;
  const paras = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const para of paras) {
    for (const raw of para.split('\n')) {
      const h = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (h) { const lvl = h[1].length; const sz = Math.max(size + 2, size * (2.2 - lvl * 0.25)); for (const l of wrapText(h[2], bold, sz, width)) lines.push({ text: l, font: bold, size: sz, indent: 0, gapBefore: lines.length ? sz * 0.6 : 0 }); continue; }
      const b = /^\s*[-*•]\s+(.*)$/.exec(raw);
      if (b) { const ls = wrapText(b[1], base, size, width - 18); ls.forEach((l, i) => lines.push({ text: (i ? '' : '•  ') + l, font: base, size, indent: i ? 18 : 6, gapBefore: 0 })); continue; }
      const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(raw);
      if (n) { const ls = wrapText(n[2], base, size, width - 22); ls.forEach((l, i) => lines.push({ text: (i ? '' : `${n[1]}. `) + l, font: base, size, indent: i ? 22 : 4, gapBefore: 0 })); continue; }
      for (const l of wrapText(raw, base, size, width)) lines.push({ text: l, font: base, size, indent: 0, gapBefore: 0 });
    }
    lines.push({ text: '', font: base, size, indent: 0, gapBefore: 0 });
  }
  for (const l of lines) {
    const lh = Math.max(leading, l.size * 1.3) + l.gapBefore;
    if (y - lh < margin) { flush(); newPage(); }
    y -= lh;
    if (!l.text) continue;
    ops.push(`BT /${fontName(l.font)} ${fmtNum(l.size)} Tf ${fmtNum(margin + l.indent)} ${fmtNum(y)} Td ${litText(l.text)} Tj ET`);
  }
  flush();
  if (o.title) { doc.ensureInfo().set('Title', PdfString.fromText(o.title)); }
  return pages;
}

/** A complete PDF with one text page per string (used by tests and templates). */
export function makeTextPdf(pages: string[], o: TextPageOptions = {}): Uint8Array {
  const doc = PdfDocument.create();
  for (const t of pages) addTextPage(doc, t, o);
  return doc.save({ incremental: false });
}

export function addTextPage(doc: PdfDocument, text: string, o: TextPageOptions = {}): PageInfo {
  const paper = o.paper || PAPER.letter;
  const page = addBlankPage(doc, paper);
  const f = ensureFont(doc, page, o.font || 'Helvetica');
  const size = o.size ?? 12, margin = o.margin ?? 72;
  const lines = wrapText(text, o.font || 'Helvetica', size, paper[0] - margin * 2);
  const ops = lines.map((l, i) => `BT /${f} ${fmtNum(size)} Tf ${fmtNum(margin)} ${fmtNum(paper[1] - margin - i * size * 1.4)} Td ${litText(l)} Tj ET`);
  doc.setPageContent(page, new TextEncoder().encode(ops.join('\n')));
  return page;
}

export type ImageSpec = { kind: 'jpeg'; data: Uint8Array; width: number; height: number; gray?: boolean; cmyk?: boolean } | { kind: 'rgb'; data: Uint8Array; width: number; height: number; alpha?: Uint8Array } | { kind: 'gray'; data: Uint8Array; width: number; height: number };

/** Creates an image XObject. */
export function imageXObject(doc: PdfDocument, img: ImageSpec): Ref {
  if (img.kind === 'jpeg') {
    const s = new PdfStream(new Dict({ Type: Name.get('XObject'), Subtype: Name.get('Image'), Width: img.width, Height: img.height, ColorSpace: Name.get(img.cmyk ? 'DeviceCMYK' : img.gray ? 'DeviceGray' : 'DeviceRGB'), BitsPerComponent: 8, Filter: Name.get('DCTDecode'), Length: img.data.length }), img.data);
    if (img.cmyk) s.dict.set('Decode', [1, 0, 1, 0, 1, 0, 1, 0]);
    return doc.register(s);
  }
  const s = flateStream(img.data, { Type: Name.get('XObject'), Subtype: Name.get('Image'), Width: img.width, Height: img.height, ColorSpace: Name.get(img.kind === 'rgb' ? 'DeviceRGB' : 'DeviceGray'), BitsPerComponent: 8 });
  if (img.kind === 'rgb' && img.alpha) {
    const sm = flateStream(img.alpha, { Type: Name.get('XObject'), Subtype: Name.get('Image'), Width: img.width, Height: img.height, ColorSpace: Name.get('DeviceGray'), BitsPerComponent: 8 });
    s.dict.set('SMask', doc.register(sm));
  }
  return doc.register(s);
}

/** Dimensions of a JPEG from its SOF marker (null when not a JPEG). */
export function jpegInfo(b: Uint8Array): { width: number; height: number; components: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], components: b[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

/** Adds a page the size of the image (or fits the image on `paper`) and draws it. */
export function addImagePage(doc: PdfDocument, img: ImageSpec, opts: { paper?: [number, number] | 'image'; dpi?: number; at?: number } = {}): PageInfo {
  const dpi = opts.dpi || 96;
  const iw = (img.width / dpi) * 72, ih = (img.height / dpi) * 72;
  const paper: [number, number] = !opts.paper || opts.paper === 'image' ? [iw, ih] : opts.paper;
  const page = addBlankPage(doc, paper, opts.at);
  const x = imageXObject(doc, img);
  const name = ensureXObject(doc, page, 'Im', x);
  const scale = Math.min(paper[0] / iw, paper[1] / ih, 1);
  const w = iw * scale, h = ih * scale;
  const ox = (paper[0] - w) / 2, oy = (paper[1] - h) / 2;
  doc.setPageContent(page, new TextEncoder().encode(`q ${fmtNum(w)} 0 0 ${fmtNum(h)} ${fmtNum(ox)} ${fmtNum(oy)} cm /${name} Do Q`));
  return page;
}

export { textWidth, stdWidths };
export type { PdfObj };
