import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PluginCredentials, ConnectorKind } from '../shared/plugins';
import type { PluginStore } from './plugin-store';
import { OAuthCallbackPage } from './oauth-callback-page';
import { SLACK_REDIRECT_URI } from '../shared/slack-oauth';
import { connectorRegistrations } from './connector-registrations';

const tokenSchema = z.object({ access_token: z.string().min(1).max(12000), refresh_token: z.string().max(12000).optional(), expires_in: z.number().positive().max(31536000).optional(), scope: z.string().max(3000).optional() });
export const googleDesktopClientSchema = z.object({ installed: z.object({ client_id: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/), client_secret: z.string().min(1).max(1000) }) });
export { SLACK_REDIRECT_URI } from '../shared/slack-oauth';
const endpoints = { googleAuth: 'https://accounts.google.com/o/oauth2/v2/auth', googleToken: 'https://oauth2.googleapis.com/token', githubDevice: 'https://github.com/login/device/code', githubToken: 'https://github.com/login/oauth/access_token', slackAuth: 'https://slack.com/oauth/v2/authorize', slackToken: 'https://slack.com/api/oauth.v2.access', slackRefresh: 'https://plugin.tinygpt.org/oauth/slack/token' };
type Endpoints = typeof endpoints;
const googleExchange = 'https://plugin.tinygpt.org/oauth/google/token';
export class ConnectorOAuth {
  private refreshing: Promise<string> | undefined;
  private callbackServer?: Server;
  private callbackPage?: OAuthCallbackPage;
  private callbackTimer?: ReturnType<typeof setTimeout>;
  constructor(private store: PluginStore, private id: string, private open: (url: string) => Promise<void>, private progress: (message: string, code?: string) => void, private request: typeof fetch = fetch, private urls: Endpoints = endpoints, private returnToApp: () => void | Promise<void> = () => {}) {}
  complete(connected: boolean, message = ''): void { this.callbackPage?.complete(connected, message); }
  close(): void { clearTimeout(this.callbackTimer); this.callbackServer?.close(); this.callbackServer?.closeAllConnections(); this.callbackServer = undefined; }
  private googleTokenUrl(oauth: NonNullable<PluginCredentials['connectorAuth']>): string { return !oauth.clientSecret && oauth.clientId === connectorRegistrations.google.clientId && this.urls.googleToken === endpoints.googleToken ? googleExchange : this.urls.googleToken; }
  private async post(url: string, values: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(url, { method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(url === this.urls.slackRefresh ? { 'X-TinyGPT-Connector': 'slack' } : url === googleExchange ? { 'X-TinyGPT-Connector': 'google' } : {}) }, body: new URLSearchParams(values) });
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { if (reader) while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 32000) throw new Error('Authorization response was too large.'); chunks.push(next.value); } } finally { await reader?.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (value.error === 'invalid_grant' || value.error === 'bad_refresh_token' || value.error === 'invalid_refresh_token' || value.error === 'token_revoked') throw new Error('Sign in again to reconnect this account.');
    if ((!response.ok || value.ok === false) && !['authorization_pending', 'slow_down'].includes(String(value.error))) throw new Error('Authorization failed. Check the app registration and try again.'); return value;
  }
  async authorize(kind: ConnectorKind, signal: AbortSignal, send = false): Promise<void> {
    const saved = this.store.credentials(this.id); const oauth = saved?.connectorAuth; if (!oauth) throw new Error('Set up the connector app before signing in.');
    if (oauth.provider !== (kind === 'github' ? 'github' : kind === 'slack' ? 'slack' : 'google')) throw new Error('This connector does not match the request.');
    let requestedScope = 'repo read:user'; let tokens: Record<string, unknown>;
    if (oauth.provider === 'github') {
      const device = z.object({ device_code: z.string().min(1).max(1000), user_code: z.string().min(1).max(40), verification_uri: z.literal('https://github.com/login/device'), interval: z.number().positive().max(60), expires_in: z.number().positive().max(1800) }).parse(await this.post(this.urls.githubDevice, { client_id: oauth.clientId, scope: 'repo read:user' }, signal));
      this.progress('Enter this code in GitHub, then authorize TinyGPT.', device.user_code); await this.open(device.verification_uri); const deadline = Date.now() + device.expires_in * 1000; let interval = device.interval;
      while (true) {
        await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Authorization cancelled.')); }; const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, interval * 1000); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
        if (Date.now() > deadline) throw new Error('Authorization timed out. Try signing in again.');
        tokens = await this.post(this.urls.githubToken, { client_id: oauth.clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal);
        if (tokens.error === 'authorization_pending') continue; if (tokens.error === 'slow_down') { interval = Math.min(interval + 5, 60); continue; } if (tokens.error) throw new Error('Authorization was declined or expired. Try signing in again.'); break;
      }
    } else {
      const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url'); let accept!: (code: string) => void; let fail!: (error: Error) => void; const codePromise = new Promise<string>((resolve, reject) => { accept = resolve; fail = reject; }); void codePromise.catch(() => {});
      const slack = oauth.provider === 'slack';
      let handled = false; const page = this.callbackPage = new OAuthCallbackPage(this.returnToApp, kind === 'google' ? 'gdrive' : kind);
      const server = this.callbackServer = createServer((request, response) => {
        const address = server.address(); const origin = `http://${slack ? 'localhost' : '127.0.0.1'}:${typeof address === 'object' && address ? address.port : 0}`;
        if ((request.url?.length ?? 0) <= 8192 && page.handle(request, response, origin)) return;
        const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' };
        if (request.method !== 'GET' || (request.url?.length ?? 0) > 8192) { response.writeHead(400, headers).end('Invalid request.'); return; }
        const url = new URL(request.url ?? '/', 'http://127.0.0.1'); const actual = url.searchParams.get('state') ?? '';
        if (url.pathname !== '/oauth/callback' || request.headers.host !== new URL(origin).host || handled || Buffer.byteLength(actual) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(actual), Buffer.from(state))) { response.writeHead(400, headers).end('This request does not belong to TinyGPT.'); return; }
        if (url.searchParams.has('error')) { handled = true; page.complete(false, 'Sign-in was cancelled. Return to TinyGPT when you’re ready to try again.'); page.render(response); fail(new Error('Authorization was declined or expired. Try signing in again.')); return; }
        const code = url.searchParams.get('code'); if (!code || code.length > 4000) { response.writeHead(400, headers).end('Missing authorization code.'); return; } handled = true; page.render(response); accept(code);
      });
      const timeout = setTimeout(() => fail(new Error('Authorization timed out. Try signing in again.')), 180000); const abort = () => fail(new Error('Authorization cancelled.')); signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(slack ? 43829 : 0, '127.0.0.1', resolve); }); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Authorization callback unavailable.'); const redirect = slack ? SLACK_REDIRECT_URI : `http://127.0.0.1:${address.port}/oauth/callback`;
        const scope = ['https://www.googleapis.com/auth/userinfo.email', ...(kind === 'gmail' ? ['https://www.googleapis.com/auth/gmail.readonly', ...(send ? ['https://www.googleapis.com/auth/gmail.send'] : [])] : kind === 'gdrive' ? ['https://www.googleapis.com/auth/drive.readonly'] : kind === 'gcalendar' ? ['https://www.googleapis.com/auth/calendar.readonly'] : ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/gmail.readonly', ...(send ? ['https://www.googleapis.com/auth/gmail.send'] : [])])].join(' ');
        requestedScope = slack ? 'search:read,channels:read,channels:history,groups:read,groups:history,chat:write' : scope;
        const url = new URL(slack ? this.urls.slackAuth : this.urls.googleAuth);
        url.search = new URLSearchParams({ client_id: oauth.clientId, redirect_uri: redirect, response_type: 'code', ...(slack ? { user_scope: requestedScope } : { scope, access_type: 'offline', prompt: 'consent' }), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString(); this.progress('Finish signing in and choosing access in your browser.'); await this.open(url.toString());
        const result = await this.post(slack ? this.urls.slackToken : this.googleTokenUrl(oauth), { client_id: oauth.clientId, ...(!slack && oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}), code: await codePromise, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }, signal);
        // Desktop Slack grants are user tokens, never bot tokens. The initial
        // exchange nests this grant; refresh returns it at the top level.
        tokens = slack ? z.object({ ok: z.literal(true), authed_user: tokenSchema }).parse(result).authed_user : result;
      } finally {
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        if (signal.aborted || !handled) this.close();
        else { server.unref(); this.callbackTimer = setTimeout(() => this.close(), 120000); this.callbackTimer.unref(); }
      }
    }
    const result = tokenSchema.parse(tokens!); signal.throwIfAborted(); await this.store.saveCredentials(this.id, { connectorAuth: { ...oauth, accessToken: result.access_token, refreshToken: result.refresh_token, scope: result.scope ?? requestedScope, expiresAt: result.expires_in ? Date.now() + result.expires_in * 1000 : undefined } }, saved);
  }
  async token(signal: AbortSignal): Promise<string | undefined> {
    const credentials = this.store.credentials(this.id); if (!credentials?.connectorAuth) return credentials?.bearer;
    const oauth = credentials.connectorAuth; if (oauth.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now() + 60000)) return oauth.accessToken;
    if (!oauth.refreshToken) throw new Error('Sign in again to reconnect this account.');
    if (!this.refreshing) { this.refreshing = this.refresh(credentials, signal).finally(() => { this.refreshing = undefined; }); } return this.refreshing;
  }
  private async refresh(credentials: PluginCredentials, signal: AbortSignal): Promise<string> {
    const oauth = credentials.connectorAuth!;
    // GitHub's device-flow tokens refresh without a client secret. Its refresh
    // token rotates with each exchange, so save the returned pair atomically.
    const result = await this.post(oauth.provider === 'github' ? this.urls.githubToken : oauth.provider === 'slack' ? this.urls.slackRefresh : this.googleTokenUrl(oauth), { client_id: oauth.clientId, ...(oauth.provider === 'google' && oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}), refresh_token: oauth.refreshToken!, grant_type: 'refresh_token' }, signal);
    if (result.error === 'bad_refresh_token' || result.error === 'invalid_grant') throw new Error('Sign in again to reconnect this account.');
    const tokens = tokenSchema.parse(result); signal.throwIfAborted(); await this.store.saveCredentials(this.id, { connectorAuth: { ...oauth, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? oauth.refreshToken, scope: tokens.scope ?? oauth.scope, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 } }, credentials); return tokens.access_token;
  }
}
