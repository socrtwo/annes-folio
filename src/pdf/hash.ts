/**
 * The primitives the standard security handler needs (ISO 32000-1 §7.6, 32000-2 §7.6.4): MD5, SHA-256/384/512,
 * RC4 and AES-128/256 (CBC). Written from the published algorithms so the engine stays synchronous
 * and works the same in the browser, in Electron and in Node tests.
 */

// ------------------------------------------------------------------------------------------
// MD5 (RFC 1321)

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bits >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

// ------------------------------------------------------------------------------------------
// SHA-256

const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

export function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 4294967296));
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}

// ------------------------------------------------------------------------------------------
// SHA-384 / SHA-512 (64-bit words kept as two 32-bit halves; used by the R6 password hash, dozens of times per check)

const K512 = ['428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc', '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118', 'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2', '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694', 'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65', '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5', '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4', 'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70', '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df', '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b', 'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30', 'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8', '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8', '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3', '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec', '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b', 'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178', '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b', '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c', '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817'];
/** 64-bit words as pairs of 32-bit halves (high, low). */
const words64 = (hex: string[]): Uint32Array => { const w = new Uint32Array(hex.length * 2); hex.forEach((h, i) => { w[2 * i] = parseInt(h.slice(0, 8), 16); w[2 * i + 1] = parseInt(h.slice(8), 16); }); return w; };
const K512W = words64(K512);

function sha512Core(data: Uint8Array, init: Uint32Array, outWords: number): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array(((len + 16) >> 7) * 128 + 128);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 4294967296));
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);
  const K = K512W;
  const H = init.slice();
  const W = new Uint32Array(160);
  for (let off = 0; off < padded.length; off += 128) {
    for (let i = 0; i < 32; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 32; i < 160; i += 2) {
      const xh = W[i - 30], xl = W[i - 29], yh = W[i - 4], yl = W[i - 3];
      // σ0 = rotr1 ^ rotr8 ^ shr7, σ1 = rotr19 ^ rotr61 ^ shr6
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
      const lo = W[i - 31] + (s0l >>> 0) + W[i - 13] + (s1l >>> 0);
      W[i + 1] = lo;
      W[i] = W[i - 32] + s0h + W[i - 14] + s1h + Math.floor(lo / 4294967296);
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7], eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let i = 0; i < 160; i += 2) {
      // Σ1 = rotr14 ^ rotr18 ^ rotr41, Σ0 = rotr28 ^ rotr34 ^ rotr39
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      const t1l = hl + (S1l >>> 0) + (chl >>> 0) + K[i + 1] + W[i + 1];
      const t1h = (hh + (S1h >>> 0) + (chh >>> 0) + K[i] + W[i] + Math.floor(t1l / 4294967296)) >>> 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (mjl >>> 0);
      const t2h = ((S0h >>> 0) + (mjh >>> 0) + Math.floor(t2l / 4294967296)) >>> 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      const nel = dl + (t1l >>> 0);
      eh = (dh + t1h + Math.floor(nel / 4294967296)) >>> 0; el = nel >>> 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      const nal = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + Math.floor(nal / 4294967296)) >>> 0; al = nal >>> 0;
    }
    const add = (k: number, h: number, l: number) => { const lo = H[k + 1] + l; H[k + 1] = lo; H[k] = H[k] + h + Math.floor(lo / 4294967296); };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  const out = new Uint8Array(outWords * 8);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < outWords * 2; i++) ov.setUint32(i * 4, H[i]);
  return out;
}

const INIT384 = words64(['cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939', '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4']);
const INIT512 = words64(['6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1', '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179']);
export const sha384 = (d: Uint8Array): Uint8Array => sha512Core(d, INIT384, 6);
export const sha512 = (d: Uint8Array): Uint8Array => sha512Core(d, INIT512, 8);

// ------------------------------------------------------------------------------------------
// RC4

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255;
    const t = S[i]; S[i] = S[j]; S[j] = t;
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// AES (FIPS 197), CBC mode

const SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
(() => {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();
const xtime = (x: number) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a: number, b: number) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; } return r; };

// GF(2^8) multiplication tables for MixColumns and its inverse (a table lookup instead of a shift loop per byte).
const M2 = new Uint8Array(256), M3 = new Uint8Array(256), M9 = new Uint8Array(256), M11 = new Uint8Array(256), M13 = new Uint8Array(256), M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) { M2[i] = mul(i, 2); M3[i] = mul(i, 3); M9[i] = mul(i, 9); M11[i] = mul(i, 11); M13[i] = mul(i, 13); M14[i] = mul(i, 14); }

