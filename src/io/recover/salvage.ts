/**
 * Salvage primitives from socrtwo/wordrecovery-SF (web/app.js), ported to TypeScript:
 *
 *  - scanZipBytes: walks PK\x03\x04 local headers and ignores the central directory, so
 *    archives with a damaged or missing directory still yield their parts. Each deflated
 *    entry is decoded with ImmortalInflate at bit-alignment shifts 0..47 and the most
 *    plausible result is kept.
 *  - applyDocumentXmlTagFixes: the original SourceForge tool's InvalidTags -> ValidTags
 *    substitutions for word/document.xml.
 *  - healXMLStrict: the original character-level XML healer.
 *  - Text extractors for WordprocessingML, ODF, RTF, and a printable-strings scan.
 *
 * Additions that are not in the original: the declared compressed size is used when it is
 * consistent, and balanceXml() rebuilds a well-formed tree from tag soup (mis-nested and
 * truncated elements, stray ampersands, duplicate attributes, undeclared prefixes).
 */
import { immortalInflate, crc32, type InflateResult } from './inflate';

export interface SalvagedEntry {
  data: Uint8Array;
  isCorrupt: boolean;
  offset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Score how much a decoded buffer looks like real content (original rateQuality). */
export function rateQuality(u8: Uint8Array, name?: string): number {
  let valid = 0;
  const limit = Math.min(u8.length, 500);
  for (let i = 0; i < limit; i++) if ((u8[i] >= 32 && u8[i] <= 126) || u8[i] === 10 || u8[i] === 13) valid++;
  if (name && (name.endsWith('.xml') || name.endsWith('.rels'))) {
    const peek = Math.min(u8.length, 100);
    for (let i = 0; i < peek; i++) if (u8[i] === 60) { valid += 500; break; }
  }
  return valid;
}

function isSig(b: Uint8Array, k: number): boolean {
  if (b[k] !== 0x50 || b[k + 1] !== 0x4b) return false;
  const c = b[k + 2], d = b[k + 3];
  return (c === 1 && d === 2) || (c === 3 && d === 4) || (c === 5 && d === 6) || (c === 7 && d === 8) || (c === 6 && d === 6) || (c === 6 && d === 7);
}

export interface ZipScanOptions {
  /** Decode only entries this accepts; `head` is the start of the entry's data (up to 1 KB, decompressed). Default: every entry. */
  want?: (name: string, head: Uint8Array) => boolean;
  /** Stop decoding once this many bytes are held in total (default 512 MB), so a small archive cannot exhaust memory. */
  maxTotal?: number;
}

/** Byte-level ZIP recovery: every entry whose local header survives. Encrypted entries are skipped (their data cannot be read). */
export function scanZipBytes(u8: Uint8Array, opts: ZipScanOptions = {}): Map<string, SalvagedEntry> {
  const out = new Map<string, SalvagedEntry>();
  const maxTotal = opts.maxTotal ?? 512 * 1024 * 1024;
  let total = 0;
  const dec = new TextDecoder('utf-8', { fatal: false });
  let offset = 0;
  while (offset < u8.length - 30) {
    if (u8[offset] !== 0x50 || u8[offset + 1] !== 0x4b || u8[offset + 2] !== 0x03 || u8[offset + 3] !== 0x04) { offset++; continue; }
    const flags = u16(u8, offset + 6);
    const meth = u16(u8, offset + 8);
    const crc = u32(u8, offset + 14);
    const csize = u32(u8, offset + 18);
    const nl = u16(u8, offset + 26);
    const el = u16(u8, offset + 28);
    if (nl === 0 || nl > 512 || (meth !== 0 && meth !== 8)) { offset++; continue; }
    const name = dec.decode(u8.subarray(offset + 30, offset + 30 + nl));
    if (/[\x00-\x1f�]/.test(name)) { offset++; continue; }
    const dStart = offset + 30 + nl + el;
    if (dStart > u8.length) break;
    if (name.endsWith('/')) { offset = dStart; continue; }
    // End of the entry's data: trust the declared size when a signature (or EOF) follows it,
    // otherwise search forward for the next signature, as the original does.
    let next = -1;
    if (!(flags & 0x08) && csize > 0 && dStart + csize <= u8.length && (dStart + csize === u8.length || isSig(u8, dStart + csize))) next = dStart + csize;
    if (next < 0) {
      next = u8.length;
      for (let k = dStart; k < u8.length - 4; k++) if (isSig(u8, k)) { next = k; break; }
    }
    const raw = u8.subarray(dStart, next);
    const skip = () => { offset = Math.max(next, offset + 1); };
    if (flags & 0x01) { skip(); continue; }
    if (opts.want && !opts.want(name, meth === 0 ? raw.subarray(0, 1024) : immortalInflate(raw, { maxOutput: 1024 }).data)) { skip(); continue; }
    const room = maxTotal - total;
    if (room <= 0) break;
    let data: Uint8Array | null = null, isCorrupt = false;
    if (meth === 0) data = raw.length > room ? raw.subarray(0, room) : raw;
    else {
      let best: InflateResult = { data: new Uint8Array(0), isCorrupt: true }, bestScore = 0, bestShift = 0;
      // Realignment retries decode the entry again each time: a large entry gets only a few.
      const tries = raw.length > 32 * 1024 * 1024 ? 4 : 48;
      for (let shift = 0; shift < tries && shift < raw.length; shift++) {
        const r = immortalInflate(raw.subarray(shift), { maxOutput: room });
        if (!r.data.length) continue;
        if (shift === 0 && !r.isCorrupt) { best = r; break; }
        const score = rateQuality(r.data, name) + (r.isCorrupt ? 0 : 100);
        if (score > bestScore) { bestScore = score; best = r; bestShift = shift; if (score > 1000) break; }
      }
      // Damaged data often inflates without an error, so check the CRC from the local header.
      if (!best.isCorrupt && crc && !(flags & 0x08) && crc32(best.data) !== crc) best = { ...best, isCorrupt: true };
      // A damaged XML stream: skip the bad region and keep decoding the deflate blocks after it.
      if (best.isCorrupt && /\.(xml|rels)$/i.test(name)) {
        const r = immortalInflate(raw.subarray(bestShift), { resync: true, validateText: true, strictBlocks: true, maxOutput: room });
        if (r.data.length > best.data.length * 0.5 || r.gaps) best = { ...r, isCorrupt: true };
      }
      data = best.data; isCorrupt = best.isCorrupt;
    }
    if (data && data.length) {
      const prev = out.get(name);
      if (!prev || prev.data.length < data.length) { total += data.length - (prev ? prev.data.length : 0); out.set(name, { data, isCorrupt, offset }); }
    }
    offset = Math.max(next, offset + 1);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// XML repair

const InvalidTags = {
  omathWps: '<mc:AlternateContent><mc:Choice Requires="wps"><m:oMath>',
  omathWpg: '<mc:AlternateContent><mc:Choice Requires="wpg"><m:oMath>',
  omathWpi: '<mc:AlternateContent><mc:Choice Requires="wpi"><m:oMath>',
  omathWpc: '<mc:AlternateContent><mc:Choice Requires="wpc"><m:oMath>',
  vshape: '</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>',
  mcChoiceRe: /(<\/mc:Choice>)(<(.).*?(\/>|>))/g,
  fallbackRe: /(<mc:Fallback><w:pict\/>)(<(.).*?(\/>|>))/g,
};
const ValidTags = {
  omathWps: '<m:oMath><mc:AlternateContent><mc:Choice Requires="wps">',
  omathWpg: '<m:oMath><mc:AlternateContent><mc:Choice Requires="wpg">',
  omathWpi: '<m:oMath><mc:AlternateContent><mc:Choice Requires="wpi">',
  omathWpc: '<m:oMath><mc:AlternateContent><mc:Choice Requires="wpc">',
  vshape: '</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent>',
  mcChoice3: '</mc:Choice></mc:AlternateContent>',
  omitFallback: '</mc:AlternateContent></w:r>',
};

/** The original tool's InvalidTags -> ValidTags substitutions for word/document.xml. */
export function applyDocumentXmlTagFixes(xml: string): { xml: string; changes: number } {
  let s = xml;
  let changes = 0;
  const replaceAll = (needle: string, repl: string) => {
    const parts = s.split(needle);
    if (parts.length > 1) { changes += parts.length - 1; s = parts.join(repl); }
  };
  replaceAll(InvalidTags.omathWps, ValidTags.omathWps);
  replaceAll(InvalidTags.omathWpg, ValidTags.omathWpg);
  replaceAll(InvalidTags.omathWpi, ValidTags.omathWpi);
  replaceAll(InvalidTags.omathWpc, ValidTags.omathWpc);
  replaceAll(InvalidTags.vshape, ValidTags.vshape);
  s = s.replace(InvalidTags.mcChoiceRe, (m, _g1, g2: string) => {
    // Only a sibling directly after </mc:Choice> that is not the Fallback/AlternateContent close is invalid.
    if (g2.startsWith('<mc:Fallback') || g2.startsWith('</mc:AlternateContent')) return m;
    changes++;
    return ValidTags.mcChoice3 + g2;
  });
  s = s.replace(InvalidTags.fallbackRe, (m, _g1, g2: string) => {
    if (g2.startsWith('</mc:Fallback')) return m;
    changes++;
    return ValidTags.omitFallback + g2;
  });
  return { xml: s, changes };
}

/** Original character-level healer: escapes stray brackets, closes cut-off tags and quotes. */
export function healXMLStrict(input: string): string {
  let xml = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const validStart = xml.search(/<\?xml|<[a-zA-Z0-9]+:/);
  if (validStart > -1) xml = xml.substring(validStart);
  else { const f = xml.indexOf('<'); if (f > -1) xml = xml.substring(f); }
  let out = '', inTag = false, inQuote = false, quoteChar: string | null = null;
  for (let i = 0; i < xml.length; i++) {
    const c = xml[i], next = xml[i + 1] || '';
    if (!inTag) {
      if (c === '<') {
        if (/[a-zA-Z0-9_:/?!]/.test(next)) { inTag = true; out += c; }
        else out += '&lt;';
      } else if (c === '>') out += '&gt;';
      else out += c;
    } else if (inQuote) {
      if (c === quoteChar) { inQuote = false; quoteChar = null; }
      out += c;
    } else if (c === '"' || c === "'") { inQuote = true; quoteChar = c; out += c; }
    else if (c === '>') { inTag = false; out += c; }
    else if (c === '<') { out += '>'; inTag = false; i--; }
    else out += c;
  }
  if (inQuote) out += quoteChar;
  if (inTag) out += '>';
  const stack: string[] = [];
  const re = /<\/?([a-zA-Z0-9_:-]+)[^>]*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const tag = m[1], full = m[0];
    if (full.startsWith('</')) { if (stack.length && stack[stack.length - 1] === tag) stack.pop(); }
    else if (!full.endsWith('/>') && m[2] !== '/' && !full.startsWith('<?')) stack.push(tag);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/** Namespaces commonly used in OOXML and ODF parts, for declaring prefixes a damaged part lost. */
const KNOWN_NS: Record<string, string> = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  w10: 'urn:schemas-microsoft-com:office:word',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  wpg: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  wpc: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  wpi: 'http://schemas.microsoft.com/office/word/2010/wordprocessingInk',
  wp14: 'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
};

const ENTITY_FIX = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g;
const escText = (s: string) => fixCharRefs(s.replace(ENTITY_FIX, '&amp;'));
const escAttr = (s: string) => fixCharRefs(s.replace(ENTITY_FIX, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'));

function fixCharRefs(s: string): string {
  return s.replace(/&#(x[0-9a-fA-F]+|\d+);/g, (m, v: string) => {
    const cp = v[0] === 'x' || v[0] === 'X' ? parseInt(v.slice(1), 16) : parseInt(v, 10);
    const ok = cp === 9 || cp === 10 || cp === 13 || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
    return ok ? m : '';
  });
}

export function stripInvalidChars(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

const NAME_RE = /[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/y;
const ATTR_NAME_RE = /[^\s=/>"'<]+/y;

/**
 * Rebuild well-formed XML from damaged markup. Mis-nested end tags close the elements
 * opened after their partner; end tags with no partner are dropped; everything still open
 * at the end (a truncated part) is closed; unknown prefixes get declarations on the root.
 */
export function balanceXml(input: string): string {
  const s = stripInvalidChars(input);
  const out: string[] = [];
  const stack: string[] = [];
  const declared = new Set<string>();
  const used = new Set<string>();
  let rootIdx = -1, rootDone = false;
  let i = s.indexOf('<');
  if (i < 0) return '';
  const notePrefix = (n: string) => { const c = n.indexOf(':'); if (c > 0) used.add(n.slice(0, c)); };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const textEnd = lt < 0 ? s.length : lt;
    if (textEnd > i) {
      if (stack.length) out.push(escText(s.slice(i, textEnd)));
      i = textEnd;
      if (lt < 0) break;
    }
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); if (e < 0) break; i = e + 3; continue; }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      const body = s.slice(i + 9, e < 0 ? s.length : e);
      if (stack.length) out.push(escText(body.replace(/&/g, '&amp;').replace(/</g, '&lt;')));
      if (e < 0) break;
      i = e + 3; continue;
    }
    if (s.startsWith('<?', i)) {
      const e = s.indexOf('?>', i + 2);
      if (e < 0) break;
      if (!out.length && s.startsWith('<?xml', i)) out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
      i = e + 2; continue;
    }
    if (s.startsWith('<!', i)) { const e = s.indexOf('>', i); if (e < 0) break; i = e + 1; continue; }
    // Element tag
    let j = i + 1;
    const close = s[j] === '/';
    if (close) j++;
    NAME_RE.lastIndex = j;
    const nm = NAME_RE.exec(s);
    if (!nm) { if (stack.length) out.push('&lt;'); i++; continue; }
    const name = nm[0];
    j = NAME_RE.lastIndex;
    const attrs: [string, string][] = [];
    const seen = new Set<string>();
    let self = false;
    for (;;) {
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j >= s.length) break;
      const c = s[j];
      if (c === '>') { j++; break; }
      if (c === '/' && s[j + 1] === '>') { self = true; j += 2; break; }
      if (c === '<') break;
      ATTR_NAME_RE.lastIndex = j;
      const an = ATTR_NAME_RE.exec(s);
      if (!an) { j++; continue; }
      j = ATTR_NAME_RE.lastIndex;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] !== '=') continue;
      j++;
      while (j < s.length && /\s/.test(s[j])) j++;
      let value = '';
      const q = s[j];
      if (q === '"' || q === "'") {
        const k = s.indexOf(q, j + 1);
        const cut = s.indexOf('<', j + 1);
        if (k < 0 || (cut >= 0 && cut < k)) { value = s.slice(j + 1, cut >= 0 ? cut : s.length); j = cut >= 0 ? cut : s.length; }
        else { value = s.slice(j + 1, k); j = k + 1; }
      } else {
        const m = /[^\s>]*/y; m.lastIndex = j; value = m.exec(s)![0]; j = m.lastIndex;
      }
      const a = an[0];
      if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(a) || seen.has(a)) continue;
      seen.add(a);
      attrs.push([a, value]);
    }
    i = j;
    if (close) {
      const at = stack.lastIndexOf(name);
      if (at >= 0) {
        while (stack.length > at) out.push(`</${stack.pop()}>`);
        if (!stack.length) rootDone = true;
      }
      continue;
    }
    if (rootDone || (!stack.length && rootIdx >= 0)) continue;
    notePrefix(name);
    for (const [a] of attrs) {
      if (a.startsWith('xmlns:')) declared.add(a.slice(6));
      else if (a !== 'xmlns' && !a.startsWith('xml:')) notePrefix(a);
    }
    if (rootIdx < 0) rootIdx = out.length;
    out.push(`<${name}${attrs.map(([a, v]) => ` ${a}="${escAttr(v)}"`).join('')}${self ? '/>' : '>'}`);
    if (!self) stack.push(name);
    else if (!stack.length) rootDone = true;
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  if (rootIdx >= 0) {
    const missing = [...used].filter((p) => p !== 'xml' && p !== 'xmlns' && !declared.has(p));
    if (missing.length) {
      const decl = missing.map((p) => ` xmlns:${p}="${KNOWN_NS[p] || `urn:quillfolio:recovered:${p}`}"`).join('');
      out[rootIdx] = out[rootIdx].replace(/(\/?>)$/, `${decl}$1`);
    }
  }
  return out.join('');
}

