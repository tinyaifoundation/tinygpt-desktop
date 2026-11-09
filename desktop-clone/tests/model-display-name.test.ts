import { describe, expect, it } from 'vitest';
import { modelDisplayName } from '../src/shared/effort';
import { checkConnection } from '../src/core/connections';
import { withModel } from '../src/core/inference-discovery';
import { defaultSettings } from '../src/shared/config';

describe('model display names', () => {
  it('labels Auto Beta as Auto with or without catalog metadata and preserves its request ID', () => {
    for (const name of [undefined, 'Auto Router (Beta)', 'OpenRouter: Auto Router (Beta)']) expect(modelDisplayName({ id: 'openrouter/auto-beta', name }, true)).toBe('Auto');
    expect(modelDisplayName({ id: 'openrouter/auto-beta:nitro' }, true)).toBe('Auto');
    expect(modelDisplayName({ id: 'openrouter/auto', name: 'Auto Router' }, true)).toBe('Auto Router');
    expect(modelDisplayName({ id: 'openrouter/auto-beta', name: 'My local model' })).toBe('My local model');
  });
  it.each([
    ['z-ai/glm-5.3-flash', 'Z.ai: GLM 5.3 Flash', 'GLM 5.3 Flash'],
    ['openai/gpt-4.1', 'OpenAI: GPT-4.1', 'GPT-4.1'],
    ['google/gemini-2.5-pro', 'Gemini 2.5 Pro', 'Gemini 2.5 Pro'],
    ['meta-llama/llama-3.3-70b-instruct:free', 'Meta: Llama 3.3 70B Instruct (free)', 'Llama 3.3 70B Instruct (free)'],
    ['vendor/custom', 'Vendor: Family: Special Edition', 'Family: Special Edition'],
  ])('preserves catalog spelling and variants for %s', (id, name, expected) => {
    expect(modelDisplayName({ id, name }, true)).toBe(expected);
  });
  it('keeps custom and local names intact and avoids inventing spelling from IDs', () => {
    expect(modelDisplayName({ id: 'local-file', name: 'My model: Q4_K_M' })).toBe('My model: Q4_K_M');
    expect(modelDisplayName({ id: 'vendor/new-model', name: '  ' }, true)).toBe('vendor/new-model');
    expect(modelDisplayName({ id: 'vendor/model', name: '  GPT-4.1  ' }, true)).toBe('GPT-4.1');
  });
  it('carries the authoritative name through discovery and saved selection without changing the request ID', async () => {
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'openrouter' as const, protocol: 'openai-compatible' as const, model: 'z-ai/glm-5.3-flash' }, openrouter: { ...defaultSettings.openrouter, access: 'paid' as const } };
    const report = await checkConnection(settings, 'byok', 'fixture-key', async () => new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', supported_parameters: ['reasoning'] }] })));
    const next = withModel(settings, 'byok', report.modelDetails!.find(model => model.id === settings.byok.model)!);
    expect(next.byok.model).toBe('z-ai/glm-5.3-flash');
    expect(next.byok.modelCapabilities?.name).toBe('Z.ai: GLM 5.3 Flash');
    expect(modelDisplayName({ id: next.byok.model, name: next.byok.modelCapabilities?.name }, true)).toBe('GLM 5.3 Flash');
  });
});
