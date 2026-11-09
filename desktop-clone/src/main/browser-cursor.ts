/** Runs in Chromium's isolated world; never displays text typed into a page. */
export function browserCursor(x: number, y: number, pressed: boolean, svg: string) {
  const key = '__tinygptAgentCursor';
  const context = globalThis as typeof globalThis & { [key: string]: { host: HTMLElement; cursor: HTMLElement; timer?: ReturnType<typeof setTimeout> } | undefined };
  let state = context[key];
  if (!state?.host.isConnected) {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const cursor = document.createElement('div');
    // Align Solar's (4.39141, 4.39141) tip with the actual input coordinates.
    cursor.style.cssText = 'position:absolute;left:-5.125px;top:-5.125px;width:28px;height:28px;pointer-events:none;filter:drop-shadow(0 2px 3px #0005);transition:transform 180ms ease-out,opacity 180ms;';
    cursor.innerHTML = svg;
    shadow.append(cursor); document.documentElement.append(host);
    state = context[key] = { host, cursor };
  }
  clearTimeout(state.timer);
  state.cursor.style.opacity = '1';
  state.cursor.style.transform = `translate(${x}px,${y}px) scale(${pressed ? 0.85 : 1})`;
  state.timer = setTimeout(() => { if (state) state.cursor.style.opacity = '0'; }, 5000);
}
