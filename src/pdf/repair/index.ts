/**
 * The repair pipeline for damaged PDFs (docs/REPAIR.md). Methods run in order; each records what it
 * found. The candidate with the most recovered pages (and text) wins and opens as a new, unsaved file
 * with the report. Descends from the author's XML Truncator-Fixer, Immortal Zip and Word Recovery
 * tools: identify first, salvage byte by byte, never refuse to open.
 */
import { PdfDocument } from '../document';
import { Lexer } from '../lexer';
import { latin1, bytesOf, concat } from '../objects';
import { analyze, identifyAt, scan, recommend, S2Program } from '../../io/recover/fileid';
import { scanZipBytes } from '../../io/recover/salvage';
import { addTextPages } from '../build';
import { pageText } from '../ops/extract';
import { readAttachments } from '../structure';

export type MethodStatus = 'success' | 'partial' | 'failed' | 'skipped';
export type MethodId = 'identify' | 'open' | 'header' | 'xref' | 'trailer' | 'pages' | 'streams' | 'segments' | 'zip' | 'attachments' | 'text' | 'strings';

export interface MethodResult { id: MethodId; name: string; status: MethodStatus; detail: string; pages?: number; words?: number }

export interface RepairReport {
  fileName: string;
  methods: MethodResult[];
  summary: string;
  /** The recovered document (null when nothing could be made). */
  doc: PdfDocument | null;
  bytes: Uint8Array | null;
  /** The parts the repair lost, for the "repair diff". */
  lost: string[];
  rebuilt: string[];
  identification: { ext: string; description: string; confidence: string };
  recommendations: S2Program[];
  pagesBefore: number | null;
  pagesAfter: number;
  textOnly: boolean;
  tools: S2Program[];
}

