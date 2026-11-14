/**
 * Side panes (task panes). On phones they appear as bottom sheets. Command modules register their own
 * panes with registerPane(); the core ones (Bookmarks, Attachments, Layers, Comments, Signatures, Fields,
 * Search, Structure Inspector, Version History, Report) are defined here.
 */
import type { App } from '../app';
import { h, icon, clear, download } from './dom';
import { toast, confirmDialog, promptDialog, openDialog } from './dialog';
import { kvKeys, kvGet, kvDel } from '../util/store';
import { readOutlines, readAttachments, readLayers, setLayerVisible, pageAnnotations, readFields, readSignatures, allAnnotations, removeAttachment, type OutlineItem, type AnnotInfo } from '../pdf/structure';
import { Dict, PdfStream, PdfString, Ref, Name, PdfObj, isName, nameText } from '../pdf/objects';
import { serialize } from '../pdf/writer';
import type { CheckItem } from '../pdf/ops/optimize';
import { PdfDocument, PasswordNeeded } from '../pdf/document';

export interface PaneDef {
  id: string;
  title: string;
  render: (app: App, el: HTMLElement, opts: any) => void;
  update?: (app: App, el: HTMLElement, opts: any) => void;
  onOpen?: (app: App, el: HTMLElement, opts: any) => void;
  onClose?: (app: App) => void;
}

export const PANES: Record<string, PaneDef> = {};
export function registerPane(def: PaneDef): void { PANES[def.id] = def; }

/** True while the user is typing in a field of the pane (redrawing would destroy the field). */
export const typingIn = (el: HTMLElement) => { const a = document.activeElement as HTMLElement | null; return !!a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'); };
export const sigOf = (el: HTMLElement, sig: string) => { if (el.dataset.sig === sig) return false; el.dataset.sig = sig; return true; };
const docSig = (app: App) => `${app.tab.id}:${app.tab.bytes.length}:${app.tab.doc.changed.size}`;

// ------------------------------------------------------------------------------------------
// Bookmarks

registerPane({
  id: 'bookmarks', title: 'Bookmarks',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    if (!sigOf(el, docSig(app)) || typingIn(el)) return;
    clear(el);
    const items = readOutlines(app.doc);
    const bar = h('div', { class: 'ql-pane-bar' },
      h('button', { class: 'ql-btn', onclick: () => app.exec('tools.addBookmark') }, icon('bookmark_add'), ' Add'),
      h('button', { class: 'ql-btn', onclick: () => app.exec('tools.bookmarksFromHeadings') }, icon('auto_fix_high'), ' From headings'),
      h('button', { class: 'ql-iconbtn', title: 'Expand all', onclick: () => el.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => (d.open = true)) }, icon('unfold_more')),
      h('button', { class: 'ql-iconbtn', title: 'Collapse all', onclick: () => el.querySelectorAll<HTMLDetailsElement>('details').forEach((d) => (d.open = false)) }, icon('unfold_less')));
    el.appendChild(bar);
    if (!items.length) { el.appendChild(h('p', { class: 'ql-help' }, 'No bookmarks. Add one for the current page, or build them from the headings.')); return; }
    const draw = (list: OutlineItem[], depth: number): HTMLElement => h('div', { class: 'ql-tree' }, list.map((it) => {
      const row = h('div', { class: 'ql-nav-item ql-bm', style: `padding-left:${8 + depth * 14}px` },
        h('button', { class: 'ql-nav-link', onclick: () => { if (it.dest) app.tab.ui.goToPage(it.dest.page, it.dest.y); else if (it.url) app.followLink(it.url); } }, icon(it.children.length ? 'bookmark' : 'bookmark_border'), h('span', { style: `${it.bold ? 'font-weight:600;' : ''}${it.italic ? 'font-style:italic;' : ''}` }, it.title || '(untitled)')),
        h('span', { class: 'ql-help' }, it.dest ? String(it.dest.page + 1) : it.url ? 'link' : ''),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Edit', onclick: () => app.exec('tools.editBookmark', it) }, icon('edit')),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Delete', onclick: () => app.exec('tools.deleteBookmark', it) }, icon('delete')));
      if (!it.children.length) return row;
      const det = h('details', { open: it.open ? '' : null }, h('summary', null, row), draw(it.children, depth + 1));
      return det;
    }));
    el.appendChild(draw(items, 0));
  },
});

