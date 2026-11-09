const imageReference = /^tinygpt-image:([a-f0-9-]{36})$/i;
export function savedAnswerImage(url: string): string | null { return imageReference.exec(url)?.[1] ?? null; }
export function answerUrlTransform(url: string, key: string): string {
  if (key === 'src' && savedAnswerImage(url)) return url;
  if (key === 'href' && /^tinygpt-source:[a-f0-9-]{36}$/i.test(url)) return url;
  if (key === 'src' && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+=*$/i.test(url) && url.length <= 20_971_520) return url;
  try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return url; } catch { /* References never grant arbitrary file access. */ }
  return '';
}
