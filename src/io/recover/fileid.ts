/**
 * S2 File Identifier, ported from socrtwo/wordrecovery-SF (web/s2-file-id.js).
 *
 * Before any repair runs: identify the file by its magic numbers, scan the whole buffer for
 * embedded or concatenated files (for example a PDF fused onto a DOCX by a disk error),
 * separate the pieces, and recommend which S2 tool repairs any piece this program does not.
 */

export interface S2Program { key: string; name: string; url: string; handles: string[] }

export const PROGRAMS: S2Program[] = [
  { key: 'universal', name: 'Universal File Repair Tool', url: 'https://socrtwo.github.io/Universal-File-Repair-Tool/', handles: ['*'] },
  { key: 'corruptdocxrepair', name: 'CorruptDOCXRepair', url: 'https://socrtwo.github.io/CorruptDOCXRepair/', handles: ['docx'] },
  { key: 'quickwordrecovr', name: 'Quick Word Recovr', url: 'https://socrtwo.github.io/quickwordrecovr-SF/', handles: ['docx'] },
  { key: 'wordrecovery', name: 'Word Recovery', url: 'https://socrtwo.github.io/wordrecovery-SF/', handles: ['doc', 'docx'] },
  { key: 'damageddocx2txt', name: 'Damageddocx2txt', url: 'https://socrtwo.github.io/damageddocx2txt-SF/', handles: ['docx'] },
  { key: 'corruptexcelrec', name: 'S2 Recovery Tools for Microsoft Excel', url: 'https://socrtwo.github.io/corruptexcelrec-SF/', handles: ['xls', 'xlsx'] },
  { key: 'excelrcvryaddin', name: 'Excel Recovery Addin', url: 'https://socrtwo.github.io/excelrcvryaddin-SF/', handles: ['xls'] },
  { key: 'pptxrecovery', name: 'PPTX Recovery', url: 'https://socrtwo.github.io/pptxrecovery-SF/', handles: ['pptx'] },
  { key: 'oorecovery', name: 'OO Recovery (OpenDocument)', url: 'https://socrtwo.github.io/oorecovery-SF/', handles: ['odt', 'ods', 'odp', 'odg'] },
  { key: 'immortalzip', name: 'Immortal Zip', url: 'https://socrtwo.github.io/Immortal-Zip/', handles: ['zip', 'jar', 'apk', 'epub'] },
  { key: 'xmltrncatorfixr', name: 'XML Truncator-Fixer', url: 'https://socrtwo.github.io/xmltrncatorfixr-SF/app/', handles: ['xml', 'docx', 'xlsx', 'pptx'] },
  { key: 'savvyoffice', name: 'Savvy Repair for Microsoft Office', url: 'https://socrtwo.github.io/savvyoffice-SF/', handles: ['doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx'] },
  { key: 'coffice2txt', name: 'Coffice2txt', url: 'https://socrtwo.github.io/coffice2txt-SF/', handles: ['doc', 'xls', 'ppt', 'docx', 'xlsx', 'pptx'] },
  { key: 'crrptoffcxtrctr', name: 'Crrptoffcxtrctr (Office extractor)', url: 'https://socrtwo.github.io/crrptoffcxtrctr-SF/', handles: ['docx', 'xlsx', 'pptx'] },
  { key: 'saveofficedata', name: 'Saveofficedata', url: 'https://socrtwo.github.io/saveofficedata-SF/', handles: ['doc', 'xls', 'ppt'] },
  { key: 'filefixerbot', name: 'File Fixer Bot', url: 'https://socrtwo.github.io/file-fixer-bot/', handles: ['*'] },
];

const RECOMMEND_ORDER: Record<string, string[]> = {
  docx: ['corruptdocxrepair', 'quickwordrecovr', 'wordrecovery', 'xmltrncatorfixr', 'savvyoffice', 'crrptoffcxtrctr', 'damageddocx2txt', 'coffice2txt'],
  doc: ['wordrecovery', 'savvyoffice', 'coffice2txt', 'saveofficedata'],
  xls: ['corruptexcelrec', 'savvyoffice', 'excelrcvryaddin', 'coffice2txt', 'saveofficedata'],
  xlsx: ['corruptexcelrec', 'xmltrncatorfixr', 'savvyoffice', 'crrptoffcxtrctr', 'coffice2txt'],
  ppt: ['savvyoffice', 'coffice2txt', 'saveofficedata'],
  pptx: ['pptxrecovery', 'xmltrncatorfixr', 'savvyoffice', 'crrptoffcxtrctr', 'coffice2txt'],
  odt: ['oorecovery'], ods: ['oorecovery'], odp: ['oorecovery'], odg: ['oorecovery'],
  zip: ['immortalzip'], jar: ['immortalzip'], apk: ['immortalzip'], epub: ['immortalzip'],
  xml: ['xmltrncatorfixr'],
};

