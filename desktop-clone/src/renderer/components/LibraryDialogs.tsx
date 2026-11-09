import { useCallback, useState } from 'react';
import { FolderOpen, LoaderCircle, SquarePen, Settings } from '../icons';
import type { ConversationSummary, LibrarySnapshot } from '../../shared/chat';
import { Dialog } from './ui/dialog';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { matchesConversation } from '../../shared/conversation-search';
export function SearchChatsDialog({ library, close, select, newChat, newProject, settings, platform }: { library: LibrarySnapshot; close: () => void; select: (id: string) => void; newChat: () => void; newProject: () => void; settings: () => void; platform: string }) {
  const anchor = useCallback((element: HTMLDivElement | null) => {
    if (!element || platform === 'mobile') return;
    // Begin centered, then hold that opening position as the results shrink or grow.
    const top = element.getBoundingClientRect().top;
    element.style.top = `${top}px`; element.style.transform = 'translateX(-50%)';
    element.style.setProperty('--search-top', `${top}px`);
    element.style.maxHeight = `calc(100dvh - ${top}px - 16px)`;
  }, [platform]);
  const [query, setQuery] = useState(''); const [index, setIndex] = useState(0); const needle = query.trim().toLocaleLowerCase();
  const results = library.conversations.filter(chat => !chat.archived && matchesConversation(chat, needle, library.projects.find(project => project.id === chat.projectId)?.name)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, needle ? 100 : 9);
  const actions = [
    { id: 'new', title: 'New chat', Icon: SquarePen, run: newChat, shortcut: platform === 'darwin' ? '⌘J' : 'Ctrl+J' },
    { id: 'project', title: 'New Project', Icon: FolderOpen, run: newProject, shortcut: null },
    { id: 'settings', title: 'Settings', Icon: Settings, run: settings, shortcut: null },
  ].filter(action => (platform !== 'mobile' || action.id === 'new') && (!needle || action.title.toLocaleLowerCase().includes(needle)));
  const choices = [...results.map(chat => ({ id: `chat-search-${chat.id}`, run: () => select(chat.id) })), ...actions.map(action => ({ id: `chat-search-action-${action.id}`, run: action.run }))];
  const selected = Math.min(index, choices.length - 1);
  function activate(position: number) { const choice = choices[position]; if (choice) { close(); choice.run(); } }
  return <Dialog open change={open => { if (!open) close(); }} title="Search chats" titleHidden showClose={false} className={`search-chats-dialog ${platform === 'mobile' ? 'mobile-search-dialog' : ''}`} contentRef={anchor}>
    <div className="search-command" onKeyDown={event => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-9]$/.test(event.key) && results[Number(event.key) - 1]) { event.preventDefault(); event.stopPropagation(); activate(Number(event.key) - 1); }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'j') { event.preventDefault(); event.stopPropagation(); close(); newChat(); }
    }}>
      <div className="search-dialog-input"><input autoFocus role="combobox" aria-label="Search saved chats" aria-autocomplete="list" aria-expanded="true" aria-controls="chat-search-options" aria-activedescendant={choices[selected]?.id} placeholder="Search chats" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = Math.max(0, Math.min(choices.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1))); setIndex(next); document.getElementById(choices[next]?.id)?.scrollIntoView({ block: 'nearest' }); }
        if (event.key === 'Enter') { event.preventDefault(); activate(selected); }
      }} /></div>
      <div className="search-command-options" id="chat-search-options" role="listbox" aria-label="Matching chats and quick actions">
        <div role="group" aria-label="Chats"><h2 className="search-section-label">Chats</h2><div className="search-dialog-results">{results.map((chat, position) => <button type="button" role="option" aria-selected={selected === position} tabIndex={-1} id={`chat-search-${chat.id}`} key={chat.id} className={selected === position ? 'is-selected' : ''} title={[chat.title, chat.summary].filter(Boolean).join('\n')} onMouseEnter={() => setIndex(position)} onClick={() => activate(position)}>
          <span className="search-chat-status">{library.activeRuns.some(run => run.conversationId === chat.id) && <LoaderCircle className="animate-spin" aria-label="Reply running" />}</span>
          <strong>{chat.title}</strong><small className="search-chat-project">{library.projects.find(project => project.id === chat.projectId)?.name ?? (chat.mode === 'bot' ? 'Your Bot' : 'Personal')}</small>{position < 9 && <kbd>{platform === 'darwin' ? '⌥' : 'Alt+'}{position + 1}</kbd>}
        </button>)}{!results.length && <p>No matching chats</p>}</div></div>
        {!!actions.length && <div role="group" aria-label="Quick actions" className="search-quick-actions"><h2 className="search-section-label">Quick actions</h2>{actions.map((action, position) => <button type="button" role="option" aria-selected={selected === results.length + position} tabIndex={-1} id={`chat-search-action-${action.id}`} key={action.id} className={selected === results.length + position ? 'is-selected' : ''} onMouseEnter={() => setIndex(results.length + position)} onClick={() => activate(results.length + position)}><action.Icon /><span>{action.title}</span>{action.shortcut && <kbd>{action.shortcut}</kbd>}</button>)}</div>}
      </div>
    </div>
  </Dialog>;
}
export function ConversationEditDialog({ chat, action, close, save }: { chat: ConversationSummary; action: 'rename' | 'delete'; close: () => void; save: (value: string) => Promise<void> }) {
  const [title, setTitle] = useState(chat.title); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Dialog open change={open => { if (!open && !busy) close(); }} title={action === 'rename' ? 'Rename chat' : 'Delete chat?'} description={action === 'delete' ? `“${chat.title}” and its saved messages will be deleted from this computer.` : undefined}><form onSubmit={event => { event.preventDefault(); setBusy(true); void save(title).then(close, cause => setError(cause instanceof Error ? cause.message : 'The chat could not be changed.')).finally(() => setBusy(false)); }}>{action === 'rename' && <Input autoFocus aria-label="Chat title" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} />}{error && <p role="alert">{error}</p>}<div className="dialog-actions"><Button variant="ghost" type="button" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" variant={action === 'delete' ? 'destructive' : 'default'} disabled={busy || !title.trim()}>{action === 'rename' ? 'Save title' : 'Delete conversation'}</Button></div></form></Dialog>;
}

