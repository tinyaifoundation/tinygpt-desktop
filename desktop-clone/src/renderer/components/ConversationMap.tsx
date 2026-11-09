import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui/button';

export interface ConversationMapEntry { id: string; title: string; preview: string }
export function ConversationMap({ entries, activeId, select }: { entries: ConversationMapEntry[]; activeId: string; select: (id: string) => void }) {
  const rail = useRef<HTMLElement>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ entry: ConversationMapEntry; x: number; y: number } | null>(null);
  const entryIds = entries.map(entry => entry.id).join(',');
  useEffect(() => { setFocused(null); setPeek(null); }, [entryIds]);
  function preview(entry: ConversationMapEntry, target: HTMLElement) {
    const bounds = target.getBoundingClientRect();
    setPeek({ entry, x: bounds.right + 8, y: Math.min(Math.max(8, bounds.top - 16), window.innerHeight - 160) });
  }
  const tabIndex = focused ?? Math.max(0, entries.findIndex(entry => entry.id === activeId));
  return <>
    <nav ref={rail} className="conversation-map absolute left-1 top-1/2 z-20 flex max-h-[50%] -translate-y-1/2 flex-col gap-0.5 overflow-y-auto" aria-label="Conversation map" onPointerLeave={() => setPeek(null)} onKeyDown={event => {
      const buttons = Array.from(rail.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: buttons.length - 1 }[event.key];
      if (next !== undefined) { event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus(); }
      if (event.key === 'Escape') setPeek(null);
    }}>
      {entries.map((entry, index) => <Button key={entry.id} variant="ghost" size="icon" className="map-stub group h-4 w-8 shrink-0 rounded-md px-2 hover:bg-transparent" aria-label={`Jump to message ${index + 1}: ${entry.title.slice(0, 80)}`} aria-describedby={peek?.entry.id === entry.id ? 'conversation-map-preview' : undefined} aria-current={activeId === entry.id ? 'location' : undefined} tabIndex={index === tabIndex ? 0 : -1} onPointerEnter={event => preview(entry, event.currentTarget)} onFocus={event => { setFocused(index); preview(entry, event.currentTarget); }} onBlur={() => setPeek(null)} onClick={() => { setPeek(null); select(entry.id); }}><span className={`h-0.5 rounded-full transition-all group-hover:w-5 group-hover:bg-foreground group-focus-visible:w-5 ${activeId === entry.id ? 'w-4 bg-foreground/60' : 'w-2 bg-foreground/20'}`} /></Button>)}
    </nav>
    {peek && createPortal(<div id="conversation-map-preview" role="tooltip" className="pointer-events-none fixed z-50 w-60 rounded-2xl border bg-background p-3.5 shadow-sm" style={{ left: Math.min(peek.x, window.innerWidth - 248), top: peek.y }}><p className="line-clamp-2 text-[13px] font-medium leading-5">{peek.entry.title}</p>{peek.entry.preview && <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-muted-foreground">{peek.entry.preview}</p>}</div>, document.body)}
  </>;
}
