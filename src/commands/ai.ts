/**
 * AI tab: setup, providers, several AIs, and the document features (summaries, questions, extraction,
 * translation, comment help, OCR clean-up, alt text, redaction suggestions, bookmarks, assistant).
 * Only the text a command needs is sent, answers are previewed, and changes apply as one undoable step
 * to the document the command was started on, never to whichever document is in front when the answer arrives.
 */
import { def, type MenuEntry } from './registry';
import { NO_CHANGE, type App, type DocTab } from '../app';
import { aiSettings, saveAiSettings, resolveProvider } from '../ai/store';
import { providerById } from '../ai/providers';
import { chat, activeEnsemble, inputBudgetChars, type ChatMessage, type ContentPart } from '../ai/client';
import { outcomeLine, type EnsembleMode } from '../ai/ensemble';
import { FOLIO_SYSTEM, TASKS, cleanText, linesOf, parseJsonLoose, fenced } from '../ai/folio';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { readFields, readOutlines, writeOutlines, outlinesToInput, pageAnnotations, type OutlineInput } from '../pdf/structure';
import type { PdfDocument, PageInfo } from '../pdf/document';
import { setFieldProps } from '../pdf/ops/forms';
import { setAnnotationProps, addReply, addNote, addRedactMark } from '../pdf/ops/annots';
import { listImages, type ImageInfo } from '../pdf/ops/optimize';
import { PdfString, Ref, nameText } from '../pdf/objects';
import { toBase64 } from '../util/store';
import { selectedText, selectedAnnotation, viewer, pageOf, saveBytes, baseName, esc } from './util';
import { invisibleRuns, ocrLayerText, applyOcrCorrections } from './ocrlayer';

// ------------------------------------------------------------------------------------------
// Readiness, privacy, requests

const cloudId = (id: string) => { const p = providerById(id); return !!p && p.kind !== 'local' && p.kind !== 'builtin'; };
function aiRecipients(): string[] {
  const plan = activeEnsemble();
  if (!plan) { const a = aiSettings().active; return a ? [a] : []; }
  return [...new Set([...plan.members.map((m) => m.provider), plan.master.provider])];
}
const names = (ids: string[]) => { const n = ids.map((id) => providerById(id)?.name || id); return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`; };

export async function ensureAiReady(app: App, reason = 'This command needs an AI provider. Choose one below; free options, including one that runs on this device, are at the top.'): Promise<boolean> {
  const s = aiSettings();
  if (!s.enabled) { toast('AI features are turned off (AI ▸ AI Settings).', { action: 'Settings', onAction: () => app.exec('ai.settings') }); return false; }
  if (!(s.active && (await resolveProvider()))) {
    const { openAiSetup } = await import('../ui/aiWizard');
    if (!(await openAiSetup(app, { reason }))) return false;
  }
  const ids = aiRecipients().filter((id) => cloudId(id) && !aiSettings().privacyAck.includes(id));
  if (!ids.length) return true;
  const free = ids.some((id) => providerById(id)?.free === 'free');
  const ok = await confirmDialog('Sending Text to an AI Service', `AI commands send only the page text they need directly from this device to ${names(ids)}. Anne's Folio has no server and keeps no copy. The service's terms and privacy policy apply${free ? ', and free tiers may use what you send to improve their models' : ''}. For confidential documents, use the on-device model. Continue?`, 'Continue', 'Cancel');
  if (ok) saveAiSettings((x) => { for (const id of ids) if (!x.privacyAck.includes(id)) x.privacyAck.push(id); });
  return ok;
}

let controller: AbortController | null = null;

function system(): string {
  const s = aiSettings();
  return [FOLIO_SYSTEM, s.language && s.language !== 'auto' ? `Write in ${s.language}.` : '', s.styleGuide ? `Style guide: ${s.styleGuide}` : ''].filter(Boolean).join('\n');
}

/** Sends a prompt and returns the answer text (with a status line while waiting). */
export async function ask(app: App, prompt: string | ContentPart[], opts: { tier?: 'fast' | 'quality'; maxTokens?: number } = {}): Promise<string | null> {
  if (!(await ensureAiReady(app))) return null;
  controller?.abort();
  controller = new AbortController();
  const ctl = controller;
  app.ui.status?.('● AI is working… (AI ▸ Stop AI to cancel)');
  try {
    const messages: ChatMessage[] = [{ role: 'system', content: system() }, { role: 'user', content: prompt }];
    const r = await chat({ messages, tier: opts.tier || 'quality', maxTokens: opts.maxTokens || 2000, signal: ctl.signal, onStatus: (t) => app.ui.status?.(`● ${t}`) });
    if (r.ensemble && aiSettings().ensemble.showDeliberation) toast(outcomeLine(r.ensemble, (id) => providerById(id)?.name || id), { ms: 8000 });
    if (r.truncated) toast('The AI answer was cut short; the result may be incomplete.');
    return r.text;
  } catch (e: any) {
    if (e?.code === 'aborted' || ctl.signal.aborted) toast('AI stopped.');
    else toast(`AI: ${e?.message || e}`, { ms: 7000 });
    return null;
  } finally {
    if (controller === ctl) controller = null;
    app.ui.status?.('');
  }
}

/** The document's text, page by page, with page markers (truncated to maxChars). */
async function docText(tab: DocTab, maxChars = 24000, pages?: number[]): Promise<string> {
  // A model running on this device gets less text than a cloud model, so an answer arrives in reasonable time.
  maxChars = Math.min(maxChars, inputBudgetChars());
  const v = viewer(tab);
  const idx = pages || tab.doc.pages.map((_, i) => i);
  const parts: string[] = [];
  let n = 0;
  for (const i of idx) { const t = (await v.pageText(i)).trim(); if (!t) continue; const chunk = `[Page ${i + 1}]\n${t}`; n += chunk.length; parts.push(chunk); if (n > maxChars) break; }
  const out = parts.join('\n\n');
  if (out.length > maxChars) toast(`The document is long; only the first ${Math.round(maxChars / 1000)}k characters were sent.`);
  return out.slice(0, maxChars);
}

/**
 * Page texts cut into pieces of at most maxChars for requests that must cover a whole document. Each piece
 * starts its pages with a "[Page n]" line; a page longer than maxChars is split across pieces.
 */
export function chunkPages(texts: string[], maxChars: number): { pages: number[]; text: string }[] {
  const out: { pages: number[]; text: string }[] = [];
  let cur: { pages: number[]; text: string } = { pages: [], text: '' };
  const flush = () => { if (cur.text) out.push(cur); cur = { pages: [], text: '' }; };
  texts.forEach((raw, i) => {
    const t = raw.trim();
    if (!t) return;
    const head = `[Page ${i + 1}]\n`;
    const room = Math.max(200, maxChars - head.length);
    for (let o = 0; o < t.length; o += room) {
      const piece = head + t.slice(o, o + room);
      if (cur.text && cur.text.length + 2 + piece.length > maxChars) flush();
      cur.text += (cur.text ? '\n\n' : '') + piece;
      if (!cur.pages.includes(i)) cur.pages.push(i);
    }
  });
  flush();
  return out;
}

/** Shows an answer with ways to keep it: copy, save, add as a note, append as pages (on the tab the command ran on). */
async function showResult(app: App, tab: DocTab, title: string, text: string, opts: { notePage?: number; csv?: boolean } = {}): Promise<void> {
  const page = opts.notePage ?? tab.ui.page;
  await openDialog({ title, wide: true, ok: 'Close', cancel: false, fields: [{ key: 't', label: 'Result (you can edit it)', type: 'textarea', rows: Math.min(20, Math.max(6, text.split('\n').length + 1)), value: text }], buttons: [
    { label: 'Copy', onClick: (v) => { navigator.clipboard?.writeText(String(v.t)); toast('Copied'); } },
    { label: opts.csv ? 'Save CSV…' : 'Save as Text…', onClick: (v) => { void saveBytes(String(v.t), `${baseName(tab)} ${title.toLowerCase()}.${opts.csv ? 'csv' : 'txt'}`, opts.csv ? 'text/csv' : 'text/plain'); } },
    { label: 'Add as Note', onClick: (v, ctl) => { ctl.close(null); app.editTab(tab, title, (doc) => { const p = doc.pages[Math.min(page, doc.pageCount - 1)]; return addNote(doc, p, p.cropBox[0] + 24, p.cropBox[3] - 24, { contents: String(v.t), author: `${app.prefs.author} (AI)`, color: [0.75, 0.85, 1] }); }); } },
    { label: 'Append as Pages', onClick: async (v, ctl) => { ctl.close(null); const { addTextPages } = await import('../pdf/build'); app.editTab(tab, title, (doc) => addTextPages(doc, `# ${title}\n\n${v.t}`, { font: 'Helvetica', size: 11 })); } },
  ] });
}

