/** Developer tab: macros (recorded command lists), macro editor, scripts report, structure export, tags, raw objects. */
import { def } from './registry';
import type { App } from '../app';
import type { Macro } from '../prefs';
import { getCommand } from './registry';
import { openDialog, toast, confirmDialog, promptDialog } from '../ui/dialog';
import { h } from '../ui/dom';
import { Dict, PdfStream, Ref, Name, PdfString, nameText, type PdfObj } from '../pdf/objects';
import { serialize } from '../pdf/writer';
import { saveBytes, baseName } from './util';

/** How many macros may run inside each other. */
const MACRO_DEPTH = 8;

/**
 * Runs a macro's steps in order and stops at the first step that fails or is refused. A macro that would
 * start itself again (directly, through another macro, or through its macro: button id) is not started.
 * `stack` holds the macros already running. True when every step ran.
 */
export async function runMacro(app: App, name: string, stack: string[] = []): Promise<boolean> {
  const m = app.prefs.macros.find((x) => x.name === name);
  if (!m) { toast(`No macro named "${name}".`); return false; }
  if (stack.includes(name) || stack.length >= MACRO_DEPTH) {
    toast(`Macro "${name}" was not run: ${stack.includes(name) ? 'it would start itself again' : 'too many macros run inside each other'} (${[...stack, name].join(' → ')}).`, { ms: 7000 });
    return false;
  }
  for (const [i, s] of m.steps.entries()) {
    const inner = s.id === 'dev.runMacro' && typeof s.arg === 'string' ? s.arg : s.id.startsWith('macro:') ? s.id.slice(6) : null;
    if (inner !== null) { if (!(await runMacro(app, inner, [...stack, name]))) return false; continue; }
    const c = getCommand(s.id);
    if (!c) { toast(`Macro "${name}" stopped: the command ${s.id} no longer exists.`); return false; }
    let r = app.exec(s.id, s.arg);
    // exec has already reported a failure; here it only ends the macro.
    if (r instanceof Promise) { try { r = await r; } catch { r = false; } }
    if (r === false) { toast(`Macro "${name}" stopped at step ${i + 1} (${c.label}); the remaining steps were not run.`, { ms: 6000 }); return false; }
  }
  return true;
}

/** One macro step per line: a command id, then an optional JSON argument (kept exactly as typed). "#" starts a comment line. */
export function parseMacroSteps(text: string): { steps: { id: string; arg?: any }[]; error: string | null } {
  const steps: { id: string; arg?: any }[] = [];
  for (const [i, line] of String(text).split('\n').entries()) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(\S+)\s*([\s\S]*)$/.exec(t)!;
    if (!getCommand(m[1])) return { steps, error: `Line ${i + 1}: unknown command "${m[1]}".` };
    if (!m[2]) { steps.push({ id: m[1] }); continue; }
    try { steps.push({ id: m[1], arg: JSON.parse(m[2]) }); } catch { return { steps, error: `Line ${i + 1}: the argument is not valid JSON.` }; }
  }
  return { steps, error: null };
}

/** Points everything that names a macro (bar, shortcuts, custom tabs) at its new name, or removes it (next = null). */
export function retargetMacro(app: App, old: string, next: string | null): void {
  const from = `macro:${old}`, to = next === null ? null : `macro:${next}`;
  const swap = (ids: string[]): string[] => ids.flatMap((id) => (id !== from ? [id] : to ? [to] : []));
  const p = app.prefs;
  p.qat = swap(p.qat);
  p.pinnedCommands = swap(p.pinnedCommands);
  p.keymap = Object.fromEntries(Object.entries(p.keymap).flatMap(([k, id]) => (id !== from ? [[k, id]] : to ? [[k, to]] : [])));
  p.customTabs = p.customTabs.map((t) => ({ ...t, groups: t.groups.map((g) => ({ ...g, items: swap(g.items) })) }));
}

function stepsLabel(m: Macro): string {
  return m.steps.map((s) => getCommand(s.id)?.label || s.id).slice(0, 6).join(' → ') + (m.steps.length > 6 ? ' …' : '');
}

