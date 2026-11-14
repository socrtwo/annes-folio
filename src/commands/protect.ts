/** Protect tab: encryption and permissions, redaction, hidden information and sanitizing, mark as final. */
import { def } from './registry';
import type { App, DocTab } from '../app';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { permissionsOf, type Permissions } from '../pdf/crypt';
import { PdfString } from '../pdf/objects';
import type { PdfDocument } from '../pdf/document';
import { addRedactMark, applyRedactions } from '../pdf/ops/annots';
import { hiddenInformation, sanitize, type SanitizeOptions } from '../pdf/ops/optimize';
import { pageAnnotations, addAttachment, readAttachments, removeAttachment } from '../pdf/structure';
import { textWidth } from '../pdf/stdfonts';
import { writeClipboardText } from '../platform/native';
import { replaceWithBytes, confirmRewrite } from './file';
import { askPages, pageOf, pagesFromRange, selectedText, esc, viewerOf, editTab, stillCurrent, tabOf, type Ctx, type Rect } from './util';

const PERMS: { key: keyof Permissions; label: string }[] = [
  { key: 'print', label: 'Printing' }, { key: 'printHigh', label: 'High-quality printing' }, { key: 'copy', label: 'Copying text and images' }, { key: 'accessibility', label: 'Text access for screen readers' },
  { key: 'modify', label: 'Changing the document' }, { key: 'annotate', label: 'Commenting' }, { key: 'fillForms', label: 'Filling form fields' }, { key: 'assemble', label: 'Inserting, deleting and rotating pages' },
];

/** The audit log kept with the tab (saved into review packages and the redaction log attachment). */
export function audit(c: Ctx, text: string): void {
  const t = tabOf(c) as any;
  (t.audit ||= []).push({ when: Date.now(), text, user: t.app?.prefs?.author });
}

/** One undoable step that takes content out of the document. The tab is marked so that every later save, share or draft is a full rewrite: an incremental update would keep the removed bytes in the file. */
function removal<T>(app: App, tab: DocTab, label: string, fn: (doc: PdfDocument) => T): T | undefined {
  return editTab(app, tab, label, (doc) => { tab.mustRewrite = true; return fn(doc); });
}

// ------------------------------------------------------------------------------------------
// Passwords

/** A permissions password from the system's cryptographic random generator: 20 letters and digits (100 bits) in groups of five. */
export function newOwnerPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(20));
  let s = '';
  for (let i = 0; i < b.length; i++) s += (i && i % 5 === 0 ? '-' : '') + alphabet[b[i] & 31];
  return s;
}

/** Shows a generated permissions password once; it is not kept anywhere. */
export async function showGeneratedPassword(pw: string): Promise<void> {
  await openDialog({
    title: 'Permissions Password', ok: 'I Have Saved It', cancel: false,
    help: 'No permissions password was entered, so this one was generated. It is needed to change or remove the protection later. Anne\'s Folio does not keep it: copy it now.',
    fields: [{ key: 'pw', label: 'Permissions password', type: 'text', value: pw }],
    buttons: [{ label: 'Copy', onClick: () => { void writeClipboardText(pw, true).then((ok) => toast(ok ? 'Copied' : 'Could not copy; select the text and copy it yourself.')); } }],
  });
}

/** Permissions passwords entered (or set) in this session, by security handler; never stored. */
const ownerPasswords = new WeakMap<object, string>();

/** The permissions password of an encrypted tab when this session knows it: entered here, or the one the file was opened with. */
function knownOwnerPassword(tab: DocTab): string | null {
  const sec = tab.doc.security;
  if (!sec) return null;
  return ownerPasswords.get(sec) ?? (sec.ownerAccess && tab.password ? tab.password : null);
}

/**
 * The password that opens an encrypted tab, or null when it is not known: a file opened with its
 * permissions password does not reveal its open password (only whether it has one).
 */
function knownOpenPassword(tab: DocTab): string | null {
  const sec = tab.doc.security;
  if (!sec) return '';
  if (!sec.ownerAccess || ownerPasswords.has(sec)) return tab.password || '';
  // Opened as owner: the open password is '' when the empty password opens the file too.
  let empty = false;
  try { empty = sec.authenticate('', (o) => tab.doc.resolve(o)); } catch { /* damaged dictionary: unknown */ } finally { sec.ownerAccess = true; }
  return empty ? '' : null;
}

