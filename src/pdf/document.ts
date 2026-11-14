/**
 * PdfDocument: the lossless object graph of one PDF file, with lazy object loading, decryption,
 * the page tree, and an overlay of changed objects that save() writes as an incremental update or
 * a full rewrite. Nothing is lost on a round trip: objects the app does not understand are kept.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, dictOf, isName, latin1, nameText, pdfDate } from './objects';
import { Lexer, Parser } from './lexer';
import { decodeStream, DecodeResult, flateStream } from './filters';
import { parseXref, scanObjects, addObjectStream, finishScan, scanObjectHeaders, ObjectHeader, XrefEntry, XrefResult } from './xref';
import { PasswordNeeded, SecurityHandler, SecurityInfo } from './crypt';
import { writeFull, writeIncremental, SaveOptions } from './writer';

export interface PageInfo {
  index: number;
  ref: Ref | null;
  dict: Dict;
  mediaBox: [number, number, number, number];
  cropBox: [number, number, number, number];
  rotate: number;
  resources: Dict | null;
  /** Width and height in points after rotation. */
  width: number;
  height: number;
}

export interface LoadOptions { password?: string; /** Skip the normal xref and rebuild from a scan. */ repair?: boolean; onWarning?: (w: string) => void }

export interface LoadReport { reconstructed: boolean; warnings: string[]; header: string; encrypted: boolean; pagesSynthesized: boolean }

const RECT_DEFAULT: [number, number, number, number] = [0, 0, 612, 792];

export class PdfDocument {
  buf: Uint8Array;
  xref: Map<number, XrefEntry> = new Map();
  trailer = new Dict();
  usesXrefStream = false;
  startxref = -1;
  security: SecurityHandler | null = null;
  report: LoadReport = { reconstructed: false, warnings: [], header: '', encrypted: false, pagesSynthesized: false };
  /** Parsed objects, by object number. */
  private cache = new Map<number, PdfObj>();
  /** Objects created or replaced since loading (null = deleted). */
  changed = new Map<number, PdfObj | null>();
  private gens = new Map<number, number>();
  private nextNum = 1;
  private pageCache: PageInfo[] | null = null;
  private objStmCache = new Map<number, Map<number, PdfObj>>();
  private reconstructed = false;
  /** Objects being parsed right now (a stream whose /Length leads back to itself must not recurse). */
  private loading = new Set<number>();
  /** Where each "n g obj" really is, built on the first object the cross-reference table misplaces. */
  private huntIndex: Map<number, ObjectHeader> | null = null;
  /** Objects the file's newest revision lists as free, with their generation numbers: an incremental update keeps them in its free list. */
  prevFree = new Map<number, number>();
  /** Set when the document was modified in memory. save() leaves it alone; whoever stores the bytes resets it. */
  dirty = false;
  password = '';

  private constructor(buf: Uint8Array) { this.buf = buf; }

  // ------------------------------------------------------------------------------------------
  // Loading

  static load(bytes: Uint8Array | ArrayBuffer, opts: LoadOptions = {}): PdfDocument {
    let buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const warn = (w: string) => { doc.report.warnings.push(w); opts.onWarning?.(w); };
    // The header may be preceded by junk; offsets count from "%PDF".
    const h = Lexer.find(buf, '%PDF-', 0, Math.min(buf.length, 4096));
    if (h > 0) { buf = buf.subarray(h); }
    const doc = new PdfDocument(buf);
    if (h < 0) { doc.report.header = ''; warn('The file has no %PDF header.'); }
    else doc.report.header = latin1(buf, 0, 8).trim();
    let xr: XrefResult | null = null;
    if (!opts.repair) {
      try { xr = parseXref(buf, (o) => doc.resolve(o)); for (const w of xr.warnings) warn(w); }
      catch (e: any) { warn(`Cross-reference table unusable: ${e?.message || e}`); }
    }
    const password = opts.password || '';
    if (xr) { doc.xref = xr.entries; doc.trailer = xr.trailer; doc.usesXrefStream = xr.usesXrefStream; doc.startxref = xr.startxref; doc.prevFree = xr.free; }
    if (!xr || !doc.validate()) doc.reconstruct(warn, password);
    else doc.setupSecurity(password);
    // Make sure the catalog and page tree resolve; otherwise rebuild.
    try {
      const cat = doc.catalog;
      if (!cat.has('Pages') && !cat.has('Type')) throw new Error('no catalog');
      doc.pages; // forces the walk
    } catch {
      if (!doc.reconstructed) doc.reconstruct(warn, password);
    }
    // Never hand back a document whose catalog cannot be read: every later access would throw.
    try { doc.catalog; } catch { throw new Error('This file has no readable document catalog, even after scanning it for objects, so there is nothing to open.'); }
    doc.pageCache = null;
    doc.nextNum = Math.max(doc.nextNum, doc.sizeFromXref(), 1);
    if (doc.reconstructed) { try { doc.tidyRebuilt(warn); } catch { /* best effort: the document opens as it is */ } }
    // A direct catalog becomes an object of its own now, so that catalogRef is the same from the start and
    // a saved file's trailer names it by reference. That is no edit of the user's, so the document stays clean.
    if (doc.trailer.get('Root') instanceof Dict) { void doc.catalogRef; doc.dirty = false; }
    doc.password = password;
    return doc;
  }

