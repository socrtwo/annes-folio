/** Dialogs, prompts, menus, toasts and color pickers. */
import { h, icon, clear, isPhone } from './dom';
import type { MenuEntry } from '../commands/registry';
import { sanitizeHtml } from '../util/sanitize';
import { openExternal } from '../platform/native';

// ------------------------------------------------------------------------------------------
// Toast

export function toast(msg: string, opts: { action?: string; onAction?: () => void; ms?: number } = {}): void {
  const host = document.querySelector('.ql-toasts') || document.body.appendChild(h('div', { class: 'ql-toasts' }));
  const t = h('div', { class: 'ql-toast', role: 'status' }, h('span', null, msg));
  if (opts.action) t.appendChild(h('button', { class: 'ql-link', onclick: () => { opts.onAction?.(); t.remove(); } }, opts.action));
  host.appendChild(t);
  placeToasts(host as HTMLElement);
  setTimeout(() => t.classList.add('ql-out'), opts.ms ?? 2800);
  setTimeout(() => t.remove(), (opts.ms ?? 2800) + 400);
}

/**
 * Keeps toasts off buttons: above the topmost dialog's button row when it would cover it (bottom sheets on
 * phones), otherwise above the sheet tabs, bottom Quick Access Bar and status bar, and above the keyboard.
 */
function placeToasts(host: HTMLElement): void {
  host.style.bottom = '';
  const overlays = document.querySelectorAll('.ql-overlay');
  const top = overlays[overlays.length - 1];
  const obstacles = top ? [...top.querySelectorAll<HTMLElement>('.ql-dialog-foot')] : [...document.querySelectorAll<HTMLElement>('.ql-sheetbar, .ql-qat-bottom, .ql-status')];
  const r = host.getBoundingClientRect();
  let lift = 0;
  // Lowest obstacle first, so that lifting the toast above one is checked against the next one up.
  const rects = obstacles.filter((o) => o.getClientRects().length).map((o) => o.getBoundingClientRect()).sort((a, b) => b.top - a.top);
  for (const or of rects) {
    if (or.height && r.bottom - lift > or.top && r.top - lift < or.bottom && r.right > or.left && r.left < or.right) lift = r.bottom - or.top + 8;
  }
  const vv = window.visualViewport;
  if (vv && vv.offsetTop + vv.height < r.bottom - lift) lift = r.bottom - (vv.offsetTop + vv.height) + 8;
  if (lift > 0) host.style.bottom = `${innerHeight - r.bottom + lift}px`;
}

// ------------------------------------------------------------------------------------------
// Dialog

export type FieldType = 'text' | 'number' | 'select' | 'checkbox' | 'color' | 'textarea' | 'radio' | 'range' | 'date' | 'info' | 'list' | 'heading' | 'password' | 'combo' | 'file' | 'button' | 'time';

export interface Field {
  key: string;
  label?: string;
  type: FieldType;
  value?: any;
  options?: (string | { value: any; label: string; style?: string })[];
  min?: number; max?: number; step?: number;
  suffix?: string;
  help?: string;
  placeholder?: string;
  rows?: number;
  multiple?: boolean;
  /** For `info` fields. Shown through the allow-list in util/sanitize.ts: formatting, lists, tables and links only. */
  html?: string;
  /** `autocomplete` of the input (password fields default to "new-password" so saved site passwords are not offered). */
  autocomplete?: string;
  width?: string;
  half?: boolean;
  visibleIf?: (v: Record<string, any>) => boolean;
  onClick?: (values: Record<string, any>, ctl: DialogControl) => void;
  accept?: string;
  autofocus?: boolean;
}

export interface DialogControl {
  set(key: string, value: any): void;
  get(key: string): any;
  values(): Record<string, any>;
  close(result?: any): void;
  body: HTMLElement;
  /** A string goes through the same allow-list as `Field.html`; pass an element (for example an SVG built with the DOM) for anything else. */
  setPreview(html: string | Node): void;
  rebuild(fields: Field[]): void;
}

export interface DialogOptions {
  title: string;
  fields?: Field[];
  ok?: string | false;
  cancel?: string | false;
  wide?: boolean;
  full?: boolean;
  preview?: boolean | string;
  previewStyle?: string;
  onChange?: (values: Record<string, any>, ctl: DialogControl, key: string) => void;
  onOpen?: (ctl: DialogControl) => void;
  buttons?: { label: string; onClick: (values: Record<string, any>, ctl: DialogControl) => void; primary?: boolean }[];
  validate?: (values: Record<string, any>) => string | null;
  content?: HTMLElement;
  help?: string;
}

