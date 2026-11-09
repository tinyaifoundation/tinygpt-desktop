import { describe, expect, it, vi } from 'vitest';
import { googleExchange } from '../plugin-auth/src/google-exchange';
import { connectorRegistrations } from '../src/main/connector-registrations';
const env = () => ({ GOOGLE_CLIENT_SECRET: 'publisher-secret', TOKEN_LIMITER: { limit: vi.fn(async () => ({ success: true })) } });
function request(values: Record<string, string> = {}) { return new Request('https://plugin.tinygpt.org/oauth/google/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-TinyGPT-Connector': 'google' }, body: new URLSearchParams({ client_id: connectorRegistrations.google.clientId, grant_type: 'authorization_code', code: 'one-time-code', code_verifier: 'v'.repeat(43), redirect_uri: 'http://127.0.0.1:54321/oauth/callback', ...values }) }); }
describe('Google publisher exchange', () => {
  it('exchanges a PKCE code only with Google and returns no publisher credential or identity payload', async () => {
    const upstream = vi.fn(async (url, options) => {
      expect(url).toBe('https://oauth2.googleapis.com/token'); expect(options.redirect).toBe('manual');
      expect(options.body.get('client_secret')).toBe('publisher-secret'); expect(options.body.get('code_verifier')).toBe('v'.repeat(43));
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, id_token: 'private-identity' });
    }) as typeof fetch;
    const response = await googleExchange(request(), env(), upstream);
    expect(await response.json()).toEqual({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }); expect(response.headers.has('access-control-allow-origin')).toBe(false); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('refreshes without requiring Google to rotate the refresh token', async () => {
    const refresh = new Request('https://plugin.tinygpt.org/oauth/google/token', { method: 'POST', headers: request().headers, body: new URLSearchParams({ client_id: connectorRegistrations.google.clientId, grant_type: 'refresh_token', refresh_token: 'refresh' }) });
    expect(await (await googleExchange(refresh, env(), vi.fn(async () => Response.json({ access_token: 'next', expires_in: 3600 })) as typeof fetch)).json()).toEqual({ access_token: 'next', expires_in: 3600 });
  });
  it('rejects browser requests, foreign clients, redirects, duplicate fields, and invalid proofs', async () => {
    const browser = request(); browser.headers.set('Origin', 'https://attacker.invalid');
    const duplicate = request(); const body = await duplicate.text(); const duplicates = new Request(duplicate.url, { method: 'POST', headers: duplicate.headers, body: body + '&client_id=other' });
    const upstream = vi.fn();
    for (const value of [browser, duplicates, request({ client_id: 'other' }), request({ redirect_uri: 'https://attacker.invalid' }), request({ code_verifier: 'short' }), request({ redirect_uri: 'http://127.0.0.1:99999/oauth/callback' }), request({ token_endpoint: 'https://attacker.invalid' })]) expect((await googleExchange(value, env(), upstream)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('fails closed on absent credentials, rate limits, upstream redirects, oversized payloads and malformed success', async () => {
    expect((await googleExchange(request(), { ...env(), GOOGLE_CLIENT_SECRET: undefined })).status).toBe(503);
    const limited = env(); limited.TOKEN_LIMITER.limit.mockResolvedValue({ success: false }); expect((await googleExchange(request(), limited)).status).toBe(429);
    for (const response of [new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } }), new Response('x'.repeat(32001)), Response.json({ access_token: 'x' })]) expect((await googleExchange(request(), env(), vi.fn(async () => response) as typeof fetch)).status).toBe(502);
  });
  it('preserves reconnect errors without reflecting provider details', async () => {
    const response = await googleExchange(request(), env(), vi.fn(async () => Response.json({ error: 'invalid_grant', error_description: 'private detail' }, { status: 400 })) as typeof fetch);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_grant' });
  });
});