  /**
   * After a rebuild, lists that name other objects can point at objects the damage destroyed (they read as
   * null) or at salvaged fragments that are not what the list needs. Readers warn about such entries and
   * some refuse the file, so the page /Annots arrays and the form's /Fields tree (with /Kids) keep only
   * entries that resolve to an annotation or a field. Recorded as a load warning; not counted as an edit.
   */
  private tidyRebuilt(warn: (w: string) => void): void {
    const wasDirty = this.dirty;
    let dropped = 0;
    const put = (owner: Dict, ownerRef: Ref | null, key: string, kept: PdfObj[]): void => {
      const v = owner.get(key);
      if (v instanceof Ref) this.update(v, kept);
      else { owner.set(key, kept); if (ownerRef) this.update(ownerRef, owner); }
    };
    const pages = this.pages;
    for (const p of pages) {
      const list = this.getArray(p.dict, 'Annots');
      if (!list) continue;
      const kept = list.filter((x) => { const d = dictOf(this.resolve(x)); return !!d && d.has('Subtype'); });
      if (kept.length !== list.length) { dropped += list.length - kept.length; put(p.dict, p.ref, 'Annots', kept); }
    }
    const isField = (d: Dict) => d.has('FT') || d.has('T') || d.has('Kids') || isName(d.get('Subtype'), 'Widget');
    const seen = new Set<number>();
    const prune = (owner: Dict, ownerRef: Ref | null, key: string, depth: number): void => {
      const list = this.getArray(owner, key);
      if (!list || depth > 32) return;
      const kept: PdfObj[] = [];
      for (const x of list) {
        if (x instanceof Ref) { if (seen.has(x.num)) continue; seen.add(x.num); }
        const d = dictOf(this.resolve(x));
        if (!d || !isField(d)) { dropped++; continue; }
        kept.push(x);
        if (d.has('Kids')) prune(d, x instanceof Ref ? x : null, 'Kids', depth + 1);
      }
      if (kept.length !== list.length) put(owner, ownerRef, key, kept);
    };
    const afv = this.catalog.get('AcroForm');
    const af = dictOf(this.resolve(afv));
    if (af) prune(af, afv instanceof Ref ? afv : this.catalogRef, 'Fields', 0);
    this.pageCache = null;
    this.dirty = wasDirty;
    if (dropped) warn(`${dropped} reference(s) to annotations or form fields that the damage destroyed were removed.`);
  }

  /** One more than the highest object number in the trailer's /Size and the cross-reference table. */
  private sizeFromXref(): number {
    const size = this.trailer.get('Size');
    let n = typeof size === 'number' && isFinite(size) ? size : 0;
    for (const k of this.xref.keys()) if (k >= n) n = k + 1;
    return n;
  }

