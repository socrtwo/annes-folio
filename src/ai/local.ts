/**
 * On-device model ("Anne's Folio Local AI"): a small open instruction model run with
 * Transformers.js in a module Web Worker (local.worker.ts). WebGPU is used when the device offers
 * it, otherwise WebAssembly on the CPU.
 *
 * The library and ONNX Runtime ship with the app. Only the model weights are downloaded, on first
 * use, from the Hugging Face Hub, then served from the browser cache. Nothing typed into the
 * document leaves the device.
 */
import type { ChatRequest, ChatResult } from './client';
import { AiError } from './errors';

/** `bytes`: the largest download for this model (from `size`), for the free-space check. `revision`: a Hub commit to pin the files to. */
export interface LocalModel { id: string; label: string; size: string; note: string; bytes: number; revision?: string }

const MB = 1048576;
// Each model is pinned to the Hub commit it was checked against (2026-11-14: the ONNX files the worker asks for are present),
// so a later change to a model repository cannot change what the app downloads and runs.
export const LOCAL_MODELS: LocalModel[] = [
  { id: 'onnx-community/Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B Instruct (recommended)', size: '≈ 480–510 MB', note: 'Best quality for its size; handles many languages.', bytes: 510 * MB, revision: '22942cb7d7ba4cc81bb4673549ca4d4614469b5e' },
  { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', label: 'SmolLM2 360M Instruct (smallest download)', size: '≈ 270–365 MB', note: 'Fastest on older phones; English-centric.', bytes: 365 * MB, revision: 'a10cc1512eabd3dde888204e902eca88bddb4951' },
  { id: 'onnx-community/gemma-3-270m-it-ONNX', label: 'Gemma 3 270M IT', size: '≈ 270–545 MB', note: 'Very small; simple rewrites and summaries.', bytes: 545 * MB, revision: '2dbbfdb1b59bd034eb959428c6a7da9dd7ea27f0' },
  { id: 'onnx-community/Llama-3.2-1B-Instruct-q4f16', label: 'Llama 3.2 1B Instruct (needs WebGPU)', size: '≈ 1.24 GB', note: 'Noticeably better writing; only for devices with WebGPU and plenty of storage.', bytes: 1270 * MB, revision: '1089a6ec8011cc0acc4eacd544ced5cd4f524ab0' },
];

const MODEL_CACHE = 'transformers-cache';
/** Where the app serves ONNX Runtime's files from (public/ort/, copied by scripts/copy-pdfjs.mjs). */
const ortBase = (): string => { try { return new URL('./ort/', document.baseURI).href; } catch { return './ort/'; } };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; onToken?: (t: string) => void };
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
const progressListeners = new Set<(p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => void>();

const stoppedError = () => new AiError('Stopped', 'aborted');

/** Settles every waiting request: a worker that crashed or was shut down never answers. */
function failAll(e: Error): void {
  const all = [...pending.values()];
  pending.clear();
  all.forEach((p) => p.reject(e));
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./local.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'progress') { progressListeners.forEach((f) => f(m.p)); return; }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'token') p.onToken?.(m.text);
    else if (m.type === 'ready') { pending.delete(m.id); p.resolve(m.info); }
    else if (m.type === 'done') { pending.delete(m.id); p.resolve(m.text); }
    else if (m.type === 'stopped') { pending.delete(m.id); p.reject(stoppedError()); }
    else if (m.type === 'error') { pending.delete(m.id); p.reject(new AiError(localError(m.message), 'other')); }
  };
  w.onerror = (e) => {
    if (worker === w) worker = null;
    try { w.terminate(); } catch { /* already gone */ }
    failAll(new AiError(localError(e.message || 'The on-device model could not start'), 'network'));
  };
  worker = w;
  return w;
}

