import { pageUrlSchema, type SearchEngine, type WebResult } from '../shared/tools';
export function searchAddress(engine: SearchEngine, query: string): string {
  const url = new URL({ google: 'https://www.google.com/search', bing: 'https://www.bing.com/search', brave: 'https://search.brave.com/search', duckduckgo: 'https://duckduckgo.com/' }[engine]);
  url.searchParams.set('q', query); if (engine === 'duckduckgo') url.searchParams.set('ia', 'web'); return url.href;
}
export function cleanSearchResults(engine: SearchEngine, rows: WebResult[]): WebResult[] {
  const unique = new Set<string>();
  return rows.map(row => {
    let url: URL; try { url = new URL(row.url); } catch { return null; }
    if (engine === 'google' && url.hostname.endsWith('google.com') && url.pathname === '/url') { try { url = new URL(url.searchParams.get('q') ?? url.searchParams.get('url') ?? ''); } catch { return null; } }
    if (engine === 'duckduckgo' && url.searchParams.has('uddg')) { try { url = new URL(url.searchParams.get('uddg')!); } catch { return null; } }
    if (engine === 'bing' && url.hostname.endsWith('bing.com') && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u'); if (encoded?.startsWith('a1')) try { url = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8')); } catch { return null; }
    }
    if (!pageUrlSchema.safeParse(url.href).success || !row.title.trim() || unique.has(url.href) || /(^|\.)(google\.com|bing\.com|search\.brave\.com|duckduckgo\.com)$/.test(url.hostname)) return null;
    unique.add(url.href); return { title: row.title.trim().slice(0, 300), url: url.href, snippet: row.snippet.trim().slice(0, 1000) };
  }).filter((row): row is WebResult => !!row).slice(0, 8);
}

// These functions run only in an isolated Chromium world. Page content is data;
// no page-provided script or model-provided selector is evaluated.
export function pageDocument() {
  const visible = (node: Element) => { const style = getComputedStyle(node); return node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
  const dialog = Array.from(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')).filter(visible).at(-1) as HTMLElement | undefined;
  const main = document.querySelector('article, main, [role="main"]') as HTMLElement | null;
  const root = dialog ?? main ?? document.body;
  const full = (root?.innerText || '').replace(/\n{3,}/g, '\n\n');
  const text = full.slice(0, 24000);
  const label = dialog?.getAttribute('aria-label') || (dialog?.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim() || dialog?.querySelector('h1,h2,h3')?.textContent || 'Open dialog';
  const title = document.title || location.hostname;
  const challenge = !!document.querySelector('iframe[src*="captcha"], #challenge-running, #cf-challenge-running, .g-recaptcha, [data-testid="challenge"]')
    || /verify you are human|unusual traffic|complete the security check|just a moment|before you continue to|sign in to continue|access denied/i.test(`${title}\n${text.slice(0, 5000)}`)
    || (Array.from(root?.querySelectorAll('input[type="password"]') ?? []).some(visible) && text.length < 2500);
  return { url: location.href, title: title.slice(0, 200), text, elements: [], challenge, textCoverage: { scope: dialog ? 'dialog' as const : main ? 'main' as const : 'page' as const, totalCharacters: full.length, returnedCharacters: text.length, truncated: full.length > text.length }, ...(dialog ? { activeDialog: { title: label.slice(0, 200) } } : {}) };
}
export function resultDocument(engine: SearchEngine) {
  const selectors: Record<SearchEngine, string> = {
    google: '#search a:has(h3), #rso a:has(h3)', bing: '#b_results .b_algo h2 a',
    brave: '.snippet a.heading-serpresult, .snippet a:has(.title), a[data-testid="result-title-a"]',
    duckduckgo: 'a[data-testid="result-title-a"], .result__a, article h2 a',
  };
  let links = Array.from(document.querySelectorAll(selectors[engine])) as HTMLAnchorElement[];
  if (!links.length) links = Array.from(document.querySelectorAll('main a:has(h2),main a:has(h3),[role="main"] a:has(h2),[role="main"] a:has(h3)')) as HTMLAnchorElement[];
  return links.slice(0, 30).map(link => ({ title: link.innerText || link.textContent || '', url: link.href, snippet: (link.closest('article,.b_algo,.snippet,.g,.result') as HTMLElement | null)?.innerText?.slice(0, 1000) ?? '' }));
}