  /** A new, empty document with one catalog and an empty page tree. */
  static create(): PdfDocument {
    const doc = new PdfDocument(new Uint8Array(0));
    doc.report.header = '%PDF-1.7';
    const pages = doc.register(new Dict({ Type: Name.get('Pages'), Kids: [], Count: 0 }));
    const cat = doc.register(new Dict({ Type: Name.get('Catalog'), Pages: pages }));
    const info = doc.register(new Dict({ Producer: PdfString.fromText('Anne\'s Folio'), Creator: PdfString.fromText('Anne\'s Folio'), CreationDate: pdfDate(), ModDate: pdfDate() }));
    doc.trailer = new Dict({ Root: cat, Info: info, Size: doc.nextNum });
    doc.dirty = true;
    return doc;
  }

  /** Checks that a sample of xref offsets point at the objects they claim (cheap sanity check). */
  private validate(): boolean {
    const root = this.trailer.get('Root');
    // A catalog written directly in the trailer is not allowed, but nothing about it needs a rebuild.
    if (!(root instanceof Ref) && !(root instanceof Dict)) return false;
    const probe = (n: number): boolean => {
      const e = this.xref.get(n);
      if (!e) return false;
      if (e.type === 2) return this.xref.has(e.offset);
      if (e.offset < 0 || e.offset >= this.buf.length) return false;
      const lex = new Lexer(this.buf, e.offset);
      const a = lex.next(), b = lex.next(), c = lex.next();
      return a.t === 'num' && a.v === n && b.t === 'num' && c.t === 'kw' && c.v === 'obj';
    };
    if (root instanceof Ref && !probe(root.num)) return false;
    const nums = [...this.xref.keys()];
    const step = Math.max(1, Math.floor(nums.length / 12));
    for (let i = 0; i < nums.length; i += step) if (!probe(nums[i])) return false;
    return true;
  }

  /**
   * Rebuilds the cross-reference table by scanning the file, and sets the security handler up on the
   * way: an encrypted file's object streams (where its catalog and pages usually are) can only be
   * listed once they can be decrypted.
   */
  private reconstruct(warn: (w: string) => void, password: string): void {
    this.reconstructed = true;
    this.report.reconstructed = true;
    const scan = scanObjects(this.buf, (o) => this.resolve(o));
    this.cache.clear(); this.objStmCache.clear(); this.pageCache = null; this.huntIndex = null;
    this.xref = scan.entries;
    this.startxref = -1;
    this.prevFree = new Map();
    const oldTrailer = this.trailer;
    this.trailer = scan.trailer;
    // Keep ID/Info/Encrypt from the original trailer if the scan did not find them.
    for (const k of ['ID', 'Info', 'Encrypt']) if (!this.trailer.has(k) && oldTrailer.has(k)) this.trailer.set(k, oldTrailer.get(k)!);
    this.security = null;
    this.setupSecurity(password);
    for (const sn of scan.objStreams) {
      try {
        const s = this.fetch(new Ref(sn, scan.entries.get(sn)!.gen));
        if (s instanceof PdfStream) addObjectStream(scan, sn, this.decoded(s), this.getNum(s, 'N'), this.getNum(s, 'First'));
      } catch { /* damaged object stream */ }
    }
    // Listing the streams moved objects into them: nothing fetched under the earlier table may be kept.
    this.cache.clear(); this.objStmCache.clear();
    const r = finishScan(scan, (n, what) => {
      const d = dictOf(this.fetch(new Ref(n, scan.entries.get(n)?.gen ?? 0)));
      return !!d && (what === 'pages' || d.has('Pages') || isName(d.get('Type'), 'Catalog'));
    });
    for (const w of r.warnings) warn(w);
    this.usesXrefStream = r.usesXrefStream;
    // Before anything is registered: new objects must not take the numbers of objects in the file.
    this.nextNum = Math.max(this.nextNum, this.sizeFromXref());
    if (r.catalogSynthesized) {
      const pagesRoot = r.pagesRoot;
      let pagesRef: Ref | null = pagesRoot != null && this.xref.has(pagesRoot) ? new Ref(pagesRoot, this.xref.get(pagesRoot)!.gen) : null;
      const catalog = new Dict({ Type: Name.get('Catalog') });
      this.trailer.set('Root', this.register(catalog));
      // A page tree root that leads to no page at all (its kids are damaged) is no better than none.
      if (pagesRef) { catalog.set('Pages', pagesRef); this.pageCache = null; if (!this.pages.length) pagesRef = null; this.pageCache = null; }
      if (!pagesRef) {
        // Collect every /Type /Page object in file order into a new Pages node.
        const kids: Ref[] = [];
        // An object inside an object stream sorts at the stream's place in the file, then by its index there.
        const where = (e: XrefEntry): number => (e.type === 2 ? (this.xref.get(e.offset)?.offset ?? 0) + ((e.idx || 0) + 1) / 1e6 : e.offset);
        const ordered = [...this.xref.entries()].sort((a, b) => where(a[1]) - where(b[1]));
        for (const [n, e] of ordered) {
          try { const o = this.fetch(new Ref(n, e.gen)); if (o instanceof Dict && isName(o.get('Type'), 'Page')) kids.push(new Ref(n, e.gen)); } catch { /* */ }
        }
        pagesRef = this.register(new Dict({ Type: Name.get('Pages'), Kids: kids, Count: kids.length }));
        for (const k of kids) { const d = this.fetch(k); if (d instanceof Dict) { d.set('Parent', pagesRef); this.update(k, d); } }
        this.report.pagesSynthesized = true;
        warn(`${kids.length} page object(s) were collected by scanning the file.`);
      }
      catalog.set('Pages', pagesRef);
    }
    this.nextNum = Math.max(this.nextNum, this.sizeFromXref());
  }

