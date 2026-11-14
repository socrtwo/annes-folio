/**
 * The standard security handler (ISO 32000-1 §7.6.3, ISO 32000-2 §7.6.4): RC4 40/128-bit (R2–R4),
 * AES-128 (AESV2, R4) and AES-256 (AESV3, R5/R6). Opening tries the empty user password first, then the
 * password the person enters as user or owner password. Saving re-encrypts new objects with the same key
 * (incremental updates) or encrypts everything with a new AES-256 dictionary (Protect ▸ Encrypt).
 */
import { Dict, Name, PdfObj, PdfStream, PdfString, Ref, bytesOf, isName, nameObj } from './objects';
import { aesCbcDecrypt, aesCbcDecryptNoPad, aesCbcEncrypt, aesCbcEncryptNoPad, md5, randomBytes, rc4, sha256, sha384, sha512 } from './hash';

const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

export class PasswordNeeded extends Error {
  constructor(message = 'This PDF is encrypted; enter its password to open it.') { super(message); this.name = 'PasswordNeeded'; }
}

export type CryptMethod = 'none' | 'rc4' | 'aesv2' | 'aesv3';

export interface Permissions { print: boolean; modify: boolean; copy: boolean; annotate: boolean; fillForms: boolean; accessibility: boolean; assemble: boolean; printHigh: boolean }

export function permissionsOf(p: number): Permissions {
  const bit = (n: number) => ((p >>> (n - 1)) & 1) === 1;
  return { print: bit(3), modify: bit(4), copy: bit(5), annotate: bit(6), fillForms: bit(9), accessibility: bit(10), assemble: bit(11), printHigh: bit(12) };
}
export function permissionBits(perm: Partial<Permissions>): number {
  let p = 0xfffff0c0 | 0; // reserved bits set
  const set = (n: number, on: boolean | undefined) => { if (on !== false) p |= 1 << (n - 1); else p &= ~(1 << (n - 1)); };
  set(3, perm.print); set(4, perm.modify); set(5, perm.copy); set(6, perm.annotate); set(9, perm.fillForms); set(10, perm.accessibility); set(11, perm.assemble); set(12, perm.printHigh);
  return p | 0;
}

export interface SecurityInfo { method: CryptMethod; stringMethod: CryptMethod; revision: number; keyLength: number; permissions: Permissions; ownerAccess: boolean; encryptMetadata: boolean }

const padPassword = (pw: Uint8Array): Uint8Array => { const out = new Uint8Array(32); out.set(pw.subarray(0, 32)); if (pw.length < 32) out.set(PAD.subarray(0, 32 - pw.length), pw.length); return out; };
const pwBytes = (pw: string): Uint8Array => { try { return new TextEncoder().encode(pw.normalize('NFKC')).subarray(0, 127); } catch { return bytesOf(pw); } };
const latinPw = (pw: string): Uint8Array => bytesOf(pw);

/** Algorithm 2: the file encryption key from the user password (R2–R4). */
function computeKeyR4(pw: Uint8Array, O: Uint8Array, P: number, id0: Uint8Array, R: number, length: number, encryptMetadata: boolean): Uint8Array {
  const pbytes = Uint8Array.from([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >>> 24) & 255]);
  const parts = [padPassword(pw), O.subarray(0, 32), pbytes, id0];
  if (R >= 4 && !encryptMetadata) parts.push(Uint8Array.from([255, 255, 255, 255]));
  let n = 0; for (const p of parts) n += p.length;
  const buf = new Uint8Array(n); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  let key = md5(buf);
  const len = R === 2 ? 5 : Math.max(5, Math.min(16, length >> 3));
  if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, len));
  return key.subarray(0, len);
}

