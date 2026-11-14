/** View commands: page layout, panes, zoom, rotation, modes, display, windows, Quick Access Bar and ribbon. */
import { def } from './registry';
import type { App, DocTab, ViewMode } from '../app';
import { openDialog, toast, inDialog } from '../ui/dialog';
import { addAllQatChoices } from '../prefs';
import { getCommand } from './registry';
import { PdfDocument } from '../pdf/document';
import { keepAwake } from '../platform/native';
import type { Viewer } from '../view/viewer';

const viewerOf = (tab: DocTab): Viewer => tab.ui as unknown as Viewer;
/** Moves by one page without the "not available" notice at either end (presentation keys and taps). */
function stepPage(_app: App, dir: 1 | -1, tab: DocTab): void {
  const i = tab.ui.page + dir;
  if (i >= 0 && i < tab.doc.pageCount) tab.ui.goToPage(i);
}

function setView(app: App, v: ViewMode): void {
  const t = app.tab;
  if (t.view === v) return;
  t.view = v;
  t.ui.layout();
  app.refresh();
}

const viewCmd = (id: string, v: ViewMode, label: string, icon: string, tip: string) => ({
  id, label, icon, tip, tab: 'View', group: 'Page Layout', kind: 'toggle' as const, noRecord: true, edits: false,
  isActive: (app: App) => app.tab?.view === v, run: (app: App) => setView(app, v),
});

const pref = (key: 'showThumbnails' | 'smoothScroll' | 'nightMode' | 'grayscale' | 'highlightFields') => ({
  kind: 'toggle' as const, noRecord: true, edits: false,
  isActive: (app: App) => !!app.prefs[key],
  run: (app: App) => { app.prefs[key] = !app.prefs[key]; app.savePrefs(); for (const d of app.docs) d.ui.layout(); app.tab.ui.refreshAnnotations(); app.refresh(); },
});

const paneCmd = (id: string, pane: string, label: string, icon: string, tip: string, keys?: string[]) => ({
  id, label, icon, tip, keys, tab: 'View', group: 'Panes', kind: 'toggle' as const, noRecord: true, edits: false,
  isActive: (app: App) => app.ui.paneOpen(pane), run: (app: App) => app.ui.togglePane(pane),
});

const ZOOMS = [25, 50, 75, 100, 125, 150, 200, 300, 400];

/** The running presentation: the tab it runs on (not whichever is active later) and what to put back when it ends. */
let presenting: { tab: DocTab; view: ViewMode; zoom: number | 'fit-width' | 'fit-page'; off: () => void } | null = null;
let fullscreenWatched = false;

/** Leaving the browser's full screen (its own Esc, a gesture) ends presentation and full-screen mode with it. */
function watchFullscreen(app: App): void {
  if (fullscreenWatched) return;
  fullscreenWatched = true;
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return;
    if (presenting) stopPresentation(app);
    else if (document.body.classList.contains('ql-fullscreen')) { document.body.classList.remove('ql-fullscreen'); app.refresh(); }
  });
}

