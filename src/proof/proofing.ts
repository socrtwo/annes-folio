/**
 * Spelling for the text Anne's Folio can change: comment contents and form field values.
 *
 * Text being edited is checked as you type by the platform's spell checker (a dialog is
 * contenteditable); Review ▸ Spelling (F7) walks every annotation and form field. Words are checked in a
 * background worker (spell.worker.ts: nspell with the SCOWL English dictionaries, or Hunspell for a
 * downloaded dictionary of another language, see dictionaries.ts).
 *
 * The walk itself (SpellSession) is independent of the worker and the UI: it takes any
 * SpellChecker and reads and writes paragraph text through a callback, so it can be tested directly.
 */
import { installedDictionaries, dictionaryFor, loadDictionary } from './dictionaries';

// --------------------------------------------------------------------------------------------
// Worker protocol (same messages as Anne's Pen's proofing engine)

let worker: Worker | null = null;
let workerFailures = 0;
let reqId = 0;
const pending = new Map<number, (v: any) => void>();
/** The answer to every request a failed (or missing) worker leaves unanswered. */
const FAILED = { bad: [], suggestions: [], failed: true };
/** Downloaded dictionaries already sent to the current worker. */
const inWorker = new Set<string>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (workerFailures >= 3 || typeof Worker === 'undefined') return null;
  try {
    const w = new Worker(new URL('./spell.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { const cb = pending.get(e.data.id); if (cb) { pending.delete(e.data.id); cb(e.data); } };
    w.onerror = () => {
      // A crashed worker never answers: settle every waiting request so the walk finishes.
      workerFailures++;
      if (worker === w) { worker = null; inWorker.clear(); }
      try { w.terminate(); } catch { /* */ }
      for (const cb of pending.values()) cb(FAILED);
      pending.clear();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

function call(msg: Record<string, any>): Promise<any> {
  const w = getWorker();
  if (!w) return Promise.resolve(FAILED);
  const id = ++reqId;
  return new Promise((res) => { pending.set(id, res); w.postMessage({ ...msg, id }); });
}

/** Send a downloaded dictionary to the worker once. Returns false if it is not available. */
async function ensureLoaded(id: string): Promise<boolean> {
  if (inWorker.has(id) && worker) return true;
  const d = await loadDictionary(id);
  if (!d) return false;
  if (!(d.aff instanceof Uint8Array) || !(d.dic instanceof Uint8Array)) return false;
  const r = await call({ type: 'load', dialect: 'dict:' + id, aff: d.aff, dic: d.dic });
  // Only an explicit acknowledgement counts: any other answer means the worker did not load it.
  if (r.failed || r.error || !r.ok) return false;
  inWorker.add(id);
  return true;
}

/** Forget a dictionary in the worker (after it is removed). */
export async function unloadDictionary(id: string): Promise<void> {
  inWorker.delete(id);
  if (worker) await call({ type: 'unload', dialect: 'dict:' + id });
}

// --------------------------------------------------------------------------------------------
// Dialects and languages

export type SpellDialect = 'any' | 'document' | 'en-US' | 'en-GB' | 'en-CA' | 'en-AU';

export const SPELL_DIALECTS: { value: SpellDialect; label: string }[] = [
  { value: 'any', label: 'English — all varieties (accept any standard spelling)' },
  { value: 'document', label: 'English — follow the document language' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom, including Oxford -ize spelling)' },
  { value: 'en-CA', label: 'English (Canada)' },
  { value: 'en-AU', label: 'English (Australia)' },
];

/** The English dictionary set for a preference and a language tag (BCP 47). */
export function dialectFor(pref: SpellDialect | undefined, lang: string | undefined): 'any' | 'en-US' | 'en-GB' | 'en-CA' | 'en-AU' {
  if (pref && pref !== 'document') return pref;
  const l = (lang || '').toLowerCase().replace(/_/g, '-').replace(/^en-[a-z]{4}(?=-|$)/, 'en');
  if (!l || !isEnglish(l)) return 'any';
  if (/^en-(us|as|gu|mp|pr|um|vi|ph)\b/.test(l)) return 'en-US';
  if (/^en-ca\b/.test(l)) return 'en-CA';
  if (/^en-(au|nz)\b/.test(l)) return 'en-AU';
  if (l === 'en') return 'any';
  return 'en-GB';
}

/** True for an English language tag ("en", "en-GB", "en-IN"...) or no tag. */
export function isEnglish(lang: string | null | undefined): boolean {
  return !lang || /^en([-_]|$)/i.test(lang);
}

/**
 * The dictionary key the worker checks words with for a document language: an English variety,
 * 'dict:<id>' for a downloaded dictionary, or null when no dictionary covers the language.
 */
export async function dictionaryKey(lang: string | undefined, pref: SpellDialect | undefined): Promise<string | null> {
  if (isEnglish(lang) && !/^en[-_]za\b/i.test(lang || '')) return dialectFor(pref, lang);
  const installed = await installedDictionaries();
  const id = dictionaryFor(lang, installed);
  if (id) return 'dict:' + id;
  return isEnglish(lang) ? dialectFor(pref, lang) : null;
}

// --------------------------------------------------------------------------------------------
// Checkers

export interface SpellChecker {
  /** The words (of those given) that are not in the dictionary. */
  check(words: string[], dict: string): Promise<Set<string>>;
  suggest(word: string, dict: string): Promise<string[]>;
  add?(word: string): Promise<void>;
}

/** The background worker checker. */
export const workerChecker: SpellChecker = {
  async check(words, dict) {
    if (dict.startsWith('dict:') && !(await ensureLoaded(dict.slice(5)))) throw new Error('The dictionary for this language could not be loaded.');
    const out = new Set<string>();
    for (let i = 0; i < words.length; i += 2000) {
      const r = await call({ type: 'check', words: words.slice(i, i + 2000), dialect: dict });
      if (r.failed) throw new Error('The spelling checker could not start on this device.');
      if (r.error) throw new Error(r.error);
      for (const w of r.bad || []) out.add(w);
    }
    return out;
  },
  async suggest(word, dict) { return (await call({ type: 'suggest', word, dialect: dict })).suggestions || []; },
  async add(word) { await call({ type: 'add', word }); },
};

export async function suggest(word: string, dialect?: string): Promise<string[]> { return workerChecker.suggest(word, dialect || 'any'); }
export async function addWord(word: string): Promise<void> { await workerChecker.add!(word); }

// --------------------------------------------------------------------------------------------
// Words in text

// Inside a word: apostrophes, the Catalan middle dot (col·legi), zero-width (non-)joiners (Persian, Indic scripts)
// and soft hyphens, which mark a possible line break and are not part of the spelling.
const WORD_RE = /[\p{L}][\p{L}\p{M}'’·‌‍­]*[\p{L}\p{M}]|[\p{L}]/gu;
// Every repetition is bounded so that one very long unbroken token costs linear, not quadratic, time.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|[^\s@]{1,64}@[^\s@]{1,255}\.\w+|\b[\w-]{1,253}(?:\.[\w-]{1,253})+\/\S*/gi;

export interface SpellOptions {
  ignoreUpper: boolean;
  ignoreDigits: boolean;
  ignoreUrls: boolean;
}
export const DEFAULT_SPELL_OPTIONS: SpellOptions = { ignoreUpper: true, ignoreDigits: true, ignoreUrls: true };

export interface WordAt { word: string; start: number; end: number }

/** The checkable words of a text (offsets into the text). */
export function wordsIn(text: string, opts: SpellOptions = DEFAULT_SPELL_OPTIONS): WordAt[] {
  const skip: [number, number][] = [];
  if (opts.ignoreUrls) { URL_RE.lastIndex = 0; let u: RegExpExecArray | null; while ((u = URL_RE.exec(text))) skip.push([u.index, u.index + u[0].length]); }
  const out: WordAt[] = [];
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) {
    const start = m.index, end = start + m[0].length;
    if (skip.some(([a, b]) => start >= a && start < b)) continue;
    // Words glued to digits ("A4", "2nd", "Q3x") are codes, not words.
    const before = text[start - 1] || '', after = text[end] || '';
    if (opts.ignoreDigits && (/\d/.test(before) || /\d/.test(after))) continue;
    // Offsets stay those of the text; the word handed to the dictionary has no soft hyphens.
    let w = m[0].replace(/’/g, "'").replace(/­/g, '');
    let s = start, e = end;
    if (/'s$/i.test(w)) { w = w.slice(0, -2); e -= 2; }
    while (w.startsWith("'")) { w = w.slice(1); s++; }
    while (w.endsWith("'")) { w = w.slice(0, -1); e--; }
    if (w.length < 2) continue;
    if (opts.ignoreUpper && /^[\p{Lu}]{2,}$/u.test(w)) continue;
    out.push({ word: w, start: s, end: e });
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// Text to check

// --------------------------------------------------------------------------------------------
// Text to check

/** One piece of editable text: an annotation's contents, a reply, or a form field's value. */
export interface SpellTarget { kind: 'annotation' | 'field'; page: number; /** Object number of the annotation or field. */ num: number; label: string; text: string }

/** The spell-checkable texts of a document: annotation contents (notes, text boxes, replies) and text field values. */
export function spellTargets(annots: { ref: { num: number } | null; page: number; subtype: string; contents: string; author: string }[], fields: { ref: { num: number }; name: string; type: string; value: unknown }[], opts: { fromPage?: number } = {}): SpellTarget[] {
  const out: SpellTarget[] = [];
  for (const a of annots) if (a.ref && a.subtype !== 'Widget' && a.subtype !== 'Link' && a.subtype !== 'Popup' && /\p{L}/u.test(a.contents)) out.push({ kind: 'annotation', page: a.page, num: a.ref.num, label: `${a.subtype} by ${a.author || 'unknown'} on page ${a.page + 1}`, text: a.contents });
  for (const f of fields) if ((f.type === 'text' || f.type === 'combo') && typeof f.value === 'string' && /\p{L}/u.test(f.value)) out.push({ kind: 'field', page: -1, num: f.ref.num, label: `Field "${f.name}"`, text: f.value });
  if (opts.fromPage) { const i = out.findIndex((t) => t.page >= opts.fromPage!); if (i > 0) return [...out.slice(i), ...out.slice(0, i)]; }
  return out;
}

export function replaceInText(text: string, start: number, end: number, rep: string): string { return text.slice(0, start) + rep + text.slice(end); }

// --------------------------------------------------------------------------------------------
// The spelling walk

export interface SpellIssue { target: SpellTarget; word: string; start: number; end: number; text: string }

export interface SpellSessionOptions {
  dict: string;
  /** Words the user ignores (lowercase). Shared with preferences: Ignore All adds to it. */
  ignored: Set<string>;
  /** Personal dictionary (lowercase). Add to Dictionary adds to it. */
  dictionary: Set<string>;
  options?: SpellOptions;
  /** Writes the new full text of a target back into the document; returns false when it cannot be changed. */
  write: (t: SpellTarget, text: string) => boolean;
}

/**
 * Walks the targets one misspelling at a time. next() finds the next issue (applying Change All
 * replacements on the way); the action methods resolve the current issue and move on.
 */
export class SpellSession {
  private i = 0;
  private pos = 0;
  private bad = new Set<string>();
  private known = new Set<string>();
  private changeAllMap = new Map<string, string>();
  current: SpellIssue | null = null;
  changed = 0;

  constructor(public targets: SpellTarget[], private checker: SpellChecker, private o: SpellSessionOptions) {}

  private async prime(words: string[]): Promise<void> {
    const fresh = [...new Set(words.filter((w) => !this.known.has(w)))];
    if (!fresh.length) return;
    const bad = await this.checker.check(fresh, this.o.dict);
    for (const w of fresh) { this.known.add(w); if (bad.has(w)) this.bad.add(w); }
  }

  /** Checks every word of the remaining targets in one batch. */
  async start(): Promise<void> {
    const words: string[] = [];
    for (const t of this.targets) for (const w of wordsIn(t.text, this.o.options)) words.push(w.word);
    await this.prime(words);
  }

  private skip(w: string): boolean { const l = w.toLowerCase(); return this.o.ignored.has(l) || this.o.dictionary.has(l); }

  async next(): Promise<SpellIssue | null> {
    while (this.i < this.targets.length) {
      const t = this.targets[this.i];
      const words = wordsIn(t.text, this.o.options).filter((w) => w.start >= this.pos);
      await this.prime(words.map((w) => w.word));
      let restart = false;
      for (const w of words) {
        if (!this.bad.has(w.word) || this.skip(w.word)) continue;
        const auto = this.changeAllMap.get(w.word);
        if (auto != null) {
          if (this.apply(t, w.start, w.end, auto)) { this.pos = w.start + auto.length; restart = true; break; }
          continue;
        }
        this.current = { target: t, word: w.word, start: w.start, end: w.end, text: t.text };
        return this.current;
      }
      if (restart) continue;
      this.i++;
      this.pos = 0;
    }
    this.current = null;
    return null;
  }

  private apply(t: SpellTarget, start: number, end: number, rep: string): boolean {
    const text = replaceInText(t.text, start, end, rep);
    const ok = this.o.write(t, text);
    if (ok) { t.text = text; this.changed++; }
    return ok;
  }

  ignoreOnce(): void { if (this.current) this.pos = this.current.end; }
  ignoreAll(): void { if (this.current) { this.o.ignored.add(this.current.word.toLowerCase()); this.pos = this.current.end; } }
  async addToDictionary(): Promise<void> {
    if (!this.current) return;
    this.o.dictionary.add(this.current.word.toLowerCase());
    await this.checker.add?.(this.current.word);
    this.pos = this.current.end;
  }
  change(rep: string): boolean {
    const c = this.current;
    if (!c) return false;
    if (!this.apply(c.target, c.start, c.end, rep)) { this.pos = c.end; return false; }
    this.pos = c.start + rep.length;
    return true;
  }
  changeAll(rep: string): boolean {
    if (!this.current) return false;
    this.changeAllMap.set(this.current.word, rep);
    return this.change(rep);
  }
  /** Replaces the whole current text (after an edit typed into the Not in Dictionary box). */
  replaceTargetText(text: string): boolean {
    const c = this.current;
    if (!c) return false;
    const ok = this.o.write(c.target, text);
    if (ok) { c.target.text = text; this.changed++; }
    this.pos = 0;
    return ok;
  }
}
