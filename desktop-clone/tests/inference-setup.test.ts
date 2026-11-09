import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultSettings, settingsSchema } from '../src/shared/config';
import { checkConnection } from '../src/core/connections';
import { discoverLocal, inspectLocal, withModel } from '../src/core/inference-discovery';
import { openRouterPayload, openRouterPolicyFetch } from '../src/core/openrouter-policy';
import { OpenRouterSignIn } from '../src/main/inference-auth';
import { botProviderRequest } from '../src/main/bot-provider';
import type { ChatWorkerInput } from '../src/shared/chat';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const settings = { ...defaultSettings, route: 'byok' as const, byok: { ...defaultSettings.byok, provider: 'openrouter' as const, protocol: 'openai-compatible' as const, endpoint: 'https://openrouter.ai/api/v1' } };

describe('inference setup', () => {
  it('preserves catalog popularity order and rejects paid, missing, malformed and ancillary pricing in free mode', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => json({ data: [
      { id: 'z/free', name: 'Popular Free', pricing: { prompt: '0', completion: '0', request: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, context_length: 128000 },
      { id: 'paid', pricing: { prompt: '.01', completion: '.01' } },
      { id: 'unknown' }, { id: 'ancillary', pricing: { prompt: '0', completion: '0', image: '.01' } },
      { id: 'bad', pricing: { prompt: 'NaN', completion: '0' } },
      { id: 'blank', pricing: { prompt: '', completion: '0' } },
      { id: 'a/free', pricing: { prompt: '0', completion: '0' } },
      { id: 'image-only', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] } },
    ] }));
    const report = await checkConnection(settings, 'byok', 'fixture-key', request);
    expect(report.models).toEqual(['openrouter/free', 'z/free', 'a/free']);
    expect(report.modelDetails?.find(model => model.id === 'z/free')).toMatchObject({ name: 'Popular Free', tools: true, images: true, contextWindowTokens: 128000, free: true });
    expect(String(request.mock.calls[0][0])).toContain('sort=most-popular');
    expect((await checkConnection({ ...settings, openrouter: { ...settings.openrouter, access: 'paid', zeroDataRetention: true } }, 'byok', 'fixture-key', request)).models).toContain('paid');
    expect(String(request.mock.calls[1][0])).toContain('zdr=true');
  });
  it('enforces privacy and free pricing for replies, metadata, and summaries without paid fallback models', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    const input = { provider: 'openrouter', protocol: 'openai-compatible', model: 'model:free', openrouter: { ...defaultSettings.openrouter, nitro: true, zeroDataRetention: true } };
    const transport = openRouterPolicyFetch(request, input);
    for (const purpose of ['reply', 'metadata', 'summary']) await transport('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ purpose, model: 'sdk-model', models: ['paid-fallback'], provider: { zdr: false } }) });
    for (const [, options] of request.mock.calls) {
      const headers = new Headers(options?.headers);
      expect(headers.get('HTTP-Referer')).toBe('https://tinygpt.org'); expect(headers.get('X-OpenRouter-Title')).toBe('TinyGPT');
      const payload = JSON.parse(String(options?.body));
      expect(payload.models).toBeUndefined(); expect(payload.model).toBe('model:free');
      expect(payload.provider).toEqual({ sort: 'throughput', max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, zdr: true, data_collection: 'deny' });
    }
    const paid = openRouterPayload({ model: 'wrong' }, { ...input, model: 'model', openrouter: { ...input.openrouter, access: 'paid', allowDataCollection: true } });
    expect(paid).toMatchObject({ model: 'model:nitro', provider: { zdr: true, data_collection: 'allow' } });
    const bot: ChatWorkerInput = { ...input, route: 'byok', runId: 'fixture', endpoint: settings.byok.endpoint, protocol: 'openai-compatible', instructions: '', messages: [], tools: false };
    expect(botProviderRequest(bot, { messages: [] }).body.provider).toMatchObject({ zdr: true, data_collection: 'deny' });
  });
  it('uses actual Ollama runtime context and advertised tools/vision and excludes embeddings', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async (resource, options) => {
      const path = new URL(String(resource)).pathname;
      if (path === '/v1/models') return json({ data: [{ id: 'chat' }, { id: 'embed' }] });
      if (path === '/api/tags') return json({ models: [{ name: 'chat' }, { name: 'embed' }] });
      if (path === '/api/ps') return json({ models: [{ name: 'chat', context_length: 16384 }] });
      if (path === '/api/show') return JSON.parse(String(options?.body)).model === 'chat' ? json({ capabilities: ['completion', 'vision', 'tools', 'thinking'], model_info: { 'qwen.context_length': 131072 } }) : json({ capabilities: ['embedding'] });
      return json({}, 404);
    });
    const found = await inspectLocal(defaultSettings, defaultSettings.local.endpoint, undefined, request);
    expect(found.name).toBe('Ollama'); expect(found.models).toHaveLength(1);
    expect(found.models[0]).toMatchObject({ id: 'chat', contextWindowTokens: 16384, tools: true, images: true, reasoning: { kind: 'ollama' } });
    const next = withModel({ ...defaultSettings, local: { ...defaultSettings.local, maxOutputTokens: 8000, reasoningOverride: { kind: 'none', efforts: [], canDisable: false } } }, 'local', found.models[0]);
    expect(next.local.reasoningOverride).toBeUndefined(); expect(next.local.maxOutputTokens).toBeUndefined(); expect(next.local.modelCapabilities?.model).toBe('chat');
  });
  it('reads LM Studio loaded context, skips embedding models and keeps unknown capabilities conservative', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async resource => {
      const path = new URL(String(resource)).pathname;
      if (path === '/v1/models') return json({ data: [{ id: 'chat' }, { id: 'embed' }] });
      if (path === '/api/v1/models') return json({ models: [{ key: 'chat', type: 'llm', display_name: 'Chat Model', max_context_length: 131072, loaded_instances: [{ config: { context_length: 8192 } }], capabilities: { vision: true, trained_for_tool_use: true } }, { key: 'embed', type: 'embedding' }] });
      return json({}, 404);
    });
    expect((await inspectLocal(defaultSettings, 'http://127.0.0.1:1234/v1', undefined, request)).models).toEqual([expect.objectContaining({ id: 'chat', name: 'Chat Model', contextWindowTokens: 8192, tools: true, images: true })]);
  });
  it('never sends a saved local key to another listener and reports authentication without exposing upstream bodies', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async resource => String(resource).includes(':1234') ? json('private-secret-echo', 401) : json({ data: [] }));
    const found = await discoverLocal(defaultSettings, [defaultSettings.local.endpoint, 'http://127.0.0.1:1234/v1'], 'fixture-key', request);
    expect(found.unavailable).toEqual([{ endpoint: 'http://127.0.0.1:1234/v1', message: 'This server requires an API key.' }]);
    for (const [url, options] of request.mock.calls.filter(([url]) => String(url).includes(':1234'))) expect(options?.headers).not.toHaveProperty('Authorization');
    await expect(inspectLocal(defaultSettings, 'https://external.example/v1', 'fixture-key', request)).rejects.toThrow('this computer');
  });
  it('migrates old settings with explicit free and privacy defaults', () => {
    const { openrouter, ...old } = defaultSettings;
    expect(settingsSchema.parse(old).openrouter).toEqual(defaultSettings.openrouter);
  });
});

