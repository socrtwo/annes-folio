/** AI client: parameter retry, rate-limit retry, token floor, SSE splitting, partial streams, non-JSON bodies. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chat, adjustParams, retryDelayMs, takeSseBlocks, forgetRefusedParams, inputBudgetChars, MIN_REASONING_LIMIT, AiError } from '../../src/ai/client';
import { saveAiSettings, setApiKey, defaultAiSettings } from '../../src/ai/store';

type Call = { url: string; body: any };
let calls: Call[] = [];
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
/** `answers` are used in order; the last one repeats. */
function server(...answers: ((c: Call) => Response)[]) {
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const c = { url: String(url), body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(c);
    return answers[Math.min(n++, answers.length - 1)](c);
  }));
}
const ok = (text = 'hello') => () => json(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
const sseBody = (chunks: (string | Error)[]) => new ReadableStream<Uint8Array>({
  pull(c) {
    const next = chunks.shift();
    if (next === undefined) c.close();
    else if (next instanceof Error) c.error(next);
    else c.enqueue(new TextEncoder().encode(next));
  },
});
const ask = [{ role: 'user' as const, content: 'hi' }];

beforeEach(async () => {
  calls = [];
  forgetRefusedParams();
  localStorage.clear();
  saveAiSettings((s) => {
    Object.assign(s, defaultAiSettings());
    s.providers = {
      groq: { id: 'groq', model: 'm-groq' }, openai: { id: 'openai', model: 'm-openai' },
      anthropic: { id: 'anthropic', model: 'm-claude' }, gemini: { id: 'gemini', model: 'm-gemini' }, device: { id: 'device', model: 'x' },
    };
    s.active = 'groq';
  });
  for (const id of ['groq', 'openai', 'anthropic', 'gemini']) await setApiKey(id, 'test-key');
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('adjustParams', () => {
  it('changes a refused parameter once, and only for a bad-request answer', () => {
    const p: Record<string, unknown> = { temperature: 0, max_tokens: 100 };
    expect(adjustParams(p, 429, 'Rate limit. Try a lower temperature of requests', new Set())).toBe(false);
    expect(p).toEqual({ temperature: 0, max_tokens: 100 });
    const done = new Set<string>();
    expect(adjustParams(p, 400, "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'.", done)).toBe(true);
    expect(p).toEqual({ temperature: 0, max_completion_tokens: 100 });
    // The same complaint again (now about the other name): no second swap.
    expect(adjustParams(p, 400, 'max_completion_tokens is too large', done)).toBe(false);
    expect(adjustParams(p, 400, 'temperature is not supported', done)).toBe(true);
    expect('temperature' in p).toBe(false);
  });

  it('drops the streaming usage option for a server that rejects unknown fields without naming them', () => {
    const p: Record<string, unknown> = { stream_options: { include_usage: true } };
    const done = new Set<string>();
    expect(adjustParams(p, 422, 'Extra inputs are not permitted', done)).toBe(true);
    expect(p).toEqual({});
    expect(adjustParams(p, 422, 'Extra inputs are not permitted', done)).toBe(false);
  });
});

describe('parameter retry in a request', () => {
  it('ends with the service\'s own message instead of looping between the two limit names', async () => {
    server((c) => { const k = 'max_tokens' in c.body ? 'max_tokens' : 'max_completion_tokens'; return json(400, { error: { message: `${k} is too large: ${c.body[k]}. This model supports at most 4096.` } }); });
    const e: AiError = await chat({ provider: 'groq', messages: ask, maxTokens: 10000 }).then(() => { throw new Error('should fail'); }, (x) => x);
    expect(e.message).toContain('supports at most 4096');
    expect(e.message).not.toContain('rejected the request parameters');
    expect(calls.length).toBe(2); // the original and one swap
  });

  it('retries without temperature and remembers it for the model', async () => {
    server((c) => ('temperature' in c.body ? json(400, { error: { message: 'temperature is not supported with this model' } }) : ok()()));
    expect((await chat({ provider: 'groq', messages: ask, temperature: 0 })).text).toBe('hello');
    expect(calls.map((c) => 'temperature' in c.body)).toEqual([true, false]);
    await chat({ provider: 'groq', messages: ask, temperature: 0 });
    expect(calls.length).toBe(3); // no failed round trip the second time
    expect('temperature' in calls[2].body).toBe(false);
  });

  it('Anthropic: a refused temperature is dropped and the request sent again (consensus votes set temperature 0)', async () => {
    server((c) => ('temperature' in c.body
      ? json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature: non-default values are not supported for this model' } })
      : json(200, { content: [{ type: 'text', text: '{"stance":"unite"}' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 4 } })));
    const r = await chat({ provider: 'anthropic', messages: ask, temperature: 0, maxTokens: 400 });
    expect(r.text).toBe('{"stance":"unite"}');
    expect(calls.length).toBe(2);
    await chat({ provider: 'anthropic', messages: ask, temperature: 0, maxTokens: 400 });
    expect(calls.length).toBe(3);
  });
});

describe('busy or rate-limited service', () => {
  it('retryDelayMs: two retries, short Retry-After honoured, a long one not waited for', () => {
    expect(retryDelayMs(429, 0)).toBe(1000);
    expect(retryDelayMs(503, 1)).toBe(3000);
    expect(retryDelayMs(429, 2)).toBeNull();
    expect(retryDelayMs(429, 0, 2)).toBe(2000);
    expect(retryDelayMs(429, 0, 3600)).toBeNull();
    expect(retryDelayMs(400, 0)).toBeNull();
    expect(retryDelayMs(401, 0)).toBeNull();
  });

  it('asks again after a 429 and returns the answer', async () => {
    server(() => json(429, { error: { message: 'slow down' } }, { 'retry-after': '0' }), ok('second try'));
    expect((await chat({ provider: 'groq', messages: ask })).text).toBe('second try');
    expect(calls.length).toBe(2);
  });

  it('gives up after two retries with the quota message', async () => {
    server(() => json(429, { error: { message: 'slow down' } }, { 'retry-after': '0' }));
    const e: AiError = await chat({ provider: 'groq', messages: ask }).then(() => { throw new Error('should fail'); }, (x) => x);
    expect(e.code).toBe('quota');
    expect(calls.length).toBe(3);
  });

  it('a request that gets no answer times out instead of waiting forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))));
    const p = chat({ provider: 'groq', messages: ask }).then(() => 'answered', (e: AiError) => `${e.code}: ${e.message}`);
    await vi.advanceTimersByTimeAsync(181000);
    expect(await p).toMatch(/^network: Groq did not answer within 180 seconds/);
  });
});

describe('output limit', () => {
  it('is not below the reasoning floor for APIs that count thinking against it', async () => {
    server(ok());
    await chat({ provider: 'openai', messages: ask, maxTokens: 10 });
    expect(calls[0].body.max_completion_tokens).toBe(MIN_REASONING_LIMIT);
    server(() => json(200, { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
    await chat({ provider: 'anthropic', messages: ask, maxTokens: 10 });
    expect(calls[1].body.max_tokens).toBe(MIN_REASONING_LIMIT);
  });

  it('is sent as asked to other services', async () => {
    server(ok());
    await chat({ provider: 'groq', messages: ask, maxTokens: 10 });
    expect(calls[0].body.max_tokens).toBe(10);
  });
});

describe('server-sent events', () => {
  it('takeSseBlocks splits on blank lines whatever the line ending, across chunk boundaries', () => {
    let buf = '';
    const out: string[] = [];
    for (const chunk of ['data: {"a":1}\r', '\n\r', '\ndata: {"b"', ':2}\n\ndata: [DONE]\n', '\n', 'data: tail']) {
      const [blocks, rest] = takeSseBlocks(buf + chunk);
      buf = rest;
      out.push(...blocks);
    }
    expect(out).toEqual(['data: {"a":1}', 'data: {"b":2}', 'data: [DONE]']);
    expect(buf).toBe('data: tail');
  });

  it('streams tokens split across chunks and asks for usage', async () => {
    const delta = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
    const body = delta('Hel') + delta('lo') + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
    server(() => new Response(sseBody([body.slice(0, 25), body.slice(25, 60), body.slice(60)]), { status: 200 }));
    const seen: string[] = [];
    const r = await chat({ provider: 'groq', messages: ask, onToken: (d) => seen.push(d) });
    expect(seen).toEqual(['Hel', 'lo']);
    expect(r.text).toBe('Hello');
    expect(r.usage).toEqual({ in: 7, out: 2 });
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
  });

  it('keeps the text that arrived when the connection drops mid-answer, marked incomplete', async () => {
    const first = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer' } }] })}\n\n`;
    server(() => new Response(sseBody([first, new TypeError('network error')]), { status: 200 }));
    const r = await chat({ provider: 'groq', messages: ask, onToken: () => undefined });
    expect(r.text).toBe('Partial answer');
    expect(r.truncated).toBe(true);
  });

  it('a stream that breaks before any text is a network error, not a raw TypeError', async () => {
    server(() => new Response(sseBody([new TypeError('network error')]), { status: 200 }));
    const e = await chat({ provider: 'groq', messages: ask, onToken: () => undefined }).then(() => null, (x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe('network');
  });
});

describe('unexpected answers', () => {
  it('a web page instead of JSON is reported as such', async () => {
    server(() => new Response('<!doctype html><title>Sign in</title>', { status: 200 }));
    const e: AiError = await chat({ provider: 'groq', messages: ask }).then(() => { throw new Error('should fail'); }, (x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e.message).toMatch(/not JSON/);
  });
});

describe('inputBudgetChars', () => {
  it('is smaller for a model that runs on the device', () => {
    expect(inputBudgetChars('groq')).toBe(24000);
    expect(inputBudgetChars('device')).toBe(8000);
    expect(inputBudgetChars()).toBe(24000);
  });
});
