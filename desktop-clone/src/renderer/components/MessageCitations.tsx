import { Children, createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, FileText } from '../icons';
import type { CitationSource } from '../../core/citations';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card';

export const MessageCitations = createContext<{ sources: CitationSource[]; openSource: (source: CitationSource) => void }>({ sources: [], openSource: () => {} });

/** Chromium loads each site's own favicon. No hosted TinyGPT/favicon proxy. */
export function SiteIcon({ source, className = 'size-4' }: { source: Pick<CitationSource, 'domain' | 'url'>; className?: string }) {
  const [failed, setFailed] = useState(false);
  const icon = source.url ? `${new URL(source.url).origin}/favicon.ico` : '';
  useEffect(() => setFailed(false), [icon]);
  if (!icon || failed) return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ${className}`}>{source.domain ? source.domain.slice(0, 1).toUpperCase() : <FileText className="size-3" />}</span>;
  return <img aria-hidden="true" alt="" src={icon} referrerPolicy="no-referrer" loading="lazy" className={`shrink-0 rounded-full object-contain ${className}`} onError={() => setFailed(true)} />;
}
export function FaviconStack({ sources, dark = false }: { sources: readonly CitationSource[]; dark?: boolean }) {
  const preview = sources.filter((source, index, list) => index === list.findIndex(item => (item.domain || item.key) === (source.domain || source.key))).slice(0, 3);
  return <span className="relative isolate inline-flex shrink-0 items-center" aria-hidden="true">{preview.map((source, index) => <span key={source.key} className={`relative inline-flex size-4 overflow-hidden rounded-full bg-background ring-[1.5px] ${dark ? 'ring-zinc-900' : 'ring-background'}`} style={{ marginLeft: index ? -6 : 0, zIndex: preview.length - index }}><SiteIcon source={source} className="size-4" /></span>)}</span>;
}
function SourcePreview({ source, compact = false, onSelect }: { source: CitationSource; compact?: boolean; onSelect?: () => void }) {
  const { openSource } = useContext(MessageCitations);
  return <div className={compact ? '' : 'px-3.5 pb-3.5 pt-3'}>
    <div className="flex items-center gap-1.5"><SiteIcon source={source} /><span className="truncate font-mono text-[10px] text-muted-foreground">{source.domain || 'Saved on this device'}</span></div>
    <button type="button" className="mt-2 block w-full text-left text-[13px] font-medium leading-snug hover:underline" aria-label={`Open source: ${source.title}`} onClick={() => { openSource(source); onSelect?.(); }}>{source.title}</button>
    {source.url && <p className="mt-1 truncate text-[11px] text-muted-foreground">{source.url}</p>}
    {source.snippet && <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{source.snippet}</p>}
  </div>;
}
export function Citation({ index }: { index: number }) {
  const { sources } = useContext(MessageCitations);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const selected = useRef(false);
  const open = hovered || pinned;
  const source = sources[index];
  if (!source) return <>[{index + 1}]</>;
  const select = () => { selected.current = pinned; setPinned(false); setHovered(false); };
  // Hover previews stay quiet; click/Enter opens a focusable, keyboard-accessible card.
  return <Popover open={pinned} onOpenChange={setPinned}><HoverCard open={hovered && !pinned} onOpenChange={setHovered} openDelay={0} closeDelay={120}>
    <PopoverTrigger asChild><HoverCardTrigger asChild><button type="button" data-slot="inline-citation" aria-label={`Citation ${index + 1}: ${source.title}`} className={`citation mx-0.5 inline-flex h-4 min-w-4 -translate-y-0.5 items-center justify-center rounded-[5px] px-1 align-middle font-mono text-[10px] font-medium tabular-nums ${open ? 'bg-foreground text-background' : 'bg-foreground/6 text-foreground/45 hover:text-foreground/90'}`}>{index + 1}</button></HoverCardTrigger></PopoverTrigger>
    <HoverCardContent side="top" align="start" aria-label={`Citation ${index + 1} preview`}><SourcePreview source={source} compact onSelect={select} /></HoverCardContent>
  </HoverCard><PopoverContent side="top" align="start" className="w-64 rounded-2xl p-3.5" aria-label={`Citation ${index + 1} preview`} onCloseAutoFocus={event => { if (selected.current) { event.preventDefault(); selected.current = false; } }}><SourcePreview source={source} compact onSelect={select} /></PopoverContent></Popover>;
}
function citeChildren(children: ReactNode, sources: readonly CitationSource[]): ReactNode {
  if (!sources.length) return children;
  return Children.map(children, child => {
    if (typeof child === 'string') {
      const nodes: ReactNode[] = []; let last = 0;
      for (const match of child.matchAll(/\[(\d+)\]/g)) {
        const index = Number(match[1]) - 1; const start = match.index;
        if (start > last) nodes.push(child.slice(last, start));
        nodes.push(sources[index] ? <Citation key={`${start}-${index}`} index={index} /> : match[0]); last = start + match[0].length;
      }
      if (last < child.length) nodes.push(child.slice(last));
      return nodes;
    }
    // Each prose component handles its own text. Never descend into code or links.
    return child;
  });
}
export function CitedText({ children }: { children: ReactNode }) { const { sources } = useContext(MessageCitations); return <>{citeChildren(children, sources)}</>; }

export function MessageSources({ sources }: { sources: CitationSource[] }) {
  const [open, setOpen] = useState(false); const [index, setIndex] = useState(0);
  const current = Math.min(index, sources.length - 1);
  if (!sources.length) return null;
  function move(delta: number) { setIndex((current + delta + sources.length) % sources.length); }
  return <Popover open={open} onOpenChange={value => { setOpen(value); if (!value) setIndex(0); }}><PopoverTrigger asChild><button type="button" data-slot="sources" aria-label={`${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`} className="inline-flex w-fit items-center gap-1.5 rounded-full bg-zinc-900 px-1.5 py-1 text-[11px] leading-none text-white transition-colors hover:bg-zinc-800"><FaviconStack sources={sources} dark /><span className="pr-1 font-medium">{sources.length} {sources.length === 1 ? 'source' : 'sources'}</span></button></PopoverTrigger><PopoverContent side="top" align="start" className="w-80 overflow-hidden rounded-md p-0" aria-label="Answer sources" onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowRight' ? 1 : -1); } }}>
    {sources.length > 1 && <div className="flex items-center justify-between border-b px-2.5 py-1.5"><Button variant="ghost" size="icon" className="size-6 rounded-full" aria-label="Previous source" onClick={() => move(-1)}><ArrowLeft className="size-3.5" /></Button><span className="text-[11px] tabular-nums text-muted-foreground" aria-live="polite">{current + 1} / {sources.length}</span><Button variant="ghost" size="icon" className="size-6 rounded-full" aria-label="Next source" onClick={() => move(1)}><ArrowRight className="size-3.5" /></Button></div>}
    <SourcePreview source={sources[current]} onSelect={() => { setOpen(false); setIndex(0); }} />
  </PopoverContent></Popover>;
}
