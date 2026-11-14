/// <reference lib="webworker" />
/**
 * Spelling worker: Hunspell-compatible checking with nspell and the SCOWL English dictionaries.
 *
 * Dialects:
 *   any    - English in all its major varieties: a word is accepted when the American or the
 *            British dictionary accepts it (together they also cover Canadian and Australian
 *            spelling), so no writer's own spelling is marked wrong. The default.
 *   en-US  - American
 *   en-GB  - British; also accepts Oxford -ize spellings (organize, realization)
 *   en-CA  - Canadian
 *   en-AU  - Australian
 * Each 'check' and 'suggest' message names its dialect ('any' when it names none), so text marked
 * with its own variety is checked against that variety. Dictionaries load on demand, so only the
 * varieties in use take memory (about 9-12 MB each).
 *
 * Downloaded dictionaries (any language, see dictionaries.ts) arrive with a 'load' message as
 * 'dict:<id>' and are checked under that key by Hunspell itself (compiled to WebAssembly,
 * hunspell-asm), which handles every language's affix and compound rules quickly; nspell, a
 * JavaScript reimplementation, cannot load some of them (Catalan, for one).
 */
import nspell from 'nspell';

export type Dialect = 'any' | 'en-US' | 'en-GB' | 'en-CA' | 'en-AU' | `dict:${string}`;
/** What the worker needs from a dictionary: nspell objects, or the Hunspell adapter below. */
interface Speller { correct(w: string): boolean; suggest(w: string): string[]; add(w: string): unknown; remove(w: string): unknown; dispose?(): void }

let hunspellFactory: Promise<import('hunspell-asm').HunspellFactory> | null = null;
async function hunspell(id: string, aff: Uint8Array, dic: Uint8Array): Promise<Speller> {
  // The CommonJS build: the package's ES module build calls a namespace import of nanoid as a function.
  if (!hunspellFactory) hunspellFactory = import('hunspell-asm/dist/cjs/index.js').then((m) => ((m as any).default?.loadModule ? (m as any).default : m).loadModule());
  const f = await hunspellFactory;
  const a = f.mountBuffer(aff, `${id}.aff`);
  const d = f.mountBuffer(dic, `${id}.dic`);
  const h = f.create(a, d);
  f.unmount(a);
  f.unmount(d);
  return { correct: (w) => h.spell(w), suggest: (w) => h.suggest(w), add: (w) => h.addWord(w), remove: (w) => h.removeWord(w), dispose: () => h.dispose() };
}
type Single = 'en-US' | 'en-GB' | 'en-CA' | 'en-AU';

const loaders: Record<Single, () => Promise<[string, string]>> = {
  'en-US': async () => [(await import('../../node_modules/dictionary-en/index.aff?raw')).default, (await import('../../node_modules/dictionary-en/index.dic?raw')).default],
  'en-GB': async () => [(await import('../../node_modules/dictionary-en-gb/index.aff?raw')).default, (await import('../../node_modules/dictionary-en-gb/index.dic?raw')).default],
  'en-CA': async () => [(await import('../../node_modules/dictionary-en-ca/index.aff?raw')).default, (await import('../../node_modules/dictionary-en-ca/index.dic?raw')).default],
  'en-AU': async () => [(await import('../../node_modules/dictionary-en-au/index.aff?raw')).default, (await import('../../node_modules/dictionary-en-au/index.dic?raw')).default],
};

const DIALECTS = new Set<string>(['any', 'en-US', 'en-GB', 'en-CA', 'en-AU']);
const loaded = new Map<string, Promise<Speller>>();
const personal = new Set<string>();

function speller(d: Single): Promise<Speller> {
  let p = loaded.get(d);
  if (!p) {
    p = loaders[d]().then(([aff, dic]) => {
      const sp = nspell(aff, dic);
      for (const w of personal) sp.add(w);
      return sp;
    });
    // A failed load is retried next time instead of failing forever.
    p.catch(() => loaded.delete(d));
    loaded.set(d, p);
  }
  return p;
}

