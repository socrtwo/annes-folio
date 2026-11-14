/**
 * File format registry: detection by content, opening (with automatic repair of damaged PDFs) and
 * the conversions that make a PDF out of images and text. Heavy work loads on demand.
 */
import { PdfDocument, PasswordNeeded, type PageInfo } from '../pdf/document';
import { PdfString } from '../pdf/objects';
import type { RepairReport } from '../pdf/repair';
import { Lexer } from '../pdf/lexer';
import { fmtNum } from '../pdf/writer';
import { addBlankPage, addTextPages, ensureXObject, imageXObject, jpegInfo, PAPER, type ImageSpec } from '../pdf/build';
import { decodeXml } from './xml';

export interface FormatDef { id: string; label: string; ext: string[]; mime: string; canImport: boolean; canExport: boolean; kind: 'pdf' | 'form-data' | 'comments' | 'image' | 'text' | 'package' }

export const FORMATS: FormatDef[] = [
  { id: 'pdf', label: 'PDF Document', ext: ['pdf'], mime: 'application/pdf', canImport: true, canExport: true, kind: 'pdf' },
  { id: 'xfdf', label: 'XFDF Form and Comment Data', ext: ['xfdf'], mime: 'application/vnd.adobe.xfdf', canImport: true, canExport: true, kind: 'form-data' },
  { id: 'fdf', label: 'FDF Form Data', ext: ['fdf'], mime: 'application/vnd.fdf', canImport: true, canExport: true, kind: 'form-data' },
  { id: 'qfr', label: 'Anne\'s Folio Review Package', ext: ['qfr'], mime: 'application/x-quillfolio-review', canImport: true, canExport: true, kind: 'package' },
  { id: 'png', label: 'PNG Image', ext: ['png'], mime: 'image/png', canImport: true, canExport: true, kind: 'image' },
  { id: 'jpeg', label: 'JPEG Image', ext: ['jpg', 'jpeg'], mime: 'image/jpeg', canImport: true, canExport: true, kind: 'image' },
  { id: 'gif', label: 'GIF Image', ext: ['gif'], mime: 'image/gif', canImport: true, canExport: false, kind: 'image' },
  { id: 'webp', label: 'WebP Image', ext: ['webp'], mime: 'image/webp', canImport: true, canExport: false, kind: 'image' },
  { id: 'bmp', label: 'BMP Image', ext: ['bmp'], mime: 'image/bmp', canImport: true, canExport: false, kind: 'image' },
  { id: 'tiff', label: 'TIFF Image', ext: ['tif', 'tiff'], mime: 'image/tiff', canImport: true, canExport: false, kind: 'image' },
  { id: 'svg', label: 'SVG Image', ext: ['svg'], mime: 'image/svg+xml', canImport: true, canExport: false, kind: 'image' },
  { id: 'txt', label: 'Plain Text', ext: ['txt'], mime: 'text/plain', canImport: true, canExport: true, kind: 'text' },
  { id: 'md', label: 'Markdown', ext: ['md', 'markdown'], mime: 'text/markdown', canImport: true, canExport: true, kind: 'text' },
  { id: 'html', label: 'HTML', ext: ['html', 'htm'], mime: 'text/html', canImport: true, canExport: true, kind: 'text' },
  { id: 'csv', label: 'CSV Table', ext: ['csv'], mime: 'text/csv', canImport: false, canExport: true, kind: 'text' },
  { id: 'json', label: 'JSON Form Data', ext: ['json'], mime: 'application/json', canImport: true, canExport: true, kind: 'form-data' },
  { id: 'zip', label: 'ZIP of PDFs', ext: ['zip'], mime: 'application/zip', canImport: true, canExport: true, kind: 'package' },
];

export function formatById(id: string): FormatDef | undefined { return FORMATS.find((f) => f.id === id); }
export function formatFromName(name: string): FormatDef | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase();
  return ext ? FORMATS.find((f) => f.ext.includes(ext)) : undefined;
}