describe('OpenRouter PKCE', () => {
  it('handles denied consent without state immediately and never echoes the provider error', async () => {
    const request = vi.fn<typeof fetch>();
    const auth = new OpenRouterSignIn(async value => { const url = new URL(value); const callback = new URL(url.searchParams.get('callback_url')!); callback.search = 'error=untrusted-secret-echo'; expect((await fetch(callback)).status).toBe(200); }, () => {}, request);
    try { await expect(auth.connect()).rejects.toThrow('sign-in was declined'); expect(request).not.toHaveBeenCalled(); } finally { auth.close(); }
  });
  it('validates state, exchanges an S256 verifier once, rejects replay and keeps the key in the main process', async () => {
    let callback!: URL; let challenge = '';
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, options) => {
      expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
      const headers = new Headers(options?.headers);
      expect(headers.get('HTTP-Referer')).toBe('https://tinygpt.org'); expect(headers.get('X-OpenRouter-Title')).toBe('TinyGPT');
      const body = JSON.parse(String(options?.body));
      expect(body.code).toBe('fixture-code'); expect(body.code_challenge_method).toBe('S256');
      expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge);
      return json({ key: 'fixture-openrouter-key' });
    });
    const auth = new OpenRouterSignIn(async value => {
      const url = new URL(value); challenge = url.searchParams.get('code_challenge')!; callback = new URL(url.searchParams.get('callback_url')!);
      const invalid = new URL(callback); invalid.search = new URLSearchParams({ state: 'wrong', code: 'stolen' }).toString();
      expect((await fetch(invalid)).status).toBe(403);
      invalid.search = new URLSearchParams({ state: 'é'.repeat(url.searchParams.get('state')!.length), code: 'stolen' }).toString();
      expect((await fetch(invalid)).status).toBe(403);
      callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code' }).toString();
      const response = await fetch(callback); expect(response.status).toBe(200); expect(await response.text()).not.toContain('fixture-code');
    }, () => {}, request);
    try { expect(await auth.connect()).toBe('fixture-openrouter-key'); expect((await fetch(callback)).status).toBe(404); expect(request).toHaveBeenCalledTimes(1); }
    finally { auth.close(); }
  });
  it('cancels a pending flow and never exchanges a code', async () => {
    const request = vi.fn<typeof fetch>(); let auth!: OpenRouterSignIn;
    auth = new OpenRouterSignIn(async () => { auth.cancel(); }, () => {}, request);
    try { await expect(auth.connect()).rejects.toThrow('canceled'); expect(request).not.toHaveBeenCalled(); } finally { auth.close(); }
  });
});