/** True when the protection may be changed: the document is not encrypted, or its permissions password is known or entered now. */
async function ensureOwner(tab: DocTab): Promise<boolean> {
  const sec = tab.doc.security;
  if (!sec || sec.ownerAccess) return true;
  const pw = await promptDialog('Permissions Password', 'Enter the permissions (owner) password to change or remove this document\'s protection:', '', { type: 'password' });
  if (pw == null) return false;
  let ok = false;
  try { ok = sec.authenticate(pw, (o) => tab.doc.resolve(o)); } catch (e: any) { toast(e?.message || String(e)); return false; }
  if (ok && sec.ownerAccess) { ownerPasswords.set(sec, pw); return true; }
  toast(ok ? 'That is the password to open the document. Changing the protection needs its permissions password.' : 'That is not the permissions password.', { ms: 6000 });
  return false;
}

/** Rewrites the tab encrypted with the given passwords and remembers the permissions password for this session. */
function encryptTab(app: App, tab: DocTab, userPassword: string, ownerPassword: string, permissions: Partial<Permissions>, encryptMetadata: boolean): boolean {
  const bytes = tab.doc.save({ incremental: false, encrypt: { userPassword, ownerPassword, permissions, encryptMetadata } });
  if (!replaceWithBytes(app, tab, bytes, userPassword)) return false;
  // The reloaded document was opened with the open password; whoever just set the permissions password keeps owner access.
  const sec = tab.doc.security;
  try { if (sec && sec.authenticate(ownerPassword, (o) => tab.doc.resolve(o)) && sec.ownerAccess) ownerPasswords.set(sec, ownerPassword); } catch { /* stays user access */ }
  return true;
}

async function encryptDialog(app: App, permissionsOnly = false): Promise<void> {
  const tab = app.tab;
  if (tab.readOnly) { toast('This document is read-only.'); return; }
  // Changing existing protection needs the permissions password, exactly as removing it does.
  if (!(await ensureOwner(tab))) return;
  const cur = tab.doc.securityInfo;
  const perms = cur?.permissions || permissionsOf(-1);
  const curOwner = knownOwnerPassword(tab);
  const curOpen = knownOpenPassword(tab);
  // The open password is asked for when it is being set (Encrypt) or cannot be carried over (Permissions on a file opened with its permissions password).
  const askOpen = !permissionsOnly || curOpen === null;
  const r = await openDialog({ title: permissionsOnly ? 'Permissions' : 'Encrypt with Password', wide: true, fields: [
    ...(askOpen ? [
      { key: 'h1', type: 'heading' as const, label: 'Passwords (AES-256)' },
      { key: 'user', label: permissionsOnly ? 'Password to open: not known here, because the file was opened with its permissions password. Enter it to keep it; empty removes it' : 'Password to open (leave empty to open without one)', type: 'password' as const, half: true },
      { key: 'user2', label: 'Confirm', type: 'password' as const, half: true },
    ] : []),
    { key: 'owner', label: curOwner ? 'Permissions password (empty keeps the current one)' : 'Permissions password (empty: one is generated and shown to you)', type: 'password', half: true },
    { key: 'owner2', label: 'Confirm', type: 'password', half: true },
    { key: 'h2', type: 'heading', label: 'What readers without the permissions password may do' },
    ...PERMS.map((p) => ({ key: p.key, label: p.label, type: 'checkbox' as const, value: (perms as any)[p.key] !== false, half: true })),
    { key: 'meta', label: 'Encrypt the metadata too', type: 'checkbox', value: cur ? cur.encryptMetadata : true },
    { key: 'i', type: 'info', html: `<p class="ql-help">${askOpen ? '' : 'The password to open the document stays as it is. '}Permissions are advisory: readers that honor the standard respect them, but anyone with the open password can read the bytes. The permissions password must differ from the open password. The document is rewritten in memory; Save writes the encrypted file.</p>` },
  ], validate: (v) => {
    const user = askOpen ? String(v.user || '') : curOpen || '';
    if (askOpen && v.user !== v.user2) return 'The open passwords do not match.';
    if (v.owner !== v.owner2) return 'The permissions passwords do not match.';
    if (!permissionsOnly && !v.owner && !user && !curOwner) return 'Enter at least one password.';
    if ((v.owner || curOwner) && (v.owner || curOwner) === user) return 'The permissions password must differ from the password to open.';
    return null;
  }, ok: permissionsOnly ? 'Apply' : 'Encrypt' });
  if (!r) return;
  const permissions: Partial<Permissions> = {};
  for (const p of PERMS) permissions[p.key] = !!r[p.key];
  const userPassword = askOpen ? String(r.user || '') : curOpen || '';
  const generated = !r.owner && !curOwner;
  const ownerPassword = String(r.owner || '') || curOwner || newOwnerPassword();
  if (!(await confirmRewrite(tab, 'Encrypting')) || !stillCurrent(app, tab)) return;
  if (!encryptTab(app, tab, userPassword, ownerPassword, permissions, !!r.meta)) return;
  audit(tab, permissionsOnly ? 'Permissions changed' : 'Encrypted with AES-256');
  toast(permissionsOnly ? 'Permissions changed. Save to write the protected file.' : 'Encrypted. Save to write the protected file.');
  if (generated) await showGeneratedPassword(ownerPassword);
}

