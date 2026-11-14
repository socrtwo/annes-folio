/**
 * Interactive forms (ISO 32000-1 §12.7): filling fields with regenerated appearances, creating and
 * deleting fields, calculation and tab order, reset, flattening, and FDF/XFDF/CSV/JSON data exchange.
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, concat } from '../objects';
import { flateStream } from '../filters';
import { PdfDocument, PageInfo } from '../document';
import { Parser } from '../lexer';
import { fmtNum, serialize } from '../writer';
import { ensureAcroForm, readFields, touchAcroForm, FieldInfo, FieldType, addAnnotation, removeAnnotation } from '../structure';
import { stdFontRef, lit } from '../build';
import { textWidth, winAnsiBytes, wrapText, type StdFont } from '../stdfonts';
import { flattenAnnotations } from './annots';
import { bytesOf } from '../objects';
import { parseXml, esc as xmlEsc } from '../../io/xml';
import { detachWidget } from './shared';

type RGB = [number, number, number];
type Rect = [number, number, number, number];

/** Parses a default appearance string: font resource name, size, color. */
export function parseDA(da: string): { font: string; size: number; color: string } {
  const f = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da);
  const g = /([\d.]+)\s+g\b/.exec(da), rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/.exec(da);
  return { font: f ? f[1] : 'Helv', size: f ? +f[2] : 0, color: rg ? `${rg[1]} ${rg[2]} ${rg[3]} rg` : g ? `${g[1]} g` : '0 g' };
}

/** True when every character has a WinAnsi code (what the generated appearances can show). */
export const canWinAnsi = (s: string): boolean => { const b = winAnsiBytes(s); let i = 0; for (const ch of s) { if (b[i++] === 63 && ch !== '?') return false; } return true; };

/**
 * The font to draw a field appearance with. The /DR font named by /DA is used when it is a simple
 * WinAnsi font; a composite or custom-encoded font cannot take WinAnsi bytes, so Helvetica stands in
 * (under a name that lives in the appearance's own resources only).
 */
function fieldFont(doc: PdfDocument, resName: string): { name: string; ref: PdfObj; std: StdFont } {
  const af = ensureAcroForm(doc);
  const dr = doc.getDict(af, 'DR');
  const fonts = dr ? doc.getDict(dr, 'Font') : null;
  const existing = fonts && resName ? fonts.get(resName) : undefined;
  const fd = doc.resolve<PdfObj>(existing);
  if (fd instanceof Dict && existing !== undefined) {
    const base = doc.getName(fd, 'BaseFont'), sub = doc.getName(fd, 'Subtype'), enc = doc.get<PdfObj>(fd, 'Encoding');
    const simple = (sub === 'Type1' || sub === 'TrueType' || sub === 'MMType1') && !/Symbol|Dingbat|Wingding/i.test(base);
    const winAnsi = (enc instanceof Name && enc.name === 'WinAnsiEncoding') || (enc == null && !doc.getDict(fd, 'FontDescriptor'));
    if (simple && winAnsi) return { name: resName, ref: existing, std: (/Cour/i.test(base) ? 'Courier' : /Times|Tiro/i.test(base) ? 'Times-Roman' : 'Helvetica') as StdFont };
    return { name: 'QFHelv', ref: stdFontRef(doc, 'Helvetica'), std: 'Helvetica' };
  }
  // The name is not in /DR yet: add Helvetica under it (on copies, so shared or indirect dictionaries are not edited behind the document's back).
  const ref = stdFontRef(doc, 'Helvetica');
  const name = resName || 'Helv';
  const ndr = dr ? dr.clone() : new Dict(), nfonts = fonts ? fonts.clone() : new Dict();
  nfonts.set(name, ref); ndr.set('Font', nfonts); af.set('DR', ndr);
  touchAcroForm(doc);
  return { name, ref, std: 'Helvetica' };
}

function widgetStyle(doc: PdfDocument, w: Dict): { border: RGB | null; bg: RGB | null; width: number } {
  const mk = doc.getDict(w, 'MK');
  const c = (k: string): RGB | null => { const a = mk ? doc.getArray(mk, k) : null; if (!a || !a.length) return null; const v = a.map((x) => doc.resolve<number>(x)); return v.length === 1 ? [v[0], v[0], v[0]] : v.length === 3 ? [v[0], v[1], v[2]] : [1 - Math.min(1, v[0] + v[3]), 1 - Math.min(1, v[1] + v[3]), 1 - Math.min(1, v[2] + v[3])]; };
  const bs = doc.getDict(w, 'BS');
  return { border: c('BC'), bg: c('BG'), width: bs ? doc.getNum(bs, 'W', 1) : 1 };
}

