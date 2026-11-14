/** Repair report dialog and the manual recovery guide (adapted from socrtwo/wordrecovery-SF). */
import { h, icon, pickFile } from './dom';
import { openDialog, toast } from './dialog';
import type { RepairReport, MethodStatus } from '../pdf/repair';
import type { PdfDocument } from '../pdf/document';
import { saveAs, openExternal, platformName } from '../platform/native';
import { sanitizeHtml } from '../util/sanitize';

const STATUS: Record<MethodStatus, [string, string]> = {
  success: ['check_circle', 'Succeeded'],
  partial: ['adjust', 'Partial'],
  failed: ['cancel', 'Failed'],
  skipped: ['remove_circle_outline', 'Skipped'],
};

export interface ReportActions {
  /** Open the recovered document in a new tab. */
  openDoc?: (doc: PdfDocument, bytes: Uint8Array, name: string, report: RepairReport) => void;
  /** The recovered document is already open: switch to it. */
  open?: () => void;
}

export function recoverySummary(r: RepairReport): string { return r.summary; }

export async function showRecoveryReport(r: RepairReport, actions: ReportActions = {}): Promise<void> {
  const base = r.fileName.replace(/\.[^.]+$/, '');
  const body = h('div', { class: 'ql-recovery' },
    h('p', { class: 'ql-recovery-summary' }, h('b', null, r.summary)),
    h('p', { class: 'ql-help' }, `Identified as: ${r.identification.description} (${r.identification.confidence} confidence).${r.pagesBefore != null ? ` ${r.pagesBefore} page(s) before repair, ${r.pagesAfter} after.` : ''}`),
    r.textOnly ? h('p', { class: 'ql-help', style: 'color:#b26a00' }, 'Only text was recovered: layout, fonts and pictures are lost.') : null,
    h('h3', null, 'Repair methods'),
    h('table', { class: 'ql-recovery-methods' },
      h('tbody', null, r.methods.map((m) => {
        const [ic, label] = STATUS[m.status];
        return h('tr', { class: `ql-st-${m.status}` }, h('td', { title: label }, icon(ic)), h('td', null, h('b', null, m.name), h('div', { class: 'ql-help' }, m.detail || label), m.pages != null ? h('div', { class: 'ql-help ql-dim' }, `${m.pages} page(s), ${m.words ?? 0} word(s) readable`) : null));
      }))),
    r.rebuilt.length || r.lost.length ? h('div', null, h('h3', null, 'Repair diff'),
      r.rebuilt.length ? h('p', { class: 'ql-help' }, icon('build'), ` Rebuilt: ${r.rebuilt.join(', ')}`) : null,
      r.lost.length ? h('p', { class: 'ql-help', style: 'color:#c62828' }, icon('warning'), ` Lost: ${r.lost.join('; ')}`) : null) : null,
    !r.doc && r.tools.length ? h('div', null, h('h3', null, 'Other tools'), h('p', { class: 'ql-help' }, 'These free S2 recovery tools may help with this file:'), h('ul', { class: 'ql-recovery-notes' }, r.tools.slice(0, 4).map((p) => h('li', null, h('button', { class: 'ql-link', onclick: () => openExternal(p.url) }, p.name))))) : null,
  );
  const buttons: { label: string; onClick: (v: Record<string, any>, ctl: any) => void; primary?: boolean }[] = [];
  if (r.doc && r.bytes && (actions.openDoc || actions.open)) buttons.push({ label: 'Open recovered document', primary: true, onClick: (_v, ctl) => { ctl.close(null); if (actions.openDoc) actions.openDoc(r.doc!, r.bytes!, `${base} (Recovered)`, r); else actions.open!(); } });
  if (r.doc && r.bytes) buttons.push({ label: 'Save repaired PDF…', onClick: () => { try { saveAs(new Blob([r.doc!.save({ incremental: false }) as BlobPart], { type: 'application/pdf' }), `${base} (recovered).pdf`); } catch (e: any) { toast(`Could not save: ${e?.message || e}`); } } });
  buttons.push({ label: 'Copy report', onClick: async () => { try { const { reportText } = await import('../pdf/repair'); await navigator.clipboard.writeText(reportText(r)); toast('Repair report copied'); } catch { toast('Clipboard is not available'); } } });
  buttons.push({ label: 'Manual recovery options', onClick: () => { void showManualRecovery(actions); } });
  await openDialog({ title: `Repair Report: ${r.fileName}`, content: body, wide: true, ok: 'Close', cancel: false, buttons });
}