/** Presentation mode: full screen, one page at a time, arrow keys and taps to move. */
function startPresentation(app: App): void {
  const tab = app.tab;
  const v = viewerOf(tab);
  watchFullscreen(app);
  const keys = (e: KeyboardEvent) => {
    if (!presenting) return;
    // Another document came to the front, or the presented one was closed: the presentation is over.
    if (app.tab !== tab || !app.docs.includes(tab)) { stopPresentation(app); return; }
    const t = e.target as HTMLElement | null;
    if (inDialog() || document.querySelector('.ql-menu') || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
    if (e.key === 'Escape') { stopPresentation(app); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'Enter') { stepPage(app, 1, tab); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'Backspace') { stepPage(app, -1, tab); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Home') tab.ui.goToPage(0);
    else if (e.key === 'End') tab.ui.goToPage(tab.doc.pageCount - 1);
  };
  const click = (e: MouseEvent) => { if ((e.target as HTMLElement).closest('.qf-page')) { const r = v.el.getBoundingClientRect(); stepPage(app, e.clientX < r.left + r.width / 3 ? -1 : 1, tab); } };
  presenting = { tab, view: tab.view, zoom: (v as any).fit || v.zoom, off: () => { document.removeEventListener('keydown', keys, true); v.el.removeEventListener('click', click); } };
  v.presenting = true;
  document.body.classList.add('ql-fullscreen', 'qf-presenting');
  tab.view = 'single';
  v.layout();
  v.setZoom('fit-page');
  try { void document.documentElement.requestFullscreen?.()?.catch?.(() => undefined); } catch { /* not allowed */ }
  void keepAwake(true);
  document.addEventListener('keydown', keys, true);
  v.el.addEventListener('click', click);
  toast('Presenting: arrow keys or tap to move, Esc to stop.', { ms: 4000 });
  app.refresh();
}

function stopPresentation(app: App): void {
  const p = presenting;
  if (!p) return;
  presenting = null;
  p.off();
  document.body.classList.remove('ql-fullscreen', 'qf-presenting');
  if (app.docs.includes(p.tab)) {
    const v = viewerOf(p.tab);
    v.presenting = false;
    p.tab.view = p.view;
    v.layout();
    v.setZoom(p.zoom);
  }
  try { if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); } catch { /* */ }
  void keepAwake(false);
  app.refresh();
}

def([
  viewCmd('view.continuous', 'continuous', 'Continuous', 'view_agenda', 'Pages scroll one after another'),
  viewCmd('view.single', 'single', 'Single Page', 'crop_portrait', 'One page at a time'),
  viewCmd('view.facing', 'facing', 'Facing Pages', 'auto_stories', 'Two pages side by side'),
  viewCmd('view.book', 'book', 'Book', 'menu_book', 'Two pages side by side with the first page alone, as in a bound book'),
  { id: 'view.thumbnails', label: 'Thumbnails', icon: 'view_sidebar', tab: 'View', group: 'Panes', keys: ['F4'], tip: 'The page thumbnails rail: click to go to a page, drag to reorder, right-click for page commands', ...pref('showThumbnails') },
  paneCmd('view.bookmarks', 'bookmarks', 'Bookmarks', 'bookmarks', 'The document outline', ['Mod-b']),
  paneCmd('view.attachments', 'attachments', 'Attachments', 'attach_file', 'Files embedded in the document'),
  paneCmd('view.layers', 'layers', 'Layers', 'layers', 'Optional content groups: show or hide each'),
  paneCmd('view.comments', 'comments', 'Comments', 'forum', 'Every annotation, by page, with replies', ['Mod-Shift-c']),
  paneCmd('view.signatures', 'signatures', 'Signatures', 'draw', 'Signature fields and existing signatures'),
  paneCmd('view.fields', 'fields', 'Form Fields', 'ballot', 'Every form field and its value'),
  paneCmd('view.searchPane', 'search', 'Search', 'search', 'Find text on every page', ['Mod-Shift-f']),
  paneCmd('view.inspector', 'inspector', 'Structure Inspector', 'account_tree', 'Browse the PDF object tree, from the trailer down; view any object raw'),
  {
    id: 'view.zoom', label: 'Zoom…', icon: 'zoom_in', tab: 'View', group: 'Zoom', noRecord: true, edits: false,
    run: async (app, z?: number | string) => {
      if (typeof z === 'number') { app.tab.ui.setZoom(z); return; }
      if (z === 'fit-width' || z === 'fit-page' || z === 'actual') { app.tab.ui.setZoom(z); return; }
      const tab = app.tab;
      const now = Math.round(tab.ui.zoom * 100);
      // The choice starts on the current zoom, and typing a percent selects "Custom", so OK applies what is shown.
      const r = await openDialog({ title: 'Zoom', fields: [{ key: 'z', label: 'Zoom to', type: 'radio', options: [{ value: 'fit-width', label: 'Fit width' }, { value: 'fit-page', label: 'Fit page' }, ...ZOOMS.map((x) => ({ value: String(x), label: `${x}%` })), { value: 'custom', label: 'Custom (the percent below)' }], value: ZOOMS.includes(now) ? String(now) : 'custom' }, { key: 'pct', label: 'Percent', type: 'number', min: 10, max: 800, value: now }], onChange: (v, ctl, k) => { if (k === 'z' && /^\d+$/.test(v.z)) ctl.set('pct', +v.z); else if (k === 'pct' && v.z !== 'custom') ctl.set('z', 'custom'); } });
      if (!r || !app.docs.includes(tab)) return;
      tab.ui.setZoom(String(r.z).startsWith('fit') ? r.z : Math.min(8, Math.max(0.1, (+r.pct || 100) / 100)));
    },
  },
  {
    id: 'view.zoomBox', label: 'Zoom Level', icon: 'zoom_in', tab: 'View', group: 'Zoom', kind: 'combo', noRecord: true, edits: false,
    value: (app) => `${Math.round((app.tab?.ui?.zoom || 1) * 100)}%`,
    menu: () => [{ id: 'view.zoom', arg: 'fit-width', label: 'Fit Width' }, { id: 'view.zoom', arg: 'fit-page', label: 'Fit Page' }, { separator: true }, ...ZOOMS.map((z) => ({ id: 'view.zoom', arg: z / 100, label: `${z}%` }))],
    run: (app, v?: string | number) => { if (v == null) return app.exec('view.zoom'); const n = typeof v === 'number' ? v : parseFloat(String(v)) / 100; if (n > 0) app.tab.ui.setZoom(Math.min(8, Math.max(0.1, n))); },
  },
  { id: 'view.fitWidth', label: 'Fit Width', icon: 'fit_width', tab: 'View', group: 'Zoom', keys: ['Mod-2'], noRecord: true, edits: false, run: (app) => app.tab.ui.setZoom('fit-width') },
  { id: 'view.fitPage', label: 'Fit Page', icon: 'fit_screen', tab: 'View', group: 'Zoom', keys: ['Mod-0'], noRecord: true, edits: false, run: (app) => app.tab.ui.setZoom('fit-page') },
  { id: 'view.actualSize', label: 'Actual Size', icon: 'crop_original', tab: 'View', group: 'Zoom', keys: ['Mod-1'], noRecord: true, edits: false, tip: '100%: one point per 1/72 inch on the screen', run: (app) => app.tab.ui.setZoom('actual') },
  { id: 'view.zoomIn', label: 'Zoom In', icon: 'zoom_in', tab: 'View', group: 'Zoom', keys: ['Mod-='], noRecord: true, edits: false, run: (app) => app.tab.ui.setZoom(Math.min(8, app.tab.ui.zoom * 1.25)) },
  { id: 'view.zoomOut', label: 'Zoom Out', icon: 'zoom_out', tab: 'View', group: 'Zoom', keys: ['Mod--'], noRecord: true, edits: false, run: (app) => app.tab.ui.setZoom(Math.max(0.1, app.tab.ui.zoom / 1.25)) },
  { id: 'view.rotateLeft', label: 'Rotate View Left', icon: 'rotate_left', tab: 'View', group: 'Rotate View', keys: ['Mod-Shift--'], noRecord: true, edits: false, tip: 'Turns the display only; Organize Pages ▸ Rotate changes the file', run: (app) => app.viewer.rotateView(-90) },
  { id: 'view.rotateRight', label: 'Rotate View Right', icon: 'rotate_right', tab: 'View', group: 'Rotate View', keys: ['Mod-Shift-='], noRecord: true, edits: false, run: (app) => app.viewer.rotateView(90) },
  {
    id: 'view.readMode', label: 'Read Mode', icon: 'chrome_reader_mode', tab: 'View', group: 'Modes', kind: 'toggle', noRecord: true, edits: false, keys: ['Mod-Shift-r'],
    tip: 'Hide the ribbon, panes and thumbnails to read; Esc or the same command returns',
    isActive: () => document.body.classList.contains('qf-read-mode'),
    run: (app) => { const on = !document.body.classList.contains('qf-read-mode'); document.body.classList.toggle('qf-read-mode', on); if (on && app.ui.pane) app.ui.closePane(); app.tab.ui.layout(); app.refresh(); },
  },
  {
    id: 'view.presentation', label: 'Presentation Mode', icon: 'slideshow', tab: 'View', group: 'Modes', kind: 'toggle', noRecord: true, edits: false, keys: ['F5'],
    tip: 'Full screen, one page at a time: arrow keys or taps move, Esc ends',
    isActive: () => !!presenting,
    run: (app) => { if (presenting) stopPresentation(app); else startPresentation(app); },
  },
  {
    id: 'view.fullScreen', label: 'Full Screen', icon: 'fullscreen', tab: 'View', group: 'Modes', kind: 'toggle', noRecord: true, edits: false, keys: ['F11'],
    tip: 'Hide the ribbon and use the whole screen (Esc returns)',
    isActive: () => document.body.classList.contains('ql-fullscreen'),
    run: (app) => {
      if (presenting) { stopPresentation(app); return; }
      watchFullscreen(app);
      const on = !document.body.classList.contains('ql-fullscreen');
      document.body.classList.toggle('ql-fullscreen', on);
      try { if (on) void document.documentElement.requestFullscreen?.()?.catch?.(() => undefined); else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); } catch { /* */ }
    },
  },
  {
    id: 'view.organize', label: 'Organize Pages', icon: 'grid_view', tab: 'View', group: 'Modes', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Every page as a thumbnail: select, drag to reorder, rotate, delete, extract (double-click a page to return to it)',
    isActive: (app) => !!app.viewer?.gridMode,
    run: (app) => { const v = app.viewer; v.setGridMode(!v.gridMode); if (v.gridMode) app.ui.currentTab = 'organize'; app.ui.renderTabs(); app.ui.renderRibbon(); app.refresh(); },
  },
  { id: 'view.nightMode', label: 'Night Mode', icon: 'dark_mode', tab: 'View', group: 'Display', tip: 'Invert the page colors for reading in the dark', ...pref('nightMode') },
  { id: 'view.grayscale', label: 'Grayscale', icon: 'filter_b_and_w', tab: 'View', group: 'Display', tip: 'Show the pages as they print in grayscale', ...pref('grayscale') },
  { id: 'view.smoothScroll', label: 'Smooth Scrolling', icon: 'swipe_vertical', tab: 'View', group: 'Display', ...pref('smoothScroll') },
  { id: 'forms.highlightFields', label: 'Highlight Fields', icon: 'highlight', tab: 'Forms', group: 'Fill', tip: 'Tint every form field so they are easy to find', ...pref('highlightFields') },
  {
    id: 'view.switchWindow', label: 'Switch Windows', icon: 'tab', tab: 'View', group: 'Window', kind: 'menu', keys: ['Mod-F6'], noRecord: true, edits: false,
    menu: (app) => app.docs.map((d) => ({ id: 'view.switchWindow', arg: d.id, label: d.displayName + (d.dirty ? ' •' : ''), checked: d === app.tab })),
    run: (app, id?: string) => { const d = app.docs.find((x) => x.id === id) || app.docs[(app.docs.indexOf(app.tab) + 1) % app.docs.length]; if (d) app.activate(d); },
  },
  {
    id: 'view.newWindow', label: 'New Window', icon: 'open_in_new', tab: 'View', group: 'Window', noRecord: true, edits: false,
    tip: 'A second view of this document as another tab (a copy of its current state, to read one part while editing another)',
    run: (app) => {
      const t = app.tab;
      const bytes = t.bytes.slice();
      const twin = app.createTab(PdfDocument.load(bytes, { password: t.password || undefined }), { title: `${t.title}:2`, fileName: '', format: t.format, password: t.password }, bytes);
      twin.dirty = false;
      twin.ui.goToPage(t.ui.page);
      app.ui.tabsChanged();
    },
  },
  {
    id: 'view.compareSideBySide', label: 'Side by Side', icon: 'vertical_split', tab: 'View', group: 'Window', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Show another open document beside this one (Review ▸ Compare lists the text differences)',
    isActive: (app) => !!app.split,
    run: async (app, otherId?: string) => {
      if (app.split) { app.endSplit(); app.activate(app.tab); return; }
      const tab = app.tab;
      const others = app.docs.filter((d) => d !== tab);
      if (!others.length) { toast('Open another document first (or View ▸ New Window for a second view of this one).'); return; }
      let other = others.find((d) => d.id === otherId);
      if (!other) {
        if (others.length === 1) other = others[0];
        else { const r = await openDialog({ title: 'Side by Side', fields: [{ key: 'd', label: 'Show beside this document', type: 'select', options: others.map((d) => ({ value: d.id, label: d.displayName })), value: others[0].id }] }); if (!r) return; other = others.find((d) => d.id === r.d); }
      }
      // Either document may have been closed, or another brought to the front, while the dialog was open.
      if (!other || !app.docs.includes(other) || app.tab !== tab || other === tab) return;
      app.split = other.id;
      other.el.classList.add('ql-split-pane');
      app.ui.workspace.classList.add('ql-split');
      other.ui.layout(); tab.ui.layout();
      app.refresh();
    },
  },
]);

