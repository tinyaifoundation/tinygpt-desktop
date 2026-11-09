export interface SlackRefreshEnv {
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET?: string;
  TOKEN_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });

// Slack requires confidential-client authentication when refreshing grants
// issued to an HTTPS redirect, even when the initial exchange uses PKCE.
// Authenticate the token holder by possession of the refresh token; never
// persist tokens, accept arbitrary destinations, or ship the publisher secret.
export async function slackRefresh(request: Request, env: SlackRefreshEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'POST' || request.headers.has('Origin') || request.headers.get('X-TinyGPT-Connector') !== 'slack' || request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return json({ ok: false, error: 'invalid_request' }, 400);
  if (!env.SLACK_CLIENT_SECRET || !env.SLACK_CLIENT_ID) return json({ ok: false, error: 'publisher_unavailable' }, 503);
  if (!(await env.TOKEN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })).success) return json({ ok: false, error: 'rate_limited' }, 429);
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { if (reader) while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 16000) return json({ ok: false, error: 'invalid_request' }, 413); chunks.push(item.value); } } finally { await reader?.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const params = new URLSearchParams(new TextDecoder().decode(bytes));
  const token = params.get('refresh_token');
  if (params.get('grant_type') !== 'refresh_token' || params.get('client_id') !== env.SLACK_CLIENT_ID || !token || token.length > 12000 || [...params.keys()].some(key => !['grant_type', 'client_id', 'refresh_token'].includes(key)) || ['grant_type', 'client_id', 'refresh_token'].some(key => params.getAll(key).length !== 1)) return json({ ok: false, error: 'invalid_request' }, 400);
  try {
    // Workers supports manual redirects. Reject them explicitly so credentials
    // can never follow an upstream redirect to another destination.
    const response = await fetcher('https://slack.com/api/oauth.v2.access', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ client_id: env.SLACK_CLIENT_ID, client_secret: env.SLACK_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: token }) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return json({ ok: false, error: 'provider_unavailable' }, 502); }
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { if (reader) while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 32000) return json({ ok: false, error: 'provider_unavailable' }, 502); chunks.push(item.value); } } finally { await reader?.cancel().catch(() => {}); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let result: Record<string, unknown>;
    try { result = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>; } catch { return json({ ok: false, error: 'upstream_response_invalid' }, 502); }
    if (!response.ok || result.ok !== true) {
      const code = typeof result.error === 'string' && /^[a-z_]{1,80}$/.test(result.error) ? result.error : 'provider_unavailable';
      return json({ ok: false, error: code }, response.status === 429 ? 429 : 400);
    }
    if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 12000 || typeof result.refresh_token !== 'string' || !result.refresh_token || result.refresh_token.length > 12000 || typeof result.expires_in !== 'number' || result.expires_in <= 0 || result.expires_in > 31536000) return json({ ok: false, error: 'invalid_token_response' }, 502);
    return json({ ok: true, access_token: result.access_token, refresh_token: result.refresh_token, expires_in: result.expires_in, ...(typeof result.scope === 'string' && result.scope.length <= 3000 ? { scope: result.scope } : {}) });
  } catch { return json({ ok: false, error: 'refresh_transport_failure' }, 502); }
}