/** Builds and stores the appearance stream of a text/choice widget for its current value. */
export function regenerateAppearance(doc: PdfDocument, f: FieldInfo, w: FieldInfo['widgets'][number]): void {
  const r = w.rect;
  // A widget turned by /MK /R is laid out in its own upright box; the appearance matrix turns it into the Rect.
  const mk = doc.getDict(w.dict, 'MK');
  const rot = (((mk ? doc.getNum(mk, 'R', 0) : 0) % 360) + 360) % 360;
  const width = rot % 180 ? r[3] - r[1] : r[2] - r[0], height = rot % 180 ? r[2] - r[0] : r[3] - r[1];
  const af = ensureAcroForm(doc);
  const da = parseDA(f.defaultAppearance || doc.getText(af, 'DA'));
  const font = fieldFont(doc, da.font);
  const style = widgetStyle(doc, w.dict);
  let ops = '/Tx BMC q ';
  if (style.bg) ops += `${style.bg.map(fmtNum).join(' ')} rg 0 0 ${fmtNum(width)} ${fmtNum(height)} re f `;
  if (style.border) ops += `${style.border.map(fmtNum).join(' ')} RG ${fmtNum(style.width)} w ${fmtNum(style.width / 2)} ${fmtNum(style.width / 2)} ${fmtNum(width - style.width)} ${fmtNum(height - style.width)} re S `;
  const pad = 2 + style.width;
  // A choice shows the option's label; the export value is what /V holds.
  const labelOf = (v: string) => { const o = f.options.find((x) => x.value === v); return o ? o.label || o.value : v; };
  const value = typeof f.value === 'string' ? (f.type === 'combo' ? labelOf(f.value) : f.value) : Array.isArray(f.value) ? f.value.map(labelOf).join(', ') : '';
  const text = f.password ? '*'.repeat(value.length) : value;
  let size = da.size;
  const qOf = (d: Dict | null) => (d && d.has('Q') ? doc.getNum(d, 'Q', 0) : null);
  const q = qOf(w.dict) ?? qOf(f.dict) ?? qOf(af) ?? 0;
  const alignX = (tw: number) => (q === 1 ? (width - tw) / 2 : q === 2 ? width - pad - tw : pad);
  const comb = f.type === 'text' && !!(f.flags & (1 << 24)) && f.maxLen > 0;
  ops += `BT ${da.color} `;
  if (f.type === 'list') {
    if (!size) size = 12;
    const sel = new Set(Array.isArray(f.value) ? f.value : [f.value as string]);
    ops += `/${font.name} ${fmtNum(size)} Tf `;
    f.options.forEach((o, i) => {
      const y = height - pad - (i + 1) * size * 1.15 + size * 0.25;
      if (y < -size) return;
      if (sel.has(o.value) || sel.has(o.label)) ops += `ET q 0.6 0.75 0.85 rg ${fmtNum(pad / 2)} ${fmtNum(y - size * 0.3)} ${fmtNum(width - pad)} ${fmtNum(size * 1.15)} re f Q BT ${da.color} /${font.name} ${fmtNum(size)} Tf `;
      ops += `1 0 0 1 ${fmtNum(pad)} ${fmtNum(y)} Tm ${lit(winAnsiBytes(o.label || o.value))} Tj `;
    });
  } else if (f.multiline) {
    if (!size) size = 10;
    const lines = wrapText(text, font.std, size, width - pad * 2);
    ops += `/${font.name} ${fmtNum(size)} Tf `;
    lines.forEach((l, i) => { const y = height - pad - size * 0.95 - i * size * 1.2; if (y > -size) ops += `1 0 0 1 ${fmtNum(alignX(textWidth(l, font.std, size)))} ${fmtNum(y)} Tm ${lit(winAnsiBytes(l))} Tj `; });
  } else if (comb) {
    if (!size) size = Math.min(height * 0.7, (width / f.maxLen) * 1.2);
    const cell = width / f.maxLen;
    ops += `/${font.name} ${fmtNum(size)} Tf `;
    [...text].slice(0, f.maxLen).forEach((ch, i) => { const cw = textWidth(ch, font.std, size); ops += `1 0 0 1 ${fmtNum(i * cell + (cell - cw) / 2)} ${fmtNum((height - size * 0.7) / 2)} Tm ${lit(winAnsiBytes(ch))} Tj `; });
  } else {
    if (!size) { size = Math.min(12, height * 0.66); while (size > 4 && textWidth(text, font.std, size) > width - pad * 2) size *= 0.92; }
    ops += `/${font.name} ${fmtNum(size)} Tf 1 0 0 1 ${fmtNum(alignX(textWidth(text, font.std, size)))} ${fmtNum((height - size * 0.7) / 2)} Tm ${lit(winAnsiBytes(text))} Tj `;
  }
  ops += 'ET Q EMC';
  const res = new Dict({ Font: new Dict({ [font.name]: font.ref }) });
  const s = flateStream(bytesOf(ops), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, width, height], Resources: res });
  if (rot === 90) s.dict.set('Matrix', [0, 1, -1, 0, height, 0]); else if (rot === 180) s.dict.set('Matrix', [-1, 0, 0, -1, width, height]); else if (rot === 270) s.dict.set('Matrix', [0, -1, 1, 0, 0, width]);
  // Always a new stream object: producers share one blank appearance between many fields, and
  // writing into it would show this value in all of them.
  const ap = (doc.getDict(w.dict, 'AP') || new Dict()).clone();
  ap.set('N', doc.register(s));
  w.dict.set('AP', ap);
  doc.touch(w.ref);
}

