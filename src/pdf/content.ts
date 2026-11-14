/**
 * Content streams (ISO 32000-1 §7.8, §8–9): a tokenizer into operators with operands, a serializer
 * back to bytes, and a small interpreter that tracks the graphics state (CTM, text matrix, font,
 * size) well enough to know where each text string and image sits on the page. That is what
 * redaction, text editing, measurement and the structure inspector need; drawing is pdf.js's job.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, isName, latin1 } from './objects';
import { Lexer, Parser } from './lexer';
import { serialize } from './writer';
import type { PdfDocument } from './document';
import { bytesOf, concat } from './objects';

export interface Op { op: string; args: PdfObj[]; /** Inline image data for BI…ID…EI. */ inline?: { dict: Dict; data: Uint8Array } }

/** Tokenizes a content stream into operators. Unknown tokens are kept as operands. */
export function parseContent(data: Uint8Array): Op[] {
  const ops: Op[] = [];
  const p = new Parser(data, 0, undefined, false);
  let args: PdfObj[] = [];
  // No token limit: every token moves the position forward, and a truncated list would be written back short.
  for (;;) {
    const t = p.lexer.next();
    if (t.t === 'eof') break;
    if (t.t === 'kw') {
      if (t.v === 'true' || t.v === 'false' || t.v === 'null') { args.push(t.v === 'true' ? true : t.v === 'false' ? false : null); continue; }
      if (t.v === 'BI') {
        // Inline image: key/value pairs until ID, then binary data until EI.
        const d = new Dict();
        for (;;) {
          const k = p.lexer.next();
          if (k.t === 'eof') break;
          if (k.t === 'kw' && k.v === 'ID') break;
          if (k.t !== 'name') continue;
          const v = p.parse();
          d.set(k.v, v && typeof v === 'object' && 'kw' in v ? null : (v as PdfObj));
        }
        const start = Math.min(data.length, p.lexer.pos + 1);
        const end = inlineImageEnd(data, start, d);
        ops.push({ op: 'INLINE_IMAGE', args: [], inline: { dict: d, data: data.subarray(start, end.dataEnd) } });
        p.lexer.pos = end.next;
        args = [];
        continue;
      }
      ops.push({ op: t.v, args });
      args = [];
      continue;
    }
    const v = p.parse(t);
    if (v && typeof v === 'object' && 'kw' in v) { ops.push({ op: v.kw, args }); args = []; continue; }
    args.push(v as PdfObj);
  }
  return ops;
}

const isSpace = (c: number | undefined): boolean => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;

/**
 * Where an inline image's data ends (`dataEnd`) and where parsing resumes after its EI (`next`).
 * Unfiltered data has a known length; ASCII-filtered data has its own end marker; otherwise the first
 * "EI" between white space counts only when what follows reads like content rather than more image bytes.
 */
