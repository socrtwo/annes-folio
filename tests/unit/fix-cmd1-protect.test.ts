import { describe, it, expect, vi } from 'vitest';
import { findTextRects, searchRegex, newOwnerPassword, PII_PATTERNS, type SearchItem } from '../../src/commands/protect';
import { signatureReport } from '../../src/commands/sign';
import type { SignatureInfo } from '../../src/pdf/structure';

const item = (str: string, x: number, y: number, w: number, extra: Partial<SearchItem> = {}): SearchItem => ({ str, x, y, w, h: 10, ...extra });
const overlaps = (a: number[], b: number[]) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

describe('Mark by Search (finding 15)', () => {
  it('finds a phrase split over two text items', () => {
    const items = [item('Dear John', 72, 700, 50), item(' ', 122, 700, 3), item('Smith, hello', 125, 700, 60)];
    const rects = findTextRects(items, searchRegex('John Smith'));
    expect(rects.length).toBe(2);
    expect(overlaps(rects[0], [72, 698, 122, 708])).toBe(true);
    expect(overlaps(rects[1], [125, 698, 185, 708])).toBe(true);
    // "John" is the second half of the first item, "Smith" the first half of the last.
    expect(rects[0][0]).toBeGreaterThan(90);
    expect(rects[1][2]).toBeLessThan(160);
  });
  it('finds a phrase wrapped onto the next line', () => {
    const items = [item('account number', 72, 700, 80, { hasEOL: true }), item('12345 is', 72, 688, 45)];
    const rects = findTextRects(items, searchRegex('number 12345'));
    expect(rects.length).toBe(2);
    expect(rects[0][1]).toBeGreaterThan(690);
    expect(rects[1][3]).toBeLessThan(700);
  });
  it('finds a number split by a kerning gap into adjacent items', () => {
    const items = [item('123-45-', 72, 700, 40), item('6789', 112, 700, 22)];
    expect(findTextRects(items, searchRegex(PII_PATTERNS[2].re, { regex: true })).length).toBe(2);
  });
  it('places a match by glyph widths, not by an average character width', () => {
    // 20 narrow letters, then the word: with an average width the box would start at about 72 + 200·20/26 ≈ 226.
    const it0 = item('iiiiiiiiiiiiiiiiiiiiSECRET', 72, 700, 200);
    const [r] = findTextRects([it0], searchRegex('SECRET'));
    expect(r[2]).toBeCloseTo(272.5, 0);
    expect(r[0]).toBeLessThan(180);
    expect(r[0]).toBeGreaterThan(160);
  });
  it('follows rotated text when the item carries its angle', () => {
    const [r] = findTextRects([item('abcSECRET', 100, 100, 90, { angle: Math.PI / 2 })], searchRegex('SECRET'));
    // The text runs upward from (100, 100): the match is in the upper part, about one line wide in x.
    expect(r[1]).toBeGreaterThan(120);
    expect(r[3]).toBeCloseTo(190.5, 0);
    expect(r[2] - r[0]).toBeLessThan(15);
  });
  it('honours whole words and case, also for regular expressions', () => {
    const items = [item('cat concatenate Cat', 72, 700, 100)];
    expect(findTextRects(items, searchRegex('cat')).length).toBe(3);
    expect(findTextRects(items, searchRegex('cat', { wholeWord: true })).length).toBe(2);
    expect(findTextRects(items, searchRegex('cat', { wholeWord: true, caseSensitive: true })).length).toBe(1);
    expect(findTextRects(items, searchRegex('c.t|dog', { regex: true, wholeWord: true })).length).toBe(2);
    expect(findTextRects(items, searchRegex('a.c', {})).length).toBe(0);
  });
  it('reports an invalid regular expression instead of matching nothing', () => {
    expect(() => searchRegex('(unclosed', { regex: true })).toThrow(/Not a valid regular expression/);
    expect(() => searchRegex('(unclosed', {})).not.toThrow();
  });
  it('skips empty matches', () => {
    expect(findTextRects([item('abc', 0, 0, 30)], /x*/g)).toEqual([]);
  });
});

describe('permissions passwords (finding 5)', () => {
  it('come from the cryptographic generator, never from Math.random', () => {
    const random = vi.spyOn(Math, 'random');
    const crypt = vi.spyOn(crypto, 'getRandomValues');
    const a = newOwnerPassword(), b = newOwnerPassword();
    expect(random).not.toHaveBeenCalled();
    expect(crypt).toHaveBeenCalledTimes(2);
    expect(a).toMatch(/^[A-HJ-NP-Z2-9]{5}(-[A-HJ-NP-Z2-9]{5}){3}$/);
    expect(a).not.toBe(b);
    random.mockRestore(); crypt.mockRestore();
  });
});

describe('Signature Details wording (finding 14)', () => {
  const sig = (over: Partial<SignatureInfo> = {}): SignatureInfo => ({ field: 'Sig1', signer: 'Alice', reason: '', location: '', date: null, filter: 'Adobe.PPKLite', subFilter: 'adbe.pkcs7.detached', byteRange: [0, 40, 60, 40], coversWholeFile: true, byteRangeStartsAtZero: true, gapIsContents: true, signed: true, contactInfo: '', ...over });

  it('never says a signature is valid or verified, and says what was not checked', () => {
    const all = [sig(), sig({ coversWholeFile: false }), sig({ gapIsContents: false }), sig({ byteRange: [], coversWholeFile: false, byteRangeStartsAtZero: false, gapIsContents: false }), sig({ signed: false })];
    const items = signatureReport(all, true);
    const text = items.map((i) => `${i.text} ${i.fix || ''}`).join('\n');
    expect(text).not.toMatch(/\b(is|are) valid\b|\bvalid signature|signed by|\bverified\b(?<!not verified)/i);
    for (const it of items.filter((i) => /contains a signature/.test(i.text))) {
      expect(it.text).toMatch(/Not verified/);
      expect(it.fix).toMatch(/Not checked: .*digest.*certificate/);
    }
    expect(items[0].level).toBe('warning'); // unsaved changes
    expect(items[1].level).toBe('info');
    expect(items[2].level).toBe('warning'); // data after the signature
    expect(items[2].fix).toMatch(/added after this signature/);
    expect(items[3].level).toBe('warning'); // gap is more than the signature value
    expect(items[4].level).toBe('warning'); // no byte range
    expect(items[5].text).toMatch(/not signed/);
  });
  it('presents the signer as the file\'s own statement', () => {
    const [it] = signatureReport([sig()]);
    expect(it.text).toMatch(/The file names "Alice" as the signer/);
    expect(signatureReport([sig({ byteRangeStartsAtZero: false })])[0].fix).toMatch(/does not start at the beginning/);
  });
});