/** Sets a field's value (text, choice, checkbox/radio) and refreshes its widgets' appearances. */
export function setFieldValue(doc: PdfDocument, f: FieldInfo, value: string | string[] | boolean): void {
  if (f.readOnly) throw new Error(`${f.name} is read-only.`);
  if (f.type === 'checkbox' || f.type === 'radio') {
    const on = typeof value === 'boolean' ? value : value !== '' && value !== 'Off' && value !== 'false';
    const states = f.widgets.map((w) => w.onState || 'Yes');
    if (f.type === 'radio') {
      // value: the export name (on state) to select, or true for the first widget
      const want = typeof value === 'string' ? (on ? value : '') : on ? states[0] : '';
      if (want && !states.includes(want)) throw new Error(`${f.name} has no option "${want}".`);
      f.dict.set('V', Name.get(want || 'Off'));
      f.widgets.forEach((w) => { w.dict.set('AS', Name.get(want && w.onState === want ? want : 'Off')); doc.touch(w.ref); });
      f.value = want;
    } else {
      f.dict.set('V', Name.get(on ? states[0] : 'Off'));
      f.widgets.forEach((w, i) => { w.dict.set('AS', Name.get(on ? states[i] : 'Off')); doc.touch(w.ref); });
      f.value = on;
    }
    doc.update(f.ref, f.dict);
    return;
  }
  let shown = '';
  if (f.type === 'text') {
    let text = Array.isArray(value) ? value.join('\n') : String(value === true ? 'Yes' : value === false ? '' : value);
    if (f.maxLen > 0) text = text.slice(0, f.maxLen);
    f.dict.set('V', PdfString.fromText(text));
    f.dict.delete('RV'); // a stale rich-text value would be shown instead of the new one
    f.value = text; shown = text;
  } else if (f.type === 'combo' || f.type === 'list') {
    const vals = Array.isArray(value) ? value : [String(value)];
    const toExport = vals.map((v) => f.options.find((o) => o.label === v || o.value === v)?.value ?? v);
    f.dict.set('V', toExport.length > 1 ? toExport.map((v) => PdfString.fromText(v)) : PdfString.fromText(toExport[0] || ''));
    f.value = toExport.length > 1 ? toExport : toExport[0] || '';
    if (f.type === 'list') f.dict.set('I', toExport.map((v) => f.options.findIndex((o) => o.value === v)).filter((i) => i >= 0).sort((x, y) => x - y)); else f.dict.delete('I');
    shown = f.options.map((o) => o.label || o.value).concat(toExport).join('');
  } else return;
  doc.update(f.ref, f.dict);
  for (const w of f.widgets) regenerateAppearance(doc, f, w);
  // The appearances drawn here are WinAnsi text. Text beyond that is in /V, and readers are asked to
  // draw it themselves; otherwise an existing request to regenerate is left as the document had it.
  if (!canWinAnsi(shown)) { const af = ensureAcroForm(doc); af.set('NeedAppearances', true); touchAcroForm(doc); }
}

export function resetForm(doc: PdfDocument, fields = readFields(doc)): void {
  for (const f of fields) {
    if (f.readOnly) continue;
    const dv = doc.get(f.dict, 'DV');
    if (f.type === 'checkbox') setFieldValue(doc, f, dv instanceof Name ? dv.name !== 'Off' : false);
    else if (f.type === 'radio') { const name = dv instanceof Name && dv.name !== 'Off' && f.widgets.some((w) => w.onState === dv.name) ? dv.name : ''; setFieldValue(doc, f, name); }
    else if (f.type === 'text' || f.type === 'combo' || f.type === 'list') setFieldValue(doc, f, dv instanceof PdfString ? dv.toText() : Array.isArray(dv) ? dv.map((x) => (x instanceof PdfString ? x.toText() : '')) : '');
  }
}

export interface NewField { name: string; type: FieldType; page: number; rect: Rect; options?: string[]; value?: string | boolean; required?: boolean; multiline?: boolean; maxLen?: number; tooltip?: string; fontSize?: number; border?: RGB | null; background?: RGB | null; exportValue?: string; checkStyle?: 'check' | 'circle' | 'cross' | 'square' }

