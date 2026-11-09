import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, openRouterCostTiers, settingsSchema } from '../src/shared/config';
import { checkConnection } from '../src/core/connections';
import { openRouterPayload, openRouterPolicyFetch } from '../src/core/openrouter-policy';
import { botProviderRequest } from '../src/main/bot-provider';
import type { ChatWorkerInput } from '../src/shared/chat';

const configured = { ...defaultSettings, route: 'byok' as const, byok: { ...defaultSettings.byok, provider: 'openrouter' as const, protocol: 'openai-compatible' as const, endpoint: 'https://openrouter.ai/api/v1', model: 'openrouter/auto-beta' }, openrouter: { ...defaultSettings.openrouter, access: 'paid' as const } };
const input = { ...configured.byok, openrouter: configured.openrouter };

describe('OpenRouter virtual routers', () => {
  it('defaults existing preferences to Low without changing their access or privacy', () => {
    const { costTier, ...previous } = configured.openrouter;
    expect(settingsSchema.parse({ ...configured, openrouter: { ...previous, zeroDataRetention: true } }).openrouter).toEqual({ ...configured.openrouter, zeroDataRetention: true, costTier: 'low' });
  });
  it.each(openRouterCostTiers)('sends the %s tier to the correct stable or beta plugin and preserves unrelated plugins', costTier => {
    for (const [model, id] of [['openrouter/auto-beta', 'auto-beta-router'], ['openrouter/auto', 'auto-router']]) {
      const wrongId = id === 'auto-router' ? 'auto-beta-router' : 'auto-router';
      const result = openRouterPayload({ models: ['fallback'], plugins: [{ id: 'web' }, { id: wrongId, cost_quality_tradeoff: .7 }, { id, cost_quality_tradeoff: .8, costTier: 'max', allowed_models: ['allowed'] }] }, { ...input, model, openrouter: { ...input.openrouter, costTier, nitro: true, zeroDataRetention: true } });
      expect(result.model).toBe(model); expect(result.models).toBeUndefined();
      expect(result.plugins).toEqual([{ id: 'web' }, { id, cost_tier: costTier, allowed_models: ['allowed'] }]);
      expect(JSON.stringify(result.plugins)).not.toMatch(/cost_quality_tradeoff|costTier/);
      expect(result.provider).toEqual({ sort: 'throughput', zdr: true, data_collection: 'deny' });
    }
  });
  it('preserves router model restrictions while replacing deprecated cost controls', () => {
    const result = openRouterPayload({ plugins: [{ id: 'auto-beta-router', allowed_models: ['one'], excluded_models: ['two'], cost_quality_tradeoff: .9 }] }, input);
    expect(result.plugins).toEqual([{ id: 'auto-beta-router', allowed_models: ['one'], excluded_models: ['two'], cost_tier: 'low' }]);
  });
  it('keeps free routing free and applies no auto cost plugin to manually selected models', () => {
    const free = openRouterPayload({ plugins: [{ id: 'auto-beta-router', cost_tier: 'max' }] }, { ...input, model: 'openrouter/free', openrouter: { ...input.openrouter, access: 'free', nitro: true } });
    expect(free.model).toBe('openrouter/free'); expect(free.plugins).toBeUndefined();
    expect(free.provider).toMatchObject({ max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    const manual = openRouterPayload({ plugins: [{ id: 'auto-beta-router' }] }, { ...input, model: 'provider/manual' });
    expect(manual.model).toBe('provider/manual'); expect(manual.plugins).toBeUndefined();
  });
  it('applies cost tiers at the outbound boundary for replies, summaries, metadata and bots', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    const connection = { ...input, openrouter: { ...input.openrouter, costTier: 'xhigh' as const } };
    const transport = openRouterPolicyFetch(request, connection);
    for (const purpose of ['reply', 'summary', 'metadata']) await transport(`${configured.byok.endpoint}/chat/completions`, { method: 'POST', body: JSON.stringify({ purpose, model: 'sdk-model' }) });
    for (const [, options] of request.mock.calls) {
      expect(JSON.parse(String(options?.body))).toMatchObject({ model: 'openrouter/auto-beta', plugins: [{ id: 'auto-beta-router', cost_tier: 'xhigh' }] });
      expect(new Headers(options?.headers).get('X-OpenRouter-Title')).toBe('TinyGPT');
    }
    const bot: ChatWorkerInput = { ...connection, route: 'byok', runId: 'fixture', instructions: '', messages: [], tools: true };
    expect(botProviderRequest(bot, { messages: [] }).body).toMatchObject({ model: 'openrouter/auto-beta', plugins: [{ id: 'auto-beta-router', cost_tier: 'xhigh' }] });
  });
  it('pins the default router without changing individual popularity and handles omitted virtual catalog entries', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ data: [
      { id: 'popular/free', pricing: { prompt: '0', completion: '0' } },
      { id: 'popular/paid', pricing: { prompt: '.01', completion: '.01' } },
      { id: 'less-popular/free', pricing: { prompt: '0', completion: '0' } },
      { id: 'openrouter/auto', pricing: { prompt: '0', completion: '0' } },
    ] })));
    const all = await checkConnection(configured, 'byok', 'key', request);
    expect(all.modelAvailable).toBe(true); expect(all.models[0]).toBe('openrouter/auto-beta');
    expect(all.models.filter(id => !id.startsWith('openrouter/'))).toEqual(['popular/free', 'popular/paid', 'less-popular/free']);
    const free = await checkConnection({ ...configured, byok: { ...configured.byok, model: 'openrouter/free' }, openrouter: { ...configured.openrouter, access: 'free' } }, 'byok', 'key', request);
    expect(free.modelAvailable).toBe(true); expect(free.models).toEqual(['openrouter/free', 'popular/free', 'less-popular/free']);
    expect(free.modelDetails?.[0]).toMatchObject({ name: 'Free Models Router', tools: true, images: true, free: true });
  });
});
