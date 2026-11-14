import { describe, it, expect, beforeEach } from 'vitest';
import { openDialog, openModal, inDialog, setListOptions, toast } from '../../src/ui/dialog';
import { h } from '../../src/ui/dom';

const key = (target: Element | Document, k: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const settled = async <T>(p: Promise<T>): Promise<{ done: boolean; value?: T }> => {
  let out: { done: boolean; value?: T } = { done: false };
  void p.then((value) => { out = { done: true, value }; });
  await new Promise((r) => setTimeout(r, 0));
  return out;
};
const top = () => [...document.querySelectorAll<HTMLElement>('.ql-overlay:not(.ql-out)')].pop()!;

beforeEach(() => {
  document.body.innerHTML = '<div class="ql-app"><button id="behind">behind</button></div>';
});

describe('dialog html is rebuilt from the allow-list', () => {
  it('an info field cannot carry markup that runs', async () => {
    const p = openDialog({ title: 'T', fields: [{ key: 'i', type: 'info', html: '<p class="ql-help">Font <img src=x onerror="window.__x=1">, 12 pt <b>ok</b></p>' }] });
    const info = top().querySelector('.ql-info')!;
    expect(info.innerHTML).toBe('<p class="ql-help">Font , 12 pt <b>ok</b></p>');
    key(document, 'Escape');
    expect((await settled(p)).value).toBeNull();
  });
  it('setPreview takes a sanitized string or a node', async () => {
    let ctl: any;
    const p = openDialog({ title: 'T', preview: true, onOpen: (c) => { ctl = c; } });
    const prev = top().querySelector('.ql-dialog-preview')!;
    ctl.setPreview('<b>x</b><script>alert(1)</script><svg onload="alert(1)"></svg>');
    expect(prev.innerHTML).toBe('<b>x</b>');
    ctl.setPreview(h('i', null, 'node'));
    expect(prev.innerHTML).toBe('<i>node</i>');
    key(document, 'Escape'); await p;
  });
});

describe('Enter, Escape and Tab in dialogs', () => {
  it('Enter in a box that belongs to custom content does not close the dialog', async () => {
    const filter = h('input', { type: 'text' }) as HTMLInputElement;
    const p = openDialog({ title: 'Customize', content: h('div', null, filter), fields: [{ key: 'own', label: 'Own', type: 'text', value: 'v' }] });
    key(filter, 'Enter');
    expect((await settled(p)).done).toBe(false);     // was: OK, which saved and closed
    const own = top().querySelector<HTMLInputElement>('.ql-field input')!;
    key(own, 'Enter', { isComposing: true });        // an input method confirming a candidate
    expect((await settled(p)).done).toBe(false);
    key(own, 'Enter');
    expect((await settled(p)).value).toEqual({ own: 'v' });
  });
  it('Enter still confirms a message dialog', async () => {
    const p = openDialog({ title: 'Sure?', content: h('p', null, 'text') });
    key(document, 'Enter');
    expect((await settled(p)).value).toEqual({});
  });
  it('Escape closes only the top dialog', async () => {
    const a = openDialog({ title: 'A' });
    const b = openDialog({ title: 'B' });
    key(document, 'Escape');
    expect((await settled(b)).done).toBe(true);
    expect((await settled(a)).done).toBe(false);
    key(document, 'Escape');
    expect((await settled(a)).done).toBe(true);
  });
  it('Tab wraps inside the dialog and what is behind it is inert', async () => {
    const app = document.querySelector('.ql-app')!;
    const p = openDialog({ title: 'T', fields: [{ key: 'a', label: 'A', type: 'text' }] });
    expect(app.hasAttribute('inert')).toBe(true);    // was: focus could leave to the ribbon behind
    const box = top().querySelector<HTMLElement>('.ql-dialog')!;
    const all = [...box.querySelectorAll<HTMLElement>('button, input')];
    const first = all[0], last = all[all.length - 1];
    last.focus();
    expect(key(last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(key(first, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
    (document.getElementById('behind') as HTMLElement).focus();
    key(document.getElementById('behind')!, 'Tab');
    expect(box.contains(document.activeElement)).toBe(true);
    key(document, 'Escape'); await p;
    expect(app.hasAttribute('inert')).toBe(false);
  });
  it('the focus moves into a dialog without fields (to its main button)', async () => {
    const p = openDialog({ title: 'Msg', content: h('p', null, 'x'), ok: 'Fine' });
    await new Promise((r) => setTimeout(r, 50));
    expect((document.activeElement as HTMLElement).textContent).toBe('Fine');
    key(document, 'Escape'); await p;
  });
  it('a lower dialog is inert while another is above it', async () => {
    const a = openDialog({ title: 'A' });
    const lower = top();
    const b = openDialog({ title: 'B' });
    expect(lower.hasAttribute('inert')).toBe(true);
    key(document, 'Escape'); await b;
    expect(lower.hasAttribute('inert')).toBe(false);
    key(document, 'Escape'); await a;
  });
});

describe('openModal (command palette)', () => {
  it('counts as a dialog, closes on Escape from anywhere, and restores the app', () => {
    const overlay = h('div', { class: 'ql-overlay' }), box = h('div', { tabindex: '-1' }, h('button', null, 'pin'));
    overlay.appendChild(box); document.body.appendChild(overlay);
    let closed = 0;
    const end = openModal(overlay, box, () => { closed++; end(); overlay.remove(); });
    expect(inDialog()).toBe(true);                    // the Android Back button asks this before minimizing the app
    expect(document.querySelector('.ql-app')!.hasAttribute('inert')).toBe(true);
    key(box.querySelector('button')!, 'Escape');      // focus on a row button, not in the search box
    expect(closed).toBe(1);
    expect(inDialog()).toBe(false);
    expect(document.querySelector('.ql-app')!.hasAttribute('inert')).toBe(false);
  });
});

describe('fields', () => {
  it('password fields are not "autocomplete=off" (which browsers ignore for passwords)', async () => {
    const p = openDialog({ title: 'P', fields: [{ key: 'pw', label: 'Password', type: 'password' }, { key: 't', label: 'Text', type: 'text' }] });
    const [pw, t] = [...top().querySelectorAll<HTMLInputElement>('.ql-field input')];
    expect(pw.type).toBe('password');
    expect(pw.getAttribute('autocomplete')).toBe('new-password');
    expect(t.getAttribute('autocomplete')).toBe('off');
    key(document, 'Escape'); await p;
  });
  it('setListOptions finds the list by its key, not by a key that merely starts the same', async () => {
    let ctl: any;
    const p = openDialog({ title: 'L', onOpen: (c) => { ctl = c; }, fields: [{ key: 'a_b', label: 'AB', type: 'list', options: ['1'] }, { key: 'a', label: 'A', type: 'list', options: ['2'] }] });
    setListOptions(ctl, 'a', ['x', 'y']);
    const lists = [...top().querySelectorAll<HTMLSelectElement>('select.ql-listbox')];
    expect([...lists[0].options].map((o) => o.value)).toEqual(['1']);   // was overwritten: "f_a_" also starts "f_a_b_…"
    expect([...lists[1].options].map((o) => o.value)).toEqual(['x', 'y']);
    key(document, 'Escape'); await p;
  });
  it('radio options that differ only in punctuation get their own ids', async () => {
    const p = openDialog({ title: 'R', fields: [{ key: 'r', label: 'R', type: 'radio', options: ['a-b', 'a.b'], value: 'a.b' }] });
    const ids = [...top().querySelectorAll<HTMLInputElement>('input[type=radio]')].map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    key(document, 'Escape'); await p;
  });
});

describe('toasts', () => {
  it('are placed in <body>, outside the app root that goes inert under a dialog', () => {
    toast('hello');
    const host = document.querySelector('.ql-toasts')!;
    expect(host.parentElement).toBe(document.body);
  });
});
