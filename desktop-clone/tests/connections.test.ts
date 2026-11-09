import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../src/shared/config';
import { checkConnection, modelsUrl } from '../src/core/connections';

function response(data: unknown) { return new Response(JSON.stringify(data), { status: 200 }); }

describe('connection checks', () => {
  it('collects paginated Claude catalogs using bounded same-endpoint cursors', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ data: [{ id: 'first' }], has_more: true, last_id: 'first' })).mockResolvedValueOnce(response({ data: [{ id: 'later', max_input_tokens: 64000 }, { id: 'first' }], has_more: false }));
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'anthropic' as const, protocol: 'anthropic' as const, endpoint: 'https://api.anthropic.com/v1', model: 'later' } };
    const report = await checkConnection(settings, 'byok', 'test-only-secret', request);
    expect(report.models).toEqual(['first', 'later']); expect(report.modelDetails).toHaveLength(2); expect(report.modelAvailable).toBe(true); expect(report.modelContextWindowTokens).toBe(64000);
    expect(request.mock.calls[1][0]).toBe('https://api.anthropic.com/v1/models?after_id=first&limit=100');
    expect(request.mock.calls[0][1]?.signal).toBe(request.mock.calls[1][1]?.signal);
  });
  it('stops a catalog that repeats its pagination cursor', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }));
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, protocol: 'anthropic' as const } };
    await expect(checkConnection(settings, 'byok', 'test-only-secret', request)).rejects.toThrow('compatible model list'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('discovers mandatory, bounded, and budget-only OpenRouter reasoning per model', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [
      { id: 'required', pricing: { prompt: '0', completion: '0' }, reasoning: { supported_efforts: ['high', 'medium', 'low'], mandatory: true } },
      { id: 'budget', pricing: { prompt: '0', completion: '0' }, reasoning: { supports_max_tokens: true, mandatory: false } },
      { id: 'plain-model', pricing: { prompt: '0', completion: '0' } },
    ] }));
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'openrouter' as const, protocol: 'openai-compatible' as const } };
    const report = await checkConnection(settings, 'byok', 'test-only-secret', request);
    expect(report.modelDetails?.find(model => model.id === 'required')?.reasoning).toMatchObject({ kind: 'openrouter', efforts: ['high', 'medium', 'low'], canDisable: false });
    expect(report.modelDetails?.find(model => model.id === 'budget')?.reasoning).toMatchObject({ kind: 'openrouter', efforts: [], canDisable: true, tokenBudget: true });
    expect(report.modelDetails?.find(model => model.id === 'plain-model')?.reasoning?.kind).toBe('none');
  });
  it('uses Claude advertised thinking types and effort levels instead of guessing from a new model ID', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: 'new-claude-model', max_input_tokens: 64000, capabilities: {
      thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: false } } },
      effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: true } },
    } }] }));
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'anthropic' as const, protocol: 'anthropic' as const, model: 'new-claude-model' } };
    const report = await checkConnection(settings, 'byok', 'test-only-secret', request);
    expect(report.modelContextWindowTokens).toBe(64000);
    expect(report.modelDetails?.[0].reasoning).toMatchObject({ kind: 'anthropic-adaptive', efforts: ['low', 'high', 'max'], canDisable: false });
  });
  it('accepts explicit local-server capabilities and ignores malformed optional declarations', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [
      { id: 'controlled', tinygpt_reasoning: { kind: 'ollama', efforts: ['low', 'high'], canDisable: true } },
      { id: 'malformed', tinygpt_reasoning: { kind: 'arbitrary', efforts: ['bad'], canDisable: true } },
    ] }));
    const report = await checkConnection(defaultSettings, 'local', undefined, request);
    expect(report.modelDetails?.[0].reasoning).toEqual({ kind: 'ollama', efforts: ['low', 'high'], canDisable: true });
    expect(report.modelDetails?.[1].reasoning?.kind).toBe('none');
  });
  it.each(['context_length', 'context_window', 'max_model_len'])('discovers selected model capacity from %s', async field => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: 'other', [field]: 32768 }, { id: 'local-model', [field]: 8192 }] }));
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'local-model' } };
    expect((await checkConnection(settings, 'local', undefined, request)).modelContextWindowTokens).toBe(8192);
  });
  it('ignores malformed capacity metadata without rejecting a valid model list', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: 'local-model', context_length: 'unknown' }] }));
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'local-model' } };
    expect(await checkConnection(settings, 'local', undefined, request)).toMatchObject({ modelAvailable: true });
    expect((await checkConnection(settings, 'local', undefined, vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: 'local-model', context_length: -1 }] }))))).not.toHaveProperty('modelContextWindowTokens');
  });
  it('checks a local server without requiring an API key', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: 'local-model' }] }));
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'local-model' } };
    const report = await checkConnection(settings, 'local', undefined, request);
    expect(report.modelAvailable).toBe(true);
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:11434/v1/models', expect.objectContaining({ headers: { Accept: 'application/json' }, redirect: 'error' }));
  });
  it('uses Anthropic headers instead of a Bearer token', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: 'claude-test' }] }));
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'anthropic' as const, protocol: 'anthropic' as const, endpoint: 'https://api.anthropic.com/v1', model: 'claude-test' } };
    await checkConnection(settings, 'byok', 'test-only-secret', request);
    expect(request.mock.calls[0][1]?.headers).toEqual({ Accept: 'application/json', 'x-api-key': 'test-only-secret', 'anthropic-version': '2023-06-01' });
  });
  it('does not send a network request for unimplemented Portal', async () => {
    const request = vi.fn<typeof fetch>();
    const report = await checkConnection(defaultSettings, 'portal', 'wallet-secret', request);
    expect(report.reachable).toBe(false);
    expect(report.models).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
  it('requires a key before BYOK requests', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(checkConnection(defaultSettings, 'byok', undefined, request)).rejects.toThrow('Add your provider API key first.');
    expect(request).not.toHaveBeenCalled();
  });
  it('does not echo an upstream error body containing a secret', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-request-echo', { status: 401 }));
    await expect(checkConnection(defaultSettings, 'byok', 'test-only-secret', request)).rejects.toThrow('The endpoint did not accept your credentials.');
  });
  it('rejects arbitrary successful payloads as model discovery', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ status: 'ok' }));
    await expect(checkConnection(defaultSettings, 'local', undefined, request)).rejects.toThrow('compatible model list');
  });
  it('caps upstream response size before parsing', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(2_000_001)));
    await expect(checkConnection(defaultSettings, 'local', undefined, request)).rejects.toThrow('The model list is too large.');
  });
  it('reports a reachable endpoint separately from model availability', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: 'another-model' }] }));
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'missing-model' } };
    const report = await checkConnection(settings, 'local', undefined, request);
    expect(report.reachable).toBe(true);
    expect(report.modelAvailable).toBe(false);
  });
  it('joins model routes without duplicate slashes', () => expect(modelsUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1/models'));
});