const ascii = (u8: Uint8Array, from: number, to: number) => { let s = ''; for (let i = from; i < Math.min(u8.length, to); i++) s += String.fromCharCode(u8[i]); return s; };
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const printableShare = (data: Uint8Array, from: number, to: number): number => { let ok = 0; const n = Math.max(1, to - from); for (let i = from; i < to; i++) { const c = data[i]; if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0x80) ok++; } return ok / n; };

/** A BMP file header, not just text that starts with "BM": a known info-header size and a pixel offset inside the file. */
function isBmp(data: Uint8Array): boolean {
  if (data.length < 26 || data[0] !== 0x42 || data[1] !== 0x4d) return false;
  const dib = u32le(data, 14), pixels = u32le(data, 10);
  return [12, 40, 52, 56, 64, 108, 124].includes(dib) && pixels >= 14 + dib && pixels <= data.length;
}

/**
 * A PDF header ("%PDF-" and a version digit) between `from` and `to`. At the very start it always
 * counts. Further in it counts when it starts a line (a PDF behind a mail or HTTP header), when the
 * name says PDF, or when what precedes it is not readable text; a sentence that mentions "%PDF-" in a
 * text file does not make the file a PDF.
 */
function pdfHeaderIn(data: Uint8Array, from: number, to: number, byName: string | null): boolean {
  for (let at = Lexer.find(data, '%PDF-', from, Math.min(data.length, to)); at >= 0 && at < to; at = Lexer.find(data, '%PDF-', at + 5, Math.min(data.length, to))) {
    const digit = data[at + 5] >= 0x30 && data[at + 5] <= 0x39;
    if (!digit) continue;
    if (at === 0 || data[at - 1] === 0x0a || data[at - 1] === 0x0d || byName === 'pdf' || printableShare(data, 0, Math.min(at, 2048)) < 0.9) return true;
  }
  return false;
}

