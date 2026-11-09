import { oauthPageHtml } from '../../src/shared/oauth-page';
import { SLACK_LOCAL_CALLBACK } from '../../src/shared/slack-oauth';
import { connectorSplashIds, connectorSplashNames, type ConnectorSplash } from '../../src/shared/connector-splashes';

function brandedPage(heading: string, detail: string, status: number, plugin?: ConnectorSplash): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const script = `history.replaceState(null,'',location.pathname);document.body.dataset.status=${JSON.stringify(status >= 400 ? 'error' : 'pending')};`;
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` };
  const assets = { regular: '/connector-assets/figtree.woff2', medium: '/connector-assets/figtree.woff2', semibold: '/connector-assets/figtree.woff2', hero: plugin ? `/connector-assets/${plugin}-v1.webp` : '/connector-assets/hero.png', brand: plugin ? `TinyGPT + ${connectorSplashNames[plugin]}` : undefined };
  const html = oauthPageHtml(assets, nonce, script).replace('Finishing your connection', heading).replace('Checking your account…', detail);
  return new Response(html, { status, headers });
}

function connectionGallery(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const cards = connectorSplashIds.map(id => `<article class="plugin-card"><a href="/connect/${id}"><div class="hero"><img src="/connector-assets/${id}-v1.webp" alt=""></div><div class="content"><p class="brand">TinyGPT + ${connectorSplashNames[id]}</p><h2>Connect ${connectorSplashNames[id]}</h2><span class="view-link">View connection <span aria-hidden="true">↗</span></span></div></a></article>`).join('');
  const base = oauthPageHtml({ regular: '/connector-assets/figtree.woff2', medium: '/connector-assets/figtree.woff2', semibold: '/connector-assets/figtree.woff2', hero: '' }, nonce, '');
  const html = base.replace(/<main>[\s\S]*?<\/main>/, `<main><header><h1>Your apps, connected</h1><p>A little more connected. A lot more possible.<br>Start a connection from the TinyGPT desktop app.</p></header><section class="plugin-grid" aria-label="TinyGPT connections">${cards}</section><p class="footnote"><a href="https://tinygpt.org">tinygpt.org</a></p></main>`).replace('</style>', `body{padding:40px 24px}main{width:min(100%,1480px);border:0;border-radius:0;background:transparent;box-shadow:none;overflow:visible}header{margin-bottom:28px}header h1{font-size:30px}.plugin-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.plugin-card{overflow:hidden;border:1px solid var(--border);border-radius:24px;background:var(--card)}.plugin-card a{display:block;color:inherit;text-decoration:none}.plugin-card a:focus-visible{outline:3px solid var(--text);outline-offset:-4px}.plugin-card h2{font-size:23px;line-height:1.3;letter-spacing:-.6px;margin:0 0 20px;font-weight:600}.plugin-card .brand{margin-bottom:14px}.view-link{display:inline-block;padding:11px 20px;border-radius:99px;background:var(--button);color:var(--on-button);font-size:14px}.plugin-card .hero{height:auto;aspect-ratio:3/1}.plugin-card .hero img{aspect-ratio:3/1}.content{padding:24px}@media(max-width:900px){.plugin-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:580px){.plugin-grid{grid-template-columns:1fr}body{padding:28px 16px}} </style>`);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'` } });
}

// The HTTPS hop is required for Slack distribution. No token exchange, cookie,
// durable storage, logging, arbitrary redirect, or account data belongs here.
// Only the desktop holding the PKCE verifier can redeem the one-time code.
export function connectorCallback(request: Request): Response {
  const url = new URL(request.url);
  const invalid = () => brandedPage('Let’s try that again', 'This connection link is invalid or incomplete. Start a new sign-in from the TinyGPT app.', 400, 'slack');
  const plugin = connectorSplashIds.find(id => url.pathname === `/connect/${id}`);
  if (request.method === 'GET' && url.pathname === '/') return connectionGallery();
  if (request.method === 'GET' && plugin) return brandedPage(`Connect ${connectorSplashNames[plugin]}`, `Start this connection from the TinyGPT app. You’ll choose your account and review access before connecting.`, 200, plugin);
  if (url.pathname !== '/oauth/slack/callback') return brandedPage('Check TinyGPT', 'This connection link has expired. Start a new sign-in from the app.', 404);
  if (request.method !== 'GET' || request.url.length > 8192) return invalid();
  const state = url.searchParams.get('state'), code = url.searchParams.get('code'), error = url.searchParams.get('error');
  if (url.searchParams.getAll('state').length !== 1 || !state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return invalid();
  if (url.searchParams.getAll('code').length > 1 || url.searchParams.getAll('error').length > 1 || (code && error) || (!code && !error) || code && code.length > 4000 || error && error.length > 200) return invalid();
  const callback = new URL(SLACK_LOCAL_CALLBACK); callback.searchParams.set('state', state);
  if (error) callback.searchParams.set('error', 'access_denied'); else callback.searchParams.set('code', code!);
  // This is an intermediate OAuth hop, not a completed connection. Forward
  // automatically; the desktop exchanges the code, checks health, then renders
  // the branded completion page and attempts the token-free app deep link.
  return new Response(null, { status: 303, headers: { Location: callback.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
