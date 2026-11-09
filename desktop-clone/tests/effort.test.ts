import { describe, expect, it, vi } from 'vitest';
import { effortFetch, effortPayload, reasoningProfile, resolveEffort } from '../src/core/effort';
import { defaultSettings, settingsSchema } from '../src/shared/config';
import { effortLevels, type ReasoningProfile } from '../src/shared/effort';
import { EFFORT_BUDGET_MESSAGE } from '../src/shared/effort';

const standard: ReasoningProfile = { kind: 'openai', efforts: ['none', 'low', 'medium', 'high'], canDisable: true };
const input = { provider: 'custom', protocol: 'openai-compatible', model: 'fixture', reasoning: standard };

describe('cross-provider effort adapter', () => {
  it('migrates old settings without changing connections or approvals', () => {
    const { effort: _effort, ...legacy } = defaultSettings;
    expect(settingsSchema.parse(legacy)).toEqual({ ...legacy, effort: { chat: 'medium', code: 'medium' } });
  });
  it('uses supported native levels instead of sending a universal max value', () => {
    expect(effortLevels.map(effort => resolveEffort(effort, standard))).toEqual(['none', 'low', 'medium', 'high', 'high']);
    expect(resolveEffort('max', { ...standard, efforts: [...standard.efforts, 'xhigh'] })).toBe('xhigh');
    expect(resolveEffort('max', { ...standard, efforts: ['low', 'medium', 'high', 'max'] })).toBe('max');
  });
  it('clamps Instant to the lowest offered level for mandatory reasoning', () => {
    const mandatory = { kind: 'openrouter' as const, efforts: ['high', 'medium', 'low'] as const, canDisable: false };
    expect(resolveEffort('instant', { ...mandatory, efforts: [...mandatory.efforts] })).toBe('low');
    expect(effortPayload({}, { ...input, reasoning: { ...mandatory, efforts: [...mandatory.efforts] }, effort: 'instant' }, 4096)).toEqual({ reasoning: { effort: 'low' } });
    expect(resolveEffort('instant', { kind: 'openai', efforts: ['medium', 'high'], canDisable: false })).toBe('medium');
  });
  it.each(['openai-compatible', 'openai-responses'])('sets the actual %s reasoning field while preserving tools', protocol => {
    const payload = { model: 'fixture', tools: [{ type: 'function' }], max_tokens: 4096, reasoning: { effort: 'max' }, reasoning_effort: 'high' };
    const result = effortPayload(payload, { ...input, protocol, effort: 'instant' }, 4096);
    expect(result.tools).toEqual(payload.tools); expect(result.max_tokens).toBe(4096);
    expect(protocol === 'openai-responses' ? result.reasoning : result.reasoning_effort).toEqual(protocol === 'openai-responses' ? { effort: 'none' } : 'none');
    expect(protocol === 'openai-responses' ? result.reasoning_effort : result.reasoning).toBeUndefined();
    expect(payload.reasoning).toEqual({ effort: 'max' });
  });
  it('uses native OpenRouter disabling, not hiding reasoning output', () => {
    expect(effortPayload({}, { ...input, effort: 'instant', reasoning: { ...standard, kind: 'openrouter' } }, 4096)).toEqual({ reasoning: { enabled: false, effort: 'none' } });
  });
  it('keeps Claude thinking budgets below the output cap with room for an answer', () => {
    const reasoning: ReasoningProfile = { kind: 'anthropic-budget', efforts: [], canDisable: true, tokenBudget: true };
    const results = effortLevels.map(effort => effortPayload({ max_tokens: 16384 }, { ...input, protocol: 'anthropic', reasoning, effort }, 16384));
    expect(results.map(result => result.thinking)).toEqual([{ type: 'disabled' }, { type: 'enabled', budget_tokens: 1024 }, { type: 'enabled', budget_tokens: 2048 }, { type: 'enabled', budget_tokens: 4096 }, { type: 'enabled', budget_tokens: 8192 }]);
    const bounded = effortPayload({}, { ...input, protocol: 'anthropic', reasoning, effort: 'max' }, 2048);
    expect(bounded.thinking).toEqual({ type: 'enabled', budget_tokens: 1228 });
    expect(() => effortPayload({}, { ...input, protocol: 'anthropic', reasoning, effort: 'max' }, 128)).toThrow(EFFORT_BUDGET_MESSAGE);
  });
  it('uses current Claude native adaptive controls and preserves unrelated output options', () => {
    const reasoning: ReasoningProfile = { kind: 'anthropic-adaptive', efforts: ['low', 'medium', 'high', 'max'], canDisable: true };
    const config = { ...input, protocol: 'anthropic', reasoning };
    expect(effortPayload({ output_config: { format: 'fixture' } }, { ...config, effort: 'max' }, 8192)).toEqual({ thinking: { type: 'adaptive' }, output_config: { format: 'fixture', effort: 'max' } });
    expect(effortPayload({ output_config: { effort: 'max' } }, { ...config, effort: 'instant' }, 8192)).toEqual({ thinking: { type: 'disabled' }, output_config: {} });
    expect(effortPayload({}, { ...config, reasoning: { ...reasoning, canDisable: false, instantThinking: 'between_tools' }, effort: 'instant' }, 8192)).toEqual({ thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
  });
  it.each(['ollama', 'llamacpp'] as const)('uses %s native controls without changing the user prompt or output budget', kind => {
    const result = effortPayload({ messages: [{ content: 'Question' }], max_tokens: 4096, chat_template_kwargs: { custom: true } }, { ...input, reasoning: { ...standard, kind }, effort: 'instant' }, 4096);
    expect(result.reasoning_effort).toBe('none'); expect(result.max_tokens).toBe(4096); expect(result.messages).toEqual([{ content: 'Question' }]);
    if (kind === 'llamacpp') expect(result.chat_template_kwargs).toEqual({ custom: true, enable_thinking: false });
  });
  it('uses native llama.cpp effort without forcing a thinking cutoff', () => {
    for (const efforts of [[], ['medium', 'xhigh']] as ReasoningProfile['efforts'][]) {
      const reasoning: ReasoningProfile = { kind: 'llamacpp', efforts, canDisable: true };
      const results = effortLevels.map(effort => effortPayload({ max_tokens: 16384 }, { ...input, reasoning, effort }, 16384));
      expect(results.map(result => result.reasoning_budget_tokens)).toEqual([0, undefined, undefined, undefined, undefined]);
      expect(results.every(result => result.max_tokens === 16384)).toBe(true);
    }
  });
  it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens'])('preserves the smaller %s request cap without forcing the thinking boundary', field => {
    const reasoning: ReasoningProfile = { kind: 'llamacpp', efforts: [], canDisable: true };
    const payload = { [field]: 128, reasoning_budget_tokens: -1, thinking_budget_tokens: -1, tools: [{ type: 'function' }], chat_template_kwargs: { custom: true } };
    const result = effortPayload(payload, { ...input, reasoning, effort: 'max' }, 16384);
    expect(result).toEqual({ [field]: 128, tools: payload.tools, chat_template_kwargs: { custom: true } });
    expect(payload.thinking_budget_tokens).toBe(-1);
    expect(effortPayload({ [field]: 16384 }, { ...input, reasoning, effort: 'max' }, 2048).reasoning_budget_tokens).toBeUndefined();
  });
  it('keeps mandatory Instant reasoning enabled at its lowest native effort', () => {
    const reasoning: ReasoningProfile = { kind: 'llamacpp', efforts: ['medium'], canDisable: false };
    expect(effortPayload({}, { ...input, reasoning, effort: 'instant' }, 16384)).toEqual({ reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } });
  });
  it('does not guess native parameters on arbitrary local and compatible endpoints', () => {
    for (const provider of ['local', 'custom']) {
      const unknown = { provider, protocol: 'openai-compatible', model: 'qwen-or-another-model', effort: 'max' as const };
      expect(reasoningProfile(unknown).kind).toBe('none'); expect(effortPayload({ model: unknown.model }, unknown, 8192)).toEqual({ model: unknown.model });
    }
    expect(reasoningProfile({ ...input, provider: 'openai', model: 'gpt-5.1-codex-max', reasoning: undefined }).kind).toBe('none');
    expect(reasoningProfile({ ...input, reasoning: { ...standard, kind: 'anthropic-adaptive' } }).kind).toBe('none');
    expect(reasoningProfile({ ...input, protocol: 'openai-responses', reasoning: { ...standard, kind: 'llamacpp' } }).kind).toBe('none');
  });
  it('honors current documented mandatory OpenAI and xAI models', () => {
    for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
      const profile = reasoningProfile({ provider: 'openai', model, protocol: 'openai-responses' });
      expect(resolveEffort('instant', profile)).toBe('low'); expect(resolveEffort('max', profile)).toBe('max');
    }
    const profile = reasoningProfile({ provider: 'xai', model: 'grok-4.7', protocol: 'openai-compatible' });
    expect(resolveEffort('instant', profile)).toBe('low'); expect(resolveEffort('max', profile)).toBe('xhigh');
  });
  it('adapts actual serialized requests and leaves summary requests independent', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const transport = effortFetch(request, { ...input, effort: 'instant' }, 4096);
    await transport('https://fixture.example/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture' }) });
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toMatchObject({ reasoning_effort: 'none' });
    const summary = effortFetch(request, { ...input, effort: 'max', purpose: 'summary' }, 4096);
    await summary('https://fixture.example/v1/chat/completions', { body: '{"model":"fixture"}' });
    expect(request.mock.calls[1][1]!.body).toBe('{"model":"fixture"}');
    const inRunSummary = effortFetch(request, { ...input, effort: 'max' }, 4096, () => true);
    await inRunSummary('https://fixture.example/v1/chat/completions', { body: '{"model":"fixture"}' });
    expect(request.mock.calls[2][1]!.body).toBe('{"model":"fixture"}');
  });
  it('reserves local metadata output for JSON independently of composer effort', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const local = { provider: 'local', protocol: 'openai-compatible', model: 'MiniCPM5-2B', reasoning: { kind: 'llamacpp' as const, efforts: [], canDisable: true } };
    const body = JSON.stringify({ model: local.model, max_tokens: 512, messages: [{ role: 'user', content: 'Saved conversation transcript' }] });
    await effortFetch(request, { ...local, purpose: 'metadata', effort: 'max' }, 512)('http://localhost/v1/chat/completions', { body });
    expect(JSON.parse(request.mock.calls[0][1]!.body as string)).toEqual({ ...JSON.parse(body), reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0 });
    for (const config of [
      { ...local, purpose: 'metadata', reasoning: { ...local.reasoning, canDisable: false } },
      { ...local, purpose: 'metadata', provider: 'openrouter' },
    ]) {
      await effortFetch(request, config, 512)('http://localhost/v1/chat/completions', { body });
      expect(request.mock.calls.at(-1)![1]!.body).toBe(body);
    }
    await effortFetch(request, { ...local, effort: 'medium' }, 4096)('http://localhost/v1/chat/completions', { body });
    expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string)).toEqual(JSON.parse(body));
    for (const internal of [effortFetch(request, { ...local, effort: 'max', purpose: 'summary' }, 512), effortFetch(request, { ...local, effort: 'max' }, 512, () => true)]) {
      await internal('http://localhost/v1/chat/completions', { body });
      expect(JSON.parse(request.mock.calls.at(-1)![1]!.body as string)).toMatchObject({ reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0 });
    }
  });
});
