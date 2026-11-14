/** Help tab. */
import { def } from './registry';
import { openDialog, toast } from '../ui/dialog';
import { h } from '../ui/dom';
import { commandCount } from './registry';

declare const __APP_VERSION__: string;
const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const REPO = 'https://github.com/socrtwo/annes-folio';

async function open(url: string): Promise<void> {
  const { openExternal } = await import('../platform/native');
  openExternal(url);
}

def([
  {
    id: 'help.help', label: 'Help', icon: 'help', tab: 'Help', group: 'Help', keys: ['F1'], edits: false, noRecord: true,
    run: async () => {
      await openDialog({ title: 'Anne\'s Folio Help', wide: true, ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: [
        '<p><b>Every feature is a command.</b> Search for any of them with Alt+Q (the magnifier in the title bar), put them on the Quick Access Bar, your own tabs or keyboard shortcuts, or record them in macros.</p>',
        '<p><b>Reading:</b> scroll, pinch or Ctrl+wheel to zoom, F4 for thumbnails, Ctrl+F to search. Select text and use the Selected Text tab (or right-click) to highlight, redact, look up or read it aloud.</p>',
        '<p><b>Commenting:</b> the Comment tab has notes, text boxes, drawings, stamps, attachments and measurements. Double-click an annotation for its properties; drag it to move; the Comments pane lists them all.</p>',
        '<p><b>Pages and forms:</b> Organize Pages shows thumbnails you can drag, rotate, delete, split and merge. Forms fills existing fields and adds new ones; Fill & Sign places your signature.</p>',
        '<p><b>Files:</b> Open any PDF, even a damaged one (File ▸ Open and Repair rebuilds it and shows a report). Images, text and Markdown files become PDFs. Save appends your changes so the original bytes stay intact; Save As ▸ Rewrite makes a clean, smaller file.</p>',
        `<p>Documentation: <a href="${REPO}#readme" target="_blank" rel="noopener">${REPO}</a></p>`,
      ].join('') }] });
    },
  },
  { id: 'help.shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', tab: 'Help', group: 'Help', edits: false, noRecord: true, run: (app) => app.ui.showShortcuts() },
  { id: 'help.commandReference', label: 'Command Reference', icon: 'menu_book', tab: 'Help', group: 'Help', edits: false, noRecord: true, tip: 'Every command, by tab', run: (app) => app.ui.showCommandReference() },
  { id: 'help.tour', label: 'Tour', icon: 'tour', tab: 'Help', group: 'Help', edits: false, noRecord: true, run: (app) => app.ui.tour() },
  { id: 'help.whatsNew', label: "What's New", icon: 'new_releases', tab: 'Help', group: 'Help', edits: false, noRecord: true, run: () => open(`${REPO}/releases`) },
  { id: 'help.feedback', label: 'Report a Problem / Feedback', icon: 'feedback', tab: 'Help', group: 'Help', edits: false, noRecord: true, run: () => open(`${REPO}/issues/new/choose`) },
  { id: 'help.updates', label: 'Check for Updates', icon: 'system_update', tab: 'Help', group: 'Help', edits: false, noRecord: true, tip: 'Open the releases page to compare with this version', run: () => open(`${REPO}/releases/latest`) },
  {
    id: 'help.notices', label: 'Third-Party Notices', icon: 'gavel', tab: 'Help', group: 'Help', edits: false, noRecord: true,
    run: async () => {
      let text = '';
      try { const r = await fetch('./third-party-notices.txt'); if (r.ok) text = await r.text(); } catch { /* offline or not built */ }
      if (!text) { toast('The notices file is part of release builds; see the repository for the license list.'); return; }
      const pre = h('pre', { style: 'white-space:pre-wrap;max-height:60vh;overflow:auto;font-size:12px' }, text);
      await openDialog({ title: 'Third-Party Notices', wide: true, ok: 'Close', cancel: false, content: pre });
    },
  },
  {
    id: 'help.about', label: 'About Anne\'s Folio', icon: 'info', tab: 'Help', group: 'Help', edits: false, noRecord: true,
    run: async () => {
      await openDialog({ title: 'About Anne\'s Folio', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: `<p><b>Anne's Folio ${VERSION}</b> — an original, open-source PDF app for viewing, editing, forms, signing, OCR and repair. Part of the Anne's Office suite (Anne's Pen, Anne's Grid, Anne's Post, Anne's Stage, Anne's Loom, Anne's Press).</p><p>${commandCount()} commands, every one placeable on the Quick Access Bar, a tab, a shortcut or a macro.</p><p>Rendering by pdf.js (Apache 2.0); text recognition by tesseract.js (Apache 2.0). Anne's Folio's own PDF engine reads, repairs, edits and writes the files.</p><p>MIT License. Copyright © 2026 Paul D Pruitt. Not affiliated with Adobe, Foxit, Microsoft, Apple or Google; product names are used only to describe compatibility.</p><p><a href="${REPO}" target="_blank" rel="noopener">${REPO}</a></p>` }] });
    },
  },
]);