/**
 * Find where damaged markup starts: the first end tag that closes something other than the
 * innermost open element, or the first element with an undeclared prefix. Returns the offset
 * just after the last complete paragraph before that point, or -1 when the markup is consistent.
 * Damaged deflate data keeps decoding, and LZ77 copies the damage forward, so everything after
 * this point is unreliable.
 */
export function findDamageCut(xml: string, paraClose = '</w:p>'): number {
  const declared = new Set(['xml', 'xmlns']);
  for (const m of xml.slice(0, 20000).matchAll(/xmlns:([A-Za-z_][\w.-]*)=/g)) declared.add(m[1]);
  const stack: string[] = [];
  const re = /<(\/?)([^\s>/!?]+)[^>]*?(\/?)>/g;
  let m: RegExpExecArray | null;
  let bad = -1;
  while ((m = re.exec(xml)) !== null) {
    const name = m[2];
    if (!/^[A-Za-z_][\w.-]*(:[A-Za-z_][\w.-]*)?$/.test(name)) { bad = m.index; break; }
    const c = name.indexOf(':');
    if (c > 0 && !declared.has(name.slice(0, c))) { bad = m.index; break; }
    if (m[1]) {
      if (stack[stack.length - 1] !== name) { bad = m.index; break; }
      stack.pop();
    } else if (!m[3]) stack.push(name);
  }
  if (bad < 0) return -1;
  const cut = xml.lastIndexOf(paraClose, bad);
  return cut < 0 ? -1 : cut + paraClose.length;
}

