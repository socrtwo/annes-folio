import { describe, it, expect, vi } from 'vitest';
import { createCipheriv, createHash, randomBytes as nodeRandom } from 'node:crypto';
import { PdfDocument } from '../../src/pdf/document';
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, bytesOf, concat, latin1 } from '../../src/pdf/objects';
import { SecurityHandler } from '../../src/pdf/crypt';
import { aesCbcDecrypt, aesCbcDecryptNoPad, aesCbcEncrypt, aesCbcEncryptNoPad, hex, md5, randomBytes, sha384, sha512 } from '../../src/pdf/hash';
import { deflateZlib } from '../../src/pdf/filters';
import { serialize } from '../../src/pdf/writer';
import { addTextPage, makeTextPdf } from '../../src/pdf/build';
import { readMetadata, writeMetadata } from '../../src/pdf/structure';
import { aes128SamePw, rc4NoId, rc4SamePw } from './fix-core-fixtures';
import { eq } from './fix-core-helpers';

const resolve = (o: PdfObj | undefined): PdfObj => o ?? null;

describe('AES and SHA-2 (performance list, contract C7)', () => {
  it('AES-CBC agrees with node:crypto for all three key sizes', () => {
    for (const bytes of [16, 24, 32]) {
      const key = new Uint8Array(nodeRandom(bytes)), iv = new Uint8Array(nodeRandom(16)), data = new Uint8Array(nodeRandom(16 * 65));
      const c = createCipheriv(`aes-${bytes * 8}-cbc`, key, iv); c.setAutoPadding(false);
      const ref = new Uint8Array(Buffer.concat([c.update(data), c.final()]));
      expect(eq(aesCbcEncryptNoPad(key, iv, data), ref), `encrypt ${bytes}`).toBe(true);
      expect(eq(aesCbcDecryptNoPad(key, iv, ref), data), `decrypt ${bytes}`).toBe(true);
      const msg = new Uint8Array(nodeRandom(77));
      expect(eq(aesCbcDecrypt(key, aesCbcEncrypt(key, msg)), msg)).toBe(true);
    }
  });
  it('a key of the wrong length is a clear error, not a TypeError deep in the key schedule', () => {
    expect(() => aesCbcDecrypt(new Uint8Array(0), new Uint8Array(48))).toThrow(/AES key must be 16, 24 or 32 bytes/);
    expect(() => aesCbcEncrypt(new Uint8Array(5), new Uint8Array(3))).toThrow(/AES key/);
  });
  it('SHA-384 and SHA-512 agree with node:crypto at the padding boundaries', () => {
    for (const len of [0, 1, 111, 112, 113, 127, 128, 129, 255, 256, 1000, 15296]) {
      const d = new Uint8Array(nodeRandom(len));
      expect(hex(sha512(d)), `sha512 ${len}`).toBe(createHash('sha512').update(d).digest('hex'));
      expect(hex(sha384(d)), `sha384 ${len}`).toBe(createHash('sha384').update(d).digest('hex'));
    }
  });
  it('checks an AES-256 (R6) password in well under the old half second', () => {
    const out = PdfDocument.load(makeTextPdf(['x'])).save({ incremental: false, encrypt: { userPassword: 'user', ownerPassword: 'owner', permissions: {} } });
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) expect(PdfDocument.load(out, { password: 'owner' }).securityInfo?.ownerAccess).toBe(true);
    expect((Date.now() - t0) / 3).toBeLessThan(400);
  });
  it('randomBytes refuses to fall back to Math.random', () => {
    expect(randomBytes(32).length).toBe(32);
    vi.stubGlobal('crypto', undefined);
    try { expect(() => randomBytes(8)).toThrow(/secure random/); } finally { vi.unstubAllGlobals(); }
  });
});

