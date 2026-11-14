/** Review tab: spelling of comments and fields, dictionaries, statistics, fonts, accessibility, compare, checks, language. */
import { def } from './registry';
import { NO_CHANGE, type App, type DocTab } from '../app';
import { openDialog, toast, promptDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { allAnnotations, readFields, readMetadata, writeMetadata } from '../pdf/structure';
import { setAnnotationProps } from '../pdf/ops/annots';
import { setFieldValue } from '../pdf/ops/forms';
import { listFonts, stats, archivalCheck, accessibilityCheck, accessibilityFix } from '../pdf/ops/optimize';
import { PdfDocument } from '../pdf/document';
import { openAsPdf } from '../io';
import { pickFile } from '../ui/dom';
import { openExternal } from '../platform/native';
import { Ref } from '../pdf/objects';
import type { SpellTarget } from '../proof/proofing';
import { selectedText, viewer, esc, saveBytes, baseName } from './util';

const escHtml = esc;

// ------------------------------------------------------------------------------------------
// Spelling

async function spelling(app: App): Promise<void> {
  const tab = app.tab;
  const { workerChecker, dictionaryKey, spellTargets, SpellSession } = await import('../proof/proofing');
  if (!app.stillOpen(tab)) return;
  const lang = readMetadata(tab.doc).language || app.prefs.language;
  const dict = await dictionaryKey(lang, app.prefs.spellDialect);
  // Checking another language against the English word lists would flag every word.
  if (!dict) { toast(`No spelling dictionary is installed for the document language (${lang}). Install one, or change the language under Review ▸ Language.`, { action: 'Dictionaries', onAction: () => app.exec('review.dictionaries'), ms: 9000 }); return; }
  const rev = tab.bytes;
  const targets = spellTargets(allAnnotations(tab.doc), readFields(tab.doc), { fromPage: tab.ui.page });
  if (!targets.length) { toast('Nothing to check: Anne\'s Folio checks the spelling of comments and form field values (page text is read-only).'); return; }
  const ignored = new Set(app.prefs.ignoredWords.map((w) => w.toLowerCase()));
  const dictionary = new Set(app.prefs.dictionary.map((w) => w.toLowerCase()));
  // Corrections are collected and written as one undo step when the check ends or is stopped.
  const corrected = new Map<SpellTarget, string>();
  const session = new SpellSession(targets, workerChecker, { dict, ignored, dictionary, write: (t, text) => { corrected.set(t, text); return true; } });
  const commit = (): boolean => {
    if (!corrected.size) return true;
    if (!app.stillOpen(tab, rev)) return false;
    const n = app.editTab(tab, 'Spelling', (doc) => {
      let k = 0;
      const fields = readFields(doc);
      for (const [t, text] of corrected) {
        if (t.kind === 'annotation') { const p = doc.pages[t.page]; if (!p) continue; setAnnotationProps(doc, p, new Ref(t.num, doc.genOf(t.num)), { contents: text }); k++; }
        else { const f = fields.find((x) => x.ref.num === t.num); if (!f) continue; setFieldValue(doc, f, text); k++; }
      }
      return k || NO_CHANGE;
    });
    return !!n;
  };
  try { await session.start(); } catch (e: any) { toast(`Spelling: ${e?.message || e}`); return; }
  for (;;) {
    const issue = await session.next();
    if (!issue) break;
    if (!app.docs.includes(tab)) return;
    if (issue.target.page >= 0 && issue.target.page !== tab.ui.page) tab.ui.goToPage(issue.target.page);
    if (issue.target.kind === 'annotation') { tab.ui.selectedAnnot = { page: issue.target.page, num: issue.target.num }; tab.ui.refreshAnnotations(); }
    const sugg = await workerChecker.suggest(issue.word, dict).catch(() => [] as string[]);
    const text = issue.text;
    const r = await openDialog({ title: 'Spelling', fields: [
      { key: 'ctx', type: 'info', html: `<p class="ql-help">${escHtml(issue.target.label)}</p><p>${escHtml(text.slice(Math.max(0, issue.start - 40), issue.start))}<b style="color:#c62828;text-decoration:underline wavy">${escHtml(issue.word)}</b>${escHtml(text.slice(issue.end, issue.end + 40))}</p>` },
      { key: 'to', label: 'Change to', type: 'combo', options: sugg, value: sugg[0] || issue.word },
      { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'change', label: 'Change' }, { value: 'changeAll', label: 'Change All' }, { value: 'ignore', label: 'Ignore Once' }, { value: 'ignoreAll', label: 'Ignore All' }, { value: 'add', label: 'Add to Dictionary' }], value: sugg.length ? 'change' : 'ignore' },
    ], ok: 'Apply', cancel: 'Stop' });
    if (!r) { const ok = commit(); toast(!ok ? 'Spelling check stopped; the corrections could not be written.' : session.changed ? `Stopped. ${session.changed} change(s) made.` : 'Spelling check stopped.'); return; }
    const to = String(r.to);
    // "Change" to the same word changes nothing: treat it as Ignore Once instead of writing an empty step.
    if ((r.act === 'change' || r.act === 'changeAll') && to === issue.word) session.ignoreOnce();
    else if (r.act === 'change') session.change(to);
    else if (r.act === 'changeAll') session.changeAll(to);
    else if (r.act === 'ignore') session.ignoreOnce();
    else if (r.act === 'ignoreAll') { session.ignoreAll(); app.prefs.ignoredWords = [...new Set([...app.prefs.ignoredWords, issue.word])]; app.savePrefs(); }
    else { await session.addToDictionary(); app.prefs.dictionary = [...new Set([...app.prefs.dictionary, issue.word])]; app.savePrefs(); }
  }
  const ok = commit();
  toast(!ok ? 'Spelling check complete, but the corrections could not be written.' : session.changed ? `Spelling check complete: ${session.changed} change(s).` : 'Spelling check complete. No errors found.');
}