// ------------------------------------------------------------------------------------------
// Attachments

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

registerPane({
  id: 'attachments', title: 'Attachments',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    if (!sigOf(el, docSig(app))) return;
    clear(el);
    el.appendChild(h('div', { class: 'ql-pane-bar' }, h('button', { class: 'ql-btn', onclick: () => app.exec('tools.addAttachment') }, icon('attach_file'), ' Attach file…')));
    const list = readAttachments(app.doc);
    if (!list.length) { el.appendChild(h('p', { class: 'ql-help' }, 'No embedded files.')); return; }
    for (const a of list) {
      el.appendChild(h('div', { class: 'ql-nav-item' },
        icon(a.where === 'document' ? 'attachment' : 'push_pin'),
        h('div', { style: 'flex:1;min-width:0' }, h('b', null, a.name), h('div', { class: 'ql-help' }, `${fmtSize(a.size)}${a.mime ? ' · ' + a.mime : ''}${typeof a.where === 'number' ? ` · page ${a.where + 1}` : ''}${a.description ? ' · ' + a.description : ''}`)),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Open', onclick: () => app.exec('tools.openAttachment', a) }, icon('open_in_new')),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Save', onclick: () => app.exec('tools.saveAttachment', a) }, icon('download')),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Remove', onclick: async () => { if (await confirmDialog('Remove Attachment', `Remove "${a.name}" from the document?`, 'Remove')) app.edit('Remove Attachment', (doc) => removeAttachment(doc, a)); } }, icon('delete'))));
    }
  },
});

// ------------------------------------------------------------------------------------------
// Layers

registerPane({
  id: 'layers', title: 'Layers',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    if (!sigOf(el, docSig(app))) return;
    clear(el);
    const layers = readLayers(app.doc);
    if (!layers.length) { el.appendChild(h('p', { class: 'ql-help' }, 'This document has no optional content (layers).')); return; }
    for (const l of layers) {
      const cb = h('input', { type: 'checkbox', checked: l.on ? '' : null }) as HTMLInputElement;
      cb.addEventListener('change', () => app.edit(cb.checked ? 'Show Layer' : 'Hide Layer', (doc) => setLayerVisible(doc, l, cb.checked)));
      el.appendChild(h('label', { class: 'ql-nav-item' }, cb, h('span', null, l.name)));
    }
  },
});

// ------------------------------------------------------------------------------------------
// Comments