/** The selected annotation of a tab, looked up again by object number (the document may have changed during a request). */
function annotationOf(tab: DocTab, pageIndex: number, ref: Ref): { page: PageInfo; ref: Ref } | null {
  const page = tab.doc.pages[pageIndex];
  const a = page ? pageAnnotations(tab.doc, page).find((x) => x.ref?.num === ref.num) : undefined;
  return a?.ref && page ? { page, ref: a.ref } : null;
}

/** A JPEG data URL of an embedded picture, at most 1024 px on its longest side; '' when it cannot be decoded here. */
async function pictureDataUrl(doc: PdfDocument, im: ImageInfo): Promise<string> {
  const { extractImage, rawToRgba } = await import('../pdf/ops/extract');
  const ex = extractImage(doc, im);
  let bmp: ImageBitmap;
  if (ex.kind === 'jpeg') {
    if (ex.data.length <= 1_000_000) return `data:image/jpeg;base64,${toBase64(ex.data)}`;
    bmp = await createImageBitmap(new Blob([ex.data as BlobPart], { type: 'image/jpeg' }));
  } else {
    const rgba = rawToRgba(doc, ex);
    if (!rgba) return '';
    bmp = await createImageBitmap(new ImageData(rgba as any, ex.width, ex.height));
  }
  const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.8);
}

/** The usable entries of a model's field-label answer: a name of an existing field and a non-empty tooltip. */
export function fieldLabelSuggestions(j: unknown, fieldNames: string[]): { name: string; tooltip: string; kind: string }[] {
  const out: { name: string; tooltip: string; kind: string }[] = [];
  for (const x of Array.isArray(j) ? j : []) {
    if (!x || typeof x !== 'object' || typeof x.name !== 'string' || typeof x.tooltip !== 'string') continue;
    const tooltip = x.tooltip.replace(/\s+/g, ' ').trim();
    if (tooltip && fieldNames.includes(x.name)) out.push({ name: x.name, tooltip, kind: typeof x.kind === 'string' ? x.kind.trim() : '' });
  }
  return out;
}

export interface BookmarkSuggestion { title: string; page: number; level: number }

/** The usable entries of a model's outline answer: a text title, a whole page number inside the document, a level 0–5. */
export function validBookmarks(j: unknown, pageCount: number): BookmarkSuggestion[] {
  if (!Array.isArray(j)) return [];
  const out: BookmarkSuggestion[] = [];
  for (const x of j) {
    if (!x || typeof x !== 'object') continue;
    const title = typeof x.title === 'string' || typeof x.title === 'number' ? String(x.title).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const page = typeof x.page === 'number' || typeof x.page === 'string' ? Number(x.page) : NaN;
    if (!title || !Number.isInteger(page) || page < 1 || page > pageCount) continue;
    const level = Number.isFinite(Number(x.level)) ? Math.min(5, Math.max(0, Math.round(Number(x.level)))) : 0;
    out.push({ title, page, level });
  }
  return out;
}