let dialogDepth = 0;
/** Open dialogs, innermost last: only the top one handles Escape and Enter. */
const dialogStack: HTMLElement[] = [];

/** Everything behind the top dialog is inert: not focusable, not clickable, not read by screen readers. */
function syncModal(): void {
  const top = dialogStack[dialogStack.length - 1];
  document.querySelector('.ql-app')?.toggleAttribute('inert', dialogStack.length > 0);
  for (const o of dialogStack) o.toggleAttribute('inert', o !== top);
}

function focusables(box: HTMLElement): HTMLElement[] {
  const laidOut = box.getClientRects().length > 0; // false without layout (tests): then only inline hiding counts
  return [...box.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter((el) => {
    if ((el as HTMLButtonElement).disabled || (el as HTMLInputElement).type === 'hidden') return false;
    for (let n: HTMLElement | null = el; n && n !== box; n = n.parentElement) if (n.hidden || n.style.display === 'none') return false;
    return !laidOut || el.getClientRects().length > 0;
  });
}

/** Tab and Shift+Tab stay inside the dialog (menus opened from it handle their own keys). */
function trapTab(e: KeyboardEvent, box: HTMLElement): void {
  const cur = document.activeElement as HTMLElement | null;
  if (cur?.closest?.('.ql-menu')) return;
  const f = focusables(box);
  if (!f.length) { e.preventDefault(); box.focus(); return; }
  const first = f[0], last = f[f.length - 1];
  if (!cur || !box.contains(cur) || cur === box) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
}

/**
 * Makes an overlay that is not an openDialog dialog (the command palette) modal in the same way: the app
 * behind it is inert, Tab stays in `box`, Escape (also the Android Back button, through inDialog) calls
 * `onEscape`. Returns the function that ends it and gives the focus back.
 */
export function openModal(overlay: HTMLElement, box: HTMLElement, onEscape: () => void): () => void {
  const prevFocus = document.activeElement as HTMLElement | null;
  dialogDepth++;
  dialogStack.push(overlay);
  syncModal();
  const onKey = (e: KeyboardEvent) => {
    if (dialogStack[dialogStack.length - 1] !== overlay) return;
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); if (!escapeMenu()) onEscape(); }
    else if (e.key === 'Tab') trapTab(e, box);
  };
  document.addEventListener('keydown', onKey, true);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    dialogDepth--;
    const at = dialogStack.indexOf(overlay);
    if (at >= 0) dialogStack.splice(at, 1);
    syncModal();
    document.removeEventListener('keydown', onKey, true);
    prevFocus?.focus?.();
  };
}