/** The round keys, 16 bytes per round, in one array. */
function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new Error(`An AES key must be 16, 24 or 32 bytes long; this one has ${key.length}.`);
  const nk = key.length / 4, rounds = nk + 6;
  const w = new Uint8Array(16 * (rounds + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t0 = w[4 * i - 4], t1 = w[4 * i - 3], t2 = w[4 * i - 2], t3 = w[4 * i - 1];
    if (i % nk === 0) { const x = t0; t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[x]; rcon = xtime(rcon); }
    else if (nk > 6 && i % nk === 4) { t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3]; }
    const p = 4 * (i - nk);
    w[4 * i] = w[p] ^ t0; w[4 * i + 1] = w[p + 1] ^ t1; w[4 * i + 2] = w[p + 2] ^ t2; w[4 * i + 3] = w[p + 3] ^ t3;
  }
  return w;
}

/** Encrypts the 16-byte state `s` in place (`t` is scratch space). The state is column-major: s[c*4 + row]. */
function encryptBlock(rk: Uint8Array, s: Uint8Array, t: Uint8Array): void {
  const rounds = rk.length / 16 - 1;
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  for (let r = 1; r <= rounds; r++) {
    // SubBytes and ShiftRows
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[c * 4 + row] = SBOX[s[((c + row) & 3) * 4 + row]];
    const k = r * 16;
    if (r !== rounds) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = t[c], a1 = t[c + 1], a2 = t[c + 2], a3 = t[c + 3];
        s[c] = M2[a0] ^ M3[a1] ^ a2 ^ a3 ^ rk[k + c];
        s[c + 1] = a0 ^ M2[a1] ^ M3[a2] ^ a3 ^ rk[k + c + 1];
        s[c + 2] = a0 ^ a1 ^ M2[a2] ^ M3[a3] ^ rk[k + c + 2];
        s[c + 3] = M3[a0] ^ a1 ^ a2 ^ M2[a3] ^ rk[k + c + 3];
      }
    } else for (let i = 0; i < 16; i++) s[i] = t[i] ^ rk[k + i];
  }
}

function decryptBlock(rk: Uint8Array, s: Uint8Array, t: Uint8Array): void {
  const rounds = rk.length / 16 - 1;
  for (let i = 0; i < 16; i++) s[i] ^= rk[rounds * 16 + i];
  for (let r = rounds - 1; r >= 0; r--) {
    // InvShiftRows and InvSubBytes, then the round key
    const k = r * 16;
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) { const j = ((c + row) & 3) * 4 + row; t[j] = INV_SBOX[s[c * 4 + row]] ^ rk[k + j]; }
    if (r !== 0) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = t[c], a1 = t[c + 1], a2 = t[c + 2], a3 = t[c + 3];
        s[c] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
        s[c + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
        s[c + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
        s[c + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
      }
    } else s.set(t);
  }
}

/** AES-CBC without padding (data length must be a multiple of 16). */
export function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const rk = expandKey(key);
  const out = new Uint8Array(data.length);
  const s = new Uint8Array(16), t = new Uint8Array(16);
  s.set(iv.subarray(0, 16));
  for (let o = 0; o + 16 <= data.length; o += 16) {
    for (let i = 0; i < 16; i++) s[i] ^= data[o + i]; // s still holds the previous ciphertext block (or the IV)
    encryptBlock(rk, s, t);
    out.set(s, o);
  }
  return out;
}

export function aesCbcDecryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  const rk = expandKey(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  const s = new Uint8Array(16), t = new Uint8Array(16);
  for (let o = 0; o + 16 <= n; o += 16) {
    s.set(data.subarray(o, o + 16));
    decryptBlock(rk, s, t);
    for (let i = 0; i < 16; i++) out[o + i] = s[i] ^ (o ? data[o - 16 + i] : iv[i]);
  }
  return out;
}

/** AES-CBC with a random IV prefix and PKCS#5 padding, as PDF strings and streams use (AESV2/AESV3). */
export function aesCbcEncrypt(key: Uint8Array, data: Uint8Array, iv = randomBytes(16)): Uint8Array {
  const pad = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const enc = aesCbcEncryptNoPad(key, iv, padded);
  const out = new Uint8Array(16 + enc.length);
  out.set(iv); out.set(enc, 16);
  return out;
}

export function aesCbcDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < 16) return new Uint8Array(0);
  const iv = data.subarray(0, 16);
  const dec = aesCbcDecryptNoPad(key, iv, data.subarray(16));
  const pad = dec.length ? dec[dec.length - 1] : 0;
  if (pad >= 1 && pad <= 16 && pad <= dec.length) return dec.subarray(0, dec.length - pad);
  return dec;
}

/** AES-ECB of one block (used by the R6 hash when no IV is wanted: handled by CBC with a zero IV). */
export function aesEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array { const s = block.slice(0, 16); encryptBlock(expandKey(key), s, new Uint8Array(16)); return s; }

/** Random bytes for keys, salts and IVs. There is no weaker fallback: without a secure generator this throws. */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('No secure random number generator is available (crypto.getRandomValues), so encryption keys cannot be made.');
  c.getRandomValues(b);
  return b;
}

export const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