/** True when the browser's XML parser accepts the text. */
export function isWellFormed(xml: string): boolean {
  try {
    const d = new DOMParser().parseFromString(xml, 'application/xml');
    return !!d.documentElement && d.documentElement.localName !== 'parsererror' && !d.getElementsByTagName('parsererror').length;
  } catch {
    return false;
  }
}

/** Repair one XML part: tag fixes (document.xml), then healXMLStrict, then balanceXml. */
export function repairXmlPart(name: string, text: string, force = false): { xml: string; steps: string[] } | null {
  let t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const steps: string[] = [];
  if (/(^|\/)document\d*\.xml$/i.test(name) && (force || !isWellFormed(t))) {
    const f = applyDocumentXmlTagFixes(t);
    if (f.changes) { t = f.xml; steps.push(`${f.changes} tag substitution${f.changes === 1 ? '' : 's'}`); }
  }
  if (isWellFormed(t)) return { xml: t, steps };
  const healed = healXMLStrict(t);
  if (isWellFormed(healed)) return { xml: healed, steps: [...steps, 'healed'] };
  const balanced = balanceXml(t);
  if (isWellFormed(balanced)) return { xml: balanced, steps: [...steps, 'rebuilt'] };
  const both = balanceXml(healed);
  if (isWellFormed(both)) return { xml: both, steps: [...steps, 'healed', 'rebuilt'] };
  return null;
}

