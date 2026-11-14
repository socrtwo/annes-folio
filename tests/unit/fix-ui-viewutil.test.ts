import { describe, it, expect } from 'vitest';
import { totalRotation, pageToCss, cssToPage, outputScale, wheelZoomFactor, drawingOnDown, textFromItems, searchRegex, searchItems, coalesce, jobQueue, type TextItemLike, type Rect4 } from '../../src/view/viewutil';

describe('page rotation', () => {
  it("adds the page's own /Rotate to the view rotation", () => {
    expect(totalRotation(90, 0)).toBe(90);      // was 0: the viewer passed only the view rotation to pdf.js
    expect(totalRotation(90, 270)).toBe(0);
    expect(totalRotation(undefined, 180)).toBe(180);
    expect(totalRotation(-90, 0)).toBe(270);
  });
  it('maps PDF points to the rotated page box and back', () => {
    const box: Rect4 = [10, 20, 210, 320]; // 200 x 300
    expect(pageToCss(box, 0, 2, 10, 320)).toEqual([0, 0]);
    expect(pageToCss(box, 90, 2, 10, 20)).toEqual([0, 0]);       // bottom-left corner turns to the top-left
    expect(pageToCss(box, 90, 2, 210, 320)).toEqual([600, 400]);
    expect(pageToCss(box, 180, 2, 210, 20)).toEqual([0, 0]);
    expect(pageToCss(box, 270, 2, 210, 320)).toEqual([0, 0]);
    for (const rot of [0, 90, 180, 270]) {
      const [cx, cy] = pageToCss(box, rot, 1.5, 55, 140);
      const [x, y] = cssToPage(box, rot, 1.5, cx, cy);
      expect([Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6], String(rot)).toEqual([55, 140]);
    }
  });
});