const link = (url: string, text: string) => `<a href="${url}">${text}</a>`;

/** Per-platform manual recovery guide for PDFs. */
const MANUAL: Record<string, [string, string]> = {
  windows: ['Windows', `
    <h3>1. Previous Versions and cloud history</h3>
    <p>Right-click the file or its folder &gt; Properties &gt; <b>Previous Versions</b> (needs File History or System Protection). OneDrive, SharePoint, Google Drive and Dropbox keep version histories: right-click the file &gt; <b>Version history</b>.</p>
    <h3>2. The program that made the PDF</h3>
    <p>A PDF exported from a document can usually be exported again from the original document. Printing to PDF (Microsoft Print to PDF) from any program that still opens the damaged file produces a clean new PDF.</p>
    <h3>3. Browser and reader repairs</h3>
    <p>Chrome and Edge open many damaged PDFs; <b>Print &gt; Save as PDF</b> then writes a clean copy. Downloaded files that stopped early (size smaller than expected) should be downloaded again.</p>
    <h3>4. Command-line tools</h3>
    <pre><code>qpdf --qdf --object-streams=disable damaged.pdf fixed.pdf
gs -o fixed.pdf -sDEVICE=pdfwrite damaged.pdf
mutool clean damaged.pdf fixed.pdf</code></pre>
    <p>${link('https://qpdf.sourceforge.io/', 'qpdf')} · ${link('https://ghostscript.com/', 'Ghostscript')} · ${link('https://mupdf.com/', 'MuPDF')}</p>
    <h3>5. Deleted-file recovery</h3>
    <p>${link('https://www.ccleaner.com/recuva', 'Recuva')} · ${link('https://www.cgsecurity.org/wiki/PhotoRec', 'PhotoRec')}</p>`],
  macos: ['macOS', `
    <h3>1. Time Machine and iCloud</h3><p>Open the containing folder and enter Time Machine; iCloud Drive keeps versions of documents saved from apps that support it.</p>
    <h3>2. Preview and Quartz</h3><p>Preview opens many damaged PDFs; <b>File &gt; Export as PDF</b> writes a clean copy. <b>Print &gt; PDF &gt; Save as PDF</b> from any app that still opens the file does the same.</p>
    <h3>3. Command-line tools</h3><pre><code>brew install qpdf ghostscript mupdf-tools
qpdf --qdf damaged.pdf fixed.pdf
gs -o fixed.pdf -sDEVICE=pdfwrite damaged.pdf</code></pre>`],
  linux: ['Linux', `
    <h3>1. qpdf, Ghostscript, MuPDF, pdftk</h3><pre><code>qpdf --qdf --object-streams=disable damaged.pdf fixed.pdf   # rebuilds the cross-reference table
gs -o fixed.pdf -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress damaged.pdf
mutool clean -gggg damaged.pdf fixed.pdf
pdftk damaged.pdf output fixed.pdf</code></pre>
    <h3>2. Extract what survives</h3><pre><code>pdftotext -layout damaged.pdf text.txt
pdfimages -all damaged.pdf img
strings -n 6 damaged.pdf | less</code></pre>
    <h3>3. Deleted-file recovery</h3><p>${link('https://www.cgsecurity.org/wiki/PhotoRec', 'PhotoRec')} · ${link('https://github.com/sleuthkit/sleuthkit', 'The Sleuth Kit')}</p>`],
  android: ['Android', `
    <h3>1. Version history in the app that holds the file</h3><p>Google Drive, OneDrive and Dropbox keep versions of each file; look for <b>Version history</b> or <b>Manage versions</b>.</p>
    <h3>2. Trash and recently deleted</h3><p>Drive &gt; <b>Trash</b>, OneDrive &gt; <b>Recycle bin</b>, Files &gt; <b>Trash</b> keep deleted files for about 30 days.</p>
    <h3>3. Anne's Folio's own copies</h3><p>Open &gt; Recent keeps a cached copy of each file you opened here, and unsaved drafts are kept automatically.</p>
    <h3>4. Download again</h3><p>A PDF that stopped downloading is truncated: delete it and download it again.</p>`],
  ios: ['iOS / iPadOS', `
    <h3>1. Files &gt; Recently Deleted</h3><p>Files keeps deleted items for about 30 days; iCloud Drive keeps versions of some documents.</p>
    <h3>2. The app that created the PDF</h3><p>Export the PDF again from the original document (Pages, Numbers, Keynote, Mail attachments).</p>
    <h3>3. Anne's Folio's own copies</h3><p>Open &gt; Recent keeps a cached copy of each file opened here; drafts are kept automatically.</p>`],
  tools: ['More S2 recovery tools', `
    <p>Free tools by the author of Anne's Folio's repair engine, each specialized for one kind of damage:</p>
    <ul>
      <li>${link('https://socrtwo.github.io/Universal-File-Repair-Tool/', 'Universal File Repair Tool')} · ${link('https://socrtwo.github.io/Immortal-Zip/', 'Immortal Zip')} · ${link('https://socrtwo.github.io/xmltrncatorfixr-SF/app/', 'XML Truncator-Fixer')}</li>
      <li>${link('https://socrtwo.github.io/wordrecovery-SF/', 'Word Recovery')} · ${link('https://socrtwo.github.io/savvyoffice-SF/', 'Savvy Repair for Microsoft Office')} · ${link('https://socrtwo.github.io/file-fixer-bot/', 'File Fixer Bot')}</li>
    </ul>`],
};

