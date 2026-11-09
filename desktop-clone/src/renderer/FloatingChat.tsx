import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeChatUpdates } from './lib/chat-updates';
import { Minus, X } from './icons';
import type { AppSnapshot, ChatWindowState } from '../shared/contracts';
import type { ChatUpdate, Conversation, LibrarySnapshot } from '../shared/chat';
import type { BotSnapshot } from '../shared/bot';
import { Workbench } from './components/Workbench';
import { Button } from './components/ui/button';
import { ControlTooltip, TooltipProvider } from './components/ui/tooltip';
import { useDesktopPreferences } from './lib/appearance';
import { useNotifications, useNotificationView } from './lib/notifications';

export function FloatingChat() {
  const bridge = window.tinygpt!;
  const { bot, setBot } = useDesktopPreferences();
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [botStatus, setBotStatus] = useState<BotSnapshot>({ configured: false, conversationId: null, projectId: null, phase: 'idle' });
  const [error, setError] = useState('');
  const [botHeaderTarget, setBotHeaderTarget] = useState<HTMLDivElement | null>(null);
  const currentId = useRef<string | null>(null);
  const readPending = useRef(new Set<string>());
  const activity = useNotifications(bridge);
  useNotificationView(bridge, conversation?.id ?? null, !!snapshot && !!library, activity.snapshot?.items[0]?.sequence ?? 0);
  const update = useCallback((value: ChatUpdate) => { setLibrary(value.library); if (currentId.current === value.conversation.id) setConversation(value.conversation); }, []);
  useEffect(() => {
    let alive = true, revision = 0;
    const accept = async (state: ChatWindowState) => {
      const selection = ++revision; currentId.current = state.conversationId;
      if (!state.conversationId) return;
      setConversation(previous => previous?.id === state.conversationId ? previous : null);
      try {
        const [settings, saved, selected, status] = await Promise.all([bridge.snapshot(), bridge.library(), bridge.conversation(state.conversationId), bridge.botSnapshot()]);
        if (!alive || selection !== revision) return;
        if (!settings.ok) throw Error(settings.error); if (!saved.ok) throw Error(saved.error); if (!selected.ok) throw Error(selected.error); if (!status.ok) throw Error(status.error);
        setSnapshot(settings.value); setLibrary(saved.value); setConversation(selected.value); setBotStatus(status.value); setError('');
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : 'This chat could not be opened.'); }
    };
    const offWindow = bridge.onChatWindowUpdate(state => { void accept(state); });
    const offSettings = bridge.onSettingsUpdate(setSnapshot);
    const offChat = subscribeChatUpdates(bridge, update);
    const offBot = bridge.onBotUpdate(setBotStatus);
    void bridge.chatWindow().then(result => { if (alive && result.ok) void accept(result.value); });
    return () => { alive = false; offWindow(); offSettings(); offChat(); offBot(); };
  }, [bridge, update]);
  const latestReply = conversation?.messages.filter(message => message.role === 'assistant').at(-1);
  const unread = library?.conversations.find(chat => chat.id === conversation?.id)?.unread;
  useEffect(() => {
    const markRead = () => {
      if (!conversation || !latestReply || latestReply.status === 'streaming' || !unread || !document.hasFocus() || document.hidden) return;
      const key = `${conversation.id}:${latestReply.id}`; if (readPending.current.has(key)) return;
      readPending.current.add(key);
      void bridge.markConversationRead(conversation.id, latestReply.id).then(result => {
        if (result.ok) setLibrary(previous => previous ? { ...previous, conversations: previous.conversations.map(chat => { const receipt = result.value.conversations.find(item => item.id === chat.id); return chat.id === conversation.id && receipt?.updatedAt === chat.updatedAt ? { ...chat, unread: receipt.unread } : chat; }) } : previous);
      }).catch(() => {}).finally(() => readPending.current.delete(key));
    };
    markRead(); window.addEventListener('focus', markRead); document.addEventListener('visibilitychange', markRead);
    return () => { window.removeEventListener('focus', markRead); document.removeEventListener('visibilitychange', markRead); };
  }, [bridge, conversation?.id, latestReply?.id, latestReply?.status, unread]);
  async function dock(input?: Parameters<typeof bridge.returnChat>[0]) {
    const result = await bridge.returnChat(input); if (!result.ok) setError(result.error);
  }
  const localSnapshot = snapshot && conversation ? { ...snapshot, settings: { ...snapshot.settings, mode: conversation.mode ?? 'chat' } } : snapshot;
  return <TooltipProvider><div className="desktop-shell floating-chat" data-platform={snapshot?.platform}>
    <header className="floating-chat-header">{conversation?.mode === 'bot' ? <div className="floating-chat-heading" ref={setBotHeaderTarget} /> : <span>{conversation?.title ?? 'TinyGPT'}</span>}
      <ControlTooltip label="Return chat to TinyGPT"><Button variant="ghost" size="icon" className="size-7 rounded-full" aria-label="Return chat to TinyGPT" onClick={() => void dock()}><Minus className="size-4" /></Button></ControlTooltip>
      <ControlTooltip label="Close pop-out"><Button variant="ghost" size="icon" className="size-7 rounded-full" aria-label="Close pop-out" onClick={() => void dock()}><X className="size-4" /></Button></ControlTooltip>
    </header>
    {error && <p role="alert" className="px-4 py-2 text-sm text-destructive">{error}</p>}
    {localSnapshot && library && conversation ? <Workbench compact botHeaderTarget={botHeaderTarget} key={conversation.id} snapshot={localSnapshot} conversation={conversation} library={library} bridge={bridge}
      bot={bot} changeBot={setBot} botStatus={botStatus} completeBot={async setup => { const result = await bridge.completeBot(setup); if (!result.ok) throw Error(result.error); setConversation(result.value); }}
      update={update} updateLibrary={setLibrary} updateSnapshot={setSnapshot} createConversation={async () => conversation}
      projectId={conversation.projectId} selectProject={id => { void bridge.organizeConversation({ id: conversation.id, action: 'move', projectId: id }).then(async result => { if (!result.ok) { setError(result.error); return; } setLibrary(result.value); const selected = await bridge.conversation(conversation.id); if (selected.ok) setConversation(selected.value); }); }}
      projectSelectionBusy={false} createProject={() => void dock()} openSettings={section => void dock({ settingsSection: section === 'General' || section === 'Bot' || section === 'Plugins' ? section : 'Configuration' })}
      workspacePanel={null} previewId={null} pageUrl={null} openPanel={async (panel, sourceId, url) => { if (panel) await dock({ workspace: { panel, ...(sourceId ? { sourceId } : {}), ...(url ? { url } : {}) } }); }}
      reportError={setError} searchOpen={false} closeSearch={() => {}} /> : <p role="status" className="m-auto px-6 text-sm text-muted-foreground">Opening chat…</p>}
  </div></TooltipProvider>;
}
