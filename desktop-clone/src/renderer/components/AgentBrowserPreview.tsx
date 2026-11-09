import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, GripHorizontal } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import { browserPreviewOrder, nextBrowserPreview, type BrowserPreviewTask } from '../../core/browser-preview';
import { AgentCursorIcon } from './AgentCursorIcon';
import { ControlTooltip } from './ui/tooltip';
type Position = { x: number; y: number };

export function AgentBrowserPreview({ tasks, bridge, docked = false }: { tasks: BrowserPreviewTask[]; bridge: DesktopBridge; docked?: boolean }) {
  const card = useRef<HTMLElement>(null);
  const moved = useRef(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; start: Position } | null>(null);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const [selectedId, setSelectedId] = useState(tasks.at(-1)?.tabId ?? '');
  const [frames, setFrames] = useState(new Map<string, string>());
  const [pages, setPages] = useState(new Map<string, BrowserPreviewTask>());
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const known = useRef(tasks.map(task => task.tabId));
  const signature = tasks.map(task => task.tabId).join(':');
  const conversationId = tasks[0]?.conversationId;
  const ordered = browserPreviewOrder(tasks, selectedId);
  const visible = ordered.slice(0, 4);
  const depth = Math.max(0, visible.length - 1);
  const latest = useRef(ordered); latest.current = ordered;
  const current = ordered[0];

  useEffect(() => {
    const ids = tasks.map(task => task.tabId);
    const added = ids.filter(id => !known.current.includes(id)).at(-1);
    setSelectedId(previous => added ?? (ids.includes(previous) ? previous : ids.at(-1) ?? ''));
    known.current = ids;
    setFrames(previous => new Map([...previous].filter(([id]) => ids.includes(id))));
    setPages(previous => new Map([...previous].filter(([id]) => ids.includes(id))));
  }, [signature]);
  useEffect(() => setError(''), [current?.tabId]);

  function constrain(next: Position): Position {
    const node = card.current; const pane = node?.parentElement;
    if (!node || !pane) return next;
    return { x: Math.max(12 + depth * 36, Math.min(next.x, pane.clientWidth - node.offsetWidth - 12)), y: Math.max(12 + depth * 18, Math.min(next.y, pane.clientHeight - node.offsetHeight - 12)) };
  }
  function defaultPosition(): Position {
    const node = card.current; const pane = node?.parentElement;
    if (!node || !pane) return { x: 0, y: 0 };
    const composer = Array.from(pane.querySelectorAll('.composer-footer')).at(-1);
    const composerTop = composer ? composer.getBoundingClientRect().top - pane.getBoundingClientRect().top : pane.clientHeight - 120;
    return constrain({ x: pane.clientWidth - node.offsetWidth - 16, y: composerTop - node.offsetHeight - 12 });
  }
  useLayoutEffect(() => {
    if (docked) return;
    const node = card.current; const pane = node?.parentElement;
    if (!node || !pane) return;
    const composer = Array.from(pane.querySelectorAll('.composer-footer')).at(-1);
    const place = () => setPosition(previous => moved.current ? constrain(previous) : defaultPosition());
    place(); const observer = new ResizeObserver(place); observer.observe(pane); observer.observe(node); if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [depth, docked]);

  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const refreshed = new Map<string, number>();
    const capture = async () => {
      if (disposed) return;
      if (document.visibilityState !== 'hidden') {
        const cards = latest.current.slice(0, 4);
        const background = cards.slice(1).find(task => Date.now() - (refreshed.get(task.tabId) ?? 0) > 4000);
        // One polling loop, bounded to visible cards. Never capture every tab at 2fps.
        for (const task of [cards[0], background]) {
          if (!task || disposed) continue;
          try {
            const result = await bridge.workspaceBrowserCapture(task.conversationId, task.tabId, true);
            refreshed.set(task.tabId, Date.now());
            if (!disposed && result.ok && latest.current.some(item => item.tabId === task.tabId)) setFrames(previous => previous.get(task.tabId) === result.value ? previous : new Map(previous).set(task.tabId, result.value));
          } catch { /* A navigation or finished task can replace the page. */ }
        }
      }
      if (!disposed) timer = setTimeout(capture, 1000);
    };
    void capture();
    const unsubscribe = bridge.onWorkspaceBrowserState(state => {
      if (state.conversationId !== conversationId) return;
      setPages(new Map(state.tabs.map(tab => [tab.id, { conversationId: state.conversationId, tabId: tab.id, title: tab.title, url: tab.url }])));
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribe(); };
  }, [bridge, conversationId]);

  async function watch() {
    if (!current) return;
    setOpening(true); setError('');
    try { const result = await bridge.revealBrowser(current.conversationId, current.tabId); if (!result.ok) throw new Error(result.error); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The browser could not be opened.'); }
    finally { setOpening(false); }
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: position };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current; if (!start || start.pointerId !== event.pointerId) return;
    moved.current = true;
    setPosition(constrain({ x: start.start.x + event.clientX - start.x, y: start.start.y + event.clientY - start.y }));
  }
  function moveWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 32 : 12;
    const offset: Record<string, Position> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    if (event.key === 'Home') { event.preventDefault(); moved.current = false; setPosition(defaultPosition()); }
    else if (offset[event.key]) { event.preventDefault(); moved.current = true; setPosition(previous => constrain({ x: previous.x + offset[event.key].x, y: previous.y + offset[event.key].y })); }
  }
  const cycle = (step: number) => setSelectedId(nextBrowserPreview(tasks, current?.tabId ?? '', step));
  return <aside ref={card} className={'agent-browser-preview-stack' + (docked ? ' is-docked' : '')} aria-label="Agent browser preview" style={docked ? undefined : { left: position.x, top: position.y, '--preview-inset': depth * 36 + 'px' } as CSSProperties}>
    {(docked ? visible.slice(0, 1) : visible).map((task, index) => {
      const front = index === 0; const page = pages.get(task.tabId) ?? task;
      let address = 'Browser'; try { address = new URL(page.url).hostname; } catch { /* The page may still be opening. */ }
      return <article key={task.tabId} className={'agent-browser-preview' + (front ? ' is-front' : '')} data-tab-id={task.tabId} style={{ '--depth': index, zIndex: visible.length - index } as CSSProperties}>
        <div aria-hidden={!front} inert={!front}>
          {!docked && <ControlTooltip label="Drag to move · Arrow keys to reposition · Home to reset"><button type="button" className="agent-browser-preview-handle" aria-label="Move browser preview" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={moveWithKeyboard}>
            <AgentCursorIcon /><span>TinyGPT is using the browser</span><GripHorizontal />
          </button></ControlTooltip>}
          <button type="button" className="agent-browser-preview-page" aria-label="Open browser preview" disabled={opening} onClick={() => void watch()}>
            {frames.has(task.tabId) ? <img src={frames.get(task.tabId)} alt={'Live preview of ' + page.title} draggable={false} /> : <span className="agent-browser-preview-loading"><AgentCursorIcon />Opening browser…</span>}
          </button>
          <footer><div><strong>{page.title}</strong><span>{address}</span></div><button type="button" aria-label="Watch browser" disabled={opening} onClick={() => void watch()}>Watch<ArrowUpRight /></button></footer>
          {tasks.length > 1 && <nav className="agent-browser-preview-navigation" aria-label="Browser previews">
            <ControlTooltip label="Previous browser tab"><button type="button" aria-label="Previous browser tab" onClick={() => cycle(-1)}><ChevronLeft /></button></ControlTooltip>
            <span aria-live={front ? 'polite' : undefined}>{tasks.findIndex(item => item.tabId === task.tabId) + 1} / {tasks.length} tabs</span>
            <ControlTooltip label="Next browser tab"><button type="button" aria-label="Next browser tab" onClick={() => cycle(1)}><ChevronRight /></button></ControlTooltip>
          </nav>}
          {front && error && <p role="alert">{error}</p>}
        </div>
        {!front && <button type="button" className="agent-browser-preview-select" aria-label={'Preview browser tab: ' + page.title} onClick={() => setSelectedId(task.tabId)} />}
      </article>;
    })}
  </aside>;
}
