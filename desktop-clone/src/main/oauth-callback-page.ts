import { oauthPageHtml } from '../shared/oauth-page';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import figtree from '@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2?inline';
import { connectorSplashAssets } from './connector-splash-assets';
import { connectorSplashNames, type ConnectorSplash } from '../shared/connector-splashes';
import connectionHero from '../renderer/assets/remote-pair-hero.png?inline';
import { tinygptAppLink } from '../shared/app-link';

const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class OAuthCallbackPage {
  private key = randomBytes(32).toString('base64url');
  private nonce = randomBytes(24).toString('base64url');
  private status: 'pending' | 'connected' | 'error' = 'pending';
  private message = 'Finish your connection in TinyGPT.';
  constructor(private returnToApp: () => void | Promise<void> = () => {}, private plugin?: ConnectorSplash) {}
  complete(connected: boolean, message = ''): void { this.status = connected ? 'connected' : 'error'; this.message = message || (connected ? 'Your account is ready to use in TinyGPT.' : 'Return to TinyGPT to review the connection and try again.'); }
  handle(request: IncomingMessage, response: ServerResponse, origin: string): boolean {
    const url = new URL(request.url ?? '/', origin);
    if (!['/oauth/status', '/oauth/return'].includes(url.pathname)) return false;
    const supplied = request.headers['x-tinygpt-return'];
    const valid = typeof supplied === 'string' && equal(supplied, this.key) && request.headers.host === new URL(origin).host && (!request.headers.origin || request.headers.origin === origin);
    const method = url.pathname === '/oauth/status' ? 'GET' : 'POST';
    if (!valid || request.method !== method || (method === 'POST' && request.headers.origin !== origin)) { response.writeHead(403, { 'Cache-Control': 'no-store' }).end(); return true; }
    if (method === 'GET') response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify({ status: this.status, message: this.message }));
    else void Promise.resolve().then(this.returnToApp).then(() => response.writeHead(204, { 'Cache-Control': 'no-store' }).end(), () => response.writeHead(503, { 'Cache-Control': 'no-store' }).end());
    return true;
  }
  render(response: ServerResponse): void {
    const script = `history.replaceState(null,'','/oauth/complete');const key=${JSON.stringify(this.key)};const title=document.querySelector('h1');const detail=document.querySelector('#detail');async function update(){try{const response=await fetch('/oauth/status',{headers:{'X-TinyGPT-Return':key},cache:'no-store'});if(!response.ok)throw Error();const state=await response.json();if(state.status==='connected'){document.body.dataset.status='connected';title.textContent='You’re connected';detail.textContent='You can close this tab.';requestAnimationFrame(()=>{try{const frame=document.createElement('iframe');frame.hidden=true;frame.tabIndex=-1;frame.setAttribute('aria-hidden','true');frame.src=${JSON.stringify(tinygptAppLink)};document.body.append(frame)}catch{}});return}detail.textContent=state.message;if(state.status==='error'){document.body.dataset.status='error';title.textContent='Connection needs attention';return}}catch{document.body.dataset.status='error';title.textContent='Check TinyGPT';detail.textContent='Check the connection in the app. You can close this tab.';return}setTimeout(update,600)}update();`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${this.nonce}'; style-src 'nonce-${this.nonce}'; img-src data:; font-src data:; connect-src 'self'; frame-src tinygpt:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` }).end(oauthPageHtml({ regular: figtree, medium: figtree, semibold: figtree, hero: this.plugin ? connectorSplashAssets[this.plugin] : connectionHero, brand: this.plugin ? `TinyGPT + ${connectorSplashNames[this.plugin]}` : undefined }, this.nonce, script));
  }
}