// ------------------------------------------------------------------------------------------
// Compare

/** Largest LCS table (cells) the line diff builds; beyond it the changed region is reported as removed-then-added. */
const DIFF_CELLS = 4_000_000;

/** Line-level diff (LCS) of two texts. Equal lines at both ends are matched first, so only the changed middle costs memory. */
export function diffLines(a: string[], b: string[]): { kind: ' ' | '-' | '+'; text: string }[] {
  const out: { kind: ' ' | '-' | '+'; text: string }[] = [];
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) out.push({ kind: ' ', text: a[s++] });
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - s, m = eb - s, w = m + 1;
  if (n && m && (n + 1) * w <= DIFF_CELLS) {
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[s + i] === b[s + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (a[s + i] === b[s + j]) { out.push({ kind: ' ', text: a[s + i] }); i++; j++; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) out.push({ kind: '-', text: a[s + i++] }); else out.push({ kind: '+', text: b[s + j++] }); }
    while (i < n) out.push({ kind: '-', text: a[s + i++] });
    while (j < m) out.push({ kind: '+', text: b[s + j++] });
  } else {
    for (let i = s; i < ea; i++) out.push({ kind: '-', text: a[i] });
    for (let j = s; j < eb; j++) out.push({ kind: '+', text: b[j] });
  }
  for (let i = ea; i < a.length; i++) out.push({ kind: ' ', text: a[i] });
  return out;
}

/**
 * Pairs the pages of two versions by their text, so that an inserted or removed page shifts nothing:
 * identical pages are matched first, the pages between two matches are paired in order (changed pages),
 * and what is left over exists in one version only. [i, j] with null for "not in that version".
 */
export function alignPages(a: string[], b: string[]): [number | null, number | null][] {
  const key = (t: string) => t.replace(/\s+/g, ' ').trim();
  const d = diffLines(a.map(key), b.map(key));
  const out: [number | null, number | null][] = [];
  let i = 0, j = 0, del = 0, ins = 0;
  const flush = () => {
    const both = Math.min(del, ins);
    for (let k = 0; k < both; k++) out.push([i++, j++]);
    for (let k = both; k < del; k++) out.push([i++, null]);
    for (let k = both; k < ins; k++) out.push([null, j++]);
    del = ins = 0;
  };
  for (const x of d) { if (x.kind === '-') del++; else if (x.kind === '+') ins++; else { flush(); out.push([i++, j++]); } }
  flush();
  return out;
}

