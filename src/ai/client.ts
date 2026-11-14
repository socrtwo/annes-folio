/**
 * Provider-neutral chat client: OpenAI-compatible, Anthropic Messages, Gemini, Chrome's
 * built-in model, and the on-device model. Streams where the platform allows.
 *
 * HTTP goes through fetch (streaming). In the Android, iOS and desktop apps, when a provider blocks browser
 * CORS (or fetch fails at the network layer), the request is retried through Capacitor's
 * native HTTP without streaming.
 *
 * Every request has a time limit, and a busy or rate-limited service (429, 5xx) is asked again up to
 * twice after a short wait. A stream that breaks after some text arrived keeps that text and is
 * marked incomplete.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { desktopHttp } from '../platform/native';
import { aiSettings, resolveProvider, recordUsage, type ResolvedProvider } from './store';
import { providerById, type ProviderDef } from './providers';
import { AiError } from './errors';
import { planEnsemble, runEnsemble, type EnsembleInfo, type EnsemblePlan } from './ensemble';

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }

export interface ChatRequest {
  messages: ChatMessage[];
  /** 'fast' uses the provider's fast model. */
  tier?: 'fast' | 'quality';
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (delta: string, full: string) => void;
  /** Use a specific provider instead of the active one (never uses several AIs). */
  provider?: string;
  /** Progress lines while several AIs work on the request ("Asking 3 AIs…", "Round 2 of 3: 1 objection"). */
  onStatus?: (text: string) => void;
}

/** `truncated`: the answer stopped early (length limit, content filter), so it is not the whole text asked for. */
export interface ChatResult {
  text: string; model: string; provider: string; providerName: string; usage?: { in: number; out: number }; truncated?: boolean;
  /** Set when several AIs answered: each member's answer, the rounds and the outcome. model/provider then name the master or clerk. */
  ensemble?: EnsembleInfo;
}

/** Finish reasons (OpenAI, Anthropic, Gemini) meaning the model did not end the answer itself. */
const CUT = new Set(['length', 'content_filter', 'max_tokens', 'refusal', 'model_context_window_exceeded', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'LANGUAGE']);
const cutShort = (reason: unknown) => typeof reason === 'string' && CUT.has(reason);

export { AiError };

/** Native HTTP (no CORS) exists: the Android or iOS app, or the desktop app. */
const isNativeApp = () => Capacitor.isNativePlatform() || !!desktopHttp;

// ------------------------------------------------------------------------------------------
// HTTP

interface HttpReq { url: string; method?: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown; signal?: AbortSignal }
/** `retryAfter`: the server's Retry-After, in seconds. */
interface HttpRes { status: number; text: string; retryAfter?: number }

/** No answer (or, when streaming, no first byte) within this time: give up. Matches the native read timeout. */
const RESPONSE_TIMEOUT_MS = 180000;
/** A stream that goes silent for this long is taken as broken. */
const STREAM_IDLE_MS = 120000;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 2;

/**
 * How long to wait before asking again after `status` (attempt 0 is the first failure), or null to stop:
 * the server's Retry-After when it is short, otherwise 1 s and then 3 s. A long Retry-After (an exhausted
 * daily quota) is not waited for.
 */
export function retryDelayMs(status: number, attempt: number, retryAfter?: number): number | null {
  if (!RETRY_STATUS.has(status) || attempt >= MAX_RETRIES) return null;
  if (retryAfter != null && Number.isFinite(retryAfter)) return retryAfter > 15 ? null : Math.max(0, retryAfter * 1000);
  return attempt === 0 ? 1000 : 3000;
}