async function securityInfoDialog(app: App): Promise<void> {
  const tab = app.tab;
  const s = tab.doc.securityInfo;
  const rows = s ? [
    ['Method', `${s.method.toUpperCase()} (strings: ${s.stringMethod.toUpperCase()}), ${s.keyLength}-bit, revision ${s.revision}`],
    ['Opened with', s.ownerAccess ? 'the permissions (owner) password: everything is allowed' : tab.password ? 'the open (user) password' : 'no password (empty user password)'],
    ['Metadata', s.encryptMetadata ? 'encrypted' : 'not encrypted'],
    ...PERMS.map((p) => [p.label, (s.permissions as any)[p.key] ? 'allowed' : 'not allowed']),
  ] : [['Security', 'None: the document is not encrypted.']];
  await openDialog({ title: 'Security Settings', ok: 'Close', cancel: false, content: h('table', { class: 'ql-table' }, rows.map((rw) => h('tr', null, h('th', { style: 'text-align:left;padding-right:12px' }, rw[0]), h('td', null, rw[1])))), buttons: [
    { label: s ? 'Change…' : 'Encrypt…', onClick: (_v, ctl) => { ctl.close(null); app.exec('protect.encrypt'); } },
    ...(s ? [{ label: 'Remove Security', onClick: (_v: any, ctl: any) => { ctl.close(null); app.exec('protect.removeSecurity'); } }] : []),
  ] });
}

// ------------------------------------------------------------------------------------------
// Redaction by search

/** A text item as the viewer reports it (user space; `angle` in radians when the text is not horizontal). */
export interface SearchItem { str: string; x: number; y: number; w: number; h: number; hasEOL?: boolean; angle?: number }

/** The search expression for a needle. Throws with the reason when a regular expression does not compile. */
export function searchRegex(needle: string, opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean } = {}): RegExp {
  const body = opts.regex ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp(opts.wholeWord ? `\\b(?:${body})\\b` : body, opts.caseSensitive ? 'g' : 'gi'); }
  catch (e: any) { throw new Error(`Not a valid regular expression: ${e?.message || e}`); }
}

/**
 * Rectangles of every match of `re` in a page's text items. The items are joined into one text first, so a
 * phrase split over several items or wrapped onto the next line is found; a match yields one rectangle per
 * item it touches. Positions inside an item follow Helvetica's relative glyph widths rather than an average
 * character width, and each rectangle is padded so it overlaps the run it covers.
 */
