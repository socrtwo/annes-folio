/** Customize dialogs: Quick Access Bar, Tabs (ribbon), Keyboard. Every command in the registry is available. */
import type { App } from '../app';
import { allCommands, getCommand, type Command } from '../commands/registry';
import { DEFAULT_QAT, addAllQatChoices, type CustomTab } from '../prefs';
import { DEFAULT_TABS, idsInTabs, tabsFor } from './ribbonLayout';
import { h, icon, clear } from './dom';
import { openDialog, toast, promptDialog, confirmDialog } from './dialog';
import { prettyKey, canonicalKey, keyName } from '../util/keys';

export function categories(app: App): { id: string; label: string; list: () => Command[] }[] {
  const all = () => allCommands().sort((a, b) => a.label.localeCompare(b.label));
  const tabNames = [...new Set(allCommands().map((c) => c.tab))];
  const label = (t: string) => (t === 'Backstage' ? 'File Tab' : ['Table Design', 'Chart Design', 'Picture Format', 'Shape Format', 'PivotTable'].includes(t) ? `${t} (contextual) Tab` : `${t} Tab`);
  const order = ['Backstage', 'Home', 'Insert', 'Draw', 'Page Layout', 'Formulas', 'Data', 'Review', 'View', 'Tools', 'AI', 'Developer', 'Help', 'Table Design', 'PivotTable', 'Chart Design', 'Picture Format', 'Shape Format', 'Sheet', 'Navigation'];
  const inTabs = idsInTabs();
  return [
    { id: 'popular', label: 'Popular Commands', list: () => all().filter((c) => c.popular) },
    { id: 'notInTabs', label: 'Commands Not in the Tabs', list: () => all().filter((c) => !inTabs.has(c.id)) },
    { id: 'all', label: `All Commands (${allCommands().length})`, list: all },
    ...tabNames.sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b))).map((t) => ({ id: 'tab:' + t, label: label(t), list: () => all().filter((c) => c.tab === t) })),
    { id: 'macros', label: 'Macros', list: () => app.prefs.macros.map((m) => getCommand(`macro:${m.name}`)!).filter(Boolean) },
    ...app.prefs.customTabs.map((t) => ({ id: 'custom:' + t.id, label: `Custom tab: ${t.label}`, list: () => t.groups.flatMap((g) => g.items).map((id) => getCommand(id)!).filter(Boolean) })),
  ];
}

/** The Quick Access Bar ids that still name a command (or a separator): an imported layout or an older version can hold others. */
export function knownQat(ids: unknown[], isCommand: (id: string) => boolean = (id) => !!getCommand(id)): string[] {
  return ids.filter((x): x is string => typeof x === 'string' && (x === '|' || isCommand(x)));
}

/**
 * Keyboard use of a list: Up/Down/Home/End move the selection, Enter or Space runs `act` (what a
 * double-click does). `name` identifies the list so that it gets the focus back after the redraw a
 * selection causes. data-capture-keys keeps the dialog from taking Enter as OK.
 */