const retryAfterOf = (v: unknown): number | undefined => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : undefined; };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AiError('Stopped', 'aborted')); return; }
    const stop = () => { clearTimeout(t); reject(new AiError('Stopped', 'aborted')); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** An abort signal that follows the caller's Stop and also fires after `ms`; `arm` restarts the clock. */
function deadline(signal: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (t: number) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctl.abort(); }, t); };
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort(); else signal?.addEventListener('abort', onAbort, { once: true });
  arm(ms);
  return { signal: ctl.signal, arm, timedOut: () => timedOut, end: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

const timeoutError = (def: ProviderDef, ms: number) => new AiError(`${def.name} did not answer within ${Math.round(ms / 1000)} seconds.`, 'network');

/** Native requests cannot be canceled: Stop stops waiting for them, and the late answer is dropped. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AiError('Stopped', 'aborted'));
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new AiError('Stopped', 'aborted'));
    signal.addEventListener('abort', stop, { once: true });
    p.then((v) => { signal.removeEventListener('abort', stop); resolve(v); }, (e) => { signal.removeEventListener('abort', stop); reject(e); });
  });
}

async function viaNative(def: ProviderDef, r: HttpReq): Promise<HttpRes> {
  if (r.signal?.aborted) throw new AiError('Stopped', 'aborted');
  const req = desktopHttp
    ? desktopHttp({ url: r.url, method: r.method || 'GET', headers: r.headers, data: r.body }).then((res) => ({ status: res.status, text: res.text, retryAfter: retryAfterOf(res.retryAfter) }))
    : CapacitorHttp.request({ url: r.url, method: r.method || 'GET', headers: r.headers, data: r.body, responseType: 'text', connectTimeout: 30000, readTimeout: RESPONSE_TIMEOUT_MS })
      .then((res) => ({ status: res.status, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), retryAfter: retryAfterOf(res.headers?.['Retry-After'] ?? res.headers?.['retry-after']) }));
  try {
    return await abortable(req, r.signal);
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw networkError(def, e, r.url, true);
  }
}

/** Plain request, asked again after a short wait when the service is busy or rate-limited. */
async function http(def: ProviderDef, r: HttpReq): Promise<HttpRes> {
  for (let attempt = 0; ; attempt++) {
    const res = await httpOnce(def, r);
    const wait = retryDelayMs(res.status, attempt, res.retryAfter);
    if (wait == null) return res;
    await sleep(wait, r.signal);
  }
}

/** One request. Falls back to native HTTP in the app when the browser layer refuses. */
async function httpOnce(def: ProviderDef, r: HttpReq): Promise<HttpRes> {
  if (isNativeApp() && def.cors === 'no') return viaNative(def, r);
  const d = deadline(r.signal, RESPONSE_TIMEOUT_MS);
  try {
    const res = await fetch(r.url, { method: r.method || 'GET', headers: r.headers, body: r.body == null ? undefined : JSON.stringify(r.body), signal: d.signal });
    return { status: res.status, text: await res.text(), retryAfter: retryAfterOf(res.headers?.get?.('retry-after')) };
  } catch (e: any) {
    if (r.signal?.aborted) throw new AiError('Stopped', 'aborted');
    if (d.timedOut()) throw timeoutError(def, RESPONSE_TIMEOUT_MS);
    if (e?.name === 'AbortError') throw new AiError('Stopped', 'aborted');
    // The desktop bridge only makes https requests: for a local http server keep the real error.
    if (isNativeApp() && !(desktopHttp && /^http:\/\//i.test(r.url))) return viaNative(def, r);
    throw networkError(def, e, r.url);
  } finally {
    d.end();
  }
}

/** A provider's answer as JSON; a web page or an empty body (wrong address, a proxy's error page) is reported as such. */
function parseBody(def: ProviderDef, text: string): any {
  try { return JSON.parse(text); } catch {
    throw new AiError(`${def.name} answered with something that is not JSON (${text.trim().slice(0, 80) || 'an empty reply'}). Check the server address.`, 'other');
  }
}

/** A stream that broke (network, timeout) after text arrived: the text is kept and the answer marked incomplete. */
const keepPartial = (e: unknown, full: string, signal?: AbortSignal) => !!full && !signal?.aborted && e instanceof AiError && e.code === 'network';

function networkError(def: ProviderDef, e: unknown, url = def.baseUrl, native = false): AiError {
  const why = String((e as Error)?.message || e);
  if (def.cors === 'no' && !native) return new AiError(`${def.name} cannot be called from a web browser (it does not allow cross-origin requests). Use the Android, iOS or desktop app, or another provider.`, 'cors');
  // The apps and https pages can use plain http only for a server on this device (Android
  // cleartext policy, mixed content, the desktop content policy).
  const httpPage = typeof location !== 'undefined' && location.protocol === 'http:';
  if (/^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])([:/]|$)/i.test(url) && !httpPage) {
    return new AiError(`Could not reach ${url}: Anne's Folio can use plain http:// only for a server on this device (localhost). Serve the other computer's AI server over https instead. (${why})`, 'network');
  }
  if (def.kind === 'openai' && /localhost|127\.0\.0\.1|192\.168\.|10\./.test(url)) {
    return new AiError(`Could not reach the local server. Is it running, and is cross-origin access enabled? (${why})`, 'network');
  }
  return new AiError(`Could not reach ${def.name}: ${why}. Check the connection.`, 'network');
}

/** Splits complete server-sent-event blocks off the buffer. Events end with a blank line; servers mix \n and \r\n, so the separator is 2 to 4 characters. */
export function takeSseBlocks(buf: string): [string[], string] {
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = /\r?\n\r?\n/.exec(buf))) {
    blocks.push(buf.slice(0, m.index));
    buf = buf.slice(m.index + m[0].length);
  }
  return [blocks, buf];
}