export function addField(doc: PdfDocument, spec: NewField): Ref {
  const af = ensureAcroForm(doc);
  const page = doc.pages[spec.page];
  if (!page) throw new Error('No such page.');
  const ft = spec.type === 'text' ? 'Tx' : spec.type === 'signature' ? 'Sig' : spec.type === 'combo' || spec.type === 'list' ? 'Ch' : 'Btn';
  let flags = 0;
  if (spec.required) flags |= 2;
  if (spec.multiline) flags |= 1 << 12;
  if (spec.type === 'combo') flags |= 1 << 17;
  if (spec.type === 'radio') flags |= 1 << 15;
  if (spec.type === 'button') flags |= 1 << 16;
  const existing = readFields(doc).find((f) => f.name === spec.name);
  const mk = new Dict();
  if (spec.border) mk.set('BC', spec.border); if (spec.background) mk.set('BG', spec.background);
  if (spec.type === 'checkbox' || spec.type === 'radio') mk.set('CA', PdfString.fromText({ check: '4', circle: 'l', cross: '8', square: 'n' }[spec.checkStyle || (spec.type === 'radio' ? 'circle' : 'check')]));
  const widget = new Dict({ Type: Name.get('Annot'), Subtype: Name.get('Widget'), Rect: spec.rect, F: 4, MK: mk, BS: new Dict({ W: 1, S: Name.get('S') }) });
  if (spec.type === 'radio') {
    // A radio group is a field without a widget of its own; every button is a kid widget.
    const style = spec.checkStyle || 'circle';
    let group: Ref, gd: Dict;
    if (existing && existing.type === 'radio') {
      group = existing.ref; gd = existing.dict;
      if (doc.getName(gd, 'Subtype') === 'Widget') ({ group, gd } = splitMergedRadio(doc, existing.ref, gd));
    } else {
      gd = new Dict({ FT: Name.get('Btn'), T: PdfString.fromText(spec.name), Ff: flags, V: Name.get('Off'), Kids: [] });
      if (spec.tooltip) gd.set('TU', PdfString.fromText(spec.tooltip));
      group = doc.register(gd);
      af.set('Fields', [...(doc.getArray(af, 'Fields') || []), group]); touchAcroForm(doc);
    }
    const kids = (doc.getArray(gd, 'Kids') || []).slice();
    const taken = new Set(kids.map((k) => { const n = doc.getDict(doc.getDict(doc.resolve<Dict | null>(k), 'AP'), 'N'); return n ? n.keys().find((x) => x !== 'Off') : undefined; }));
    let on = spec.exportValue || `Choice${kids.length + 1}`;
    for (let k = 2; taken.has(on); k++) on = `${spec.exportValue || 'Choice'}${k}`;
    widget.set('Parent', group);
    widget.set('AP', new Dict({ N: new Dict({ [on]: checkAppearance(doc, spec.rect, style, true, mk), Off: checkAppearance(doc, spec.rect, style, false, mk) }) }));
    widget.set('AS', Name.get(spec.value === true ? on : 'Off'));
    if (spec.tooltip) widget.set('TU', PdfString.fromText(spec.tooltip));
    const ref = addAnnotation(doc, page, widget);
    kids.push(ref); gd.set('Kids', kids);
    if (spec.value === true) { gd.set('V', Name.get(on)); for (const k of kids.slice(0, -1)) { const kd = doc.resolve<Dict | null>(k); if (kd instanceof Dict && k instanceof Ref) { kd.set('AS', Name.get('Off')); doc.touch(k); } } }
    doc.update(group, gd);
    return ref;
  }
  const field = widget; // merged field/widget dictionary
  field.set('FT', Name.get(ft));
  field.set('T', PdfString.fromText(spec.name));
  if (flags) field.set('Ff', flags);
  if (spec.tooltip) field.set('TU', PdfString.fromText(spec.tooltip));
  if (spec.maxLen) field.set('MaxLen', spec.maxLen);
  field.set('DA', PdfString.fromText(`/Helv ${fmtNum(spec.fontSize ?? 0)} Tf 0 g`));
  fieldFont(doc, 'Helv');
  if (spec.options) field.set('Opt', spec.options.map((o) => PdfString.fromText(o)));
  if (spec.type === 'checkbox') {
    const on = spec.exportValue || 'Yes';
    const style = spec.checkStyle || 'check';
    field.set('AP', new Dict({ N: new Dict({ [on]: checkAppearance(doc, spec.rect, style, true, mk), Off: checkAppearance(doc, spec.rect, style, false, mk) }) }));
    field.set('AS', Name.get(spec.value === true ? on : 'Off'));
    field.set('V', Name.get(spec.value === true ? on : 'Off'));
  }
  if (spec.type === 'button') {
    field.set('AP', new Dict({ N: buttonAppearance(doc, spec.rect, spec.value ? String(spec.value) : spec.name, mk) }));
    if (!mk.has('CA')) mk.set('CA', PdfString.fromText(spec.value ? String(spec.value) : spec.name));
  }
  const ref = addAnnotation(doc, page, field);
  const fields = (doc.getArray(af, 'Fields') || []).slice(); fields.push(ref); af.set('Fields', fields); touchAcroForm(doc);
  if ((spec.type === 'text' || spec.type === 'combo' || spec.type === 'list') && spec.value !== undefined) {
    const f = readFields(doc).find((x) => x.ref.num === ref.num);
    if (f) setFieldValue(doc, f, spec.value);
  } else if (spec.type === 'text' || spec.type === 'combo' || spec.type === 'list') { const f = readFields(doc).find((x) => x.ref.num === ref.num); if (f) for (const w of f.widgets) regenerateAppearance(doc, f, w); }
  return ref;
}

/**
 * A radio group whose first button was written as a merged field/widget with /Kids (documents made
 * by earlier versions): the field entries move to a new parent and the button becomes its first kid.
 */
