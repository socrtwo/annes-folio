/**
 * Tokenizer and object parser for PDF syntax (ISO 32000-1 §7.2–7.3). Tolerant by design: a
 * damaged file is parsed as far as it goes and the repair pipeline decides what to do with the rest.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, latin1 } from './objects';

export type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: PdfString }
  | { t: 'name'; v: string }
  | { t: 'delim'; v: '[' | ']' | '<<' | '>>' | '{' | '}' }
  | { t: 'kw'; v: string }
  | { t: 'eof' };

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
export const isWhite = (c: number): boolean => WS[c] === 1;
export const isDelim = (c: number): boolean => DELIM[c] === 1;
export const isRegular = (c: number): boolean => !WS[c] && !DELIM[c];
const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 16; i++) { HEX['0123456789abcdef'.charCodeAt(i)] = i; HEX['0123456789ABCDEF'.charCodeAt(i)] = i; }

export class Lexer {
  constructor(public buf: Uint8Array, public pos = 0) {}

  skipWs(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS[c]) this.pos++;
      else if (c === 0x25) { while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++; } // comment
      else break;
    }
  }

  peekByte(): number { return this.pos < this.buf.length ? this.buf[this.pos] : -1; }

  next(): Token {
    const b = this.buf;
    // A loop, not recursion: a long run of stray ')' or '>' must not grow the stack.
    for (;;) {
      this.skipWs();
      if (this.pos >= b.length) return { t: 'eof' };
      const c = b[this.pos];
      if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) return this.number();
      if (c === 0x28) return { t: 'str', v: this.literalString() };
      if (c === 0x2f) return { t: 'name', v: this.name() };
      if (c === 0x3c) {
        if (b[this.pos + 1] === 0x3c) { this.pos += 2; return { t: 'delim', v: '<<' }; }
        return { t: 'str', v: this.hexString() };
      }
      if (c === 0x3e) {
        if (b[this.pos + 1] === 0x3e) { this.pos += 2; return { t: 'delim', v: '>>' }; }
        this.pos++; continue; // stray '>'
      }
      if (c === 0x5b) { this.pos++; return { t: 'delim', v: '[' }; }
      if (c === 0x5d) { this.pos++; return { t: 'delim', v: ']' }; }
      if (c === 0x7b) { this.pos++; return { t: 'delim', v: '{' }; }
      if (c === 0x7d) { this.pos++; return { t: 'delim', v: '}' }; }
      if (c === 0x29) { this.pos++; continue; } // stray ')'
      const start = this.pos;
      while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
      if (this.pos === start) { this.pos++; continue; }
      return { t: 'kw', v: latin1(b, start, this.pos) };
    }
  }

  private number(): Token {
    const b = this.buf;
    let s = '';
    while (this.pos < b.length && isRegular(b[this.pos])) { s += String.fromCharCode(b[this.pos]); this.pos++; }
    // Tolerate things like "--5", "3.4.5", ".5", "6." and junk suffixes.
    const m = /^[+-]*(\d*\.?\d*)/.exec(s.replace(/^([+-])[+-]+/, '$1'));
    const core = m ? m[0] : '';
    let v = parseFloat(core.replace(/^([+-]*)/, (x) => (x.includes('-') ? '-' : '')));
    if (!isFinite(v)) v = 0;
    if (!core || core === '-' || core === '+' || core === '.') {
      // Not a number after all: a keyword that starts with a sign or dot.
      if (!/^[+-.]+$/.test(s)) return { t: 'kw', v: s };
      v = 0;
    }
    return { t: 'num', v };
  }

  /** A name as its bytes (one char per byte) so it is written back exactly; nameText() decodes it for display. */
  private name(): string {
    const b = this.buf;
    this.pos++; // '/'
    let s = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      let c = b[this.pos++];
      if (c === 0x23 && this.pos + 1 < b.length) {
        const hi = HEX[b[this.pos]], lo = HEX[b[this.pos + 1]];
        if (hi >= 0 && lo >= 0) { c = hi * 16 + lo; this.pos += 2; } // a "#" without two hex digits stays a "#"
      }
      s += String.fromCharCode(c);
    }
    return s;
  }

  private literalString(): PdfString {
    const b = this.buf;
    this.pos++; // '('
    let depth = 1;
    const out: number[] = [];
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5c) { // backslash
        if (this.pos >= b.length) break;
        c = b[this.pos++];
        switch (c) {
          case 0x6e: out.push(10); break; // n
          case 0x72: out.push(13); break; // r
          case 0x74: out.push(9); break; // t
          case 0x62: out.push(8); break; // b
          case 0x66: out.push(12); break; // f
          case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break; // line continuation
          case 0x0a: break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
              out.push(v & 0xff);
            } else out.push(c);
        }
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { depth--; if (!depth) break; out.push(c); }
      else if (c === 0x0d) { out.push(10); if (b[this.pos] === 0x0a) this.pos++; }
      else out.push(c);
    }
    return new PdfString(Uint8Array.from(out));
  }

  private hexString(): PdfString {
    const b = this.buf;
    this.pos++; // '<'
    const out: number[] = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      let v = -1;
      if (c >= 0x30 && c <= 0x39) v = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
      else if (WS[c]) continue;
      else continue; // junk inside a hex string is ignored
      if (hi < 0) hi = v; else { out.push(hi * 16 + v); hi = -1; }
    }
    if (hi >= 0) out.push(hi * 16);
    return new PdfString(Uint8Array.from(out), true);
  }

  /** Finds the next occurrence of an ASCII string at or after `from`; -1 when absent. */
  static find(buf: Uint8Array, s: string, from = 0, to = buf.length): number {
    const n = s.length;
    const first = s.charCodeAt(0);
    outer: for (let i = Math.max(0, from); i <= Math.min(buf.length, to) - n; i++) {
      if (buf[i] !== first) continue;
      for (let j = 1; j < n; j++) if (buf[i + j] !== s.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }
  static findLast(buf: Uint8Array, s: string, from = buf.length): number {
    const n = s.length;
    outer: for (let i = Math.min(from, buf.length - n); i >= 0; i--) {
      for (let j = 0; j < n; j++) if (buf[i + j] !== s.charCodeAt(j)) continue outer;
      return i;
    }
    return -1;
  }
}

/** Resolves an indirect object's stream /Length (which may itself be indirect). */
export type LengthResolver = (o: PdfObj) => PdfObj;

export class Parser {
  lexer: Lexer;
  /** The last keyword the parser stopped at (e.g. 'endobj', 'stream'), for callers. */
  lastKeyword = '';
  /** `refs: false` is for content streams, where "n g R" cannot occur and numbers need no lookahead. */
  constructor(buf: Uint8Array, pos = 0, private resolve: LengthResolver = (o) => o, private refs = true) {
    this.lexer = new Lexer(buf, pos);
  }
  get pos(): number { return this.lexer.pos; }
  set pos(v: number) { this.lexer.pos = v; }

  /** Parses one object. Keywords other than true/false/null are returned as {kw}. */
  parse(tok: Token = this.lexer.next(), depth = 0): PdfObj | { kw: string } {
    if (depth > 300) return null;
    switch (tok.t) {
      case 'eof': return { kw: 'EOF' };
      case 'num': {
        // Look ahead for "gen R" (a reference). The usual case (digits and white space) is checked on the
        // bytes, so a long array of numbers is not tokenized three times over.
        if (!this.refs || !Number.isInteger(tok.v) || tok.v < 0) return tok.v;
        const b = this.lexer.buf;
        let p = this.lexer.pos;
        while (p < b.length && isWhite(b[p])) p++;
        if (b[p] !== 0x25) {
          const d0 = p;
          while (p < b.length && b[p] >= 0x30 && b[p] <= 0x39) p++;
          if (p === d0 || p - d0 > 10 || p >= b.length || !(isWhite(b[p]) || b[p] === 0x25)) return tok.v;
          if (b[p] !== 0x25) {
            let gen = 0;
            for (let i = d0; i < p; i++) gen = gen * 10 + (b[i] - 0x30);
            while (p < b.length && isWhite(b[p])) p++;
            if (b[p] !== 0x25) {
              if (b[p] === 0x52 && (p + 1 >= b.length || !isRegular(b[p + 1]))) { this.lexer.pos = p + 1; return new Ref(tok.v, gen); }
              return tok.v;
            }
          }
        }
        // A comment sits between the tokens: tokenize.
        const save = this.lexer.pos;
        const t2 = this.lexer.next();
        if (t2.t === 'num' && Number.isInteger(t2.v) && t2.v >= 0) {
          const t3 = this.lexer.next();
          if (t3.t === 'kw' && t3.v === 'R') return new Ref(tok.v, t2.v);
        }
        this.lexer.pos = save;
        return tok.v;
      }
      case 'str': return tok.v;
      case 'name': return Name.get(tok.v);
      case 'delim':
        if (tok.v === '[') {
          const arr: PdfObj[] = [];
          for (;;) {
            const t = this.lexer.next();
            if (t.t === 'eof') break;
            if (t.t === 'delim' && t.v === ']') break;
            if (t.t === 'delim' && t.v === '>>') continue; // stray
            if (t.t === 'kw' && (t.v === 'endobj' || t.v === 'endstream')) { this.lastKeyword = t.v; break; }
            const v = this.parse(t, depth + 1);
            if (v && typeof v === 'object' && 'kw' in v) { if (v.kw === 'EOF') break; continue; }
            arr.push(v as PdfObj);
          }
          return arr;
        }
        if (tok.v === '<<') {
          const d = new Dict();
          for (;;) {
            const t = this.lexer.next();
            if (t.t === 'eof') break;
            if (t.t === 'delim' && t.v === '>>') break;
            if (t.t === 'kw' && (t.v === 'endobj' || t.v === 'stream' || t.v === 'endstream')) { this.lexer.pos -= t.v.length; break; }
            if (t.t !== 'name') { this.parse(t, depth + 1); continue; } // value without a key: skip it
            const t2 = this.lexer.next();
            if (t2.t === 'delim' && t2.v === '>>') { d.set(t.v, null); break; }
            const v = this.parse(t2, depth + 1);
            if (v && typeof v === 'object' && 'kw' in v) { if (v.kw === 'EOF') break; continue; }
            d.set(t.v, v as PdfObj);
          }
          // A stream follows?
          const save = this.lexer.pos;
          const t = this.lexer.next();
          if (t.t === 'kw' && t.v === 'stream') return this.readStream(d);
          this.lexer.pos = save;
          return d;
        }
        if (tok.v === ']' || tok.v === '>>' || tok.v === '}' || tok.v === '{') return this.parse(this.lexer.next(), depth + 1);
        return null;
      case 'kw':
        if (tok.v === 'true') return true;
        if (tok.v === 'false') return false;
        if (tok.v === 'null') return null;
        this.lastKeyword = tok.v;
        return { kw: tok.v };
    }
  }

  /** Reads stream data after the `stream` keyword, trusting /Length only when it ends at `endstream`. */
  private readStream(dict: Dict): PdfStream {
    const b = this.lexer.buf;
    let p = this.lexer.pos;
    if (b[p] === 0x0d) p++;
    if (b[p] === 0x0a) p++;
    const start = p;
    let len = -1;
    const L = this.resolve(dict.get('Length') ?? null);
    if (typeof L === 'number' && L >= 0 && start + L <= b.length) {
      // Verify: whitespace then "endstream" within a few bytes.
      let q = start + L;
      let k = 0;
      while (k < 4 && q < b.length && isWhite(b[q])) { q++; k++; }
      if (Lexer.find(b, 'endstream', q, q + 9) === q) len = L;
    }
    if (len < 0) {
      // Search for endstream; trim the EOL that precedes it.
      let e = Lexer.find(b, 'endstream', start);
      if (e < 0) {
        // Truncated: maybe "endobj" or the next object; otherwise to the end of the file.
        e = Lexer.find(b, 'endobj', start);
        if (e < 0) e = b.length;
      }
      let end = e;
      if (end > start && b[end - 1] === 0x0a) end--;
      if (end > start && b[end - 1] === 0x0d) end--;
      len = end - start;
      dict.set('Length', len);
    }
    const raw = b.subarray(start, start + len);
    const after = Lexer.find(b, 'endstream', start + len, start + len + 32);
    this.lexer.pos = after >= 0 ? after + 9 : start + len;
    return new PdfStream(dict, raw);
  }

  /** Parses `num gen obj … endobj` at the current position. Returns null when it is not there. */
  parseIndirect(): { num: number; gen: number; obj: PdfObj } | null {
    const t1 = this.lexer.next();
    const t2 = this.lexer.next();
    const t3 = this.lexer.next();
    if (t1.t !== 'num' || t2.t !== 'num' || t3.t !== 'kw' || t3.v !== 'obj') return null;
    const v = this.parse();
    const obj = v && typeof v === 'object' && 'kw' in v ? null : (v as PdfObj);
    // Skip to endobj if it is close by.
    const save = this.lexer.pos;
    const t = this.lexer.next();
    if (!(t.t === 'kw' && t.v === 'endobj')) this.lexer.pos = save;
    return { num: t1.v, gen: t2.v, obj };
  }
}

/** Parses a standalone object from bytes (e.g. an object stream entry or a content token). */
export function parseObject(buf: Uint8Array, pos = 0, resolve?: LengthResolver): PdfObj {
  const v = new Parser(buf, pos, resolve).parse();
  return v && typeof v === 'object' && 'kw' in v ? null : (v as PdfObj);
}