describe('canvas size and zoom steps', () => {
  it('caps the bitmap at the pixel budget', () => {
    expect(outputScale(612, 792, 4 / 3, 2, 16e6)).toBeCloseTo(8 / 3);       // 100% on a 2x screen fits
    const out = outputScale(612, 792, (4 / 3) * 8, 3, 16e6);                 // 800% on a 3x screen: 496 MP before
    expect(612 * 792 * out * out).toBeLessThanOrEqual(16e6 * 1.0001);
  });
  it('follows the size of a trackpad pinch and steps for wheel notches', () => {
    let z = 1;
    for (let i = 0; i < 10; i++) z *= wheelZoomFactor(-1);
    expect(z).toBeLessThan(1.12);                 // ten tiny deltas were 1.1^10 = 2.59x
    expect(wheelZoomFactor(-100)).toBeCloseTo(1.1);
    expect(wheelZoomFactor(100)).toBeCloseTo(1 / 1.1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(Math.pow(1.1, 0.99));   // three lines, Firefox
  });
});

describe('polygon, polyline and cloud keep their points', () => {
  it('a second click continues the same drawing', () => {
    const first = drawingOnDown('polygon', null, 0, [1, 1]);
    first.pts.push([5, 5]);
    expect(drawingOnDown('polygon', first, 0, [9, 9])).toBe(first);       // was replaced by a new one-point drawing
    expect(drawingOnDown('polygon', first, 1, [9, 9]).pts).toEqual([[9, 9]]); // another page starts over
    expect(drawingOnDown('ink', first, 0, [9, 9]).pts).toEqual([[9, 9]]);
  });
});

describe('page text', () => {
  const line = (str: string, y: number, hasEOL = true) => ({ str, transform: [1, 0, 0, 1, 72, y], height: 11, hasEOL });
  it('gives one line break per line and a blank line between paragraphs', () => {
    const text = textFromItems([line('Alpha beta', 700), line('gamma delta.', 686), line('New paragraph', 650), line('ends here.', 636, false)]);
    expect(text).toBe('Alpha beta\ngamma delta.\n\nNew paragraph\nends here.'); // every line was followed by a blank one
  });
  it('breaks lines that have no end-of-line flag', () => {
    expect(textFromItems([line('one', 700, false), line('two', 686, false)])).toBe('one\ntwo');
    expect(textFromItems([{ str: 'a', transform: [1, 0, 0, 1, 0, 700], height: 10 }, { str: ' ', transform: [1, 0, 0, 1, 5, 700], height: 10 }, { str: 'b', transform: [1, 0, 0, 1, 9, 700], height: 10 }])).toBe('a b');
  });
});

describe('search over a page', () => {
  const it0 = (str: string, x: number, y: number, hasEOL = false): TextItemLike => ({ str, x, y, w: str.length * 5, h: 10, hasEOL });
  const items = [it0('alpha beta omicron', 0, 700, true), it0('pi rho both', 0, 686, true), it0('ere', 0, 672)];

  it('does not glue the words of two lines together', () => {
    expect(searchItems(items, searchRegex('omicronpi'))).toHaveLength(0);   // 351 phantom hits in the review
    expect(searchItems(items, searchRegex('there'))).toHaveLength(0);
  });
  it('finds a phrase across a line break, with a rectangle on each line', () => {
    const m = searchItems(items, searchRegex('omicron pi'));
    expect(m).toHaveLength(1);
    expect(m[0].item).toBe(0);
    expect(m[0].rects).toHaveLength(2);
    expect(m[0].rects[0][0]).toBeCloseTo(11 * 5);   // "omicron" starts at character 11 of the first item
    expect(m[0].rects[1][2]).toBeCloseTo(2 * 5);    // "pi" ends at character 2 of the second
  });
  it('finds a phrase spread over three items of one line', () => {
    const three = [it0('hello', 0, 700), it0(' ', 25, 700), it0('world', 30, 700)];
    expect(searchItems(three, searchRegex('hello world'))[0].rects).toHaveLength(3);
  });
  it('matches whole words with letters outside ASCII and ignores case unless asked', () => {
    const fr = [it0('un café noir, Résumé', 0, 700)];
    expect(searchItems(fr, searchRegex('café', { wholeWord: true }))).toHaveLength(1);    // \b never matched after é
    expect(searchItems(fr, searchRegex('caf', { wholeWord: true }))).toHaveLength(0);
    expect(searchItems(fr, searchRegex('résumé', { wholeWord: true }))).toHaveLength(1);
    expect(searchItems(fr, searchRegex('résumé', { wholeWord: true, caseSensitive: true }))).toHaveLength(0);
    expect(searchItems([it0('a.b (c)', 0, 0)], searchRegex('.b (c)'))).toHaveLength(1);   // the query is literal text
  });
});

describe('coalesced reloads and the thumbnail queue', () => {
  it('six calls in a row run the job twice, and every caller waits for the run that covers it', async () => {
    let runs = 0, running = 0, overlap = false;
    const job = coalesce(async () => { runs++; if (++running > 1) overlap = true; await new Promise((r) => setTimeout(r, 5)); running--; });
    await Promise.all([job(), job(), job(), job(), job(), job()]);   // was one load per call, all but two leaked
    expect(runs).toBe(2);
    expect(overlap).toBe(false);
    await job();
    expect(runs).toBe(3);
  });
  it('a failing run does not block the next one', async () => {
    let n = 0;
    const job = coalesce(async () => { if (++n === 1) throw new Error('first'); });
    await expect(job()).rejects.toThrow('first');
    await job();
    expect(n).toBe(2);
  });
  it('runs at most `limit` jobs at a time and can drop what is waiting', async () => {
    const q = jobQueue(2);
    let running = 0, peak = 0, done = 0;
    const job = async () => { peak = Math.max(peak, ++running); await new Promise((r) => setTimeout(r, 3)); running--; done++; };
    for (let i = 0; i < 6; i++) q.add(job);
    await new Promise((r) => setTimeout(r, 40));
    expect(peak).toBe(2);
    expect(done).toBe(6);
    for (let i = 0; i < 5; i++) q.add(job);
    q.clear();
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(8);   // the two that had started finish, the three waiting were dropped
  });
});