function splitMergedRadio(doc: PdfDocument, ref: Ref, d: Dict): { group: Ref; gd: Dict } {
  const gd = new Dict();
  for (const k of ['FT', 'T', 'TU', 'TM', 'Ff', 'V', 'DV', 'DA', 'Opt']) if (d.has(k)) { gd.set(k, d.get(k)!); d.delete(k); }
  const oldKids = doc.getArray(d, 'Kids') || [];
  d.delete('Kids');
  const group = doc.register(gd);
  gd.set('Kids', [ref, ...oldKids]);
  d.set('Parent', group);
  doc.update(ref, d);
  for (const k of oldKids) { const kd = doc.resolve<Dict | null>(k); if (kd instanceof Dict && k instanceof Ref) { kd.set('Parent', group); doc.touch(k); } }
  const af = ensureAcroForm(doc);
  for (const key of ['Fields', 'CO']) { const a = doc.getArray(af, key); if (a) af.set(key, a.map((r) => (r instanceof Ref && r.num === ref.num ? group : r))); }
  touchAcroForm(doc);
  return { group, gd };
}

function checkAppearance(doc: PdfDocument, rect: Rect, style: string, on: boolean, mk: Dict): Ref {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  let ops = '';
  const bg = doc.getArray(mk, 'BG'), bc = doc.getArray(mk, 'BC');
  if (bg && bg.length === 3) ops += `${bg.map((x) => fmtNum(doc.resolve<number>(x))).join(' ')} rg 0 0 ${fmtNum(w)} ${fmtNum(h)} re f `;
  if (bc && bc.length === 3) ops += `${bc.map((x) => fmtNum(doc.resolve<number>(x))).join(' ')} RG 1 w 0.5 0.5 ${fmtNum(w - 1)} ${fmtNum(h - 1)} re S `;
  if (on) {
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.3;
    if (style === 'circle') ops += `0 g ${fmtNum(cx + r)} ${fmtNum(cy)} m ${fmtNum(cx + r)} ${fmtNum(cy + r * 0.55)} ${fmtNum(cx + r * 0.55)} ${fmtNum(cy + r)} ${fmtNum(cx)} ${fmtNum(cy + r)} c ${fmtNum(cx - r * 0.55)} ${fmtNum(cy + r)} ${fmtNum(cx - r)} ${fmtNum(cy + r * 0.55)} ${fmtNum(cx - r)} ${fmtNum(cy)} c ${fmtNum(cx - r)} ${fmtNum(cy - r * 0.55)} ${fmtNum(cx - r * 0.55)} ${fmtNum(cy - r)} ${fmtNum(cx)} ${fmtNum(cy - r)} c ${fmtNum(cx + r * 0.55)} ${fmtNum(cy - r)} ${fmtNum(cx + r)} ${fmtNum(cy - r * 0.55)} ${fmtNum(cx + r)} ${fmtNum(cy)} c f`;
    else if (style === 'cross') ops += `0 G ${fmtNum(Math.max(1, r / 4))} w ${fmtNum(cx - r)} ${fmtNum(cy - r)} m ${fmtNum(cx + r)} ${fmtNum(cy + r)} l ${fmtNum(cx - r)} ${fmtNum(cy + r)} m ${fmtNum(cx + r)} ${fmtNum(cy - r)} l S`;
    else if (style === 'square') ops += `0 g ${fmtNum(cx - r)} ${fmtNum(cy - r)} ${fmtNum(r * 2)} ${fmtNum(r * 2)} re f`;
    else ops += `0 G ${fmtNum(Math.max(1, r / 3))} w 1 J 1 j ${fmtNum(cx - r)} ${fmtNum(cy)} m ${fmtNum(cx - r * 0.3)} ${fmtNum(cy - r * 0.7)} l ${fmtNum(cx + r)} ${fmtNum(cy + r * 0.8)} l S`;
  }
  return doc.register(flateStream(bytesOf(ops), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, w, h] }));
}

function buttonAppearance(doc: PdfDocument, rect: Rect, caption: string, mk: Dict): Ref {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  const font = fieldFont(doc, 'Helv');
  const size = Math.min(12, h * 0.6);
  const bg = doc.getArray(mk, 'BG');
  const ops = `${bg && bg.length === 3 ? bg.map((x) => fmtNum(doc.resolve<number>(x))).join(' ') + ' rg' : '0.85 g'} 0 0 ${fmtNum(w)} ${fmtNum(h)} re f 0.4 G 1 w 0.5 0.5 ${fmtNum(w - 1)} ${fmtNum(h - 1)} re S BT 0 g /Helv ${fmtNum(size)} Tf ${fmtNum((w - textWidth(caption, 'Helvetica', size)) / 2)} ${fmtNum((h - size * 0.7) / 2)} Td ${lit(winAnsiBytes(caption))} Tj ET`;
  return doc.register(flateStream(bytesOf(ops), { Type: Name.get('XObject'), Subtype: Name.get('Form'), BBox: [0, 0, w, h], Resources: new Dict({ Font: new Dict({ Helv: font.ref }) }) }));
}

export function deleteField(doc: PdfDocument, f: FieldInfo): void {
  // The field leaves /Fields, /CO and its parent's /Kids (a parent left empty goes too), then its widgets leave their pages.
  detachWidget(doc, f.ref);
  const pages = doc.pages;
  for (const w of f.widgets) { const p = pages[w.page]; if (p) removeAnnotation(doc, p, w.ref); else doc.remove(w.ref); }
  doc.remove(f.ref);
}