/** Streaming SSE request; returns null if streaming is unavailable here (caller retries without). A busy service is asked again before any text has streamed. */
async function sse(def: ProviderDef, r: HttpReq, onEvent: (data: string, event: string) => void): Promise<HttpRes | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await sseOnce(def, r, onEvent);
    const wait = res ? retryDelayMs(res.status, attempt, res.retryAfter) : null;
    if (!res || wait == null) return res;
    await sleep(wait, r.signal);
  }
}

async function sseOnce(def: ProviderDef, r: HttpReq, onEvent: (data: string, event: string) => void): Promise<HttpRes | null> {
  if (isNativeApp() && def.cors === 'no') return null;
  const d = deadline(r.signal, RESPONSE_TIMEOUT_MS);
  try {
    return await sseRead(def, r, onEvent, d);
  } finally {
    d.end();
  }
}

async function sseRead(def: ProviderDef, r: HttpReq, onEvent: (data: string, event: string) => void, d: ReturnType<typeof deadline>): Promise<HttpRes | null> {
  let res: Response;
  try {
    res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body), signal: d.signal });
  } catch (e: any) {
    if (r.signal?.aborted) throw new AiError('Stopped', 'aborted');
    if (d.timedOut()) throw timeoutError(def, RESPONSE_TIMEOUT_MS);
    if (e?.name === 'AbortError') throw new AiError('Stopped', 'aborted');
    if (isNativeApp()) return null;
    throw networkError(def, e, r.url);
  }
  if (!res.ok || !res.body) return { status: res.status, text: await res.text(), retryAfter: retryAfterOf(res.headers?.get?.('retry-after')) };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const dispatch = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) onEvent(data.join('\n'), event);
  };
  try {
    for (;;) {
      d.arm(STREAM_IDLE_MS);
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const [blocks, rest] = takeSseBlocks(buf);
      buf = rest;
      blocks.forEach(dispatch);
    }
    buf += dec.decode();
    if (buf.trim()) dispatch(buf);
  } catch (e: any) {
    void reader.cancel().catch(() => undefined);
    if (r.signal?.aborted) throw new AiError('Stopped', 'aborted');
    if (d.timedOut()) throw timeoutError(def, STREAM_IDLE_MS);
    if (e instanceof AiError) throw e;
    if (e?.name === 'AbortError') throw new AiError('Stopped', 'aborted');
    // The connection dropped mid-answer.
    throw networkError(def, e, r.url);
  }
  return { status: 200, text: '' };
}

