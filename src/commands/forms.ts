/** Forms tab: add fields, edit them, fill, calculate/tab order, reset, flatten, data in and out. */
import { def } from './registry';
import type { App, Tool } from '../app';
import { openDialog, toast, confirmDialog } from '../ui/dialog';
import { pickFile } from '../ui/dom';
import { readFields, pageAnnotations, type FieldInfo } from '../pdf/structure';
import { setFieldValue, resetForm, addField, deleteField, setFieldProps, setCalculationOrder, setTabOrder, flattenForm, formData, applyFormData, exportFormXfdf, importFormXfdf, exportFormFdf, importFormFdf, formDataCsv, detectFieldsFromText, regenerateAppearance, parseDA } from '../pdf/ops/forms';
import { pageRuns } from '../pdf/ops/textedit';
import { Dict, PdfString } from '../pdf/objects';
import { selectedAnnotation, saveBytes, baseName, pageOf, esc, hexToRgb, editTab, guarded, tabOf, csvFormData, type Ctx } from './util';

const fieldTool = (id: string, t: Tool, label: string, icon: string, tip: string) => ({
  id, label, icon, tip, tab: 'Forms', group: 'Add Fields', kind: 'toggle' as const, noRecord: true,
  isActive: (app: App) => app.tab?.ui?.tool === t, run: (app: App) => { app.tab.ui.setTool(t); app.focus(); },
});

/** The field behind the selected widget, or the one named by `name`. */
export function fieldFor(c: Ctx, name?: string): FieldInfo | null {
  const fields = readFields(tabOf(c).doc);
  if (name) return fields.find((f) => f.name === name) || null;
  const s = selectedAnnotation(c);
  if (!s) return null;
  return fields.find((f) => f.widgets.some((w) => w.ref.equals(s.ref)) || f.ref.equals(s.ref)) || null;
}
// Cheap enough for every ribbon refresh: one page's annotations instead of the whole form (the commands look the field up when they run).
const hasField = (app: App) => selectedAnnotation(app)?.info.subtype === 'Widget';

async function pickField(c: Ctx, title: string): Promise<FieldInfo | null> {
  const tab = tabOf(c);
  const fields = readFields(tab.doc).filter((f) => f.type !== 'unknown');
  if (!fields.length) { toast('The document has no form fields. Add some from the Forms tab, or Detect Fields.'); return null; }
  const r = await openDialog({ title, fields: [{ key: 'f', label: 'Field', type: 'list', rows: 10, options: fields.map((f) => ({ value: f.name, label: `${f.name} (${f.type}${f.widgets[0] ? `, page ${f.widgets[0].page + 1}` : ''})` })), value: fields[0].name }] });
  return r ? fields.find((f) => f.name === r.f) || null : null;
}

export async function fillValue(app: App, name?: string): Promise<void> {
  const tab = app.tab;
  const f = fieldFor(tab, name) || (await pickField(tab, 'Fill Field'));
  if (!f) return;
  if (f.readOnly) { toast(`"${f.name}" is read-only.`); return; }
  let field: any;
  const opts = f.options.map((o) => ({ value: o.value, label: o.label || o.value }));
  if (f.type === 'checkbox') field = { key: 'v', label: f.tooltip || f.name, type: 'checkbox', value: f.value === true };
  else if (f.type === 'radio') field = { key: 'v', label: f.tooltip || f.name, type: 'radio', options: f.widgets.map((w) => ({ value: w.onState || '', label: w.onState || '' })), value: typeof f.value === 'string' ? f.value : '' };
  else if (f.type === 'combo') field = { key: 'v', label: f.tooltip || f.name, type: 'combo', options: opts.map((o) => o.value), value: typeof f.value === 'string' ? f.value : '' };
  else if (f.type === 'list') field = { key: 'v', label: f.tooltip || f.name, type: 'list', multiple: (f.flags & (1 << 21)) !== 0, options: opts, value: f.value };
  else if (f.type === 'signature') { app.exec('sign.signature'); return; }
  else if (f.type === 'button') { toast('Buttons run actions in other readers; Anne\'s Folio never runs document scripts.'); return; }
  else field = { key: 'v', label: f.tooltip || f.name, type: f.multiline ? 'textarea' : f.password ? 'password' : 'text', rows: 4, value: typeof f.value === 'string' ? f.value : '', autofocus: true };
  const r = await openDialog({ title: `Fill: ${f.name}`, fields: [field, ...(f.maxLen ? [{ key: 'i', type: 'info' as const, html: `<p class="ql-help">At most ${f.maxLen} characters.</p>` }] : [])], ok: 'Set' });
  if (!r) return;
  let v = r.v;
  if (f.maxLen && typeof v === 'string') v = v.slice(0, f.maxLen);
  editTab(app, tab, 'Fill Field', (doc) => setFieldValue(doc, f, v));
}

