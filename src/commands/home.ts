/** Home tab tools: select, hand, marquee zoom, snapshot. */
import { def } from './registry';
import type { App, DocTab, Tool } from '../app';
import { toast, openDialog } from '../ui/dialog';
import { download } from '../ui/dom';
import { saveBytes, viewer, type Rect } from './util';

export const tool = (id: string, t: Tool, label: string, icon: string, extra: Record<string, unknown> = {}) => ({
  id, label, icon, tab: 'Home', group: 'Tools', kind: 'toggle' as const, noRecord: true, edits: false,
  isActive: (app: App) => app.tab?.ui?.tool === t, run: (app: App) => { app.tab.ui.setTool(t); app.focus(); }, ...extra,
});

def([
  tool('home.select', 'select', 'Select', 'text_select_start', { keys: ['Escape', 'v'], tip: 'Select text, annotations and form fields' }),
  tool('home.hand', 'hand', 'Hand', 'pan_tool', { keys: ['h'], tip: 'Drag to scroll the page' }),
  tool('home.zoomTool', 'zoom', 'Marquee Zoom', 'zoom_in', { keys: ['z'], tip: 'Drag a rectangle to zoom into it; click to zoom in, Shift-click to zoom out' }),
  tool('home.snapshot', 'snapshot', 'Snapshot', 'photo_camera', { tip: 'Drag a rectangle to copy it as a picture, or save it' }),
]);

/** Marquee zoom: fit the dragged rectangle to the view. */
export function zoomToRect(app: App, page: number, rect: Rect, click: boolean, shift = false, tab: DocTab = app.tab): void {
  const v = viewer(tab);
  if (click) { v.setZoom(Math.min(8, Math.max(0.1, v.zoom * (shift ? 1 / 1.5 : 1.5)))); v.goToPage(page, rect[3]); return; }
  const w = rect[2] - rect[0], hh = rect[3] - rect[1];
  if (w < 4 || hh < 4) return;
  const el = v.el.querySelector<HTMLElement>('.qf-scroll');
  const cw = (el?.clientWidth || 800) - 40, ch = (el?.clientHeight || 600) - 24;
  const z = Math.min(cw / (w * 96 / 72), ch / (hh * 96 / 72));
  v.setZoom(Math.min(8, Math.max(0.1, z)));
  v.goToPage(page, rect[3]);
}

export async function snapshotRect(app: App, page: number, rect: Rect, tab: DocTab = app.tab): Promise<void> {
  const v = viewer(tab);
  if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) { const p = tab.doc.pages[page]; if (!p) return; rect = [p.cropBox[0], p.cropBox[1], p.cropBox[2], p.cropBox[3]]; }
  const blob = await v.renderRegion(page, rect, 200);
  app.clip = { image: { data: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: 0, height: 0 } };
  let copied = false;
  try { await (navigator.clipboard as any).write?.([new (window as any).ClipboardItem({ 'image/png': blob })]); copied = true; } catch { /* no image clipboard */ }
  const url = URL.createObjectURL(blob);
  try {
    const r = await openDialog({ title: 'Snapshot', content: Object.assign(document.createElement('img'), { src: url, style: 'max-width:100%;max-height:50vh;border:1px solid #ccc' }), help: copied ? 'Copied to the clipboard. You can also save it, or paste it into another page with Edit ▸ Paste.' : 'Save the picture, or paste it into another page with Edit ▸ Paste.', ok: 'Save as PNG…', cancel: 'Close' });
    if (r) await saveBytes(new Uint8Array(await blob.arrayBuffer()), `${(tab.title || 'snapshot')} page ${page + 1} snapshot.png`, 'image/png');
  } finally { URL.revokeObjectURL(url); }
  if (app.docs.includes(tab)) tab.ui.setTool('select');
}

export { toast, download };