function httpError(def: ProviderDef, status: number, body: string, model: string): AiError {
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || j?.message || j?.error?.code || j?.detail || (typeof j?.error === 'string' ? j.error : '') || body;
  } catch { /* not JSON */ }
  msg = String(msg).slice(0, 400);
  if (status === 401 || status === 403) return new AiError(`${def.name} rejected the API key (${status}). ${msg}`, 'auth', status);
  if (status === 402 || status === 429) return new AiError(`${def.name}: quota or rate limit reached (${status}). ${msg}`, 'quota', status);
  if (status === 404 || /model.*(not found|does not exist|unknown|invalid)/i.test(msg)) return new AiError(`${def.name} does not offer the model "${model}". Choose another in AI ▸ Providers & Models. (${msg})`, 'model', status);
  return new AiError(`${def.name} error ${status}: ${msg}`, 'other', status);
}

// ------------------------------------------------------------------------------------------
// Adapters

const textOf = (c: ChatMessage['content']) => (typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'));
const splitDataUrl = (u: string) => { const m = /^data:([^;,]+);base64,(.*)$/.exec(u); return m ? { mime: m[1], data: m[2] } : null; };

/**
 * Models that think before answering count that thinking against the output limit, so a small limit
 * (a 10-token key test, a 120-token caption) can be used up before any answer is written. For those
 * APIs the limit sent is never below this.
 */
export const MIN_REASONING_LIMIT = 1024;
const outputLimit = (def: ProviderDef, n: number) => (def.kind === 'anthropic' || def.completionTokens ? Math.max(n, MIN_REASONING_LIMIT) : n);

/** What a service refused for a model earlier in this session, so later requests leave it out instead of failing first. */
const refused = new Map<string, Set<string>>();
const refusedFor = (key: string) => refused.get(key) || new Set<string>();
function remember(key: string, names: Iterable<string>): void {
  const set = refused.get(key) || new Set<string>();
  for (const n of names) set.add(n);
  if (set.size) refused.set(key, set);
}
/** For tests. */
export function forgetRefusedParams(): void { refused.clear(); }

async function openaiChat(rp: ResolvedProvider, model: string, req: ChatRequest): Promise<ChatResult> {
  const { def, key, baseUrl } = rp;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(def.extraHeaders || {}) };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (def.id === 'azure' && key) headers['api-key'] = key;
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.dataUrl } })),
  }));
  const memo = `${def.id}|${baseUrl}|${model}`;
  const known = refusedFor(memo);
  const params: Record<string, unknown> = { model, messages };
  if (req.temperature != null && !known.has('temperature')) params.temperature = req.temperature;
  // `known` has 'tokens' when this model wanted the other name for the limit.
  if (req.maxTokens) params[!!def.completionTokens !== known.has('tokens') ? 'max_completion_tokens' : 'max_tokens'] = outputLimit(def, req.maxTokens);
  // Asks for token counts at the end of a stream (they are otherwise sent only without streaming).
  if (req.onToken && !known.has('stream_options')) params.stream_options = { include_usage: true };
  const url = `${baseUrl}/chat/completions`;
  const done = new Set<string>();
  const ok = (r: ChatResult): ChatResult => { remember(memo, done); return r; };

  for (;;) {
    let full = '';
    let finish: unknown = null;
    let usage: { in: number; out: number } | undefined;
    if (req.onToken) {
      let r: HttpRes | null;
      try {
        r = await sse(def, { url, headers, body: { ...params, stream: true }, signal: req.signal }, (data) => {
          if (data === '[DONE]') return;
          let j: any;
          try { j = JSON.parse(data); } catch { return; /* keep-alive or partial */ }
          // Gateways (OpenRouter...) report failures inside a 200 stream.
          if (j?.error) throw new AiError(`${def.name}: ${j.error.message || j.error.code || 'the answer failed'}`);
          const c = j?.choices?.[0];
          const d = c?.delta?.content;
          if (typeof d === 'string' && d) { full += d; req.onToken!(d, full); }
          if (c?.finish_reason) finish = c.finish_reason;
          if (j?.usage) usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 };
        });
      } catch (e) {
        if (keepPartial(e, full, req.signal)) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: true };
        throw e;
      }
      if (r && r.status === 200) return ok({ text: full, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(finish) });
      if (r) {
        if (adjustParams(params, r.status, r.text, done)) continue;
        throw httpError(def, r.status, r.text, model);
      }
    }
    const { stream_options: _streamOnly, ...plain } = params;
    const r = await http(def, { url, method: 'POST', headers, body: { ...plain, stream: false }, signal: req.signal });
    if (r.status >= 200 && r.status < 300) {
      const j = parseBody(def, r.text);
      if (j.error && !j.choices) throw new AiError(`${def.name}: ${j.error.message || j.error.code || 'the answer failed'}`);
      const msg = j.choices?.[0]?.message;
      const text = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? msg.content.map((p: any) => p.text || '').join('') : '';
      if (j.usage) usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 };
      req.onToken?.(text, text);
      return ok({ text, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(j.choices?.[0]?.finish_reason) });
    }
    if (adjustParams(params, r.status, r.text, done)) continue;
    throw httpError(def, r.status, r.text, model);
  }
}