/** Algorithm 4/5: the expected /U for a key. */
function computeU(key: Uint8Array, R: number, id0: Uint8Array): Uint8Array {
  if (R === 2) return rc4(key, PAD);
  const buf = new Uint8Array(32 + id0.length); buf.set(PAD); buf.set(id0, 32);
  let h = rc4(key, md5(buf));
  for (let i = 1; i <= 19; i++) { const k = key.map((b) => b ^ i); h = rc4(k, h); }
  const out = new Uint8Array(32); out.set(h.subarray(0, 16)); out.set(PAD.subarray(0, 16), 16);
  return out;
}

/** Algorithm 3: the RC4 key derived from the owner password, used to unwrap /O. */
function ownerKey(ownerPw: Uint8Array, R: number, length: number): Uint8Array {
  let key = md5(padPassword(ownerPw));
  const len = R === 2 ? 5 : Math.max(5, Math.min(16, length >> 3));
  if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key);
  return key.subarray(0, len);
}

/** ISO 32000-2 algorithm 2.B: the hash for R6 (and plain SHA-256 for R5). */
function hashR6(pw: Uint8Array, salt: Uint8Array, udata: Uint8Array, R: number): Uint8Array {
  const cat = (...parts: Uint8Array[]) => { let n = 0; for (const p of parts) n += p.length; const b = new Uint8Array(n); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; } return b; };
  let K = sha256(cat(pw, salt, udata));
  if (R === 5) return K;
  let i = 0;
  for (;;) {
    const K1 = new Uint8Array(64 * (pw.length + K.length + udata.length));
    const unit = cat(pw, K, udata);
    for (let k = 0; k < 64; k++) K1.set(unit, k * unit.length);
    const E = aesCbcEncryptNoPad(K.subarray(0, 16), K.subarray(16, 32), K1);
    let sum = 0; for (let k = 0; k < 16; k++) sum += E[k];
    const mod = sum % 3;
    K = mod === 0 ? sha256(E) : mod === 1 ? sha384(E) : sha512(E);
    i++;
    if (i >= 64 && E[E.length - 1] <= i - 32) break;
  }
  return K.subarray(0, 32);
}

export class SecurityHandler {
  key: Uint8Array = new Uint8Array(0);
  method: CryptMethod = 'rc4';
  stringMethod: CryptMethod = 'rc4';
  R = 2;
  V = 1;
  length = 40;
  P = -1;
  encryptMetadata = true;
  ownerAccess = false;
  identityStreams = false;
  identityStrings = false;
  /** The method for embedded file streams when the dictionary names one (/EFF); null = the same as other streams. */
  embeddedMethod: CryptMethod | null = null;

  constructor(public dict: Dict, private id0: Uint8Array, resolve: (o: PdfObj | undefined) => PdfObj) {
    const num = (k: string, d: number) => { const v = resolve(dict.get(k)); return typeof v === 'number' ? v : d; };
    const filter = resolve(dict.get('Filter'));
    if (!isName(filter, 'Standard')) throw new Error(`Unsupported security handler ${isName(filter) ? filter.name : '?'}`);
    this.V = num('V', 1); this.R = num('R', 2); this.length = num('Length', 40); this.P = num('P', -1) | 0;
    const em = resolve(dict.get('EncryptMetadata'));
    this.encryptMetadata = em !== false;
    if (this.V >= 4) {
      const cf = resolve(dict.get('CF'));
      const nameOf = (k: string) => { const v = resolve(dict.get(k)); return isName(v) ? v.name : 'Identity'; };
      const methodOf = (n: string): CryptMethod => {
        if (n === 'Identity') return 'none';
        const d = cf instanceof Dict ? resolve(cf.get(n)) : null;
        const cfm = d instanceof Dict ? resolve(d.get('CFM')) : null;
        // A crypt filter's /Length is in bytes, but some writers give bits: below 40 it can only be bytes.
        if (d instanceof Dict) { const l = resolve(d.get('Length')); if (typeof l === 'number' && l > 0) this.length = l < 40 ? l * 8 : l; }
        if (isName(cfm, 'AESV2')) { this.length = 128; return 'aesv2'; } // AESV2 always has a 128-bit key
        if (isName(cfm, 'AESV3')) return 'aesv3';
        if (isName(cfm, 'V2')) return 'rc4';
        if (isName(cfm, 'None')) return 'none';
        return 'none';
      };
      if (isName(resolve(dict.get('EFF')))) this.embeddedMethod = methodOf(nameOf('EFF'));
      this.method = methodOf(nameOf('StmF'));
      this.stringMethod = methodOf(nameOf('StrF'));
      this.identityStreams = this.method === 'none';
      this.identityStrings = this.stringMethod === 'none';
    }
  }