export function annotLabel(a: AnnotInfo): string {
  const names: Record<string, string> = { Text: 'Note', FreeText: 'Text box', Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikethrough', Squiggly: 'Squiggly', Ink: 'Drawing', Square: 'Rectangle', Circle: 'Ellipse', Line: 'Line', Polygon: 'Polygon', PolyLine: 'Polyline', Stamp: 'Stamp', FileAttachment: 'Attached file', Redact: 'Redaction mark', Link: 'Link', Caret: 'Caret', Sound: 'Audio', Widget: 'Form field' };
  return names[a.subtype] || a.subtype;
}

registerPane({
  id: 'comments', title: 'Comments',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const sel = app.tab.ui.selectedAnnot;
    // Not the current page: the list does not depend on it, and re-reading every annotation on each page turn is slow.
    const sig = docSig(app) + ':' + (sel ? `${sel.page}.${sel.num}` : '');
    if (!sigOf(el, sig) || typingIn(el)) return;
    clear(el);
    const filter = h('input', { class: 'ql-input', placeholder: 'Filter comments…', 'aria-label': 'Filter' }) as HTMLInputElement;
    const bar = h('div', { class: 'ql-pane-bar' },
      h('button', { class: 'ql-btn', onclick: () => app.exec('comment.note') }, icon('add_comment'), ' Note'),
      h('button', { class: 'ql-iconbtn', title: 'Summarize comments', onclick: () => app.exec('comment.summarize') }, icon('summarize')),
      h('button', { class: 'ql-iconbtn', title: 'Export comments (XFDF)', onclick: () => app.exec('comment.exportXfdf') }, icon('ios_share')),
      h('button', { class: 'ql-iconbtn', title: 'Import comments (XFDF)', onclick: () => app.exec('comment.importXfdf') }, icon('download')));
    const list = h('div', { class: 'ql-nav-list' });
    const all = allAnnotations(app.doc).filter((a) => !['Widget', 'Popup', 'Link'].includes(a.subtype));
    const roots = all.filter((a) => !a.irt);
    const draw = () => {
      clear(list);
      const q = filter.value.trim().toLowerCase();
      let lastPage = -1;
      for (const a of roots) {
        const replies = all.filter((r) => r.irt && a.ref && r.irt.num === a.ref.num);
        const text = `${a.contents} ${a.author} ${annotLabel(a)} ${replies.map((r) => r.contents).join(' ')}`.toLowerCase();
        if (q && !text.includes(q)) continue;
        if (a.page !== lastPage) { lastPage = a.page; list.appendChild(h('h3', { class: 'ql-pane-h' }, `Page ${a.page + 1}`)); }
        const isSel = !!sel && !!a.ref && sel.num === a.ref.num && sel.page === a.page;
        const row = h('div', { class: 'ql-comment' + (isSel ? ' ql-on' : '') },
          h('button', { class: 'ql-nav-link', onclick: () => { app.tab.ui.goToPage(a.page, a.rect[3] + 40); app.tab.ui.selectedAnnot = a.ref ? { page: a.page, num: a.ref.num } : null; app.tab.ui.refreshAnnotations(); app.refresh(); } },
            h('span', { class: 'ql-comment-swatch', style: a.color ? `background:rgb(${a.color.map((c) => Math.round(c * 255)).join(',')})` : '' }),
            h('div', { style: 'flex:1;min-width:0' }, h('b', null, `${annotLabel(a)}${a.author ? ' · ' + a.author : ''}`), a.contents ? h('div', { class: 'ql-comment-text' }, a.contents) : null, h('div', { class: 'ql-help' }, `${a.date ? a.date.toLocaleString() : ''}${a.state ? ' · ' + a.state : ''}`))),
          h('div', { class: 'ql-comment-actions' },
            h('button', { class: 'ql-iconbtn ql-sm', title: 'Reply', onclick: () => { app.tab.ui.selectedAnnot = a.ref ? { page: a.page, num: a.ref.num } : null; app.exec('comment.reply'); } }, icon('reply')),
            h('button', { class: 'ql-iconbtn ql-sm', title: 'Properties', onclick: () => { app.tab.ui.selectedAnnot = a.ref ? { page: a.page, num: a.ref.num } : null; app.exec('comment.properties'); } }, icon('tune')),
            h('button', { class: 'ql-iconbtn ql-sm', title: 'Delete', onclick: () => { app.tab.ui.selectedAnnot = a.ref ? { page: a.page, num: a.ref.num } : null; app.exec('comment.delete'); } }, icon('delete'))));
        for (const r of replies) row.appendChild(h('div', { class: 'ql-comment-reply' }, h('b', null, r.author || 'Reply'), r.state ? h('span', { class: 'ql-chip' }, r.state) : null, h('div', { class: 'ql-comment-text' }, r.contents), h('div', { class: 'ql-help' }, r.date ? r.date.toLocaleString() : '')));
        list.appendChild(row);
      }
      if (!roots.length) list.appendChild(h('p', { class: 'ql-help' }, 'No comments yet. Select text and use the Comment tab, or add a note.'));
    };
    filter.addEventListener('input', draw);
    el.append(bar, filter, list);
    draw();
  },
});

// ------------------------------------------------------------------------------------------
// Signatures