/**
 * Changes the request once for a parameter the model refuses, and says whether to send it again:
 * temperature (dropped), the name of the output limit (max_tokens / max_completion_tokens, swapped),
 * and the streaming usage option (dropped). Only for "bad request" answers (400, 422), and each change
 * at most once per request (`done`), so the caller ends with the service's own message, not a loop.
 */
export function adjustParams(params: Record<string, unknown>, status: number, body: string, done: Set<string>): boolean {
  if (status !== 400 && status !== 422) return false;
  const take = (name: string) => { done.add(name); return true; };
  if (!done.has('temperature') && /temperature/i.test(body) && 'temperature' in params) { delete params.temperature; return take('temperature'); }
  if (!done.has('tokens')) {
    if (/max_tokens/i.test(body) && 'max_tokens' in params) { params.max_completion_tokens = params.max_tokens; delete params.max_tokens; return take('tokens'); }
    if (/max_completion_tokens/i.test(body) && 'max_completion_tokens' in params) { params.max_tokens = params.max_completion_tokens; delete params.max_completion_tokens; return take('tokens'); }
  }
  // Strict servers reject fields they do not know, some without naming them.
  if (!done.has('stream_options') && 'stream_options' in params) { delete params.stream_options; return take('stream_options'); }
  return false;
}