export function openDialog(opts: DialogOptions): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    dialogDepth++;
    const prevFocus = document.activeElement as HTMLElement | null;
    const overlay = h('div', { class: 'ql-overlay' });
    const box = h('div', { class: 'ql-dialog' + (opts.wide ? ' ql-wide' : '') + (opts.full ? ' ql-full' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, tabindex: '-1' });
    const body = h('div', { class: 'ql-dialog-body' });
    const previewEl = opts.preview ? h('div', { class: 'ql-dialog-preview', style: opts.previewStyle || '' }, typeof opts.preview === 'string' ? opts.preview : '') : null;
    const inputs = new Map<string, { el: HTMLElement; field: Field; row: HTMLElement }>();
    let fields = opts.fields || [];
    let done = false;

    const values = (): Record<string, any> => {
      const v: Record<string, any> = {};
      for (const [k, { el, field }] of inputs) v[k] = readValue(el, field);
      return v;
    };
    const ctl: DialogControl = {
      set(key, value) { const i = inputs.get(key); if (i) writeValue(i.el, i.field, value); refreshVisibility(); },
      get(key) { const i = inputs.get(key); return i ? readValue(i.el, i.field) : undefined; },
      values,
      close(result) { finish(result === undefined ? null : result); },
      body,
      setPreview(html) { if (previewEl) previewEl.replaceChildren(typeof html === 'string' ? sanitizeHtml(html) : html); },
      rebuild(f) { fields = f; build(); },
    };

    function refreshVisibility() {
      const v = values();
      for (const { field, row } of inputs.values()) if (field.visibleIf) row.style.display = field.visibleIf(v) ? '' : 'none';
    }

    function build() {
      clear(body);
      inputs.clear();
      if (opts.help) body.appendChild(h('p', { class: 'ql-help' }, opts.help));
      if (opts.content) body.appendChild(opts.content);
      let rowWrap: HTMLElement | null = null;
      for (const f of fields) {
        const { row, el } = buildField(f, ctl, () => { refreshVisibility(); opts.onChange?.(values(), ctl, f.key); });
        if (f.half) {
          if (!rowWrap) { rowWrap = h('div', { class: 'ql-row2' }); body.appendChild(rowWrap); }
          rowWrap.appendChild(row);
          if (rowWrap.children.length >= 2) rowWrap = null;
        } else {
          rowWrap = null;
          body.appendChild(row);
        }
        if (f.type !== 'heading' && f.type !== 'info' && f.type !== 'button') inputs.set(f.key, { el, field: f, row });
        else inputs.set('__' + f.key, { el, field: f, row });
      }
      if (previewEl) body.appendChild(h('div', { class: 'ql-preview-wrap' }, h('div', { class: 'ql-label' }, 'Preview'), previewEl));
      for (const k of [...inputs.keys()]) if (k.startsWith('__')) inputs.delete(k);
      refreshVisibility();
    }

    function finish(result: Record<string, any> | null) {
      if (done) return;
      done = true;
      dialogDepth--;
      const at = dialogStack.indexOf(overlay);
      if (at >= 0) dialogStack.splice(at, 1);
      syncModal();
      overlay.classList.add('ql-out');
      setTimeout(() => overlay.remove(), 120);
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(result);
    }
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== overlay) return;
      const t = e.target as HTMLElement | null;
      // Shortcut capture boxes (Customize Keyboard) take Enter and modified keys themselves; plain Escape and Tab still work.
      const plainEsc = e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      const plainTab = e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (t?.closest?.('[data-capture-keys]') && !plainEsc && !plainTab) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!escapeMenu()) finish(null); return; }
      if (plainTab) { trapTab(e, box); return; }
      if (e.key !== 'Enter' || opts.ok === false || e.isComposing || e.keyCode === 229) return; // 229: an input method is still composing
      if (t && box.contains(t)) {
        if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'SUMMARY' || t.isContentEditable || (t as HTMLInputElement).type === 'file') return;
        // Enter confirms from the dialog's own fields. In a box that belongs to custom content (a filter, a
        // search, a key field of a wizard) it is that content's key and must not close the dialog.
        const typing = t.tagName === 'INPUT' || t.tagName === 'SELECT';
        if (typing && !t.closest('[data-enter-ok]') && ![...inputs.values()].some(({ row }) => row.contains(t))) return;
      } else if (t && /^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/.test(t.tagName || '')) return; // a menu or toast control above the dialog
      e.preventDefault(); e.stopImmediatePropagation(); okClick();
    };
    const okClick = () => {
      const v = values();
      const err = opts.validate?.(v);
      if (err) { toast(err); return; }
      finish(v);
    };

    const header = h('div', { class: 'ql-dialog-head' },
      h('h2', null, opts.title),
      h('button', { class: 'ql-iconbtn', 'aria-label': 'Close', onclick: () => finish(null) }, icon('close')));
    const footer = h('div', { class: 'ql-dialog-foot' });
    for (const b of opts.buttons || []) footer.appendChild(h('button', { class: 'ql-btn' + (b.primary ? ' ql-primary' : ''), onclick: () => b.onClick(values(), ctl) }, b.label));
    footer.appendChild(h('span', { class: 'ql-spacer' }));
    if (opts.cancel !== false) footer.appendChild(h('button', { class: 'ql-btn', onclick: () => finish(null) }, opts.cancel || 'Cancel'));
    if (opts.ok !== false) footer.appendChild(h('button', { class: 'ql-btn ql-primary', onclick: okClick }, opts.ok || 'OK'));

    box.append(header, body, footer);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !isPhone()) finish(null); });
    document.body.appendChild(overlay);
    dialogStack.push(overlay);
    syncModal();
    document.addEventListener('keydown', onKey, true);
    build();
    opts.onOpen?.(ctl);
    opts.onChange?.(values(), ctl, '');
    // The field marked autofocus (else the first text field, else the main button), unless the user already
    // moved into the dialog. The focus always lands inside: what is behind the dialog cannot take keys.
    setTimeout(() => {
      if (done || (box.contains(document.activeElement) && document.activeElement !== box)) return;
      const first = body.querySelector<HTMLElement>('[autofocus]') || focusables(body).find((x) => (x.tagName === 'INPUT' && !/^(checkbox|radio|file|range|color)$/.test((x as HTMLInputElement).type)) || x.tagName === 'TEXTAREA' || x.tagName === 'SELECT');
      (first || footer.querySelector<HTMLElement>('.ql-primary') || footer.querySelector<HTMLElement>('button') || box).focus();
    }, 30);
  });
}