// ------------------------------------------------------------------------------------------
// Text extractors

const unent = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => safeChar(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d: string) => safeChar(parseInt(d, 10))).replace(/&amp;/g, '&');
const safeChar = (cp: number) => { try { return String.fromCodePoint(cp); } catch { return ''; } };

/** Text of WordprocessingML (w:t, w:tab, w:br, w:p), tolerant of damaged markup. */
export function extractTextFromWordXml(xml: string): string {
  if (!xml) return '';
  const out: string[] = [];
  const tagRe = /<w:(t|tab|br|p|cr|delText)(\s[^>]*)?(\/>|>)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[1];
    const selfClose = m[3] === '/>';
    if ((tag === 't' || tag === 'delText') && !selfClose) {
      const start = tagRe.lastIndex;
      const closeTag = tag === 't' ? '</w:t>' : '</w:delText>';
      let end = xml.indexOf(closeTag, start);
      const nextTag = xml.indexOf('<', start);
      if (end === -1 || (nextTag >= 0 && nextTag < end)) end = nextTag >= 0 ? nextTag : xml.length;
      if (tag === 't') out.push(unent(xml.slice(start, end)));
      tagRe.lastIndex = end;
    } else if (tag === 'tab') out.push('\t');
    else if (tag === 'br' || tag === 'cr') out.push('\n');
    else if (tag === 'p' && !selfClose) out.push('\n');
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractTextFromOdtXml(xml: string): string {
  if (!xml) return '';
  let s = xml.replace(/<text:line-break\s*\/>/g, '\n').replace(/<text:tab\s*\/>/g, '\t').replace(/<text:s(\s[^>]*)?\/>/g, ' ')
    .replace(/<\/text:p>/g, '\n').replace(/<\/text:h>/g, '\n');
  s = s.replace(/<[^>]+>/g, '');
  return unent(s).replace(/\n{3,}/g, '\n\n').trim();
}

/** Strip RTF control words; handles \uN, \'hh, \binN and ignorable destinations. */
export function extractTextFromRtf(bytes: Uint8Array | string): string {
  const s = typeof bytes === 'string' ? bytes : new TextDecoder('latin1').decode(bytes);
  if (!s.startsWith('{\\rtf')) return '';
  const out: string[] = [];
  const skipStack: boolean[] = [];
  let skip = false, uc = 1, pendingSkip = 0;
  const SKIP_DEST = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|fldinst|themedata|colorschememapping|datastore|latentstyles|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|mmathPr|filetbl|revtbl|pgdsctbl)$/;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '{') { skipStack.push(skip); i++; continue; }
    if (c === '}') { skip = skipStack.pop() ?? false; i++; continue; }
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\\' || nx === '{' || nx === '}') { if (!skip) out.push(nx); i += 2; continue; }
      if (nx === '~') { if (!skip) out.push(' '); i += 2; continue; }
      if (nx === '-' ) { i += 2; continue; }
      if (nx === '_') { if (!skip) out.push('‑'); i += 2; continue; }
      if (nx === '*') { skip = true; i += 2; continue; }
      if (nx === "'") {
        const h = parseInt(s.substr(i + 2, 2), 16);
        if (pendingSkip > 0) pendingSkip--;
        else if (!skip && Number.isFinite(h)) out.push(cp1252(h));
        i += 4; continue;
      }
      if (nx === '\n' || nx === '\r') { if (!skip) out.push('\n'); i += 2; continue; }
      const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(s.slice(i + 1, i + 48));
      if (!m) { i += 2; continue; }
      const word = m[1], arg = m[2] != null ? parseInt(m[2], 10) : null;
      i += 1 + m[0].length;
      // Skip binary data; a zero or negative length skips nothing (stepping back would loop forever).
      if (word === 'bin') { if (arg != null && arg > 0) i += arg; continue; }
      if (SKIP_DEST.test(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === 'uc' && arg != null) uc = arg;
      else if (word === 'u' && arg != null) { out.push(safeChar(arg < 0 ? arg + 65536 : arg)); pendingSkip = uc; }
      else if (word === 'par' || word === 'line' || word === 'sect' || word === 'row') out.push('\n');
      else if (word === 'tab' || word === 'cell') out.push('\t');
      else if (word === 'page') out.push('\f');
      else if (word === 'emdash') out.push('—');
      else if (word === 'endash') out.push('–');
      else if (word === 'lquote') out.push('‘');
      else if (word === 'rquote') out.push('’');
      else if (word === 'ldblquote') out.push('“');
      else if (word === 'rdblquote') out.push('”');
      else if (word === 'bullet') out.push('•');
      continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (!skip) {
      if (pendingSkip > 0) pendingSkip--;
      else out.push(c);
    }
    i++;
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CP1252: Record<number, string> = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };
export const cp1252 = (b: number) => CP1252[b] ?? String.fromCharCode(b);

