/** OpenRouter's app identifier is the public product URL, including for desktop
 * clients. This is attribution metadata, not the OAuth callback or HTTP Origin. */
export const OPENROUTER_APP_URL = 'https://tinygpt.org';
export const OPENROUTER_APP_TITLE = 'TinyGPT';

export function openRouterAttributionFetch(request: typeof fetch): typeof fetch {
  return (resource, options) => {
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource.toString() : resource.url);
    if (url.origin !== 'https://openrouter.ai') return request(resource, options);
    const headers = new Headers(options?.headers ?? (resource instanceof Request ? resource.headers : undefined));
    headers.set('HTTP-Referer', OPENROUTER_APP_URL);
    headers.set('X-OpenRouter-Title', OPENROUTER_APP_TITLE);
    // Override legacy SDK attribution too, so a client cannot send two names.
    headers.set('X-Title', OPENROUTER_APP_TITLE);
    return request(resource, { ...options, headers, redirect: 'error' });
  };
}
