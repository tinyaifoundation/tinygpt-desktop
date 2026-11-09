import { useState } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { ArrowUp, Square } from '../icons';
import type { Conversation, QueueAction, QueuedRequest } from '../../shared/chat';
import { RequestQueue } from './RequestQueue';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
export function MobileSendControls({ running, disabled, attachments, send,stop }: { running: boolean; disabled: boolean; attachments: boolean; send: (delivery: 'queue' | 'steer') => void;stop:()=>void }) {
  const text = useAuiState(state => state.composer.text);
  const stopping=running&&!text.trim()&&!attachments;
  return <Button type="button" size="icon" className="size-10 rounded-full" aria-label={stopping?'Stop reply':'Send message'} disabled={disabled||!stopping&&!text.trim()&&!attachments} onClick={()=>stopping?stop():send('queue')}>{stopping?<Square className="size-3.5 fill-current"/>:<ArrowUp className="size-4"/>}</Button>;
}
export function MobileQueue({ conversation, running, disabled, change }: { conversation: Conversation | null; running: boolean; disabled: boolean; change: (action: QueueAction) => Promise<void> }) {
  const [editing, setEditing] = useState<QueuedRequest | null>(null), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!conversation) return null; const items = conversation.queuedRequests ?? []; if (!items.length) return null;
  const id = conversation.id;
  async function act(action: QueueAction) { setBusy(true); setError(''); try { await change(action); return true; } catch (error) { setError(error instanceof Error ? error.message : 'The queue could not be updated.'); return false; } finally { setBusy(false); } }
  return <section className="mobile-queue" aria-label="Up next"><RequestQueue items={items} paused={conversation.queuePaused} error={conversation.queueError} busy={disabled || busy} running={running} remove={requestId => { void act({ conversationId: id, action: 'remove', id: requestId }); }} steer={requestId => { void act({ conversationId: id, action: 'steer', id: requestId }); }} edit={item => { setEditing(item); setText(item.text); }} reorder={ids => { void act({ conversationId: id, action: 'reorder', ids }); }} resume={() => { void act({ conversationId: id, action: 'resume' }); }} />{error && <p role="alert">{error}</p>}<Dialog open={!!editing} change={value => { if (!value && !busy) setEditing(null); }} title="Edit queued message" className="mobile-action-sheet"><textarea aria-label="Queued message" value={text} maxLength={32000} onChange={event => setText(event.target.value)} disabled={busy} rows={5} /><div className="dialog-actions"><Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy || !text.trim()} onClick={() => { if (editing) void act({ conversationId: id, action: 'edit', id: editing.id, replacement: { text, attachmentIds: editing.attachmentIds } }).then(ok => { if (ok) setEditing(null); }); }}>Save</Button></div></Dialog></section>;
}