/** Detects the format by content, falling back to the extension. */
export function sniffFormat(data: Uint8Array, name: string): string | null {
  const byName = formatFromName(name)?.id || null;
  if (!data.length) return byName;
  const head = ascii(data, 0, 16);
  // Containers and pictures first: a ZIP of PDFs, or a picture with a PDF inside its metadata, is not a PDF.
  if (head.startsWith('PK\x03\x04') || head.startsWith('PK\x05\x06')) {
    if (Lexer.find(data, 'application/x-quillfolio-review', 0, 200) >= 0) return 'qfr';
    return byName === 'qfr' ? 'qfr' : 'zip';
  }
  if (data[0] === 0x89 && head.slice(1, 4) === 'PNG') return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && ascii(data, 8, 12) === 'WEBP') return 'webp';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'tiff';
  if (isBmp(data)) return 'bmp';
  if (head.startsWith('%FDF-')) return 'fdf';
  // A PDF header where the standard wants it (the first 1024 bytes).
  if (pdfHeaderIn(data, 0, 1024, byName)) return 'pdf';
  const text =(() => { try { return decodeXml(data.subarray(0, 4096)); } catch { return ascii(data, 0, 4096); } })();
  // XFDF and SVG by their root element, not by a mention somewhere in a text.
  const root = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/i.exec(text);
  const rootName = root ? root[2].toLowerCase() : '';
  if (rootName === 'xfdf') return 'xfdf';
  if (rootName === 'svg') return 'svg';
  if (/^\s*<(!doctype html|html|head|body)/i.test(text)) return 'html';
  if (/^\s*[{[]/.test(text)) { try { JSON.parse(new TextDecoder('utf-8').decode(data)); return 'json'; } catch { /* */ } }
  // A PDF behind more leading junk (up to 64 KB).
  if (pdfHeaderIn(data, 1024, 65536, byName)) return 'pdf';
  if (byName) return byName;
  // Mostly printable → text; Markdown if it has headings.
  if (printableShare(data, 0, Math.min(data.length, 2048)) > 0.95) return /^#{1,6}\s/m.test(text) ? 'md' : 'txt';
  // Bytes that mention PDF objects but no header: a damaged PDF.
  if (Lexer.find(data, ' obj', 0) >= 0 && Lexer.find(data, 'endobj', 0) >= 0) return 'pdf';
  return byName;
}

export interface OpenResult { doc: PdfDocument; format: string; warnings: string[]; repair?: RepairReport; bytes: Uint8Array }

export class PasswordNeededError extends PasswordNeeded {}

/** Opens any supported file as a PdfDocument: PDFs directly (repairing when needed), images and text by conversion. */
export async function openAsPdf(data: Uint8Array, name: string, opts: { password?: string; repair?: boolean } = {}): Promise<OpenResult> {
  const format = sniffFormat(data, name) || 'pdf';
  const warnings: string[] = [];
  if (format === 'pdf') {
    if (!opts.repair) {
      try {
        const doc = PdfDocument.load(data, { password: opts.password });
        warnings.push(...doc.report.warnings);
        if (!doc.report.reconstructed && doc.pageCount > 0) return { doc, format, warnings, bytes: data };
        // Damaged: run the full pipeline and keep whichever is better.
      } catch (e) {
        // A load that throws (no catalog even after reconstruction, …) is one failed method; the pipeline goes on.
        if (e instanceof PasswordNeeded) throw e;
        warnings.push(String((e as any)?.message || e));
      }
    }
    const { repairPdf } = await import('../pdf/repair');
    const report = repairPdf(data, name, { password: opts.password });
    if (!report.doc || !report.bytes) throw new Error(report.summary);
    return { doc: report.doc, format, warnings, repair: report, bytes: report.bytes };
  }
  if (format === 'jpeg' || format === 'png' || format === 'gif' || format === 'webp' || format === 'bmp' || format === 'tiff' || format === 'svg') {
    const doc = PdfDocument.create();
    // One page per picture (a multi-page TIFF gives several), added as each is decoded.
    warnings.push(...(await eachImageSpec(data, format, (spec) => { addImagePageOriented(doc, spec, { paper: 'image' }); })));
    doc.ensureInfo().set('Title', PdfString.fromText(name.replace(/\.[^.]+$/, '')));
    const bytes = doc.save({ incremental: false });
    return { doc: PdfDocument.load(bytes), format, warnings, bytes };
  }
  if (format === 'txt' || format === 'md' || format === 'html') {
    let text = decodeXml(data);
    if (format === 'html') text = htmlToText(text);
    const doc = PdfDocument.create();
    addTextPages(doc, text, { title: name.replace(/\.[^.]+$/, ''), paper: PAPER.letter, font: 'Helvetica' });
    const bytes = doc.save({ incremental: false });
    return { doc: PdfDocument.load(bytes), format, warnings, bytes };
  }
  if (format === 'zip' || format === 'qfr') {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(data);
    const pdfs = Object.keys(zip.files).filter((n) => /\.pdf$/i.test(n) && !zip.files[n].dir).sort();
    if (!pdfs.length) throw new Error('The archive holds no PDF files.');
    const first = await zip.file(pdfs[0])!.async('uint8array');
    const r = await openAsPdf(first, pdfs[0], opts);
    warnings.push(...r.warnings);
    let changed = false;
    if (format === 'qfr') {
      const xfdf = Object.keys(zip.files).find((n) => /\.xfdf$/i.test(n));
      if (xfdf) {
        // The package's PDF normally holds its comments already; only ones it lacks are added.
        try { const { importXfdf } = await import('../pdf/ops/annots'); const n = importXfdf(r.doc, await zip.file(xfdf)!.async('string')); if (n) { changed = true; warnings.push(`${n} comment(s) from the review package applied.`); } }
        catch (e) { warnings.push(`The comments of the review package could not be read: ${(e as any)?.message || e}`); }
      }
    } else if (pdfs.length > 1) {
      const { importPages } = await import('../pdf/ops/pages');
      let added = 1;
      for (const n of pdfs.slice(1)) {
        try { const d = PdfDocument.load(await zip.file(n)!.async('uint8array')); importPages(d, r.doc, d.pages.map((_, i) => i)); changed = true; added++; }
        catch { warnings.push(`${n} could not be read.`); }
      }
      warnings.push(`${added} PDFs from the archive were combined.`);
    }
    if (!changed) return { ...r, warnings, format };
    // The document now differs from the first PDF's bytes: hand back bytes that match it.
    const bytes = r.doc.save({ incremental: false });
    return { doc: PdfDocument.load(bytes, { password: opts.password }), format, warnings, repair: r.repair, bytes };
  }
  if (format === 'xfdf' || format === 'fdf' || format === 'json') throw new Error(`${formatById(format)?.label || format} holds form or comment data: open the PDF first, then use Forms ▸ Import Data or Comment ▸ Import Comments.`);
  throw new Error(`Anne's Folio cannot open ${name}.`);
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach((e) => e.remove());
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3) out.push((n.textContent || '').replace(/\s+/g, ' '));
      else if (n.nodeType === 1) {
        const e = n as Element;
        const tag = e.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) { out.push('\n\n' + '#'.repeat(+tag[1]) + ' '); walk(e); out.push('\n\n'); }
        else if (tag === 'li') { out.push('\n- '); walk(e); }
        else if (tag === 'br') out.push('\n');
        else if (/^(p|div|tr|section|article|blockquote|pre|ul|ol|table|header|footer|main)$/.test(tag)) { out.push('\n\n'); walk(e); out.push('\n\n'); }
        else walk(e);
      }
    }
  };
  walk(doc.body);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------------------------------