function buildField(f: Field, ctl: DialogControl, changed: () => void): { row: HTMLElement; el: HTMLElement } {
  const id = 'f_' + f.key + '_' + Math.random().toString(36).slice(2, 7);
  let el: HTMLElement;
  const label = f.label ? h('label', { class: 'ql-label', for: id }, f.label) : null;
  switch (f.type) {
    case 'heading':
      el = h('h3', { class: 'ql-field-heading' }, f.label || '');
      return { row: el, el };
    case 'info':
      el = h('div', { class: 'ql-info', html: f.html ?? '' }); // h() rebuilds html from the allow-list
      if (!f.html && f.label) el.textContent = f.label;
      // Links to the outside open in the system browser, never in the app's own window or WebView.
      el.addEventListener('click', (e) => { const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null; if (a && !(a.getAttribute('href') || '').startsWith('#')) { e.preventDefault(); openExternal(a.href); } });
      return { row: el, el };
    case 'button':
      el = h('button', { class: 'ql-btn', type: 'button', onclick: () => f.onClick?.(ctl.values(), ctl) }, f.label || '');
      return { row: h('div', { class: 'ql-field' }, el), el };
    case 'checkbox':
      el = h('input', { type: 'checkbox', id, checked: !!f.value });
      el.addEventListener('change', changed);
      return { row: h('div', { class: 'ql-field ql-check' + (f.half ? ' ql-half' : '') }, el, h('label', { for: id }, f.label || ''), f.help ? h('div', { class: 'ql-help' }, f.help) : null), el };
    case 'select': {
      const sel = h('select', { id }) as HTMLSelectElement;
      for (const o of f.options || []) {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        const oe = h('option', { value: String(opt.value) }, opt.label);
        if ((opt as any).style) oe.setAttribute('style', (opt as any).style);
        sel.appendChild(oe);
      }
      if (f.value != null) sel.value = String(f.value);
      sel.addEventListener('change', changed);
      el = sel;
      break;
    }
    case 'combo': {
      const listId = id + '_list';
      const inp = h('input', { id, type: 'text', list: listId, value: f.value ?? '', placeholder: f.placeholder || '' });
      const dl = h('datalist', { id: listId }, ...(f.options || []).map((o) => h('option', { value: typeof o === 'string' ? o : String(o.value) })));
      inp.addEventListener('input', changed);
      if (f.autofocus) inp.setAttribute('autofocus', '');
      el = inp;
      const row = h('div', { class: 'ql-field' + (f.half ? ' ql-half' : '') }, label, h('div', { class: 'ql-ctl' }, inp, dl, f.suffix ? h('span', { class: 'ql-suffix' }, f.suffix) : null), f.help ? h('div', { class: 'ql-help' }, f.help) : null);
      return { row, el };
    }
    case 'radio': {
      const wrap = h('div', { class: 'ql-radios', id, role: 'radiogroup' });
      for (const [k, o] of (f.options || []).entries()) {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        const rid = `${id}_${k}`;
        const r = h('input', { type: 'radio', name: id, id: rid, value: String(opt.value), checked: String(f.value) === String(opt.value) });
        r.addEventListener('change', changed);
        wrap.appendChild(h('label', { class: 'ql-radio', for: rid }, r, ' ', opt.label));
      }
      el = wrap;
      break;
    }
    case 'list': {
      const sel = h('select', { id, size: String(f.rows || 8), multiple: !!f.multiple, class: 'ql-listbox', 'data-key': f.key }) as HTMLSelectElement;
      for (const o of f.options || []) {
        const opt = typeof o === 'string' ? { value: o, label: o } : o;
        const oe = h('option', { value: String(opt.value) }, opt.label);
        if ((opt as any).style) oe.setAttribute('style', (opt as any).style);
        sel.appendChild(oe);
      }
      if (f.value != null) {
        const vals = Array.isArray(f.value) ? f.value.map(String) : [String(f.value)];
        for (const o of sel.options) o.selected = vals.includes(o.value);
      }
      sel.addEventListener('change', changed);
      sel.addEventListener('dblclick', () => { (sel.closest('.ql-dialog')?.querySelector('.ql-primary') as HTMLElement | null)?.click(); });
      el = sel;
      break;
    }
    case 'textarea':
      el = h('textarea', { id, rows: String(f.rows || 4), placeholder: f.placeholder || '' }) as HTMLTextAreaElement;
      (el as HTMLTextAreaElement).value = f.value ?? '';
      el.addEventListener('input', changed);
      break;
    case 'color': {
      const inp = h('input', { id, type: 'color', value: toHex(f.value) || '#000000' });
      inp.addEventListener('input', changed);
      el = inp;
      break;
    }
    case 'range': {
      const inp = h('input', { id, type: 'range', min: String(f.min ?? 0), max: String(f.max ?? 100), step: String(f.step ?? 1), value: String(f.value ?? 0) });
      const out = h('span', { class: 'ql-suffix' }, String(f.value ?? 0) + (f.suffix || ''));
      inp.addEventListener('input', () => { out.textContent = (inp as HTMLInputElement).value + (f.suffix || ''); changed(); });
      el = inp;
      const row = h('div', { class: 'ql-field' + (f.half ? ' ql-half' : '') }, label, h('div', { class: 'ql-ctl' }, inp, out));
      return { row, el };
    }
    case 'file': {
      const inp = h('input', { id, type: 'file', accept: f.accept || '' });
      inp.addEventListener('change', changed);
      el = inp;
      break;
    }
    default: {
      const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'password' ? 'password' : f.type === 'time' ? 'time' : 'text';
      // Browsers ignore autocomplete="off" on password fields and offer saved site passwords; "new-password" stops that.
      const inp = h('input', { id, type, placeholder: f.placeholder || '', autocomplete: f.autocomplete || (f.type === 'password' ? 'new-password' : 'off') }) as HTMLInputElement;
      if (f.type === 'number') {
        inp.inputMode = 'decimal';
        if (f.min != null) inp.min = String(f.min);
        if (f.max != null) inp.max = String(f.max);
        inp.step = String(f.step ?? 'any');
      }
      inp.value = f.value ?? '';
      inp.addEventListener('input', changed);
      if (f.autofocus) inp.setAttribute('autofocus', '');
      el = inp;
    }
  }
  if (f.width) el.style.width = f.width;
  const row = h('div', { class: 'ql-field' + (f.half ? ' ql-half' : '') }, label, h('div', { class: 'ql-ctl' }, el, f.suffix ? h('span', { class: 'ql-suffix' }, f.suffix) : null), f.help ? h('div', { class: 'ql-help' }, f.help) : null);
  return { row, el };
}

