import { ThreadPrimitive, unstable_useThreadMessageIds } from '@assistant-ui/react';
import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';

const ESTIMATE = 220, OVERSCAN = 700;
/** Keep the complete assistant-ui repository for branches/search, but mount
 * only the viewport, active editors and the latest turn. Heights preserve scroll. */
export function WindowedMessages({ components }: Pick<ComponentProps<typeof ThreadPrimitive.Messages>, 'components'>) {
  const ids = unstable_useThreadMessageIds();
  const root = useRef<HTMLDivElement>(null), heights = useRef(new Map<string, number>()), initialized = useRef(false);
  const [range, setRange] = useState({ first: Math.max(0, ids.length - 12), last: ids.length - 1, pinned: [] as number[] });
  const [, resized] = useState(0);
  const offsets = useMemo(() => { const result = [0]; for (const id of ids) result.push(result.at(-1)! + (heights.current.get(id) ?? ESTIMATE)); return result; }, [ids, range]);
  const latest = useRef({ ids, offsets }); latest.current = { ids, offsets };
  useLayoutEffect(() => {
    const node = root.current, viewport = node?.closest<HTMLElement>('.thread-viewport'); if (!node || !viewport) return;
    let frame = 0, disposed = false;
    const sync = () => {
      frame = 0; const { ids, offsets } = latest.current;
      if (ids.length <= 60) { setRange(previous => previous.first === 0 && previous.last === ids.length - 1 ? previous : { first: 0, last: ids.length - 1, pinned: [] }); return; }
      const top = viewport.getBoundingClientRect().top - node.getBoundingClientRect().top;
      let first = 0, last = ids.length - 1;
      while (first < last && offsets[first + 1] < top - OVERSCAN) first++;
      last = first; while (last < ids.length - 1 && offsets[last] < top + viewport.clientHeight + OVERSCAN) last++;
      const pinned = Array.from(node.querySelectorAll('[data-slot="edit-message"]')).map(editor => ids.indexOf(editor.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '')).filter(index => index >= 0);
      setRange(previous => previous.first === first && previous.last === last && previous.pinned.join() === pinned.join() ? previous : { first, last, pinned });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) { const id = (entry.target as HTMLElement).dataset.virtualMessage; if (!id) continue; const height = Math.max(24, entry.target.getBoundingClientRect().height); if (Math.abs((heights.current.get(id) ?? ESTIMATE) - height) > 1) { heights.current.set(id, height); changed = true; } }
      if (changed && !disposed) { resized(value => value + 1); setRange(previous => ({ ...previous })); schedule(); }
    });
    const observed = new Set<Element>();
    const observe = () => { for (const row of observed) if (!node.contains(row)) { observer.unobserve(row); observed.delete(row); } for (const row of node.querySelectorAll<HTMLElement>('[data-virtual-message]')) if (!observed.has(row)) { observed.add(row); observer.observe(row); } };
    const changes = new MutationObserver(() => { observe(); schedule(); }); changes.observe(node, { childList: true }); observe();
    const jump = (event: Event) => {
      const id = (event as CustomEvent<string>).detail, index = latest.current.ids.indexOf(id); if (index < 0) return;
      setRange(previous => ({ first: Math.max(0, index - 4), last: Math.min(latest.current.ids.length - 1, index + 6), pinned: previous.pinned }));
      const top = node.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
      viewport.scrollTop = top + latest.current.offsets[index];
      requestAnimationFrame(() => { if (!disposed) node.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'start', behavior: 'instant' }); });
    };
    window.addEventListener('tinygpt-message-jump', jump); viewport.addEventListener('scroll', schedule, { passive: true }); viewport.addEventListener('focusin', schedule); observer.observe(viewport);
    if (!initialized.current && ids.length > 60) { viewport.scrollTop = offsets[Math.max(0, ids.length - 2)]; initialized.current = true; }
    schedule();
    return () => { disposed = true; observer.disconnect(); changes.disconnect(); cancelAnimationFrame(frame); viewport.removeEventListener('scroll', schedule); viewport.removeEventListener('focusin', schedule); window.removeEventListener('tinygpt-message-jump', jump); };
  }, [ids.length]);
  const visible = new Set<number>();
  if (ids.length <= 60) for (let index = 0; index < ids.length; index++) visible.add(index);
  else {
    for (let index = Math.max(0, range.first); index <= Math.min(ids.length - 1, range.last); index++) visible.add(index);
    for (let index = Math.max(0, ids.length - 4); index < ids.length; index++) visible.add(index);
    for (const index of range.pinned) visible.add(index);
  }
  let previous = 0;
  return <div ref={root} data-slot="windowed-messages">{[...visible].sort((a, b) => a - b).map(index => { const gap = offsets[index] - offsets[previous]; previous = index + 1; return <div key={ids[index]}>{gap > 0 && <div aria-hidden="true" style={{ height: gap }} />}<div data-virtual-message={ids[index]} style={{ display: 'flow-root' }}><ThreadPrimitive.Unstable_MessageById messageId={ids[index]} components={components!} /></div></div>; })}{previous < ids.length && <div aria-hidden="true" style={{ height: offsets[ids.length] - offsets[previous] }} />}</div>;
}
