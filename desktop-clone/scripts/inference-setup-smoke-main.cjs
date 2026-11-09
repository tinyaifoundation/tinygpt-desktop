// Test-process-only transport fixtures. Production entry points never import this file.
const { shell } = require('electron');
const assert = require('node:assert/strict');
const nativeFetch = global.fetch;
global.openrouterAccountFixture = { is_free_tier: true, limit_remaining: null };
global.openrouterCreditFixture = null;
global.providerCatalogRequests = [];
global.unavailableProvider = null;
global.fetch = async (resource, options) => {
  const url = new URL(String(resource));
  const provider = { 'api.openai.com': 'openai', 'api.anthropic.com': 'anthropic', 'api.x.ai': 'xai' }[url.hostname];
  if (provider) {
    assert.equal(url.pathname, provider === 'xai' ? '/v1/language-models' : '/v1/models');
    const headers = new Headers(options?.headers);
    const key = provider === 'anthropic' ? headers.get('x-api-key') : headers.get('Authorization')?.replace(/^Bearer /, '');
    global.providerCatalogRequests.push({ provider, key });
    if (global.unavailableProvider === provider) return new Response('{}', { status: 503 });
    const accepted = provider === 'openai' ? ['openai-fixture-key', 'openai-second-fixture-key'] : [`${provider}-fixture-key`];
    if (!accepted.includes(key)) return new Response('{}', { status: 401 });
    const name = { openai: 'GPT Fixture', anthropic: 'Claude Fixture', xai: 'Grok Fixture' }[provider];
    const models = [{ id: `${provider}-model`, name, context_window: 64000, supports_tool_calling: true, supports_vision: true }, { id: 'shared-model', name: 'Shared Model', supports_tool_calling: true },
      { id: 'gpt-image-2', name: 'Image Fixture' }, { id: 'text-embedding-3-small', name: 'Embedding Fixture' }, { id: 'gpt-4o-transcribe', name: 'Transcription Fixture' },
      { id: 'media-fixture', name: 'Media Fixture', output_modalities: ['image'] }];
    return new Response(JSON.stringify(provider === 'xai' ? { models } : { data: models }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.origin !== 'https://openrouter.ai') return nativeFetch(resource, options);
  const headers = new Headers(options?.headers);
  assert.equal(headers.get('HTTP-Referer'), 'https://tinygpt.org');
  assert.equal(headers.get('X-OpenRouter-Title'), 'TinyGPT');
  if (url.pathname === '/api/v1/auth/keys') return new Response(JSON.stringify({ key: 'smoke-openrouter-secret' }), { headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/v1/key') return new Response(JSON.stringify({ data: global.openrouterAccountFixture }), { headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/v1/credits') return new Response(JSON.stringify(global.openrouterCreditFixture ? { data: global.openrouterCreditFixture } : {}), { status: global.openrouterCreditFixture ? 200 : 403, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/v1/models') return new Response(JSON.stringify({ data: [
    { id: 'z-ai/glm-5.3-flash', name: 'Z.ai: GLM 5.3 Flash', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools', 'reasoning'] },
    { id: 'popular/paid', name: 'Popular Paid', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 64000, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, top_provider: { max_completion_tokens: 32000 } },
    { id: 'popular/free:free', name: 'Popular Free', pricing: { prompt: '0', completion: '0' }, context_length: 32768, supported_parameters: ['tools'], architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'other/free:free', name: 'Other Free', pricing: { prompt: '0', completion: '0' }, context_length: 8192, supported_parameters: [], architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
  ] }), { headers: { 'content-type': 'application/json' } });
  throw Error('Unexpected fixture URL');
};
shell.openExternal = async value => {
  const url = new URL(value); if (url.origin !== 'https://openrouter.ai') throw Error('Unexpected browser launch');
  if (global.pauseOpenrouterSignIn) return;
  const callback = new URL(url.searchParams.get('callback_url')); callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'smoke-code' }).toString();
  const response = await nativeFetch(callback); if (!response.ok) throw Error('Callback failed');
};
require('./tools-smoke-main.cjs');