/** Builds the outline tree from suggestions in order: each entry goes under the nearest earlier entry of a lower level. */
export function outlineFromSuggestions(items: BookmarkSuggestion[]): OutlineInput[] {
  const out: OutlineInput[] = [];
  const trail: OutlineInput[] = [];
  for (const x of items) {
    const level = Math.min(x.level, trail.length);
    const node: OutlineInput = { title: x.title, page: x.page - 1, children: [] };
    if (level === 0) out.push(node); else (trail[level - 1].children ||= []).push(node);
    trail.length = level;
    trail[level] = node;
  }
  return out;
}

// ------------------------------------------------------------------------------------------

const ENSEMBLE_MODES: { value: EnsembleMode; label: string }[] = [
  { value: 'single', label: 'Single AI' },
  { value: 'master', label: 'Master Combines Answers' },
  { value: 'consensus', label: 'Quaker Consensus' },
];

async function setEnsembleMode(app: App, mode?: string): Promise<void> {
  const pick = ENSEMBLE_MODES.find((o) => o.value === mode);
  const { openAiSettings } = await import('../ui/aiWizard');
  if (!pick) { await openAiSettings(app, { section: 'ensemble' }); return; }
  if (pick.value !== 'single' && Object.keys(aiSettings().providers).length < 2) {
    toast('Set up at least two AI providers to use several AIs.', { action: 'Set Up AI', onAction: () => app.exec('ai.setup'), ms: 7000 });
    return;
  }
  saveAiSettings((s) => { s.ensemble.mode = pick.value; });
  if (pick.value !== 'single' && (aiSettings().ensemble.members?.length || 0) < 2) await openAiSettings(app, { section: 'ensemble', mode: pick.value });
  app.ui.refresh?.();
  toast(pick.value === 'single' ? 'AI: one AI answers (the active provider)' : `AI: ${pick.label}`);
}

/** Longest conversation text the assistant sends along with a new question. */
const ASSISTANT_HISTORY = 12000;