  private setupSecurity(password: string): void {
    const enc = this.trailer.get('Encrypt');
    if (!enc) { this.security = null; return; }
    const encDict = dictOf(this.resolveRaw(enc));
    if (!encDict) { this.security = null; this.report.warnings.push('The /Encrypt dictionary could not be read; the file is treated as unencrypted.'); return; }
    this.report.encrypted = true;
    const ids = this.resolveRaw(this.trailer.get('ID'));
    const id0 = Array.isArray(ids) && ids[0] instanceof PdfString ? ids[0].bytes : new Uint8Array(0);
    const sh = new SecurityHandler(encDict, id0, (o) => this.resolveRaw(o));
    if (!sh.authenticate(password, (o) => this.resolveRaw(o))) {
      if (!password) throw new PasswordNeeded();
      throw new PasswordNeeded('The password is incorrect.');
    }
    this.security = sh;
    this.encryptRef = enc instanceof Ref ? enc : null;
    this.cache.clear(); this.objStmCache.clear();
  }
  private encryptRef: Ref | null = null;

  get securityInfo(): SecurityInfo | null { return this.security?.info || null; }

  // ------------------------------------------------------------------------------------------
  // Object access

  /** Resolves references (repeatedly) to a direct object; null when missing. */
  resolve<T = PdfObj>(o: PdfObj | undefined): T {
    let v: PdfObj = o ?? null;
    for (let i = 0; i < 32 && v instanceof Ref; i++) v = this.fetch(v);
    return v as unknown as T;
  }
  /** resolve() without decryption-dependent caching assumptions (used while setting security up). */
  private resolveRaw(o: PdfObj | undefined): PdfObj { return this.resolve(o); }

  /** Dictionary entry, resolved. */
  get<T = PdfObj>(d: Dict | PdfStream | null | undefined, key: string): T { const dd = dictOf(d ?? null); return this.resolve<T>(dd ? dd.get(key) : undefined); }
  getDict(d: Dict | PdfStream | null | undefined, key: string): Dict | null { return dictOf(this.get(d, key)); }
  getArray(d: Dict | PdfStream | null | undefined, key: string): PdfObj[] | null { const v = this.get(d, key); return Array.isArray(v) ? v : null; }
  getNum(d: Dict | PdfStream | null | undefined, key: string, def = 0): number { const v = this.get(d, key); return typeof v === 'number' ? v : def; }
  getName(d: Dict | PdfStream | null | undefined, key: string): string { const v = this.get(d, key); return isName(v) ? v.name : ''; }
  /** A text string's text, or a name as text (names are stored as bytes; UTF-8 is decoded for display). */
  getText(d: Dict | PdfStream | null | undefined, key: string): string { const v = this.get(d, key); return v instanceof PdfString ? v.toText() : isName(v) ? nameText(v.name) : ''; }