const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w + 's'}`;

function countWords(doc: PdfDocument, maxPages = 20): number {
  let n = 0;
  for (let i = 0; i < Math.min(maxPages, doc.pageCount); i++) { try { n += (pageText(doc, i).match(/\S+/g) || []).length; } catch { /* */ } }
  return n;
}

/** Fixes the header and trailing junk, returning cleaned bytes and notes. */
function repairHeader(buf: Uint8Array): { bytes: Uint8Array; notes: string[] } {
  const notes: string[] = [];
  let b = buf;
  const h = Lexer.find(b, '%PDF-', 0, Math.min(b.length, 65536));
  if (h > 0) { notes.push(`${h} bytes of junk before the header were removed.`); b = b.subarray(h); }
  else if (h < 0) { notes.push('The %PDF header was missing and was added.'); b = concat([bytesOf('%PDF-1.4\n'), b]); }
  const eof = Lexer.findLast(b, '%%EOF');
  if (eof < 0) notes.push('The file has no %%EOF marker (it is probably truncated).');
  else if (b.length - eof > 1024 && Lexer.find(b, 'obj', eof) < 0) { notes.push(`${b.length - eof - 5} bytes after %%EOF were removed.`); b = b.subarray(0, eof + 5); }
  return { bytes: b, notes };
}

export interface RepairOptions { password?: string; onProgress?: (m: MethodResult) => void }

export function repairPdf(input: Uint8Array | ArrayBuffer, fileName: string, opts: RepairOptions = {}): RepairReport {
  const buf0 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const methods: MethodResult[] = [];
  const lost: string[] = [], rebuilt: string[] = [];
  const add = (m: MethodResult) => { methods.push(m); opts.onProgress?.(m); };
  let best: { doc: PdfDocument; bytes: Uint8Array; score: number; textOnly: boolean } | null = null;
  const consider = (doc: PdfDocument, bytes: Uint8Array, textOnly = false, bonus = 0): { pages: number; words: number } => {
    const pages = doc.pageCount;
    const words = countWords(doc);
    const score = pages * 1000 + words + bonus;
    if (!best || score > best.score) best = { doc, bytes, score, textOnly };
    return { pages, words };
  };

  // a. Identify
  const idr = analyze(buf0, fileName);
  const id = identifyAt(buf0);
  const segs = scan(buf0);
  const isPdf = id.ext === 'pdf' || Lexer.find(buf0, '%PDF-', 0, Math.min(buf0.length, 65536)) >= 0 || Lexer.find(buf0, ' obj') >= 0;
  add({ id: 'identify', name: 'File identification', status: isPdf ? 'success' : segs.segments.some((s) => s.ext === 'pdf') ? 'partial' : 'failed', detail: `${id.description} (${id.confidence} confidence)${segs.multiple ? `; ${segs.segments.length} pieces of data found in the file` : ''}${idr.mismatch && !isPdf ? `; the content is not a PDF` : ''}` });

  // b. Normal open
  let pagesBefore: number | null = null;
  try {
    const d = PdfDocument.load(buf0, { password: opts.password });
    pagesBefore = d.pageCount;
    if (!d.report.reconstructed && d.report.warnings.length === 0) {
      // A clean open wins a tie against the rebuilt candidates below: the file needs no repair.
      const r = consider(d, buf0, false, 20);
      add({ id: 'open', name: 'Normal open', status: 'success', detail: `Opened without repair: ${plural(r.pages, 'page')}.`, pages: r.pages, words: r.words });
    } else {
      const r = consider(d, buf0, false, 10);
      add({ id: 'open', name: 'Normal open', status: 'partial', detail: `Opened with ${d.report.reconstructed ? 'a rebuilt cross-reference table' : 'warnings'}: ${d.report.warnings.slice(0, 3).join(' ')}`, pages: r.pages, words: r.words });
      if (d.report.reconstructed) rebuilt.push('cross-reference table');
      if (d.report.pagesSynthesized) rebuilt.push('page tree');
    }
  } catch (e: any) {
    if (e?.name === 'PasswordNeeded') { add({ id: 'open', name: 'Normal open', status: 'failed', detail: 'The file is encrypted and the password was not given; repair works on the structure only.' }); }
    else add({ id: 'open', name: 'Normal open', status: 'failed', detail: String(e?.message || e) });
  }

  // c. Header / trailer cleanup, then a forced rebuild
  const hr = repairHeader(buf0);
  add({ id: 'header', name: 'Header and end-of-file', status: hr.notes.length ? 'partial' : 'success', detail: hr.notes.join(' ') || 'The header and %%EOF are in place.' });
  try {
    const d = PdfDocument.load(hr.bytes, { password: opts.password, repair: true });
    const r = consider(d, hr.bytes, false, 5);
    const synth = d.report.pagesSynthesized;
    add({ id: 'xref', name: 'Cross-reference rebuild', status: r.pages ? 'success' : 'failed', detail: `Scanned the file for objects: ${plural(r.pages, 'page')} reachable${synth ? ' (page tree rebuilt from loose page objects)' : ''}.`, pages: r.pages, words: r.words });
    if (synth && !rebuilt.includes('page tree')) rebuilt.push('page tree');
    const missingRoot = d.report.warnings.find((w) => /catalog/i.test(w));
    add({ id: 'trailer', name: 'Trailer and catalog', status: missingRoot ? 'partial' : 'success', detail: missingRoot || 'The trailer names a usable catalog.' });
    // d. Streams: count damaged content streams.
    let damaged = 0, checked = 0;
    for (const p of d.pages.slice(0, 200)) { try { const c = d.get(p.dict, 'Contents'); const list = Array.isArray(c) ? c : c ? [c] : []; for (const it of list) { const s = d.resolve(it); if (s && typeof s === 'object' && 'raw' in (s as any)) { checked++; const res = d.decode(s as any); if (res.corrupt) damaged++; } } } catch { damaged++; } }
    add({ id: 'streams', name: 'Content streams', status: damaged ? 'partial' : 'success', detail: damaged ? `${damaged} of ${checked} content streams are damaged; the readable part of each was kept (ImmortalInflate).` : `${checked} content streams decode cleanly.` });
    if (damaged) lost.push(`${damaged} damaged content stream(s): text after the damage point is missing`);
    // Pages lost?
    if (pagesBefore != null && r.pages < pagesBefore) lost.push(`${pagesBefore - r.pages} page(s) could not be reached after the rebuild`);
  } catch (e: any) {
    add({ id: 'xref', name: 'Cross-reference rebuild', status: 'failed', detail: String(e?.message || e) });
  }

  // e. Segments: a PDF fused with other data (or several PDFs).
  const pdfSegs = segs.segments.filter((s) => s.ext === 'pdf');
  if (segs.multiple && pdfSegs.length) {
    let got = 0;
    for (const s of pdfSegs) {
      try { const piece = buf0.subarray(s.offset, s.offset + s.length); const d = PdfDocument.load(piece, { repair: true, password: opts.password }); const r = consider(d, piece.slice()); if (r.pages) got++; } catch { /* */ }
    }
    add({ id: 'segments', name: 'Embedded or concatenated PDF', status: got ? 'success' : 'failed', detail: `${pdfSegs.length} PDF piece(s) inside the file; ${got} opened.` });
  } else add({ id: 'segments', name: 'Embedded or concatenated PDF', status: 'skipped', detail: 'The file is one piece.' });

  // f. ZIP salvage: a PDF inside a damaged ZIP / portfolio package.
  if (buf0[0] === 0x50 && buf0[1] === 0x4b) {
    try {
      // Only entries that are PDFs by name or by content are decoded; the rest of the archive is left alone.
      const entries = scanZipBytes(buf0, { want: (name, head) => /\.pdf$/i.test(name) || latin1(head, 0, 5) === '%PDF-' });
      let got = 0;
      for (const [, e] of entries) { try { const d = PdfDocument.load(e.data, { repair: true, password: opts.password }); const r = consider(d, e.data); if (r.pages) got++; } catch { /* this entry is not a usable PDF */ } }
      add({ id: 'zip', name: 'ZIP salvage', status: got ? 'success' : 'failed', detail: `${entries.size} PDF entr${entries.size === 1 ? 'y' : 'ies'} read from the archive's local headers; ${got} opened.` });
    } catch (e: any) { add({ id: 'zip', name: 'ZIP salvage', status: 'failed', detail: String(e?.message || e) }); }
  } else add({ id: 'zip', name: 'ZIP salvage', status: 'skipped', detail: 'Not a ZIP archive.' });

  // g. Attachments survive?
  if (best) {
    try { const att = readAttachments((best as any).doc); add({ id: 'attachments', name: 'Embedded files', status: att.length ? 'success' : 'skipped', detail: att.length ? `${plural(att.length, 'attachment')} recovered: ${att.map((a) => a.name).slice(0, 5).join(', ')}` : 'No embedded files.' }); } catch { /* */ }
  }

  // h. Text scan: content streams found by signature when the structure is gone.
  if (!best || (best as any).score < 1000) {
    let text = '';
    try { text = textScan(buf0); } catch { /* nothing readable */ }
    let done = false;
    if (text.trim().length > 20) {
      try {
        const d = PdfDocument.create();
        addTextPages(d, `Recovered text from ${fileName}\n\n${text}`, { title: `${fileName} (recovered text)` });
        const out = d.save({ incremental: false });
        const r = consider(PdfDocument.load(out), out, true);
        add({ id: 'text', name: 'Text scan', status: 'partial', detail: `${plural(r.words, 'word')} of text found in decoded streams; rebuilt as a text-only PDF.`, pages: r.pages, words: r.words });
        done = true;
      } catch { /* fall through to "failed" */ }
    }
    if (!done) add({ id: 'text', name: 'Text scan', status: 'failed', detail: 'No readable text in the streams.' });
    // i. Strings
    const strings = stringsScan(buf0);
    const usable = !!best && (best as any).doc.pageCount > 0;
    done = false;
    if (!usable && strings.length > 40) {
      try {
        const d = PdfDocument.create();
        addTextPages(d, `Readable strings from ${fileName}\n\n${strings}`, { title: `${fileName} (strings)` });
        const out = d.save({ incremental: false });
        consider(PdfDocument.load(out), out, true);
        add({ id: 'strings', name: 'Strings scan', status: 'partial', detail: 'Only loose readable text could be recovered.' });
        done = true;
      } catch { /* fall through */ }
    }
    if (!done) add({ id: 'strings', name: 'Strings scan', status: 'skipped', detail: best ? 'Not needed.' : 'Nothing readable.' });
  } else {
    add({ id: 'text', name: 'Text scan', status: 'skipped', detail: 'Not needed: the structure was recovered.' });
    add({ id: 'strings', name: 'Strings scan', status: 'skipped', detail: 'Not needed.' });
  }

  let b = best as { doc: PdfDocument; bytes: Uint8Array; score: number; textOnly: boolean } | null;
  if (b && b.doc.pageCount === 0) b = null;
  const pagesAfter = b ? b.doc.pageCount : 0;
  const summary = !b ? 'Nothing could be recovered from this file.' : b.textOnly ? `Only text could be recovered (${plural(pagesAfter, 'page')} of text).` : pagesBefore != null && pagesAfter >= pagesBefore && !rebuilt.length && !lost.length ? 'The file opened without repair.' : `${plural(pagesAfter, 'page')} recovered${rebuilt.length ? ` (rebuilt: ${rebuilt.join(', ')})` : ''}${lost.length ? `; lost: ${lost.join('; ')}` : ''}.`;
  return { fileName, methods, summary, doc: b?.doc || null, bytes: b?.bytes || null, lost, rebuilt, identification: { ext: id.ext, description: id.description, confidence: id.confidence }, recommendations: recommend('pdf'), pagesBefore, pagesAfter, textOnly: !!b?.textOnly, tools: recommend('pdf') };
}

