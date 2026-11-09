import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { boundedJson } from '../core/inference-discovery';
import { OAuthCallbackPage } from './oauth-callback-page';

export class OpenRouterSignIn {
  private server?: Server;
  private controller?: AbortController;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private page?: OAuthCallbackPage;
  private pending = false;
  constructor(private open: (url: string) => Promise<void>, private returnToApp: () => void, private request: typeof fetch = fetch) {}
  cancel(): void { this.controller?.abort(new Error('OpenRouter sign-in was canceled.')); }
  assertNotCanceled(): void { this.controller?.signal.throwIfAborted(); }
  close(): void { this.cancel(); clearTimeout(this.cleanupTimer); this.server?.closeAllConnections(); this.server?.close(); this.server = undefined; }
  complete(success: boolean): void { this.page?.complete(success); this.returnToApp(); }
  async connect(): Promise<string> {
    if (this.pending) throw new Error('Finish the current OpenRouter sign-in first.');
    this.close(); this.pending = true;
    const controller = new AbortController(); this.controller = controller;
    const verifier = randomBytes(48).toString('base64url'), state = randomBytes(32).toString('base64url');
    const path = `/callback/${randomBytes(16).toString('hex')}`;
    const page = new OAuthCallbackPage(this.returnToApp); this.page = page;
    let callbackOrigin = '', accepted = false;
    let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // Avoid an unhandled rejection when browser launch fails before awaiting.
    void code.catch(() => {});
    const abort = () => rejectCode(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('OpenRouter sign-in timed out. Please try again.')), 180000);
    const server = createServer((request, response) => {
      if (request.headers.host !== new URL(callbackOrigin).host) { response.writeHead(403).end(); return; }
      if (page.handle(request, response, callbackOrigin)) return;
      const url = new URL(request.url ?? '/', callbackOrigin);
      if (request.method !== 'GET' || url.pathname !== path || accepted) { response.writeHead(404).end(); return; }
      const supplied = url.searchParams.get('state') ?? '';
      // OpenRouter omits state on denial. The unguessable callback path is
      // sufficient to terminate this flow; it never authorizes an exchange.
      if (url.searchParams.has('error') && !supplied) { accepted = true; page.render(response); page.complete(false); rejectCode(new Error('OpenRouter sign-in was declined. Try again when you’re ready.')); return; }
      if (Buffer.byteLength(supplied) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))) { response.writeHead(403).end(); return; }
      accepted = true; page.render(response);
      const value = url.searchParams.get('code');
      if (url.searchParams.has('error') || !value || value.length > 8192) { page.complete(false); rejectCode(new Error('OpenRouter sign-in was declined. Try again when you’re ready.')); }
      else resolveCode(value);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Could not start sign-in.');
      callbackOrigin = `http://localhost:${address.port}`;
      const auth = new URL('https://openrouter.ai/auth');
      auth.search = new URLSearchParams({ callback_url: callbackOrigin + path, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', key_label: 'TinyGPT', state }).toString();
      await this.open(auth.toString());
      const authorizationCode = await code; controller.signal.throwIfAborted();
      const data = await boundedJson('https://openrouter.ai/api/v1/auth/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]), body: JSON.stringify({ code: authorizationCode, code_verifier: verifier, code_challenge_method: 'S256' }) }, this.request).catch(() => { throw new Error('OpenRouter could not finish sign-in. Please try again.'); });
      if (typeof data.key !== 'string' || !data.key.trim() || data.key.length > 8192) throw new Error('OpenRouter did not return a valid connection.');
      controller.signal.throwIfAborted();
      return data.key;
    } catch (error) { page.complete(false); if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    finally { this.pending = false; clearTimeout(timer); controller.signal.removeEventListener('abort', abort); this.cleanupTimer = setTimeout(() => { server.closeAllConnections(); server.close(); }, 60000); this.cleanupTimer.unref(); }
  }
}