async function anthropicChat(rp: ResolvedProvider, model: string, req: ChatRequest): Promise<ChatResult> {
  const { def, key, baseUrl } = rp;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true',
  };
  const system = req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const messages = req.messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      const d = splitDataUrl(p.dataUrl);
      return d ? { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } } : { type: 'text', text: '[image]' };
    }),
  }));
  const memo = `${def.id}|${baseUrl}|${model}`;
  const body: Record<string, unknown> = { model, max_tokens: outputLimit(def, req.maxTokens || 4096), messages };
  if (system) body.system = system;
  if (req.temperature != null && !refusedFor(memo).has('temperature')) body.temperature = req.temperature;
  const url = `${baseUrl}/messages`;
  // Some models refuse a temperature: the request is sent again without it, and the model is remembered.
  const noTemperature = (r: HttpRes) => {
    if (r.status !== 400 || !('temperature' in body) || !/temperature/i.test(r.text)) return false;
    delete body.temperature;
    remember(memo, ['temperature']);
    return true;
  };
  for (;;) {
    let full = '';
    let stop: unknown = null;
    const usage = { in: 0, out: 0 };
    if (req.onToken) {
      let r: HttpRes | null;
      try {
        r = await sse(def, { url, headers, body: { ...body, stream: true }, signal: req.signal }, (data) => {
          try {
            const j = JSON.parse(data);
            if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') { full += j.delta.text; req.onToken!(j.delta.text, full); }
            if (j.type === 'message_start' && j.message?.usage) usage.in = j.message.usage.input_tokens || 0;
            if (j.type === 'message_delta' && j.usage) usage.out = j.usage.output_tokens || 0;
            if (j.type === 'message_delta' && j.delta?.stop_reason) stop = j.delta.stop_reason;
            if (j.type === 'error') throw new AiError(`${def.name}: ${j.error?.message || 'stream error'}`);
          } catch (e) { if (e instanceof AiError) throw e; }
        });
      } catch (e) {
        if (keepPartial(e, full, req.signal)) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: true };
        throw e;
      }
      if (r && r.status === 200) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(stop) };
      if (r && noTemperature(r)) continue;
      if (r) throw httpError(def, r.status, r.text, model);
    }
    const r = await http(def, { url, method: 'POST', headers, body, signal: req.signal });
    if (noTemperature(r)) continue;
    if (r.status < 200 || r.status >= 300) throw httpError(def, r.status, r.text, model);
    const j = parseBody(def, r.text);
    const text = (j.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    req.onToken?.(text, text);
    return { text, model, provider: def.id, providerName: def.name, usage: { in: j.usage?.input_tokens || 0, out: j.usage?.output_tokens || 0 }, truncated: cutShort(j.stop_reason) };
  }
}

async function geminiChat(rp: ResolvedProvider, model: string, req: ChatRequest): Promise<ChatResult> {
  const { def, key, baseUrl } = rp;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
  const system = req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const contents = req.messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => {
      if (p.type === 'text') return { text: p.text };
      const d = splitDataUrl(p.dataUrl);
      return d ? { inline_data: { mime_type: d.mime, data: d.data } } : { text: '[image]' };
    }),
  }));
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const gen: Record<string, unknown> = {};
  if (req.temperature != null) gen.temperature = req.temperature;
  if (req.maxTokens) gen.maxOutputTokens = req.maxTokens;
  if (Object.keys(gen).length) body.generationConfig = gen;
  const m = encodeURIComponent(model.replace(/^models\//, ''));
  let full = '';
  let finish: unknown = null;
  let usage: { in: number; out: number } | undefined;
  const take = (j: any) => {
    if (j?.error) throw new AiError(`${def.name}: ${j.error.message || 'the answer failed'}`);
    if (j?.promptFeedback?.blockReason) throw new AiError(`${def.name} blocked the request (${j.promptFeedback.blockReason}).`);
    const c = j?.candidates?.[0];
    const parts = c?.content?.parts || [];
    const t = parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
    if (c?.finishReason) finish = c.finishReason;
    if (j?.usageMetadata) usage = { in: j.usageMetadata.promptTokenCount || 0, out: j.usageMetadata.candidatesTokenCount || 0 };
    return t;
  };
  if (req.onToken) {
    let r: HttpRes | null;
    try {
      r = await sse(def, { url: `${baseUrl}/models/${m}:streamGenerateContent?alt=sse`, headers, body, signal: req.signal }, (data) => {
        let j: any;
        try { j = JSON.parse(data); } catch { return; /* partial */ }
        const t = take(j);
        if (t) { full += t; req.onToken!(t, full); }
      });
    } catch (e) {
      if (keepPartial(e, full, req.signal)) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: true };
      throw e;
    }
    if (r && r.status === 200) return { text: full, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(finish) };
    if (r) throw httpError(def, r.status, r.text, model);
  }
  const r = await http(def, { url: `${baseUrl}/models/${m}:generateContent`, method: 'POST', headers, body, signal: req.signal });
  if (r.status < 200 || r.status >= 300) throw httpError(def, r.status, r.text, model);
  const text = take(parseBody(def, r.text));
  req.onToken?.(text, text);
  return { text, model, provider: def.id, providerName: def.name, usage, truncated: cutShort(finish) };
}

