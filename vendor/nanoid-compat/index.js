'use strict';
// hunspell-asm (and emscripten-wasm-loader) call nanoid(size) from nanoid 2 to name a temporary mount
// path. nanoid 2 is unmaintained and flagged by npm audit; nanoid 3+ no longer exports a function from
// require('nanoid'). This file keeps nanoid 2's call shape with a plain, bounded implementation.
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

function randomBytes(n) {
  const c = typeof globalThis !== 'undefined' && globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('nanoid-compat: crypto.getRandomValues is not available');
  return c.getRandomValues(new Uint8Array(n));
}

function nanoid(size) {
  let n = size === undefined ? 21 : Number(size);
  if (!Number.isFinite(n) || n < 1) n = 21;
  n = Math.min(Math.floor(n), 1024);
  const bytes = randomBytes(n);
  let id = '';
  for (let i = 0; i < n; i++) id += ALPHABET[bytes[i] & 63];
  return id;
}

module.exports = nanoid;
module.exports.nanoid = nanoid;
module.exports.default = nanoid;
