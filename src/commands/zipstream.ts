/**
 * A ZIP archive written one file at a time (stored, not compressed, as zipOf writes PDFs): each file's bytes
 * become part of the archive when added, so a caller can let go of whatever produced them before making
 * the next one. The parts are handed out as a list for a Blob, never joined into one more copy here.
 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Without ZIP64 an archive holds at most 65,535 files and 4 GB. */
const MAX_FILES = 0xffff, MAX_OFFSET = 0xffffffff;

export class ZipWriter {
  private parts: Uint8Array[] = [];
  private central: Uint8Array[] = [];
  private offset = 0;
  private count = 0;
  private readonly time: number;
  private readonly date: number;

  constructor(when = new Date()) {
    this.time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
    this.date = (Math.max(0, when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  }

  /** Adds a file. `name` must already be unique in the archive. */
  add(name: string, data: Uint8Array): void {
    if (this.count >= MAX_FILES) throw new Error('A ZIP file can hold at most 65,535 files. Split into fewer parts.');
    if (this.offset + data.length + 30 + name.length * 3 > MAX_OFFSET) throw new Error('The parts add up to more than 4 GB, more than a ZIP file can hold. Split into fewer or smaller parts, or open them as documents.');
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed: 2.0
    lv.setUint16(6, 0x0800, true); // the name is UTF-8
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, this.time, true); lv.setUint16(12, this.date, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, this.time, true); cv.setUint16(14, this.date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true); // extra, comment, disk, internal attributes: 0
    cv.setUint32(42, this.offset, true);
    cen.set(nameBytes, 46);
    this.parts.push(local, data);
    this.central.push(cen);
    this.offset += local.length + data.length;
    this.count++;
  }

  /** The archive, as the pieces of a Blob. The writer is empty afterwards. */
  finish(): Uint8Array[] {
    let size = 0;
    for (const c of this.central) size += c.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true); ev.setUint16(10, this.count, true);
    ev.setUint32(12, size, true); ev.setUint32(16, this.offset, true);
    const out = [...this.parts, ...this.central, end];
    this.parts = []; this.central = []; this.offset = 0; this.count = 0;
    return out;
  }
}