export function setFieldProps(doc: PdfDocument, f: FieldInfo, props: { name?: string; required?: boolean; readOnly?: boolean; tooltip?: string; maxLen?: number; multiline?: boolean; options?: string[]; fontSize?: number; defaultValue?: string }): void {
  if (props.name !== undefined) f.dict.set('T', PdfString.fromText(props.name));
  let flags = f.flags;
  const bit = (b: number, on: boolean | undefined) => { if (on === undefined) return; flags = on ? flags | b : flags & ~b; };
  bit(2, props.required); bit(1, props.readOnly); bit(1 << 12, props.multiline);
  f.dict.set('Ff', flags);
  if (props.tooltip !== undefined) { if (props.tooltip) f.dict.set('TU', PdfString.fromText(props.tooltip)); else f.dict.delete('TU'); }
  if (props.maxLen !== undefined) { if (props.maxLen > 0) f.dict.set('MaxLen', props.maxLen); else f.dict.delete('MaxLen'); }
  if (props.options) f.dict.set('Opt', props.options.map((o) => PdfString.fromText(o)));
  if (props.fontSize !== undefined) { const da = parseDA(f.defaultAppearance); f.dict.set('DA', PdfString.fromText(`/${da.font} ${fmtNum(props.fontSize)} Tf ${da.color}`)); f.defaultAppearance = `/${da.font} ${props.fontSize} Tf ${da.color}`; }
  if (props.defaultValue !== undefined) f.dict.set('DV', PdfString.fromText(props.defaultValue));
  doc.update(f.ref, f.dict);
  // The appearance is drawn from the field as it is now, not as it was read.
  f.flags = flags; f.required = !!(flags & 2); f.readOnly = !!(flags & 1); f.multiline = !!(flags & (1 << 12));
  if (props.maxLen !== undefined) f.maxLen = Math.max(0, props.maxLen);
  if (props.options) f.options = props.options.map((o) => ({ value: o, label: o }));
  if (props.tooltip !== undefined) f.tooltip = props.tooltip;
  if (props.name !== undefined) { const dot = f.name.lastIndexOf('.'); f.name = (dot >= 0 ? f.name.slice(0, dot + 1) : '') + props.name; }
  if (f.type === 'text' || f.type === 'combo' || f.type === 'list') for (const w of f.widgets) regenerateAppearance(doc, f, w);
}

export function setCalculationOrder(doc: PdfDocument, names: string[]): void {
  const af = ensureAcroForm(doc);
  const fields = readFields(doc);
  af.set('CO', names.map((n) => fields.find((f) => f.name === n)?.ref).filter((r): r is Ref => !!r));
  touchAcroForm(doc);
}

/** Reorders a page's annotations so the Tab key visits widgets in the given field order (row order by default). */
export function setTabOrder(doc: PdfDocument, p: PageInfo, mode: 'rows' | 'columns' | 'structure' | string[]): void {
  if (typeof mode === 'string') { p.dict.set('Tabs', Name.get(mode === 'rows' ? 'R' : mode === 'columns' ? 'C' : 'S')); if (p.ref) doc.touch(p.ref); return; }
  const fields = readFields(doc);
  const annots = (doc.getArray(p.dict, 'Annots') || []).slice();
  const order = new Map<number, number>();
  mode.forEach((name, i) => { const f = fields.find((x) => x.name === name); if (f) for (const w of f.widgets) order.set(w.ref.num, i); });
  annots.sort((a, b) => (a instanceof Ref ? order.get(a.num) ?? 1e9 : 1e9) - (b instanceof Ref ? order.get(b.num) ?? 1e9 : 1e9));
  p.dict.set('Annots', annots);
  p.dict.delete('Tabs');
  if (p.ref) doc.touch(p.ref);
}

/**
 * Draws every form field into its page and removes the form. Fields whose appearance is missing
 * (forms that rely on NeedAppearances) are drawn from their values first, so no value is lost; widgets
 * with nothing to draw (hidden ones, unchecked boxes without an off appearance) are removed as well.
 */