  fetch(ref: Ref): PdfObj {
    if (this.changed.has(ref.num)) return this.changed.get(ref.num) ?? null;
    if (this.cache.has(ref.num)) return this.cache.get(ref.num)!;
    // Asked for while it is being parsed (a stream's /Length that points back at the stream): no answer,
    // and nothing cached, so the parse in progress falls back to searching for "endstream" once.
    if (this.loading.has(ref.num)) return null;
    const e = this.xref.get(ref.num);
    let obj: PdfObj = null;
    if (e) {
      this.loading.add(ref.num);
      try {
        obj = e.type === 2 ? this.fromObjStm(e.offset, ref.num) : this.parseAt(e.offset, ref.num);
        if (obj === undefined) obj = null;
        if (e.type === 1 && this.security && !(this.encryptRef && this.encryptRef.num === ref.num)) obj = this.security.decryptObject(obj, new Ref(ref.num, e.gen));
      } catch { obj = null; }
      finally { this.loading.delete(ref.num); }
    }
    this.cache.set(ref.num, obj);
    return obj;
  }

  private parseAt(offset: number, num: number): PdfObj {
    if (offset < 0 || offset >= this.buf.length) return this.hunt(num);
    const p = new Parser(this.buf, offset, (o) => this.resolve(o));
    const r = p.parseIndirect();
    if (!r || r.num !== num) return this.hunt(num);
    return r.obj;
  }

  /** The xref entry was wrong: look for "num gen obj" anywhere (and remember to rebuild later). */
  private hunt(num: number): PdfObj {
    // One scan of the file serves every misplaced object (the last definition of a number wins).
    if (!this.huntIndex) { this.huntIndex = new Map(); for (const h of scanObjectHeaders(this.buf)) this.huntIndex.set(h.num, h); }
    const h = this.huntIndex.get(num);
    if (!h) return null;
    this.xref.set(num, { offset: h.offset, gen: h.gen, type: 1 });
    this.report.warnings.push(`Object ${num} was not where the cross-reference table said; it was found by searching.`);
    const r = new Parser(this.buf, h.offset, (o) => this.resolve(o)).parseIndirect();
    return r?.obj ?? null;
  }

  private fromObjStm(stmNum: number, wantNum: number): PdfObj {
    let table = this.objStmCache.get(stmNum);
    if (!table) {
      table = new Map();
      this.objStmCache.set(stmNum, table);
      const s = this.fetch(new Ref(stmNum, 0));
      if (s instanceof PdfStream) {
        const data = this.decoded(s);
        const n = this.getNum(s, 'N'), first = this.getNum(s, 'First');
        const lex = new Lexer(data, 0);
        const offsets: [number, number][] = [];
        for (let i = 0; i < n; i++) { const a = lex.next(), b = lex.next(); if (a.t !== 'num' || b.t !== 'num') break; offsets.push([a.v, b.v]); }
        for (const [onum, off] of offsets) {
          try { const v = new Parser(data, first + off, (o) => this.resolve(o)).parse(); table.set(onum, v && typeof v === 'object' && 'kw' in v ? null : (v as PdfObj)); } catch { table.set(onum, null); }
        }
      }
    }
    return table.get(wantNum) ?? null;
  }

  /** Decoded bytes of a stream (filters applied; image filters left in place). Cached on the stream. */
  decoded(s: PdfStream): Uint8Array {
    if (s.decoded) return s.decoded;
    const r = this.decode(s);
    s.decoded = r.data;
    return r.data;
  }
  decode(s: PdfStream): DecodeResult { return decodeStream(s.raw, s.dict, (o) => this.resolve(o)); }

  // ------------------------------------------------------------------------------------------
  // Mutation

