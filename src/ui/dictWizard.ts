/**
 * Spelling Dictionaries wizard: find, download, use and remove free Hunspell dictionaries for any
 * language (see proof/dictionaries.ts for sources and verification). The chosen language is the
 * spelling language (prefs.language) that Review ▸ Spelling checks comments and form fields with.
 */
import { h, clear } from './dom';
import { openDialog, toast, confirmDialog } from './dialog';
import type { App } from '../app';
import { CATALOG, installedDictionaries, installDictionary, removeDictionary, isHeavy, dictionaryFor, dictionaryUpdateAvailable, type DictInfo } from '../proof/dictionaries';
import { unloadDictionary, isEnglish } from '../proof/proofing';

const mb = (d: DictInfo) => ((d.aff.size + d.dic.size) / 1e6).toFixed(1) + ' MB';

/** Languages the user probably wants: the device's, and the current spelling language. */
function suggested(app: App): DictInfo[] {
  const tags = new Set<string>();
  for (const t of navigator.languages || [navigator.language]) if (t) tags.add(t);
  if (app.prefs.language) tags.add(app.prefs.language);
  const all = new Set(CATALOG.map((d) => d.id));
  const ids = new Set<string>();
  for (const t of tags) { const id = dictionaryFor(t, all); if (id) ids.add(id); }
  return CATALOG.filter((d) => ids.has(d.id));
}

function useLanguage(app: App, d: DictInfo): void {
  app.prefs.language = d.tag;
  app.savePrefs();
  toast(`Spelling language: ${d.name}`);
}

