import { describe, expect, it, vi } from 'vitest';
import { slackRefresh } from '../plugin-auth/src/slack-refresh';
const env = () => ({ SLACK_CLIENT_ID: '123.456', SLACK_CLIENT_SECRET: 'publisher-secret', TOKEN_LIMITER: { limit: vi.fn(async () => ({ success: true })) } });
function request(values: Record<string,string> = {}) { return new Request('https://plugin.tinygpt.org/oauth/slack/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-TinyGPT-Connector': 'slack' }, body: new URLSearchParams({ client_id: '123.456', grant_type: 'refresh_token', refresh_token: 'private-refresh', ...values }) }); }
describe('Slack publisher refresh exchange', () => {
  it('keeps the publisher secret server-side and returns only a bounded rotated token pair', async () => {
    const upstream = vi.fn(async (url, options) => {
      expect(url).toBe('https://slack.com/api/oauth.v2.access'); expect(options.redirect).toBe('manual');
      const form = options.body as URLSearchParams; expect(form.get('client_secret')).toBe('publisher-secret'); expect(form.get('refresh_token')).toBe('private-refresh');
      return Response.json({ ok: true, access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 43200, scope: 'search:read', internal: 'do-not-forward' });
    }) as typeof fetch;
    const response = await slackRefresh(request(), env(), upstream); const text = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('access-control-allow-origin')).toBe(false); expect(text).toContain('rotated-refresh'); expect(text).not.toContain('publisher-secret'); expect(text).not.toContain('do-not-forward');
  });
  it('rejects browser-origin, wrong-client and injected-destination requests without calling Slack', async () => {
    const upstream = vi.fn(); const browser = request(); browser.headers.set('Origin','https://attacker.invalid');
    for (const value of [browser, request({ client_id:'other' }), request({ token_endpoint:'https://attacker.invalid' }), request({ grant_type:'authorization_code' })]) expect((await slackRefresh(value, env(), upstream)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('fails closed without a publisher secret or when rate-limited', async () => {
    const upstream = vi.fn(); const missing = { ...env(), SLACK_CLIENT_SECRET: undefined };
    expect((await slackRefresh(request(), missing, upstream)).status).toBe(503);
    const limited = env(); limited.TOKEN_LIMITER.limit.mockResolvedValue({ success:false });
    expect((await slackRefresh(request(), limited, upstream)).status).toBe(429); expect(upstream).not.toHaveBeenCalled();
  });
  it('never follows a provider redirect', async () => {
    const upstream = vi.fn(async () => new Response(null, { status:302, headers:{Location:'https://attacker.invalid'} })) as typeof fetch;
    expect((await slackRefresh(request(),env(),upstream)).status).toBe(502); expect(upstream).toHaveBeenCalledOnce();
  });
  it('preserves reconnect errors and never forwards provider error details or malformed success tokens', async () => {
    const refused = await slackRefresh(request(), env(), vi.fn(async () => Response.json({ ok:false,error:'invalid_refresh_token',secret:'never-return' })) as typeof fetch);
    expect(await refused.json()).toEqual({ ok:false,error:'invalid_refresh_token' });
    const malformed = await slackRefresh(request(), env(), vi.fn(async () => Response.json({ ok:true,access_token:'a' })) as typeof fetch); expect(malformed.status).toBe(502);
    const huge = await slackRefresh(request(), env(), vi.fn(async () => new Response('x'.repeat(32001))) as typeof fetch); expect(huge.status).toBe(502);
  });
});
