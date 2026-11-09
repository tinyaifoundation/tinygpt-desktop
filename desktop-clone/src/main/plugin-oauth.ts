import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PluginStore } from './plugin-store';
import type { PluginCredentials } from '../shared/plugins';
import { connectorMatches, connectorIdentity } from '../shared/connector-catalog';
import { OAuthCallbackPage } from './oauth-callback-page';

interface OAuthVault extends PluginCredentials { oauth?: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; port?: number } }
export class PluginOAuth implements OAuthClientProvider {
  private server?: Server;
  private authorizationState = randomBytes(32).toString('hex');
  private callback!: string;
  private resolve!: (code: string) => void;
  private reject!: (error: Error) => void;
  private code?: Promise<string>;
  private timer?: ReturnType<typeof setTimeout>;
  private page: OAuthCallbackPage;
  private handled = false;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(private store: PluginStore, private id: string, private open: (url: string) => Promise<void>, returnToApp: () => void | Promise<void> = () => {}) { this.page = new OAuthCallbackPage(returnToApp, connectorIdentity(store.entry(id).manifest)); }
  private vault(): OAuthVault { return this.store.credentials<OAuthVault>(this.id) ?? {}; }
  private async update(value: OAuthVault['oauth']): Promise<void> { if (this.closed) throw new Error('Plugin access was revoked.'); const saved = this.store.credentials<OAuthVault>(this.id); const vault = saved ?? {}; await this.store.saveCredentials(this.id, { ...vault, oauth: { ...vault.oauth, ...value } }, saved); }
  async initialize(): Promise<void> {
    const oldPort = this.vault().oauth?.port;
    this.server = createServer((request, response) => {
      const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" };
      if (!this.callback || (request.url?.length ?? 0) > 8192) { response.writeHead(400, headers).end('Invalid request.'); return; }
      if (this.page.handle(request, response, new URL(this.callback).origin)) return;
      const url = new URL(request.url ?? '/', this.callback);
      const state = url.searchParams.get('state') ?? '';
      if (url.pathname !== '/oauth/callback' || request.method !== 'GET' || this.handled || request.headers.host !== new URL(this.callback).host || Buffer.byteLength(state) !== Buffer.byteLength(this.authorizationState) || !timingSafeEqual(Buffer.from(state), Buffer.from(this.authorizationState))) { response.writeHead(400, headers).end('Invalid authorization callback.'); return; }
      if (url.searchParams.has('error')) { this.handled = true; this.complete(false, 'Authorization was cancelled or refused. Return to TinyGPT to try again.'); this.page.render(response); this.reject?.(new Error('Authorization was cancelled or refused.')); return; }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096 || !this.code) { response.writeHead(400, headers).end('Authorization was not completed. Return to TinyGPT.'); return; }
      this.handled = true; this.page.render(response); this.resolve?.(code);
    });
    const listen = (port: number) => new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1', () => { this.server!.removeListener('error', reject); resolve(); }); });
    try { await listen(oldPort ?? 0); } catch { await listen(0); }
    const address = this.server.address(); const port = typeof address === 'object' ? address!.port : 0;
    this.callback = `http://127.0.0.1:${port}/oauth/callback`;
    if (oldPort && port !== oldPort) await this.update({ client: undefined, tokens: undefined, port }); else await this.update({ port });
  }
  get redirectUrl(): string { return this.callback; }
  get clientMetadata() { return { client_name: 'TinyGPT Desktop', redirect_uris: [this.callback], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(connectorMatches(this.store.entry(this.id).manifest, 'linear') ? { scope: 'read' } : {}) }; }
  state(): string { return this.authorizationState; }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.vault().oauth?.client; }
  saveClientInformation(client: OAuthClientInformationMixed): Promise<void> { return this.update({ client }); }
  tokens(): OAuthTokens | undefined { return this.vault().oauth?.tokens; }
  saveTokens(tokens: OAuthTokens): Promise<void> { if (connectorMatches(this.store.entry(this.id).manifest, 'linear') && tokens.scope?.split(/\s+/).some(scope => !['read', 'openid', 'email', 'offline_access'].includes(scope))) throw new Error('Linear returned permissions beyond read-only access.'); return this.update({ tokens }); }
  async redirectToAuthorization(url: URL): Promise<void> {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopback) || url.username || url.password || url.searchParams.get('state') !== this.authorizationState) throw new Error('Invalid authorization address.');
    // The SDK otherwise requests every scope advertised by resource metadata.
    // This catalog entry deliberately grants only read access, even if the
    // provider advertises write scopes for its other endpoint.
    if (connectorMatches(this.store.entry(this.id).manifest, 'linear')) url.searchParams.set('scope', 'read');
    if (!this.code) { this.code = new Promise<string>((resolve, reject) => { this.resolve = resolve; this.reject = reject; this.timer = setTimeout(() => reject(new Error('Authorization timed out. Try connecting again.')), 180000); }); void this.code.catch(() => {}); }
    await this.open(url.href);
  }
  saveCodeVerifier(verifier: string): Promise<void> { return this.update({ verifier }); }
  codeVerifier(): string { const value = this.vault().oauth?.verifier; if (!value) throw new Error('Authorization session expired.'); return value; }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> { if (this.closed) throw new Error('Plugin access was revoked.'); if (scope === 'all') { const saved = this.store.credentials<OAuthVault>(this.id); if (!saved) return; const vault = structuredClone(saved); delete vault.oauth; await this.store.saveCredentials(this.id, vault, saved); } else if (scope !== 'discovery') await this.update({ [scope]: undefined }); }
  async wait(signal: AbortSignal): Promise<string> {
    if (!this.code) throw new Error('This server does not support automatic OAuth registration.');
    const abort = () => this.reject(new Error('Authorization was cancelled.')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    try { return await this.code; } finally { signal.removeEventListener('abort', abort); clearTimeout(this.timer); }
  }
  complete(connected: boolean, message = ''): void {
    this.page.complete(connected, message); clearTimeout(this.finishTimer); this.server?.unref();
    this.finishTimer = setTimeout(() => this.closeListener(), 120000); this.finishTimer.unref();
  }
  private closeListener(): void { clearTimeout(this.timer); clearTimeout(this.finishTimer); this.server?.close(); this.server?.closeAllConnections(); }
  close(): void { this.closed = true; this.reject?.(new Error('Authorization was cancelled.')); this.closeListener(); }
}