registerPane({
  id: 'signatures', title: 'Signatures',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    if (!sigOf(el, docSig(app))) return;
    clear(el);
    const sigs = readSignatures(app.doc);
    el.appendChild(h('div', { class: 'ql-pane-bar' }, h('button', { class: 'ql-btn', onclick: () => app.exec('sign.signature') }, icon('draw'), ' Sign'), h('button', { class: 'ql-btn', onclick: () => app.exec('forms.signatureField') }, icon('add_box'), ' Add field')));
    if (!sigs.length) { el.appendChild(h('p', { class: 'ql-help' }, 'No signature fields. Fill & Sign places a drawn or typed signature on the page; Add field makes a field for a certificate-based signature in another program.')); return; }
    for (const s of sigs) {
      el.appendChild(h('div', { class: 'ql-nav-item' }, icon(s.signed ? (s.coversWholeFile ? 'verified' : 'warning') : 'edit_square'),
        h('div', { style: 'flex:1;min-width:0' }, h('b', null, s.field), h('div', { class: 'ql-help' }, s.signed ? `${s.signer || 'Unknown signer'}${s.date ? ' · ' + s.date.toLocaleString() : ''}${s.reason ? ' · ' + s.reason : ''}${s.location ? ' · ' + s.location : ''}` : 'Unsigned'),
          s.signed ? h('div', { class: 'ql-help' }, `${s.subFilter || s.filter}; byte range ${s.coversWholeFile ? 'covers the whole file (no later changes)' : 'does not cover the whole file: the document was changed after signing'}. Anne's Folio does not verify certificates.`) : null)));
    }
  },
});

// ------------------------------------------------------------------------------------------
// Fields

registerPane({
  id: 'fields', title: 'Form Fields',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    if (!sigOf(el, docSig(app)) || typingIn(el)) return;
    clear(el);
    const fields = readFields(app.doc);
    el.appendChild(h('div', { class: 'ql-pane-bar' }, h('button', { class: 'ql-btn', onclick: () => app.exec('forms.textField') }, icon('add_box'), ' Text field'), h('button', { class: 'ql-iconbtn', title: 'Reset form', onclick: () => app.exec('forms.reset') }, icon('restart_alt')), h('button', { class: 'ql-iconbtn', title: 'Export data', onclick: () => app.exec('forms.exportData') }, icon('ios_share'))));
    if (!fields.length) { el.appendChild(h('p', { class: 'ql-help' }, 'This document has no form fields. Use the Forms tab to add some, or Detect Form Fields.')); return; }
    for (const f of fields) {
      const w = f.widgets[0];
      const val = typeof f.value === 'boolean' ? (f.value ? '☑' : '☐') : Array.isArray(f.value) ? f.value.join(', ') : f.value;
      el.appendChild(h('div', { class: 'ql-nav-item' },
        h('button', { class: 'ql-nav-link', onclick: () => { if (w && w.page >= 0) { app.tab.ui.goToPage(w.page, w.rect[3] + 40); app.tab.ui.selectedAnnot = { page: w.page, num: w.ref.num }; app.tab.ui.refreshAnnotations(); app.refresh(); } } },
          icon({ text: 'text_fields', checkbox: 'check_box', radio: 'radio_button_checked', combo: 'arrow_drop_down_circle', list: 'list', button: 'smart_button', signature: 'draw', unknown: 'help' }[f.type]),
          h('div', { style: 'flex:1;min-width:0' }, h('b', null, f.name), h('div', { class: 'ql-help' }, `${f.type}${f.required ? ' · required' : ''}${f.readOnly ? ' · read-only' : ''}${w && w.page >= 0 ? ` · page ${w.page + 1}` : ''}${val ? ' · ' + String(val).slice(0, 40) : ''}`))),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Fill', onclick: () => app.exec('forms.fillValue', f.name) }, icon('edit')),
        h('button', { class: 'ql-iconbtn ql-sm', title: 'Properties', onclick: () => app.exec('forms.properties', f.name) }, icon('tune'))));
    }
  },
});

// ------------------------------------------------------------------------------------------
// Search