/** File kinds Anne's Folio itself opens. */
export const HANDLED_HERE = ['pdf', 'fdf', 'xml', 'txt', 'png', 'jpg', 'gif', 'tif', 'bmp', 'webp', 'zip', 'html'];

export const DESCRIPTIONS: Record<string, string> = {
  docx: 'Microsoft Word document (DOCX, Office Open XML)', xlsx: 'Microsoft Excel workbook (XLSX)', pptx: 'Microsoft PowerPoint presentation (PPTX)',
  ooxml: 'Office Open XML document (type unclear)', doc: 'Microsoft Word 97-2003 document (DOC)', xls: 'Microsoft Excel 97-2003 workbook (XLS)',
  ppt: 'Microsoft PowerPoint 97-2003 presentation (PPT)', msg: 'Microsoft Outlook message (MSG)', vsd: 'Microsoft Visio drawing (VSD)',
  ole: 'Office compound (OLE2) file, exact type unclear', odt: 'OpenDocument text (ODT)', ods: 'OpenDocument spreadsheet (ODS)',
  odp: 'OpenDocument presentation (ODP)', odg: 'OpenDocument drawing (ODG)', epub: 'EPUB e-book', jar: 'Java archive (JAR)', apk: 'Android package (APK)',
  zip: 'ZIP archive', pdf: 'PDF document', png: 'PNG image', gif: 'GIF image', jpg: 'JPEG image', tif: 'TIFF image', bmp: 'BMP image',
  rtf: 'Rich Text Format document (RTF)', '7z': '7-Zip archive', rar: 'RAR archive', gz: 'GZIP compressed data', xml: 'XML document',
  html: 'HTML document', sqlite: 'SQLite database', pst: 'Outlook data file (PST/OST)', wav: 'WAV audio', avi: 'AVI video', webp: 'WebP image',
  ogg: 'OGG media', flac: 'FLAC audio', mp3: 'MP3 audio', mp4: 'MP4 / QuickTime media', exe: 'Windows executable (EXE/DLL)',
  txt: 'Plain text', csv: 'Comma-separated values (CSV)', bin: 'Unrecognized binary data',
};

export const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint', pdf: 'application/pdf', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', zip: 'application/zip',
  xml: 'application/xml', txt: 'text/plain', html: 'text/html', odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
};

const programByKey = (key: string) => PROGRAMS.find((p) => p.key === key) || null;

export function recommend(ext: string, excludeKey?: string): S2Program[] {
  const out = (RECOMMEND_ORDER[ext] || []).filter((k) => k !== excludeKey).map(programByKey).filter((p): p is S2Program => !!p);
  if (!out.length && excludeKey !== 'universal') out.push(programByKey('universal')!);
  return out;
}

const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function matches(b: Uint8Array, off: number, sig: number[]): boolean {
  if (off < 0 || off + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[off + i] !== sig[i]) return false;
  return true;
}
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const utf16le = (s: string) => Array.from(s).flatMap((c) => [c.charCodeAt(0) & 0xff, 0]);
function indexOfBytes(b: Uint8Array, sig: number[], start = 0, end = b.length): number {
  const last = end - sig.length;
  for (let i = start; i <= last; i++) if (b[i] === sig[0] && matches(b, i, sig)) return i;
  return -1;
}

const SIG = {
  ZIP_LOCAL: [0x50, 0x4b, 0x03, 0x04], ZIP_EOCD: [0x50, 0x4b, 0x05, 0x06], ZIP_CDIR: [0x50, 0x4b, 0x01, 0x02], ZIP_SPAN: [0x50, 0x4b, 0x07, 0x08],
  OLE2: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], PDF: [0x25, 0x50, 0x44, 0x46, 0x2d], PNG: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  GIF87: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], GIF89: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], JPEG: [0xff, 0xd8, 0xff], RTF: [0x7b, 0x5c, 0x72, 0x74, 0x66],
  SEVENZ: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], RAR: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], GZIP: [0x1f, 0x8b, 0x08], XMLDECL: [0x3c, 0x3f, 0x78, 0x6d, 0x6c],
  TIFF_LE: [0x49, 0x49, 0x2a, 0x00], TIFF_BE: [0x4d, 0x4d, 0x00, 0x2a], SQLITE: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66], RIFF: [0x52, 0x49, 0x46, 0x46],
  OGG: [0x4f, 0x67, 0x67, 0x53], FLAC: [0x66, 0x4c, 0x61, 0x43], ID3: [0x49, 0x44, 0x33], PST: [0x21, 0x42, 0x44, 0x4e],
};

