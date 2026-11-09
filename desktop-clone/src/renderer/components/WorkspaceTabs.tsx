import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, X } from '../icons';
import { AgentCursorIcon } from './AgentCursorIcon';
import { ControlTooltip } from './ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ScrollArea } from './ui/scroll-area';

export interface WorkspaceTab {
  id: string;
  title: string;
  icon: ReactNode;
  active: boolean;
  activate: () => void;
  close: () => void;
  locked?: boolean;
  agent?: boolean;
}

export function WorkspaceTabs({ tabs }: { tabs: WorkspaceTab[] }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = container.current; if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Tabs shrink to 96px; overflow reserves an 80px More button and a 4px gap.
  const fits = tabs.length * 96 + Math.max(0, tabs.length - 1) * 4 <= width;
  const capacity = fits ? tabs.length : Math.max(0, Math.floor((width - 80) / 100));
  const visible = tabs.slice(0, capacity);
  const active = tabs.find(tab => tab.active);
  if (active && capacity > 0 && !visible.includes(active)) visible[capacity - 1] = active;
  const hidden = tabs.filter(tab => !visible.includes(tab));
  useLayoutEffect(() => {
    if (focusNext.current) { const button = buttons.current.get(focusNext.current); if (button) { button.focus(); focusNext.current = null; } }
  });
  const icon = (tab: WorkspaceTab) => tab.agent ? <span className="agent-tab-cursor" aria-label="Agent is using this tab"><AgentCursorIcon /></span> : tab.icon;
  function keyboard(event: React.KeyboardEvent, tab: WorkspaceTab) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const index = tabs.indexOf(tab);
    const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
    if (next) { focusNext.current = next.id; next.activate(); }
  }
  return <div ref={container} className="workspace-tabs" role="tablist" aria-label="Workspace tabs">
    {visible.map(tab => <div className="workspace-tab" data-active={tab.active} key={tab.id}>
      <ControlTooltip label={tab.agent ? `${tab.title} · Agent is using this tab` : tab.title}><button ref={element => { if (element) buttons.current.set(tab.id, element); else buttons.current.delete(tab.id); }} className="workspace-tab-select" role="tab" aria-label={tab.title} aria-selected={tab.active} tabIndex={tab.active || !active && visible[0] === tab ? 0 : -1} onClick={tab.activate} onKeyDown={event => keyboard(event, tab)}>{icon(tab)}<span>{tab.title}</span></button></ControlTooltip>
      <button className="workspace-tab-close" aria-label={`Close ${tab.title}`} disabled={tab.locked} onClick={tab.close}><X /></button>
    </div>)}
    {hidden.length > 0 && <DropdownMenu modal={false}><DropdownMenuTrigger asChild><button className="workspace-tabs-more" aria-label="More workspace tabs">More…<ChevronDown /></button></DropdownMenuTrigger><DropdownMenuContent className="workspace-tabs-overflow" align="end"><ScrollArea style={{ height: Math.min(320, hidden.length * 36) }}><div>{hidden.map(tab => <DropdownMenuItem key={tab.id} onSelect={tab.activate} className="workspace-overflow-item">{icon(tab)}<span>{tab.title}</span>{tab.active && <Check className="workspace-overflow-check" />}</DropdownMenuItem>)}</div></ScrollArea></DropdownMenuContent></DropdownMenu>}
  </div>;
}