/** Pick a file, run every repair method on it (Open and Repair), and show the report. */
export async function recoverPickedFile(actions: ReportActions = {}): Promise<RepairReport | null> {
  const [file] = await pickFile('*/*');
  if (!file) return null;
  const { repairPdf } = await import('../pdf/repair');
  toast(`Repairing ${file.name}…`, { ms: 2500 });
  const report = repairPdf(new Uint8Array(await file.arrayBuffer()), file.name);
  await showRecoveryReport(report, actions);
  return report;
}

export async function showManualRecovery(actions: ReportActions = {}): Promise<void> {
  const plat = platformName();
  const guess = plat === 'android' ? 'android' : plat === 'ios' ? 'ios' : /Mac/.test(navigator.platform) ? 'macos' : /Linux/.test(navigator.platform) ? 'linux' : 'windows';
  const content = h('div', { class: 'ql-manual' });
  const pane = h('div', { class: 'ql-manual-body' });
  const tabs = h('div', { class: 'ql-seg' }, Object.entries(MANUAL).map(([k, [label]]) => h('button', { class: 'ql-seg-btn', 'data-k': k, onclick: () => show(k) }, label)));
  const show = (k: string) => { pane.replaceChildren(sanitizeHtml(MANUAL[k][1])); tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('ql-on', b.getAttribute('data-k') === k)); };
  pane.addEventListener('click', (e) => { const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null; if (a) { e.preventDefault(); openExternal(a.href); } });
  const intro = h('p', { class: 'ql-help' }, 'Anne\'s Folio can try every repair method on a damaged PDF, or on any file that may hold PDF data: pick it with "Repair a file…". The steps below find other copies of the file.');
  content.append(intro, tabs, pane);
  show(guess);
  await openDialog({ title: 'Manual Recovery Options', content, wide: true, ok: 'Close', cancel: false, buttons: [{ label: 'Repair a file…', primary: true, onClick: (_v, ctl) => { ctl.close(null); void recoverPickedFile(actions).catch((e) => toast(`Repair failed: ${e?.message || e}`)); } }] });
}