async function compare(app: App): Promise<void> {
  // The document being compared is the one in front now, whatever tab is created or activated below.
  const mine = app.tab;
  const others = app.docs.filter((d) => d !== mine);
  const r = await openDialog({ title: 'Compare Documents', fields: [
    { key: 'src', label: 'Compare this document with', type: 'radio', options: [...(others.length ? [{ value: 'open', label: 'An open document' }] : []), { value: 'file', label: 'A file…' }], value: others.length ? 'open' : 'file' },
    ...(others.length ? [{ key: 'other', label: 'Document', type: 'select' as const, options: others.map((d) => ({ value: d.id, label: d.displayName })), value: others[0].id, visibleIf: (v: any) => v.src === 'open' }] : []),
    { key: 'pixels', label: 'Also compare the look of each page (slower)', type: 'checkbox', value: false },
  ], ok: 'Compare' });
  if (!r) return;
  let otherDoc: PdfDocument; let otherName = ''; let otherTab: DocTab | null = r.src === 'open' ? app.docs.find((d) => d.id === r.other && d !== mine) || null : null;
  if (otherTab) { otherDoc = otherTab.doc; otherName = otherTab.displayName; }
  else {
    const [f] = await pickFile('.pdf');
    if (!f) return;
    const res = await openAsPdf(new Uint8Array(await f.arrayBuffer()), f.name);
    if (!app.stillOpen(mine)) return;
    otherDoc = res.doc; otherName = f.name;
    otherTab = app.createTab(otherDoc, { title: f.name.replace(/\.pdf$/i, ''), fileName: f.name }, res.bytes);
    otherTab.dirty = false;
    app.activate(mine);
  }
  if (!app.stillOpen(mine)) return;
  const myDoc = mine.doc;
  const items: { level: 'info' | 'warning' | 'error'; text: string; page?: number }[] = [];
  const { pageText } = await import('../pdf/ops/extract');
  // The viewer's text when it has it; the engine's own extraction while a just-opened tab is still loading.
  const textOf = async (tab: DocTab | null, doc: PdfDocument, i: number): Promise<string> => {
    let t = '';
    try { if (tab && app.docs.includes(tab)) t = await tab.ui.pageText(i); } catch { /* fall back */ }
    return t || pageText(doc, i);
  };
  const a: string[] = [], b: string[] = [];
  for (let i = 0; i < myDoc.pageCount; i++) a.push(await textOf(mine, myDoc, i));
  for (let j = 0; j < otherDoc.pageCount; j++) b.push(await textOf(otherTab, otherDoc, j));
  let changed = 0;
  const detail: HTMLElement[] = [];
  const pairs = alignPages(a, b);
  for (const [i, j] of pairs) {
    if (i === null) { items.push({ level: 'warning', text: `Page ${j! + 1} of ${otherName}: not in this document` }); continue; }
    if (j === null) { items.push({ level: 'warning', text: `Page ${i + 1}: only in this document`, page: i }); continue; }
    const where = `Page ${i + 1}${j !== i ? ` (page ${j + 1} of ${otherName})` : ''}`;
    const d = diffLines(a[i].split('\n').map((l) => l.trim()).filter(Boolean), b[j].split('\n').map((l) => l.trim()).filter(Boolean));
    const removed = d.filter((x) => x.kind === '-').length, added = d.filter((x) => x.kind === '+').length;
    if (removed || added) {
      changed++;
      items.push({ level: 'error', text: `${where}: ${removed} line(s) removed, ${added} added`, page: i });
      detail.push(h('details', null, h('summary', null, `${where} text changes`), h('pre', { class: 'ql-notices', style: 'max-height:200px' }, d.filter((x) => x.kind !== ' ').map((x) => `${x.kind} ${x.text}`).join('\n'))));
    } else items.push({ level: 'info', text: `${where}: same text`, page: i });
    if (r.pixels && otherTab && app.docs.includes(otherTab) && app.docs.includes(mine)) {
      try {
        const [ca, cb] = await Promise.all([mine.ui.renderPagePng(i, 36), otherTab.ui.renderPagePng(j, 36)]);
        const [ia, ib] = await Promise.all([createImageBitmap(ca), createImageBitmap(cb)]);
        const w = Math.min(ia.width, ib.width), hh = Math.min(ia.height, ib.height);
        const c1 = document.createElement('canvas'); c1.width = w; c1.height = hh; const x1 = c1.getContext('2d')!; x1.drawImage(ia, 0, 0); const d1 = x1.getImageData(0, 0, w, hh).data;
        const c2 = document.createElement('canvas'); c2.width = w; c2.height = hh; const x2 = c2.getContext('2d')!; x2.drawImage(ib, 0, 0); const d2 = x2.getImageData(0, 0, w, hh).data;
        ia.close?.(); ib.close?.();
        let diff = 0; for (let k = 0; k < d1.length; k += 4) if (Math.abs(d1[k] - d2[k]) + Math.abs(d1[k + 1] - d2[k + 1]) + Math.abs(d1[k + 2] - d2[k + 2]) > 60) { diff++; d1[k] = 255; d1[k + 1] = 0; d1[k + 2] = 0; } else { d1[k + 1] = d1[k + 2] = d1[k] = 255 - (255 - d1[k]) / 3; }
        const pct = (100 * diff) / (w * hh);
        if (pct > 0.2) { x1.putImageData(new ImageData(d1, w, hh), 0, 0); items.push({ level: 'warning', text: `${where}: ${pct.toFixed(1)}% of the pixels differ`, page: i }); detail.push(h('details', null, h('summary', null, `${where} pixel differences (red)`), Object.assign(document.createElement('img'), { src: c1.toDataURL('image/png'), style: 'max-width:100%;border:1px solid #ccc' }))); }
      } catch (e) { console.warn('pixel compare', e); }
    }
  }
  if (!app.stillOpen(mine)) return;
  if (app.tab !== mine) app.activate(mine);
  const other = otherTab;
  app.ui.openPane('report', { title: `Compare: ${mine.displayName} vs ${otherName}`, items: [{ level: 'info', text: `${changed} page(s) with text changes out of ${pairs.length}` }, ...items], html: detail.length ? h('div', null, ...detail) : undefined, actions: other ? [{ label: 'Side by side', run: () => { if (app.docs.includes(other)) app.exec('view.compareSideBySide', other.id); } }] : [] });
}