def([
  {
    id: 'ai.setup', label: 'Set Up AI', icon: 'auto_awesome', tab: 'AI', group: 'Setup', popular: true, noRecord: true, edits: false,
    tip: 'Choose a free or paid AI: on this device, free cloud tiers, your own computer, or a paid key', keywords: 'api key openai anthropic gemini mistral groq openrouter ollama wizard',
    run: async (app) => { const { openAiSetup } = await import('../ui/aiWizard'); await openAiSetup(app); },
  },
  { id: 'ai.providers', label: 'Providers & Models', icon: 'tune', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Switch AI provider, choose models, test or remove keys', run: async (app) => { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); } },
  {
    id: 'ai.active', label: 'Active AI', icon: 'swap_horiz', tab: 'AI', group: 'Setup', kind: 'menu', noRecord: true, edits: false, tip: 'Switch between the AI providers you have set up',
    run: async (app, id?: string) => {
      if (!id) { const { openAiProviders } = await import('../ui/aiWizard'); await openAiProviders(app); return; }
      if (!aiSettings().providers[id]) return;
      saveAiSettings((s) => { s.active = id; });
      toast(`AI: ${providerById(id)?.name}`);
    },
    menu: () => { const s = aiSettings(); const items: MenuEntry[] = Object.keys(s.providers).map((id) => ({ id: 'ai.active', arg: id, label: `${providerById(id)?.name || id} · ${s.providers[id].model}`, checked: s.active === id })); return [...items, ...(items.length ? [{ separator: true }] : []), { id: 'ai.setup', label: 'Add a Provider…' }]; },
  },
  { id: 'ai.settings', label: 'AI Settings', icon: 'settings_suggest', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Turn AI on or off, language for generated text, style guide, usage', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app); } },
  {
    id: 'ai.privacy', label: 'AI & Privacy', icon: 'shield', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Where your text goes when you use AI',
    run: async () => {
      const p = providerById(aiSettings().active || '');
      await openDialog({ title: 'AI & Privacy', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: [
        '<p><b>Anne\'s Folio has no server.</b> AI requests go directly from this device to the provider you choose, using your own key. Nothing is sent until you run an AI command.</p>',
        `<p><b>Active provider:</b> ${p ? esc(p.name) : 'none'}${p && (p.kind === 'local' || p.kind === 'builtin') ? ' — runs on this device; your document does not leave it.' : p ? ' — the text a command needs (the selection, the page, or the document text for whole-document commands) is sent to this service; its terms apply.' : ''}</p>`,
        activeEnsemble() ? `<p><b>Several AIs are on.</b> Each AI command sends the same text to every one of these services: ${esc(names(aiRecipients()))}.</p>` : '',
        '<p><b>Pictures</b> are sent only by Alt Text for Images, and only the pictures on the page you choose.</p>',
        '<p><b>Whole documents:</b> Suggest Redactions sends the text of every page, in several requests, so that no page is left unread.</p>',
        '<p><b>Keys</b> are stored on this device only. They are never placed in documents, drafts or exported settings.</p>',
        '<p><b>Changes are previewed</b> and applied as one step you can undo. Text from the document is given to the AI as material to work on; the AI is told not to follow instructions written inside it, but check what it proposes before you accept it.</p>',
      ].join('') }] });
    },
  },
  { id: 'ai.stop', label: 'Stop AI', icon: 'stop_circle', tab: 'AI', group: 'Setup', noRecord: true, edits: false, isEnabled: () => !!controller, tip: 'Stop the AI request in progress', run: () => { controller?.abort(); controller = null; } },
  {
    id: 'ai.deleteModels', label: 'Delete Downloaded Models', icon: 'delete_sweep', tab: 'AI', group: 'Setup', noRecord: true, edits: false, tip: 'Free the storage used by the on-device AI model',
    run: async () => { const { clearLocalModels, localStorageEstimate } = await import('../ai/local'); if (!(await confirmDialog('Delete Downloaded Models', `Delete the on-device AI model files? (${await localStorageEstimate()}). They download again the next time you use the on-device model.`, 'Delete'))) return; const n = await clearLocalModels(); toast(`Deleted ${n} cached file(s).`); },
  },
  {
    id: 'ai.ensembleMode', label: 'Several AIs', icon: 'groups', tab: 'AI', group: 'Several AIs', kind: 'menu', edits: false,
    tip: 'Ask one AI, or several at once: one AI combines their answers (master), or they deliberate until they agree (Quaker consensus)',
    run: (app, mode?: string) => setEnsembleMode(app, mode),
    menu: () => { const e = aiSettings().ensemble; return [...ENSEMBLE_MODES.map((o) => ({ id: 'ai.ensembleMode', arg: o.value, label: o.label, checked: e.mode === o.value })), { separator: true }, { id: 'ai.ensembleMembers', label: 'Choose AIs…' }, { id: 'ai.showDeliberation', label: 'Show AI Discussion', checked: e.showDeliberation }]; },
    isActive: () => aiSettings().ensemble.mode !== 'single',
  },
  { id: 'ai.ensembleMembers', label: 'Choose AIs', icon: 'checklist', tab: 'AI', group: 'Several AIs', noRecord: true, edits: false, tip: 'Choose which AIs answer together, the master or clerk, and the rounds of discussion', run: async (app) => { const { openAiSettings } = await import('../ui/aiWizard'); await openAiSettings(app, { section: 'ensemble' }); } },
  { id: 'ai.showDeliberation', label: 'Show AI Discussion', icon: 'forum', tab: 'AI', group: 'Several AIs', kind: 'toggle', edits: false, tip: 'Show the outcome of the discussion when several AIs answer', run: (app, on?: boolean) => { saveAiSettings((s) => { s.ensemble.showDeliberation = typeof on === 'boolean' ? on : !s.ensemble.showDeliberation; }); app.ui.refresh?.(); }, isActive: () => aiSettings().ensemble.showDeliberation },

  // Understand -------------------------------------------------------------------------------
  { id: 'ai.summarize', label: 'Summarize Document', icon: 'summarize', tab: 'AI', group: 'Understand', popular: true, edits: false, run: async (app) => { const tab = app.tab; const t = await docText(tab); if (!t) { toast('The document has no text (run OCR on scans first).'); return; } const a = await ask(app, TASKS.summarize(t), { maxTokens: 1200 }); if (a != null) await showResult(app, tab, 'Summary', cleanText(a), { notePage: 0 }); } },
  { id: 'ai.summarizePage', label: 'Summarize Page', icon: 'short_text', tab: 'AI', group: 'Understand', edits: false, run: async (app) => { const tab = app.tab; const page = tab.ui.page; const t = (await viewer(tab).pageText(page)).trim(); if (!t) { toast('This page has no text.'); return; } const a = await ask(app, TASKS.summarizePage(t), { tier: 'fast', maxTokens: 400 }); if (a != null) await showResult(app, tab, `Page ${page + 1} Summary`, cleanText(a), { notePage: page }); } },
  {
    id: 'ai.explain', label: 'Explain Selection', icon: 'lightbulb', tab: 'AI', group: 'Understand', edits: false, isEnabled: (app) => !!selectedText(app),
    run: async (app) => { const tab = app.tab; const page = tab.ui.page; const t = selectedText(tab).trim(); if (!t) { toast('Select some text first.'); return; } const ctx = (await viewer(tab).pageText(page)).slice(0, 3000); const a = await ask(app, TASKS.explain(t, ctx), { maxTokens: 600 }); if (a != null) await showResult(app, tab, 'Explanation', cleanText(a), { notePage: page }); },
  },
  {
    id: 'ai.askDocument', label: 'Ask the Document', icon: 'question_answer', tab: 'AI', group: 'Understand', popular: true, edits: false, tip: 'Ask a question; the pages whose text matches it best are sent with the question',
    run: async (app) => {
      const tab = app.tab;
      const q = await promptDialog('Ask the Document', 'Your question', '');
      if (!q || !app.stillOpen(tab)) return;
      // Pick the pages that share the most words with the question (a small retrieval step). Words are runs of
      // letters and digits in any script.
      const v = viewer(tab);
      const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
      const scored: { i: number; s: number }[] = [];
      for (let i = 0; i < tab.doc.pageCount; i++) { const t = (await v.pageText(i)).toLowerCase(); let s = 0; for (const w of words) if (t.includes(w)) s++; scored.push({ i, s }); }
      const best = scored.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 8).filter((x) => x.s > 0 || scored.every((y) => y.s === 0)).map((x) => x.i).sort((a, b) => a - b);
      const t = await docText(tab, 20000, best.length ? best : undefined);
      const a = await ask(app, TASKS.ask(t, q), { maxTokens: 800 });
      if (a != null) await showResult(app, tab, 'Answer', `Q: ${q}\n\n${cleanText(a)}`);
    },
  },
  { id: 'ai.keyPoints', label: 'Key Points', icon: 'checklist', tab: 'AI', group: 'Understand', edits: false, tip: 'Decisions, dates, amounts and action items with page numbers', run: async (app) => { const tab = app.tab; const t = await docText(tab); if (!t) { toast('The document has no text (run OCR on scans first).'); return; } const a = await ask(app, TASKS.keyPoints(t), { maxTokens: 1200 }); if (a != null) await showResult(app, tab, 'Key Points', linesOf(a).join('\n')); } },

  // Extract ----------------------------------------------------------------------------------
  { id: 'ai.extractTable', label: 'Extract Table', icon: 'table', tab: 'AI', group: 'Extract', edits: false, tip: 'Rebuild the table in the selected text (or on the page) as CSV', run: async (app) => { const tab = app.tab; const t = selectedText(tab).trim() || (await viewer(tab).pageText(tab.ui.page)); if (!t.trim()) { toast('Select the table text or go to a page with a table.'); return; } const a = await ask(app, TASKS.extractTable(t), { maxTokens: 2000 }); if (a != null) await showResult(app, tab, 'Table', cleanText(a), { csv: true }); } },
  {
    id: 'ai.extractEntities', label: 'Extract Entities', icon: 'person_search', tab: 'AI', group: 'Extract', edits: false, tip: 'People, organizations, places, dates and amounts in the selection or page',
    run: async (app) => {
      const tab = app.tab;
      const t = selectedText(tab).trim() || (await viewer(tab).pageText(tab.ui.page));
      if (!t.trim()) { toast('Select text or go to a page with text.'); return; }
      const a = await ask(app, TASKS.entities(t), { maxTokens: 1200 });
      if (a == null) return;
      const j = parseJsonLoose<Record<string, unknown>>(a);
      // The model may answer a category with a list, a single string or nothing at all.
      const lines = j && typeof j === 'object' && !Array.isArray(j) ? Object.entries(j).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.map(String).join('; ') : v == null ? '' : String(v)}`) : null;
      await showResult(app, tab, 'Entities', lines ? lines.join('\n') : cleanText(a));
    },
  },
  {
    id: 'ai.classifyFields', label: 'Label Form Fields', icon: 'ballot', tab: 'AI', group: 'Extract', tip: 'Suggest readable tooltips for the form fields from the text around them, then apply the ones you keep',
    run: async (app) => {
      const tab = app.tab;
      const fields = readFields(tab.doc).filter((f) => f.type !== 'button');
      if (!fields.length) { toast('The document has no form fields.'); return; }
      const pages = [...new Set(fields.flatMap((f) => f.widgets.map((w) => w.page)))].slice(0, 6);
      const t = await docText(tab, 12000, pages);
      const list = fields.map((f) => `${f.name}\t${f.type}\t${f.tooltip || ''}`).join('\n');
      const a = await ask(app, TASKS.classifyFields(t, list), { maxTokens: 1500 });
      if (a == null) return;
      // One list serves the dialog, its default selection and the apply step, so what is ticked is what is applied.
      const items = fieldLabelSuggestions(parseJsonLoose<unknown>(a), fields.map((f) => f.name));
      if (!items.length) { toast('The AI answer had no usable field labels.'); return; }
      const r = await openDialog({ title: 'Label Form Fields', fields: [{ key: 'f', label: 'Apply these tooltips', type: 'list', multiple: true, rows: 12, options: items.map((x, i) => ({ value: String(i), label: `${x.name} → ${x.tooltip}${x.kind ? ` (${x.kind})` : ''}` })), value: items.map((_, i) => String(i)) }], ok: 'Apply' });
      if (!r?.f?.length) return;
      app.editTab(tab, 'Label Form Fields', (doc) => { let n = 0; const fs = readFields(doc); for (const i of r.f as string[]) { const s = items[+i]; const f = s && fs.find((x) => x.name === s.name); if (f) { setFieldProps(doc, f, { tooltip: s.tooltip }); n++; } } return n || NO_CHANGE; });
    },
  },

  // Write ------------------------------------------------------------------------------------
  {
    id: 'ai.translate', label: 'Translate', icon: 'g_translate', tab: 'AI', group: 'Write', edits: false, tip: 'Translate the selection or the page; keep the result as a note or new pages',
    run: async (app, lang?: string) => {
      const tab = app.tab;
      const page = tab.ui.page;
      const t = selectedText(tab).trim() || (await viewer(tab).pageText(page));
      if (!t.trim()) { toast('Select text or go to a page with text.'); return; }
      if (!lang) { const r = await openDialog({ title: 'Translate', fields: [{ key: 'l', label: 'Into', type: 'combo', options: ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Polish', 'Russian', 'Ukrainian', 'Chinese (Simplified)', 'Japanese', 'Korean', 'Arabic', 'Hebrew', 'Hindi', 'Turkish', 'Greek', 'Swedish'], value: 'Spanish' }] }); if (!r) return; lang = r.l; }
      if (t.length > 12000) toast('The text is long; only its first 12k characters are translated.');
      const a = await ask(app, TASKS.translate(t.slice(0, 12000), lang!), { maxTokens: 3000 });
      if (a != null) await showResult(app, tab, `Translation (${lang})`, cleanText(a), { notePage: page });
    },
  },
  {
    id: 'ai.rewriteComment', label: 'Rewrite Comment', icon: 'edit_note', tab: 'AI', group: 'Write', isEnabled: (app) => { const s = selectedAnnotation(app); return !!s?.info.contents && s.info.subtype !== 'Widget'; }, tip: 'Rephrase the selected comment (more polite, shorter, clearer…)',
    run: async (app) => {
      const tab = app.tab;
      const s = selectedAnnotation(tab); if (!s?.info.contents || s.info.subtype === 'Widget') { toast('Select a comment with text first.'); return; }
      const before = s.info.contents;
      const r = await openDialog({ title: 'Rewrite Comment', fields: [{ key: 't', label: 'Make it', type: 'combo', options: ['more polite and constructive', 'shorter', 'clearer', 'more formal', 'more direct'], value: 'more polite and constructive' }] });
      if (!r) return;
      const a = await ask(app, TASKS.rewriteComment(before, r.t), { tier: 'fast', maxTokens: 300 });
      if (a == null) return;
      const out = await openDialog({ title: 'Rewrite Comment', fields: [{ key: 't', label: 'New text', type: 'textarea', rows: 4, value: cleanText(a) }], ok: 'Replace' });
      if (!out || !app.stillOpen(tab)) return;
      const at = annotationOf(tab, s.page.index, s.ref);
      if (!at || tab.doc.getText(tab.doc.resolve(at.ref) as any, 'Contents') !== before) { toast('The comment was changed or removed meanwhile; nothing was replaced.'); return; }
      app.editTab(tab, 'Rewrite Comment', (doc) => setAnnotationProps(doc, at.page, at.ref, { contents: String(out.t) }));
    },
  },
  {
    id: 'ai.replyComment', label: 'Draft Reply', icon: 'reply', tab: 'AI', group: 'Write', isEnabled: (app) => { const s = selectedAnnotation(app); return !!s?.info.contents && s.info.subtype !== 'Widget'; },
    run: async (app) => {
      const tab = app.tab;
      const s = selectedAnnotation(tab); if (!s?.info.contents || s.info.subtype === 'Widget') { toast('Select a comment first.'); return; }
      const ctx = (await viewer(tab).pageText(s.page.index)).slice(0, 2000);
      const a = await ask(app, TASKS.replyComment(s.info.contents, ctx), { tier: 'fast', maxTokens: 300 });
      if (a == null) return;
      const out = await openDialog({ title: 'Reply', fields: [{ key: 't', label: 'Reply', type: 'textarea', rows: 4, value: cleanText(a) }], ok: 'Post Reply' });
      if (!out || !app.stillOpen(tab)) return;
      const at = annotationOf(tab, s.page.index, s.ref);
      if (!at) { toast('The comment was removed meanwhile; the reply was not posted.'); return; }
      app.editTab(tab, 'Reply', (doc) => addReply(doc, at.page, at.ref, String(out.t), app.prefs.author));
    },
  },
  {
    id: 'ai.cleanOcr', label: 'Clean OCR Text', icon: 'spellcheck', tab: 'AI', group: 'Write', tip: 'Correct recognition errors in the current page\'s recognized text layer',
    run: async (app) => {
      const tab = app.tab;
      const page = tab.ui.page;
      const rev = tab.bytes;
      const runs = invisibleRuns(tab.doc, pageOf(tab, page));
      if (!runs.length) { toast('This page has no recognized text layer (Scan/OCR ▸ Recognize Text).'); return; }
      // The layer stores right-to-left words mirrored; the AI reads and returns them in reading order.
      const shown = runs.map((x) => ocrLayerText(x.text));
      const a = await ask(app, TASKS.cleanOcr(shown.join('\n')), { maxTokens: 3000 });
      if (a == null) return;
      const lines = cleanText(a).split(/\r?\n/);
      if (lines.length !== runs.length) { toast(`The AI returned ${lines.length} lines for ${runs.length} words; nothing changed. Try Scan/OCR ▸ OCR Cleanup.`); return; }
      const changes = runs.map((run, i) => ({ run, from: shown[i], text: lines[i].trim() })).filter((x) => x.text && x.text !== x.from);
      if (!changes.length) { toast('No corrections suggested.'); return; }
      const r = await openDialog({ title: 'Clean OCR Text', fields: [{ key: 'c', label: `${changes.length} correction(s)`, type: 'list', multiple: true, rows: 12, options: changes.map((c, i) => ({ value: String(i), label: `${c.from} → ${c.text}` })), value: changes.map((_, i) => String(i)) }], ok: 'Apply' });
      // The corrections name text by its place in the page content: they only fit the page as it was when they were made.
      if (!r?.c?.length || !app.stillOpen(tab, rev)) return;
      // One rewrite of the page for all corrections; the words stay invisible whatever characters they hold.
      app.editTab(tab, 'Clean OCR Text', (doc) => applyOcrCorrections(doc, pageOf(tab, page), (r.c as string[]).map((i) => changes[+i])));
    },
  },
  {
    id: 'ai.altText', label: 'Alt Text for Images', icon: 'image_search', tab: 'AI', group: 'Write', tip: 'Describe the pictures on this page (the pictures are sent to a vision-capable provider; others get the nearby text only); stored on each image object',
    run: async (app) => {
      const tab = app.tab;
      const page = tab.ui.page;
      const rev = tab.bytes;
      const all = listImages(tab.doc).filter((im) => im.page === page && im.ref);
      if (!all.length) { toast('No images on this page.'); return; }
      const imgs = all.slice(0, 6);
      const ctx = (await viewer(tab).pageText(page)).slice(0, 1500);
      const results: { im: ImageInfo; alt: string; sent: boolean }[] = [];
      for (const im of imgs) {
        let url = '';
        try { url = await pictureDataUrl(tab.doc, im); } catch (e) { console.warn('alt text picture', e); }
        const content: string | ContentPart[] = url ? [{ type: 'text', text: TASKS.altText(ctx) }, { type: 'image', dataUrl: url }] : TASKS.altText(ctx);
        const a = await ask(app, content, { tier: 'fast', maxTokens: 120 });
        if (a == null) return;
        results.push({ im, alt: cleanText(a).replace(/^"|"$/g, ''), sent: !!url });
      }
      const unsent = results.filter((x) => !x.sent).length;
      const r = await openDialog({ title: 'Alt Text', wide: true, fields: results.map((x, i) => ({ key: String(i), label: `${nameText(x.im.name)} (${x.im.width}×${x.im.height})${x.sent ? '' : ' — picture not sent, written from the nearby text'}`, type: 'text' as const, value: x.alt })), ok: 'Store', help: `${all.length > imgs.length ? `The page has ${all.length} pictures; only the first ${imgs.length} are described. ` : ''}${unsent ? `${unsent} picture(s) could not be decoded here and were not sent: their text is a guess from the words around them, so check it. ` : ''}Stored as /Alt on each image object. Screen readers use structure tags, which Anne's Folio cannot create for existing content; the text is kept for tools that read it from the image.` });
      if (!r || !app.stillOpen(tab, rev)) return;
      app.editTab(tab, 'Alt Text', (doc) => { let n = 0; results.forEach((x, i) => { const text = String(r[String(i)] ?? '').trim(); if (!text) return; const s = doc.resolve(x.im.ref!) as any; if (s?.dict) { s.dict.set('Alt', PdfString.fromText(text)); doc.update(x.im.ref!, s); n++; } }); return n || NO_CHANGE; });
    },
  },

  // Review -----------------------------------------------------------------------------------
  {
    id: 'ai.suggestRedactions', label: 'Suggest Redactions', icon: 'policy', tab: 'AI', group: 'Review', tip: 'Pattern matching (emails, phones, IDs) on every page plus the AI\'s reading of the pages; you choose what to mark',
    run: async (app) => {
      const tab = app.tab;
      const rev = tab.bytes;
      const { PII_PATTERNS, findRects } = await import('./protect');
      const v = viewer(tab);
      const count = tab.doc.pageCount;
      const texts: string[] = [];
      for (let i = 0; i < count; i++) texts.push(await v.pageText(i));
      // Patterns run on every page of the document.
      const found = new Map<string, Set<number>>();
      texts.forEach((t, i) => { for (const pat of PII_PATTERNS) { const re = new RegExp(pat.re, 'g'); let m; while ((m = re.exec(t))) { if (!m[0]) { re.lastIndex++; continue; } const k = m[0].trim(); if (!k) continue; if (!found.has(k)) found.set(k, new Set()); found.get(k)!.add(i); } } });
      // The AI reads the whole text in pieces; a piece that fails ends the reading, and the dialog says how far it got.
      let chunks = chunkPages(texts, 14000);
      if (chunks.length > 4) {
        const chars = chunks.reduce((n, c) => n + c.text.length, 0);
        const pick = await openDialog({ title: 'Suggest Redactions', fields: [{ key: 'how', label: `Reading the whole document takes ${chunks.length} AI requests (about ${Math.round(chars / 1000)}k characters)`, type: 'radio', options: [{ value: 'all', label: `Let the AI read every page (${chunks.length} requests)` }, { value: 'first', label: `Let the AI read only the beginning (4 requests, pages 1–${chunks[3].pages[chunks[3].pages.length - 1] + 1}); patterns still check every page` }, { value: 'none', label: 'Patterns only, no AI' }], value: 'all' }], ok: 'Continue' });
        if (!pick || !app.stillOpen(tab, rev)) return;
        chunks = pick.how === 'all' ? chunks : pick.how === 'first' ? chunks.slice(0, 4) : [];
      }
      const read = new Set<number>();
      for (const [n, c] of chunks.entries()) {
        app.ui.status?.(`● AI is reading pages ${c.pages[0] + 1}–${c.pages[c.pages.length - 1] + 1} (part ${n + 1} of ${chunks.length})…`);
        const a = await ask(app, TASKS.suggestRedactions(c.text), { maxTokens: 1500 });
        if (a == null) break;
        const list = parseJsonLoose<unknown>(a);
        for (const s of Array.isArray(list) ? list : []) if (typeof s === 'string' && s.trim().length > 2) { const k = s.trim(); if (!found.has(k)) found.set(k, new Set()); }
        for (const p of c.pages) read.add(p);
      }
      if (!app.stillOpen(tab, rev)) return;
      const withText = texts.map((t, i) => (t.trim() ? i : -1)).filter((i) => i >= 0);
      const unread = withText.filter((i) => !read.has(i));
      const noText = count - withText.length;
      const coverage = `Patterns (e-mail addresses, phone numbers, ID numbers) were checked on all ${count} page(s). ${unread.length ? `The AI did not read page(s) ${rangeText(unread)}: those were checked with the patterns only.` : withText.length ? 'The AI read the text of every page.' : ''}${noText ? ` ${noText} page(s) have no text layer (scans or pictures) and were not checked at all: look at them yourself, or run OCR first.` : ''}`;
      if (!found.size) { toast(`Nothing was suggested. ${coverage}`, { ms: 12000 }); return; }
      const list = [...found.keys()];
      const r = await openDialog({ title: 'Suggested Redactions', help: `${coverage} This is a suggestion, not a guarantee that nothing sensitive is left.`, fields: [{ key: 's', label: `${list.length} candidate(s); mark these`, type: 'list', multiple: true, rows: 14, options: list.map((k, i) => ({ value: String(i), label: `${k}${found.get(k)!.size ? ` (p. ${rangeText([...found.get(k)!])})` : ''}` })), value: list.map((_, i) => String(i)) }], ok: 'Mark for Redaction' });
      if (!r?.s?.length || !app.stillOpen(tab, rev)) return;
      const marks = new Map<number, [number, number, number, number][]>();
      for (const i of r.s as string[]) {
        const needle = list[+i];
        for (let pg = 0; pg < count; pg++) {
          if (!texts[pg].includes(needle)) continue;
          const rects = await findRects(tab, pg, needle, { caseSensitive: true });
          if (rects.length) marks.set(pg, [...(marks.get(pg) || []), ...rects]);
        }
      }
      const total = [...marks.values()].reduce((n, x) => n + x.length, 0);
      if (!total) { toast('The strings could not be located on the pages.'); return; }
      if (!app.stillOpen(tab, rev)) return;
      const done = app.editTab(tab, 'Suggest Redactions', (doc) => { for (const [pg, rects] of marks) if (doc.pages[pg]) addRedactMark(doc, doc.pages[pg], rects, { author: `${app.prefs.author} (AI)` }); return true; });
      if (done) toast(`${total} area(s) marked on ${marks.size} page(s). Protect ▸ Apply Redactions removes them.`, { ms: 7000 });
    },
  },
  { id: 'ai.describePage', label: 'Describe Page', icon: 'description', tab: 'AI', group: 'Review', edits: false, tip: 'A description of the page for readers who cannot see it', run: async (app) => { const tab = app.tab; const page = tab.ui.page; const t = (await viewer(tab).pageText(page)).trim(); const a = await ask(app, TASKS.describePage(t || '(the page has no text; it is probably an image or a scan)'), { tier: 'fast', maxTokens: 400 }); if (a != null) await showResult(app, tab, `Page ${page + 1} Description`, cleanText(a), { notePage: page }); } },
  {
    id: 'ai.suggestBookmarks', label: 'Suggest Bookmarks', icon: 'bookmark_add', tab: 'AI', group: 'Review', tip: 'An outline proposed from the first lines of each page',
    run: async (app) => {
      const tab = app.tab;
      const rev = tab.bytes;
      const v = viewer(tab);
      const count = tab.doc.pageCount;
      const lines: string[] = [];
      for (let i = 0; i < Math.min(count, 150); i++) { const t = (await v.pageText(i)).trim().split('\n').filter((l) => l.trim()).slice(0, 4).join(' | '); lines.push(`Page ${i + 1}: ${t.slice(0, 200)}`); }
      if (count > 150) toast(`The document has ${count} pages; the outline is proposed from the first 150.`, { ms: 6000 });
      const a = await ask(app, TASKS.suggestBookmarks(lines.join('\n')), { maxTokens: 2000 });
      if (a == null) return;
      const items = validBookmarks(parseJsonLoose<unknown>(a), count);
      if (!items.length) { toast('The AI answer was not an outline.'); return; }
      const r = await openDialog({ title: 'Suggested Bookmarks', fields: [{ key: 'b', label: 'Keep', type: 'list', multiple: true, rows: 12, options: items.map((x, i) => ({ value: String(i), label: `${'   '.repeat(x.level)}${x.title} (p. ${x.page})` })), value: items.map((_, i) => String(i)) }, { key: 'replace', label: 'Replace the existing bookmarks', type: 'checkbox', value: !readOutlines(tab.doc).length }], ok: 'Add' });
      // Page numbers in the proposal belong to the document as it was read.
      if (!r?.b?.length || !app.stillOpen(tab, rev)) return;
      const kept = (r.b as string[]).map((i) => items[+i]).filter(Boolean);
      const done = app.editTab(tab, 'Suggest Bookmarks', (doc) => { writeOutlines(doc, [...(r.replace ? [] : outlinesToInput(readOutlines(doc))), ...outlineFromSuggestions(kept)]); return true; });
      if (done && app.tab === tab && !app.ui.paneOpen('bookmarks')) app.ui.openPane('bookmarks');
    },
  },

  // More -------------------------------------------------------------------------------------
  {
    id: 'ai.assistant', label: 'AI Assistant', icon: 'chat', tab: 'AI', group: 'More', edits: false, noRecord: true,
    tip: 'A conversation about this document (its text is sent with every question)',
    run: async (app) => {
      const tab = app.tab;
      const log = h('div', { class: 'ql-ai-log', style: 'max-height:45vh;overflow:auto;white-space:pre-wrap;min-width:min(80vw,640px)' });
      const turns: { q: string; a: string }[] = [];
      const ctx = await docText(tab, 16000);
      for (;;) {
        const r = await openDialog({ title: 'AI Assistant', wide: true, content: log, ok: 'Ask', cancel: 'Close', fields: [{ key: 'q', label: 'Your question', type: 'textarea', rows: 3, value: '' }] });
        if (!r || !String(r.q).trim()) return;
        const q = String(r.q).trim();
        // The document text once, then the latest turns that fit; older turns drop out so the request stays bounded.
        const recent: string[] = [];
        let used = 0;
        for (let i = turns.length - 1; i >= 0; i--) { const t = `Q: ${turns[i].q}\nA: ${turns[i].a}`; if (used + t.length > ASSISTANT_HISTORY) break; recent.unshift(t); used += t.length; }
        const prompt = `Document text:\n${fenced(ctx)}\n\n${recent.length ? `Earlier in this conversation:\n${recent.join('\n')}\n\n` : ''}Question: ${q}`;
        const ans = await ask(app, prompt);
        if (ans == null) return;
        turns.push({ q, a: cleanText(ans) });
        log.append(h('p', null, h('b', null, 'You: '), q), h('p', null, h('b', null, 'AI: '), cleanText(ans)));
      }
    },
  },
  {
    id: 'ai.prompts', label: 'Prompt Library', icon: 'library_books', tab: 'AI', group: 'More', kind: 'menu', edits: false,
    tip: 'Run one of your saved prompts on the selection, the page or the document',
    run: async (app, id?: string) => {
      const tab = app.tab;
      const s = aiSettings();
      if (id === '__new') {
        const r = await openDialog({ title: 'New Prompt', fields: [{ key: 'name', label: 'Name', type: 'text', value: '' }, { key: 'prompt', label: 'Prompt (the text is added after it)', type: 'textarea', rows: 5, value: '' }, { key: 'input', label: 'Text to send', type: 'select', options: [{ value: 'selection', label: 'The selection (or the page)' }, { value: 'document', label: 'The whole document' }, { value: 'none', label: 'Nothing' }], value: 'selection' }] });
        if (!r?.name || !r.prompt) return;
        saveAiSettings((x) => { x.prompts.push({ id: `pr${Date.now().toString(36)}`, name: r.name, prompt: r.prompt, input: r.input, output: 'pane' } as any); });
        return;
      }
      const p = s.prompts.find((x) => x.id === id);
      if (!p) return;
      const input = p.input === 'none' ? '' : p.input === 'document' ? await docText(tab) : selectedText(tab).trim() || (await viewer(tab).pageText(tab.ui.page));
      const ans = await ask(app, input ? `${p.prompt}\n${fenced(input)}` : p.prompt);
      if (ans != null) await showResult(app, tab, p.name, cleanText(ans));
    },
    menu: () => [...aiSettings().prompts.map((p) => ({ id: 'ai.prompts', arg: p.id, label: p.name })), ...(aiSettings().prompts.length ? [{ separator: true }] : []), { id: 'ai.prompts', arg: '__new', label: 'New Prompt…' }],
  },
]);

/** Page indexes as a compact 1-based list ("1-3, 7"). */
function rangeText(pages: number[]): string {
  const p = [...new Set(pages)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < p.length; i++) { let j = i; while (j + 1 < p.length && p[j + 1] === p[j] + 1) j++; out.push(j > i ? `${p[i] + 1}-${p[j] + 1}` : String(p[i] + 1)); i = j; }
  return out.join(', ');
}