function refineZip(b: Uint8Array, start: number, end: number): string {
  const has = (s: string) => indexOfBytes(b, ascii(s), start, end) !== -1;
  if (has('mimetypeapplication/vnd.oasis.opendocument.text')) return 'odt';
  if (has('mimetypeapplication/vnd.oasis.opendocument.spreadsheet')) return 'ods';
  if (has('mimetypeapplication/vnd.oasis.opendocument.presentation')) return 'odp';
  if (has('mimetypeapplication/vnd.oasis.opendocument.graphics')) return 'odg';
  if (has('mimetypeapplication/epub+zip')) return 'epub';
  const isOoxml = has('[Content_Types].xml');
  if (has('word/document.xml') || has('word/_rels/')) return 'docx';
  if (has('xl/workbook.xml') || has('xl/_rels/')) return 'xlsx';
  if (has('ppt/presentation.xml') || has('ppt/slides/')) return 'pptx';
  if (isOoxml) return 'ooxml';
  if (has('AndroidManifest.xml')) return 'apk';
  if (has('META-INF/MANIFEST.MF')) return 'jar';
  if (has('content.xml') && has('META-INF/manifest.xml')) {
    if (has('office:spreadsheet')) return 'ods';
    if (has('office:presentation')) return 'odp';
    return 'odt';
  }
  return 'zip';
}

function walkZipEntries(b: Uint8Array, start: number): { end: number; clean: boolean } {
  let pos = start, verified = start;
  while (pos + 30 <= b.length && matches(b, pos, SIG.ZIP_LOCAL)) {
    verified = pos;
    const flags = u16le(b, pos + 6), csize = u32le(b, pos + 18), nameLen = u16le(b, pos + 26), extraLen = u16le(b, pos + 28);
    const dataStart = pos + 30 + nameLen + extraLen;
    if (nameLen === 0 || dataStart > b.length) break;
    verified = dataStart;
    if (flags & 0x08) {
      const dd = indexOfBytes(b, SIG.ZIP_SPAN, dataStart);
      if (dd === -1) { pos = dataStart; break; }
      pos = dd + 16;
    } else {
      const next = dataStart + csize;
      if (next > b.length) { pos = dataStart; break; }
      pos = next;
    }
  }
  if (matches(b, pos, SIG.ZIP_CDIR)) verified = pos;
  while (pos + 46 <= b.length && matches(b, pos, SIG.ZIP_CDIR)) pos = pos + 46 + u16le(b, pos + 28) + u16le(b, pos + 30) + u16le(b, pos + 32);
  if (pos + 22 <= b.length && matches(b, pos, SIG.ZIP_EOCD)) return { end: Math.min(pos + 22 + u16le(b, pos + 20), b.length), clean: true };
  return { end: Math.min(verified, b.length), clean: false };
}

function refineOle(b: Uint8Array, start: number, end: number): string {
  const has16 = (s: string) => indexOfBytes(b, utf16le(s), start, end) !== -1;
  if (has16('WordDocument')) return 'doc';
  if (has16('Workbook') || has16('Book')) return 'xls';
  if (has16('PowerPoint Document')) return 'ppt';
  if (has16('VisioDocument')) return 'vsd';
  if (has16('__properties_version1.0') || has16('__recip_version1.0')) return 'msg';
  return 'ole';
}

