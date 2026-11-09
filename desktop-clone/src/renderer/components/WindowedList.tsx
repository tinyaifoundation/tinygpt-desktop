import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Fixed-height sidebar rows; offscreen menus/tooltips never mount. */
export function WindowedList<T extends { id: string }>({ items, render, pinned = [] }: { items: T[]; render: (item: T) => ReactNode; pinned?: (string | null | undefined)[] }) {
  const root = useRef<HTMLDivElement>(null), latest = useRef(items); latest.current = items;
  const [range, setRange] = useState({ first: 0, last: Math.min(items.length, 30) });
  useLayoutEffect(() => {
    const node = root.current, viewport = node?.closest<HTMLElement>('.sidebar-library-scroll'); if (!node || !viewport) return;
    let frame = 0;
    const sync = () => { frame = 0; const top = viewport.getBoundingClientRect().top - node.getBoundingClientRect().top, first = Math.min(latest.current.length, Math.max(0, Math.floor((top - 200) / 34))), last = Math.min(latest.current.length, Math.max(first, Math.ceil((top + viewport.clientHeight + 200) / 34))); setRange(previous => previous.first === first && previous.last === last ? previous : { first, last }); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const observer = new ResizeObserver(schedule); observer.observe(viewport); observer.observe(node); viewport.addEventListener('scroll', schedule, { passive: true }); schedule();
    return () => { observer.disconnect(); viewport.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, [items.length]);
  const visible = new Set<number>();
  if (items.length <= 40) for (let index = 0; index < items.length; index++) visible.add(index);
  else { for (let index = range.first; index < Math.min(items.length, range.last); index++) visible.add(index); for (const id of pinned) { const index = items.findIndex(item => item.id === id); if (index >= 0) visible.add(index); } }
  let previous = 0;
  return <div ref={root} data-slot="windowed-sidebar-list">{[...visible].sort((a, b) => a - b).map(index => { const gap = (index - previous) * 34; previous = index + 1; return <div key={items[index].id}>{gap > 0 && <div aria-hidden="true" style={{ height: gap }} />}<div style={{ height: 34 }}>{render(items[index])}</div></div>; })}{previous < items.length && <div aria-hidden="true" style={{ height: (items.length - previous) * 34 }} />}</div>;
}