/** Last resort: printable ASCII runs and UTF-16LE runs (original stringsScan). */
export function stringsScan(u8: Uint8Array, minLen = 4): string {
  const runs: string[] = [];
  let buf = '';
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    if ((b >= 32 && b <= 126) || b === 9) buf += String.fromCharCode(b);
    else { if (buf.length >= minLen) runs.push(buf); buf = ''; }
  }
  if (buf.length >= minLen) runs.push(buf);
  buf = '';
  for (let i = 0; i + 1 < u8.length; i += 2) {
    const lo = u8[i], hi = u8[i + 1];
    const cp = lo | (hi << 8);
    const printable = (hi === 0 && ((lo >= 32 && lo <= 126) || lo === 9 || lo === 10 || lo === 13)) || (cp >= 0xa0 && cp < 0x2000) || (cp >= 0x2010 && cp <= 0x205f);
    if (printable) buf += String.fromCharCode(cp);
    else { if (buf.length >= minLen) runs.push(buf); buf = ''; }
  }
  if (buf.length >= minLen) runs.push(buf);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const r of runs) {
    const key = r.replace(/\s+/g, ' ').trim();
    if (key.length >= minLen && !seen.has(key)) { seen.add(key); unique.push(key); }
  }
  return unique.join('\n');
}

/** Rough measure of how much of a text is natural language (letters and spaces). */
export function textQuality(t: string): number {
  if (!t) return 0;
  const sample = t.slice(0, 20000);
  const letters = (sample.match(/[\p{L}\s.,;:'"!?()-]/gu) || []).length;
  const words = (sample.match(/\b\p{L}{2,}\b/gu) || []).length;
  return (letters / sample.length) * Math.min(1, words / Math.max(1, sample.length / 7));
}
