/** Several AIs: a reply that cannot be read (or was cut off) is not agreement. */
import { describe, it, expect } from 'vitest';
import { parseStance, runEnsemble, outcomeLine, type EnsemblePlan, type MemberCall } from '../../src/ai/ensemble';

const plan: EnsemblePlan = { mode: 'consensus', members: [{ provider: 'a', model: 'ma' }, { provider: 'b', model: 'mb' }, { provider: 'c', model: 'mc' }], master: { provider: 'a', model: 'ma' }, maxRounds: 2, memberTimeoutMs: 5000 };
const isVote = (req: { messages: { content: unknown }[] }) => /Reply with JSON only/.test(String(req.messages[req.messages.length - 1].content));
/** Members answer; `vote` decides what each says about the minute. */
const meeting = (vote: (provider: string) => { text: string; truncated?: boolean }): MemberCall => async (provider, model, req) => ({
  model, provider, providerName: provider, ...(isVote(req) ? vote(provider) : { text: `answer from ${provider}` }),
});
const ask = { messages: [{ role: 'user' as const, content: 'What is 2+2?' }] };

describe('parseStance', () => {
  it('reads a stance from JSON, also inside code fences and after thinking', () => {
    expect(parseStance('{"stance":"unite"}')).toEqual({ stance: 'unite', reason: undefined, suggestedChange: undefined });
    expect(parseStance('```json\n{"stance":"block","reason":"wrong sum","suggested_change":"say 4"}\n```')).toEqual({ stance: 'block', reason: 'wrong sum', suggestedChange: 'say 4' });
    expect(parseStance('<think>hmm {"stance":"block"}</think>{"stance":"Stand Aside","reason":"fine"}').stance).toBe('stand-aside');
  });

  it('flags a reply it cannot read', () => {
    for (const t of ['', 'I agree with the minute.', '{"stance":"uni', '{"stance":"maybe"}']) expect(parseStance(t).unreadable, t).toBe(true);
    expect(parseStance('{"stance":"unite"}').unreadable).toBeUndefined();
  });
});

describe('consensus', () => {
  it('does not report unity when no reply could be read', async () => {
    const r = await runEnsemble(ask, plan, meeting(() => ({ text: 'Looks good to me!' })), { shuffle: (x) => x });
    expect(r.ensemble.outcome).toBe('no-unity');
    expect(r.ensemble.rounds).toHaveLength(1);
    expect(r.ensemble.rounds![0].responses).toEqual([]);
    expect(r.ensemble.note).toMatch(/not agreed/);
    expect(outcomeLine(r.ensemble)).toBe('Not agreed: no AI gave a readable reply on the minute');
    expect(r.text).toBe('answer from a'); // the clerk's minute is still shown
  });

  it('leaves out a reply that was cut off, even when its JSON happens to parse', async () => {
    const r = await runEnsemble(ask, plan, meeting((p) => (p === 'c' ? { text: '{"stance":"unite"}', truncated: true } : { text: '{"stance":"unite"}' })), { shuffle: (x) => x });
    expect(r.ensemble.outcome).toBe('unity');
    expect(r.ensemble.rounds![0].responses.map((x) => x.provider)).toEqual(['a', 'b']);
    expect(outcomeLine(r.ensemble)).toBe('United (2 of 2)');
  });

  it('an unreadable reply does not outvote a block', async () => {
    const r = await runEnsemble(ask, { ...plan, maxRounds: 1 }, meeting((p) => (p === 'b' ? { text: '{"stance":"block","reason":"wrong"}' } : { text: '???' })), { shuffle: (x) => x });
    expect(r.ensemble.outcome).toBe('no-unity');
    expect(r.ensemble.blocks).toEqual([{ provider: 'b', reason: 'wrong' }]);
  });
});
