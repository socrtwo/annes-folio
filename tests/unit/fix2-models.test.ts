/** Provider registry: every entry is usable as shipped, and ids found retired or unsupported (November 2026) stay out. */
import { describe, it, expect } from 'vitest';
import { PROVIDERS, providerById } from '../../src/ai/providers';

/** Entries whose model and server the user supplies, or that make no HTTP calls. */
const USER_SUPPLIED = new Set(['custom']);
const NO_HTTP = new Set(['local', 'builtin']);

describe('provider registry', () => {
  it('has no duplicate provider ids', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every provider a non-empty default fast and quality model', () => {
    for (const p of PROVIDERS) {
      if (USER_SUPPLIED.has(p.id)) continue;
      expect(p.models.fast.trim(), `${p.id} fast`).not.toBe('');
      expect(p.models.quality.trim(), `${p.id} quality`).not.toBe('');
    }
  });

  it('uses an https base URL (plain http only for a server on localhost)', () => {
    for (const p of PROVIDERS) {
      if (USER_SUPPLIED.has(p.id) || NO_HTTP.has(p.kind)) continue;
      const url = new URL(p.baseUrl.replace(/\{(\w+)\}/g, 'x'));
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      expect(url.protocol === 'https:' || (local && url.protocol === 'http:'), `${p.id} ${p.baseUrl}`).toBe(true);
    }
  });

  it('does not default to model ids the vendors retired or do not serve on that endpoint', () => {
    const bedrock = providerById('bedrock')!;
    // Bedrock's /openai/v1 Chat Completions route rejects Claude models; bedrock-runtime ids carry a version suffix.
    expect(bedrock.baseUrl).toContain('/openai/v1');
    for (const m of [bedrock.models.fast, bedrock.models.quality]) {
      expect(m).not.toMatch(/anthropic/);
      expect(m).toMatch(/^openai\.gpt-oss-\d+b-1:0$/);
    }
    // DeepSeek retired deepseek-chat / deepseek-reasoner (24 July 2026).
    expect(Object.values(providerById('deepseek')!.models)).not.toContain('deepseek-chat');
    expect(Object.values(providerById('deepseek')!.models)).not.toContain('deepseek-reasoner');
    // OpenAI shut gpt-image-1 down (23 October 2026).
    expect(providerById('openai')!.images).not.toBe('gpt-image-1');
    // Moonshot no longer offers the K2 series to new accounts.
    expect(Object.values(providerById('moonshot')!.models).some((m) => /^kimi-k2/.test(m))).toBe(false);
    // Cloudflare retires @cf/zai-org/glm-5.3-flash on 20 November 2026.
    expect(Object.values(providerById('cloudflare')!.models)).not.toContain('@cf/zai-org/glm-5.3-flash');
  });
});
