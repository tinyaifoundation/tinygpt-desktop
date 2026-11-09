import { BranchPickerPrimitive, ComposerPrimitive, ThreadPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { ArrowDown, ChevronDown, ChevronLeft, ChevronRight, CornerDownLeft, Play, X } from '../icons';
import { useEffect, useRef, useState } from 'react';
import { ApprovalCard } from "./ApprovalCard";
import {PluginUseCard} from './PluginConnectionCards';
import { MessageNotice } from './elements/error-state';
import { DictationButton } from './DictationButton';
import { ComposerInput } from './ComposerInput';
import { Button } from './ui/button';
import { ControlTooltip } from './ui/tooltip';
import { Dialog, DialogFooter } from './ui/dialog';
import type { ApprovalRequest, ApprovalDecision } from '../../shared/tools';
import { isComputerTool } from '../../shared/computer';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/dropdown-menu';

// Runtime compositions follow the assistant-ui Elements. The desktop owns
// persistence, execution, and permission decisions through its main process.
export function MessageBranches({ disabled }: { disabled: boolean }) {
  return <BranchPickerPrimitive.Root hideWhenSingleBranch data-slot="message-branches" className="inline-flex items-center gap-0 text-xs tabular-nums text-muted-foreground">
    <ControlTooltip label="Previous version"><BranchPickerPrimitive.Previous asChild><Button variant="ghost" size="icon" className="size-7 rounded-full" aria-label="Show previous response" disabled={disabled}><ChevronLeft className="size-3.5" /></Button></BranchPickerPrimitive.Previous></ControlTooltip>
    <span aria-live="polite"><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span>
    <ControlTooltip label="Next version"><BranchPickerPrimitive.Next asChild><Button variant="ghost" size="icon" className="size-7 rounded-full" aria-label="Show next response" disabled={disabled}><ChevronRight className="size-3.5" /></Button></BranchPickerPrimitive.Next></ControlTooltip>
  </BranchPickerPrimitive.Root>;
}
export function EditMessage({ disabled }: { disabled: boolean }) {
  const aui = useAui();
  const [dictating, setDictating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const messageId = useAuiState(s => s.message.id);
  const hasText = useAuiState(s => !!s.composer.text.trim());
  return <ComposerPrimitive.Root data-slot="edit-message" className="message-edit-composer" onSubmit={event => { event.preventDefault(); if (!disabled && !dictating && hasText) setConfirming(true); }}>
    <ComposerInput scrollClassName="composer-edit-input-scroll" autoFocus cancelOnEscape={!dictating && !confirming} rows={3} maxLength={32000} aria-label="Edit message" className="min-h-20 w-full resize-none bg-transparent text-[15px] leading-7 outline-none" />
    <div className="message-edit-controls">
      {window.tinygpt && <DictationButton bridge={window.tinygpt} scope={messageId} disabled={disabled || confirming} activeChanged={setDictating} />}
      <ComposerPrimitive.Cancel asChild><Button type="button" size="sm" variant="ghost" className="message-edit-cancel" disabled={confirming}>Cancel</Button></ComposerPrimitive.Cancel>
      <Button type="submit" size="sm" className="message-edit-send" disabled={disabled || dictating || !hasText}>Send</Button>
    </div>
    <Dialog open={confirming} change={setConfirming} title="Undo changes and send edit?" description="Sending this edit will undo all recorded file changes made by this turn and any later turns, then start a new reply. Your previous message versions will remain available.">
      <p className="text-sm leading-6 text-muted-foreground">Changes made outside the file tools, such as shell commands or actions in connected services, cannot be undone here.</p>
      <DialogFooter><Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button><Button type="button" variant="pill" disabled={disabled || dictating || !hasText} onClick={() => { setConfirming(false); aui.composer().send(); }}>Undo and send</Button></DialogFooter>
    </Dialog>
  </ComposerPrimitive.Root>;
}
export function StoppedReplyNotice({ interrupted, error, disabled, canDiscard, onContinue, onDiscard }: { interrupted: boolean; error: string | null; disabled: boolean; canDiscard: boolean; onContinue: () => void; onDiscard: () => void }) {
  return <MessageNotice role="status" tone="muted" title={interrupted ? 'Reply interrupted' : 'Reply stopped'} action={<div className="message-notice-actions"><Button variant="ghost" size="sm" disabled={disabled} onClick={onContinue}><Play aria-hidden="true" />Continue</Button>{canDiscard && <Button variant="ghost" size="sm" disabled={disabled} onClick={onDiscard}><X aria-hidden="true" />Discard</Button>}</div>}><span>{error || 'Partial answer saved. You can continue this reply.'}</span></MessageNotice>;
}
export function PermissionGrant({ approval, busy, onGrant }: { approval: ApprovalRequest; busy: boolean; onGrant: (decision: ApprovalDecision) => void }) {
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (busy || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('[role="menu"], [data-slot="dialog-content"]') || (event.target instanceof Element && event.target.closest('[role="menu"]'))) return;
      if (event.key === 'Escape') { event.preventDefault(); onGrant('deny'); }
      else if (event.key === 'Enter' && !(event.target instanceof Element && event.target.closest('button, input, textarea, a, [contenteditable="true"]'))) { event.preventDefault(); onGrant('allow-once'); }
    };
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut);
  }, [approval.id, busy, onGrant]);
  if(approval.pluginUse)return <PluginUseCard plugin={approval.pluginUse} status="pending" busy={busy} allow={()=>onGrant('allow-conversation')} deny={()=>onGrant('deny')}/>;
  const action = approval.summary.replace(/^Write /, 'create or replace '); const prompt = approval.prompt || `May I ${action.charAt(0).toLowerCase() + action.slice(1)}?`;
  return <ApprovalCard data-slot="permission-grant" aria-label="Tool approval" descriptionId={`permission-${approval.id}`} heading="Ask permission" title={prompt} description={<>{approval.prompt && <p className="permission-grant-action">{approval.summary}</p>}{isComputerTool(approval.name) && <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6 text-muted-foreground">{approval.details}</div>}</>} actions={<><Button size="sm" variant="outline" disabled={busy} onClick={() => onGrant('deny')}>Deny<kbd>Esc</kbd></Button><div className="permission-grant-allow"><Button size="sm" disabled={busy} onClick={() => onGrant('allow-once')}>Allow once<kbd><CornerDownLeft /></kbd></Button>{!approval.onceOnly && <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" aria-label="More approval options" disabled={busy}><ChevronDown /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" side="top"><DropdownMenuItem onSelect={() => onGrant('allow-once')}>Allow once</DropdownMenuItem>{!approval.name.startsWith('bot_') && <DropdownMenuItem onSelect={() => onGrant('allow-conversation')}>Allow for this conversation</DropdownMenuItem>}<DropdownMenuItem onSelect={() => onGrant('deny')}>Deny</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}</div></>} />;
}
export function TypingIndicator() {
  return <span data-slot="typing-indicator" role="status" aria-label="Assistant is typing" className="inline-flex items-center gap-1 px-1">{[0, 1, 2].map(index => <span key={index} className="typing-dot size-1 rounded-full bg-current" style={{ animationDelay: `${index * 160}ms` }} />)}</span>;
}
export function ScrollAnchor() {
  const running = useAuiState(s => s.thread.isRunning);
  const anchor = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const viewport = anchor.current?.closest<HTMLElement>('.thread-viewport');
    if (!viewport) return;
    let frame = 0;
    let observedLast: HTMLElement | null = null;
    const sync = () => {
      frame = 0;
      const messages = viewport.querySelectorAll<HTMLElement>('[data-message-id]');
      const last = messages.item(messages.length - 1);
      if (last !== observedLast) {
        if (observedLast) observer.unobserve(observedLast);
        observedLast = last;
        if (last) observer.observe(last);
      }
      const footer = viewport.querySelector<HTMLElement>('.composer-footer');
      const visibleBottom = viewport.getBoundingClientRect().bottom - (footer?.offsetHeight ?? 0);
      // Top-turn anchoring adds blank reserve space after the answer. Reaching
      // the actual last message counts as latest, even with reserve remaining.
      setAtBottom(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2 || !last || last.getBoundingClientRect().bottom <= visibleBottom + 2);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    for (const element of viewport.querySelectorAll('.thread-message-column, .composer-footer')) observer.observe(element);
    // Deferred Markdown and generated interfaces can grow after the run ends,
    // without resizing the viewport or re-rendering this control.
    const changes = new MutationObserver(schedule);
    const column = viewport.querySelector('.thread-message-column');
    if (column) changes.observe(column, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener('scroll', schedule, { passive: true });
    sync();
    return () => { observer.disconnect(); changes.disconnect(); viewport.removeEventListener('scroll', schedule); cancelAnimationFrame(frame); };
  }, []);
  return <div ref={anchor} data-slot="scroll-anchor" className="pointer-events-none absolute -top-11 left-1/2 flex -translate-x-1/2 items-center gap-2">
    {running && <div className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm"><TypingIndicator /></div>}
    {!atBottom && <ControlTooltip label="Scroll to latest message"><ThreadPrimitive.ScrollToBottom asChild behavior={document.documentElement.dataset.motion === 'reduce' ? 'instant' : 'smooth'}><Button variant="ghost" size="icon" aria-label="Scroll to latest message" className="pointer-events-auto size-8 shrink-0 rounded-full border bg-background shadow-sm"><ArrowDown className="size-4" /></Button></ThreadPrimitive.ScrollToBottom></ControlTooltip>}
  </div>;
}