function inlineImageEnd(data: Uint8Array, start: number, d: Dict): { dataEnd: number; next: number } {
  const get = (...keys: string[]): PdfObj | undefined => { for (const k of keys) if (d.has(k)) return d.get(k); return undefined; };
  const eiAt = (at: number): number => { // position after an EI that follows optional white space at `at`, or -1
    let q = at;
    while (q < data.length && isSpace(data[q])) q++;
    return data[q] === 0x45 && data[q + 1] === 0x49 && (q + 2 >= data.length || isSpace(data[q + 2])) ? q + 2 : -1;
  };
  const filter = get('Filter', 'F');
  const first = filter instanceof Name ? filter.name : Array.isArray(filter) && filter[0] instanceof Name ? filter[0].name : '';
  let from = start;
  if (filter === undefined || filter === null || (Array.isArray(filter) && !filter.length)) {
    const w = get('Width', 'W'), h = get('Height', 'H'), bpc = get('BitsPerComponent', 'BPC'), cs = get('ColorSpace', 'CS');
    const mask = get('ImageMask', 'IM') === true;
    const csName = cs instanceof Name ? cs.name : Array.isArray(cs) && cs[0] instanceof Name ? cs[0].name : '';
    const comps = mask ? 1 : ({ G: 1, DeviceGray: 1, CalGray: 1, I: 1, Indexed: 1, RGB: 3, DeviceRGB: 3, CalRGB: 3, Lab: 3, CMYK: 4, DeviceCMYK: 4 } as Record<string, number>)[csName] || 0;
    const bits = mask ? 1 : typeof bpc === 'number' ? bpc : 0;
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 && comps && bits > 0) {
      const len = h * Math.ceil((w * comps * bits) / 8);
      const next = start + len <= data.length ? eiAt(start + len) : -1;
      if (next >= 0) return { dataEnd: start + len, next };
    }
  } else if (first === 'ASCII85Decode' || first === 'A85') { const m = Lexer.find(data, '~>', start); if (m >= 0) from = m + 2; }
  else if (first === 'ASCIIHexDecode' || first === 'AHx') { const m = Lexer.find(data, '>', start); if (m >= 0) from = m + 1; }
  let fallback = -1;
  for (let at = from; ;) {
    const e = Lexer.find(data, 'EI', at);
    if (e < 0) break;
    at = e + 2;
    if (!(e === start || isSpace(data[e - 1])) || !(e + 2 >= data.length || isSpace(data[e + 2]))) continue;
    if (fallback < 0) fallback = e;
    // Content follows an image's EI: the next bytes are white space or printable ASCII, not arbitrary binary.
    let ok = true;
    for (let i = e + 2; i < Math.min(data.length, e + 22); i++) { const c = data[i]; if (!(isSpace(c) || (c >= 0x20 && c <= 0x7e))) { ok = false; break; } }
    if (ok) return { dataEnd: Math.max(start, e - 1), next: e + 2 };
  }
  if (fallback >= 0) return { dataEnd: Math.max(start, fallback - 1), next: fallback + 2 };
  return { dataEnd: data.length, next: data.length };
}

export function serializeContent(ops: Op[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const o of ops) {
    if (o.inline) {
      parts.push(bytesOf('BI '));
      for (const [k, v] of o.inline.dict.map) { parts.push(bytesOf(`/${k} `)); parts.push(serialize(v)); parts.push(bytesOf(' ')); }
      parts.push(bytesOf('ID '));
      parts.push(o.inline.data);
      parts.push(bytesOf('\nEI\n'));
      continue;
    }
    for (const a of o.args) { parts.push(serialize(a)); parts.push(bytesOf(' ')); }
    parts.push(bytesOf(o.op + '\n'));
  }
  return concat(parts);
}

export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export const mul = (a: Matrix, b: Matrix): Matrix => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

export interface TextRun {
  /** Index of the operator (Tj/TJ/'/") in the ops array. */
  opIndex: number;
  /** Decoded text (best effort through the font's encoding / ToUnicode). */
  text: string;
  /** Bounding box in user space [x0, y0, x1, y1]. */
  box: [number, number, number, number];
  font: string;
  size: number;
  /** The string operands' raw bytes, in order. */
  strings: PdfString[];
}

export interface ImageUse { opIndex: number; name: string; box: [number, number, number, number]; inline?: boolean }

export interface FontInfo {
  name: string;
  subtype: string;
  /** Glyph widths (per code) in text space units ×1000, for simple fonts. */
  widths: Map<number, number>;
  defaultWidth: number;
  /** Code → Unicode (from ToUnicode, or the base encoding). */
  toUnicode: Map<number, string>;
  /** Two-byte codes (Type0 with Identity or a 2-byte CMap). */
  twoByte: boolean;
  /** Can Anne's Folio re-encode text for this font? (simple font with a known Latin encoding) */
  editable: boolean;
  /** Unicode → code for editable fonts. */
  fromUnicode: Map<string, number>;
  dict: Dict;
}

// Standard 14 fonts' Helvetica-like widths are used when a font has no /Widths.
const STD_WIDTHS: Record<string, number[]> = {};
import { HELVETICA_WIDTHS, TIMES_WIDTHS, COURIER_WIDTH } from './stdfonts';
STD_WIDTHS.helv = HELVETICA_WIDTHS; STD_WIDTHS.times = TIMES_WIDTHS;