async function builtinChat(model: string, req: ChatRequest): Promise<ChatResult> {
  const LM = (globalThis as any).LanguageModel;
  if (!LM) throw new AiError('This browser has no built-in AI model. It is available in desktop Chrome 148 or later on supported hardware; use another provider here.', 'unsupported');
  const avail = await LM.availability?.();
  if (avail === 'unavailable') throw new AiError('The browser reports its built-in model is unavailable on this device.', 'unsupported');
  const system = req.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const turns = req.messages.filter((m) => m.role !== 'system');
  const last = turns.pop();
  const session = await LM.create({
    initialPrompts: [...(system ? [{ role: 'system', content: system }] : []), ...turns.map((t) => ({ role: t.role, content: textOf(t.content) }))],
    signal: req.signal,
  });
  try {
    const prompt = textOf(last?.content || '');
    if (req.onToken && session.promptStreaming) {
      let full = '';
      for await (const chunk of session.promptStreaming(prompt, { signal: req.signal })) {
        const c = String(chunk);
        // Older implementations stream the whole text so far; newer ones stream deltas.
        const delta = c.startsWith(full) ? c.slice(full.length) : c;
        full = c.startsWith(full) ? c : full + c;
        if (delta) req.onToken(delta, full);
      }
      return { text: full, model, provider: 'builtin', providerName: 'Built-in browser AI' };
    }
    const text = String(await session.prompt(prompt, { signal: req.signal }));
    req.onToken?.(text, text);
    return { text, model, provider: 'builtin', providerName: 'Built-in browser AI' };
  } finally {
    session.destroy?.();
  }
}

// ------------------------------------------------------------------------------------------
// Public API

/** The ensemble plan for normal commands (no provider named), or null for a single AI. */
export function activeEnsemble(req: Pick<ChatRequest, 'provider'> = {}): EnsemblePlan | null {
  const s = aiSettings();
  return planEnsemble(req, s.ensemble, (id) => {
    const def = providerById(id);
    const cfg = s.providers[id];
    return def && cfg ? { model: cfg.model || def.models.quality, sequential: def.kind === 'local' } : null;
  });
}

/**
 * Sends a request. Normal commands go to the active provider, or to several AIs when AI Settings ▸
 * "Use several AIs" is on; a request that names a provider (key tests, "Try it") always goes to
 * that provider alone.
 */
export async function chat(req: ChatRequest): Promise<ChatResult> {
  const plan = activeEnsemble(req);
  if (plan) {
    return runEnsemble(req, plan, (provider, model, r) => chatOne({ ...r, provider, model }), { name: (id) => providerById(id)?.name || id });
  }
  return chatOne(req);
}

async function chatOne(req: ChatRequest): Promise<ChatResult> {
  const rp = await resolveProvider(req.provider);
  if (!rp) throw new AiError('No AI provider is set up yet.', 'no-provider');
  const { def, cfg } = rp;
  const model = req.model || (req.tier === 'fast' ? cfg.fastModel || cfg.model : cfg.model) || def.models.quality;
  if (def.needsKey && !rp.key && def.id !== 'custom') throw new AiError(`${def.name} has no API key. Open AI ▸ Set Up AI to add one.`, 'auth');
  let res: ChatResult;
  if (def.kind === 'anthropic') res = await anthropicChat(rp, model, req);
  else if (def.kind === 'gemini') res = await geminiChat(rp, model, req);
  else if (def.kind === 'builtin') res = await builtinChat(model, req);
  else if (def.kind === 'local') {
    const { localChat } = await import('./local');
    res = await localChat(model, req);
  } else res = await openaiChat(rp, model, req);
  recordUsage(res.usage?.in || 0, res.usage?.out || 0);
  // An answer that arrives after Stop (a request that could not be canceled) is dropped.
  if (req.signal?.aborted) throw new AiError('Stopped', 'aborted');
  return res;
}