async function properties(app: App, name?: string): Promise<void> {
  const tab = app.tab;
  const f = fieldFor(tab, name) || (await pickField(tab, 'Field Properties'));
  if (!f) return;
  const da = parseDA(f.defaultAppearance);
  const r = await openDialog({ title: `Field: ${f.name}`, wide: true, fields: [
    { key: 'name', label: 'Name', type: 'text', value: f.name, half: true },
    { key: 'tooltip', label: 'Tooltip (read by screen readers)', type: 'text', value: f.tooltip, half: true },
    { key: 'required', label: 'Required', type: 'checkbox', value: f.required, half: true },
    { key: 'readOnly', label: 'Read-only', type: 'checkbox', value: f.readOnly, half: true },
    ...(f.type === 'text' ? [{ key: 'multiline', label: 'Multi-line', type: 'checkbox' as const, value: f.multiline, half: true }, { key: 'maxLen', label: 'Maximum length (0 = none)', type: 'number' as const, value: f.maxLen, half: true }] : []),
    ...(f.type === 'combo' || f.type === 'list' ? [{ key: 'options', label: 'Options (one per line)', type: 'textarea' as const, rows: 5, value: f.options.map((o) => o.value).join('\n') }] : []),
    { key: 'fontSize', label: 'Font size (0 = auto)', type: 'number', min: 0, max: 72, value: da.size, half: true },
    { key: 'defaultValue', label: 'Default value', type: 'text', value: tab.doc.getText(f.dict, 'DV'), half: true },
    { key: 'i', type: 'info', html: `<p class="ql-help">Type: ${esc(f.type)} · ${f.widgets.length} widget(s)${f.widgets[0] ? ` · page ${f.widgets[0].page + 1}, rect ${f.widgets[0].rect.map((v) => v.toFixed(0)).join(', ')}` : ''}</p>` },
  ], ok: 'Apply', buttons: [{ label: 'Delete Field', onClick: (_v, ctl) => guarded('Delete Field', async () => { if (await confirmDialog('Delete Field', `Delete "${f.name}" and its widgets?`, 'Delete')) { ctl.close(null); editTab(app, tab, 'Delete Field', (doc) => deleteField(doc, f)); tab.ui.selectedAnnot = null; } }) }] });
  if (!r) return;
  editTab(app, tab, 'Field Properties', (doc) => setFieldProps(doc, f, { name: r.name, tooltip: r.tooltip, required: r.required, readOnly: r.readOnly, multiline: r.multiline, maxLen: r.maxLen != null ? +r.maxLen : undefined, options: r.options != null ? String(r.options).split('\n').map((s: string) => s.trim()).filter(Boolean) : undefined, fontSize: +r.fontSize, defaultValue: r.defaultValue }));
}

async function exportData(app: App, format?: string): Promise<void> {
  const tab = app.tab;
  if (!readFields(tab.doc).length) { toast('The document has no form fields.'); return; }
  const fmt = format || (await openDialog({ title: 'Export Form Data', fields: [{ key: 'f', label: 'Format', type: 'radio', options: [{ value: 'xfdf', label: 'XFDF (XML form data)' }, { value: 'fdf', label: 'FDF' }, { value: 'csv', label: 'CSV (one row: field names, then values)' }, { value: 'json', label: 'JSON' }], value: 'xfdf' }] }))?.f;
  if (!fmt) return;
  const b = baseName(tab);
  if (fmt === 'xfdf') await saveBytes(exportFormXfdf(tab.doc, tab.fileName), `${b}.xfdf`, 'application/vnd.adobe.xfdf');
  else if (fmt === 'fdf') await saveBytes(exportFormFdf(tab.doc, tab.fileName), `${b}.fdf`, 'application/vnd.fdf');
  else if (fmt === 'csv') await saveBytes(formDataCsv(tab.doc), `${b} form data.csv`, 'text/csv');
  else await saveBytes(JSON.stringify(formData(tab.doc), null, 1), `${b} form data.json`, 'application/json');
}