function listKeys(box: HTMLElement, name: string, count: number, cur: number, pick: (i: number) => void, act?: (i: number) => void): HTMLElement {
  box.setAttribute('role', 'listbox'); box.tabIndex = 0; box.dataset.list = name; box.setAttribute('data-capture-keys', '');
  box.addEventListener('keydown', (e) => {
    if (e.target !== box || e.ctrlKey || e.metaKey || e.altKey || !count) return;
    const to = e.key === 'ArrowDown' ? Math.min(count - 1, cur + 1) : e.key === 'ArrowUp' ? Math.max(0, cur - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : -1;
    if (to >= 0) { e.preventDefault(); if (to !== cur) pick(to); }
    else if ((e.key === 'Enter' || e.key === ' ') && act && cur >= 0) { e.preventDefault(); act(cur); }
  });
  return box;
}

function commandList(name: string, cmds: (Command | '|')[], selected: number, onSelect: (i: number) => void, onDbl?: (i: number) => void): HTMLElement {
  const box = h('div', { class: 'ql-cmdlist' });
  cmds.forEach((c, i) => {
    const row = c === '|' ? h('div', { class: 'ql-cmdlist-row ql-sep-row' + (i === selected ? ' ql-sel' : ''), role: 'option', 'aria-selected': String(i === selected) }, h('span', { class: 'ql-icon-space' }), '<Separator>')
      : h('div', { class: 'ql-cmdlist-row' + (i === selected ? ' ql-sel' : ''), role: 'option', 'aria-selected': String(i === selected), title: `${c.label} — ${c.id}` }, icon(c.icon), h('span', null, c.label), c.kind === 'menu' || c.kind === 'split' ? h('span', { class: 'ql-help' }, ' ▸') : null);
    row.addEventListener('click', () => onSelect(i));
    if (onDbl) row.addEventListener('dblclick', () => onDbl(i));
    box.appendChild(row);
  });
  return listKeys(box, name, cmds.length, selected, onSelect, onDbl);
}

/** A button of the middle toolbar: icon plus a label that stays visible on phones (wrapping onto more rows). */
function midButton(label: string, ic: string, fn: () => void, tip = label): HTMLElement {
  return h('button', { class: 'ql-btn ql-cust-btn', type: 'button', onclick: fn, title: tip, 'aria-label': label }, icon(ic), h('span', { class: 'ql-cust-btn-label' }, label));
}

/**
 * Empties the columns before a redraw and, once the redraw is done, puts their list boxes back where they
 * were scrolled (a click must not jump the list back to the top), then scrolls each list just enough to show
 * its selected row. Only the lists scroll, never the dialog around them.
 */
function clearKeepingScroll(...cols: HTMLElement[]): void {
  const tops = cols.map((c) => [...c.querySelectorAll<HTMLElement>('.ql-cmdlist')].map((l) => l.scrollTop));
  // The list that had the keyboard focus gets it back on its replacement (arrow keys redraw the lists).
  const active = document.activeElement as HTMLElement | null;
  const focused = active && cols.some((c) => c.contains(active)) ? active.dataset.list : undefined;
  const field = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT') && cols.some((c) => c.contains(active)) ? active : null;
  for (const c of cols) clear(c);
  // The filter box and the category list are taken out and put back by the redraw: typing must not lose the focus.
  if (field) queueMicrotask(() => { if (field.isConnected && document.activeElement !== field) field.focus({ preventScroll: true }); });
  queueMicrotask(() => cols.forEach((c, j) => c.querySelectorAll<HTMLElement>('.ql-cmdlist').forEach((l, i) => {
    if (focused && l.dataset.list === focused) l.focus({ preventScroll: true });
    if (tops[j][i]) l.scrollTop = tops[j][i];
    const row = l.querySelector<HTMLElement>('.ql-sel');
    if (!row) return;
    const lr = l.getBoundingClientRect(), rr = row.getBoundingClientRect();
    if (rr.top < lr.top) l.scrollTop -= lr.top - rr.top;
    else if (rr.bottom > lr.bottom) l.scrollTop += rr.bottom - lr.bottom;
  })));
}

export async function customizeQat(app: App): Promise<void> {
  const cats = categories(app);
  let cat = cats[0];
  let filter = '';
  let leftSel = 0, rightSel = -1;
  // Only ids that name a command: the list on the right must line up with `qat` index for index.
  let qat = knownQat(app.prefs.qat);
  const root = h('div', { class: 'ql-customize' });
  const left = h('div', { class: 'ql-cust-col' });
  const right = h('div', { class: 'ql-cust-col' });
  const mid = h('div', { class: 'ql-cust-mid' });
  const leftItems = () => cat.list().filter((c) => !filter || `${c.label} ${c.id} ${c.keywords || ''}`.toLowerCase().includes(filter));
  const qatItems = (): (Command | '|')[] => qat.map((id) => (id === '|' ? '|' : getCommand(id) || null)).filter(Boolean) as (Command | '|')[];
  const add = () => { const c = leftItems()[leftSel]; if (!c) return; const at = rightSel >= 0 ? rightSel + 1 : qat.length; qat.splice(at, 0, c.id); rightSel = at; draw(); };
  const remove = () => { if (rightSel < 0) return; qat.splice(rightSel, 1); rightSel = Math.min(rightSel, qat.length - 1); draw(); };
  const move = (d: number) => { const j = rightSel + d; if (rightSel < 0 || j < 0 || j >= qat.length) return; [qat[rightSel], qat[j]] = [qat[j], qat[rightSel]]; rightSel = j; draw(); };
  const catSel = h('select', { 'aria-label': 'Choose commands from' }, ...cats.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
  catSel.addEventListener('change', () => { cat = cats.find((c) => c.id === catSel.value) || cats[0]; leftSel = 0; draw(); });
  const search = h('input', { placeholder: 'Filter commands…', 'aria-label': 'Filter commands' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value.toLowerCase(); leftSel = 0; draw(); });
  const count = h('div', { class: 'ql-help' });
  const draw = () => {
    clearKeepingScroll(left, right);
    const items = leftItems();
    count.textContent = `${items.length} command(s)`;
    left.append(h('label', { class: 'ql-label' }, 'Choose commands from:'), catSel, search, count, commandList('commands', items, leftSel, (i) => { leftSel = i; draw(); }, (i) => { leftSel = i; add(); }));
    right.append(h('label', { class: 'ql-label' }, 'Quick Access Bar:'), commandList('qat', qatItems(), rightSel, (i) => { rightSel = i; draw(); }, (i) => { rightSel = i; remove(); }));
  };
  mid.append(midButton('Add', 'arrow_forward', add), midButton('Remove', 'arrow_back', remove), midButton('Up', 'arrow_upward', () => move(-1)), midButton('Down', 'arrow_downward', () => move(1)),
    midButton('Separator', 'more_vert', () => { const at = rightSel >= 0 ? rightSel + 1 : qat.length; qat.splice(at, 0, '|'); rightSel = at; draw(); }),
    midButton('Add All A–Z', 'sort_by_alpha', () => { qat = addAllQatChoices(qat, (id) => getCommand(id)?.label); rightSel = -1; draw(); }, 'Add every Quick Access Bar choice: Save and Print first, then the rest A to Z'),
    midButton('Reset', 'restart_alt', () => { qat = [...DEFAULT_QAT]; rightSel = -1; draw(); }, 'Reset to the default Quick Access Bar'));
  root.append(left, mid, right);
  draw();
  const r = await openDialog({
    title: 'Customize the Quick Access Bar', full: true, content: root,
    fields: [
      { key: 'bottom', label: 'Show the Quick Access Bar at the bottom (near the keyboard)', type: 'checkbox', value: app.prefs.qatPosition === 'bottom' },
      { key: 'labels', label: 'Show command labels', type: 'checkbox', value: app.prefs.qatLabels },
    ],
    buttons: [
      { label: 'Export…', onClick: async () => {
        const text = JSON.stringify({ qat });
        try { if (!navigator.clipboard) throw new Error('no clipboard'); await navigator.clipboard.writeText(text); toast('Quick Access Bar layout copied to clipboard'); }
        catch { void promptDialog('Export', 'The clipboard is not available here. Copy this layout:', text); }
      } },
      { label: 'Import…', onClick: async () => { const t = await promptDialog('Import', 'Paste a Quick Access Bar layout:', ''); if (!t) return; try { const j = JSON.parse(t); if (!Array.isArray(j?.qat)) throw new Error('no list'); const all = j.qat.filter((x: unknown) => typeof x === 'string'); qat = knownQat(all); rightSel = -1; draw(); if (qat.length < all.length) toast(`${all.length - qat.length} entr${all.length - qat.length === 1 ? 'y was' : 'ies were'} left out: this version has no such command.`); } catch { toast('That is not a Quick Access Bar layout.'); } } },
    ],
  });
  if (!r) return;
  app.prefs.qat = qat;
  // The checkbox only moves the bar to or from the bottom; "below the ribbon" stays as it was when it is left unticked.
  if (r.bottom) app.prefs.qatPosition = 'bottom'; else if (app.prefs.qatPosition === 'bottom') app.prefs.qatPosition = 'top';
  app.prefs.qatLabels = r.labels;
  app.savePrefs();
  app.ui.applyPrefs();
  app.ui.rebuild();
}

export async function customizeRibbon(app: App): Promise<void> {
  const cats = categories(app);
  let cat = cats[0];
  let filter = '';
  let leftSel = 0;
  const customTabs: CustomTab[] = JSON.parse(JSON.stringify(app.prefs.customTabs));
  const hidden = new Set(app.prefs.hiddenTabs);
  let order = tabsFor(app).map((t) => t.id).concat(DEFAULT_TABS.filter((t) => hidden.has(t.id)).map((t) => t.id));
  for (const t of customTabs) if (!order.includes(t.id)) order.push(t.id);
  let selTab = customTabs[0]?.id || order[0];
  let selGroup = 0, selItem = -1;
  const root = h('div', { class: 'ql-customize' });
  const left = h('div', { class: 'ql-cust-col' }), mid = h('div', { class: 'ql-cust-mid' }), right = h('div', { class: 'ql-cust-col' });
  const leftItems = () => cat.list().filter((c) => !filter || `${c.label} ${c.id}`.toLowerCase().includes(filter));
  const labelOf = (id: string) => customTabs.find((t) => t.id === id)?.label || DEFAULT_TABS.find((t) => t.id === id)?.label || id;
  const isCustom = (id: string) => customTabs.some((t) => t.id === id);
  const curTab = () => customTabs.find((t) => t.id === selTab);
  const ensureCustom = () => {
    if (curTab()) return curTab()!;
    // Customizing a built-in tab creates an editable copy that replaces it.
    const base = DEFAULT_TABS.find((t) => t.id === selTab)!;
    const copy: CustomTab = { id: `custom-${base.id}-${Date.now().toString(36)}`, label: base.label + ' (Custom)', groups: base.groups.map((g) => ({ id: g.id, label: g.label, items: [...g.items] })) };
    customTabs.push(copy);
    hidden.add(base.id);
    order.splice(order.indexOf(base.id) + 1, 0, copy.id);
    selTab = copy.id;
    toast(`Created an editable copy of ${base.label}; the original is hidden.`);
    return copy;
  };
  const catSel = h('select', null, ...cats.map((c) => h('option', { value: c.id }, c.label))) as HTMLSelectElement;
  catSel.addEventListener('change', () => { cat = cats.find((c) => c.id === catSel.value) || cats[0]; leftSel = 0; draw(); });
  const search = h('input', { placeholder: 'Filter commands…' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value.toLowerCase(); leftSel = 0; draw(); });
  const draw = () => {
    clearKeepingScroll(left, right);
    left.append(h('label', { class: 'ql-label' }, 'Choose commands from:'), catSel, search, commandList('commands', leftItems(), leftSel, (i) => { leftSel = i; draw(); }, (i) => { leftSel = i; addCmd(); }));
    const tabList = listKeys(h('div', { class: 'ql-cmdlist' }), 'tabs', order.length, order.indexOf(selTab), (i) => { selTab = order[i]; selGroup = 0; selItem = -1; draw(); });
    for (const id of order) {
      const row = h('div', { class: 'ql-cmdlist-row' + (id === selTab ? ' ql-sel' : '') },
        h('input', { type: 'checkbox', checked: !hidden.has(id) && !(customTabs.find((t) => t.id === id)?.hidden), title: 'Show tab', onclick: (e: Event) => { e.stopPropagation(); const ct = customTabs.find((t) => t.id === id); if (ct) ct.hidden = !(e.target as HTMLInputElement).checked; else if ((e.target as HTMLInputElement).checked) hidden.delete(id); else hidden.add(id); } }),
        h('span', null, labelOf(id) + (isCustom(id) && !/\(Custom\)$/.test(labelOf(id)) ? ' (Custom)' : '')));
      row.addEventListener('click', () => { selTab = id; selGroup = 0; selItem = -1; draw(); });
      tabList.appendChild(row);
    }
    right.append(h('label', { class: 'ql-label' }, 'Tabs (check to show):'), tabList);
    const t = curTab() || DEFAULT_TABS.find((x) => x.id === selTab);
    if (t) {
      const groups = h('div', { class: 'ql-cmdlist ql-groups' });
      t.groups.forEach((g, gi) => {
        groups.appendChild(h('div', { class: 'ql-cmdlist-row ql-group-row' + (gi === selGroup && selItem < 0 ? ' ql-sel' : ''), onclick: () => { selGroup = gi; selItem = -1; draw(); } }, icon('folder'), h('b', null, g.label)));
        g.items.forEach((id, ii) => {
          const c = getCommand(id);
          groups.appendChild(h('div', { class: 'ql-cmdlist-row ql-item-row' + (gi === selGroup && ii === selItem ? ' ql-sel' : ''), onclick: () => { selGroup = gi; selItem = ii; draw(); } }, icon(c?.icon), c?.label || id));
        });
      });
      // Keyboard: the rows in order, a group row first and then its commands.
      const flat = t.groups.flatMap((g, gi) => [[gi, -1], ...g.items.map((_, ii) => [gi, ii])]);
      listKeys(groups, 'groups', flat.length, flat.findIndex(([gi, ii]) => gi === selGroup && ii === selItem), (i) => { [selGroup, selItem] = flat[i]; draw(); });
      right.append(h('label', { class: 'ql-label' }, `Groups in "${labelOf(selTab)}"${isCustom(selTab) ? '' : ' (built-in: editing makes a copy)'}:`), groups);
    }
  };
  const addCmd = () => { const c = leftItems()[leftSel]; if (!c) return; const t = ensureCustom(); if (!t.groups.length) t.groups.push({ id: 'g1', label: 'New Group', items: [] }); const g = t.groups[Math.min(selGroup, t.groups.length - 1)]; g.items.splice(selItem >= 0 ? selItem + 1 : g.items.length, 0, c.id); selItem = selItem >= 0 ? selItem + 1 : g.items.length - 1; draw(); };
  const removeSel = () => { const t = ensureCustom(); const g = t.groups[selGroup]; if (!g) return; if (selItem >= 0) { g.items.splice(selItem, 1); selItem = Math.min(selItem, g.items.length - 1); } else { t.groups.splice(selGroup, 1); selGroup = 0; } draw(); };
  const moveSel = (d: number) => {
    if (selItem < 0) { const oi = order.indexOf(selTab); const j = oi + d; if (j >= 0 && j < order.length) { [order[oi], order[j]] = [order[j], order[oi]]; draw(); } return; }
    const t = ensureCustom(); const g = t.groups[selGroup]; const j = selItem + d; if (j < 0 || j >= g.items.length) return; [g.items[selItem], g.items[j]] = [g.items[j], g.items[selItem]]; selItem = j; draw();
  };
  const b = midButton;
  mid.append(
    b('Add', 'arrow_forward', addCmd), b('Remove', 'arrow_back', removeSel), b('Up', 'arrow_upward', () => moveSel(-1)), b('Down', 'arrow_downward', () => moveSel(1)),
    b('New Tab', 'tab', async () => { const n = await promptDialog('New Tab', 'Tab name:', 'My Tab'); if (!n) return; const t: CustomTab = { id: `custom-${Date.now().toString(36)}`, label: n, groups: [{ id: 'g1', label: 'New Group', items: [] }] }; customTabs.push(t); order.push(t.id); selTab = t.id; selGroup = 0; selItem = -1; draw(); }),
    b('New Group', 'create_new_folder', async () => { const t = ensureCustom(); const n = await promptDialog('New Group', 'Group name:', 'New Group'); if (!n) return; t.groups.push({ id: `g${Date.now().toString(36)}`, label: n, items: [] }); selGroup = t.groups.length - 1; selItem = -1; draw(); }),
    b('Rename', 'edit', async () => { const t = ensureCustom(); if (selItem < 0 && t.groups[selGroup]) { const n = await promptDialog('Rename Group', 'Name:', t.groups[selGroup].label); if (n) t.groups[selGroup].label = n; } else { const n = await promptDialog('Rename Tab', 'Name:', t.label); if (n) t.label = n; } draw(); }),
    b('Delete Tab', 'delete', async () => { const t = curTab(); if (!t) { toast('Built-in tabs can be hidden (uncheck) but not deleted.'); return; } if (await confirmDialog('Delete Tab', `Delete "${t.label}"?`)) { customTabs.splice(customTabs.indexOf(t), 1); order = order.filter((x) => x !== t.id); selTab = order[0]; draw(); } }),
    b('Reset All', 'restart_alt', async () => { if (await confirmDialog('Reset', 'Remove all custom tabs and show all built-in tabs?')) { customTabs.splice(0); hidden.clear(); order = DEFAULT_TABS.map((t) => t.id); selTab = order[0]; draw(); } }),
  );
  root.append(left, mid, right);
  draw();
  const r = await openDialog({ title: 'Customize Tabs (Ribbon)', full: true, content: root, help: 'Add any command to your own tabs and groups. Reorder or hide built-in tabs. Contextual tabs (Table, Picture) appear automatically.' });
  if (!r) return;
  app.prefs.customTabs = customTabs;
  app.prefs.hiddenTabs = [...hidden];
  app.prefs.tabOrder = order;
  app.savePrefs();
  app.ui.rebuild();
}

export async function customizeKeyboard(app: App, initialId?: string): Promise<void> {
  const cats = categories(app);
  let cat = cats.find((c) => c.id === 'all')!;
  let filter = '';
  let sel = 0;
  let pending: string | null = null;
  const keymap = { ...app.prefs.keymap };
  const root = h('div', { class: 'ql-customize ql-cust-keys' });
  const left = h('div', { class: 'ql-cust-col' }), right = h('div', { class: 'ql-cust-col' });
  const catSel = h('select', null, ...cats.map((c) => h('option', { value: c.id, selected: c === cat }, c.label))) as HTMLSelectElement;
  catSel.addEventListener('change', () => { cat = cats.find((c) => c.id === catSel.value) || cats[0]; sel = 0; draw(); });
  const search = h('input', { placeholder: 'Filter commands…' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value.toLowerCase(); sel = 0; draw(); });
  const items = () => cat.list().filter((c) => !filter || `${c.label} ${c.id}`.toLowerCase().includes(filter));
  if (initialId) { const i = items().findIndex((c) => c.id === initialId); if (i >= 0) sel = i; }
  const keysFor = (id: string) => {
    const c = getCommand(id);
    const base = (c?.keys || []).map(canonicalKey).filter((k) => keymap[k] === undefined || keymap[k] === id);
    const custom = Object.entries(keymap).filter(([, v]) => v === id).map(([k]) => k);
    return [...new Set([...base, ...custom])].filter((k) => keymap[k] !== '');
  };
  const ownerOf = (k: string): string | null => {
    if (keymap[k] !== undefined) return keymap[k] || null;
    const c = allCommands().find((x) => (x.keys || []).map(canonicalKey).includes(k));
    return c?.id || null;
  };
  const capture = h('input', { class: 'ql-key-capture', placeholder: 'Press new shortcut key…', readonly: true, 'data-capture-keys': true, 'aria-label': 'Press new shortcut key' }) as HTMLInputElement;
  const owner = h('div', { class: 'ql-help', role: 'status' });
  capture.addEventListener('keydown', (e) => {
    const k = keyName(e);
    // Plain Tab and Shift+Tab move on (to Assign) and plain Escape closes the dialog: keyboard users are not trapped.
    if (!k || k === 'Tab' || k === 'Shift-Tab' || k === 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    pending = canonicalKey(k);
    capture.value = prettyKey(pending);
    const o = ownerOf(pending);
    owner.textContent = o ? `Currently assigned to: ${getCommand(o)?.label || o}` : 'Currently unassigned';
  });
  const draw = () => {
    clearKeepingScroll(left, right);
    const list = items();
    left.append(h('label', { class: 'ql-label' }, 'Categories:'), catSel, search, commandList('commands', list, sel, (i) => { sel = i; pending = null; capture.value = ''; owner.textContent = ''; draw(); }));
    const c = list[sel];
    if (!c) return;
    const current = keysFor(c.id);
    right.append(h('h3', null, c.label), h('p', { class: 'ql-help' }, c.id + (c.tip ? ` — ${c.tip}` : '')),
      h('label', { class: 'ql-label' }, 'Current keys:'),
      h('div', { class: 'ql-cmdlist' }, ...(current.length ? current.map((k) => h('div', { class: 'ql-cmdlist-row' }, h('kbd', null, prettyKey(k)), h('button', { class: 'ql-iconbtn ql-sm', title: 'Remove', onclick: () => { keymap[k] = ''; draw(); } }, icon('close')))) : [h('div', { class: 'ql-help' }, '(none)')])),
      h('label', { class: 'ql-label' }, 'Press new shortcut key:'), capture, owner,
      h('div', { class: 'ql-row' },
        h('button', { class: 'ql-btn ql-primary', type: 'button', onclick: () => { if (!pending) { toast('Tap the box and press a key combination.'); return; } keymap[pending] = c.id; pending = null; capture.value = ''; owner.textContent = ''; draw(); } }, 'Assign'),
        h('button', { class: 'ql-btn', type: 'button', onclick: () => { for (const k of Object.keys(keymap)) if (keymap[k] === c.id || (keymap[k] === '' && (c.keys || []).map(canonicalKey).includes(k))) delete keymap[k]; draw(); } }, 'Reset Command')));
  };
  root.append(left, right);
  draw();
  const r = await openDialog({ title: 'Customize Keyboard', full: true, content: root, buttons: [{ label: 'Reset All', onClick: () => { for (const k of Object.keys(keymap)) delete keymap[k]; draw(); } }] });
  if (!r) return;
  app.prefs.keymap = keymap;
  app.savePrefs();
  app.ui.rebuild();
}