// Pictures: orientation and resolution from the file, then a page

/** An image for a page, with what its file says about how to show it. */
export type ImageSpecEx = ImageSpec & { /** EXIF orientation 1–8 of a JPEG kept as is (pictures decoded by the browser are already upright). */ orientation?: number; /** Pixels per inch the file declares. */ dpi?: number };

const saneDpi = (v: number): number | undefined => (isFinite(v) && v >= 20 && v <= 4800 ? v : undefined);

/** EXIF orientation and declared resolution of a JPEG (JFIF density, or EXIF XResolution with its unit). */
export function jpegMeta(b: Uint8Array): { orientation: number; dpi?: number } {
  let orientation = 1, dpi: number | undefined;
  if (b[0] !== 0xff || b[1] !== 0xd8) return { orientation };
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    if (m === 0xda || m === 0xd9) break; // image data: no more metadata
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) break;
    const s = i + 4, e = Math.min(b.length, i + 2 + len);
    if (m === 0xe0 && ascii(b, s, s + 5) === 'JFIF\0' && s + 12 <= e) {
      const units = b[s + 7], xd = (b[s + 8] << 8) | b[s + 9];
      if (dpi === undefined) dpi = saneDpi(units === 1 ? xd : units === 2 ? xd * 2.54 : NaN);
    } else if (m === 0xe1 && ascii(b, s, s + 6) === 'Exif\0\0') {
      const t = s + 6;
      const le = b[t] === 0x49 && b[t + 1] === 0x49;
      const r16 = (o: number) => (o + 2 <= e ? (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]) : 0);
      const r32 = (o: number) => (o + 4 <= e ? (le ? u32le(b, o) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0) : 0);
      if ((le || (b[t] === 0x4d && b[t + 1] === 0x4d)) && r16(t + 2) === 42) {
        const ifd = t + r32(t + 4);
        const n = Math.min(r16(ifd), 200);
        let xres = 0, unit = 2;
        for (let k = 0; k < n; k++) {
          const p = ifd + 2 + k * 12, tag = r16(p);
          if (tag === 0x0112) { const v = r16(p + 8); if (v >= 1 && v <= 8) orientation = v; }
          else if (tag === 0x011a) { const off = t + r32(p + 8), den = r32(off + 4); xres = den ? r32(off) / den : 0; }
          else if (tag === 0x0128) unit = r16(p + 8);
        }
        // EXIF resolution is the more specific statement when both are present.
        const d = saneDpi(unit === 3 ? xres * 2.54 : unit === 2 ? xres : NaN);
        if (d) dpi = d;
      }
    }
    i += 2 + len;
  }
  return { orientation, dpi };
}