registerPane({
  id: 'search', title: 'Search',
  render(app, el, opts) {
    clear(el);
    const input = h('input', { class: 'ql-input', placeholder: 'Find in document…', 'aria-label': 'Find', value: opts?.q || '' }) as HTMLInputElement;
    const cs = h('input', { type: 'checkbox' }) as HTMLInputElement, ww = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const results = h('div', { class: 'ql-nav-list' });
    const status = h('p', { class: 'ql-help' }, 'Type to search every page.');
    let timer: any;
    let seq = 0;
    const run = async () => {
      const q = input.value;
      const my = ++seq;
      const tab = app.tab;
      let counts: { page: number; count: number }[];
      try { counts = await tab.ui.search(q, { caseSensitive: cs.checked, wholeWord: ww.checked }); }
      catch (e: any) { if (my === seq) status.textContent = `The search stopped: ${e?.message || e}`; return; }
      // Only the latest query fills the list: an older one that was still reading pages is dropped.
      if (my !== seq || app.tab !== tab) return;
      clear(results);
      const total = counts.reduce((n, c) => n + c.count, 0);
      status.textContent = q ? (total ? `${total} match${total === 1 ? '' : 'es'} on ${counts.length} page${counts.length === 1 ? '' : 's'}` : 'No matches') : 'Type to search every page.';
      for (const c of counts) results.appendChild(h('button', { class: 'ql-nav-item', onclick: () => { app.tab.ui.goToPage(c.page); } }, icon('find_in_page'), h('span', null, `Page ${c.page + 1}`), h('span', { class: 'ql-help' }, `${c.count}`)));
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); app.tab.ui.findNext(e.shiftKey ? -1 : 1); } });
    cs.addEventListener('change', run); ww.addEventListener('change', run);
    el.append(input, h('div', { class: 'ql-pane-bar' }, h('label', null, cs, ' Match case'), h('label', null, ww, ' Whole words'), h('button', { class: 'ql-iconbtn', title: 'Previous', onclick: () => app.tab.ui.findNext(-1) }, icon('expand_less')), h('button', { class: 'ql-iconbtn', title: 'Next', onclick: () => app.tab.ui.findNext(1) }, icon('expand_more'))), status, results);
    if (opts?.q) void run();
    setTimeout(() => input.focus(), 30);
  },
  onClose(app) { app.tab?.ui.clearSearch(); },
});

// ------------------------------------------------------------------------------------------
// Structure inspector

function objSummary(o: PdfObj): string {
  if (o instanceof Dict) return `<< ${o.type ? '/' + o.type + ' ' : ''}${o.size} keys >>`;
  if (o instanceof PdfStream) return `stream ${o.dict.type ? '/' + o.dict.type + ' ' : ''}(${o.raw.length} bytes)`;
  if (Array.isArray(o)) return `[ ${o.length} items ]`;
  if (o instanceof PdfString) return JSON.stringify(o.toText().slice(0, 60));
  if (o instanceof Ref) return o.toString();
  if (o instanceof Name) return '/' + nameText(o.name);
  return String(o);
}