  /** Tries a password (as user, then as owner). Returns false when it does not open the file. */
  authenticate(password: string, resolve: (o: PdfObj | undefined) => PdfObj): boolean {
    const str = (k: string): Uint8Array => { const v = resolve(this.dict.get(k)); return v instanceof PdfString ? v.bytes : new Uint8Array(0); };
    const O = str('O'), U = str('U');
    if (this.R >= 5) {
      const pw = pwBytes(password);
      const uValidation = U.subarray(32, 40), uKeySalt = U.subarray(40, 48);
      const oValidation = O.subarray(32, 40), oKeySalt = O.subarray(40, 48);
      const UE = str('UE'), OE = str('OE');
      const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (U.length < 48 || O.length < 48) throw new Error('The encryption dictionary is damaged (/U or /O is too short), so no password can open this file.');
      const opened = (owner: boolean): true => {
        this.ownerAccess = owner;
        const v3 = (m: CryptMethod): CryptMethod => (m === 'none' ? 'none' : 'aesv3');
        this.method = v3(this.method); this.stringMethod = v3(this.stringMethod);
        if (this.embeddedMethod) this.embeddedMethod = v3(this.embeddedMethod);
        return true;
      };
      // The file key is wrapped in /UE and /OE (32 bytes each); a right password is no use when they are damaged.
      // The owner password is tried first (ISO 32000-2 algorithm 2.A): a file whose two passwords are the
      // same must open with owner access, or its security could never be changed or removed.
      let damaged = false;
      if (eq(hashR6(pw, oValidation, U.subarray(0, 48), this.R), O.subarray(0, 32))) {
        if (OE.length >= 32) { this.key = aesCbcDecryptNoPadZero(hashR6(pw, oKeySalt, U.subarray(0, 48), this.R), OE); return opened(true); }
        damaged = true;
      }
      if (eq(hashR6(pw, uValidation, new Uint8Array(0), this.R), U.subarray(0, 32))) {
        if (UE.length >= 32) { this.key = aesCbcDecryptNoPadZero(hashR6(pw, uKeySalt, new Uint8Array(0), this.R), UE); return opened(false); }
        damaged = true;
      }
      if (damaged) throw new Error('The password is right, but the encryption dictionary is damaged (/UE or /OE is missing or too short), so the file key cannot be recovered.');
      return false;
    }
    const tryUser = (pw: Uint8Array): boolean => {
      const key = computeKeyR4(pw, O, this.P, this.id0, this.R, this.length, this.encryptMetadata);
      const u = computeU(key, this.R, this.id0);
      const n = this.R === 2 ? 32 : 16;
      for (let i = 0; i < n; i++) if (u[i] !== U[i]) return false;
      this.key = key;
      if (this.V < 4) { this.method = 'rc4'; this.stringMethod = 'rc4'; }
      return true;
    };
    const pw = latinPw(password);
    // As owner password first (see above): unwrap the user password from /O and check that.
    const ok = ownerKey(pw, this.R, this.length);
    let userPw: Uint8Array;
    if (this.R === 2) userPw = rc4(ok, O.subarray(0, 32));
    else { userPw = O.slice(0, 32); for (let i = 19; i >= 0; i--) userPw = rc4(ok.map((b) => b ^ i), userPw); }
    if (tryUser(userPw)) { this.ownerAccess = true; return true; }
    if (tryUser(pw)) { this.ownerAccess = false; return true; }
    return false;
  }

