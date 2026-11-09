import { connectorCallback } from './callback';
import { slackRefresh, type SlackRefreshEnv } from './slack-refresh';
import { googleExchange, type GoogleExchangeEnv } from './google-exchange';

interface Env extends SlackRefreshEnv, GoogleExchangeEnv { ASSETS: Fetcher }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/oauth/slack/token') return slackRefresh(request, env);
    if (url.pathname === '/oauth/google/token') return googleExchange(request, env);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'tinygpt-plugins' }, { headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname.startsWith('/connector-assets/') && ['GET', 'HEAD'].includes(request.method)) {
      const result = await env.ASSETS.fetch(request);
      const headers = new Headers(result.headers); headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(result.body, { status: result.status, headers });
    }
    return connectorCallback(request);
  }
};