function looksLikeText(b: Uint8Array, start: number, end: number): boolean {
  const n = Math.min(end - start, 4096);
  if (n <= 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = b[start + i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
    else if (c === 0) return false;
  }
  return printable / n > 0.95;
}

export interface Identification { ext: string; description: string; confidence: 'high' | 'medium' | 'low' }

export function identifyAt(b: Uint8Array, start = 0, end = b.length): Identification {
  const res = (ext: string, confidence: Identification['confidence'] = 'high') => ({ ext, description: DESCRIPTIONS[ext] || ext, confidence });
  if (matches(b, start, SIG.ZIP_LOCAL) || matches(b, start, SIG.ZIP_EOCD)) return res(refineZip(b, start, end));
  if (matches(b, start, SIG.OLE2)) return res(refineOle(b, start, end));
  if (matches(b, start, SIG.PDF)) return res('pdf');
  if (matches(b, start, SIG.PNG)) return res('png');
  if (matches(b, start, SIG.GIF87) || matches(b, start, SIG.GIF89)) return res('gif');
  if (matches(b, start, SIG.JPEG)) return res('jpg');
  if (matches(b, start, SIG.RTF)) return res('rtf');
  if (matches(b, start, SIG.SEVENZ)) return res('7z');
  if (matches(b, start, SIG.RAR)) return res('rar');
  if (matches(b, start, SIG.GZIP)) return res('gz');
  if (matches(b, start, SIG.SQLITE)) return res('sqlite');
  if (matches(b, start, SIG.PST)) return res('pst');
  if (matches(b, start, SIG.TIFF_LE) || matches(b, start, SIG.TIFF_BE)) return res('tif');
  if (matches(b, start, SIG.OGG)) return res('ogg');
  if (matches(b, start, SIG.FLAC)) return res('flac');
  if (matches(b, start, SIG.ID3)) return res('mp3', 'medium');
  if (matches(b, start, SIG.RIFF)) {
    if (matches(b, start + 8, ascii('WAVE'))) return res('wav');
    if (matches(b, start + 8, ascii('AVI '))) return res('avi');
    if (matches(b, start + 8, ascii('WEBP'))) return res('webp');
    return res('bin', 'low');
  }
  if (matches(b, start + 4, ascii('ftyp'))) return res('mp4');
  if (b[start] === 0x4d && b[start + 1] === 0x5a) return res('exe', 'medium');
  if (b[start] === 0x42 && b[start + 1] === 0x4d && start === 0) return res('bmp', 'medium');
  if (matches(b, start, SIG.XMLDECL)) return res('xml');
  if (looksLikeText(b, start, end)) {
    let head = '';
    for (let i = start; i < Math.min(end, start + 512); i++) head += String.fromCharCode(b[i]);
    const lower = head.toLowerCase();
    if (lower.includes('<!doctype html') || lower.includes('<html')) return res('html');
    if (lower.includes('<?xml') || /^\s*</.test(head)) return res('xml', 'medium');
    return res('txt', 'medium');
  }
  return res('bin', 'low');
}

const BOUNDARY_SIGS: { ext: string; sig: number[] }[] = [
  { ext: 'zip', sig: SIG.ZIP_LOCAL }, { ext: 'ole', sig: SIG.OLE2 }, { ext: 'pdf', sig: SIG.PDF }, { ext: 'png', sig: SIG.PNG },
  { ext: 'gif', sig: SIG.GIF87 }, { ext: 'gif', sig: SIG.GIF89 },
  { ext: 'jpg', sig: [0xff, 0xd8, 0xff, 0xe0] }, { ext: 'jpg', sig: [0xff, 0xd8, 0xff, 0xe1] }, { ext: 'jpg', sig: [0xff, 0xd8, 0xff, 0xdb] },
  { ext: 'jpg', sig: [0xff, 0xd8, 0xff, 0xee] }, { ext: 'jpg', sig: [0xff, 0xd8, 0xff, 0xc0] }, { ext: 'jpg', sig: [0xff, 0xd8, 0xff, 0xe2] },
  { ext: 'rtf', sig: SIG.RTF }, { ext: '7z', sig: SIG.SEVENZ }, { ext: 'rar', sig: SIG.RAR }, { ext: 'sqlite', sig: SIG.SQLITE }, { ext: 'pst', sig: SIG.PST },
];

const STREAM = ascii('stream'), EOF_MARK = ascii('%%EOF');
/** True when `pos` comes right after a PDF end-of-file marker (only line ends in between). */
function afterPdfEof(b: Uint8Array, pos: number): boolean {
  let i = pos - 1;
  while (i >= 0 && (b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x20)) i--;
  return matches(b, i - 4, EOF_MARK);
}
/** True when `pos` lies in the data of a PDF stream: the nearest "stream" keyword before it is not an "endstream". */
function insidePdfStream(b: Uint8Array, start: number, pos: number): boolean {
  const floor = Math.max(start, pos - (1 << 20));
  for (let i = pos - 6; i >= floor; i--) if (b[i] === 0x73 && matches(b, i, STREAM)) return !(b[i - 3] === 0x65 && b[i - 2] === 0x6e && b[i - 1] === 0x64);
  return floor > start; // nothing within 1 MB: a stream longer than that
}

interface SegState { start: number; kind: string; walkClean?: boolean; guard: number; /** JPEG: where its first end-of-image marker is (-1 none), found once. */ eoi?: number }
function segState(b: Uint8Array, start: number): SegState {
  if (matches(b, start, SIG.ZIP_LOCAL)) { const w = walkZipEntries(b, start); return { start, kind: 'zip', walkClean: w.clean, guard: Math.max(start + 4, w.end) }; }
  if (matches(b, start, SIG.PDF)) return { start, kind: 'pdf', guard: start + 5 };
  if (matches(b, start, SIG.OLE2)) return { start, kind: 'ole', guard: start + 512 };
  if (matches(b, start, SIG.JPEG)) return { start, kind: 'jpg', guard: start + 4 };
  return { start, kind: 'other', guard: start + 1 };
}

export interface Segment extends Identification {
  index: number; offset: number; length: number; bytes: Uint8Array;
  handledHere?: boolean; suggestedName?: string; recommended?: S2Program[];
}

export function scan(b: Uint8Array): { segments: Segment[]; multiple: boolean } {
  const starts = [0];
  let cur = segState(b, 0);
  let pos = Math.max(1, cur.guard);
  while (pos < b.length) {
    let hit: { ext: string; sig: number[] } | null = null;
    for (const s of BOUNDARY_SIGS) if (matches(b, pos, s.sig)) { hit = s; break; }
    if (hit) {
      let accept = true;
      if (cur.kind === 'zip') accept = hit.ext === 'zip' ? !!cur.walkClean : !!cur.walkClean || hit.sig.length >= 5;
      else if (cur.kind === 'ole') accept = (pos - cur.start) % 512 === 0 || hit.sig.length >= 6;
      else if (cur.kind === 'jpg' && hit.ext === 'jpg') { if (cur.eoi === undefined) cur.eoi = indexOfBytes(b, [0xff, 0xd9], cur.start); accept = cur.eoi !== -1 && cur.eoi < pos; }
      // A PDF holds JPEGs, embedded files and the like in its streams: those are not other files. A
      // signature inside stream data only counts when a whole, consistent ZIP starts there (a
      // truncated PDF with an archive fused on); after the PDF's %%EOF anything counts.
      else if (cur.kind === 'pdf') accept = afterPdfEof(b, pos) || !insidePdfStream(b, cur.start, pos) || (hit.ext === 'zip' && walkZipEntries(b, pos).clean);
      if (accept) { starts.push(pos); cur = segState(b, pos); pos = Math.max(pos + 1, cur.guard); continue; }
    }
    pos++;
  }
  const segments = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : b.length;
    return { index: i, offset: start, length: end - start, ...identifyAt(b, start, end), bytes: b.subarray(start, end) };
  });
  return { segments, multiple: segments.length > 1 };
}