  get info(): SecurityInfo {
    return { method: this.method, stringMethod: this.stringMethod, revision: this.R, keyLength: this.key.length * 8, permissions: permissionsOf(this.P), ownerAccess: this.ownerAccess, encryptMetadata: this.encryptMetadata };
  }

  private objectKey(ref: Ref, aes: boolean): Uint8Array {
    if (this.R >= 5) return this.key;
    const extra = aes ? 9 : 5;
    const buf = new Uint8Array(this.key.length + extra);
    buf.set(this.key);
    buf.set([ref.num & 255, (ref.num >> 8) & 255, (ref.num >> 16) & 255, ref.gen & 255, (ref.gen >> 8) & 255], this.key.length);
    if (aes) buf.set([0x73, 0x41, 0x6c, 0x54], this.key.length + 5);
    const h = md5(buf);
    return h.subarray(0, Math.min(16, this.key.length + 5));
  }

  decryptBytes(data: Uint8Array, ref: Ref, isString: boolean, m: CryptMethod = isString ? this.stringMethod : this.method): Uint8Array {
    if (m === 'none') return data;
    if (m === 'rc4') return rc4(this.objectKey(ref, false), data);
    if (m === 'aesv2') return aesCbcDecrypt(this.objectKey(ref, true), data);
    return aesCbcDecrypt(this.key, data);
  }

  encryptBytes(data: Uint8Array, ref: Ref, isString: boolean, m: CryptMethod = isString ? this.stringMethod : this.method): Uint8Array {
    if (m === 'none') return data;
    if (m === 'rc4') return rc4(this.objectKey(ref, false), data);
    if (m === 'aesv2') return aesCbcEncrypt(this.objectKey(ref, true), data);
    return aesCbcEncrypt(this.key, data);
  }

  /** Decrypts every string and stream inside an object (in place for dicts/arrays; streams get new raw bytes). */
  decryptObject(obj: PdfObj, ref: Ref): PdfObj {
    if (obj instanceof PdfString) return new PdfString(this.decryptBytes(obj.bytes, ref, true), obj.hex);
    if (Array.isArray(obj)) return obj.map((o) => this.decryptObject(o, ref));
    if (obj instanceof PdfStream) {
      // A cross-reference stream is never encrypted, and neither are the strings in its dictionary (/ID).
      if (isName(obj.dict.get('Type'), 'XRef')) return obj;
      const d = this.decryptObject(obj.dict, ref) as Dict;
      return new PdfStream(d, this.streamInClear(obj.dict) ? obj.raw : this.decryptBytes(obj.raw, ref, false, this.streamMethod(obj.dict)));
    }
    if (obj instanceof Dict) { const d = new Dict(); for (const [k, v] of obj.map) d.map.set(k, this.decryptObject(v, ref)); return d; }
    return obj;
  }

  /** Streams whose bytes are stored unencrypted: metadata when /EncryptMetadata is false, and Identity crypt filters. */
  private streamInClear(dict: Dict): boolean {
    return (isName(dict.get('Type'), 'Metadata') && !this.encryptMetadata) || this.hasIdentityCryptFilter(dict);
  }
  private streamMethod(dict: Dict): CryptMethod {
    return this.embeddedMethod !== null && isName(dict.get('Type'), 'EmbeddedFile') ? this.embeddedMethod : this.method;
  }

  private hasIdentityCryptFilter(dict: Dict): boolean {
    const f = dict.get('Filter');
    const names = isName(f) ? [f] : Array.isArray(f) ? f.filter(nameObj) : [];
    if (!names.some((n) => (n as Name).name === 'Crypt')) return false;
    const p = dict.get('DecodeParms');
    const list = Array.isArray(p) ? p : [p];
    return list.some((d) => d instanceof Dict && (!d.has('Name') || isName(d.get('Name'), 'Identity')));
  }