function readValue(el: HTMLElement, f: Field): any {
  switch (f.type) {
    case 'checkbox': return (el as HTMLInputElement).checked;
    case 'number': { const v = (el as HTMLInputElement).value; return v === '' ? null : parseFloat(v); }
    case 'range': return parseFloat((el as HTMLInputElement).value);
    case 'radio': { const c = el.querySelector<HTMLInputElement>('input:checked'); return c ? c.value : null; }
    case 'list': {
      const s = el as HTMLSelectElement;
      const sel = [...s.selectedOptions].map((o) => o.value);
      return f.multiple ? sel : sel[0] ?? null;
    }
    case 'file': return (el as HTMLInputElement).files?.[0] || null;
    default: return (el as HTMLInputElement).value;
  }
}

function writeValue(el: HTMLElement, f: Field, v: any): void {
  switch (f.type) {
    case 'checkbox': (el as HTMLInputElement).checked = !!v; break;
    case 'radio': { const r = el.querySelector<HTMLInputElement>(`input[value="${CSS.escape(String(v))}"]`); if (r) r.checked = true; break; }
    case 'list': {
      const s = el as HTMLSelectElement;
      if (Array.isArray(v) && !f.multiple) {
        clear(s);
        for (const o of v) { const opt = typeof o === 'string' ? { value: o, label: o } : o; s.appendChild(h('option', { value: String(opt.value) }, opt.label)); }
      } else {
        const vals = Array.isArray(v) ? v.map(String) : [String(v)];
        for (const o of s.options) o.selected = vals.includes(o.value);
      }
      break;
    }
    case 'color': (el as HTMLInputElement).value = toHex(v) || '#000000'; break;
    default: (el as HTMLInputElement).value = v ?? '';
  }
}

export function setListOptions(ctl: DialogControl, key: string, options: (string | { value: any; label: string; style?: string })[], selected?: string): void {
  const sel = [...ctl.body.querySelectorAll<HTMLSelectElement>('select.ql-listbox')].find((s) => s.dataset.key === key);
  if (!sel) return;
  clear(sel);
  for (const o of options) {
    const opt = typeof o === 'string' ? { value: o, label: o } : o;
    const oe = h('option', { value: String(opt.value) }, opt.label);
    if ((opt as any).style) oe.setAttribute('style', (opt as any).style);
    if (selected != null && String(opt.value) === selected) oe.selected = true;
    sel.appendChild(oe);
  }
}

export function toHex(c: any): string | null {
  if (!c || typeof c !== 'string') return null;
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('');
  const m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('');
  try {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = c;
    const v = ctx.fillStyle as string;
    return /^#/.test(v) ? v : null;
  } catch { return null; }
}