function localError(m: string): string {
  if (/fetch|network|Failed to load|import/i.test(m)) return `The on-device model needs an internet connection the first time, to download the model files (${m}).`;
  if (/memory|allocation|OOM/i.test(m)) return `This device ran out of memory loading the model. Choose a smaller on-device model in AI ▸ Providers & Models (${m}).`;
  return `On-device model: ${m}`;
}

export function onLocalProgress(f: (p: { status: string; file?: string; loaded?: number; total?: number; progress?: number }) => void): () => void {
  progressListeners.add(f);
  return () => progressListeners.delete(f);
}

const modelDef = (id: string) => LOCAL_MODELS.find((m) => m.id === id);

/**
 * Before a first download: asks the browser to keep the model (not evict it under storage pressure)
 * and refuses, with the numbers, when the device clearly has no room. Says nothing when the browser
 * does not report its storage.
 */
export async function checkLocalStorageFor(model: string): Promise<void> {
  const need = modelDef(model)?.bytes;
  const st = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!need || !st?.estimate) return;
  try {
    const cache = await caches.open(MODEL_CACHE);
    if ((await cache.keys()).some((r) => r.url.includes(`/${model}/`))) return; // already downloaded
  } catch { /* no Cache Storage: the library downloads every time */ }
  try { await st.persist?.(); } catch { /* optional */ }
  let free = Infinity;
  try { const e = await st.estimate(); if (e.quota) free = e.quota - (e.usage || 0); } catch { return; }
  if (free < need) throw new AiError(`Not enough free storage for this model: it needs about ${Math.round(need / MB)} MB and this browser allows about ${Math.max(0, Math.round(free / MB))} MB more. Free some space or choose a smaller model.`, 'other');
}

/** Sends a request to the worker; `signal` stops it (immediately for the caller; the worker drops or interrupts it). */
function request<T>(msg: Record<string, unknown>, onToken?: (t: string) => void, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(stoppedError());
  const id = ++seq;
  const w = getWorker();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!pending.delete(id)) return;
      w.postMessage({ type: 'stop', id });
      reject(stoppedError());
    };
    const done = () => signal?.removeEventListener('abort', onAbort);
    pending.set(id, { resolve: (v) => { done(); resolve(v); }, reject: (e) => { done(); reject(e); }, onToken });
    signal?.addEventListener('abort', onAbort, { once: true });
    w.postMessage({ ...msg, id, ortBase: ortBase(), revision: modelDef(String(msg.model))?.revision });
  });
}

/** Download (if needed) and load a model. Resolves with the backend used. */
export async function loadLocalModel(model: string, signal?: AbortSignal): Promise<{ device: string; dtype: string }> {
  await checkLocalStorageFor(model);
  return request({ type: 'load', model }, undefined, signal);
}

export async function localChat(model: string, req: ChatRequest): Promise<ChatResult> {
  const messages = req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n') }));
  let full = '';
  await checkLocalStorageFor(model);
  const text = await request<string>(
    { type: 'generate', model, messages, maxTokens: Math.min(req.maxTokens || 768, 2048), temperature: req.temperature ?? 0 },
    (t) => { full += t; req.onToken?.(t, full); }, req.signal);
  if (req.signal?.aborted) throw stoppedError();
  return { text: text || full, model, provider: 'device', providerName: 'On-device model' };
}

/** Approximate storage used by downloaded models (Cache Storage), if the browser reports it. */
export async function localStorageEstimate(): Promise<string> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (e?.usage) return `${(e.usage / MB).toFixed(0)} MB used by Anne's Folio in this browser storage`;
  } catch { /* unsupported */ }
  return '';
}

/** Remove downloaded model files from the browser cache. Requests still waiting are stopped. */
export async function clearLocalModels(): Promise<number> {
  let n = 0;
  try {
    for (const k of await caches.keys()) if (/transformers/i.test(k)) { await caches.delete(k); n++; }
  } catch { /* unsupported */ }
  worker?.terminate();
  worker = null;
  failAll(stoppedError());
  return n;
}