// ------------------------------------------------------------------------------------------
// Read aloud

/** The utterance being read, or null. Only its own end (or failure) clears it, so a restart is not undone by the old one finishing late. */
let speaking: SpeechSynthesisUtterance | null = null;
async function readAloud(app: App): Promise<void> {
  if (!('speechSynthesis' in window)) { toast('Speech is not available on this device.'); return; }
  const tab = app.tab;
  const text = selectedText(tab) || (await viewer(tab).pageText(tab.ui.page));
  if (!text.trim()) { toast('Nothing to read on this page (a scanned page needs OCR first).'); return; }
  speaking = null;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 20000));
  const lang = readMetadata(tab.doc).language || app.prefs.language;
  if (lang) u.lang = lang;
  u.rate = app.prefs.readAloudRate || 1;
  const done = () => { if (speaking !== u) return; speaking = null; app.ui.status?.(''); app.refresh(); };
  u.onend = done;
  u.onerror = done;
  speaking = u;
  app.ui.status?.('● Reading aloud (Review ▸ Stop Reading)');
  speechSynthesis.speak(u);
  app.refresh();
}

const LANGS = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'es-ES', 'es-MX', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'pt-BR', 'pt-PT', 'nl-NL', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'pl-PL', 'cs-CZ', 'hu-HU', 'ro-RO', 'ru-RU', 'uk-UA', 'el-GR', 'tr-TR', 'he-IL', 'ar-SA', 'hi-IN', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR'];