const WIN_ANSI: Record<number, string> = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ', 0xa0: ' ', 0xad: '-' };
export function winAnsiToUnicode(c: number): string { return WIN_ANSI[c] ?? String.fromCharCode(c); }
export function unicodeToWinAnsi(ch: string): number {
  const c = ch.codePointAt(0)!;
  if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
  for (const [k, v] of Object.entries(WIN_ANSI)) if (v === ch) return +k;
  return -1;
}
const MAC_ROMAN_HI = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

// StandardEncoding above 0x7E (ISO 32000-1 Annex D); below, it is ASCII except 0x27 quoteright and 0x60 quoteleft.
const STANDARD_HI: Record<number, string> = {
  0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤', 0xa9: "'", 0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'ﬁ', 0xaf: 'ﬂ',
  0xb1: '–', 0xb2: '†', 0xb3: '‡', 0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿',
  0xc1: '`', 0xc2: '´', 0xc3: 'ˆ', 0xc4: '˜', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸', 0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—',
  0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º', 0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
};

/** Parses a ToUnicode CMap (bfchar / bfrange). */
export function parseToUnicode(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const text = latin1(data);
  const hexText = (h: string): string => { const b: number[] = []; for (let i = 0; i + 1 < h.length; i += 2) b.push(parseInt(h.slice(i, i + 2), 16)); let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); if (b.length === 1) s = String.fromCharCode(b[0]); return s; };
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const e of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(e[1], 16), hexText(e[2]));
  }
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = m[1];
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g;
    let e: RegExpExecArray | null;
    while ((e = re.exec(body))) {
      const lo = parseInt(e[1], 16), hi = parseInt(e[2], 16);
      if (hi - lo > 65535 || hi < lo) continue;
      if (e[5] !== undefined) {
        const items = [...e[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => hexText(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      } else {
        const dst = hexText(e[4]);
        const last = dst.charCodeAt(dst.length - 1) || 0;
        for (let c = lo; c <= hi; c++) map.set(c, dst.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return map;
}

/** Reads what the engine needs about a font resource. */
export function fontInfo(doc: PdfDocument, name: string, fd: Dict | null): FontInfo {
  const info: FontInfo = { name, subtype: fd ? doc.getName(fd, 'Subtype') : '', widths: new Map(), defaultWidth: 500, toUnicode: new Map(), twoByte: false, editable: false, fromUnicode: new Map(), dict: fd || new Dict() };
  if (!fd) return info;
  const base = doc.getName(fd, 'BaseFont');
  const tu = doc.get(fd, 'ToUnicode');
  if (tu instanceof PdfStream) { try { info.toUnicode = parseToUnicode(doc.decoded(tu)); } catch { /* */ } }
  if (info.subtype === 'Type0') {
    info.twoByte = true;
    const enc = doc.get(fd, 'Encoding');
    const encName = isName(enc) ? enc.name : '';
    if (!/Identity|UCS2|UTF16/.test(encName) && enc instanceof PdfStream) {
      // An embedded CMap: use its codespace to decide the byte length (1 or 2).
      const cm = latin1(doc.decoded(enc));
      const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(cm);
      info.twoByte = !cs || cs[1].length > 2;
    }
    const desc = doc.getArray(fd, 'DescendantFonts');
    const df = desc && desc.length ? doc.resolve<Dict | null>(desc[0]) : null;
    if (df instanceof Dict) {
      info.defaultWidth = doc.getNum(df, 'DW', 1000);
      const W = doc.getArray(df, 'W') || [];
      for (let i = 0; i < W.length;) {
        const a = doc.resolve<number>(W[i]);
        const b = doc.resolve<PdfObj>(W[i + 1]);
        if (Array.isArray(b)) { b.forEach((w, k) => info.widths.set(a + k, doc.resolve<number>(w))); i += 2; }
        else { const c = doc.resolve<number>(W[i + 2]); if (typeof b === 'number' && typeof c === 'number' && b - a < 65536) for (let x = a; x <= b; x++) info.widths.set(x, c); i += 3; }
      }
    }
    return info;
  }
  // Simple fonts
  const fc = doc.getNum(fd, 'FirstChar', 0);
  const widths = doc.getArray(fd, 'Widths');
  if (widths && widths.length) {
    widths.forEach((w, i) => { const v = doc.resolve<number>(w); if (typeof v === 'number') info.widths.set(fc + i, v); });
    const fdesc = doc.getDict(fd, 'FontDescriptor');
    info.defaultWidth = fdesc ? doc.getNum(fdesc, 'MissingWidth', 0) : 0;
  } else {
    const std = /Courier|Mono/i.test(base) ? null : /Times|Serif|Roman|Georgia|Book/i.test(base) ? STD_WIDTHS.times : STD_WIDTHS.helv;
    for (let c = 32; c < 127; c++) info.widths.set(c, std ? std[c - 32] : COURIER_WIDTH);
    info.defaultWidth = std ? 556 : COURIER_WIDTH;
    if (/Bold/i.test(base) && std) for (const [c, w] of info.widths) info.widths.set(c, Math.round(w * 1.05));
  }
  // Encoding: base encoding + differences; names map through a small glyph list.
  const enc = doc.get(fd, 'Encoding');
  const fontDesc = doc.getDict(fd, 'FontDescriptor');
  const embedded = !!fontDesc && (fontDesc.has('FontFile') || fontDesc.has('FontFile2') || fontDesc.has('FontFile3'));
  const named = isName(enc) ? enc.name : enc instanceof Dict ? doc.getName(enc, 'BaseEncoding') : '';
  // With no encoding named: a symbolic font uses its own; a TrueType font is read as WinAnsi (what its
  // Windows cmap usually amounts to); any other simple font uses StandardEncoding.
  let baseEnc = named;
  if (!baseEnc) baseEnc = /Symbol|Dingbat|Wingding/i.test(base) || (fontDesc && doc.getNum(fontDesc, 'Flags', 0) & 4) ? 'Builtin' : info.subtype === 'TrueType' ? 'WinAnsiEncoding' : 'StandardEncoding';
  if (baseEnc === 'MacExpertEncoding') baseEnc = 'Builtin';
  const codeMap = new Map<number, string>();
  if (baseEnc === 'StandardEncoding') {
    for (let c = 32; c < 127; c++) codeMap.set(c, c === 0x27 ? '’' : c === 0x60 ? '‘' : String.fromCharCode(c));
    for (const [c, u] of Object.entries(STANDARD_HI)) codeMap.set(+c, u);
  } else if (baseEnc !== 'Builtin') for (let c = 32; c < 256; c++) codeMap.set(c, baseEnc === 'MacRomanEncoding' && c >= 128 ? MAC_ROMAN_HI[c - 128] || '' : winAnsiToUnicode(c));
  if (enc instanceof Dict) {
    const diff = doc.getArray(enc, 'Differences') || [];
    let code = 0;
    for (const d of diff) { const v = doc.resolve<PdfObj>(d); if (typeof v === 'number') code = v; else if (isName(v)) { codeMap.set(code, glyphToUnicode(v.name)); code++; } }
  }
  for (const [c, u] of codeMap) if (!info.toUnicode.has(c) && u) info.toUnicode.set(c, u);
  // New text can be encoded only when the code-to-character table is certain: an encoding the font names
  // (WinAnsi or MacRoman), or the implied StandardEncoding of a Type 1 font that is not embedded. An
  // embedded font without a named encoding may use any table of its own.
  const certain = named === 'WinAnsiEncoding' || named === 'MacRomanEncoding' || (!named && !embedded && baseEnc === 'StandardEncoding');
  info.editable = (info.subtype === 'Type1' || info.subtype === 'TrueType' || info.subtype === 'MMType1') && certain && !(enc instanceof Dict && doc.getArray(enc, 'Differences')?.length) && (!embedded || !!widths);
  if (info.editable) for (const [c, u] of codeMap) if (u && !info.fromUnicode.has(u)) info.fromUnicode.set(u, c);
  return info;
}

const GLYPHS: Record<string, string> = { space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', bullet: '•', endash: '–', emdash: '—', quotedblleft: '“', quotedblright: '”', quotedblbase: '„', ellipsis: '…', fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ', ffl: 'ﬄ', copyright: '©', registered: '®', trademark: '™', degree: '°', section: '§', paragraph: '¶', dagger: '†', daggerdbl: '‡', periodcentered: '·', multiply: '×', divide: '÷', plusminus: '±', Euro: '€', sterling: '£', yen: '¥', cent: '¢', currency: '¤', eacute: 'é', egrave: 'è', ecircumflex: 'ê', edieresis: 'ë', aacute: 'á', agrave: 'à', acircumflex: 'â', adieresis: 'ä', atilde: 'ã', aring: 'å', ccedilla: 'ç', iacute: 'í', igrave: 'ì', icircumflex: 'î', idieresis: 'ï', ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocircumflex: 'ô', odieresis: 'ö', otilde: 'õ', oslash: 'ø', uacute: 'ú', ugrave: 'ù', ucircumflex: 'û', udieresis: 'ü', yacute: 'ý', ydieresis: 'ÿ', Eacute: 'É', Egrave: 'È', Aacute: 'Á', Agrave: 'À', Adieresis: 'Ä', Aring: 'Å', Ccedilla: 'Ç', Ntilde: 'Ñ', Oacute: 'Ó', Odieresis: 'Ö', Oslash: 'Ø', Uacute: 'Ú', Udieresis: 'Ü', germandbls: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', quoteleft2: '‘', guillemotleft: '«', guillemotright: '»', exclamdown: '¡', questiondown: '¿', onehalf: '½', onequarter: '¼', threequarters: '¾', ordfeminine: 'ª', ordmasculine: 'º', macron: '¯', acute: '´', cedilla: '¸', dieresis: '¨', tilde: '˜', circumflex: 'ˆ', caron: 'ˇ', breve: '˘', dotaccent: '˙', ring: '˚', ogonek: '˛', hungarumlaut: '˝', florin: 'ƒ', fraction: '⁄', perthousand: '‰', Scaron: 'Š', scaron: 'š', Zcaron: 'Ž', zcaron: 'ž', Ydieresis: 'Ÿ', Lslash: 'Ł', lslash: 'ł', dotlessi: 'ı', logicalnot: '¬', brokenbar: '¦', mu: 'µ', onesuperior: '¹', twosuperior: '²', threesuperior: '³', nbspace: ' ', sfthyphen: '-', Delta: 'Δ', Omega: 'Ω', pi: 'π', summation: '∑', product: '∏', radical: '√', infinity: '∞', notequal: '≠', lessequal: '≤', greaterequal: '≥', approxequal: '≈', partialdiff: '∂', integral: '∫', lozenge: '◊', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', checkmark: '✓', heart: '♥', diamond: '♦', club: '♣', spade: '♠' };
export function glyphToUnicode(g: string): string {
  if (g.length === 1) return g;
  if (GLYPHS[g]) return GLYPHS[g];
  let m = /^uni([0-9A-Fa-f]{4})/.exec(g); if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(g); if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^(?:g|cid|c|G)(\d+)$/.exec(g); if (m) return '';
  m = /^([A-Za-z])(\d+)$/.exec(g); if (m) return '';
  return g.length <= 2 ? g : '';
}

/** Decodes a string operand through the font. */
export function decodeString(font: FontInfo, s: PdfString): { codes: number[]; text: string } {
  const b = s.bytes;
  const codes: number[] = [];
  if (font.twoByte) for (let i = 0; i + 1 < b.length; i += 2) codes.push((b[i] << 8) | b[i + 1]);
  else for (let i = 0; i < b.length; i++) codes.push(b[i]);
  let text = '';
  for (const c of codes) {
    const u = font.toUnicode.get(c);
    text += u !== undefined ? u : font.twoByte ? '' : c >= 32 && c < 127 ? String.fromCharCode(c) : '';
  }
  return { codes, text };
}

export function encodeString(font: FontInfo, text: string): PdfString | null {
  const out: number[] = [];
  for (const ch of text) {
    let c = font.fromUnicode.get(ch);
    if (c === undefined) { const w = unicodeToWinAnsi(ch); if (w >= 0 && font.fromUnicode.size === 0) c = w; }
    if (c === undefined) return null;
    out.push(c);
  }
  return new PdfString(Uint8Array.from(out));
}

export interface PageText {
  runs: TextRun[]; images: ImageUse[]; ops: Op[];
  /** Some forms were not looked into (the work budget ran out, or they are nested deeper than 8): runs and images may be missing. */
  incomplete: boolean;
}

/**
 * Shared by one analysis and the forms it descends into: parsed form content, and how much work in forms
 * is still allowed (in operators; the default is about 20,000 small forms, or twenty million operators).
 * Forms drawn after that are skipped, so nested forms that multiply cannot stall the app.
 */
export interface FormWork { parsed: Map<PdfStream, Op[]>; opsLeft: number; /** Set when a form was skipped for the budget or the nesting limit. */ cutShort?: boolean }

/** Walks a page's content and reports where text strings and images are drawn (user space). */
export function analyzeContent(doc: PdfDocument, ops: Op[], resources: Dict | null, depth = 0, ctm0: Matrix = IDENTITY, shared: FormWork = { parsed: new Map(), opsLeft: 2e7 }): PageText {
  const runs: TextRun[] = [];
  const images: ImageUse[] = [];
  const fonts = new Map<string, FontInfo>();
  const fontRes = resources ? doc.getDict(resources, 'Font') : null;
  const xobjRes = resources ? doc.getDict(resources, 'XObject') : null;
  const fontOf = (n: string): FontInfo => { let f = fonts.get(n); if (!f) { f = fontInfo(doc, n, fontRes ? doc.getDict(fontRes, n) : null); fonts.set(n, f); } return f; };
  let ctm: Matrix = ctm0;
  // q/Q save and restore the whole graphics state, and the text state (font, size, spacing…) is part of it.
  const stack: { ctm: Matrix; font: FontInfo | null; size: number; charSp: number; wordSp: number; hscale: number; leading: number; rise: number }[] = [];
  let tm: Matrix = IDENTITY, tlm: Matrix = IDENTITY;
  let font: FontInfo | null = null, size = 0, charSp = 0, wordSp = 0, hscale = 1, leading = 0, rise = 0;
  const n = (v: PdfObj, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d);
  const showText = (opIndex: number, items: PdfObj[]) => {
    if (!font) font = fontOf('__none');
    const strings: PdfString[] = [];
    let text = '';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const trm = () => mul(mul([size * hscale, 0, 0, size, 0, rise], tm), ctm);
    const addBox = (w: number) => {
      const m = trm();
      const pts = [apply(m, 0, -0.25), apply(m, w, -0.25), apply(m, 0, 0.85), apply(m, w, 0.85)];
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    };
    for (const it of items) {
      if (typeof it === 'number') { tm = mul([1, 0, 0, 1, (-it / 1000) * size * hscale, 0], tm); continue; }
      if (!(it instanceof PdfString)) continue;
      strings.push(it);
      const { codes, text: t } = decodeString(font, it);
      text += t;
      let adv = 0;
      for (const c of codes) {
        const w = (font.widths.get(c) ?? font.defaultWidth) / 1000;
        const isSpace = !font.twoByte && c === 32;
        adv += w * size + charSp + (isSpace ? wordSp : 0);
      }
      const total = adv * hscale;
      addBox(total / (size * hscale || 1) * (size * hscale ? 1 : 0) || 0);
      // Advance in unscaled text space units: width / (size*hscale) → box above used glyph units; simpler: box from 0..total/size
      tm = mul([1, 0, 0, 1, total, 0], tm);
    }
    if (strings.length) {
      if (!isFinite(x0)) { const [x, y] = apply(trm(), 0, 0); x0 = x1 = x; y0 = y1 = y; }
      runs.push({ opIndex, text, box: [x0, y0, x1, y1], font: font.name, size, strings });
    }
  };
  ops.forEach((o, i) => {
    const a = o.args;
    switch (o.op) {
      case 'q': stack.push({ ctm, font, size, charSp, wordSp, hscale, leading, rise }); if (stack.length > 256) stack.shift(); break;
      case 'Q': { const s = stack.pop(); if (s) ({ ctm, font, size, charSp, wordSp, hscale, leading, rise } = s); break; }
      case 'cm': if (a.length >= 6) ctm = mul([n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])], ctm); break;
      case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
      case 'Tf': if (isName(a[0])) { font = fontOf(a[0].name); size = n(a[1]); } break;
      case 'Td': tlm = mul([1, 0, 0, 1, n(a[0]), n(a[1])], tlm); tm = tlm; break;
      case 'TD': leading = -n(a[1]); tlm = mul([1, 0, 0, 1, n(a[0]), n(a[1])], tlm); tm = tlm; break;
      case 'Tm': if (a.length >= 6) { tlm = [n(a[0]), n(a[1]), n(a[2]), n(a[3]), n(a[4]), n(a[5])]; tm = tlm; } break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
      case 'TL': leading = n(a[0]); break;
      case 'Tc': charSp = n(a[0]); break;
      case 'Tw': wordSp = n(a[0]); break;
      case 'Tz': hscale = n(a[0], 100) / 100; break;
      case 'Ts': rise = n(a[0]); break;
      case 'Tj': showText(i, [a[0]]); break;
      case "'": tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; showText(i, [a[0]]); break;
      case '"': wordSp = n(a[0]); charSp = n(a[1]); tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; showText(i, [a[2]]); break;
      case 'TJ': if (Array.isArray(a[0])) showText(i, a[0]); break;
      case 'Do': {
        if (!isName(a[0])) break;
        const x = xobjRes ? doc.get(xobjRes, a[0].name) : null;
        if (x instanceof PdfStream) {
          const sub = doc.getName(x, 'Subtype');
          if (sub === 'Image') {
            const pts = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
            images.push({ opIndex: i, name: a[0].name, box: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] });
          } else if (sub === 'Form' && depth >= 8) shared.cutShort = true;
          else if (sub === 'Form') {
            const mtx = doc.getArray(x, 'Matrix');
            const fm: Matrix = mtx && mtx.length >= 6 ? (mtx.map((v) => n(doc.resolve(v))) as Matrix) : IDENTITY;
            try {
              // Parsed once however often the form is drawn; the work budget stops forms that draw each
              // other many times over from multiplying without end.
              let formOps = shared.parsed.get(x);
              if (!formOps) { formOps = parseContent(doc.decoded(x)); shared.parsed.set(x, formOps); }
              // Setting a form up costs about as much as walking a thousand of its operators.
              shared.opsLeft -= formOps.length + 1000;
              if (shared.opsLeft < 0) { shared.cutShort = true; break; }
              const inner = analyzeContent(doc, formOps, doc.getDict(x, 'Resources') || resources, depth + 1, mul(fm, ctm), shared);
              for (const r of inner.runs) runs.push({ ...r, opIndex: i });
              for (const im of inner.images) images.push({ ...im, opIndex: i });
            } catch { /* damaged form */ }
          }
        }
        break;
      }
      case 'INLINE_IMAGE': {
        const pts = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
        images.push({ opIndex: i, name: '', inline: true, box: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] });
        break;
      }
    }
  });
  return { runs, images, ops, incomplete: !!shared.cutShort };
}

export const rectsOverlap = (a: [number, number, number, number], b: [number, number, number, number]): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/** The ops needed to draw a filled rectangle. */
export function rectOps(x: number, y: number, w: number, h: number, rgb: [number, number, number]): Op[] {
  return [{ op: 'q', args: [] }, { op: 'rg', args: rgb }, { op: 're', args: [x, y, w, h] }, { op: 'f', args: [] }, { op: 'Q', args: [] }];
}

export function textOps(font: string, size: number, x: number, y: number, text: PdfString, rgb: [number, number, number] = [0, 0, 0], extra: Op[] = []): Op[] {
  return [{ op: 'BT', args: [] }, { op: 'rg', args: rgb }, { op: 'Tf', args: [Name.get(font), size] }, ...extra, { op: 'Td', args: [x, y] }, { op: 'Tj', args: [text] }, { op: 'ET', args: [] }];
}
