import { describe, expect, it, vi } from 'vitest';
import { openRouterAttributionFetch } from '../src/core/openrouter-attribution';
import { scopedFetch } from '../src/core/librechat';
import { openRouterPolicyFetch } from '../src/core/openrouter-policy';
import { boundedJson } from '../src/core/inference-discovery';
import { checkConnection } from '../src/core/connections';
import { defaultSettings } from '../src/shared/config';
const json = (data: unknown) => new Response(JSON.stringify(data));
function attributed(options?: RequestInit) {
  const headers = new Headers(options?.headers);
  expect(headers.get('HTTP-Referer')).toBe('https://tinygpt.org');
  expect(headers.get('X-OpenRouter-Title')).toBe('TinyGPT');
  expect(headers.get('X-Title')).toBe('TinyGPT');
  expect(headers.has('Origin')).toBe(false);
  expect(options?.redirect).toBe('error');
}
describe('OpenRouter app attribution', () => {
  it.each([
    { Authorization: 'Bearer fixture', 'X-Title': 'SDK name', 'HTTP-Referer': 'https://sdk.example' },
    new Headers({ Authorization: 'Bearer fixture', 'X-OpenRouter-Title': 'SDK name' }),
    [['Authorization', 'Bearer fixture'], ['X-Title', 'SDK name']] as [string, string][],
  ])('preserves credentials and request data while overriding SDK attribution', async headers => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    const controller = new AbortController();
    const options = { method: 'POST', headers, body: '{"model":"fixture"}', signal: controller.signal };
    const originalHeaders = [...new Headers(headers)];
    await openRouterAttributionFetch(request)('https://openrouter.ai/api/v1/chat/completions', options);
    const sent = request.mock.calls[0][1]; attributed(sent);
    expect(new Headers(sent?.headers).get('Authorization')).toBe('Bearer fixture');
    expect(sent?.body).toBe(options.body); expect(sent?.signal).toBe(controller.signal); expect(sent?.method).toBe('POST');
    expect([...new Headers(headers)]).toEqual(originalHeaders);
  });
  it('supports Request resources without dropping their original headers', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    const resource = new Request('https://openrouter.ai/api/v1/key', { headers: { Authorization: 'Bearer request-key' } });
    await openRouterAttributionFetch(request)(resource);
    expect(request.mock.calls[0][0]).toBe(resource); attributed(request.mock.calls[0][1]);
    expect(new Headers(request.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer request-key');
    expect(resource.headers.has('X-OpenRouter-Title')).toBe(false);
  });
  it.each(['https://api.openai.com/v1/models', 'http://127.0.0.1:1234/v1/models', 'https://openrouter.ai.attacker.example/api/v1/key', 'http://openrouter.ai/api/v1/models'])('leaves other origins untouched: %s', async url => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({})); const options = { headers: { Authorization: 'Bearer fixture' }, redirect: 'error' as const };
    await openRouterAttributionFetch(request)(url, options);
    expect(request.mock.calls[0]).toEqual([url, options]); expect(request.mock.calls[0][1]).toBe(options);
  });
  it('attributes catalogs, authentication/account JSON, and native Code/Chat transport boundaries', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async resource => String(resource).includes('/models') ? json({ data: [] }) : json({}));
    await checkConnection({ ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1' } }, 'byok', 'fixture', request);
    await boundedJson('https://openrouter.ai/api/v1/auth/keys', { method: 'POST', body: '{"code":"fixture"}' }, request);
    await boundedJson('https://openrouter.ai/api/v1/key', {}, request);
    await boundedJson('https://openrouter.ai/api/v1/credits', {}, request);
    await scopedFetch('https://openrouter.ai/api/v1', request)('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' });
    const transport = openRouterPolicyFetch(request, { provider: 'openrouter', protocol: 'openai-compatible', model: 'fixture' });
    await transport(new URL('https://openrouter.ai/api/v1/models'));
    expect(request).toHaveBeenCalledTimes(6);
    for (const [, options] of request.mock.calls) attributed(options);
  });
});
