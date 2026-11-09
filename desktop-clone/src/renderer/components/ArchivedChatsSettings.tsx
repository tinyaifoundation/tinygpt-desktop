import { useState } from 'react';
import { Archive, ArchiveRestore, Search } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import { SettingsButton as Button } from './ui/settings-button';
import { Input } from './ui/input';
import { matchesConversation } from '../../shared/conversation-search';

export function ArchivedChatsSettings({ library, bridge, updateLibrary }: { library: LibrarySnapshot; bridge: DesktopBridge; updateLibrary: (value: LibrarySnapshot) => void }) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const archived = library.conversations.filter(chat => chat.archived);
  const matches = archived.filter(chat => matchesConversation(chat, query));
  async function restore(id: string) {
    setPending(id); setError('');
    try {
      const result = await bridge.organizeConversation({ id, action: 'archive', value: false });
      if (!result.ok) throw new Error(result.error);
      updateLibrary(result.value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This chat could not be restored.'); }
    finally { setPending(null); }
  }
  return <section className="settings-content-group archived-chats-settings" aria-label="Archived chats">
    {archived.length > 0 && <p className="settings-notice">Restore an archived chat to return it to your sidebar.</p>}
    {archived.length > 0 && <Input aria-label="Search archived chats" placeholder="Search archived chats" value={query} onChange={event => setQuery(event.target.value)} />}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="settings-card">{matches.map(chat => <div className="archived-chat-row" key={chat.id}>
      <div><strong>{chat.title}</strong><small>{library.projects.find(project => project.id === chat.projectId)?.name ?? 'Personal'} · {new Date(chat.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</small></div>
      <Button aria-label={`Restore ${chat.title}`} disabled={pending !== null} onClick={() => void restore(chat.id)}><ArchiveRestore />{pending === chat.id ? 'Restoring…' : 'Restore'}</Button>
    </div>)}{!matches.length && <div className="archived-chats-empty" role="status"><span className="archived-chats-empty-icon">{archived.length ? <Search aria-hidden="true" /> : <Archive aria-hidden="true" />}</span><h2>{archived.length ? 'No matching chats' : 'No archived chats'}</h2><p>{archived.length ? 'Try a different search to find an archived chat.' : 'Chats you archive will appear here. You can restore them anytime.'}</p>{archived.length > 0 && <Button onClick={() => setQuery('')}>Clear search</Button>}</div>}</div>
  </section>;
}