describe('what is and is not encrypted (finding 5)', () => {
  const withMeta = () => { const d = PdfDocument.load(makeTextPdf(['Secret'])); writeMetadata(d, { title: 'My Title' }); return d; };
  it('metadata stays readable when "encrypt the metadata" is off', () => {
    const out = withMeta().save({ incremental: false, encrypt: { userPassword: 'u', ownerPassword: 'o', permissions: {}, encryptMetadata: false } });
    expect(latin1(out)).toContain('<x:xmpmeta'); // in the clear in the file
    expect(latin1(out)).not.toContain('Secret');
    const back = PdfDocument.load(out, { password: 'u' });
    expect(back.securityInfo?.encryptMetadata).toBe(false);
    expect(readMetadata(back).xmp).toContain('My Title');
    // and through an incremental update of that file
    writeMetadata(back, { title: 'Second Title' });
    expect(readMetadata(PdfDocument.load(back.save({ incremental: true }), { password: 'u' })).xmp).toContain('Second Title');
  });
  it('metadata is encrypted when it is on', () => {
    const out = withMeta().save({ incremental: false, encrypt: { userPassword: 'u', ownerPassword: 'o', permissions: {} } });
    expect(latin1(out)).not.toContain('<x:xmpmeta');
    expect(readMetadata(PdfDocument.load(out, { password: 'u' })).xmp).toContain('My Title');
  });
  it('a stream with an Identity crypt filter is written as it is read: not encrypted', () => {
    const { handler } = SecurityHandler.createAes256('', 'o', {}, md5(bytesOf('id')));
    const s = new PdfStream(new Dict({ Filter: [Name.get('Crypt')], DecodeParms: [new Dict({ Name: Name.get('Identity') })] }), bytesOf('in the clear'));
    const enc = handler.encryptObject(s, new Ref(5, 0)) as PdfStream;
    expect(latin1(enc.raw)).toBe('in the clear');
    expect(latin1((handler.decryptObject(enc, new Ref(5, 0)) as PdfStream).raw)).toBe('in the clear');
    const other = handler.encryptObject(new PdfStream(new Dict(), bytesOf('secret')), new Ref(6, 0)) as PdfStream;
    expect(latin1(other.raw)).not.toContain('secret');
  });
  it('strings in a cross-reference stream dictionary (/ID) are left alone', () => {
    const { handler } = SecurityHandler.createAes256('', 'o', {}, md5(bytesOf('id')));
    const x = new PdfStream(new Dict({ Type: Name.get('XRef'), ID: [new PdfString(bytesOf('0123456789abcdef0123456789abcdef'), true)] }), new Uint8Array(4));
    expect(handler.decryptObject(x, new Ref(9, 0))).toBe(x);
  });
});

describe('crypt filter parameters (lower-priority list)', () => {
  const dictV4 = (cf: Record<string, PdfObj>, extra: Record<string, PdfObj> = {}) => new Dict({ Filter: Name.get('Standard'), V: 4, R: 4, P: -1, CF: new Dict({ StdCF: new Dict(cf) }), StmF: Name.get('StdCF'), StrF: Name.get('StdCF'), ...extra });
  it('AESV2 always means a 128-bit key, whatever /Length says or does not say', () => {
    expect(new SecurityHandler(dictV4({ CFM: Name.get('AESV2') }), new Uint8Array(0), resolve).length).toBe(128);
    expect(new SecurityHandler(dictV4({ CFM: Name.get('AESV2'), Length: 40 }), new Uint8Array(0), resolve).length).toBe(128);
  });
  it('a crypt filter /Length is bytes below 40 and bits from 40 up', () => {
    expect(new SecurityHandler(dictV4({ CFM: Name.get('V2'), Length: 16 }), new Uint8Array(0), resolve).length).toBe(128);
    expect(new SecurityHandler(dictV4({ CFM: Name.get('V2'), Length: 5 }), new Uint8Array(0), resolve).length).toBe(40);
    expect(new SecurityHandler(dictV4({ CFM: Name.get('V2'), Length: 40 }), new Uint8Array(0), resolve).length).toBe(40);
    expect(new SecurityHandler(dictV4({ CFM: Name.get('V2'), Length: 128 }), new Uint8Array(0), resolve).length).toBe(128);
  });
  it('/EFF names the method for embedded file streams only', () => {
    const { dict, handler } = SecurityHandler.createAes256('', 'o', {}, md5(bytesOf('id')));
    dict.set('EFF', Name.get('Identity'));
    const h = new SecurityHandler(dict, md5(bytesOf('id')), resolve);
    h.key = handler.key; h.method = 'aesv3'; h.stringMethod = 'aesv3'; h.R = 6;
    const file = h.encryptObject(new PdfStream(new Dict({ Type: Name.get('EmbeddedFile') }), bytesOf('attached')), new Ref(4, 0)) as PdfStream;
    expect(latin1(file.raw)).toBe('attached');
    const page = h.encryptObject(new PdfStream(new Dict(), bytesOf('content')), new Ref(5, 0)) as PdfStream;
    expect(latin1(page.raw)).not.toContain('content');
  });
});