/** Results per dialect: word -> correct. */
const cache = new Map<Dialect, Map<string, boolean>>();

/** Dictionaries consulted for a dialect (the first one gives suggestions first). */
function spellers(d: Dialect): Promise<Speller[]> {
  if (d.startsWith('dict:')) {
    const p = loaded.get(d);
    return p ? Promise.all([p]) : Promise.reject(new Error(`${d} is not loaded`));
  }
  if (d === 'any') return Promise.all([speller('en-US'), speller('en-GB')]);
  if (d === 'en-GB') return Promise.all([speller('en-GB'), speller('en-US')]);
  return Promise.all([speller(d as Single)]);
}

const OXFORD = /iz(e|ed|es|ing|ation|ations|er|ers|able)$/i;

async function correct(d: Dialect, w: string): Promise<boolean> {
  const sps = await spellers(d);
  if (d === 'en-GB') {
    // British dictionary, plus Oxford spelling: -ize forms the American dictionary confirms.
    return sps[0].correct(w) || (OXFORD.test(w) && sps[1].correct(w));
  }
  return sps.some((s) => s.correct(w));
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { id: number; type: 'check' | 'suggest' | 'add' | 'remove' | 'load' | 'unload'; words?: string[]; word?: string; dialect?: string; aff?: Uint8Array; dic?: Uint8Array };
  const reply = (v: Record<string, unknown>) => (self as any).postMessage({ id: msg.id, ...v });
  try {
    const d: Dialect = msg.dialect && (DIALECTS.has(msg.dialect) || msg.dialect.startsWith('dict:')) ? (msg.dialect as Dialect) : 'any';
    // Frees the Hunspell instance (WebAssembly memory) a downloaded dictionary held.
    const drop = async (key: string) => { const old = loaded.get(key); loaded.delete(key); cache.delete(key as Dialect); try { (await old)?.dispose?.(); } catch { /* already gone */ } };
    if (msg.type === 'load') {
      if (!d.startsWith('dict:') || !(msg.aff instanceof Uint8Array) || !(msg.dic instanceof Uint8Array)) throw new Error('The dictionary files are missing or damaged.');
      const sp = await hunspell(d.slice(5), msg.aff, msg.dic);
      for (const w of personal) sp.add(w);
      await drop(d);
      loaded.set(d, Promise.resolve(sp));
      reply({ ok: true });
      return;
    }
    if (msg.type === 'unload') {
      if (d.startsWith('dict:')) await drop(d);
      reply({ ok: true });
      return;
    }
    // Anything but a complete request of a known kind is an error, never an empty "all words are fine".
    if (msg.type === 'check' ? !Array.isArray(msg.words) : !(['add', 'remove', 'suggest'].includes(msg.type) && typeof msg.word === 'string' && msg.word)) throw new Error(`Bad spelling request (${String(msg.type)}).`);
    if (msg.type === 'add' && msg.word) {
      personal.add(msg.word);
      for (const p of loaded.values()) (await p).add(msg.word);
      for (const c of cache.values()) c.set(msg.word, true);
      reply({ ok: true });
      return;
    }
    if (msg.type === 'remove' && msg.word) {
      personal.delete(msg.word);
      for (const p of loaded.values()) (await p).remove(msg.word);
      for (const c of cache.values()) c.delete(msg.word);
      reply({ ok: true });
      return;
    }
    if (msg.type === 'suggest' && msg.word) {
      const out: string[] = [];
      for (const sp of await spellers(d)) for (const s of sp.suggest(msg.word)) if (!out.includes(s)) out.push(s);
      reply({ suggestions: out.slice(0, 8) });
      return;
    }
    let c = cache.get(d);
    if (!c) cache.set(d, (c = new Map()));
    const bad: string[] = [];
    for (const w of msg.words || []) {
      let ok = c.get(w);
      if (ok === undefined) { ok = await correct(d, w); c.set(w, ok); }
      if (!ok) bad.push(w);
    }
    reply({ bad });
  } catch (err) {
    reply({ bad: [], suggestions: [], error: String((err as Error)?.message || err) });
  }
};
