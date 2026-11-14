/** Tiny DOM helpers. */
import { sanitizeHtml } from '../util/sanitize';

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any> & { class?: string; style?: string | Partial<CSSStyleDeclaration>; on?: Record<string, (e: any) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') {
        if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v);
      } else if (k === 'on') {
        for (const [ev, fn] of Object.entries(v as Record<string, any>)) el.addEventListener(ev, fn);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'html') {
        // Never raw innerHTML: the string is rebuilt from an allow-list, so text from a document cannot become markup that runs.
        el.replaceChildren(sanitizeHtml(v));
      } else if (/^on/i.test(k)) {
        continue; // an event handler is a function (handled above), never an attribute string
      } else if (k in el && typeof v !== 'string') {
        (el as any)[k] = v;
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function icon(name: string | undefined, extra = ''): HTMLElement {
  const s = document.createElement('span');
  s.className = 'ql-icon ' + extra;
  s.textContent = name || 'circle';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function isPhone(): boolean {
  return window.matchMedia('(max-width: 700px)').matches;
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: any;
  return ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

export function download(data: Blob, name: string): void {
  const url = URL.createObjectURL(data);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function readFileAsDataURL(f: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: 'display:none' }) as HTMLInputElement;
    inp.multiple = multiple;
    document.body.appendChild(inp);
    inp.addEventListener('change', () => { resolve(inp.files ? [...inp.files] : []); inp.remove(); });
    inp.addEventListener('cancel', () => { resolve([]); inp.remove(); });
    inp.click();
  });
}