def([
  { id: 'review.spelling', label: 'Spelling', icon: 'spellcheck', tab: 'Review', group: 'Proofing', keys: ['F7'], popular: true, tip: 'Check the spelling of comments and form field values (page text is read-only)', run: spelling },
  { id: 'review.dictionaries', label: 'Spelling Dictionaries', icon: 'translate', tab: 'Review', group: 'Proofing', edits: false, noRecord: true, tip: 'Download dictionaries for other languages', run: async (app) => { const { openDictionaryWizard } = await import('../ui/dictWizard'); await openDictionaryWizard(app); } },
  {
    id: 'review.statistics', label: 'Document Statistics', icon: 'analytics', tab: 'Review', group: 'Proofing', edits: false, noRecord: true,
    run: async (app) => {
      const tab = app.tab;
      const doc = tab.doc;
      const text = (await viewer(tab).allText()).join('\n');
      const s = stats(doc, text);
      const rows: [string, string | number][] = [['Pages', s.pages], ['Words', s.words], ['Characters', s.characters], ['Images', s.images], ['Fonts', s.fonts], ['Annotations', s.annotations], ['Form fields', s.fields], ['Attachments', s.attachments], ['Bookmarks', s.bookmarks], ['File size', `${(tab.bytes.length / 1024).toFixed(0)} KB`], ['Objects', s.objects], ['PDF version', s.version || doc.report.header], ['Encrypted', doc.security ? 'yes' : 'no']];
      await openDialog({ title: 'Document Statistics', ok: 'Close', cancel: false, content: h('table', { class: 'ql-table' }, rows.map((rw) => h('tr', null, h('th', { style: 'text-align:left;padding-right:16px' }, rw[0]), h('td', null, String(rw[1]))))) });
    },
  },
  {
    id: 'review.fonts', label: 'Fonts', icon: 'font_download', tab: 'Review', group: 'Proofing', edits: false, noRecord: true, tip: 'Every font the pages use: type, encoding, embedded or not',
    run: (app) => {
      const fonts = listFonts(app.doc);
      const items = fonts.map((f) => ({ level: (f.embedded || f.type3 ? 'info' : 'warning') as 'info' | 'warning', text: `${f.name} — ${f.subtype}${f.encoding ? `, ${f.encoding}` : ''}, ${f.embedded ? 'embedded' : f.type3 ? 'Type 3 (glyphs in the file)' : 'not embedded (substituted on screen)'}; pages ${f.pages.map((p) => p + 1).slice(0, 12).join(', ')}${f.pages.length > 12 ? '…' : ''}`, page: f.pages[0] }));
      app.ui.openPane('report', { title: `Fonts (${fonts.length})`, items: items.length ? items : [{ level: 'info', text: 'The document uses no fonts (image-only pages?).' }] });
    },
  },
  {
    id: 'review.checkAccessibility', label: 'Check Accessibility', icon: 'accessibility_new', tab: 'Review', group: 'Accessibility', edits: false, noRecord: true, popular: true,
    run: async (app) => { const tab = app.tab; const texts = await viewer(tab).allText(); if (app.tab !== tab) return; const items = accessibilityCheck(tab.doc, texts); app.ui.openPane('report', { title: 'Accessibility', items, actions: [{ label: 'Fix what can be fixed…', run: () => app.exec('review.accessibilityFixer') }] }); },
  },
  {
    id: 'review.accessibilityFixer', label: 'Accessibility Fixer', icon: 'auto_fix_high', tab: 'Review', group: 'Accessibility',
    tip: 'Set the title and language, turn on Display Document Title, and give fields tooltips',
    run: async (app) => {
      const tab = app.tab;
      const m = readMetadata(tab.doc);
      const r = await openDialog({ title: 'Accessibility Fixer', fields: [{ key: 'title', label: 'Document title', type: 'text', value: m.title || tab.title }, { key: 'lang', label: 'Language', type: 'combo', options: LANGS, value: m.language || app.prefs.language || 'en-US' }, { key: 'i', type: 'info', html: '<p class="ql-help">Tagging existing content (reading order, headings, alt text) cannot be added automatically; create tagged PDFs from the authoring application when you can.</p>' }], ok: 'Fix' });
      if (!r) return;
      const done = app.editTab(tab, 'Accessibility Fixer', (doc) => { const d = accessibilityFix(doc, { title: r.title, language: r.lang }); return d.length ? d : NO_CHANGE; });
      toast(done?.length ? `Fixed: ${done.join(', ')}.` : 'Nothing needed fixing.');
      if (app.tab === tab && app.ui.paneOpen('report')) app.exec('review.checkAccessibility');
    },
  },
  { id: 'review.readAloud', label: 'Read Aloud', icon: 'record_voice_over', tab: 'Review', group: 'Accessibility', edits: false, noRecord: true, keys: ['Mod-Alt-Space'], tip: 'Read the selected text, or the page, with the system voice', run: readAloud },
  { id: 'review.stopReading', label: 'Stop Reading', icon: 'voice_over_off', tab: 'Review', group: 'Accessibility', edits: false, noRecord: true, isEnabled: () => !!speaking, run: (app) => { speaking = null; speechSynthesis?.cancel(); app.ui.status?.(''); } },
  {
    id: 'review.readingRate', label: 'Reading Speed', icon: 'speed', tab: 'Review', group: 'Accessibility', kind: 'menu', edits: false, noRecord: true,
    menu: (app) => [0.7, 0.85, 1, 1.25, 1.5, 2].map((x) => ({ id: 'review.readingRate', arg: x, label: `${x}×`, checked: (app.prefs.readAloudRate || 1) === x })),
    run: (app, x?: number) => { if (x) { app.prefs.readAloudRate = x; app.savePrefs(); } },
  },
  { id: 'review.compare', label: 'Compare…', icon: 'compare', tab: 'Review', group: 'Compare', edits: false, noRecord: true, popular: true, tip: 'Text differences page by page with another version (and optionally pixel differences)', run: compare },
  { id: 'review.archivalCheck', label: 'Archival Check', icon: 'inventory', tab: 'Review', group: 'Checks', edits: false, noRecord: true, tip: 'What stands between this file and an archival (PDF/A-style) PDF', run: (app) => app.ui.openPane('report', { title: 'Archival Check', items: archivalCheck(app.doc), actions: [{ label: 'Prepare for archiving…', run: () => app.exec('tools.toArchival') }] }) },
  {
    id: 'review.compatibility', label: 'Compatibility', icon: 'rule', tab: 'Review', group: 'Checks', edits: false, noRecord: true, tip: 'Features of this file that older or simpler readers may not handle',
    run: (app) => {
      const d = app.doc;
      const items: { level: 'info' | 'warning'; text: string }[] = [{ level: 'info', text: `PDF version ${d.report.header || 'unknown'}${d.usesXrefStream ? ', cross-reference streams (PDF 1.5+)' : ''}` }];
      if (d.security) items.push({ level: 'warning', text: `Encrypted with ${d.securityInfo?.method.toUpperCase()} (AES-256 needs readers for PDF 1.7 extension level 3 / PDF 2.0).` });
      if (d.getDict(d.catalog, 'AcroForm')?.has('XFA')) items.push({ level: 'warning', text: 'XFA forms are present: only some readers show them; Anne\'s Folio shows the AcroForm fallback.' });
      if (d.getDict(d.catalog, 'OCProperties')) items.push({ level: 'warning', text: 'Optional content (layers) needs PDF 1.5+.' });
      if (d.getDict(d.catalog, 'Collection')) items.push({ level: 'warning', text: 'A portfolio (collection) needs PDF 1.7+; other readers show only the cover sheet.' });
      const fonts = listFonts(d);
      if (fonts.some((f) => f.subtype === 'Type0')) items.push({ level: 'info', text: 'Composite (CID) fonts are used: fine in modern readers.' });
      if (fonts.some((f) => !f.embedded && !f.type3)) items.push({ level: 'warning', text: 'Some fonts are not embedded: other devices substitute them.' });
      if (d.pages.some((p) => p.dict.has('Group'))) items.push({ level: 'info', text: 'Transparency groups are used (PDF 1.4+).' });
      if (d.pages.some((p) => (p.dict.get('UserUnit') as any) > 1)) items.push({ level: 'warning', text: 'UserUnit scaling is used (PDF 1.6+; many readers ignore it).' });
      app.ui.openPane('report', { title: 'Compatibility', items: items.length > 1 ? items : [...items, { level: 'info', text: 'No compatibility concerns found.' }] });
    },
  },
  { id: 'review.translate', label: 'Translate', icon: 'g_translate', tab: 'Review', group: 'Language', edits: false, noRecord: true, tip: 'Translate the selected text or the page with your AI provider', run: (app) => app.exec('ai.translate') },
  {
    id: 'review.lookUp', label: 'Look Up', icon: 'travel_explore', tab: 'Review', group: 'Language', edits: false, noRecord: true, keys: ['Mod-Shift-l'], tip: 'Look up the selected words in a dictionary, encyclopedia or web search',
    run: async (app) => {
      const q = selectedText(app).trim().slice(0, 200) || (await promptDialog('Look Up', 'Word or phrase', ''));
      if (!q) return;
      const r = await openDialog({ title: `Look Up "${q.slice(0, 40)}"`, fields: [{ key: 'w', label: 'Where', type: 'radio', options: [{ value: 'wiktionary', label: 'Wiktionary (dictionary)' }, { value: 'wikipedia', label: 'Wikipedia (encyclopedia)' }, { value: 'ddg', label: 'Web search (DuckDuckGo)' }, { value: 'ai', label: 'Ask the AI to explain it' }], value: 'wiktionary' }], ok: 'Open' });
      if (!r) return;
      if (r.w === 'ai') { app.exec('ai.explain'); return; }
      const url = r.w === 'wiktionary' ? `https://en.wiktionary.org/wiki/${encodeURIComponent(q)}` : r.w === 'wikipedia' ? `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}` : `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
      openExternal(url);
    },
  },
  {
    id: 'review.language', label: 'Language…', icon: 'language', tab: 'Review', group: 'Language', tip: 'The document language (for spelling, screen readers and read aloud)',
    run: async (app) => {
      const tab = app.tab;
      const m = readMetadata(tab.doc);
      const r = await openDialog({ title: 'Document Language', fields: [{ key: 'lang', label: 'Language (BCP 47)', type: 'combo', options: LANGS, value: m.language || app.prefs.language || 'en-US' }, { key: 'def', label: 'Also use it for spelling in every document', type: 'checkbox', value: false }] });
      if (!r) return;
      const lang = String(r.lang).trim();
      app.editTab(tab, 'Document Language', (doc) => (lang === readMetadata(doc).language ? NO_CHANGE : writeMetadata(doc, { language: lang })));
      if (r.def) { app.prefs.language = lang; app.savePrefs(); }
    },
  },
  {
    id: 'review.exportComments', label: 'Comments as Text', icon: 'summarize', tab: 'Review', group: 'Comments', edits: false, noRecord: true,
    run: async (app) => { const tab = app.tab; const all = allAnnotations(tab.doc).filter((a) => !['Widget', 'Popup', 'Link'].includes(a.subtype)); await saveBytes(all.map((a) => `Page ${a.page + 1}\t${a.subtype}\t${a.author}\t${a.date ? a.date.toISOString() : ''}\t${a.contents.replace(/\s+/g, ' ')}`).join('\n'), `${baseName(tab)} comments.tsv`, 'text/tab-separated-values'); },
  },
]);

export { PdfDocument };