  register(obj: PdfObj): Ref {
    const num = this.nextNum++;
    this.changed.set(num, obj);
    this.gens.set(num, 0);
    this.dirty = true;
    return new Ref(num, 0);
  }
  update(ref: Ref, obj: PdfObj): void { this.changed.set(ref.num, obj); this.cache.delete(ref.num); this.dirty = true; this.pageCache = null; }
  remove(ref: Ref): void { this.changed.set(ref.num, null); this.cache.delete(ref.num); this.dirty = true; this.pageCache = null; }
  /** Marks an object fetched from the file as modified in place (after mutating the Dict you got). */
  touch(ref: Ref): void { const o = this.fetch(ref); this.changed.set(ref.num, o); this.dirty = true; this.pageCache = null; }
  genOf(num: number): number { return this.gens.get(num) ?? this.xref.get(num)?.gen ?? 0; }
  get size(): number { return this.nextNum; }
  /** Every object number known (file + overlay), excluding deleted ones. */
  objectNumbers(): number[] {
    const s = new Set<number>([...this.xref.keys(), ...this.changed.keys()]);
    return [...s].filter((n) => this.changed.get(n) !== null).sort((a, b) => a - b);
  }
  invalidatePages(): void { this.pageCache = null; }

  // ------------------------------------------------------------------------------------------
  // Structure

  get catalog(): Dict {
    const c = dictOf(this.resolve(this.trailer.get('Root')));
    if (!c) throw new Error('The document has no catalog.');
    return c;
  }
  get catalogRef(): Ref {
    const r = this.trailer.get('Root');
    if (r instanceof Ref) return r;
    // A catalog written directly in the trailer: make it an object once, and point the trailer at it.
    const ref = this.register(this.catalog);
    this.trailer.set('Root', ref);
    return ref;
  }
  get info(): Dict | null { return dictOf(this.resolve(this.trailer.get('Info'))); }
  ensureInfo(): Dict {
    let d = this.info;
    if (!d) { d = new Dict(); this.trailer.set('Info', this.register(d)); }
    else { const r = this.trailer.get('Info'); if (r instanceof Ref) this.touch(r); }
    return d;
  }
  get pagesRoot(): Dict | null { return this.getDict(this.catalog, 'Pages'); }
  get pagesRootRef(): Ref | null { const r = this.catalog.get('Pages'); return r instanceof Ref ? r : null; }