/**
 * How much document text (characters) a whole-document command should send. Cloud models take the
 * full 24,000; a model running on this device (a 0.3–1 B model on the CPU, or the browser's) gets a
 * third of that, so an answer arrives in a reasonable time. With several AIs, the smallest counts.
 */
export function inputBudgetChars(providerId?: string | null): number {
  const s = aiSettings();
  const plan = providerId ? null : activeEnsemble();
  const ids = providerId ? [providerId] : plan ? [...plan.members.map((m) => m.provider), plan.master.provider] : s.active ? [s.active] : [];
  const onDevice = ids.some((id) => { const k = providerById(id)?.kind; return k === 'local' || k === 'builtin'; });
  return onDevice ? 8000 : 24000;
}

/** List models (validates the key at the same time). */
export async function listModels(rp: ResolvedProvider, signal?: AbortSignal): Promise<string[]> {
  const { def, key, baseUrl } = rp;
  if (def.kind === 'local') { const { LOCAL_MODELS } = await import('./local'); return LOCAL_MODELS.map((m) => m.id); }
  if (def.kind === 'builtin') {
    const LM = (globalThis as any).LanguageModel;
    if (!LM) throw new AiError('This browser has no built-in AI model (desktop Chrome 148+ only).', 'unsupported');
    const a = await LM.availability();
    if (a === 'unavailable') throw new AiError('The built-in model is unavailable on this device.', 'unsupported');
    return ['default'];
  }
  let url: string;
  const headers: Record<string, string> = { ...(def.extraHeaders || {}) };
  if (def.kind === 'anthropic') {
    url = `${baseUrl}/models?limit=100`;
    Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  } else if (def.kind === 'gemini') {
    url = `${baseUrl}/models?pageSize=200`;
    headers['x-goog-api-key'] = key;
  } else {
    url = `${baseUrl}/models`;
    if (key) headers.Authorization = `Bearer ${key}`;
    if (def.id === 'azure' && key) headers['api-key'] = key;
  }
  const r = await http(def, { url, method: 'GET', headers, signal });
  if (r.status < 200 || r.status >= 300) throw httpError(def, r.status, r.text, '');
  const j = parseBody(def, r.text);
  if (def.kind === 'gemini') {
    return (j.models || []).filter((m: any) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m: any) => String(m.name).replace(/^models\//, ''));
  }
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  const ids = list.map((m: any) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  // OpenRouter: put free models first so the free path is obvious.
  if (def.id === 'openrouter') {
    const free = list.filter((m: any) => m.id?.endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)).map((m: any) => m.id);
    return [...new Set(['openrouter/free', ...free, 'openrouter/auto', ...ids])];
  }
  return [...new Set(ids as string[])];
}

/** Pick sensible fast/quality models from a provider's list when the defaults are not offered. */
export function pickModels(def: ProviderDef, list: string[]): { fast: string; quality: string } {
  const has = (m: string) => list.includes(m);
  if (!list.length) return { fast: def.models.fast, quality: def.models.quality };
  const chatty = list.filter((m) => !/embed|whisper|tts|audio|image|vision-preview|moderation|rerank|guard|transcrib|dall-e|imagen|veo|search-preview/i.test(m));
  const pool = chatty.length ? chatty : list;
  const fast = has(def.models.fast) ? def.models.fast : pool.find((m) => /flash-lite|mini|luna|haiku|small|8b|20b|flash|lite|fast|instant/i.test(m)) || pool[0];
  const quality = has(def.models.quality) ? def.models.quality : pool.find((m) => /sonnet|sol|pro|large|medium|120b|70b|max|plus|flash-latest/i.test(m)) || fast;
  return { fast, quality };
}
