import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

/** Animate only the changing setup content; the live avatar and layout stay put. */
export function useBotSetupTransition() {
  const root = useRef<HTMLElement>(null);
  const cleanups = useRef(new Set<() => void>());
  const clear = () => { for (const cleanup of [...cleanups.current]) cleanup(); };
  const reduced = () => document.documentElement.dataset.motion === 'reduce' ||
    (document.documentElement.dataset.motion !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { if (reduced()) clear(); };
    motion.addEventListener('change', sync);
    window.addEventListener('tinygpt-motion', sync);
    return () => { clear(); motion.removeEventListener('change', sync); window.removeEventListener('tinygpt-motion', sync); };
  }, []);

  function transition(update: () => void, direction: 'forward' | 'back') {
    clear();
    const section = root.current;
    const moveFocus = !!section && !!document.activeElement?.closest('.bot-designer-next');
    const commit = () => {
      flushSync(update);
      if (moveFocus) {
        const primary = section?.querySelector<HTMLButtonElement>('.bot-designer-next > button:last-child');
        const target = primary && !primary.disabled ? primary : section?.querySelector<HTMLElement>('.bot-introduction h1');
        if (target) { if (target !== primary) target.tabIndex = -1; target.focus({ preventScroll: true }); }
      }
    };
    if (!section || reduced()) { commit(); return; }
    const bounds = section.getBoundingClientRect();
    const regions = ['.bot-introduction', '.bot-design-controls', '.bot-designer-next'].map(selector => {
      const current = section.querySelector<HTMLElement>(selector);
      if (!current) return null;
      const rect = current.getBoundingClientRect();
      const snapshot = current.cloneNode(true) as HTMLElement;
      snapshot.inert = true;
      snapshot.setAttribute('aria-hidden', 'true');
      snapshot.removeAttribute('id');
      snapshot.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
      Object.assign(snapshot.style, { position: 'absolute', left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', pointerEvents: 'none', userSelect: 'none', zIndex: '2' });
      snapshot.classList.add('bot-step-snapshot');
      return { selector, snapshot };
    });

    commit();
    const sign = direction === 'forward' ? 1 : -1;
    regions.forEach((region, index) => {
      if (!region) return;
      const current = section.querySelector<HTMLElement>(region.selector);
      if (!current) return;
      section.append(region.snapshot);
      const shift = index === 1 ? `${sign * 10}px 0` : `0 ${sign * 5}px`;
      const exitShift = index === 1 ? `${sign * -7}px 0` : `0 ${sign * -3}px`;
      const outgoing = region.snapshot.animate([{ opacity: 1, translate: '0 0', filter: 'blur(0)' }, { opacity: 0, translate: exitShift, filter: 'blur(1.5px)' }], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'both' });
      const incoming = current.animate([{ opacity: 0, translate: shift, filter: 'blur(1.5px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }], { duration: 420, delay: index * 25, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' });
      const cleanup = () => { outgoing.cancel(); incoming.cancel(); region.snapshot.remove(); cleanups.current.delete(cleanup); };
      cleanups.current.add(cleanup);
      void outgoing.finished.then(() => region.snapshot.remove(), () => {});
      void incoming.finished.then(cleanup, cleanup);
    });
  }
  return { root, transition };
}