export function flattenForm(doc: PdfDocument): number {
  let n = 0;
  const af = doc.getDict(doc.catalog, 'AcroForm');
  const need = !!af && doc.get(af, 'NeedAppearances') === true;
  for (const f of readFields(doc)) {
    for (const w of f.widgets) {
      const ap = doc.getDict(w.dict, 'AP');
      const has = !!ap && ap.has('N') && doc.get<PdfObj>(ap, 'N') != null;
      if ((f.type === 'text' || f.type === 'combo' || f.type === 'list') && (need || !has)) regenerateAppearance(doc, f, w);
      else if ((f.type === 'checkbox' || f.type === 'radio') && !has) {
        // No appearances at all: draw the state the value names.
        const v = doc.get<PdfObj>(f.dict, 'V'), as = doc.getName(w.dict, 'AS') || (v instanceof Name ? v.name : 'Off');
        const mk = doc.getDict(w.dict, 'MK') || new Dict();
        const style = f.type === 'radio' ? 'circle' : 'check';
        if (as !== 'Off') { w.dict.set('AP', new Dict({ N: new Dict({ [as]: checkAppearance(doc, w.rect, style, true, mk), Off: checkAppearance(doc, w.rect, style, false, mk) }) })); w.dict.set('AS', Name.get(as)); doc.touch(w.ref); }
      }
    }
  }
  doc.invalidatePages();
  for (const p of doc.pages) {
    n += flattenAnnotations(doc, p, (a) => a.subtype === 'Widget');
    for (const a of doc.getArray(p.dict, 'Annots') || []) { const d = doc.resolve<Dict | null>(a); if (a instanceof Ref && d instanceof Dict && doc.getName(d, 'Subtype') === 'Widget') removeAnnotation(doc, p, a); }
  }
  if (doc.catalog.has('AcroForm')) { doc.catalog.delete('AcroForm'); doc.update(doc.catalogRef, doc.catalog); }
  return n;
}

// ------------------------------------------------------------------------------------------
// Data exchange

export function formData(doc: PdfDocument): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (const f of readFields(doc)) if (f.type !== 'button' && f.type !== 'signature') out[f.name] = f.value;
  return out;
}

export function applyFormData(doc: PdfDocument, data: Record<string, unknown>): number {
  let n = 0;
  const fields = readFields(doc);
  for (const [k, v] of Object.entries(data)) {
    // The exact name first; a partial name only when it fits exactly one field.
    let f = fields.find((x) => x.name === k);
    if (!f) { const tail = fields.filter((x) => x.name.endsWith('.' + k)); if (tail.length === 1) f = tail[0]; }
    if (!f || f.readOnly) continue;
    try {
      if (f.type === 'checkbox') setFieldValue(doc, f, v === true || v === 1 || (typeof v === 'string' && (/^(true|yes|on|1|x|checked)$/i.test(v.trim()) || f.widgets.some((w) => w.onState === v))));
      else if (f.type === 'radio') setFieldValue(doc, f, typeof v === 'string' ? v : !!v);
      else setFieldValue(doc, f, Array.isArray(v) ? v.map(String) : String(v ?? ''));
      n++;
    } catch { /* read-only */ }
  }
  return n;
}

