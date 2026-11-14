/**
 * Content-Security-Policy for the browser, installed-PWA and Capacitor builds. It is inserted at startup as a
 * <meta> element rather than written into index.html: Capacitor on older Android WebViews injects its bridge as
 * an inline script before the page runs, which a static policy would block. The desktop app sets the header
 * itself (electron/main.cjs).
 *
 * What each directive is for:
 *   script-src   the app's own modules; WebAssembly (pdf.js decoders, Hunspell, tesseract, the on-device model);
 *                blob: for the modules the on-device model's runtime loads through blob URLs. Every script
 *                ships with the app: no CDN is allowed.
 *   worker-src   pdf.js, spelling and tesseract workers (same origin) and the on-device model worker (blob:).
 *   connect-src  AI services, dictionary and OCR language downloads (https); local model servers on this device
 *                (localhost, 127.0.0.1, and 10.0.2.2, which is "this computer" inside the Android emulator).
 *   img/media    page renderings, pictures and recordings are blob: and data: URLs.
 *   frame-src    the hidden print frame (same origin, about:blank) and PDF/attachment previews (blob:, data:).
 * No inline or eval'd script is allowed anywhere, so markup that reaches the page from a document cannot run.
 */
export const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://10.0.2.2:* data: blob:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * Whether to insert the policy. Not under Electron (it sends the header), and only on engines that know
 * 'wasm-unsafe-eval': Chromium 97+, Safari/iOS 16+, Firefox 102+. On anything older or unrecognized the
 * policy would stop WebAssembly (rendering, spelling, OCR), so none is set.
 */
export function shouldApplyCsp(userAgent: string, isElectron: boolean): boolean {
  const ua = String(userAgent || '');
  if (isElectron || /\bElectron\//.test(ua)) return false;
  const num = (re: RegExp): number => { const m = re.exec(ua); return m ? parseInt(m[1], 10) : NaN; };
  // Every browser on iOS and iPadOS uses the system WebKit, whatever its name.
  const ios = num(/\b(?:iPhone|iPad|iPod)\b.*?\bOS (\d+)[_.]/);
  if (!Number.isNaN(ios)) return ios >= 16;
  const chromium = num(/\b(?:Chrome|Chromium)\/(\d+)/);
  if (!Number.isNaN(chromium)) return chromium >= 97;
  const firefox = num(/\bFirefox\/(\d+)/);
  if (!Number.isNaN(firefox)) return firefox >= 102;
  const safari = /\bSafari\//.test(ua) ? num(/\bVersion\/(\d+)/) : NaN;
  if (!Number.isNaN(safari)) return safari >= 16;
  return false;
}

/**
 * The policy for a page address. On http(s) it is CSP_POLICY as written. An app served from its own scheme
 * (the iOS app: capacitor://localhost) also gets that origin spelled out next to every 'self', because
 * engines differ on whether 'self' covers a custom scheme. Null for file: pages, which have no origin to allow.
 */
export function cspFor(loc: { protocol: string; host: string }): string | null {
  if (loc.protocol === 'http:' || loc.protocol === 'https:') return CSP_POLICY;
  if (loc.protocol === 'file:' || !loc.host || !/^[a-z][a-z0-9+.-]*:$/i.test(loc.protocol)) return null;
  return CSP_POLICY.replace(/'self'/g, `'self' ${loc.protocol}//${loc.host}`);
}

/** Inserts the policy as the first element of <head>. False when the document already carries one or the page has no origin. */
export function installCsp(doc: Document = document, loc: { protocol: string; host: string } = doc.defaultView?.location || { protocol: 'https:', host: '' }): boolean {
  const policy = cspFor(loc);
  if (!policy || doc.querySelector('meta[http-equiv="Content-Security-Policy" i]')) return false;
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = policy;
  (doc.head || doc.documentElement).prepend(meta);
  return true;
}

// The development server needs inline modules and a WebSocket for hot reload, so the policy is for built pages only.
if (typeof document !== 'undefined' && typeof navigator !== 'undefined' && !import.meta.env?.DEV && shouldApplyCsp(navigator.userAgent, !!(window as any).quillDesktop)) installCsp();
