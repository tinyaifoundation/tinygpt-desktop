import { BellRing, CheckCircle2, CircleAlert, X } from '../icons';
import { useState } from 'react';
import type { LibrarySnapshot } from '../../shared/chat';
import type { NotificationAction, NotificationSnapshot } from '../../shared/notifications';
import { ScrollArea } from './ui/scroll-area';

export function ActivityList({ library, select, notifications, action, settings, badges, error }: { library: LibrarySnapshot; select: (id: string) => void; notifications: NotificationSnapshot | null; action: (action: NotificationAction) => Promise<void>; settings: () => void; badges: boolean; error?: string }) {
  const [busy, setBusy] = useState(false);
  async function act(value: NotificationAction) { setBusy(true); try { await action(value); } finally { setBusy(false); } }
  const items = notifications?.items ?? [];
  return <><div className="activity-header"><h2>Activity{notifications?.unreadCount ? ` · ${notifications.unreadCount} unread` : ''}</h2><button type="button" disabled={busy || !notifications?.unreadCount} onClick={() => void act({ action: 'read-all', throughSequence: items[0]?.sequence ?? 0 })}>Mark all read</button></div>
    <ScrollArea className="activity-scroll-area" viewportClassName="activity-scroll-viewport" type="auto" aria-label="Notifications"><div className="activity-list">{items.map(item => {
      const Icon = item.kind === 'completed' ? CheckCircle2 : item.kind === 'failed' ? CircleAlert : BellRing;
      const chat = library.conversations.find(chat => chat.id === item.conversationId);
      return <div className="notification-row" data-unread={!item.read || undefined} key={item.id}><button type="button" className="notification-open" disabled={busy} onClick={() => void act({ action: 'open', id: item.id })}><Icon /><span className="notification-copy"><strong>{item.title}{!item.read && badges && <i aria-label="Unread notification" />}</strong><small>{chat?.title ?? 'Chat'}{item.resolved && item.kind === 'attention' ? ' · Handled' : ''}</small><time dateTime={new Date(item.createdAt).toISOString()} title={new Date(item.createdAt).toLocaleString()}>{new Date(item.createdAt).toDateString() === new Date().toDateString() ? new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}</time></span></button><button type="button" className="notification-dismiss" disabled={busy} aria-label={`Dismiss ${item.title} notification`} onClick={() => void act({ action: 'dismiss', id: item.id })}><X /></button></div>;
    })}{!items.length && <p className="library-empty">{notifications ? 'You’re all caught up.' : 'Loading activity…'}</p>}
    {library.activeRuns.slice(0, 3).map(run => <button type="button" key={run.runId} className="activity-running" onClick={() => select(run.conversationId)}><small>{library.conversations.find(chat => chat.id === run.conversationId)?.title ?? 'Chat'} · Working…</small></button>)}
    </div></ScrollArea><div className="activity-footer"><button type="button" disabled={busy || !items.some(item => item.read)} onClick={() => void act({ action: 'clear-read' })}>Clear read activity</button><button type="button" onClick={settings}>Notification settings</button></div>{error && <p role="alert" className="settings-notice text-destructive">{error}</p>}</>;
}