registerPane({
  id: 'inspector', title: 'Structure Inspector',
  render(app, el, opts) { this.update!(app, el, opts); },
  update(app, el) {
    if (!sigOf(el, docSig(app))) return;
    clear(el);
    const doc = app.doc;
    const node = (label: string, o: PdfObj, depth: number, visited: Set<string>): HTMLElement => {
      const summary = h('summary', null, h('b', null, label), ' ', h('span', { class: 'ql-help' }, objSummary(o)));
      const det = h('details', { class: 'ql-inspect', style: `margin-left:${Math.min(depth, 12) * 6}px` }, summary);
      let filled = false;
      det.addEventListener('toggle', () => {
        if (!det.open || filled) return;
        filled = true;
        let v: PdfObj = o;
        if (v instanceof Ref) { if (visited.has(v.key)) { det.appendChild(h('div', { class: 'ql-help' }, '(already shown above)')); return; } visited = new Set([...visited, v.key]); v = doc.fetch(v); det.appendChild(h('div', { class: 'ql-help' }, objSummary(v))); }
        const d = v instanceof PdfStream ? v.dict : v;
        if (d instanceof Dict) for (const k of d.keys()) det.appendChild(node('/' + k, d.get(k)!, depth + 1, visited));
        else if (Array.isArray(d)) d.slice(0, 500).forEach((x, i) => det.appendChild(node(`[${i}]`, x, depth + 1, visited)));
        if (v instanceof PdfStream) {
          const s = v;
          det.appendChild(h('div', { class: 'ql-pane-bar' },
            h('button', { class: 'ql-btn ql-sm', onclick: () => { try { const data = doc.decoded(s); const txt = new TextDecoder('latin1').decode(data.subarray(0, 20000)); void openDialog({ title: 'Stream contents', wide: true, cancel: false, content: h('pre', { class: 'ql-notices', style: 'max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:11px' }, txt + (data.length > 20000 ? `\n… (${data.length} bytes)` : '')) }); } catch (e: any) { toast(`Could not decode: ${e?.message || e}`); } } }, 'Show decoded'),
            h('button', { class: 'ql-btn ql-sm', onclick: () => { try { download(new Blob([doc.decoded(s) as BlobPart]), `${label.replace(/\W/g, '') || 'stream'}.bin`); } catch (e: any) { toast(String(e?.message || e)); } } }, 'Save decoded')));
        }
        if (!(d instanceof Dict) && !Array.isArray(d) && !(v instanceof PdfStream)) det.appendChild(h('pre', { class: 'ql-notices', style: 'white-space:pre-wrap;font-size:11px' }, new TextDecoder('latin1').decode(serialize(v))));
      });
      return det;
    };
    el.appendChild(h('p', { class: 'ql-help' }, `${doc.objectNumbers().length} objects · ${doc.report.header || 'no header'}${doc.usesXrefStream ? ' · xref stream' : ' · xref table'}${doc.security ? ' · encrypted' : ''}${doc.report.reconstructed ? ' · rebuilt' : ''}`));
    el.appendChild(node('trailer', doc.trailer, 0, new Set()));
    const p = doc.pages[app.page];
    if (p) el.appendChild(node(`page ${app.page + 1}`, p.ref || p.dict, 0, new Set()));
    const go = h('input', { class: 'ql-input', placeholder: 'Object number…', inputmode: 'numeric' }) as HTMLInputElement;
    go.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const n = parseInt(go.value, 10); if (n >= 0) { const r = new Ref(n, doc.genOf(n)); const det = node(`${n} ${r.gen} obj`, r, 0, new Set()); el.appendChild(det); (det as HTMLDetailsElement).open = true; } } });
    el.appendChild(go);
  },
});

// ------------------------------------------------------------------------------------------
// Version history

registerPane({
  id: 'versions', title: 'Version History',
  render(app, el) { this.update!(app, el, {}); },
  update(app, el) {
    const sig = `${app.tab.id}:${app.tab.saved}`;
    if (!sigOf(el, sig)) return;
    clear(el);
    el.appendChild(h('p', { class: 'ql-help' }, 'Snapshots are kept on this device each time you save, and when you choose File ▸ Info ▸ Take Snapshot.'));
    el.appendChild(h('button', { class: 'ql-btn', onclick: async () => { await app.exec('file.snapshot'); el.dataset.sig = ''; } }, icon('add_a_photo'), ' Take Snapshot'));
    const list = h('div', { class: 'ql-nav-list' });
    el.appendChild(list);
    const tab = app.tab;
    void (async () => {
      try {
        const { docKey } = await import('../commands/file');
        const prefix = `snap:${docKey(tab)}:`;
        const keys = (await kvKeys(prefix)).sort((a, b) => (+b.slice(prefix.length) || 0) - (+a.slice(prefix.length) || 0));
        if (!keys.length) list.appendChild(h('p', { class: 'ql-help' }, 'No snapshots yet.'));
        for (const k of keys) {
          const m = await snapshotLabel(k, prefix);
          if (!m) continue;
          list.appendChild(h('div', { class: 'ql-nav-item' },
            icon('history'), h('span', null, m.label), h('span', { class: 'ql-help' }, m.when ? new Date(m.when).toLocaleString() : ''),
            h('button', { class: 'ql-iconbtn ql-sm', title: 'Open as a copy', 'aria-label': 'Open as a copy', onclick: () => void openSnapshot(app, k) }, icon('open_in_new')),
            h('button', { class: 'ql-iconbtn ql-sm', title: 'Delete', 'aria-label': 'Delete snapshot', onclick: async () => {
              try { await kvDel(k); await kvDel('snapmeta:' + k.slice(5)); }
              catch (e: any) { toast(`The snapshot could not be deleted: ${e?.message || e}`); return; }
              el.dataset.sig = ''; this.update!(app, el, {});
            } }, icon('delete'))));
        }
      } catch (e: any) {
        list.appendChild(h('p', { class: 'ql-help' }, `The snapshots stored on this device could not be read: ${e?.message || e}`));
      }
    })();
  },
});