export function findTextRects(items: SearchItem[], re: RegExp): Rect[] {
  let text = '';
  const at: [number, number][] = []; // text index → [item, offset in item]; item −1 for a joining space
  let prev: SearchItem | null = null;
  items.forEach((it, k) => {
    if (!it.str) { if (it.hasEOL && prev) prev = { ...prev, hasEOL: true }; return; }
    if (prev && !/\s$/.test(text) && !/^\s/.test(it.str)) {
      const sameLine = Math.abs(prev.y - it.y) <= Math.max(prev.h, it.h) * 0.5;
      if (prev.hasEOL || !sameLine || it.x - (prev.x + prev.w) > Math.max(prev.h, it.h) * 0.15) { text += ' '; at.push([-1, 0]); }
    }
    for (let i = 0; i < it.str.length; i++) at.push([k, i]);
    text += it.str;
    prev = it;
  });
  const out: Rect[] = [];
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const rx = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    if (!m[0]) { rx.lastIndex++; continue; }
    const spans = new Map<number, [number, number]>();
    for (let i = m.index; i < m.index + m[0].length; i++) { const [k, off] = at[i]; if (k < 0) continue; const s = spans.get(k); if (s) s[1] = off + 1; else spans.set(k, [off, off + 1]); }
    for (const [k, [a, b]] of spans) {
      const it = items[k];
      if (!it.str.slice(a, b).trim()) continue; // a space between two words needs no box of its own
      const full = textWidth(it.str, 'Helvetica', 1) || 1;
      const t0 = (it.w * textWidth(it.str.slice(0, a), 'Helvetica', 1)) / full - 0.5, t1 = (it.w * textWidth(it.str.slice(0, b), 'Helvetica', 1)) / full + 0.5;
      const c = Math.cos(it.angle || 0), s = Math.sin(it.angle || 0);
      const pts = [[t0, -it.h * 0.25], [t1, -it.h * 0.25], [t0, it.h * 0.85], [t1, it.h * 0.85]].map(([t, u]) => [it.x + c * t - s * u, it.y + s * t + c * u]);
      out.push([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]);
    }
  }
  return out;
}

/** Rectangles of every occurrence of a text on a page (through the renderer's text items). Throws on an invalid regular expression. */
export async function findRects(c: Ctx, page: number, needle: string, opts: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): Promise<Rect[]> {
  const re = searchRegex(needle, opts);
  return findTextRects(await viewerOf(tabOf(c)).items(page), re);
}

