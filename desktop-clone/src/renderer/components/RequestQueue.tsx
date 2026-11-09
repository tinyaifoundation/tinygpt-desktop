import { useState } from 'react';
import { CornerDownRight, GripVertical, ListEnd, MoreHorizontal, Paperclip, Pencil, Trash2 } from '../icons';
import type { QueuedRequest } from '../../shared/chat';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';

export function RequestQueue({ items, paused, error, busy, running, remove, steer, edit, reorder, resume }: {
  items: QueuedRequest[]; paused?: boolean; error?: string; busy: boolean; running: boolean;
  remove: (id: string) => void; steer: (id: string) => void; edit: (item: QueuedRequest) => void;
  reorder: (ids: string[]) => void; resume: () => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [reorderMenu, setReorderMenu] = useState<string | null>(null);
  if (!items.length) return null;
  function move(id: string, target: number) {
    const ids = items.map(item => item.id); const from = ids.indexOf(id); if (from < 0 || from === target) return;
    ids.splice(from, 1); ids.splice(Math.max(0, Math.min(ids.length, target)), 0, id); reorder(ids);
  }
  return <section className="request-queue" aria-label="Queued requests">
    <ol className="request-queue-list">{items.map((item, index) => <li className="request-queue-row" key={item.id} data-queue-id={item.id} data-dragging={dragged === item.id || undefined} data-drop-target={over === item.id && dragged !== item.id || undefined}
      onDragOver={event => { if (dragged && !busy) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(item.id); } }}
      onDrop={event => { event.preventDefault(); if (dragged && !busy) move(dragged, index); setDragged(null); setOver(null); }}>
      <Popover open={reorderMenu === item.id} onOpenChange={open => setReorderMenu(open ? item.id : null)}><PopoverTrigger asChild><button type="button" className="request-queue-handle" aria-label={`Reorder queued request ${index + 1}`} title="Drag to reorder, or click for options" disabled={busy || item.lane === 'steer'} draggable={!busy && item.lane !== 'steer'}
        onDragStart={event => { setReorderMenu(null); event.dataTransfer.setData('text/plain', item.id); event.dataTransfer.effectAllowed = 'move'; setDragged(item.id); }}
        onDragEnd={() => { setDragged(null); setOver(null); }}
        onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(item.id, index + (event.key === 'ArrowUp' ? -1 : 1)); } }}><ListEnd className="queue-handle-idle" /><GripVertical className="queue-handle-grip" /></button></PopoverTrigger>
        <PopoverContent align="start" className="request-queue-reorder-menu"><div role="group" aria-label="Reorder request">{[{ label: 'Move up', target: index - 1, disabled: index === 0 }, { label: 'Move down', target: index + 1, disabled: index === items.length - 1 }, { label: 'Move to top', target: 0, disabled: index === 0 }].map(option => <button type="button" key={option.label} disabled={option.disabled || busy} onClick={() => { move(item.id, option.target); setReorderMenu(null); }}>{option.label}</button>)}</div></PopoverContent>
      </Popover>
      <span className="request-queue-text" title={item.text}>{item.text}</span>
      {!!item.attachmentIds.length && <span className="request-queue-attachments" aria-label={`${item.attachmentIds.length} attachments`}><Paperclip />{item.attachmentIds.length}</span>}
      <button type="button" className="request-queue-steer" disabled={busy || item.lane === 'steer'} aria-label={`Steer queued request ${index + 1}`} title={running ? 'Send into the current run' : 'Send now'} onClick={() => steer(item.id)}><CornerDownRight /><span>{item.lane === 'steer' ? 'Steering…' : 'Steer'}</span></button>
      <button type="button" className="request-queue-icon" disabled={busy || item.lane === 'steer'} aria-label={`Delete queued request ${index + 1}`} title="Delete queued request" onClick={() => remove(item.id)}><Trash2 /></button>
      <DropdownMenu modal={false}><DropdownMenuTrigger asChild><button type="button" className="request-queue-icon" aria-label={`Options for queued request ${index + 1}`} disabled={busy || item.lane === 'steer'}><MoreHorizontal /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => edit(item)}><Pencil />Edit in composer</DropdownMenuItem><DropdownMenuItem onSelect={() => steer(item.id)}><CornerDownRight />{running ? 'Steer current run' : 'Send now'}</DropdownMenuItem><DropdownMenuItem onSelect={() => remove(item.id)}><Trash2 />Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </li>)}</ol>
    {paused && !running && <div className="request-queue-paused"><span role="status">{error || 'Queue paused'}</span><button type="button" disabled={busy} onClick={resume}>Resume queue</button></div>}
  </section>;
}