export function exportFormXfdf(doc: PdfDocument, fileName = ''): string {
  const fields = readFields(doc).filter((f) => f.type !== 'button' && f.type !== 'signature');
  const items = fields.map((f) => {
    const vals = f.type === 'checkbox' || f.type === 'radio' ? [f.value ? (f.widgets.find((w) => (f.type === 'radio' ? doc.getName(w.dict, 'AS') !== 'Off' : true))?.onState || 'Yes') : 'Off'] : Array.isArray(f.value) ? f.value : [String(f.value)];
    return `<field name="${xmlEsc(f.name)}">${vals.map((v) => `<value>${xmlEsc(v)}</value>`).join('')}</field>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">${fileName ? `<f href="${xmlEsc(fileName)}"/>` : ''}<fields>${items.join('')}</fields></xfdf>`;
}

export function importFormXfdf(doc: PdfDocument, xml: string): number {
  const dom = parseXml(xml);
  if (!dom) throw new Error('The XFDF file is not well-formed XML; nothing was imported.');
  const data: Record<string, unknown> = {};
  const walk = (el: Element, prefix: string) => {
    for (const c of [...el.children]) {
      if (c.localName === 'field') { const name = (prefix ? prefix + '.' : '') + (c.getAttribute('name') || ''); const vals = [...c.children].filter((x) => x.localName === 'value').map((x) => x.textContent || ''); if (vals.length) data[name] = vals.length > 1 ? vals : vals[0]; walk(c, name); }
      else walk(c, prefix);
    }
  };
  const fields = dom.getElementsByTagNameNS('*', 'fields')[0];
  if (fields) walk(fields, '');
  return applyFormData(doc, data);
}

/** FDF (the older binary-ish form data format): a minimal writer and reader. */
export function exportFormFdf(doc: PdfDocument, fileName = ''): Uint8Array {
  const fields = readFields(doc).filter((f) => f.type !== 'button' && f.type !== 'signature');
  const items = fields.map((f) => {
    const d = new Dict({ T: PdfString.fromText(f.name) });
    if (f.type === 'radio') d.set('V', Name.get(typeof f.value === 'string' && f.value ? f.value : 'Off')); // the selected option, not the first one
    else if (f.type === 'checkbox') d.set('V', Name.get(f.value ? f.widgets[0]?.onState || 'Yes' : 'Off'));
    else d.set('V', Array.isArray(f.value) ? f.value.map((v) => PdfString.fromText(v)) : PdfString.fromText(String(f.value)));
    return d;
  });
  const fdfDict = new Dict({ Fields: items });
  if (fileName) fdfDict.set('F', PdfString.fromText(fileName));
  // The plain FDF layout (ISO 32000-1 §12.7.7): one object holding the /FDF dictionary and a trailer naming it.
  return concat([bytesOf('%FDF-1.2\n%\xe2\xe3\xcf\xd3\n1 0 obj\n'), serialize(new Dict({ FDF: fdfDict })), bytesOf('\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n')]);
}

/**
 * The /FDF dictionary of an FDF file with a resolver for its references. FDF files usually have no
 * cross-reference table and their root is not a PDF catalog, so the objects are found by scanning
 * rather than through the PDF loader.
 */
function readFdf(bytes: Uint8Array): { fdf: Dict; resolve: (o: PdfObj | undefined) => PdfObj } | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const offsets = new Map<number, number>();
  for (const m of text.matchAll(/(?:^|[^0-9])(\d{1,10})\s+\d{1,5}\s+obj\b/g)) offsets.set(+m[1], m.index! + m[0].indexOf(m[1]));
  const objs = new Map<number, PdfObj>();
  const fetch = (n: number): PdfObj => {
    if (objs.has(n)) return objs.get(n)!;
    objs.set(n, null); // a reference loop resolves to null
    const off = offsets.get(n);
    if (off != null) { try { const r = new Parser(bytes, off, resolve).parseIndirect(); if (r) objs.set(n, r.obj); } catch { /* damaged object */ } }
    return objs.get(n)!;
  };
  const resolve = (o: PdfObj | undefined): PdfObj => { let v: PdfObj = o ?? null; for (let i = 0; i < 32 && v instanceof Ref; i++) v = fetch(v.num); return v; };
  let fdf: Dict | null = null;
  for (const n of offsets.keys()) { const o = fetch(n); const d = o instanceof Dict ? o : o instanceof PdfStream ? o.dict : null; const f = d ? resolve(d.get('FDF')) : null; if (f instanceof Dict) fdf = f; }
  return fdf ? { fdf, resolve } : null;
}

/** Applies the field values of an FDF file. Throws when the bytes hold no FDF data. */
export function importFormFdf(doc: PdfDocument, bytes: Uint8Array): number {
  const file = readFdf(bytes);
  if (!file) throw new Error('This file holds no FDF form data.');
  const { fdf, resolve } = file;
  const data: Record<string, unknown> = {};
  const seen = new Set<Dict>();
  const walk = (list: PdfObj, prefix: string, depth: number) => {
    if (!Array.isArray(list) || depth > 32) return;
    for (const it of list) {
      const d = resolve(it);
      if (!(d instanceof Dict) || seen.has(d)) continue;
      seen.add(d);
      const t = resolve(d.get('T'));
      const name = (prefix ? prefix + '.' : '') + (t instanceof PdfString ? t.toText() : '');
      const v = resolve(d.get('V'));
      if (v instanceof PdfString) data[name] = v.toText(); else if (v instanceof Name) data[name] = v.name; else if (Array.isArray(v)) data[name] = v.map((x) => { const r = resolve(x); return r instanceof PdfString ? r.toText() : ''; });
      walk(resolve(d.get('Kids')), name, depth + 1);
    }
  };
  walk(resolve(fdf.get('Fields')), '', 0);
  return applyFormData(doc, data);
}

export function formDataCsv(doc: PdfDocument): string {
  const d = formData(doc);
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return Object.keys(d).map(q).join(',') + '\n' + Object.values(d).map((v) => q(Array.isArray(v) ? v.join('; ') : String(v))).join(',') + '\n';
}

/** Finds likely form fields on a page from its drawn rectangles and underscore runs (for "Detect Form Fields"). */
export function detectFieldsFromText(runs: { text: string; box: Rect }[], rects: Rect[]): NewField[] {
  const out: NewField[] = [];
  let n = 0;
  for (const r of runs) {
    const m = /^(.*?[:\s])?(_{3,})\s*$/.exec(r.text);
    if (m) {
      const frac = m[2].length / Math.max(1, r.text.length);
      const w = r.box[2] - r.box[0];
      out.push({ name: (m[1] || `Field ${++n}`).replace(/[:\s_]+$/, '').trim() || `Field ${++n}`, type: 'text', page: -1, rect: [r.box[2] - w * frac, r.box[1] - 2, r.box[2], r.box[3] + 2] });
    }
    if (/\[\s*\]|☐|\(\s*\)/.test(r.text)) out.push({ name: r.text.replace(/\[\s*\]|☐|\(\s*\)/g, '').trim() || `Check ${++n}`, type: 'checkbox', page: -1, rect: [r.box[0], r.box[1], r.box[0] + (r.box[3] - r.box[1]), r.box[3]] });
  }
  for (const r of rects) { const w = r[2] - r[0], h = r[3] - r[1]; if (w > 30 && h > 8 && h < 40) out.push({ name: `Field ${++n}`, type: 'text', page: -1, rect: r }); else if (Math.abs(w - h) < 3 && w >= 6 && w <= 20) out.push({ name: `Check ${++n}`, type: 'checkbox', page: -1, rect: r }); }
  return out;
}

export { readFields };
export type { FieldInfo };
export const strOf = (o: PdfObj): string => (o instanceof PdfString ? o.toText() : o instanceof Name ? o.name : '');
export const isStream = (o: unknown): o is PdfStream => o instanceof PdfStream;
