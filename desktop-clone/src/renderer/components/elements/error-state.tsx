import { ActionBarPrimitive, ErrorPrimitive, MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { CircleAlert, RotateCcw } from '../../icons';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '../ui/button';

export function MessageNotice({ title, tone = 'error', children, action, ...props }: ComponentProps<'div'> & { title: string; tone?: 'error' | 'muted'; action?: ReactNode }) {
  return <div {...props} data-slot="error-state" data-tone={tone} className="message-error-state">
    <CircleAlert aria-hidden="true" strokeWidth={1.25} />
    <div className="message-error-copy"><p>{title}</p>{children}</div>
    {action}
  </div>;
}

// assistant-ui Error state runtime composition: the message owns both its
// sanitized failure and reload action; retry creates a preserved sibling branch.
export function MessageErrorState({ disabled, allowRetry = true, onContinue, work = false }: { disabled: boolean; allowRetry?: boolean; onContinue?: () => void; work?: boolean }) {
  const timeout = useAuiState(s => s.message.status?.type === 'incomplete' && s.message.status.reason === 'error' && /timed out|stopped responding/i.test(String(s.message.status.error ?? '')));
  return <MessagePrimitive.Error><ErrorPrimitive.Root asChild><MessageNotice title={work ? 'Work paused' : timeout ? 'Connection timed out' : 'Reply failed'} action={onContinue ? <Button variant="ghost" size="sm" disabled={disabled} aria-label={work ? 'Resume saved work' : 'Continue saved reply'} onClick={onContinue}><RotateCcw aria-hidden="true" />{work ? 'Resume work' : 'Continue'}</Button> : allowRetry && <ActionBarPrimitive.Reload asChild><Button variant="ghost" size="sm" disabled={disabled} aria-label="Retry failed reply"><RotateCcw aria-hidden="true" />Retry</Button></ActionBarPrimitive.Reload>}><ErrorPrimitive.Message />{onContinue && <p>{work ? 'Your progress and completed actions are saved. Resume from this point.' : 'Your partial reply is saved. Continue from where it stopped.'}</p>}</MessageNotice></ErrorPrimitive.Root></MessagePrimitive.Error>;
}
