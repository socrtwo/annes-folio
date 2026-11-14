/**
 * Metrics of the standard 14 fonts Anne's Folio writes with (Helvetica, Times, Courier families), from
 * the public AFM files: glyph widths in 1/1000 em for ASCII 32–126, plus WinAnsi encoding helpers.
 */

export const HELVETICA_WIDTHS = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
export const HELVETICA_BOLD_WIDTHS = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
export const TIMES_WIDTHS = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541];
export const TIMES_BOLD_WIDTHS = [250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520];
export const COURIER_WIDTH = 600;

export type StdFont = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique' | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic' | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique' | 'Symbol' | 'ZapfDingbats';

export const STD_FONTS: StdFont[] = ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats'];

const COURIER_WIDTHS: number[] = new Array(95).fill(COURIER_WIDTH);

export function stdWidths(font: string): number[] {
  if (/^Courier/.test(font)) return COURIER_WIDTHS;
  if (/^Times/.test(font)) return /Bold/.test(font) ? TIMES_BOLD_WIDTHS : TIMES_WIDTHS;
  return /Bold/.test(font) ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
}

// WinAnsi (cp1252) code points for 0x80–0x9F.
const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };

/** Text as WinAnsi bytes; characters outside the encoding become "?". */
export function winAnsiBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c > 255 || (c >= 0x80 && c < 0xa0)) c = CP1252[c] ?? 63;
    if (c < 32 && c !== 9) c = 32;
    out.push(c);
  }
  return Uint8Array.from(out);
}

/** Width of text in a standard font at `size` points. */
export function textWidth(s: string, font: string, size: number): number {
  const w = stdWidths(font);
  let total = 0;
  for (const b of winAnsiBytes(s)) total += b >= 32 && b <= 126 ? w[b - 32] : /^Courier/.test(font) ? COURIER_WIDTH : 556;
  return (total / 1000) * size;
}

/** Width of one character in 1/1000 em (the same rule as textWidth). */
function charUnits(ch: string, font: string): number {
  const b = winAnsiBytes(ch)[0];
  return b >= 32 && b <= 126 ? stdWidths(font)[b - 32] : /^Courier/.test(font) ? COURIER_WIDTH : 556;
}

/** Breaks text into lines that fit a width. */
export function wrapText(text: string, font: string, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      if (!w) continue;
      const cand = line + w;
      if (textWidth(cand, font, size) <= width || !line.trim()) {
        line = cand;
        // A single word longer than the line: break it by characters, in one pass over the word (measuring
        // every prefix again for every piece made a long unbroken token take minutes).
        if (textWidth(line, font, size) > width) {
          const chars = [...line];
          let start = 0, units = 0;
          for (let i = 0; i < chars.length; i++) {
            const u = charUnits(chars[i], font);
            if (i > start && ((units + u) / 1000) * size > width) { lines.push(chars.slice(start, i).join('')); start = i; units = 0; }
            units += u;
          }
          line = chars.slice(start).join('');
        }
      } else { lines.push(line.replace(/\s+$/, '')); line = w.trimStart(); }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}