export async function openDictionaryWizard(app: App): Promise<void> {
  let installed = await installedDictionaries();
  const root = h('div', { class: 'ql-dict-wizard' });
  const search = h('input', { type: 'search', class: 'ql-input', placeholder: 'Search 90+ languages (name or code)…', 'aria-label': 'Search languages' }) as HTMLInputElement;
  const current = h('p', { class: 'ql-dict-current' });
  const list = h('div', { class: 'ql-dict-list', role: 'list' });
  const busy = new Map<string, AbortController>();

  const showCurrent = () => {
    const lang = app.prefs.language || 'en-US';
    const d = CATALOG.find((x) => x.tag.toLowerCase() === lang.toLowerCase()) || CATALOG.find((x) => x.id === dictionaryFor(lang, new Set(CATALOG.map((c) => c.id))));
    const ok = isEnglish(lang) || !!dictionaryFor(lang, installed);
    current.textContent = `Spelling language for comments and form fields: ${d ? d.name : lang}${ok ? '' : ' — download its dictionary below to check spelling'}`;
  };

  const useButton = (d: DictInfo) => h('button', { class: 'ql-btn', onclick: () => { useLanguage(app, d); showCurrent(); draw(); } }, (app.prefs.language || '').toLowerCase() === d.tag.toLowerCase() ? '✓ In use' : 'Use for spelling');

  const row = (d: DictInfo) => {
    const status = d.bundled ? 'Built in' : installed.has(d.id) ? 'Installed' : '';
    const info = h('div', { class: 'ql-dict-info' },
      h('div', { class: 'ql-dict-name' }, d.name, d.native ? h('span', { class: 'ql-dict-native' }, ` · ${d.native}`) : null, h('code', null, ` ${d.tag}`)),
      h('div', { class: 'ql-help' }, `${mb(d)} · ${d.license} · version ${d.version}`, isHeavy(d) ? h('span', { class: 'ql-warn-inline' }, ` · large: about ${d.memoryMB || '?'} MB of memory, ${Math.ceil((d.loadSec || 1) * 3)} s to start on a phone`) : null));
    const actions = h('div', { class: 'ql-dict-actions' });
    const progress = h('progress', { max: 1, value: 0, hidden: true }) as HTMLProgressElement;
    // Download (or, for an installed dictionary whose catalog version changed, download again). A second press cancels.
    const fetchIt = async (btn: HTMLButtonElement, done: string) => {
      if (busy.has(d.id)) { busy.get(d.id)!.abort(); return; }
      if (isHeavy(d) && !(await confirmDialog('Large dictionary', `${d.name} is a large dictionary (${mb(d)}, about ${d.memoryMB || '?'} MB of memory when loaded). Checking may start slowly, and older phones may not have enough memory. Download it anyway?`, 'Download'))) return;
      const ctl = new AbortController();
      busy.set(d.id, ctl);
      btn.textContent = 'Cancel';
      progress.hidden = false;
      try {
        await installDictionary(d.id, (p) => { progress.max = p.total || 1; progress.value = p.loaded; btn.title = p.phase; }, ctl.signal);
        await unloadDictionary(d.id); // the next check loads the new files
        installed = await installedDictionaries();
        toast(`${d.name} dictionary ${done}`, { action: 'Use for spelling', onAction: () => { useLanguage(app, d); showCurrent(); draw(); } });
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') toast(`Could not install ${d.name}: ${(err as Error)?.message || err}`, { ms: 8000 });
      } finally {
        busy.delete(d.id);
        showCurrent();
        draw();
      }
    };
    if (d.bundled) actions.append(h('span', { class: 'ql-badge' }, status), useButton(d));
    else if (installed.has(d.id)) {
      const update = h('button', { class: 'ql-btn', title: `Version ${d.version} is available`, style: 'display:none', onclick: (e: Event) => void fetchIt(e.currentTarget as HTMLButtonElement, `updated to version ${d.version}`) }, 'Update') as HTMLButtonElement;
      void dictionaryUpdateAvailable(d.id).then((yes) => { update.style.display = yes ? '' : 'none'; }).catch(() => undefined);
      actions.append(progress, h('span', { class: 'ql-badge' }, status), useButton(d), update, h('button', {
        class: 'ql-btn', onclick: async () => {
          if (!(await confirmDialog('Remove dictionary', `Remove the ${d.name} dictionary from this device? You can download it again later.`, 'Remove'))) return;
          try { await removeDictionary(d.id); }
          catch (err) { toast(`The ${d.name} dictionary could not be removed: ${(err as Error)?.message || err}`, { ms: 8000 }); return; }
          await unloadDictionary(d.id);
          installed = await installedDictionaries();
          showCurrent();
          draw();
        },
      }, 'Remove'));
    } else {
      actions.append(progress, h('button', { class: 'ql-btn ql-primary', onclick: (e: Event) => void fetchIt(e.currentTarget as HTMLButtonElement, 'installed') }, 'Download'));
    }
    return h('div', { class: 'ql-dict-row', role: 'listitem' }, info, actions);
  };

  const draw = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const match = (d: DictInfo) => !q || d.name.toLowerCase().includes(q) || (d.native || '').toLowerCase().includes(q) || d.tag.toLowerCase().startsWith(q) || d.id.startsWith(q);
    const sug = q ? [] : suggested(app);
    const mine = CATALOG.filter((d) => installed.has(d.id) && !sug.includes(d));
    const sections: [string, DictInfo[]][] = q
      ? [['Results', CATALOG.filter(match)]]
      : [['Suggested for you', sug], ['Installed', mine], ['All languages', CATALOG.filter((d) => !sug.includes(d) && !installed.has(d.id))]];
    for (const [title, items] of sections) {
      if (!items.length) continue;
      list.append(h('h3', { class: 'ql-dict-head' }, title), ...items.map(row));
    }
    if (!list.childElementCount) list.append(h('p', { class: 'ql-help' }, 'No dictionary matches. Try the English name of the language or its code (for example "de" or "pt-PT").'));
  };
  search.addEventListener('input', draw);

  root.append(
    h('p', { class: 'ql-help' }, 'Download free spelling dictionaries for the languages you write in, then choose "Use for spelling". Review ▸ Spelling (F7) checks the text of comments and form fields with that language. English (United States, United Kingdom, Canada, Australia) is built in. Dictionaries are stored on this device and work offline.'),
    current, search, list,
    h('p', { class: 'ql-help ql-small' }, 'Source: the wooorm/dictionaries project (Hunspell dictionaries from LibreOffice, Mozilla and the language communities), downloaded from cdn.jsdelivr.net or the npm registry. Every file is checked against a published checksum before it is used. Each dictionary keeps its own license, shown in the list.'),
  );
  showCurrent();
  draw();
  await openDialog({ title: 'Spelling Dictionaries', content: root, wide: true, ok: 'Done', cancel: false });
  for (const c of busy.values()) c.abort();
}