/**
 * Label and time of a snapshot for the list. The pane keeps no snapshot bytes: a small `snapmeta:` record
 * is used when there is one; otherwise the snapshot is read once for its label and let go at once, and
 * the time comes from the key. The bytes are read again only when the snapshot is opened.
 */
async function snapshotLabel(key: string, prefix: string): Promise<{ label: string; when: number } | null> {
  const when = +key.slice(prefix.length) || 0;
  const meta = await kvGet('snapmeta:' + key.slice(5)).catch(() => undefined);
  if (meta && typeof meta.label === 'string') return { label: meta.label, when: meta.when || when };
  const v = await kvGet(key).catch(() => undefined);
  return v ? { label: String(v.label || 'Snapshot'), when: v.when || when } : null;
}

async function openSnapshot(app: App, key: string): Promise<void> {
  const v = await kvGet(key).catch(() => undefined);
  if (!v?.bytes) { toast('That snapshot is no longer stored on this device.'); return; }
  const bytes = new Uint8Array(v.bytes);
  const title = `${v.name || 'Snapshot'} (${new Date(v.when || Date.now()).toLocaleString()})`;
  // Snapshots hold no password (older ones may): try the open document's, then ask.
  let password: string = v.password || app.tab?.password || '';
  for (;;) {
    try { app.createTab(PdfDocument.load(bytes, { password: password || undefined }), { title, password }, bytes); return; }
    catch (e: any) {
      if (!(e instanceof PasswordNeeded)) { toast(`Could not open the snapshot: ${e?.message || e}`); return; }
      const pw = await promptDialog('Password', `${v.name || 'This snapshot'} is encrypted. Enter its password:`, '', { type: 'password' });
      if (pw == null) return;
      password = pw;
    }
  }
}

// ------------------------------------------------------------------------------------------
// Report pane (checks, preflight, accessibility, statistics)

registerPane({
  id: 'report', title: 'Report',
  render(app, el, opts: { title?: string; items?: CheckItem[]; html?: HTMLElement; actions?: { label: string; run: () => void }[] }) {
    clear(el);
    if (opts?.title) el.appendChild(h('h3', { class: 'ql-pane-h' }, opts.title));
    if (opts?.actions?.length) el.appendChild(h('div', { class: 'ql-pane-bar' }, opts.actions.map((a) => h('button', { class: 'ql-btn', onclick: a.run }, a.label))));
    if (opts?.html) el.appendChild(opts.html);
    for (const it of opts?.items || []) {
      el.appendChild(h('div', { class: `ql-nav-item ql-check-${it.level}` }, icon(it.level === 'error' ? 'error' : it.level === 'warning' ? 'warning' : 'info'),
        h('div', { style: 'flex:1;min-width:0' }, h('span', null, it.text), it.fix ? h('div', { class: 'ql-help' }, it.fix) : null),
        it.page != null ? h('button', { class: 'ql-iconbtn ql-sm', title: `Page ${it.page + 1}`, onclick: () => app.tab.ui.goToPage(it.page!) }, icon('arrow_forward')) : null));
    }
  },
  update(app, el, opts) { void app; void el; void opts; },
});

export { pageAnnotations, isName };
export const promptName = promptDialog;
