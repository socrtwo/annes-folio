/** File backstage: Home, New, Open, Info, Save As, Export, Print, Share, Options. */
import type { App } from '../app';
import { h, icon, clear } from './dom';
import { kvKeys, kvGet, kvDel } from '../util/store';
import { readMetadata, readAttachments, readFields, readOutlines } from '../pdf/structure';
import { TEMPLATES } from '../templates';

const PAGES: [string, string, string][] = [
  ['home', 'Home', 'home'], ['new', 'New', 'note_add'], ['open', 'Open', 'folder_open'], ['info', 'Info', 'info'],
  ['save', 'Save', 'save'], ['saveas', 'Save As', 'save_as'], ['export', 'Export', 'ios_share'], ['print', 'Print', 'print'],
  ['share', 'Share', 'share'], ['close', 'Close', 'close'], ['options', 'Options', 'settings'],
];

export function renderBackstage(app: App, root: HTMLElement, page: string): void {
  clear(root);
  const nav = h('nav', { class: 'ql-bs-nav' }, h('button', { class: 'ql-bs-back', onclick: () => app.ui.hideBackstage(), 'aria-label': 'Back to document' }, icon('arrow_back'), ' Back'));
  for (const [id, label, ic] of PAGES) {
    nav.appendChild(h('button', { class: 'ql-bs-item' + (id === page ? ' ql-on' : ''), 'aria-label': label, 'aria-current': id === page ? 'page' : null, onclick: () => {
      if (id === 'save') { app.ui.hideBackstage(); app.exec('file.save'); return; }
      if (id === 'close') { app.exec('file.close'); return; }
      if (id === 'options') { app.exec('file.options'); return; }
      renderBackstage(app, root, id);
      root.querySelector<HTMLElement>('.ql-bs-item.ql-on')?.focus(); // the page was rebuilt: keep the keyboard where it was
    } }, icon(ic), ' ', label));
  }
  const body = h('div', { class: 'ql-bs-body' });
  root.append(nav, body);
  const card = (title: string, sub: string, ic: string, onclick: () => void) => h('button', { class: 'ql-bs-card', onclick }, icon(ic, 'ql-bs-card-icon'), h('div', null, h('b', null, title), h('div', { class: 'ql-help' }, sub)));
  switch (page) {
    case 'home':
    case 'new': {
      const hr = new Date().getHours();
      body.appendChild(h('h1', null, page === 'home' ? 'Good ' + (hr < 12 ? 'morning' : hr < 18 ? 'afternoon' : 'evening') : 'New'));
      const grid = h('div', { class: 'ql-bs-cards' });
      grid.append(
        card('Blank document', 'A single empty Letter page', 'note_add', () => { app.ui.hideBackstage(); app.exec('file.new', 'blank'); }),
        card('From images…', 'Photos, scans and screenshots, one per page', 'photo_library', () => { app.ui.hideBackstage(); app.exec('scan.fromImages'); }),
        card('From text or Markdown…', 'A .txt, .md or .html file typeset into pages', 'article', () => { app.ui.hideBackstage(); app.exec('file.newFromText'); }),
        card('From the clipboard', 'The image or text you copied', 'content_paste', () => { app.ui.hideBackstage(); app.exec('file.newFromClipboard'); }),
        card('Combine files…', 'Several PDFs and images into one document', 'merge', () => { app.ui.hideBackstage(); app.exec('organize.combineFiles'); }),
        card('Open…', 'Any PDF, even a damaged one', 'folder_open', () => { app.ui.hideBackstage(); app.exec('file.open'); }));
      body.appendChild(grid);
      if (page === 'new') {
        body.appendChild(h('h2', null, 'Templates'));
        const tg = h('div', { class: 'ql-bs-templates' });
        for (const t of TEMPLATES) tg.appendChild(h('button', { class: 'ql-template', onclick: () => { app.ui.hideBackstage(); app.exec('file.new', t.id); } }, icon(t.icon || 'description', 'ql-template-icon'), h('b', null, t.name), h('div', { class: 'ql-help' }, t.description)));
        body.appendChild(tg);
      }
      if (page === 'home') { body.appendChild(h('h2', null, 'Recent')); recentList(app, body); }
      break;
    }
    case 'open': {
      body.append(h('h1', null, 'Open'),
        card('Browse…', 'Open a file from this device, Drive, or any document provider', 'folder_open', () => app.exec('file.open')),
        card('Open and Repair…', 'Rebuild a damaged PDF and show what was recovered', 'healing', () => app.exec('file.openRepair')),
        card('Recover Data from Any File…', 'Pull PDF pages and readable text out of any file, however damaged', 'text_snippet', () => app.exec('file.recoverAny')),
        card('Recover unsaved documents', 'Drafts saved automatically before a crash or close', 'restore_page', () => app.exec('file.recoverUnsaved')),
        h('h2', null, 'Recent'));
      recentList(app, body, true);
      break;
    }
    case 'info': {
      const tab = app.tab;
      const m = readMetadata(tab.doc);
      const sec = tab.doc.securityInfo;
      body.append(h('h1', null, 'Info'), h('h2', null, tab.displayName),
        h('div', { class: 'ql-bs-cards' },
          card('Protect Document', sec ? `Encrypted (${sec.method.toUpperCase()}, ${sec.keyLength}-bit)` : 'Encrypt with a password and set permissions', 'shield_lock', () => app.exec('protect.encrypt')),
          card('Mark as Final', tab.readOnly ? 'The document is read-only here' : 'Make the document read-only in this app', 'verified', () => app.exec('protect.markFinal')),
          card('Hidden Information', 'Find metadata, comments, attachments, scripts and earlier versions', 'policy', () => { app.ui.hideBackstage(); app.exec('protect.hiddenInfo'); }),
          card('Check Accessibility', 'Title, language, tags, alt text and form tooltips', 'accessibility_new', () => { app.ui.hideBackstage(); app.exec('review.checkAccessibility'); }),
          card('Archival Check', 'What stands between this file and PDF/A', 'inventory', () => { app.ui.hideBackstage(); app.exec('review.archivalCheck'); }),
          card('Optimize', 'Drop unused objects, recompress streams', 'compress', () => app.exec('tools.optimize')),
          card('Version History', 'Browse and restore snapshots', 'history', () => app.exec('file.versions')),
          card('Revert to Saved', 'Discard changes since the last save', 'settings_backup_restore', () => app.exec('file.revert'))),
        h('h3', null, 'Properties'),
        h('table', { class: 'ql-stats' },
          ...[['Title', m.title || '—'], ['Author', m.author || '—'], ['Subject', m.subject || '—'], ['Keywords', m.keywords || '—'], ['Pages', String(tab.doc.pageCount)], ['Page size', (() => { const p = tab.doc.pages[0]; return p ? `${(p.width / 72).toFixed(2)} × ${(p.height / 72).toFixed(2)} in` : '—'; })()], ['PDF version', m.version || '—'], ['Producer', m.producer || '—'], ['Creator', m.creator || '—'], ['Tagged', m.tagged ? 'Yes' : 'No'], ['Form fields', String(readFields(tab.doc).length)], ['Attachments', String(readAttachments(tab.doc).length)], ['Bookmarks', String(readOutlines(tab.doc).length)], ['File size', `${(tab.bytes.length / 1024).toFixed(0)} KB`], ['Location', tab.uri ? 'Device storage' : 'Not saved yet'], ['Created', m.created ? m.created.toLocaleString() : '—'], ['Modified', m.modified ? m.modified.toLocaleString() : '—'], ['Last saved here', tab.saved ? new Date(tab.saved).toLocaleString() : '—']].map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v)))),
        h('button', { class: 'ql-btn', onclick: () => app.exec('file.properties') }, 'All Properties…'));
      break;
    }
    case 'saveas':
    case 'export': {
      body.append(h('h1', null, page === 'saveas' ? 'Save As' : 'Export'), h('p', { class: 'ql-help' }, page === 'saveas' ? 'Choose how to write the file. The system file dialog lets you pick the folder (device, SD card, Drive, Dropbox…).' : 'Export a copy in another form; the document keeps its file.'));
      const grid = h('div', { class: 'ql-bs-cards' });
      if (page === 'saveas') {
        grid.append(
          card('PDF (incremental)', 'Appends your changes; the original bytes stay intact, signatures survive', 'picture_as_pdf', () => app.exec('file.saveAsFormat', 'pdf')),
          card('PDF (rewrite)', 'A clean, renumbered file without earlier versions or unused objects', 'cleaning_services', () => app.exec('file.saveAsFormat', 'pdf-rewrite')),
          card('PDF (optimized)', 'Rewrite with recompressed streams and object streams: smallest file', 'compress', () => app.exec('file.saveAsFormat', 'pdf-optimized')),
          card('Encrypted PDF', 'AES-256 with a password and permissions', 'enhanced_encryption', () => app.exec('protect.encrypt')),
          card('Flattened PDF', 'Comments and form fields become part of the page', 'layers_clear', () => app.exec('file.saveAsFormat', 'pdf-flat')),
          card('Review package (.qfr)', 'The PDF with its comments, audit log and report in one ZIP', 'inventory_2', () => app.exec('file.saveAsFormat', 'qfr')));
      } else {
        grid.append(
          card('Images', 'PNG or JPEG of each page', 'image', () => app.exec('file.export.images')),
          card('Text', 'Plain text of every page', 'notes', () => app.exec('file.export.text')),
          card('Markdown', 'Headings guessed from font sizes', 'markdown', () => app.exec('file.export.markdown')),
          card('HTML', 'One web page with the text of every page', 'html', () => app.exec('file.export.html')),
          card('Tables (CSV)', 'Tables detected from the text positions', 'table', () => app.exec('tools.extractTables')),
          card('Form data', 'XFDF, FDF, CSV or JSON', 'dataset', () => app.exec('forms.exportData')),
          card('Comments (XFDF)', 'Annotations for another reader', 'forum', () => app.exec('comment.exportXfdf')),
          card('Pictures in the document', 'Every embedded image as a file', 'photo_library', () => app.exec('tools.extractImages')),
          card('Attachments', 'Every embedded file', 'attach_file', () => app.exec('tools.extractAttachments')),
          card('Selected pages', 'A new PDF of the pages you choose', 'output', () => app.exec('organize.extract')));
      }
      body.appendChild(grid);
      break;
    }
    case 'print': {
      body.append(h('h1', null, 'Print'),
        card('Print…', 'Pages, range, scale and booklet options, through the system print service', 'print', () => app.exec('file.print')),
        card('Quick Print', 'All pages with the current settings', 'print', () => app.exec('file.quickPrint')),
        card('Booklet', 'Make a saddle-stitched booklet PDF to print duplex', 'menu_book', () => app.exec('organize.booklet')),
        card('N-up', 'Several pages per sheet', 'grid_on', () => app.exec('organize.nUp')));
      break;
    }
    case 'share': {
      body.append(h('h1', null, 'Share'),
        card('Share a copy…', 'Send the PDF through the share sheet', 'share', () => app.exec('file.share')),
        card('Email', 'Attach to an email', 'mail', () => app.exec('file.email')),
        card('Share flattened copy', 'Comments and fields baked in, nothing editable', 'layers_clear', () => app.exec('file.shareFlat')),
        card('Request signatures', 'Add signature fields and draft an email asking for them', 'draw', () => app.exec('sign.requestSignatures')));
      break;
    }
  }
}