export async function alertDialog(title: string, message: string | HTMLElement): Promise<void> {
  const content = typeof message === 'string' ? h('div', { class: 'ql-msg' }, ...message.split('\n').map((l) => h('p', null, l))) : message;
  await openDialog({ title, content, cancel: false, ok: 'OK' });
}

export async function confirmDialog(title: string, message: string, ok = 'OK', cancel = 'Cancel'): Promise<boolean> {
  const r = await openDialog({ title, content: h('div', { class: 'ql-msg' }, ...message.split('\n').map((l) => h('p', null, l))), ok, cancel });
  return r !== null;
}

/** Three-way choice. Resolves to the index of the chosen button, or -1 for cancel. */
export function choiceDialog(title: string, message: string, choices: string[]): Promise<number> {
  return new Promise((resolve) => {
    let chosen = -1;
    openDialog({
      title, content: h('div', { class: 'ql-msg' }, message), ok: false, cancel: 'Cancel',
      buttons: choices.map((c, i) => ({ label: c, primary: i === 0, onClick: (_v, ctl) => { chosen = i; ctl.close({}); } })),
    }).then(() => resolve(chosen));
  });
}

export async function promptDialog(title: string, label: string, value = '', opts: Partial<Field> = {}): Promise<string | null> {
  const r = await openDialog({ title, fields: [{ key: 'v', label, type: 'text', value, autofocus: true, ...opts }] });
  return r ? (r.v as string) : null;
}

// ------------------------------------------------------------------------------------------
// Popup menus

let openMenus: HTMLElement[] = [];
/** Where focus goes back to when a menu is left with the keyboard (the button or editor it was opened from). */
let menuReturn: HTMLElement | null = null;
/** Whether the latest input was a key press: menus opened from the keyboard take focus, others leave it alone. */
let keyboardInput = false;
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', () => { keyboardInput = true; }, true);
  for (const t of ['pointerdown', 'mousedown', 'touchstart']) document.addEventListener(t, () => { keyboardInput = false; }, true);
}

export function closeMenus(): void {
  for (const m of openMenus) m.remove();
  openMenus = [];
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('touchstart', outside, true);
}

function outside(e: Event) {
  if (openMenus.some((m) => m.contains(e.target as Node))) return;
  closeMenus();
}

export interface MenuOptions {
  onPick: (entry: MenuEntry) => void;
  anchor?: HTMLElement;
  x?: number; y?: number;
  level?: number;
  className?: string;
  title?: string;
  grid?: boolean;
  extra?: HTMLElement;
  /** Move focus into the menu (default: when it was opened from the keyboard). */
  focus?: boolean;
}

const menuItems = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('button, input')].filter((x) => !(x as HTMLButtonElement).disabled && (x.offsetParent !== null || x === document.activeElement));