/** Readable text from every Flate stream that holds text operators, in file order. */
export function textScan(buf: Uint8Array): string {
  const out: string[] = [];
  // One code unit per byte, decoded natively: a character-by-character conversion of a large file takes minutes and gigabytes.
  const text = new TextDecoder('latin1').decode(buf);
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  const { inflateZlib } = requireFilters();
  while ((m = re.exec(text)) && guard++ < 20000) {
    if (text.startsWith('end', m.index - 3)) continue; // "endstream": what follows is not stream data
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    const data = buf.subarray(start, end < 0 ? Math.min(buf.length, start + 2_000_000) : end);
    let dec: Uint8Array = data;
    const looksZ = data[0] === 0x78 || data[0] === 0x68;
    if (looksZ) dec = inflateZlib(data).data;
    const s = latin1(dec);
    if (!/\bTj\b|\bTJ\b/.test(s)) continue;
    const parts: string[] = [];
    for (const t of s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:[^\]]|\\\])*)\]\s*TJ|T\*|\bTd\b|\bTD\b|\bET\b/g)) {
      if (t[1] !== undefined) parts.push(unescapePdf(t[1]));
      else if (t[2] !== undefined) { const strs = [...t[2].matchAll(/\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)/g)]; let line = ''; for (const x of strs) { if (x[1] !== undefined) line += unescapePdf(x[1]); else if (+x[2] < -200) line += ' '; } parts.push(line); }
      else parts.push('\n');
    }
    const joined = parts.join('').replace(/\n{3,}/g, '\n\n');
    if (/[A-Za-z]{3,}/.test(joined)) out.push(joined);
  }
  return out.join('\n\n').replace(/[^\x09\x0a\x20-\x7e -￿]/g, '');
}

function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, c) => ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[c] ?? String.fromCharCode(parseInt(c, 8)));
}

export function stringsScan(buf: Uint8Array, minLen = 6): string {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 32 && c < 127) cur += String.fromCharCode(c);
    else { if (cur.length >= minLen && /[A-Za-z]{3}/.test(cur) && !/^[\s\d./-]+$/.test(cur) && !/obj|endobj|stream|\/[A-Z][A-Za-z]+/.test(cur)) out.push(cur); cur = ''; }
  }
  if (cur.length >= minLen) out.push(cur);
  return out.join('\n');
}

import * as filtersMod from '../filters';
function requireFilters() { return filtersMod; }

export function reportText(r: RepairReport): string {
  const lines = [`Anne's Folio repair report for ${r.fileName}`, r.summary, '', `Identified as: ${r.identification.description} (${r.identification.confidence})`, ''];
  for (const m of r.methods) lines.push(`[${m.status}] ${m.name}: ${m.detail}`);
  if (r.rebuilt.length) lines.push('', 'Rebuilt: ' + r.rebuilt.join(', '));
  if (r.lost.length) lines.push('', 'Lost: ' + r.lost.join('; '));
  return lines.join('\n');
}