  get pages(): PageInfo[] {
    if (this.pageCache) return this.pageCache;
    const out: PageInfo[] = [];
    const seen = new Set<string>();
    type Inherited = { mediaBox?: PdfObj; cropBox?: PdfObj; rotate?: PdfObj; resources?: PdfObj };
    // Depth first, in document order, on an explicit stack: a tree may be any depth (a reference is
    // followed once, so a cycle ends), and a deep one must not overflow the call stack.
    const stack: { node: Dict; ref: Ref | null; inh: Inherited }[] = [];
    const visit = (node: Dict, ref: Ref | null, inh: Inherited) => {
      const inherit = { ...inh };
      if (node.has('MediaBox')) inherit.mediaBox = node.get('MediaBox');
      if (node.has('CropBox')) inherit.cropBox = node.get('CropBox');
      if (node.has('Rotate')) inherit.rotate = node.get('Rotate');
      if (node.has('Resources')) inherit.resources = node.get('Resources');
      const type = this.getName(node, 'Type');
      const kids = this.getArray(node, 'Kids');
      if (type === 'Page' || (!kids && type !== 'Pages' && (node.has('Contents') || node.has('MediaBox')))) {
        const mb = this.rect(inherit.mediaBox) || RECT_DEFAULT;
        const cb = this.rect(inherit.cropBox) || mb;
        const crop: [number, number, number, number] = [Math.max(mb[0], cb[0]), Math.max(mb[1], cb[1]), Math.min(mb[2], cb[2]), Math.min(mb[3], cb[3])];
        const cropOk = crop[2] > crop[0] && crop[3] > crop[1] ? crop : mb;
        let rot = this.resolve<PdfObj>(inherit.rotate);
        rot = typeof rot === 'number' ? ((Math.round(rot / 90) * 90) % 360 + 360) % 360 : 0;
        const w = cropOk[2] - cropOk[0], h = cropOk[3] - cropOk[1];
        out.push({ index: out.length, ref, dict: node, mediaBox: mb, cropBox: cropOk, rotate: rot, resources: dictOf(this.resolve(inherit.resources)), width: rot % 180 ? h : w, height: rot % 180 ? w : h });
        return;
      }
      if (!kids) return;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        const kd = dictOf(this.resolve(k));
        if (kd) stack.push({ node: kd, ref: k instanceof Ref ? k : null, inh: inherit });
      }
    };
    const root = this.pagesRoot;
    if (root) stack.push({ node: root, ref: this.pagesRootRef, inh: {} });
    while (stack.length) {
      const f = stack.pop()!;
      if (f.ref) { if (seen.has(f.ref.key)) continue; seen.add(f.ref.key); }
      visit(f.node, f.ref, f.inh);
    }
    this.pageCache = out;
    return out;
  }
  get pageCount(): number { return this.pages.length; }
  page(i: number): PageInfo | undefined { return this.pages[i]; }

  rect(o: PdfObj | undefined): [number, number, number, number] | null {
    const a = this.resolve(o);
    if (!Array.isArray(a) || a.length < 4) return null;
    const v = a.slice(0, 4).map((x) => this.resolve(x)).map((x) => (typeof x === 'number' && isFinite(x) ? x : 0));
    const r: [number, number, number, number] = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
    if (r[2] - r[0] < 1 || r[3] - r[1] < 1) return null;
    return r;
  }

  /** The concatenated, decoded content stream(s) of a page. */
  pageContent(p: PageInfo): Uint8Array {
    const c = this.get(p.dict, 'Contents');
    const parts: Uint8Array[] = [];
    const list = Array.isArray(c) ? c : c ? [c] : [];
    for (const item of list) { const s = this.resolve(item); if (s instanceof PdfStream) { parts.push(this.decoded(s)); parts.push(new Uint8Array([10])); } }
    let n = 0; for (const x of parts) n += x.length;
    const out = new Uint8Array(n); let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }

  /** Replaces a page's content with one new stream. */
  setPageContent(p: PageInfo, data: Uint8Array): void {
    const s = flateStream(data);
    p.dict.set('Contents', this.register(s));
    if (p.ref) this.touch(p.ref);
  }

  /**
   * The page's own /Resources dictionary, ready to be changed. A page whose resources are a separate
   * object, or come down from the page tree, gets a copy of them first (with a copy of each category
   * dictionary inside, such as /Font): those may be shared with other pages, which must not change, and
   * an empty dictionary in their place would cut the page off from the fonts and images it already uses.
   */
  pageResources(p: PageInfo): Dict {
    const own = p.dict.get('Resources');
    let res: Dict;
    if (own instanceof Dict) res = own;
    else {
      let from = own !== undefined ? dictOf(this.resolve(own)) : null;
      // Not on the page: the nearest ancestor in the page tree that has one.
      const seen = new Set<Dict>([p.dict]);
      for (let node = own === undefined ? dictOf(this.resolve(p.dict.get('Parent'))) : null; node && !from && !seen.has(node); node = dictOf(this.resolve(node.get('Parent')))) {
        seen.add(node);
        if (node.has('Resources')) from = dictOf(this.resolve(node.get('Resources')));
      }
      res = from ? from.clone() : new Dict();
      for (const [k, v] of res.map) if (v instanceof Dict) res.set(k, v.clone());
      p.dict.set('Resources', res);
      p.resources = res;
    }
    if (p.ref) this.touch(p.ref);
    return res;
  }

  // ------------------------------------------------------------------------------------------
  // Saving

  /**
   * Writes the document. Incremental updates append to the original bytes; a full rewrite renumbers and
   * drops unused objects. `incremental: true` is a preference: a document with no file behind it, one whose
   * cross-reference table had to be rebuilt (there is no valid section for /Prev to name), and a change
   * of encryption are always written in full.
   */
  save(opts: SaveOptions = {}): Uint8Array {
    const incremental = opts.incremental !== false && !!this.buf.length && !this.reconstructed && this.startxref >= 0 && !opts.encrypt && opts.removeSecurity !== true;
    this.ensureInfo().set('ModDate', pdfDate());
    const bytes = incremental ? writeIncremental(this, opts) : writeFull(this, opts);
    return bytes;
  }

  /** The document's text title (Info /Title, else XMP dc:title), or ''. */
  get title(): string { return this.getText(this.info, 'Title'); }
}

export { PasswordNeeded };
