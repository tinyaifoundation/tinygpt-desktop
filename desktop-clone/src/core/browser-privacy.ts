import type { BrowserPreferences } from '../shared/config';

// The v2 default list blocks subresources, never the page the user opened.
const blockedHosts = new Set([
  '2mdn.net', 'ad.doubleclick.net', 'adservice.google.com', 'ads.google.com', 'ads.yahoo.com',
  'amazon-adsystem.com', 'analytics.google.com', 'bat.bing.com', 'connect.facebook.net',
  'doubleclick.net', 'google-analytics.com', 'googlesyndication.com', 'googletagmanager.com',
  'googletagservices.com', 'pixel.facebook.com', 'scorecardresearch.com', 'taboola.com', 'outbrain.com',
]);
export function blockedBrowserRequest(url: string, resourceType: string, enabled: boolean): boolean {
  if (!enabled || resourceType === 'mainFrame') return false;
  try {
    let host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    while (host) { if (blockedHosts.has(host)) return true; const dot = host.indexOf('.'); if (dot < 0) break; host = host.slice(dot + 1); }
  } catch { /* Non-web requests do not belong to the domain blocklist. */ }
  return false;
}
export function browserUserAgent(chrome: string, platform: string): string {
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}
export function browserHeaders(headers: Record<string, string>, agent: string, locale: string): Record<string, string> {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'user-agent') delete next[key];
    else if (/^sec-ch-ua/i.test(key)) next[key] = next[key].replace(/,?\s*"Electron";v="[^"]*"/g, '').replace(/\s*Electron\/[\d.]+/g, '').trim();
  }
  next['User-Agent'] = agent;
  if (!Object.keys(next).some(key => key.toLowerCase() === 'accept-language')) next['Accept-Language'] = locale.includes('-') ? `${locale},${locale.split('-')[0]};q=0.9` : locale;
  return next;
}
export function browserLinkDestination(url: string, settings: BrowserPreferences): 'workspace' | 'system' {
  const host = new URL(url).hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) ? settings.localLinkDestination : settings.webLinkDestination;
}
export function browserAddressLabel(url: string, showFull: boolean): string {
  if (!url || showFull) return url;
  try { return new URL(url).host; } catch { return url; }
}
