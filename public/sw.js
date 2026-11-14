// Anne's Folio service worker: makes the web app (and the ChromeOS / desktop-browser install) work
// offline.
//
// scripts/gen-sw-precache.mjs runs after `vite build` and fills in the two values below in dist/sw.js:
// a build id and the list of the build's files. Without it (this file as it is in public/) the worker
// still works: it caches the start page and then every file as it is fetched.
//
//  - Install fetches every listed file into a cache named after the build, so the app starts offline
//    after ONE visit and all files of a cache belong to the same build.
//  - Pages are network-first, so an update shows on the next visit; only a good response for the start
//    page itself is stored as the offline start page.
//  - Hashed files under assets/ never change: cache-first. Everything else of this origin (pdf.js
//    fonts and decoders, tesseract) is network-first with the cache as the offline fallback, so a new
//    build never runs with an old copy of an unhashed file.
//  - Only GET requests to this origin are handled: AI provider calls, OAuth and downloads from other
//    origins never pass through here.
const BUILD_ID = /*__BUILD_ID__*/ 'dev';
const PRECACHE = /*__PRECACHE__*/ [];

const PREFIX = 'quillfolio-';
const CACHE = PREFIX + BUILD_ID;
const CORE = ['./', './index.html', './manifest.webmanifest'];
const SCOPE = new URL('./', self.location.href);
const INDEX = new URL('./index.html', SCOPE).href;

const isStartPage = (url) => url.origin === SCOPE.origin && (url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html');
const storable = (res) => !!res && res.status === 200 && res.type === 'basic';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 'reload' skips the HTTP cache: the copy stored for this build is the server's current file.
    await c.addAll(CORE.map((u) => new Request(u, { cache: 'reload' })));
    // One missing or failing file must not keep the whole worker from installing; it is fetched when first used.
    let i = 0;
    const next = async () => { while (i < PRECACHE.length) { const u = PRECACHE[i++]; try { const res = await fetch(new Request(u, { cache: 'reload' })); if (storable(res)) await c.put(u, res); } catch { /* offline or gone */ } } };
    await Promise.all([next(), next(), next(), next(), next(), next()]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Only this app's caches (other apps on the same origin and downloaded AI models have their own), and
    // the build before this one stays: a window still running it can load the parts it has not needed yet.
    const mine = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== CACHE && k !== PREFIX + 'dev').sort();
    const legacy = mine.filter((k) => !/^quillfolio-[0-9a-z]{8,}-[0-9a-f]{8}$/.test(k));
    const builds = mine.filter((k) => !legacy.includes(k));
    await Promise.all([...legacy, ...builds.slice(0, -1)].map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE.href)) return;
  if (req.headers.has('range')) return; // partial responses cannot be cached; let the browser handle them
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        // Only the start page, and only when it loaded properly: an error page or another file opened in
        // a tab must never become what the app shows offline.
        if (storable(res) && isStartPage(url)) { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(INDEX, copy))); }
        return res;
      } catch (err) {
        // This build's start page first (an earlier build's cache may still be there).
        const c = await caches.open(CACHE);
        const page = isStartPage(url) || !/\.[a-z0-9]+$/i.test(url.pathname);
        const hit = page ? (await c.match(INDEX)) || (await caches.match(INDEX)) : (await c.match(req)) || (await caches.match(req));
        if (hit) return hit;
        throw err;
      }
    })());
    return;
  }
  const hashed = url.pathname.startsWith(SCOPE.pathname + 'assets/');
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (hashed) {
      // Also an earlier build's cache: a window that started before an update asks for that build's files.
      const hit = (await c.match(req)) || (await caches.match(req));
      if (hit) return hit;
      const res = await fetch(req);
      if (storable(res)) e.waitUntil(c.put(req, res.clone()));
      return res;
    }
    try {
      const res = await fetch(req);
      if (storable(res)) e.waitUntil(c.put(req, res.clone()));
      return res;
    } catch (err) {
      const hit = (await c.match(req)) || (await caches.match(req));
      if (hit) return hit;
      throw err;
    }
  })());
});