/** Pixels per inch a PNG (pHYs chunk, unit metre) or a BMP (pixels per metre) declares. */
export function rasterDpi(b: Uint8Array): number | undefined {
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') {
    const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    for (let i = 8; i + 12 <= b.length;) {
      const len = be32(i), type = ascii(b, i + 4, i + 8);
      if (type === 'IDAT' || type === 'IEND') break;
      if (type === 'pHYs' && len >= 9 && i + 17 <= b.length) return b[i + 16] === 1 ? saneDpi(be32(i + 8) * 0.0254) : undefined;
      i += 12 + len;
    }
    return undefined;
  }
  if (isBmp(b) && u32le(b, 14) >= 40 && b.length >= 46) return saneDpi(u32le(b, 38) * 0.0254);
  return undefined;
}

/** Maps the unit square of an image onto a w×h box so that it shows upright for the given EXIF orientation. */
export function orientationMatrix(orientation: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-w, 0, 0, h, w, 0]; // mirrored left-right
    case 3: return [-w, 0, 0, -h, w, h]; // upside down
    case 4: return [w, 0, 0, -h, 0, h]; // mirrored top-bottom
    case 5: return [0, -h, -w, 0, w, h]; // transposed
    case 6: return [0, -h, w, 0, 0, h]; // to be turned 90° clockwise
    case 7: return [0, h, w, 0, 0, 0]; // transverse
    case 8: return [0, h, -w, 0, w, 0]; // to be turned 90° counter-clockwise
    default: return [w, 0, 0, h, 0, 0];
  }
}

/**
 * Adds a page for an image: sized by the image's own resolution (96 dpi when it states none, or
 * `opts.dpi` to override), turned as its EXIF orientation asks. With a `paper` size the image is
 * fitted and centred on it.
 */
export function addImagePageOriented(doc: PdfDocument, spec: ImageSpecEx, opts: { paper?: [number, number] | 'image'; dpi?: number; at?: number } = {}): PageInfo {
  const o = spec.orientation && spec.orientation >= 1 && spec.orientation <= 8 ? spec.orientation : 1;
  const dpi = opts.dpi || spec.dpi || 96;
  const turned = o >= 5;
  let iw = ((turned ? spec.height : spec.width) / dpi) * 72, ih = ((turned ? spec.width : spec.height) / dpi) * 72;
  // A page side below 3 points is not a usable page (readers and this engine fall back to a default size).
  const tiny = Math.min(iw, ih);
  if (tiny > 0 && tiny < 3) { iw *= 3 / tiny; ih *= 3 / tiny; }
  const paper: [number, number] = !opts.paper || opts.paper === 'image' ? [iw, ih] : opts.paper;
  const page = addBlankPage(doc, paper, opts.at);
  const name = ensureXObject(doc, page, 'Im', imageXObject(doc, spec));
  const scale = Math.min(paper[0] / iw, paper[1] / ih, 1);
  const w = iw * scale, h = ih * scale;
  const m = orientationMatrix(o, w, h);
  m[4] += (paper[0] - w) / 2; m[5] += (paper[1] - h) / 2;
  doc.setPageContent(page, new TextEncoder().encode(`q ${m.map(fmtNum).join(' ')} cm /${name} Do Q`));
  return page;
}

/** Decodes an image file into an ImageSpec using the browser (JPEG stays JPEG). For a multi-page TIFF this is its first page. */
export async function imageSpecFromBytes(data: Uint8Array, format?: string): Promise<ImageSpecEx> {
  let first: ImageSpecEx | null = null;
  await eachImageSpec(data, format, (spec) => { first = first || spec; }, 1);
  return first!;
}

/**
 * Hands every picture of a file to `use`, one at a time (one picture, except for multi-page TIFFs;
 * a page is decoded only when its turn comes, so memory holds one page). Returns warnings about TIFF
 * pages that were left out. Throws when nothing can be decoded.
 */