export const PII_PATTERNS: { label: string; re: string }[] = [
  { label: 'Email addresses', re: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+' },
  { label: 'Phone numbers', re: '(?:\\+?\\d{1,3}[ .-]?)?\\(?\\d{3}\\)?[ .-]?\\d{3}[ .-]?\\d{4}' },
  { label: 'US Social Security numbers', re: '\\b\\d{3}-\\d{2}-\\d{4}\\b' },
  { label: 'Credit card numbers', re: '\\b(?:\\d[ -]?){13,19}\\b' },
  { label: 'Dates', re: '\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b' },
  { label: 'IP addresses', re: '\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b' },
];

def([
  { id: 'protect.encrypt', label: 'Encrypt…', icon: 'enhanced_encryption', tab: 'Protect', group: 'Security', popular: true, tip: 'AES-256 with an open password and/or a permissions password', run: (app) => encryptDialog(app) },
  { id: 'protect.permissions', label: 'Permissions…', icon: 'admin_panel_settings', tab: 'Protect', group: 'Security', tip: 'Restrict printing, copying and changes; the password to open the document stays as it is', run: (app) => encryptDialog(app, true) },
  {
    id: 'protect.removeSecurity', label: 'Remove Security', icon: 'no_encryption', tab: 'Protect', group: 'Security', isEnabled: (app) => !!app.doc?.security,
    run: async (app) => {
      const tab = app.tab;
      if (!tab.doc.security) { toast('The document is not encrypted.'); return; }
      if (tab.readOnly) { toast('This document is read-only.'); return; }
      if (!(await ensureOwner(tab)) || !(await confirmRewrite(tab, 'Removing the security')) || !stillCurrent(app, tab)) return;
      const bytes = tab.doc.save({ incremental: false, removeSecurity: true });
      if (!replaceWithBytes(app, tab, bytes, '')) return;
      audit(tab, 'Security removed');
      toast('Security removed. Save to write the unprotected file.');
    },
  },
  { id: 'protect.securityInfo', label: 'Security Settings', icon: 'shield', tab: 'Protect', group: 'Security', edits: false, noRecord: true, run: securityInfoDialog },
  {
    id: 'protect.redactArea', label: 'Mark Area', icon: 'block', tab: 'Protect', group: 'Redact', kind: 'toggle', noRecord: true,
    tip: 'Drag rectangles over content to redact; Apply Redactions removes it for good',
    isActive: (app) => app.tab?.ui?.tool === 'redact' && !app.viewer.toolOpts?.text,
    run: (app) => { app.tab.ui.setTool('redact', {}); app.focus(); },
  },
  {
    id: 'protect.redactText', label: 'Mark Text', icon: 'format_strikethrough', tab: 'Protect', group: 'Redact', kind: 'toggle', noRecord: true,
    tip: 'Mark the selected text for redaction, or drag over text with the tool',
    isActive: (app) => app.tab?.ui?.tool === 'redact' && !!app.viewer.toolOpts?.text,
    run: (app) => {
      const sr = app.viewer.selectionRects;
      if (sr && sr.rects.length) { const p = pageOf(app, sr.page); app.edit('Mark for Redaction', (doc) => addRedactMark(doc, p, sr.rects, { author: app.prefs.author })); app.viewer.clearSelection(); return; }
      app.tab.ui.setTool('redact', { text: true }); app.focus();
    },
  },
  {
    id: 'protect.redactSearch', label: 'Mark by Search…', icon: 'find_replace', tab: 'Protect', group: 'Redact', popular: true,
    tip: 'Mark every occurrence of a word, phrase, pattern or kind of personal data in the page text',
    run: async (app) => {
      const tab = app.tab;
      const r = await openDialog({ title: 'Mark by Search', wide: true, fields: [
        { key: 'q', label: 'Text or regular expression', type: 'text', value: selectedText(tab).slice(0, 60), autofocus: true },
        { key: 'regex', label: 'Regular expression', type: 'checkbox', value: false, half: true },
        { key: 'cs', label: 'Match case', type: 'checkbox', value: false, half: true },
        { key: 'ww', label: 'Whole words', type: 'checkbox', value: false, half: true },
        { key: 'pii', label: 'Also mark', type: 'list', multiple: true, rows: 6, options: PII_PATTERNS.map((p, i) => ({ value: String(i), label: p.label })), value: [] },
        { key: 'overlay', label: 'Text printed on the black boxes after redaction (optional)', type: 'text', value: '' },
        { key: 'pages', label: 'Pages (blank = all)', type: 'text', value: '' },
        { key: 'i', type: 'info', html: '<p class="ql-help">The search covers the text of the pages. Words in pictures, comments, form fields, bookmarks, metadata and attachments are not searched; hyphenated words broken across lines are not joined. Check the marks before applying them.</p>' },
      ], validate: (v) => {
        try { if (String(v.q).trim()) searchRegex(v.q, { regex: v.regex, wholeWord: v.ww }); if (String(v.pages).trim()) pagesFromRange(tab, v.pages); return null; }
        catch (e: any) { return e?.message || String(e); }
      }, ok: 'Mark' });
      if (!r) return;
      const pages = String(r.pages).trim() ? pagesFromRange(tab, r.pages) : tab.doc.pages.map((_, i) => i);
      const patterns: RegExp[] = [];
      if (String(r.q).trim()) patterns.push(searchRegex(r.q, { regex: r.regex, caseSensitive: r.cs, wholeWord: r.ww }));
      for (const i of r.pii as string[]) patterns.push(searchRegex(PII_PATTERNS[+i].re, { regex: true, caseSensitive: r.cs }));
      if (!patterns.length) { toast('Enter text or choose a kind of data.'); return; }
      // The rectangles belong to the document as it is now: `rev` catches an edit made while the pages are read.
      const rev = tab.bytes;
      const v = viewerOf(tab);
      const found = new Map<number, Rect[]>();
      try {
        for (const i of pages) {
          app.ui.status?.(`● Searching page ${i + 1}…`);
          const items = await v.items(i);
          for (const re of patterns) { const rects = findTextRects(items, re); if (rects.length) found.set(i, [...(found.get(i) || []), ...rects]); }
        }
      } finally { app.ui.status?.(''); }
      const total = [...found.values()].reduce((n, x) => n + x.length, 0);
      if (!total) { toast('Nothing matched in the page text.'); return; }
      if (!stillCurrent(app, tab, rev)) return;
      const author = app.prefs.author;
      const done = editTab(app, tab, 'Mark by Search', (doc) => { for (const [i, rects] of found) addRedactMark(doc, doc.pages[i], rects, { author, overlayText: r.overlay || undefined, contents: r.regex || !String(r.q).trim() ? 'pattern' : 'search' }); return true; });
      if (done) toast(`${total} area(s) marked on ${found.size} page(s). Check them, then use Apply Redactions to remove the content.`, { ms: 6000 });
    },
  },
  {
    id: 'protect.redactPages', label: 'Mark Pages', icon: 'crop_free', tab: 'Protect', group: 'Redact', tip: 'Mark whole pages for redaction',
    run: async (app) => { const tab = app.tab; const author = app.prefs.author; const r = await askPages(tab, 'Mark Pages for Redaction', [], 'Mark'); if (!r) return; editTab(app, tab, 'Mark Pages', (doc) => { for (const i of r.pages) { const p = doc.pages[i]; addRedactMark(doc, p, [p.mediaBox], { author }); } }); },
  },
  {
    id: 'protect.applyRedactions', label: 'Apply Redactions', icon: 'delete_forever', tab: 'Protect', group: 'Redact', popular: true,
    tip: 'Remove the marked text and images from the page content, draw black boxes; the next save rewrites the whole file so nothing removed stays in it',
    run: async (app) => {
      const tab = app.tab;
      const author = app.prefs.author;
      const marks = tab.doc.pages.flatMap((p) => pageAnnotations(tab.doc, p).filter((a) => a.subtype === 'Redact'));
      if (!marks.length) { toast('Nothing is marked for redaction.'); return; }
      const r = await openDialog({ title: 'Apply Redactions', fields: [
        { key: 'i', type: 'info', html: `<p>${marks.length} mark(s) on ${new Set(marks.map((m) => m.page)).size} page(s) will be applied. Text and images under them are taken out of the page content, not just covered.</p><p>From then on this document is saved, shared and emailed as a <b>full rewrite</b> (never as an appended update), so the removed content is not kept in the file. Undo works until you save.</p>` },
        { key: 'sanitize', label: 'Also remove metadata, all comments, embedded thumbnails and private application data', type: 'checkbox', value: true },
        { key: 'log', label: 'Attach a redaction log to the document (date, your user name, counts)', type: 'checkbox', value: false },
      ], ok: 'Apply' });
      if (!r) return;
      const pageList = [...new Set(marks.map((m) => m.page))];
      const res = removal(app, tab, 'Apply Redactions', (doc) => {
        const result = applyRedactions(doc, pageList);
        if (r.sanitize) sanitize(doc, { metadata: true, comments: true, thumbnails: true, privateData: true });
        if (r.log) {
          const old = readAttachments(doc).find((a) => a.name === 'redaction-log.txt');
          const prev = old?.stream ? new TextDecoder().decode(doc.decoded(old.stream)) + '\n' : '';
          const line = `${new Date().toISOString()}\t${author}\t${marks.length} mark(s) applied: ${result.textRemoved} text run(s), ${result.imagesRemoved} image(s), ${result.pathsRemoved} drawing(s), ${result.areas} area(s) on page(s) ${pageList.map((i) => i + 1).join(', ')}`;
          if (old) removeAttachment(doc, old);
          addAttachment(doc, 'redaction-log.txt', new TextEncoder().encode(prev + line), { description: 'Anne\'s Folio redaction log', mime: 'text/plain' });
        }
        return result;
      });
      if (!res) return;
      audit(tab, `Redactions applied: ${res.textRemoved} text run(s), ${res.imagesRemoved} image(s), ${res.pathsRemoved} drawing(s), ${res.areas} area(s)`);
      tab.ui.selectedAnnot = null;
      toast(`Redacted: ${res.textRemoved} text run(s), ${res.imagesRemoved} image(s) and ${res.pathsRemoved} drawing(s) removed in ${res.areas} area(s). Save now: the file is rewritten whole, without the removed content.`, { ms: 9000, action: 'Save', onAction: () => { if (app.docs.includes(tab)) { app.activate(tab); app.exec('file.save'); } } });
    },
  },
  {
    id: 'protect.redactLog', label: 'Redaction Log', icon: 'receipt_long', tab: 'Protect', group: 'Redact', edits: false, noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const att = readAttachments(tab.doc).find((a) => a.name === 'redaction-log.txt');
      const text = att?.stream ? new TextDecoder().decode(tab.doc.decoded(att.stream)) : '';
      const mem = ((tab as any).audit || []).map((l: any) => `${new Date(l.when).toLocaleString()}\t${l.text}`).join('\n');
      await openDialog({ title: 'Redaction and Audit Log', wide: true, ok: 'Close', cancel: false, content: h('pre', { class: 'ql-notices' }, [text ? `Redaction log attached to the document:\n${text}` : 'No redaction log is attached to the document.', mem ? `\nThis session:\n${mem}` : ''].join('\n')) });
    },
  },
  {
    id: 'protect.hiddenInfo', label: 'Hidden Information', icon: 'policy', tab: 'Protect', group: 'Hidden Information', edits: false, noRecord: true, popular: true,
    tip: 'What the file carries besides its pages: metadata, comments, attachments, scripts, hidden layers, earlier versions',
    run: (app) => {
      const rep = hiddenInformation(app.doc);
      const items = rep.items.map((it) => ({ level: 'info' as const, text: `${it.kind}: ${it.count}${it.detail ? ` — ${it.detail}` : ''}` }));
      app.ui.openPane('report', { title: 'Hidden Information', items: items.length ? items : [{ level: 'info', text: 'Nothing hidden was found.' }], actions: [{ label: 'Sanitize…', run: () => app.exec('protect.sanitize') }] });
    },
  },
  {
    id: 'protect.sanitize', label: 'Sanitize…', icon: 'cleaning_services', tab: 'Protect', group: 'Hidden Information',
    tip: 'Remove the chosen kinds of hidden information in one step; the next save rewrites the whole file',
    run: async (app) => {
      const tab = app.tab;
      const rep = hiddenInformation(tab.doc);
      const has = (k: string) => rep.items.some((i) => i.kind.toLowerCase().startsWith(k));
      const opts: { key: keyof SanitizeOptions; label: string; on: boolean }[] = [
        { key: 'metadata', label: 'Document metadata and XMP', on: true }, { key: 'attachments', label: 'Attachments', on: has('attach') }, { key: 'javascript', label: 'JavaScript and script actions', on: true },
        { key: 'comments', label: 'Comments and markup', on: false }, { key: 'forms', label: 'Form fields (flattened into the page)', on: false }, { key: 'links', label: 'Links', on: false },
        { key: 'bookmarks', label: 'Bookmarks', on: false }, { key: 'thumbnails', label: 'Embedded page thumbnails', on: true }, { key: 'privateData', label: 'Private application data', on: true },
        // Removes the layers that are switched off together with what they draw; offered only when the file has some.
        { key: 'hiddenLayers', label: 'Hidden layers and their content', on: has('hidden layers') },
      ];
      const r = await openDialog({ title: 'Sanitize Document', fields: [...opts.map((o) => ({ key: o.key, label: o.label, type: 'checkbox' as const, value: o.on, half: true })), { key: 'i', type: 'info', html: '<p class="ql-help">After this the document is saved, shared and emailed as a full rewrite, so what was removed is not kept in earlier versions inside the file.</p>' }], ok: 'Remove' });
      if (!r) return;
      const o: SanitizeOptions = {}; for (const x of opts) (o as any)[x.key] = !!r[x.key];
      const done = removal(app, tab, 'Sanitize', (doc) => sanitize(doc, o));
      if (!done) return;
      audit(tab, `Sanitized: ${done.join(', ') || 'nothing'}`);
      toast(done.length ? `Done: ${done.join(', ')}. Save to write the rewritten file.` : 'Nothing to remove.', { ms: 6000 });
    },
  },
  { id: 'protect.removeMetadata', label: 'Remove Metadata', icon: 'label_off', tab: 'Protect', group: 'Hidden Information', tip: 'Remove the document information and XMP; the next save rewrites the whole file', run: (app) => { const tab = app.tab; if (removal(app, tab, 'Remove Metadata', (doc) => sanitize(doc, { metadata: true }))) { audit(tab, 'Metadata removed'); toast('Metadata removed. Save to write the rewritten file.'); } } },
  { id: 'protect.removeAttachments', label: 'Remove Attachments', icon: 'attachment', tab: 'Protect', group: 'Hidden Information', tip: 'Remove every attached file; the next save rewrites the whole file', run: async (app) => { const tab = app.tab; const n = readAttachments(tab.doc).length; if (!n) { toast('There are no attachments.'); return; } if (await confirmDialog('Remove Attachments', `Remove ${n} attachment(s)?`, 'Remove')) { if (removal(app, tab, 'Remove Attachments', (doc) => sanitize(doc, { attachments: true }))) { audit(tab, `${n} attachment(s) removed`); toast(`${n} attachment(s) removed. Save to write the rewritten file.`); } } } },
  { id: 'protect.removeJavaScript', label: 'Remove JavaScript', icon: 'code_off', tab: 'Protect', group: 'Hidden Information', tip: 'Strip scripts and script actions (Anne\'s Folio never runs them anyway); the next save rewrites the whole file', run: (app) => { const tab = app.tab; const d = removal(app, tab, 'Remove JavaScript', (doc) => sanitize(doc, { javascript: true })); if (d) { audit(tab, 'Scripts removed'); toast(d.length ? 'Scripts and script actions removed. Save to write the rewritten file.' : 'The document has no scripts.'); } } },
  {
    id: 'protect.markFinal', label: 'Mark as Final', icon: 'verified', tab: 'Protect', group: 'Final', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Make the document read-only in this window so nothing changes by accident (not a security feature)',
    isActive: (app) => !!app.tab?.readOnly,
    run: (app) => { app.tab.readOnly = !app.tab.readOnly; app.refresh(); toast(app.tab.readOnly ? 'Marked as final: editing is turned off here.' : 'Editing is allowed again.'); },
  },
  {
    id: 'protect.watermarkConfidential', label: 'Confidential Watermark', icon: 'water_drop', tab: 'Protect', group: 'Final', tip: 'A diagonal CONFIDENTIAL watermark on every page',
    run: async (app) => { const tab = app.tab; const { addWatermark } = await import('../pdf/ops/pages'); editTab(app, tab, 'Confidential Watermark', (doc) => addWatermark(doc, doc.pages.map((_, i) => i), 'CONFIDENTIAL', { size: 72, opacity: 0.15, color: [0.8, 0, 0], rotate: 45 })); },
  },
  {
    id: 'protect.setOpenPassword', label: 'Change Open Password…', icon: 'password', tab: 'Protect', group: 'Security', isEnabled: (app) => !!app.doc?.security,
    tip: 'A new password to open the document; the permissions password and the permissions stay as they are',
    run: async (app) => {
      const tab = app.tab;
      const s = tab.doc.securityInfo; if (!s) return;
      if (tab.readOnly) { toast('This document is read-only.'); return; }
      if (!(await ensureOwner(tab))) return;
      // Known after ensureOwner: entered just now, or the password the file was opened with.
      const owner = knownOwnerPassword(tab);
      const r = await openDialog({ title: 'Change Open Password', fields: [
        { key: 'p1', label: 'New password to open (empty: the document opens without one)', type: 'password' }, { key: 'p2', label: 'Confirm', type: 'password' },
        ...(owner ? [] : [{ key: 'o1', label: 'Permissions password (empty: one is generated and shown to you)', type: 'password' as const }, { key: 'o2', label: 'Confirm', type: 'password' as const }]),
        { key: 'i', type: 'info', html: `<p class="ql-help">${owner ? 'The permissions password and the permissions stay as they are.' : 'The current permissions password cannot be read from the file, so it is set again here.'} The two passwords must differ.</p>` },
      ], validate: (v) => (v.p1 !== v.p2 ? 'The passwords do not match.' : !owner && v.o1 !== v.o2 ? 'The permissions passwords do not match.' : (owner || v.o1) && (owner || v.o1) === v.p1 ? 'The password to open must differ from the permissions password.' : null) });
      if (!r) return;
      const generated = !owner && !r.o1;
      const ownerPassword = owner || String(r.o1 || '') || newOwnerPassword();
      if (!(await confirmRewrite(tab, 'Changing the password')) || !stillCurrent(app, tab)) return;
      if (!encryptTab(app, tab, String(r.p1 || ''), ownerPassword, s.permissions, s.encryptMetadata)) return;
      audit(tab, 'Open password changed');
      toast('Open password changed. Save to write the file.');
      if (generated) await showGeneratedPassword(ownerPassword);
    },
  },
]);

export { esc, PdfString };
