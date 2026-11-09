// Runs in Chromium's isolated world; it reads only the document scroll geometry.
export function browserPageScroll(position?: number) {
  const element = document.scrollingElement ?? document.documentElement;
  const viewport = Math.max(1, element.clientHeight);
  const height = Math.max(viewport, element.scrollHeight);
  if (position !== undefined) window.scrollTo({ left: 0, top: position * (height - viewport), behavior: 'instant' });
  return { height: Math.min(100000000, height), viewport, top: Math.max(0, element.scrollTop) };
}
export const browserPageChrome = `
  html { scrollbar-width: none !important; overflow-x: hidden !important; }
  html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  body { min-width: 0 !important; max-width: 100% !important; }
`;
