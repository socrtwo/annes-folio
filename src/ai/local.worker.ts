/// <reference lib="webworker" />
/**
 * On-device model worker. Transformers.js and ONNX Runtime are part of the app (bundled by Vite;
 * the runtime's .wasm and .mjs files are copied to public/ort/ by scripts/copy-pdfjs.mjs), so no
 * code is loaded from a CDN. Only the model weights download, from the Hugging Face Hub, on first use.
 *
 * Requests run one at a time, in the order they arrive. A 'stop' names the request it stops: a
 * request still waiting (or still loading its model) is dropped, a running one is interrupted.
 */
import { pipeline, TextStreamer, InterruptableStoppingCriteria, env } from '@huggingface/transformers';

env.allowLocalModels = false;
// ONNX Runtime reads its files straight from the app; a second copy in Cache Storage is not needed.
(env as any).useWasmCache = false;

const post = (m: Record<string, unknown>) => (self as any).postMessage(m);
let gen: any = null, loaded = '', info: { device: string; dtype: string } | null = null;
const stopper = new InterruptableStoppingCriteria();
const waiting = new Set<number>();
const cancelled = new Set<number>();
let running = 0;
let queue: Promise<unknown> = Promise.resolve();
let runtimeSet = false;

/** Points ONNX Runtime at the copies shipped with the app (the library's default is a CDN). The .mjs loader is shipped as .js (scripts/copy-pdfjs.mjs says why). */
function useLocalRuntime(ortBase: string): void {
  if (runtimeSet || !ortBase) return;
  runtimeSet = true;
  const wasm = (env as any).backends?.onnx?.wasm;
  if (!wasm) return;
  const cur = wasm.wasmPaths;
  if (cur && typeof cur === 'object') {
    const local: Record<string, string> = {};
    for (const k of Object.keys(cur)) local[k] = ortBase + String(cur[k]).split('/').pop()!.replace(/\.mjs$/, '.js');
    wasm.wasmPaths = local;
  } else wasm.wasmPaths = ortBase;
}

async function load(model: string, revision?: string) {
  if (gen && loaded === model) return info!;
  let device = 'wasm', dtype = 'q8';
  try {
    const gpu = (self.navigator as any)?.gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter();
      if (adapter) { device = 'webgpu'; dtype = adapter.features && adapter.features.has('shader-f16') ? 'q4f16' : 'q4'; }
    }
  } catch { /* no WebGPU: CPU */ }
  // Repos published as a single q4f16 file have no other precision to fall back to.
  if (/q4f16$/.test(model)) dtype = 'q4f16';
  const progress = (p: any) => post({ type: 'progress', p: { status: p.status, file: p.file, loaded: p.loaded, total: p.total, progress: p.progress } });
  const opts = (): any => ({ device, dtype, progress_callback: progress, ...(revision ? { revision } : {}) });
  try {
    gen = await (pipeline as any)('text-generation', model, opts());
  } catch (e) {
    if (device !== 'webgpu') throw e;
    device = 'wasm'; dtype = 'q8';
    gen = await (pipeline as any)('text-generation', model, opts());
  }
  loaded = model;
  info = { device, dtype };
  return info;
}

async function handle(m: any): Promise<void> {
  const stopped = () => { const c = cancelled.delete(m.id); if (c) post({ type: 'stopped', id: m.id }); return c; };
  try {
    if (stopped()) return;
    running = m.id;
    useLocalRuntime(m.ortBase);
    const i = await load(m.model, m.revision);
    // Stop pressed while the model was downloading or loading: do not start generating.
    if (stopped()) return;
    if (m.type === 'load') { post({ type: 'ready', id: m.id, info: i }); return; }
    stopper.reset();
    const streamer = new TextStreamer(gen.tokenizer, { skip_prompt: true, skip_special_tokens: true, callback_function: (t: string) => post({ type: 'token', id: m.id, text: t }) });
    const out = await gen(m.messages, { max_new_tokens: m.maxTokens || 512, do_sample: m.temperature > 0, temperature: m.temperature || undefined, repetition_penalty: 1.1, streamer, stopping_criteria: stopper });
    const g = out[0].generated_text;
    post({ type: 'done', id: m.id, text: Array.isArray(g) ? (g[g.length - 1].content || '') : String(g) });
  } catch (err: any) {
    post({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  } finally {
    running = 0;
    waiting.delete(m.id);
    cancelled.delete(m.id);
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'stop') {
    if (!waiting.has(m.id)) return;
    cancelled.add(m.id);
    if (m.id === running) stopper.interrupt();
    return;
  }
  waiting.add(m.id);
  queue = queue.then(() => handle(m));
};
