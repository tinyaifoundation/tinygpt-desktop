import { useEffect, useId, useState, type ReactElement } from 'react';
import { BriefcaseBusiness, ChartNoAxesColumn, FolderClosed, MessageCircle, Zap } from '../icons';
import type { ConversationSummary, ConversationUsage } from '../../shared/chat';
import type { DesktopBridge } from '../../shared/contracts';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card';

function age(date: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - date) / 60000));
  if (!minutes) return 'Now'; if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60); return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
function compact(tokens: number): string { return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens); }

export function ConversationPreview({ chat, projectName, bridge, children, disabled = false }: { chat: ConversationSummary; projectName?: string; bridge: DesktopBridge; children: ReactElement; disabled?: boolean }) {
  const id = useId(); const [open, setOpen] = useState(false);
  const visible = open && !disabled;
  const [usage, setUsage] = useState<ConversationUsage | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!visible) return;
    let active = true; setUsage(null); setFailed(false);
    void bridge.conversationUsage(chat.id).then(result => { if (active) { if (result.ok) setUsage(result.value); else setFailed(true); } }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [visible, chat.id, chat.updatedAt, bridge]);
  return <HoverCard open={visible} onOpenChange={value => setOpen(value && !disabled)} openDelay={260} closeDelay={100}>
    <HoverCardTrigger asChild aria-describedby={visible ? id : undefined} onPointerDown={() => setOpen(false)} onFocus={event => setOpen(!disabled && !!(event.target as HTMLElement).closest('.sidebar-chat-row'))} onBlur={() => setOpen(false)}>{children}</HoverCardTrigger>
    <HoverCardContent id={id} role="tooltip" side="right" sideOffset={24} align="start" className="conversation-preview">
      <div className="conversation-preview-heading"><strong>{chat.title}</strong><time dateTime={new Date(chat.updatedAt).toISOString()} title={new Date(chat.updatedAt).toLocaleString()}>{age(chat.updatedAt)}</time></div>
      {chat.summary && <p className="conversation-preview-description">{chat.summary}</p>}
      <div className="conversation-preview-row"><FolderClosed /><span>{projectName ?? 'No project'}</span></div>
      <div className="conversation-preview-row">{chat.mode === 'code' ? <BriefcaseBusiness /> : <MessageCircle />}<span>{chat.mode === 'code' ? 'Work' : 'Chat'}</span></div>
      <div className="conversation-preview-row"><ChartNoAxesColumn />{usage ? <span className="conversation-preview-usage"><span>{usage.totalTokens === null ? 'Usage unavailable' : `${usage.missingUsage ? '≥' : ''}${compact(usage.totalTokens)} tokens`}</span><span className="conversation-preview-speed" title="Average reported output tokens per second across completed responses, including tool and approval time."><Zap />{usage.tokensPerSecond === null ? '—' : usage.tokensPerSecond.toFixed(1)} tokens/sec</span></span> : <span role="status">{failed ? 'Stats unavailable' : 'Loading usage…'}</span>}</div>
      {usage && <p className="conversation-preview-summary">{usage.messages} {usage.messages === 1 ? 'message' : 'messages'} · {usage.responses} {usage.responses === 1 ? 'response' : 'responses'} · {usage.toolCalls} {usage.toolCalls === 1 ? 'tool' : 'tools'}</p>}
      {usage?.missingUsage && <p className="conversation-preview-note">Some provider usage is unavailable.</p>}
    </HoverCardContent>
  </HoverCard>;
}