export interface FileIdReport {
  fileName: string;
  primary: Identification;
  segments: Segment[];
  matching: Segment[];
  foreign: Segment[];
  multiple: boolean;
  mismatch: boolean;
  proceedBytes: Uint8Array;
}

export function analyze(bytes: Uint8Array, fileName = 'recovered-file'): FileIdReport {
  const base = fileName.replace(/\.[A-Za-z0-9]{1,6}$/, '');
  const { segments, multiple } = scan(bytes);
  const matching: Segment[] = [], foreign: Segment[] = [];
  for (const seg of segments) {
    seg.handledHere = HANDLED_HERE.includes(seg.ext);
    seg.suggestedName = multiple ? `${base}.part${seg.index + 1}.${seg.ext}` : `${base}.${seg.ext}`;
    if (seg.handledHere) matching.push(seg);
    else { seg.recommended = recommend(seg.ext); foreign.push(seg); }
  }
  // Prefer a document segment over loose text or XML that happens to precede it.
  const docKinds = ['pdf', 'fdf', 'zip'];
  const proceed = matching.find((m) => docKinds.includes(m.ext)) || matching[0] || segments[0];
  if (proceed && matching[0] !== proceed) { matching.splice(matching.indexOf(proceed), 1); matching.unshift(proceed); }
  return {
    fileName, primary: segments[0], segments, matching, foreign, multiple,
    mismatch: !HANDLED_HERE.includes(segments[0].ext), proceedBytes: proceed ? proceed.bytes : bytes,
  };
}