/** A JSON-friendly dump of an object graph (depth-limited; streams as summaries). */
export function toJsonish(doc: App['doc'], o: PdfObj, depth: number, seen = new Set<number>()): unknown {
  if (o instanceof Ref) { if (depth <= 0 || seen.has(o.num)) return `${o.num} ${o.gen} R`; seen.add(o.num); return { $ref: `${o.num} ${o.gen} R`, value: toJsonish(doc, doc.fetch(o), depth - 1, seen) }; }
  if (o instanceof Name) return `/${nameText(o.name)}`;
  if (o instanceof PdfString) return o.toText();
  if (o instanceof PdfStream) return { $stream: o.raw.length, dict: toJsonish(doc, o.dict, depth, seen) };
  if (o instanceof Dict) { const out: Record<string, unknown> = {}; for (const k of o.keys()) out[k] = depth > 0 ? toJsonish(doc, o.get(k)!, depth - 1, seen) : String(o.get(k)); return out; }
  if (Array.isArray(o)) return depth > 0 ? o.map((x) => toJsonish(doc, x, depth - 1, seen)) : `[${o.length}]`;
  return o as unknown;
}

/** Counts and lists the script/action entries Anne's Folio never runs. */
function scriptsReport(app: App): { text: string; count: number }[] {
  const doc = app.doc;
  const out: { text: string; count: number }[] = [];
  const names = doc.getDict(doc.catalog, 'Names');
  const js = names ? doc.getDict(names, 'JavaScript') : null;
  if (js) out.push({ text: 'Document-level JavaScript (Names ▸ JavaScript tree)', count: 1 });
  if (doc.catalog.has('OpenAction')) out.push({ text: `Open action: ${doc.getName(doc.getDict(doc.catalog, 'OpenAction'), 'S') || 'destination'}`, count: 1 });
  if (doc.catalog.has('AA')) out.push({ text: 'Document additional actions (AA)', count: 1 });
  let pageAA = 0, annotActs = 0, fieldActs = 0;
  for (const p of doc.pages) { if (p.dict.has('AA')) pageAA++; for (const a of doc.getArray(p.dict, 'Annots') || []) { const d = doc.resolve(a); if (d instanceof Dict) { if (d.has('AA')) annotActs++; const act = doc.getDict(d, 'A'); if (act && doc.getName(act, 'S') === 'JavaScript') annotActs++; } } }
  const af = doc.getDict(doc.catalog, 'AcroForm');
  for (const f of doc.getArray(af, 'Fields') || []) { const d = doc.resolve(f); if (d instanceof Dict && d.has('AA')) fieldActs++; }
  if (pageAA) out.push({ text: 'Pages with open/close actions', count: pageAA });
  if (annotActs) out.push({ text: 'Annotations with JavaScript or event actions', count: annotActs });
  if (fieldActs) out.push({ text: 'Form fields with calculate/format/validate scripts', count: fieldActs });
  if (af?.has('XFA')) out.push({ text: 'XFA form (XML forms architecture)', count: 1 });
  return out;
}