function recentList(app: App, body: HTMLElement, full = false) {
  const list = h('div', { class: 'ql-recent' });
  const rec = app.prefs.recent;
  if (!rec.length) list.appendChild(h('p', { class: 'ql-help' }, 'Documents you open or save appear here.'));
  for (const r of rec.slice(0, full ? 40 : 8)) {
    list.appendChild(h('div', { class: 'ql-recent-row' },
      h('button', { class: 'ql-recent-open', onclick: () => app.exec('file.openRecent', r.key) }, icon('picture_as_pdf'), h('div', null, h('b', null, r.name), h('div', { class: 'ql-help' }, new Date(r.when).toLocaleString()))),
      h('button', { class: 'ql-iconbtn', title: r.pinned ? 'Unpin' : 'Pin', onclick: () => { r.pinned = !r.pinned; app.savePrefs(); renderBackstage(app, body.parentElement!, full ? 'open' : 'home'); } }, icon(r.pinned ? 'keep_off' : 'keep')),
      h('button', { class: 'ql-iconbtn', title: 'Remove from list', onclick: () => { app.prefs.recent = app.prefs.recent.filter((x) => x !== r); app.savePrefs(); renderBackstage(app, body.parentElement!, full ? 'open' : 'home'); } }, icon('close'))));
  }
  if (full && rec.length) list.appendChild(h('button', { class: 'ql-btn', onclick: () => app.exec('file.clearRecent') }, 'Clear unpinned'));
  body.appendChild(list);
  void kvKeys; void kvGet; void kvDel;
}
