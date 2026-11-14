/**
 * HTML and URL sanitizing for document-controlled content.
 *
 * Text from a document (font names, titles, field names, file names...) can reach a dialog as part of
 * an HTML string, and on Android the WebView origin can reach the native bridge. So every HTML string
 * shown in the UI is rebuilt here from an allow-list: only plain formatting elements and a few
 * attributes survive, whatever a missed escape let through.
 */

/** Schemes Anne's Folio will hand to the system browser or mail/phone apps. */
const SAFE_SCHEMES = /^(https?|mailto|tel|ftp|sms|geo):/i;

export function isSafeExternalUrl(url: string): boolean {
  const u = url.trim();
  return SAFE_SCHEMES.test(u);
}

/** Elements that are kept (in the HTML namespace only). Anything else is unwrapped: its text stays. */
const KEEP = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'span', 'div', 'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre', 'kbd', 'mark', 'hr', 'blockquote']);
/** Elements dropped together with everything inside them (their content is code, markup or a foreign vocabulary). */
const DROP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'head', 'title',
  'textarea', 'select', 'option', 'xmp', 'plaintext', 'noembed', 'noframes', 'audio', 'video', 'canvas', 'link', 'meta', 'base', 'portal']);
/** Declarations allowed in a style attribute: text formatting only, nothing that positions, layers or loads. */
const STYLE_PROPS = /^(color|background-color|font-weight|font-style|font-size|font-family|font-variant|text-decoration(-line|-style|-color)?|text-align|vertical-align|white-space|line-height|letter-spacing|margin(-top|-right|-bottom|-left)?|padding(-top|-right|-bottom|-left)?|border(-top|-right|-bottom|-left)?|border-radius|max-width|opacity)$/;
const STYLE_VALUE = /^[\w\s.,%#()'"+-]*$/;
/** Classes that only style text. Layout classes (overlays, dialogs, buttons) could dress injected text up as app chrome. */
const TEXT_CLASSES = /^ql-(help|warn|warn-inline|small|msg|dim|chip|badge|label|stats|table|shortcuts|notices|recovery-notes|field-heading)$/;

/** The style declarations of `css` that are plain formatting, or '' when none are. */
function safeStyle(css: string): string {
  const out: string[] = [];
  for (const decl of css.split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim().toLowerCase(), value = decl.slice(at + 1).trim();
    if (!STYLE_PROPS.test(prop) || !value || value.length > 120 || !STYLE_VALUE.test(value)) continue;
    // Only color functions: url(), image-set(), expression(), var() and attr() cannot load or leak anything.
    if ([...value.matchAll(/([\w-]*)\s*\(/g)].some((m) => !/^(rgba?|hsla?)$/i.test(m[1]))) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

// Read the tree through the prototype getters: a <form> with a child named "childNodes" or "attributes"
// shadows its own properties (DOM clobbering), and a sanitizer that trips over that leaves the rest unsanitized.
const getter = <T>(proto: object, name: string) => { const g = Object.getOwnPropertyDescriptor(proto, name)!.get!; return (n: unknown) => g.call(n) as T; };
let read: { root: (d: Document) => Element | null; type: (n: Node) => number; kids: (n: Node) => NodeList; text: (n: Node) => string | null; local: (e: Element) => string; ns: (e: Element) => string | null; attrs: (e: Element) => NamedNodeMap } | null = null;
function readers() {
  return (read ||= {
    root: getter<Element | null>(Document.prototype, 'documentElement'),
    type: getter<number>(Node.prototype, 'nodeType'), kids: getter<NodeList>(Node.prototype, 'childNodes'), text: getter<string | null>(Node.prototype, 'nodeValue'),
    local: getter<string>(Element.prototype, 'localName'), ns: getter<string | null>(Element.prototype, 'namespaceURI'), attrs: getter<NamedNodeMap>(Element.prototype, 'attributes'),
  });
}

const XHTML = 'http://www.w3.org/1999/xhtml';

function copy(from: Node, to: Node, doc: Document, depth: number): void {
  const r = readers();
  if (depth > 64) return;
  const kids = r.kids(from);
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    const type = r.type(n);
    if (type === 3) { to.appendChild(doc.createTextNode(r.text(n) || '')); continue; }
    if (type !== 1) continue; // comments, processing instructions
    const el = n as Element;
    const name = r.local(el).toLowerCase();
    if (r.ns(el) !== XHTML || DROP.has(name)) continue;
    if (!KEEP.has(name)) { copy(el, to, doc, depth + 1); continue; }
    const out = doc.createElement(name);
    const attrs = r.attrs(el);
    for (let k = 0; k < attrs.length; k++) {
      const a = attrs[k], an = a.name.toLowerCase(), v = a.value;
      if (an === 'class') { const c = v.split(/\s+/).filter((x) => TEXT_CLASSES.test(x)).join(' '); if (c) out.setAttribute('class', c); }
      else if (an === 'title' || an === 'lang' || an === 'dir') out.setAttribute(an, v);
      else if ((an === 'colspan' || an === 'rowspan') && /^\d{1,3}$/.test(v)) out.setAttribute(an, v);
      else if (an === 'style') { const s = safeStyle(v); if (s) out.setAttribute('style', s); }
      else if (an === 'href' && name === 'a' && (isSafeExternalUrl(v) || /^#[\w.:-]*$/.test(v.trim()))) {
        out.setAttribute('href', v.trim());
        // A link to the outside never opens in the app's own window (dialogs also route it through the system browser).
        if (!v.trim().startsWith('#')) { out.setAttribute('target', '_blank'); out.setAttribute('rel', 'noopener noreferrer'); }
      }
    }
    copy(el, out, doc, depth + 1);
    to.appendChild(out);
  }
}

/**
 * Parses `html` in an inert document and returns a fragment rebuilt from the allow-list: formatting
 * elements, tables, lists and links to web, mail or phone addresses, with class, title, a filtered
 * style and (on links) href. Scripts, event handlers, forms, images, frames, SVG/MathML and every
 * other attribute are gone. Use it for every HTML string that is shown, including ones built from literals.
 */
export function sanitizeHtml(html: unknown): DocumentFragment {
  const frag = document.createDocumentFragment();
  if (html == null || html === '') return frag;
  const src = new DOMParser().parseFromString(`<!doctype html><body>${String(html)}`, 'text/html');
  const root = readers().root(src); // <html>: its <head> is dropped, <body> is unwrapped
  if (root) copy(root, frag, document, 0);
  return frag;
}

/** Escape text for HTML element content and quoted attribute values. */
export function escHtml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