def([
  fieldTool('forms.textField', 'field-text', 'Text Field', 'short_text', 'Drag where a text field goes'),
  fieldTool('forms.checkbox', 'field-checkbox', 'Check Box', 'check_box', 'Click where a check box goes'),
  fieldTool('forms.radio', 'field-radio', 'Radio Button', 'radio_button_checked', 'Click where a radio button goes (give buttons of one group the same name)'),
  fieldTool('forms.combo', 'field-combo', 'Drop-down', 'arrow_drop_down_circle', 'Drag where a drop-down list goes'),
  fieldTool('forms.listbox', 'field-list', 'List Box', 'list', 'Drag where a list box goes'),
  fieldTool('forms.button', 'field-button', 'Button', 'smart_button', 'Drag where a push button goes'),
  fieldTool('forms.signatureField', 'field-signature', 'Signature Field', 'draw', 'Drag where a signature field goes'),
  fieldTool('forms.dateField', 'field-date', 'Date Field', 'event', 'Drag where a date field goes (a text field with a date tooltip)'),
  { id: 'forms.properties', label: 'Field Properties…', icon: 'tune', tab: 'Forms', group: 'Edit', run: (app, name?: string) => properties(app, name) },
  { id: 'forms.deleteField', label: 'Delete Field', icon: 'delete', tab: 'Forms', group: 'Edit', isEnabled: hasField, run: async (app) => { const tab = app.tab; const f = fieldFor(tab); if (!f) return; if (!(await confirmDialog('Delete Field', `Delete "${f.name}"?`, 'Delete'))) return; editTab(app, tab, 'Delete Field', (doc) => deleteField(doc, f)); tab.ui.selectedAnnot = null; } },
  {
    id: 'forms.duplicateField', label: 'Duplicate Field', icon: 'content_copy', tab: 'Forms', group: 'Edit', isEnabled: hasField,
    run: (app) => {
      const f = fieldFor(app); const s = selectedAnnotation(app);
      if (!f || !s) return;
      const w = f.widgets.find((x) => x.ref.equals(s.ref)) || f.widgets[0];
      const names = new Set(readFields(app.doc).map((x) => x.name));
      let n = 2; while (names.has(`${f.name}${n}`)) n++;
      const r = w.rect;
      const ref = app.edit('Duplicate Field', (doc) => addField(doc, { name: `${f.name}${n}`, type: f.type === 'unknown' ? 'text' : f.type, page: w.page, rect: [r[0], r[1] - (r[3] - r[1]) - 6, r[2], r[1] - 6], options: f.options.map((o) => o.value), tooltip: f.tooltip, required: f.required, multiline: f.multiline, maxLen: f.maxLen || undefined, border: [0.5, 0.5, 0.5] }));
      if (ref) app.tab.ui.selectedAnnot = { page: w.page, num: ref.num };
    },
  },
  {
    id: 'forms.fieldFont', label: 'Field Font Size', icon: 'format_size', tab: 'Forms', group: 'Appearance', kind: 'menu', isEnabled: hasField,
    menu: () => [0, 8, 9, 10, 11, 12, 14, 18, 24].map((s) => ({ id: 'forms.fieldFont', arg: s, label: s ? `${s} pt` : 'Auto' })),
    run: (app, size?: number) => { const f = fieldFor(app); if (!f || size == null) return; app.edit('Field Font Size', (doc) => setFieldProps(doc, f, { fontSize: size })); },
  },
  {
    id: 'forms.fieldBorder', label: 'Field Border…', icon: 'border_color', tab: 'Forms', group: 'Appearance', isEnabled: hasField,
    run: async (app) => {
      const tab = app.tab;
      const f = fieldFor(tab); if (!f) return;
      const w = f.widgets[0];
      const mk = w ? tab.doc.getDict(w.dict, 'MK') : null;
      const bs = w ? tab.doc.getDict(w.dict, 'BS') : null;
      const toHex = (a: any) => Array.isArray(a) && a.length === 3 ? '#' + a.map((v: number) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : '';
      const r = await openDialog({ title: 'Field Border and Background', fields: [
        { key: 'border', label: 'Border color', type: 'color', value: toHex(mk ? tab.doc.get(mk, 'BC') : null) || '#808080', half: true },
        { key: 'noBorder', label: 'No border', type: 'checkbox', value: !mk?.has('BC'), half: true },
        { key: 'bg', label: 'Background color', type: 'color', value: toHex(mk ? tab.doc.get(mk, 'BG') : null) || '#ffffff', half: true },
        { key: 'noBg', label: 'Transparent background', type: 'checkbox', value: !mk?.has('BG'), half: true },
        { key: 'w', label: 'Border width (pt)', type: 'number', min: 0, max: 6, value: bs ? tab.doc.getNum(bs, 'W', 1) : 1, half: true },
      ] });
      if (!r) return;
      editTab(app, tab, 'Field Border', (doc) => {
        for (const wd of f.widgets) {
          const m = doc.getDict(wd.dict, 'MK') || new Dict();
          if (r.noBorder) m.delete('BC'); else m.set('BC', hexToRgb(r.border));
          if (r.noBg) m.delete('BG'); else m.set('BG', hexToRgb(r.bg));
          wd.dict.set('MK', m);
          // Only the width changes: a dashed, beveled, inset or underline style stays as it was.
          const style = doc.getDict(wd.dict, 'BS')?.clone() || new Dict({ S: Name_S() });
          style.set('W', Math.max(0, +r.w || 0));
          wd.dict.set('BS', style);
          doc.update(wd.ref, wd.dict);
          regenerateAppearance(doc, f, wd);
        }
      });
    },
  },
  {
    id: 'forms.detect', label: 'Detect Fields', icon: 'auto_fix_high', tab: 'Forms', group: 'Edit',
    tip: 'Find underscored blanks and "Label: ____" lines on the page and make text fields for them',
    run: async (app) => {
      const tab = app.tab;
      const p = pageOf(tab, tab.ui.page);
      const runs = pageRuns(tab.doc, p).map((r) => ({ text: r.text, box: r.box }));
      const specs = detectFieldsFromText(runs, []).map((s) => ({ ...s, page: p.index }));
      if (!specs.length) { toast('No blanks were found on this page. Draw fields with the Forms tab tools.'); return; }
      const existing = new Set(readFields(tab.doc).map((f) => f.name));
      const r = await openDialog({ title: 'Detect Fields', fields: [{ key: 'f', label: `Fields found on page ${p.index + 1}`, type: 'list', multiple: true, rows: 10, options: specs.map((s, i) => ({ value: String(i), label: `${s.name} (${s.type})` })), value: specs.map((_, i) => String(i)) }], ok: 'Add Fields' });
      if (!r?.f?.length) return;
      const n = editTab(app, tab, 'Detect Fields', (doc) => { let k = 0; for (const i of r.f as string[]) { const s = specs[+i]; let name = s.name; let j = 2; while (existing.has(name)) name = `${s.name}${j++}`; existing.add(name); addField(doc, { ...s, name, border: [0.6, 0.6, 0.6] }); k++; } return k; });
      toast(`${n || 0} field(s) added.`);
    },
  },
  {
    id: 'forms.tabOrder', label: 'Tab Order', icon: 'low_priority', tab: 'Forms', group: 'Edit', kind: 'menu',
    menu: () => [{ id: 'forms.tabOrder', arg: 'rows', label: 'Rows (left to right, top to bottom)' }, { id: 'forms.tabOrder', arg: 'columns', label: 'Columns (top to bottom, left to right)' }, { id: 'forms.tabOrder', arg: 'structure', label: 'Document structure' }],
    run: (app, mode?: string) => { if (!mode) return; const p = pageOf(app, app.page); app.edit('Tab Order', (doc) => setTabOrder(doc, p, mode as 'rows' | 'columns' | 'structure')); toast(`Tab order on page ${p.index + 1}: ${mode}.`); },
  },
  {
    id: 'forms.calcOrder', label: 'Calculation Order…', icon: 'calculate', tab: 'Forms', group: 'Edit',
    tip: 'The order fields with calculations are recomputed in (Anne\'s Folio records the order; it never runs field scripts)',
    run: async (app) => {
      const tab = app.tab;
      const names = readFields(tab.doc).map((f) => f.name);
      if (!names.length) { toast('The document has no form fields.'); return; }
      const co = tab.doc.getArray(tab.doc.getDict(tab.doc.catalog, 'AcroForm'), 'CO') || [];
      const cur = co.map((r) => readFields(tab.doc).find((f) => f.ref.equals(r as any))?.name).filter(Boolean).join('\n');
      const r = await openDialog({ title: 'Calculation Order', fields: [{ key: 'o', label: 'Field names, one per line, in calculation order', type: 'textarea', rows: 8, value: cur || names.join('\n') }] });
      if (!r) return;
      editTab(app, tab, 'Calculation Order', (doc) => setCalculationOrder(doc, String(r.o).split('\n').map((s) => s.trim()).filter(Boolean)));
    },
  },
  { id: 'forms.fillMode', label: 'Fill Mode', icon: 'edit_square', tab: 'Forms', group: 'Fill', kind: 'toggle', noRecord: true, edits: false, tip: 'Double-click a field to fill it (off: double-click opens its properties)', isActive: (app) => !!app.tab?.fillMode, run: (app) => { app.tab.fillMode = !app.tab.fillMode; app.tab.ui.refreshAnnotations(); app.refresh(); } },
  { id: 'forms.fillValue', label: 'Fill Field…', icon: 'edit', tab: 'Forms', group: 'Fill', popular: true, run: (app, name?: string) => fillValue(app, name) },
  { id: 'forms.reset', label: 'Reset Form', icon: 'restart_alt', tab: 'Forms', group: 'Fill', run: async (app) => { const tab = app.tab; if (!readFields(tab.doc).length) { toast('The document has no form fields.'); return; } if (await confirmDialog('Reset Form', 'Clear every field to its default value?', 'Reset')) editTab(app, tab, 'Reset Form', (doc) => resetForm(doc)); } },
  { id: 'forms.flatten', label: 'Flatten Form', icon: 'layers_clear', tab: 'Forms', group: 'Fill', tip: 'Field values become page content; the fields are removed', run: async (app) => { const tab = app.tab; if (!readFields(tab.doc).length) { toast('The document has no form fields.'); return; } if (!(await confirmDialog('Flatten Form', 'Draw every field into the page and remove the form?', 'Flatten'))) return; const n = editTab(app, tab, 'Flatten Form', (doc) => flattenForm(doc)); toast(`${n || 0} field widget(s) flattened.`); } },
  { id: 'forms.exportData', label: 'Export Form Data…', icon: 'ios_share', tab: 'Forms', group: 'Form Data', edits: false, noRecord: true, run: (app, f?: string) => exportData(app, f) },
  { id: 'forms.exportCsv', label: 'Export CSV', icon: 'table', tab: 'Forms', group: 'Form Data', edits: false, noRecord: true, run: (app) => exportData(app, 'csv') },
  { id: 'forms.exportJson', label: 'Export JSON', icon: 'data_object', tab: 'Forms', group: 'Form Data', edits: false, noRecord: true, run: (app) => exportData(app, 'json') },
  {
    id: 'forms.importData', label: 'Import Form Data…', icon: 'download', tab: 'Forms', group: 'Form Data', tip: 'Fill the fields from an XFDF, FDF, JSON or CSV file',
    run: async (app) => {
      const tab = app.tab;
      const [f] = await pickFile('.xfdf,.fdf,.json,.csv,.xml');
      if (!f) return;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const text = () => new TextDecoder().decode(bytes);
      const n = editTab(app, tab, 'Import Form Data', (doc) => {
        if (/\.fdf$/i.test(f.name)) return importFormFdf(doc, bytes);
        if (/\.json$/i.test(f.name)) {
          const data = JSON.parse(text().replace(/^﻿/, ''));
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The JSON file must hold one object of field names and values.');
          return applyFormData(doc, data);
        }
        if (/\.csv$/i.test(f.name)) {
          // A real CSV parser: quoted line breaks, quotes, a byte-order mark; cells missing from the data row are left alone.
          const data = csvFormData(text());
          if (!data) throw new Error('The CSV file needs a row of field names and a row of values.');
          return applyFormData(doc, data);
        }
        return importFormXfdf(doc, text());
      });
      toast(`${n || 0} field(s) filled.`);
    },
  },
  { id: 'forms.fieldList', label: 'Field List', icon: 'ballot', tab: 'Forms', group: 'Edit', noRecord: true, edits: false, run: (app) => app.ui.togglePane('fields') },
  {
    id: 'forms.clearField', label: 'Clear Field', icon: 'backspace', tab: 'Forms', group: 'Fill', isEnabled: hasField,
    run: (app) => { const f = fieldFor(app); if (!f) return; app.edit('Clear Field', (doc) => setFieldValue(doc, f, f.type === 'checkbox' || f.type === 'radio' ? false : '')); },
  },
  {
    id: 'forms.widgetTooltips', label: 'Add Missing Tooltips', icon: 'accessibility', tab: 'Forms', group: 'Edit', tip: 'Give every field without a tooltip its name as the tooltip (screen readers read it)',
    run: (app) => { const n = app.edit('Field Tooltips', (doc) => { let k = 0; for (const f of readFields(doc)) if (!f.tooltip) { f.dict.set('TU', PdfString.fromText(f.name.replace(/[_.]/g, ' '))); doc.update(f.ref, f.dict); k++; } return k; }); toast(`${n || 0} tooltip(s) added.`); },
  },
]);

import { Name } from '../pdf/objects';
const Name_S = () => Name.get('S');
export { pageAnnotations };