  encryptObject(obj: PdfObj, ref: Ref): PdfObj {
    if (obj instanceof PdfString) return new PdfString(this.encryptBytes(obj.bytes, ref, true), obj.hex);
    if (Array.isArray(obj)) return obj.map((o) => this.encryptObject(o, ref));
    if (obj instanceof PdfStream) {
      if (isName(obj.dict.get('Type'), 'XRef')) return obj;
      const d = this.encryptObject(obj.dict, ref) as Dict;
      // The same exceptions as in decryptObject, so that what is written is what will be read back.
      const raw = this.streamInClear(obj.dict) ? obj.raw : this.encryptBytes(obj.raw, ref, false, this.streamMethod(obj.dict));
      d.set('Length', raw.length);
      return new PdfStream(d, raw);
    }
    if (obj instanceof Dict) { const d = new Dict(); for (const [k, v] of obj.map) d.map.set(k, this.encryptObject(v, ref)); return d; }
    return obj;
  }

  /** A new AES-256 (R6) encryption dictionary and handler for the given passwords. */
  static createAes256(userPw: string, ownerPw: string, perms: Partial<Permissions>, id0: Uint8Array, encryptMetadata = true): { dict: Dict; handler: SecurityHandler } {
    const key = randomBytes(32);
    const u = pwBytes(userPw), o = pwBytes(ownerPw || userPw);
    const uvs = randomBytes(8), uks = randomBytes(8), ovs = randomBytes(8), oks = randomBytes(8);
    const cat = (...parts: Uint8Array[]) => { let n = 0; for (const p of parts) n += p.length; const b = new Uint8Array(n); let off = 0; for (const p of parts) { b.set(p, off); off += p.length; } return b; };
    const U = cat(hashR6(u, uvs, new Uint8Array(0), 6), uvs, uks);
    const UE = aesCbcEncryptNoPad(hashR6(u, uks, new Uint8Array(0), 6), new Uint8Array(16), key);
    const O = cat(hashR6(o, ovs, U, 6), ovs, oks);
    const OE = aesCbcEncryptNoPad(hashR6(o, oks, U, 6), new Uint8Array(16), key);
    const P = permissionBits(perms);
    const permsBlock = new Uint8Array(16);
    permsBlock.set([P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >>> 24) & 255, 255, 255, 255, 255, encryptMetadata ? 0x54 : 0x46, 0x61, 0x64, 0x62]);
    permsBlock.set(randomBytes(4), 12);
    const Perms = aesEcbEncrypt(key, permsBlock);
    const cf = new Dict({ StdCF: new Dict({ AuthEvent: Name.get('DocOpen'), CFM: Name.get('AESV3'), Length: 32 }) });
    const dict = new Dict({ Filter: Name.get('Standard'), V: 5, R: 6, Length: 256, P, CF: cf, StmF: Name.get('StdCF'), StrF: Name.get('StdCF'), O: new PdfString(O, true), U: new PdfString(U, true), OE: new PdfString(OE, true), UE: new PdfString(UE, true), Perms: new PdfString(Perms, true), EncryptMetadata: encryptMetadata });
    const h = new SecurityHandler(dict, id0, (x) => x ?? null);
    h.key = key; h.method = 'aesv3'; h.stringMethod = 'aesv3'; h.R = 6; h.V = 5; h.P = P; h.ownerAccess = true; h.encryptMetadata = encryptMetadata;
    return { dict, handler: h };
  }
}

function aesCbcDecryptNoPadZero(key: Uint8Array, data: Uint8Array): Uint8Array {
  // AES-256 CBC, zero IV, no padding (the file key wrapped in /UE and /OE).
  return aesCbcDecryptNoPad(key, new Uint8Array(16), data.subarray(0, 32));
}
function aesEcbEncrypt(key: Uint8Array, block: Uint8Array): Uint8Array {
  return aesCbcEncryptNoPad(key, new Uint8Array(16), block);
}