def([
  {
    id: 'dev.macros', label: 'Macros', icon: 'smart_button', tab: 'Developer', group: 'Code', keys: ['Alt-F8'], edits: false, noRecord: true,
    tip: 'Run, rename, delete or put a macro on the Quick Access Bar',
    run: async (app) => {
      const ms = app.prefs.macros;
      if (!ms.length) { toast('No macros yet. Use Record Macro to make one.', { action: 'Record', onAction: () => app.exec('dev.recordMacro') }); return; }
      const r = await openDialog({ title: 'Macros', fields: [
        { key: 'm', label: 'Macro', type: 'list', options: ms.map((m) => ({ value: m.name, label: `${m.name} — ${stepsLabel(m)}` })), value: ms[0].name },
        { key: 'act', label: 'Action', type: 'radio', options: [{ value: 'run', label: 'Run' }, { value: 'edit', label: 'Edit…' }, { value: 'rename', label: 'Rename…' }, { value: 'qat', label: 'Add to Quick Access Bar' }, { value: 'delete', label: 'Delete' }], value: 'run' },
      ] });
      if (!r?.m) return;
      const m = ms.find((x) => x.name === r.m)!;
      if (r.act === 'run') await runMacro(app, m.name);
      else if (r.act === 'edit') app.exec('dev.macroEditor', m.name);
      else if (r.act === 'rename') {
        const n = (await promptDialog('Rename Macro', 'Name', m.name))?.trim();
        if (!n || n === m.name) return;
        if (ms.some((x) => x.name === n)) { toast(`There is already a macro named "${n}".`); return; }
        retargetMacro(app, m.name, n); m.name = n; app.savePrefs(); app.ui.rebuild();
      }
      else if (r.act === 'qat') { if (!app.prefs.qat.includes(`macro:${m.name}`)) app.prefs.qat = [...app.prefs.qat, `macro:${m.name}`]; app.savePrefs(); app.ui.renderQat(); }
      else if (r.act === 'delete' && (await confirmDialog('Delete Macro', `Delete "${m.name}"? Its Quick Access Bar buttons and keyboard shortcuts are removed too.`, 'Delete'))) { app.prefs.macros = app.prefs.macros.filter((x) => x !== m); retargetMacro(app, m.name, null); app.savePrefs(); app.ui.rebuild(); }
    },
  },
  { id: 'dev.runMacro', label: 'Run Macro', icon: 'play_arrow', tab: 'Developer', group: 'Code', internal: true, noRecord: true, edits: false, run: (app, name: string) => runMacro(app, name) },
  {
    id: 'dev.recordMacro', label: 'Record Macro', icon: 'fiber_manual_record', tab: 'Developer', group: 'Code', kind: 'toggle', noRecord: true, edits: false,
    tip: 'Record the commands you run (page changes, marks, exports) to replay them later',
    isActive: (app) => !!app.recording,
    run: async (app) => {
      if (app.recording) { app.exec('dev.stopRecording'); return; }
      const name = await promptDialog('Record Macro', 'Macro name', `Macro${app.prefs.macros.length + 1}`);
      if (!name) return;
      if (app.prefs.macros.some((m) => m.name === name) && !(await confirmDialog('Record Macro', `Replace the macro "${name}"?`, 'Replace'))) return;
      app.recording = { name, steps: [] };
      app.recordingPaused = false;
      app.ui.status?.('● Recording macro');
    },
  },
  {
    id: 'dev.pauseRecording', label: 'Pause Recording', icon: 'pause', tab: 'Developer', group: 'Code', kind: 'toggle', noRecord: true, edits: false,
    tip: 'While paused, the commands you run are not added to the macro; choose it again to go on recording',
    isEnabled: (app) => !!app.recording, isActive: (app) => !!app.recording && app.recordingPaused,
    run: (app) => { if (!app.recording) return; app.recordingPaused = !app.recordingPaused; app.ui.status?.(app.recordingPaused ? '⏸ Macro recording paused' : '● Recording macro'); },
  },
  {
    id: 'dev.stopRecording', label: 'Stop Recording', icon: 'stop', tab: 'Developer', group: 'Code', noRecord: true, edits: false, isEnabled: (app) => !!app.recording,
    run: (app) => {
      const rec = app.recording;
      if (!rec) return;
      app.recording = null;
      app.ui.status?.('');
      if (!rec.steps.length) { toast('Nothing was recorded.'); return; }
      app.prefs.macros = [...app.prefs.macros.filter((m) => m.name !== rec.name), { name: rec.name, steps: rec.steps, created: Date.now() }];
      app.savePrefs();
      toast(`Macro "${rec.name}" saved with ${rec.steps.length} step(s).`, { action: 'Add to QAT', onAction: () => { app.prefs.qat = [...app.prefs.qat, `macro:${rec.name}`]; app.savePrefs(); app.ui.renderQat(); } });
    },
  },
  {
    id: 'dev.macroEditor', label: 'Macro Editor', icon: 'code', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    tip: 'Edit a macro\'s steps (one command per line: id and an optional JSON argument)',
    run: async (app, name?: string) => {
      let ms = app.prefs.macros;
      let m = name === undefined ? undefined : ms.find((x) => x.name === name);
      // Opened without a macro: ask which one to edit, or start a new one.
      if (name === undefined && ms.length) {
        const pick = await openDialog({ title: 'Macro Editor', fields: [{ key: 'm', label: 'Edit', type: 'list', options: [{ value: '', label: 'A new macro…' }, ...ms.map((x) => ({ value: x.name, label: `${x.name} — ${stepsLabel(x)}` }))], value: '' }], ok: 'Edit' });
        if (!pick) return;
        m = app.prefs.macros.find((x) => x.name === pick.m);
      }
      const text = m ? m.steps.map((s) => (s.arg === undefined ? s.id : `${s.id} ${JSON.stringify(s.arg)}`)).join('\n') : 'organize.rotateRight\ncomment.flatten';
      const r = await openDialog({ title: m ? `Edit Macro: ${m.name}` : 'New Macro', wide: true, fields: [
        { key: 'name', label: 'Name', type: 'text', value: m?.name || `Macro${ms.length + 1}` },
        { key: 'desc', label: 'Description', type: 'text', value: m?.description || '' },
        { key: 'steps', label: 'Steps', type: 'textarea', rows: 14, value: text, help: 'One command per line: its id, then an optional JSON argument. Find command ids in Help ▸ Command Reference or the Customize dialogs. A macro can run any Anne\'s Folio command, nothing else.' },
      ], validate: (v) => parseMacroSteps(v.steps).error || (String(v.name).trim() ? null : 'Give the macro a name.') });
      if (!r) return;
      const newName = String(r.name).trim();
      ms = app.prefs.macros;
      const clash = ms.find((x) => x.name === newName && x !== m);
      if (clash && !(await confirmDialog('Macro Editor', `There is already a macro named "${newName}". Replace it?`, 'Replace'))) return;
      const { steps } = parseMacroSteps(r.steps);
      if (m && m.name !== newName) retargetMacro(app, m.name, newName);
      app.prefs.macros = [...app.prefs.macros.filter((x) => x !== clash && x !== m), { name: newName, description: r.desc || undefined, steps, created: m?.created || Date.now() }];
      app.savePrefs();
      app.ui.rebuild();
      toast(`Saved "${newName}".`, { action: 'Run', onAction: () => void runMacro(app, newName) });
    },
  },
  {
    id: 'dev.macroSecurity', label: 'Macro Security', icon: 'admin_panel_settings', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    run: async () => { await openDialog({ title: 'Macro Security', ok: 'Close', cancel: false, fields: [{ key: 'i', type: 'info', html: '<p><b>Anne\'s Folio macros are lists of Anne\'s Folio commands.</b> A macro can do what you could do yourself with the ribbon, and nothing else: mark up, organize pages, save, export, share. That includes commands that send text out, such as the AI commands (to the AI service you set up) and Share or Email. A macro cannot run code of its own, and it cannot read or write files or use the network except through those commands. Look at a macro\'s steps (Developer ▸ Macros ▸ Edit) before you run one you did not record yourself; this applies to macros that arrive with imported settings.</p><p>A macro stops at the first step that fails or is refused, and it cannot start itself again.</p><p><b>JavaScript inside PDF files</b> (document scripts, field calculations, link actions) is <b>never run</b> by Anne\'s Folio. Developer ▸ Scripts in This Document lists what is there; Protect ▸ Remove JavaScript strips it.</p>' }] }); },
  },
  {
    id: 'dev.javaScriptInfo', label: 'Scripts in This Document', icon: 'code_off', tab: 'Developer', group: 'Code', noRecord: true, edits: false,
    tip: 'List the JavaScript and actions the file carries (read-only; never executed)',
    run: (app) => { const items = scriptsReport(app); app.ui.openPane('report', { title: 'Scripts and Actions', items: items.length ? items.map((x) => ({ level: 'warning' as const, text: `${x.text}: ${x.count}` })) : [{ level: 'info', text: 'No scripts or actions found.' }], actions: items.length ? [{ label: 'Remove them', run: () => app.exec('protect.removeJavaScript') }] : [] }); },
  },
  {
    id: 'dev.exportStructure', label: 'Export Structure JSON', icon: 'download', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    tip: 'The trailer, catalog, page tree and page dictionaries as JSON (object numbers kept, streams summarized)',
    run: async (app) => {
      const d = app.doc;
      const dump = { file: app.tab.fileName, header: d.report.header, xrefStream: d.usesXrefStream, encrypted: !!d.security, objects: d.objectNumbers().length, trailer: toJsonish(d, d.trailer, 1), catalog: toJsonish(d, d.catalog, 3), pages: d.pages.map((p) => ({ index: p.index, ref: p.ref ? `${p.ref.num} ${p.ref.gen} R` : null, mediaBox: p.mediaBox, cropBox: p.cropBox, rotate: p.rotate, dict: toJsonish(d, p.dict, 2) })) };
      await saveBytes(JSON.stringify(dump, null, 1), `${baseName(app)} structure.json`, 'application/json');
    },
  },
  {
    id: 'dev.tags', label: 'Tag Structure', icon: 'sell', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    tip: 'Whether the document is tagged, and the structure element types it uses',
    run: async (app) => {
      const d = app.doc;
      const root = d.getDict(d.catalog, 'StructTreeRoot');
      const mi = d.getDict(d.catalog, 'MarkInfo');
      const counts = new Map<string, number>();
      let n = 0;
      const walk = (o: PdfObj | undefined, depth: number) => { if (depth > 40 || n > 20000) return; const x = d.resolve(o); if (Array.isArray(x)) { for (const k of x) walk(k, depth + 1); return; } if (!(x instanceof Dict)) return; const s = d.getName(x, 'S'); if (s) { counts.set(s, (counts.get(s) || 0) + 1); n++; } walk(x.get('K'), depth + 1); };
      if (root) walk(root.get('K'), 0);
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`);
      await openDialog({ title: 'Tag Structure', ok: 'Close', cancel: false, content: h('div', null, h('p', null, root ? `Tagged: ${mi && d.get(mi, 'Marked') === true ? 'yes (MarkInfo/Marked)' : 'structure tree present, MarkInfo not set'}; ${n} structure element(s).` : 'The document is not tagged (no StructTreeRoot). Anne\'s Folio cannot add tags to existing content.'), rows.length ? h('pre', { class: 'ql-notices' }, rows.join('\n')) : null, root && root.has('RoleMap') ? h('p', { class: 'ql-help' }, `Role map: ${Object.entries(toJsonish(d, root.get('RoleMap')!, 1) as any).map(([k, v]) => `${k}→${v}`).join(', ')}`) : null) });
    },
  },
  {
    id: 'dev.rawObject', label: 'Raw Object…', icon: 'data_object', tab: 'Developer', group: 'Data', noRecord: true, edits: false,
    tip: 'Show any object by number as PDF syntax (and a stream\'s decoded bytes)',
    run: async (app, num?: number) => {
      const d = app.doc;
      let n = num;
      if (n == null) { const r = await promptDialog('Raw Object', `Object number (1–${d.size - 1}; the catalog is ${d.catalogRef.num})`, String(d.catalogRef.num)); if (!r) return; n = parseInt(r, 10); }
      if (!Number.isFinite(n!)) return;
      const ref = new Ref(n!, d.genOf(n!));
      let obj: PdfObj;
      try { obj = d.fetch(ref); } catch (e: any) { toast(`Object ${n}: ${e?.message || e}`); return; }
      let text = new TextDecoder('latin1').decode(serialize(obj instanceof PdfStream ? obj.dict : obj));
      if (obj instanceof PdfStream) { let body = ''; try { const dec = d.decoded(obj); body = new TextDecoder('latin1').decode(dec.subarray(0, 60000)) + (dec.length > 60000 ? `\n… (${dec.length} bytes)` : ''); } catch (e: any) { body = `(could not decode: ${e?.message || e})`; } text += `\nstream (${obj.raw.length} raw bytes)\n${body}\nendstream`; }
      await openDialog({ title: `Object ${n} ${ref.gen}`, wide: true, ok: 'Close', cancel: false, content: h('pre', { class: 'ql-notices', style: 'max-height:60vh;overflow:auto;font-size:12px;white-space:pre-wrap' }, text), buttons: [{ label: 'Copy', onClick: () => { navigator.clipboard?.writeText(text); toast('Copied'); } }] });
    },
  },
]);