// Quick Access Bar and ribbon -----------------------------------------------------------------

def([
  { id: 'view.cmdSearch', label: 'Search Commands', icon: 'search', tab: 'View', group: 'Help', keys: ['Alt-q'], popular: true, noRecord: true, edits: false, run: (app) => app.ui.commandPalette() },
  {
    id: 'view.qatAddAll', label: 'Add All Quick Access Choices (A–Z)', icon: 'sort_by_alpha', tab: 'View', group: 'Quick Access Bar', noRecord: true, edits: false,
    tip: 'Put every drop-down choice on the Quick Access Bar: Save and Print first, then the rest alphabetically',
    run: (app) => { app.prefs.qat = addAllQatChoices(app.prefs.qat, (id) => getCommand(id)?.label); app.prefs.qatHidden = false; app.savePrefs(); app.ui.applyPrefs(); app.ui.renderQat(); toast('All Quick Access choices added'); },
  },
  {
    id: 'view.qatPosition', label: 'Quick Access Bar Position', icon: 'swap_vert', tab: 'View', group: 'Quick Access Bar', kind: 'menu', noRecord: true, edits: false,
    menu: (app) => (['top', 'below', 'bottom'] as const).map((p) => ({ id: 'view.qatPosition', arg: p, label: p === 'top' ? 'Show Above the Ribbon' : p === 'below' ? 'Show Below the Ribbon' : 'Show at the Bottom (near keyboard)', checked: app.prefs.qatPosition === p })),
    run: (app, pos?: 'top' | 'below' | 'bottom') => { const order: ('top' | 'below' | 'bottom')[] = ['top', 'below', 'bottom']; app.prefs.qatPosition = pos || order[(order.indexOf(app.prefs.qatPosition) + 1) % 3]; app.savePrefs(); app.ui.applyPrefs(); },
  },
  { id: 'view.qatLabels', label: 'Quick Access Bar Labels', icon: 'label', tab: 'View', group: 'Quick Access Bar', kind: 'toggle', noRecord: true, edits: false, isActive: (app) => app.prefs.qatLabels, run: (app) => { app.prefs.qatLabels = !app.prefs.qatLabels; app.savePrefs(); app.ui.renderQat(); } },
  { id: 'view.qatShow', label: 'Show Quick Access Bar', icon: 'bolt', tab: 'View', group: 'Quick Access Bar', noRecord: true, edits: false, run: (app) => { app.prefs.qatHidden = false; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'view.qatHide', label: 'Hide Quick Access Bar', icon: 'visibility_off', tab: 'View', group: 'Quick Access Bar', noRecord: true, edits: false, run: (app) => { app.prefs.qatHidden = true; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'view.collapseRibbon', label: 'Collapse the Ribbon', icon: 'expand_less', tab: 'View', group: 'Ribbon', keys: ['Mod-F1'], kind: 'toggle', noRecord: true, edits: false, isActive: (app) => app.prefs.ribbon !== 'full', run: (app) => { app.prefs.ribbon = app.prefs.ribbon === 'full' ? 'tabs' : 'full'; app.savePrefs(); app.ui.applyPrefs(); } },
  { id: 'view.touchMode', label: 'Touch/Mouse Mode', icon: 'touch_app', tab: 'View', group: 'Ribbon', kind: 'toggle', noRecord: true, edits: false, tip: 'More space between commands for fingers', isActive: (app) => app.prefs.touchMode, run: (app) => { app.prefs.touchMode = !app.prefs.touchMode; app.savePrefs(); app.ui.applyPrefs(); } },
  {
    id: 'view.theme', label: 'Dark Mode', icon: 'dark_mode', tab: 'View', group: 'Appearance', kind: 'menu', noRecord: true, edits: false,
    menu: (app) => (['system', 'light', 'dark'] as const).map((t) => ({ id: 'view.theme', arg: t, label: t === 'system' ? 'Follow the System' : t === 'light' ? 'Light' : 'Dark', checked: app.prefs.theme === t })),
    run: (app, t?: 'system' | 'light' | 'dark') => { app.prefs.theme = t || (app.prefs.theme === 'dark' ? 'light' : 'dark'); app.savePrefs(); app.ui.applyPrefs(); },
  },
]);