export async function eachImageSpec(data: Uint8Array, format: string | undefined, use: (spec: ImageSpecEx) => void, maxPages = 500): Promise<string[]> {
  const f = format || sniffFormat(data, '') || 'png';
  const warnings: string[] = [];
  if (f === 'jpeg') {
    const info = jpegInfo(data);
    if (info) { const meta = jpegMeta(data); use({ kind: 'jpeg', data, width: info.width, height: info.height, gray: info.components === 1, cmyk: info.components === 4, orientation: meta.orientation, dpi: meta.dpi }); return warnings; }
  }
  if (f === 'tiff') {
    const { decodeTiff } = await import('./tiff');
    const t = decodeTiff(data, maxPages);
    let done = 0, unsupported = 0;
    for (const page of t ? t.pages : []) {
      const bmp = page.bmp();
      if (!bmp) { unsupported++; continue; }
      use({ ...(await bitmapSpec(bmp, 'image/bmp', false)), dpi: page.dpi ?? undefined });
      done++;
    }
    if (!done) throw new Error('This TIFF uses a feature Anne\'s Folio cannot read (strips of 8-bit grey, palette or RGB and 1-bit images, uncompressed, PackBits or LZW are supported; tiles, CMYK, fax and JPEG compression are not).');
    if (maxPages > 1 && unsupported) warnings.push(`${unsupported} of ${t!.total} pages of the TIFF use a feature Anne's Folio cannot read and were left out.`);
    if (maxPages > 1 && t!.total > t!.pages.length) warnings.push(`Only the first ${t!.pages.length} of ${t!.total} pages of the TIFF were converted.`);
    return warnings;
  }
  use({ ...(await bitmapSpec(data, formatById(f)?.mime || 'image/png', f === 'svg')), dpi: rasterDpi(data) });
  return warnings;
}

/**
 * An image that needs no special handling: a JPEG whose EXIF orientation is not "upright" is drawn
 * turned and re-encoded as JPEG (needs a browser). For callers that place the image themselves
 * (stamps, signatures) instead of using addImagePageOriented.
 */
export async function uprightImageSpec(spec: ImageSpecEx): Promise<ImageSpecEx> {
  if (spec.kind !== 'jpeg' || !spec.orientation || spec.orientation === 1) return spec;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return spec;
  const bmp = await createImageBitmap(new Blob([spec.data as BlobPart], { type: 'image/jpeg' })); // applies the EXIF orientation
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  if (!blob) return spec;
  const data = new Uint8Array(await blob.arrayBuffer());
  const info = jpegInfo(data);
  return info ? { kind: 'jpeg', data, width: info.width, height: info.height, gray: info.components === 1, dpi: spec.dpi } : spec;
}

async function bitmapSpec(bytes: Uint8Array, mime: string, svg: boolean): Promise<ImageSpec> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error('Image decoding needs a browser.');
  const blob = new Blob([bytes as BlobPart], { type: mime });
  const bmp = await (svg ? svgToBitmap(blob) : createImageBitmap(blob));
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const rgb = new Uint8Array(bmp.width * bmp.height * 3);
  const alpha = new Uint8Array(bmp.width * bmp.height);
  let hasAlpha = false;
  for (let i = 0, j = 0; i < id.data.length; i += 4, j += 3) { rgb[j] = id.data[i]; rgb[j + 1] = id.data[i + 1]; rgb[j + 2] = id.data[i + 2]; alpha[i / 4] = id.data[i + 3]; if (id.data[i + 3] < 255) hasAlpha = true; }
  return { kind: 'rgb', data: rgb, width: bmp.width, height: bmp.height, alpha: hasAlpha ? alpha : undefined };
}

async function svgToBitmap(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG could not be decoded')); img.src = url; });
    const w = img.naturalWidth || 800, h = img.naturalHeight || 600;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return createImageBitmap(c);
  } finally { URL.revokeObjectURL(url); }
}

export { PasswordNeeded };
