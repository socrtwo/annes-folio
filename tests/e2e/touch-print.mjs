// Phone checks: a finger drag with the Pen tool draws (native scrolling used to cancel it after a few
// pixels), a plain finger drag with the Hand/Select tool still scrolls, and print pages stay in the
// page while the print UI is open (a phone browser returns from print() at once).
// Usage: npm run build && npm run e2e:touch   (set QF_URL to test an already-running server instead)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 4192;
let server = null;
let url = process.env.QF_URL;
if (!url) {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
  url = `http://localhost:${PORT}/`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const exe = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};
const browser = await chromium.launch(exe);
const failures = [];
const check = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => failures.push('pageerror: ' + e.message));
  await p.addInitScript(() => {
    localStorage.setItem('quillfolio.prefs.v1', JSON.stringify({ firstRun: false }));
    // A phone browser: print() returns at once and afterprint comes early. Printing goes through a
    // hidden frame, so stub print() on every frame as it is added.
    const stub = (w) => { w.print = () => { window.__printed = (window.__printed || 0) + 1; setTimeout(() => w.dispatchEvent(new Event('afterprint')), 50); }; };
    stub(window);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.tagName === 'IFRAME' && n.contentWindow) stub(n.contentWindow); }).observe(document, { childList: true, subtree: true });
  });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForSelector('.qf-page canvas');
  await p.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(p);
  const wait = (ms) => p.waitForTimeout(ms);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y]) => ({ x, y })) });
  const drag = async (from, to, steps = 15) => {
    await touch('touchStart', [from]); await wait(30);
    for (let i = 1; i <= steps; i++) { await touch('touchMove', [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]); await wait(16); }
    await touch('touchEnd', []); await wait(400);
  };

  // A three-page document, so there is something to scroll.
  await p.evaluate(async () => {
    const { PdfDocument } = await window.__qfEngine();
    const build = await window.__qfBuild();
    const d = PdfDocument.create();
    build.addBlankPage(d); build.addBlankPage(d); build.addBlankPage(d);
    await qf.exec('file.openDropped', [new File([d.save({ incremental: false })], 'touch.pdf', { type: 'application/pdf' })]);
    await new Promise((r) => setTimeout(r, 1200));
  });
  await p.waitForSelector('.qf-page[data-i="2"]');
  const box = await p.evaluate(() => { const r = document.querySelector('.qf-page[data-i="0"]').getBoundingClientRect(); return [r.left, r.top, r.width, Math.min(r.height, innerHeight - r.top - 80)]; });
  const scrollTop = () => p.evaluate(() => qf.viewer.scroll.scrollTop);

  // --- Pen: the stroke is drawn along the whole drag and the page does not scroll.
  await p.evaluate(() => qf.exec('comment.pen'));
  await wait(150);
  const s0 = await scrollTop();
  await drag([box[0] + box[2] * 0.2, box[1] + box[3] * 0.3], [box[0] + box[2] * 0.8, box[1] + box[3] * 0.9]);
  const ink = await p.evaluate(() => qf.viewer.annotsOf(0).filter((a) => a.subtype === 'Ink').length);
  check('finger drag with the Pen draws', ink, 1);
  check('finger drag with the Pen does not scroll', (await scrollTop()) - s0, 0);

  // --- Select tool: a finger drag scrolls.
  await p.evaluate(() => qf.viewer.setTool('select'));
  await wait(150);
  const s1 = await scrollTop();
  // Start clear of the ink stroke (x 20-80 %): a drag that starts on an annotation moves it.
  await drag([box[0] + box[2] * 0.08, box[1] + box[3] * 0.95], [box[0] + box[2] * 0.08, box[1] + box[3] * 0.2]);
  await wait(600);
  check('finger drag with Select scrolls', (await scrollTop()) - s1 > 50, true);

  // --- Print: the frame survives the early afterprint and the old 1.5 s timer.
  await p.evaluate(() => { Promise.resolve(qf.exec('file.quickPrint')).catch((e) => { window.__printErr = String(e); }); });
  await p.waitForFunction(() => window.__printed >= 1, null, { timeout: 15000 });
  await wait(3000);
  const frame = () => p.evaluate(() => [...document.querySelectorAll('iframe')].some((f) => f.contentDocument?.querySelector('.p img')));
  check('print frame kept while the print UI is open', await frame(), true);
  await p.touchscreen.tap(200, 880);
  await wait(2200);
  check('print frame removed afterwards', await frame(), false);
  check('print error', await p.evaluate(() => window.__printErr || null), null);
} finally {
  await browser.close();
  if (server) { try { process.kill(-server.pid); } catch { /* */ } }
}
if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exit(1); }
console.log('touch/print e2e: ok');
