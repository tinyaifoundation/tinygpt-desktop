import { connectorRegistrations } from '../../src/main/connector-registrations';

export interface GoogleExchangeEnv {
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_LIMITER: { limit(input: { key: string }): Promise<{ success: boolean }> };
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  const reader = body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { if (reader) while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > limit) throw Error('body_limit'); chunks.push(item.value); } } finally { await reader?.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return new TextDecoder().decode(bytes);
}

// Legacy Desktop registrations require their generated client credential even
// with PKCE. Keep it server-side. Forward once to Google's fixed endpoint only;
// never log or persist codes, verifiers, credentials, or account tokens.
export async function googleExchange(request: Request, env: GoogleExchangeEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== 'POST' || request.headers.has('Origin') || request.headers.get('X-TinyGPT-Connector') !== 'google' || request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return json({ error: 'invalid_request' }, 400);
  if (!env.GOOGLE_CLIENT_SECRET) return json({ error: 'publisher_unavailable' }, 503);
  if (!(await env.TOKEN_LIMITER.limit({ key: `google:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}` })).success) return json({ error: 'rate_limited' }, 429);
  let params: URLSearchParams;
  try { params = new URLSearchParams(await readBounded(request.body, 16000)); } catch { return json({ error: 'invalid_request' }, 413); }
  const code = params.get('grant_type') === 'authorization_code';
  const keys = code ? ['grant_type', 'client_id', 'code', 'code_verifier', 'redirect_uri'] : ['grant_type', 'client_id', 'refresh_token'];
  if (params.get('client_id') !== connectorRegistrations.google.clientId || (!code && params.get('grant_type') !== 'refresh_token') || [...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length !== 1 || !params.get(key))) return json({ error: 'invalid_request' }, 400);
  if (code) {
    const redirect = params.get('redirect_uri')!;
    if (params.get('code')!.length > 4000 || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.get('code_verifier')!) || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/oauth\/callback$/.test(redirect)) return json({ error: 'invalid_request' }, 400);
    const port = Number(redirect.match(/:(\d+)\//)?.[1]); if (port < 1 || port > 65535) return json({ error: 'invalid_request' }, 400);
  } else if (params.get('refresh_token')!.length > 12000) return json({ error: 'invalid_request' }, 400);
  params.set('client_secret', env.GOOGLE_CLIENT_SECRET);
  try {
    const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: params });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return json({ error: 'provider_unavailable' }, 502); }
    const value = JSON.parse(await readBounded(response.body, 32000)) as Record<string, unknown>;
    if (!response.ok || value.error) return json({ error: typeof value.error === 'string' && /^[a-z_]{1,80}$/.test(value.error) ? value.error : 'provider_unavailable' }, response.status === 429 ? 429 : 400);
    if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 12000 || typeof value.expires_in !== 'number' || value.expires_in <= 0 || value.expires_in > 31536000 || value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 12000)) return json({ error: 'invalid_token_response' }, 502);
    return json({ access_token: value.access_token, expires_in: value.expires_in, ...(value.refresh_token ? { refresh_token: value.refresh_token } : {}), ...(typeof value.scope === 'string' && value.scope.length <= 3000 ? { scope: value.scope } : {}) });
  } catch { return json({ error: 'provider_unavailable' }, 502); }
}