/** Arrow keys, Home/End, Right/Left for submenus, Escape and Tab inside a menu. */
function menuKey(ev: KeyboardEvent, menu: HTMLElement, level: number) {
  const items = menuItems(menu);
  const cur = document.activeElement as HTMLElement | null;
  const i = cur ? items.indexOf(cur) : -1;
  const typing = cur?.tagName === 'INPUT';
  const go = (j: number) => { ev.preventDefault(); items[(j + items.length) % items.length]?.focus(); };
  if (ev.key === 'ArrowDown') go(i + 1);
  else if (typing) { if (ev.key === 'Escape' || ev.key === 'Tab') leave(ev); }
  else if (ev.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
  else if (ev.key === 'Home') go(0);
  else if (ev.key === 'End') go(items.length - 1);
  else if (ev.key === 'ArrowRight' && cur?.querySelector('.ql-sub')) { ev.preventDefault(); cur.click(); }
  else if (ev.key === 'ArrowLeft' && level > 0) { ev.preventDefault(); for (const m of openMenus.slice(level)) m.remove(); openMenus = openMenus.slice(0, level); (menu as any)._back?.focus?.(); }
  else if (ev.key === 'Escape' || ev.key === 'Tab') leave(ev);
}
function leave(ev: KeyboardEvent) { ev.preventDefault(); const back = menuReturn; closeMenus(); back?.focus?.(); }
/** Escape with a menu open above a dialog closes the menu only. True when there was one. */
function escapeMenu(): boolean {
  if (!openMenus.length) return false;
  const back = menuReturn;
  closeMenus();
  back?.focus?.();
  return true;
}

export function showMenu(entries: MenuEntry[], opts: MenuOptions): HTMLElement {
  const prior = document.activeElement as HTMLElement | null;
  if (!opts.level) { if (!prior?.closest?.('.ql-menu')) menuReturn = prior; closeMenus(); }
  const phone = isPhone();
  const menu = h('div', { class: 'ql-menu' + (opts.className ? ' ' + opts.className : '') + (opts.grid ? ' ql-menu-grid' : ''), role: 'menu' });
  if (opts.title) menu.appendChild(h('div', { class: 'ql-menu-title' }, opts.title));
  for (const e of entries) {
    if (e.separator) { menu.appendChild(h('div', { class: 'ql-menu-sep', role: 'separator' })); continue; }
    if (e.heading) { menu.appendChild(h('div', { class: 'ql-menu-heading' }, e.heading)); continue; }
    const item = h('button', { class: 'ql-menu-item' + (e.checked ? ' ql-checked' : ''), role: 'menuitem', type: 'button', title: e.label || '' });
    if (e.swatch !== undefined) item.appendChild(h('span', { class: 'ql-swatch', style: `background:${e.swatch || 'transparent'}` }));
    else if (e.icon) item.appendChild(icon(e.icon));
    else item.appendChild(h('span', { class: 'ql-icon-space' }, e.checked ? '✓' : ''));
    const lab = h('span', { class: 'ql-menu-label' }, e.label || e.id || '');
    if (e.preview) lab.setAttribute('style', e.preview);
    item.appendChild(lab);
    if (e.submenu) item.appendChild(icon('chevron_right', 'ql-sub'));
    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (e.submenu) {
        const r = item.getBoundingClientRect();
        if (phone) {
          showMenu([{ label: '‹ Back', icon: 'arrow_back', id: '__back' }, { separator: true }, ...e.submenu], {
            ...opts, level: 0, x: r.left, y: r.top,
            onPick: (pe) => { if (pe.id === '__back') showMenu(entries, { ...opts, level: 0 }); else opts.onPick(pe); },
          });
        } else {
          for (const m of openMenus.slice((opts.level || 0) + 1)) m.remove();
          openMenus = openMenus.slice(0, (opts.level || 0) + 1);
          showMenu(e.submenu, { ...opts, level: (opts.level || 0) + 1, anchor: undefined, x: r.right - 4, y: r.top });
        }
        return;
      }
      const back = keyboardInput && menu.contains(document.activeElement) ? menuReturn : null;
      closeMenus();
      back?.focus?.();
      opts.onPick(e);
    });
    menu.appendChild(item);
  }
  if (opts.extra) menu.appendChild(opts.extra);
  document.body.appendChild(menu);
  openMenus.push(menu);
  (menu as any)._back = prior;
  menu.addEventListener('keydown', (ev) => menuKey(ev, menu, opts.level || 0));
  const place = () => placeMenu(menu, opts);
  (menu as any)._place = place;
  place();
  // Callers may add to the menu after it opens (a search box, more items): keep it on screen.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (menu.isConnected) place(); else ro.disconnect(); });
    ro.observe(menu);
  }
  if (opts.focus ?? keyboardInput) menuItems(menu)[0]?.focus();
  if (!opts.level) {
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('touchstart', outside, true);
    }, 0);
  }
  return menu;
}

/**
 * Positions a menu at its anchor (below it, or above when there is no room below) or at its point, inside
 * the area not covered by status, navigation or gesture bars or by the on-screen keyboard, and no taller
 * than that area. Called again when the window or the visual viewport changes size (keyboard, rotation).
 */
function placeMenu(menu: HTMLElement, opts: MenuOptions): void {
  const sa = safeInsets();
  const vv = window.visualViewport;
  const vvBottom = vv && vv.scale === 1 ? vv.offsetTop + vv.height : window.innerHeight;
  const left = sa.left + 4, top = sa.top + 4, right = window.innerWidth - sa.right - 4, bottom = Math.min(window.innerHeight - sa.bottom, vvBottom) - 4;
  menu.style.maxHeight = '';
  const cssMax = parseFloat(getComputedStyle(menu).maxHeight);
  if (!(cssMax <= bottom - top)) menu.style.maxHeight = `${Math.max(80, bottom - top)}px`;
  const mr = menu.getBoundingClientRect();
  const anchor = opts.anchor?.isConnected ? opts.anchor : null;
  let x = opts.x ?? 0, y = opts.y ?? 0;
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 2; if (y + mr.height > bottom && r.top - mr.height - 2 >= top) y = r.top - mr.height - 2; }
  if (x + mr.width > right) x = right - mr.width;
  if (y + mr.height > bottom) y = bottom - mr.height;
  x = Math.max(left, x); y = Math.max(top, y);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

