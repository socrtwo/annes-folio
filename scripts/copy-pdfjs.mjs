#!/usr/bin/env node
// Copies the static files of the renderer, the OCR engine and the on-device AI runtime into public/, so the
// app works offline on every platform and loads no code from a CDN: pdf.js CMaps, standard fonts, ICC
// profiles and WASM decoders (public/pdfjs/), the Tesseract worker and core (public/tesseract/), and the
// ONNX Runtime files Transformers.js asks for (public/ort/). Runs before `vite build`, `vite dev` and the
// tests (package.json). A missing source stops the build: a silent skip would ship an app without that feature.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const copies = [
  ['pdfjs-dist/cmaps', 'public/pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'public/pdfjs/standard_fonts'],
  ['pdfjs-dist/wasm', 'public/pdfjs/wasm'],
  ['pdfjs-dist/iccs', 'public/pdfjs/iccs'],
  ['tesseract.js/dist/worker.min.js', 'public/tesseract/worker.min.js'],
  // Only the LSTM cores the worker can pick (plain, SIMD, relaxed SIMD); the legacy engine cores stay out.
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'public/tesseract/core/tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'public/tesseract/core/tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'public/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['tesseract.js-core/LICENSE', 'public/tesseract/core/LICENSE'],
];

// ONNX Runtime: exactly the files the installed Transformers.js would otherwise fetch from its CDN default
// (one pair for Safari, one for other browsers). src/ai/local.worker.ts points the library at public/ort/.
const tf = join(nm, '@huggingface/transformers/dist/transformers.web.js');
if (!existsSync(tf)) throw new Error('missing node_modules/@huggingface/transformers: run npm ci');
const ortFiles = [...new Set([...readFileSync(tf, 'utf8').matchAll(/\$\{wasmPathPrefix\}(ort-wasm[\w.-]+\.(?:mjs|wasm))/g)].map((m) => m[1]))];
if (!ortFiles.length) throw new Error('Transformers.js no longer names its ONNX Runtime files the way scripts/copy-pdfjs.mjs expects; update the pattern and src/ai/local.worker.ts');
rmSync(join(root, 'public/ort'), { recursive: true, force: true });
// The .mjs loaders are copied as .js: the iOS shell (and some web hosts) serve .mjs as application/octet-stream,
// which a browser refuses to import as a module. The loader finds itself through import.meta.url, not by name.
for (const f of ortFiles) copies.push([`onnxruntime-web/dist/${f}`, `public/ort/${f.replace(/\.mjs$/, '.js')}`]);

const missing = copies.filter(([from]) => !existsSync(join(nm, from))).map(([from]) => from);
if (missing.length) throw new Error(`missing in node_modules (run npm ci): ${missing.join(', ')}`);
for (const [from, to] of copies) {
  const dst = join(root, to);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(join(nm, from), dst, { recursive: true, filter: (p) => !/\.(md|txt|map)$/i.test(p) || /LICENSE/i.test(p) });
}
console.log('copied renderer, OCR and on-device AI assets:', [...new Set(copies.map(([, t]) => t.split('/').slice(0, 2).join('/')))].join(', '),
  `(${readdirSync(join(root, 'public/pdfjs/cmaps')).length} CMaps, ${ortFiles.length} ONNX Runtime files)`);
