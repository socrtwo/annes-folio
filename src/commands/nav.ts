/** Page navigation. */
import { def } from './registry';
import type { App, DocTab } from '../app';
import { openDialog, toast } from '../ui/dialog';

const go = (app: App, i: number, tab: DocTab = app.tab) => tab.ui.goToPage(Math.max(0, Math.min(tab.doc.pageCount - 1, i)));
def([
  { id: 'nav.first', label: 'First Page', icon: 'first_page', tab: 'Home', group: 'Pages', keys: ['Mod-Home'], noRecord: true, edits: false, isEnabled: (app) => app.page > 0, run: (app) => go(app, 0) },
  { id: 'nav.prev', label: 'Previous Page', icon: 'navigate_before', tab: 'Home', group: 'Pages', keys: ['Alt-ArrowLeft'], noRecord: true, edits: false, isEnabled: (app) => app.page > 0, run: (app) => go(app, app.page - 1) },
  { id: 'nav.next', label: 'Next Page', icon: 'navigate_next', tab: 'Home', group: 'Pages', keys: ['Alt-ArrowRight'], noRecord: true, edits: false, isEnabled: (app) => app.page < app.doc.pageCount - 1, run: (app) => go(app, app.page + 1) },
  { id: 'nav.last', label: 'Last Page', icon: 'last_page', tab: 'Home', group: 'Pages', keys: ['Mod-End'], noRecord: true, edits: false, isEnabled: (app) => app.page < app.doc.pageCount - 1, run: (app) => go(app, app.doc.pageCount - 1) },
  {
    id: 'nav.pageNumber', label: 'Page Number', icon: 'tag', tab: 'Home', group: 'Pages', kind: 'combo', noRecord: true, edits: false,
    tip: 'Type a page number (or label) and press Enter',
    value: (app) => { const labels = app.viewer.pageLabels?.() || []; return labels[app.page] || String(app.page + 1); },
    run: (app, v?: string) => {
      if (v == null) return app.exec('nav.goTo');
      const labels = app.viewer.pageLabels?.() || [];
      const s = String(v).trim();
      const byLabel = labels.findIndex((l) => l.toLowerCase() === s.toLowerCase());
      const n = byLabel >= 0 ? byLabel : parseInt(s, 10) - 1;
      if (Number.isNaN(n) || n < 0 || n >= app.doc.pageCount) { toast(`No page "${s}".`); return; }
      go(app, n);
    },
  },
  {
    id: 'nav.goTo', label: 'Go to Page…', icon: 'my_location', tab: 'Home', group: 'Pages', keys: ['Mod-g', 'Mod-Shift-n'], noRecord: true, edits: false,
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Go to Page', fields: [{ key: 'n', label: `Page (1–${tab.doc.pageCount})`, type: 'number', min: 1, max: tab.doc.pageCount, value: tab.ui.page + 1, autofocus: true }] });
      if (r && app.docs.includes(tab)) go(app, (+r.n || 1) - 1, tab);
    },
  },
  { id: 'nav.back', label: 'Back', icon: 'arrow_back', tab: 'Home', group: 'Pages', keys: ['Alt-ArrowUp'], noRecord: true, edits: false, tip: 'Return to the page you came from (after following a link or bookmark)', isEnabled: (app) => history(app).length > 0, run: (app) => { const h = history(app); const i = h.pop(); if (i != null) { forward(app).push(app.page); app.tab.ui.goToPage(i); } } },
  { id: 'nav.forward', label: 'Forward', icon: 'arrow_forward', tab: 'Home', group: 'Pages', keys: ['Alt-ArrowDown'], noRecord: true, edits: false, isEnabled: (app) => forward(app).length > 0, run: (app) => { const f = forward(app); const i = f.pop(); if (i != null) { history(app).push(app.page); app.tab.ui.goToPage(i); } } },
]);

const hist = new WeakMap<object, { back: number[]; fwd: number[] }>();
function nav(app: App) { let h = hist.get(app.tab); if (!h) { h = { back: [], fwd: [] }; hist.set(app.tab, h); } return h; }
export const history = (app: App): number[] => nav(app).back;
export const forward = (app: App): number[] => nav(app).fwd;
/** Records the current page before a jump (links, bookmarks, search). */
export function remember(app: App): void { const h = nav(app); h.back.push(app.page); if (h.back.length > 50) h.back.shift(); h.fwd = []; }