/** Keyboard height not already taken out of the layout viewport (an overlaying keyboard), as --kb. */
function viewportChanged(): void {
  const vv = window.visualViewport;
  const kb = vv && vv.scale === 1 ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  document.documentElement.style.setProperty('--kb', `${kb}px`);
  for (const m of openMenus) (m as any)._place?.();
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', viewportChanged);
  window.visualViewport?.addEventListener('resize', viewportChanged);
}

/** Current system-bar insets in CSS pixels (the --sat/--sab/--sal/--sar variables in app.css). */
export function safeInsets(): { top: number; bottom: number; left: number; right: number } {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:var(--sat) var(--sar) var(--sab) var(--sal)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const r = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };
  probe.remove();
  return r;
}

// ------------------------------------------------------------------------------------------
// Color picker

export const THEME_COLORS = [
  ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'],
  ['#f2f2f2', '#7f7f7f', '#d0cece', '#d6dce4', '#d9e2f3', '#fbe5d5', '#ededed', '#fff2cc', '#deebf6', '#e2efd9'],
  ['#d8d8d8', '#595959', '#aeabab', '#adb9ca', '#b4c6e7', '#f7cbac', '#dbdbdb', '#fee599', '#bdd7ee', '#c5e0b3'],
  ['#bfbfbf', '#3f3f3f', '#757070', '#8496b0', '#8eaadb', '#f4b183', '#c9c9c9', '#ffd965', '#9cc3e5', '#a8d08d'],
  ['#a5a5a5', '#262626', '#3a3838', '#323f4f', '#2f5496', '#c55a11', '#7b7b7b', '#bf9000', '#2e75b5', '#538135'],
  ['#7f7f7f', '#0c0c0c', '#171616', '#222a35', '#1f3864', '#833c0b', '#525252', '#7f6000', '#1e4e79', '#375623'],
];
export const STANDARD_COLORS = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
export const HIGHLIGHT_COLORS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0', '#000000', '#ffd8a8', '#ffc9de', '#d0bfff'];

const recentColors: string[] = [];

export function colorMenu(anchor: HTMLElement | { x: number; y: number }, opts: { none?: string; auto?: string; highlight?: boolean; title?: string } = {}): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let resolved = false;
    const pick = (c: string | null) => {
      if (resolved) return;
      resolved = true;
      if (c && !recentColors.includes(c)) { recentColors.unshift(c); recentColors.splice(10); }
      const back = keyboardInput && m.contains(document.activeElement) ? menuReturn : null;
      closeMenus();
      back?.focus?.();
      resolve(c);
    };
    const grid = h('div', { class: 'ql-colors' });
    const sw = (c: string) => h('button', { class: 'ql-color', style: `background:${c}`, title: c, 'aria-label': c, onclick: () => pick(c) });
    if (opts.auto) grid.appendChild(h('button', { class: 'ql-btn ql-full', onclick: () => pick(null) }, opts.auto));
    if (opts.highlight) {
      grid.appendChild(h('div', { class: 'ql-color-row' }, ...HIGHLIGHT_COLORS.map(sw)));
    } else {
      grid.appendChild(h('div', { class: 'ql-menu-heading' }, 'Theme Colors'));
      for (const row of THEME_COLORS) grid.appendChild(h('div', { class: 'ql-color-row' }, ...row.map(sw)));
      grid.appendChild(h('div', { class: 'ql-menu-heading' }, 'Standard Colors'));
      grid.appendChild(h('div', { class: 'ql-color-row' }, ...STANDARD_COLORS.map(sw)));
    }
    if (recentColors.length) {
      grid.appendChild(h('div', { class: 'ql-menu-heading' }, 'Recent Colors'));
      grid.appendChild(h('div', { class: 'ql-color-row' }, ...recentColors.map(sw)));
    }
    if (opts.none) grid.appendChild(h('button', { class: 'ql-btn ql-full', onclick: () => pick(null) }, opts.none));
    const more = h('input', { type: 'color', class: 'ql-color-more', 'aria-label': 'More colors' }) as HTMLInputElement;
    more.addEventListener('change', () => pick(more.value));
    grid.appendChild(h('label', { class: 'ql-btn ql-full ql-morecolors' }, icon('palette'), ' More Colors… ', more));
    const pos = anchor instanceof HTMLElement ? { anchor } : { x: anchor.x, y: anchor.y };
    const m = showMenu([], { ...pos, onPick: () => undefined, extra: grid, title: opts.title, className: 'ql-color-menu' });
    const obs = new MutationObserver(() => { if (!m.isConnected) { obs.disconnect(); if (!resolved) { resolved = true; resolve(undefined); } } });
    obs.observe(document.body, { childList: true });
  });
}

export function inDialog(): boolean {
  return dialogDepth > 0;
}