describe('damaged encryption dictionaries (contract C7)', () => {
  const encrypted = () => PdfDocument.load(makeTextPdf(['Secret'])).save({ incremental: false, encrypt: { userPassword: 'user', ownerPassword: 'owner', permissions: {} } });
  it('a missing /UE is reported, with the right user password, as damage', () => {
    const bad = bytesOf(latin1(encrypted()).replace('/UE<', '/UX<'));
    let err: unknown = null;
    try { PdfDocument.load(bad, { password: 'user' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe('TypeError');
    expect((err as Error).message).toMatch(/damaged/);
    // The owner password still works: /OE is intact.
    expect(PdfDocument.load(bad, { password: 'owner' }).pageCount).toBe(1);
  });
  it('a wrong password is still "password needed"', () => {
    expect(() => PdfDocument.load(encrypted(), { password: 'nope' })).toThrow(/password is incorrect/);
  });
});

describe('owner access (owner password tried first)', () => {
  it('a file whose two passwords are the same opens with owner access: AES-256', () => {
    const out = PdfDocument.load(makeTextPdf(['x'])).save({ incremental: false, encrypt: { userPassword: 'same', ownerPassword: 'same', permissions: { print: false } } });
    const d = PdfDocument.load(out, { password: 'same' });
    expect(d.securityInfo?.ownerAccess).toBe(true);
    // so its security can be taken off again
    expect(PdfDocument.load(d.save({ incremental: false, removeSecurity: true })).securityInfo).toBeNull();
  });
  it('and so do RC4-128 and AES-128 files written by another library', () => {
    for (const [name, bytes] of [['rc4', rc4SamePw()], ['aes128', aes128SamePw()]] as [string, Uint8Array][]) {
      const d = PdfDocument.load(bytes, { password: 'same' });
      expect(d.securityInfo?.ownerAccess, name).toBe(true);
      expect(latin1(d.pageContent(d.pages[0])), name).toContain('(Same password) Tj');
      expect(() => PdfDocument.load(bytes, { password: 'other' }), name).toThrow(/password is incorrect/);
    }
  });
  it('different passwords still tell user from owner', () => {
    expect(PdfDocument.load(rc4NoId(), { password: 'user' }).securityInfo?.ownerAccess).toBe(false);
    expect(PdfDocument.load(rc4NoId(), { password: 'owner' }).securityInfo?.ownerAccess).toBe(true);
    const out = PdfDocument.load(makeTextPdf(['x'])).save({ incremental: false, encrypt: { userPassword: 'user', ownerPassword: 'owner', permissions: {} } });
    expect(PdfDocument.load(out, { password: 'user' }).securityInfo?.ownerAccess).toBe(false);
    expect(PdfDocument.load(out, { password: 'owner' }).securityInfo?.ownerAccess).toBe(true);
    // An empty open password with a real owner password is user access.
    const open = PdfDocument.load(makeTextPdf(['x'])).save({ incremental: false, encrypt: { userPassword: '', ownerPassword: 'owner', permissions: {} } });
    expect(PdfDocument.load(open).securityInfo?.ownerAccess).toBe(false);
  });
});

describe('a kept encryption dictionary is renumbered like everything else (lower-priority list)', () => {
  it('a reference inside /Encrypt still points at its object after a full rewrite', () => {
    const enc = PdfDocument.load(makeTextPdf(['x'])).save({ incremental: false, encrypt: { userPassword: '', ownerPassword: 'o', permissions: {} } });
    const d = PdfDocument.load(enc, { password: 'o' });
    for (let i = 0; i < 5; i++) d.register(new Dict({ Unused: i })); // shifts the numbers: these are dropped by the rewrite
    d.security!.dict.set('QFNote', d.register(new Dict({ Marker: 42 })));
    const back = PdfDocument.load(d.save({ incremental: false }), { password: 'o' });
    const note = back.getDict(back.security!.dict, 'QFNote');
    expect(note?.get('Marker')).toBe(42);
  });
});

describe('RC4 file without an /ID (lower-priority list)', () => {
  it('still opens with its password after an incremental update and after a rewrite', () => {
    const doc = PdfDocument.load(rc4NoId(), { password: 'user' });
    expect(doc.securityInfo?.method).toBe('rc4');
    expect(doc.title).toBe('RC4 without ID');
    addTextPage(doc, 'Added');
    for (const incremental of [true, false]) {
      const out = doc.save({ incremental });
      const back = PdfDocument.load(out, { password: 'user' });
      expect(back.pageCount, String(incremental)).toBe(2);
      expect(back.title, String(incremental)).toBe('RC4 without ID');
      expect(latin1(back.pageContent(back.pages[0])), String(incremental)).toContain('(No ID here) Tj');
    }
  });
});

describe('encrypted object streams and repair (finding 4)', () => {
  /** An AES-256 file whose catalog, page tree, page and Info are inside an encrypted object stream. */
  const build = (): Uint8Array => {
    const id0 = md5(bytesOf('id'));
    const { dict: encDict, handler } = SecurityHandler.createAes256('', 'owner', {}, id0);
    const objs: [number, string][] = [[1, '<< /Type /Catalog /Pages 2 0 R >>'], [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'], [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 6 0 R >>'], [4, '<< /Title (Secret title) >>']];
    let header = '', body = '';
    for (const [n, s] of objs) { header += `${n} ${body.length} `; body += s + '\n'; }
    const stm = new PdfStream(new Dict({ Type: Name.get('ObjStm'), N: objs.length, First: header.length, Filter: Name.get('FlateDecode') }), deflateZlib(bytesOf(header + body)));
    const parts: Uint8Array[] = [bytesOf('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
    let pos = parts[0].length;
    const off: Record<number, number> = {};
    const put = (n: number, o: PdfObj, encrypt: boolean) => { off[n] = pos; const b = concat([bytesOf(`${n} 0 obj\n`), serialize(encrypt ? handler.encryptObject(o, new Ref(n, 0)) : o), bytesOf('\nendobj\n')]); parts.push(b); pos += b.length; };
    put(5, stm, true); put(6, new PdfStream(new Dict(), bytesOf('BT (x) Tj ET')), true); put(7, encDict, false);
    const rows: number[] = [];
    const row = (t: number, a: number, b: number) => rows.push(t, (a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, (b >> 8) & 255, b & 255);
    row(0, 0, 65535); for (let i = 0; i < 4; i++) row(2, 5, i); row(1, off[5], 0); row(1, off[6], 0); row(1, off[7], 0); row(1, pos, 0);
    const xpos = pos;
    put(8, new PdfStream(new Dict({ Type: Name.get('XRef'), Size: 9, W: [1, 4, 2], Root: new Ref(1, 0), Info: new Ref(4, 0), Encrypt: new Ref(7, 0), ID: [new PdfString(id0, true), new PdfString(id0, true)] }), Uint8Array.from(rows)), false);
    parts.push(bytesOf(`startxref\n${xpos}\n%%EOF\n`));
    return concat(parts);
  };
  it('opens normally', () => {
    const d = PdfDocument.load(build());
    expect([d.pageCount, d.title, d.report.reconstructed]).toEqual([1, 'Secret title', false]);
  });
  it('a forced rebuild still finds the catalog and pages inside the encrypted object stream', () => {
    const d = PdfDocument.load(build(), { repair: true });
    expect([d.pageCount, d.title]).toEqual([1, 'Secret title']);
    expect(latin1(d.pageContent(d.pages[0]))).toContain('(x) Tj');
  });
  it('so does a file that lost its last bytes', () => {
    const pdf = build();
    const d = PdfDocument.load(pdf.subarray(0, pdf.length - 30));
    expect(d.report.reconstructed).toBe(true);
    expect([d.pageCount, d.title]).toEqual([1, 'Secret title']);
  });
});
