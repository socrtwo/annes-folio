/** Large documents go to the pdf.js worker in ranges: the app's bytes are never transferred away or copied whole. */
import { describe, it, expect } from 'vitest';
import { rangeSource } from '../../src/view/pdfjs';

describe('rangeSource', () => {
  it('answers each range with the bytes asked for, leaving the document bytes usable', () => {
    const bytes = new Uint8Array(1000).map((_, i) => i & 255);
    const t = rangeSource(bytes);
    const got: { begin: number; chunk: Uint8Array }[] = [];
    t.transportReady((a: any) => got.push({ begin: a.begin, chunk: a.chunk }));
    t.requestDataRange(100, 164);
    t.requestDataRange(990, 1100); // past the end: clamped
    expect(t.length).toBe(1000);
    expect(got[0].begin).toBe(100);
    expect([...got[0].chunk]).toEqual([...bytes.subarray(100, 164)]);
    expect(got[1].chunk.length).toBe(10);
    // A view into the document: pdf.js copies it before transferring (it is not a whole buffer), so nothing is detached.
    expect(got[0].chunk.buffer).toBe(bytes.buffer);
    expect(got[0].chunk.byteLength).not.toBe(bytes.buffer.byteLength);
    expect(bytes.length).toBe(1000);
  });
});
