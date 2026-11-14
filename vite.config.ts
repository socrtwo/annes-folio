import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  // ONNX Runtime (on-device AI): take the build that loads its .wasm/.mjs from a path the app gives it
  // (public/ort/, see scripts/copy-pdfjs.mjs) instead of the one that embeds a second 23 MB copy.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
  },
});
