import { RemoteChatControl } from './components/RemoteChatDialog';
import { Onboarding } from './components/Onboarding';
import { REMOTE_APPEARANCE_KEYS } from '../shared/remote';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { subscribeChatUpdates } from './lib/chat-updates';
import { Bell, Blocks, Clock, ChevronDown, Library, Settings, SquarePen, PanelLeft, Search, PanelRight, ArrowLeft, ArrowRight, SquareArrowOutUpRight } from './icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { Scheduled } from './components/Scheduled';
import { SidebarBot } from './components/SidebarBot';
import { ActivityList } from './components/LibraryViews';
import { OutputsLibrary } from './components/OutputsLibrary';
import type { LibraryOutput } from '../shared/outputs';
import { SidebarProfile } from './components/SidebarProfile';
import { AppUpdate } from './components/AppUpdate';
import { SearchChatsDialog, ConversationEditDialog } from './components/LibraryDialogs';
import { ProjectDialog } from './components/ProjectDialog';
import { PluginLibrary } from './components/PluginLibrary';

import { Dialog } from './components/ui/dialog';
import { SidebarLibrary } from './components/SidebarLibrary';
import { ControlTooltip, TooltipProvider } from './components/ui/tooltip';
import { Button } from './components/ui/button';
import { ScrollArea } from './components/ui/scroll-area';
import { SettingsWorkspace } from './components/SettingsWorkspace';
import { WindowChrome } from './components/WindowChrome';
import { useDesktopPreferences, initials, appearanceVariables } from './lib/appearance';
import type { WindowState } from '../shared/contracts';
import { Workbench } from './components/Workbench';
import type { AppSnapshot } from '../shared/contracts';
import type { ChatUpdate, Conversation, ConversationSummary, ConversationOrganization, ProjectOrganization, LibrarySnapshot } from '../shared/chat';
import type { Mode } from '../shared/config';
import type { BotSnapshot, BotSetup } from '../shared/bot';
import type { ScheduledSnapshot } from '../shared/scheduled';
import { useNotifications, useNotificationView } from './lib/notifications';

type Panel = 'chat' | 'settings' | 'library' | 'plugins' | 'scheduled';
type View = { panel: Panel; conversationId: string | null; projectId: string | null; mode: Mode; section: string };
export function App() {
  const { appearance, setAppearance, profile, setProfile, bot, setBot } = useDesktopPreferences();
  useEffect(() => {
    const root = document.documentElement;
    const publish = () => {
      const computed = getComputedStyle(root);
      const variables = Object.fromEntries(REMOTE_APPEARANCE_KEYS.map(key => [key, computed.getPropertyValue(key).trim()])) as Record<typeof REMOTE_APPEARANCE_KEYS[number], string>;
      void window.tinygpt?.remoteAppearance({ bot, theme: root.dataset.theme === 'dark' ? 'dark' : 'light', variables, palettes: { light: appearanceVariables(appearance, 'light'), dark: appearanceVariables(appearance, 'dark') } }).catch(() => {});
    };
    publish(); const observer = new MutationObserver(publish); observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    return () => observer.disconnect();
  }, [appearance,bot]);
  const [windowState, setWindowState] = useState<WindowState>({ maximized: false, fullScreen: false });
  const [settingsSection, setSettingsSection] = useState('General');
  const [navigation, setNavigation] = useState<{ entries: View[]; index: number }>({ entries: [], index: -1 });
  const navigating = useRef<View | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [botStatus, setBotStatus] = useState<BotSnapshot>({ configured: false, conversationId: null, projectId: null, phase: 'idle' });
  const [library, setLibrary] = useState<LibrarySnapshot | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('chat');
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledSnapshot | null>(null);
  const [scheduledJobId, setScheduledJobId] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [customizingBot, setCustomizingBot] = useState(false);
  const [clearBotOpen, setClearBotOpen] = useState(false);
  const [clearingBot, setClearingBot] = useState(false);
  const [clearBotError, setClearBotError] = useState('');
  const [workspacePanel, setWorkspacePanel] = useState<'sources' | 'web' | 'files' | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [outputFile, setOutputFile] = useState<(LibraryOutput & { requestId: number }) | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => { try { const saved = Number(localStorage.getItem('tinygpt.sidebar.width')); return saved >= 210 && saved <= 360 ? saved : 264; } catch { return 264; } });
  const sidebarDrag = useRef<{ x: number; width: number } | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [editProjectId, setEditProjectId] = useState<string | null>(null);
  const [newProjectForComposer, setNewProjectForComposer] = useState(false);
  const [moveToNewProject, setMoveToNewProject] = useState<string | null>(null);
  const [chatEdit, setChatEdit] = useState<{ chat: ConversationSummary; action: 'rename' | 'delete' } | null>(null);
  useEffect(() => { try { localStorage.setItem('tinygpt.sidebar.width', String(sidebarWidth)); } catch { /* Resizing remains usable without storage. */ } }, [sidebarWidth]);
  const [chatSearch, setChatSearch] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [threadSession, setThreadSession] = useState(0);
  const [poppedId, setPoppedId] = useState<string | null>(null);
  const currentId = useRef<string | null>(null);
  const revision = useRef(0);
  const modeSelection = useRef<number | null>(null);
  const bridge = window.tinygpt;
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const unsubscribe = bridge.onScheduledUpdate(value => { if (alive) setScheduledTasks(value); });
    void bridge.scheduledSnapshot().then(result => { if (alive && result.ok) setScheduledTasks(result.value); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  const activity = useNotifications(bridge);
  const [notificationReady, setNotificationReady] = useState(false);
  const notificationOpen = useRef<(id: string) => void>(() => {});
  useNotificationView(bridge, panel === 'chat' && conversation?.id !== poppedId ? conversation?.id ?? null : null, notificationReady, activity.snapshot?.items[0]?.sequence ?? 0);
  useEffect(() => bridge?.onNotificationOpen(id => notificationOpen.current(id)), [bridge]);
  const readPending = useRef(new Set<string>());
  const visibleReply = conversation?.messages.filter(message => message.role === 'assistant').at(-1);
  const unread = library?.conversations.find(chat => chat.id === conversation?.id)?.unread;
  useEffect(() => {
    const markRead = () => {
      if (!bridge || panel !== 'chat' || !conversation || !unread || !visibleReply || visibleReply.status === 'streaming' || document.visibilityState !== 'visible' || !document.hasFocus() || !document.querySelector('.thread-message-column')?.getClientRects().length) return;
      const key = `${conversation.id}:${visibleReply.id}`;
      if (readPending.current.has(key)) return;
      readPending.current.add(key);
      void bridge.markConversationRead(conversation.id, visibleReply.id).then(result => {
        if (result.ok) setLibrary(previous => previous ? { ...previous, conversations: previous.conversations.map(chat => { const receipt = result.value.conversations.find(item => item.id === chat.id); return chat.id === conversation.id && receipt?.updatedAt === chat.updatedAt ? { ...chat, unread: receipt.unread } : chat; }) } : previous);
      }).catch(() => { /* Keep the unread indicator if saving the receipt fails. */ }).finally(() => readPending.current.delete(key));
    };
    markRead(); window.addEventListener('focus', markRead); document.addEventListener('visibilitychange', markRead);
    const pane = document.querySelector('.workbench-panes'); const visibility = new MutationObserver(markRead);
    if (panel === 'chat' && unread && pane) visibility.observe(pane, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    return () => { visibility.disconnect(); window.removeEventListener('focus', markRead); document.removeEventListener('visibilitychange', markRead); };
  }, [bridge, panel, conversation?.id, visibleReply?.id, visibleReply?.status, unread, snapshot?.settings.mode, workspacePanel]);
  const update = useCallback((value: ChatUpdate) => {
    setLibrary(value.library);
    if (currentId.current && !value.library.conversations.some(chat => chat.id === currentId.current)) { currentId.current = null; setConversation(null); setProjectId(null); return; }
    if (currentId.current === value.conversation.id) { setConversation(value.conversation); setProjectId(value.conversation.projectId); }
  }, []);
  useEffect(() => {
    if (!bridge) { setError('Open TinyGPT in the desktop app to use your connections and settings.'); return; }
    const unsubscribe = subscribeChatUpdates(bridge, update);
    const unsubscribeBot = bridge.onBotUpdate(setBotStatus);
    void (async () => {
      try {
        const [settings, saved, status, chatWindow] = await Promise.all([bridge.snapshot(), bridge.library(), bridge.botSnapshot(), bridge.chatWindow()]);
        if (!settings.ok) throw new Error(settings.error);
        if (!saved.ok) throw new Error(saved.error);
        setSnapshot(settings.value); setLibrary(saved.value);
        if (!status.ok) throw new Error(status.error); setBotStatus(status.value);
        if (chatWindow.ok) setPoppedId(chatWindow.value.conversationId);
        const initialId = chatWindow.ok && chatWindow.value.returnedConversationId || (settings.value.settings.mode === 'bot' ? status.value.configured ? status.value.conversationId : null : saved.value.lastConversationId);
        if (initialId) {
          const selected = await bridge.conversation(initialId);
          if (selected.ok) { currentId.current = selected.value.id; setConversation(selected.value); setProjectId(selected.value.projectId); if (chatWindow.ok && chatWindow.value.returnedConversationId) { const next = await bridge.saveSettings({ ...settings.value.settings, mode: selected.value.mode ?? 'chat' }); if (next.ok) setSnapshot(next.value); if (chatWindow.value.settingsSection) openSettings(chatWindow.value.settingsSection); if (chatWindow.value.workspace) { setWorkspacePanel(chatWindow.value.workspace.panel); setPreviewId(chatWindow.value.workspace.sourceId ?? null); setPageUrl(chatWindow.value.workspace.url ?? null); } await bridge.acknowledgeChatReturn(selected.value.id); } }
        }
      } catch { setError('TinyGPT could not load its settings or saved conversations.'); }
      finally { setNotificationReady(true); }
    })();
    return () => { unsubscribe(); unsubscribeBot(); };
  }, [bridge]);
  useEffect(() => {
    if (bridge && panel === 'chat' && snapshot?.settings.mode === 'bot' && botStatus.configured && botStatus.phase === 'idle') void bridge.prepareBot({ name: bot.name, projectId: botStatus.projectId }).then(result => { if (result.ok) setBotStatus(result.value); else setError(result.error); });
  }, [bridge, panel, snapshot?.settings.mode, botStatus.configured, botStatus.phase]);
  useEffect(() => {
    if (!snapshot || !library || modeSelection.current !== null) return;
    const view: View = { panel, conversationId: conversation?.id ?? null, projectId, mode: snapshot.settings.mode, section: panel === 'settings' ? settingsSection : '' };
    if (navigating.current) { if (JSON.stringify(view) === JSON.stringify(navigating.current)) navigating.current = null; else return; }
    setNavigation(previous => {
      if (JSON.stringify(previous.entries[previous.index]) === JSON.stringify(view)) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), view].slice(-100);
      return { entries, index: entries.length - 1 };
    });
  }, [panel, conversation?.id, projectId, snapshot?.settings.mode, !!library, settingsSection]);
  async function moveHistory(direction: number) {
    const index = navigation.index + direction; const target = navigation.entries[index];
    if (!target || busy) return;
    navigating.current = target; setBusy(true); setError('');
    try {
      // Restore the view without the normal saved-chat action switching modes.
      if (snapshot && snapshot.settings.mode !== target.mode) {
        const saved = await bridge!.saveSettings({ ...snapshot.settings, mode: target.mode });
        if (!saved.ok) throw new Error(saved.error); setSnapshot(saved.value);
      }
      if (target.conversationId) {
        const selected = await bridge!.conversation(target.conversationId);
        if (!selected.ok) throw new Error(selected.error);
        currentId.current = selected.value.id; setConversation(selected.value); setThreadSession(value => value + 1);
        setWorkspacePanel(null); setPreviewId(null); setPageUrl(null); setSearchOpen(false);
      } else clearConversation();
      setOutputFile(null); setProjectId(target.projectId); setPanel(target.panel); if (target.panel === 'settings') setSettingsSection(target.section);
      setNavigation(previous => ({ ...previous, index }));
    } catch (cause) { navigating.current = null; setError(cause instanceof Error ? cause.message : 'That view is no longer available.'); }
    finally { setBusy(false); }
  }
  function openSettings(section = 'General') { if (section === 'Plugins') { setPanel('plugins'); return; } setSettingsSection(section); setPanel('settings'); }
  function newProject(chatId?: string, forComposer = false) { setNewProjectForComposer(forComposer); setMoveToNewProject(chatId ?? null); setNewProjectOpen(true); }
  async function organizeProject(action: ProjectOrganization) {
    const result = await bridge!.organizeProject(action);
    if (!result.ok) throw Error(result.error);
    setLibrary(result.value);
    if (conversation?.projectId === action.id) {
      const refreshed = await bridge!.conversation(conversation.id);
      if (refreshed.ok) { setConversation(refreshed.value); setProjectId(refreshed.value.projectId); }
    } else if (projectId === action.id && action.action === 'remove') setProjectId(null);
    if (action.action === 'remove' && projectId === action.id) { setWorkspacePanel(null); setPreviewId(null); setOutputFile(null); }
  }
  async function openProjectWorkspace(id: string) {
    setBusy(true); setError('');
    try {
      const existing = library?.conversations.find(chat => chat.projectId === id && !chat.archived && chat.mode !== 'bot');
      if (existing) await selectConversation(existing.id);
      else {
        const created = await bridge!.createConversation(id); if (!created.ok) throw Error(created.error);
        await selectConversation(created.value.id);
      }
      setWorkspacePanel('files'); setPreviewId(null); setPageUrl(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The project workspace could not be opened.'); }
    finally { setBusy(false); }
  }
  async function organizeConversation(action: ConversationOrganization) {
    const result = await bridge!.organizeConversation(action);
    if (!result.ok) { setError(result.error); return; }
    setLibrary(result.value);
    if (action.id === currentId.current) { const selected = await bridge!.conversation(action.id); if (selected.ok) { setConversation(selected.value); setProjectId(selected.value.projectId); if (action.action === 'move') { setWorkspacePanel(null); setPreviewId(null); setPageUrl(null); } } }
  }
  async function selectComposerProject(id: string | null) {
    if (!bridge || !library || busy || library.activeRuns.some(run => run.conversationId === currentId.current)) return;
    setBusy(true); setError('');
    try {
      if (currentId.current) await organizeConversation({ id: currentId.current, action: 'move', projectId: id });
      else setProjectId(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Project could not be selected.'); }
    finally { setBusy(false); }
  }
  function clearConversation() { setOutputFile(null); revision.current++; currentId.current = null; setConversation(null); setThreadSession(value => value + 1); setWorkspacePanel(null); setPreviewId(null); setPageUrl(null); setSearchOpen(false); }
  function newChat(scope: string | null = null) { setProjectId(scope); clearConversation(); setPanel('chat'); if (snapshot && snapshot.settings.mode !== 'chat') void selectMode('chat'); }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.key === 'Escape') { setSearchOpen(false); setChatSearch(null); return; }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'b') { event.preventDefault(); setSidebarOpen(open => !open); }
      if (key === 'k') { event.preventDefault(); setChatSearch(''); }
      if (key === 'f' && panel === 'chat') { event.preventDefault(); setSearchOpen(true); }
      if (key === 'j') { event.preventDefault(); newChat(); }
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [panel, snapshot, bridge]);
  async function selectMode(mode: Mode) {
    if (!snapshot || !bridge) return;
    const selection = ++revision.current;
    modeSelection.current = selection;
    setBusy(true); setError('');
    try {
      let status: BotSnapshot | null = null;
      let selected: Conversation | null = null;
      if (mode === 'bot') {
        const saved = await bridge.botSnapshot(); if (!saved.ok) throw new Error(saved.error); status = saved.value;
        if (status.configured && status.conversationId) {
          const savedChat = await bridge.conversation(status.conversationId); if (!savedChat.ok) throw new Error(savedChat.error); selected = savedChat.value;
        }
      }
      if (revision.current !== selection) return;
      const result = await bridge.saveSettings({ ...snapshot.settings, mode });
      if (!result.ok) throw new Error(result.error);
      if (revision.current !== selection) return;
      setSnapshot(result.value); setPanel('chat');
      if (status) {
        setBotStatus(status); clearConversation(); setProjectId(status.projectId);
        if (selected) { currentId.current = selected.id; setConversation(selected); setProjectId(selected.projectId); }
      }
    } catch (error) { if (revision.current === selection) setError(error instanceof Error ? error.message : 'The mode could not be changed.'); }
    finally { if (modeSelection.current === selection) { modeSelection.current = null; setBusy(false); } }
  }
  async function selectConversation(id: string, output?: LibraryOutput) {
    if (!bridge) return;
    const revisiting = panel !== 'chat' || currentId.current !== id;
    setActivityOpen(false);
    const selection = ++revision.current;
    setError(''); setBusy(true);
    try {
      const result = await bridge.conversation(id);
      if (!result.ok) throw new Error(result.error);
      if (revision.current !== selection) return;
      currentId.current = id; setConversation(result.value); if (revisiting) setThreadSession(value => value + 1); setProjectId(result.value.projectId); setPanel('chat');
      setWorkspacePanel(null); setPreviewId(null); setPageUrl(null); setSearchOpen(false);
      setOutputFile(output ? { ...output, requestId: Date.now() } : null);
      if (output?.sourceId) {setWorkspacePanel('sources');setPreviewId(output.sourceId);setOutputFile(null);} else if (output) setWorkspacePanel('files');
      if (snapshot?.settings.mode !== (result.value.mode ?? 'chat')) await selectMode(result.value.mode ?? 'chat');
    } catch (error) { setError(error instanceof Error ? error.message : 'The chat could not be opened.'); }
    finally { setBusy(false); }
  }
  notificationOpen.current = id => { void selectConversation(id); };
  const createConversation = useCallback(async (): Promise<Conversation> => {
    const result = await bridge!.createConversation(projectId);
    if (!result.ok) throw new Error(result.error);
    currentId.current = result.value.id; setConversation(result.value); setPanel('chat');
    const saved = await bridge!.library();
    if (saved.ok) setLibrary(saved.value);
    return result.value;
  }, [bridge, projectId]);
  async function completeBot(setup: BotSetup) {
    const result = await bridge!.completeBot(setup); if (!result.ok) throw new Error(result.error);
    currentId.current = result.value.id; setConversation(result.value); setProjectId(result.value.projectId); setPanel('chat');
    setWorkspacePanel(null); setPreviewId(null); setPageUrl(null);
    const saved = await bridge!.library(); if (saved.ok) setLibrary(saved.value);
  }
  const openWorkspace = useCallback(async (value: 'sources' | 'web' | 'files' | null, sourceId?: string, url?: string) => {
    setWorkspacePanel(value); setPreviewId(sourceId ?? null); setPageUrl(url ?? null);
    try { if (value && !currentId.current) await createConversation(); }
    catch (error) { setWorkspacePanel(null); setError(error instanceof Error ? error.message : 'The workspace could not be opened.'); }
  }, [createConversation]);
  useEffect(() => {
    if (!bridge) return;
    const offSettings = bridge.onSettingsUpdate(value => setSnapshot(previous => modeSelection.current !== null && previous ? { ...value, settings: { ...value.settings, mode: previous.settings.mode } } : value));
    const offWindow = bridge.onChatWindowUpdate(state => {
      setPoppedId(state.conversationId);
      if (state.returnedConversationId) void selectConversation(state.returnedConversationId).then(() => {
        if (state.settingsSection) openSettings(state.settingsSection);
        if (state.workspace) void openWorkspace(state.workspace.panel, state.workspace.sourceId, state.workspace.url);
        void bridge.acknowledgeChatReturn(state.returnedConversationId!);
      });
    });
    return () => { offSettings(); offWindow(); };
  }, [bridge, snapshot?.settings.mode, openWorkspace]);
  async function popOutChat() {
    setError('');
    try {
      const draft = document.querySelector<HTMLTextAreaElement>('.composer [aria-label="Message"]')?.value ?? '';
      const current = conversation ?? await createConversation();
      if (draft) localStorage.setItem(`tinygpt-chat-draft:${current.id}`, draft);
      const result = await bridge!.popOutChat(current.id); if (!result.ok) throw Error(result.error);
      setPoppedId(result.value.conversationId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This chat could not be popped out.'); }
  }
  useEffect(() => {
    if (!bridge) return;
    return bridge.onWorkspaceBrowserFocus(({ conversationId }) => {
      // Background tasks may reveal their own tabs without taking the user away
      // from the conversation they are currently reading or composing in.
      if (currentId.current !== conversationId) return;
      void (async () => { if (currentId.current !== conversationId) await selectConversation(conversationId); setWorkspacePanel('web'); setPreviewId(null); setPageUrl(null); setPanel('chat'); })();
    });
  }, [bridge, snapshot?.settings.mode]);
  if (!snapshot || !library || !bridge) return <div className="desktop-shell" data-maximized={windowState.maximized || windowState.fullScreen}>{bridge && <WindowChrome bridge={bridge} platform={snapshot?.platform ?? (navigator.userAgent.includes('Macintosh') ? 'darwin' : 'win32')} changed={setWindowState} reportError={setError} />}<div className="window-drag loading-window-drag" /><p role={error ? 'alert' : 'status'} className="m-auto max-w-md p-10 text-center text-sm text-muted-foreground">{error || 'Opening TinyGPT…'}</p></div>;
  const routeTitle = { portal: 'TinyGPT Portal', byok: 'Your API key', local: 'Local model' }[snapshot.settings.route];
  const editingProject = library.projects.find(item => item.id === editProjectId);
  const sidebarBotAction = botStatus.snoozed ? 'snooze' : library.approvals.some(item => item.conversationId === botStatus.conversationId) ? 'blocked' : library.activeRuns.some(run => run.conversationId === botStatus.conversationId) ? 'waiting' : botStatus.phase === 'error' ? 'error' : 'idle';
  const botUnreadCount = snapshot.settings.notifications.badges && botStatus.conversationId ? activity.snapshot?.unreadCounts?.[botStatus.conversationId] ?? 0 : 0;
  const newChatActive = panel === 'chat' && snapshot.settings.mode !== 'bot' && !conversation;
  if (snapshot.onboarding?.status === 'in-progress') return <div className="desktop-shell" data-platform={snapshot.platform} data-maximized={windowState.maximized || windowState.fullScreen}>
    <WindowChrome bridge={bridge} platform={snapshot.platform} changed={setWindowState} reportError={setError} />
    <Onboarding snapshot={snapshot} bridge={bridge} update={setSnapshot} profile={profile} changeProfile={setProfile} done={prompt => {
      if (prompt) { sessionStorage.setItem('tinygpt-plugin-prompt', prompt); newChat(); }
      else setPanel('chat');
    }} />
  </div>;
  return <TooltipProvider><div className="desktop-shell" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties} data-platform={snapshot.platform} data-maximized={windowState.maximized || windowState.fullScreen}>
    <WindowChrome bridge={bridge} platform={snapshot.platform} changed={setWindowState} reportError={setError} />
    {panel === 'settings' ? <SettingsWorkspace pluginContext={{ conversationId: conversation?.id ?? null, projectId }} snapshot={snapshot} library={library} bridge={bridge} update={setSnapshot} updateLibrary={setLibrary} close={() => setPanel('chat')} section={settingsSection} select={setSettingsSection} appearance={appearance} changeAppearance={setAppearance} profile={profile} changeProfile={setProfile} /> : <>
    <TooltipProvider><aside className="tiny-sidebar" style={{ width: sidebarOpen ? sidebarWidth : 62, flexBasis: sidebarOpen ? sidebarWidth : 62 }} data-collapsed={!sidebarOpen}>
      {sidebarOpen && <div className="sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={210} aria-valuemax={360} aria-valuenow={sidebarWidth} tabIndex={0} onPointerDown={event => { sidebarDrag.current = { x: event.clientX, width: sidebarWidth }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (sidebarDrag.current) setSidebarWidth(Math.max(210, Math.min(360, sidebarDrag.current.width + event.clientX - sidebarDrag.current.x))); }} onPointerUp={event => { sidebarDrag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { sidebarDrag.current = null; }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setSidebarWidth(value => Math.max(210, Math.min(360, value + (event.key === 'ArrowRight' ? 12 : -12)))); } }} />}
      <div className="tiny-sidebar-toolbar window-drag"><div className="sidebar-history-controls"><ControlTooltip label="Back"><Button variant="ghost" size="icon" className="tiny-sidebar-chrome" aria-label="Back" disabled={busy || navigation.index <= 0} onClick={() => void moveHistory(-1)}><ArrowLeft /></Button></ControlTooltip><ControlTooltip label="Forward"><Button variant="ghost" size="icon" className="tiny-sidebar-chrome" aria-label="Forward" disabled={busy || navigation.index >= navigation.entries.length - 1} onClick={() => void moveHistory(1)}><ArrowRight /></Button></ControlTooltip></div><ControlTooltip label={`${sidebarOpen ? 'Collapse' : 'Expand'} sidebar`}><Button variant="ghost" size="icon" className="tiny-sidebar-chrome" aria-label={`${sidebarOpen ? 'Collapse' : 'Expand'} sidebar`} onClick={() => setSidebarOpen(!sidebarOpen)}><PanelLeft /></Button></ControlTooltip></div>
      <div className="tiny-sidebar-header"><span className="tiny-sidebar-brand">TinyGPT</span><div className="sidebar-header-actions"><Popover open={activityOpen} onOpenChange={setActivityOpen}><ControlTooltip label="Activity"><PopoverTrigger asChild><Button variant="ghost" size="icon" className="tiny-sidebar-chrome sidebar-activity" aria-label="View activity"><Bell />{snapshot.settings.notifications.badges && !!activity.snapshot?.unreadCount && <i className="activity-indicator" aria-label="Unread activity" />}</Button></PopoverTrigger></ControlTooltip><PopoverContent side={sidebarOpen ? 'bottom' : 'right'} align="start" className="sidebar-activity-popover" aria-label="Activity"><ActivityList library={library} select={id => void selectConversation(id)} notifications={activity.snapshot} action={activity.action} settings={() => openSettings('Notifications')} badges={snapshot.settings.notifications.badges} error={activity.error} /></PopoverContent></Popover><ControlTooltip label="Search chats"><Button variant="ghost" size="icon" className="tiny-sidebar-chrome sidebar-search" aria-label="Search chats" onClick={() => setChatSearch('')}><Search /></Button></ControlTooltip></div></div>
      <ControlTooltip label={`New chat (${snapshot.platform === 'darwin' ? '⌘ J' : 'Ctrl J'})`}><Button variant="ghost" className={`sidebar-entry sidebar-nav-action ${newChatActive ? 'is-active' : ''}`} aria-label="New chat" aria-pressed={newChatActive} disabled={busy} onClick={() => newChat()}><SquarePen /><span className="sidebar-action-label">New chat</span></Button></ControlTooltip>
      <SidebarBot snoozed={!!botStatus.snoozed} snooze={() => void bridge.setBotSnoozed(!botStatus.snoozed).then(result => { if (!result.ok) setError(result.error); }, () => setError('Your bot could not change its sleep status.'))} design={bot} active={snapshot.settings.mode === 'bot' && panel === 'chat'} busy={busy || clearingBot} running={library.activeRuns.some(run => run.conversationId === botStatus.conversationId)} action={sidebarBotAction} configured={botStatus.configured} unreadCount={botUnreadCount} select={() => void selectMode('bot')} settings={() => openSettings('Bot')} customize={() => void selectMode('bot').then(() => setCustomizingBot(true))} clear={() => { setClearBotError(''); setClearBotOpen(true); }} stop={() => { if (botStatus.conversationId) void bridge.cancelMessage(botStatus.conversationId).then(result => { if (result.ok) update(result.value); else setError(result.error); }); }} />
      <ControlTooltip label="Library"><Button variant="ghost" className={`sidebar-entry sidebar-nav-action ${panel === 'library' ? 'is-active' : ''}`} aria-label="Library" aria-pressed={panel === 'library'} onClick={() => setPanel('library')}><Library /><span className="sidebar-action-label">Library</span></Button></ControlTooltip>
      <ControlTooltip label="Plugins"><Button variant="ghost" className={`sidebar-entry sidebar-nav-action ${panel === 'plugins' ? 'is-active' : ''}`} aria-label="Plugins library" onClick={() => setPanel('plugins')}><Blocks /><span className="sidebar-action-label">Plugins</span></Button></ControlTooltip>
      <ControlTooltip label="Scheduled"><Button variant="ghost" className={`sidebar-entry sidebar-nav-action ${panel === 'scheduled' ? 'is-active' : ''}`} aria-label="Scheduled" aria-pressed={panel === 'scheduled'} onClick={() => setPanel('scheduled')}><Clock /><span className="sidebar-action-label">Scheduled</span></Button></ControlTooltip>
      {sidebarOpen && panel === 'scheduled' && !!scheduledTasks?.jobs.length && <nav className="sidebar-scheduled-tasks" aria-label="Scheduled tasks">{scheduledTasks.jobs.map(job => <Button key={job.id} variant="ghost" className="sidebar-entry sidebar-chat-row is-nested" title={job.title} onClick={() => setScheduledJobId(job.id)}><span className="truncate">{job.title}</span></Button>)}</nav>}
      <div className="tiny-sidebar-library" hidden={!sidebarOpen}><SidebarLibrary bridge={bridge} library={{ ...library, conversations: library.conversations.filter(chat => chat.mode !== 'bot').map(chat => ({ ...chat, unread: snapshot.settings.notifications.badges && (activity.snapshot ? activity.snapshot.unreadConversationIds.includes(chat.id) : !!chat.unread) })) }} conversationId={panel === 'chat' ? conversation?.id : undefined} projectId={projectId} query={null} busy={busy} selectConversation={id => void selectConversation(id)} newChat={newChat} newProject={newProject} organize={action => void organizeConversation(action)} edit={(chat, action) => setChatEdit({ chat, action })} projectSettings={setEditProjectId} openProject={id => void openProjectWorkspace(id)} organizeProject={action => void organizeProject(action).catch(cause => setError(cause instanceof Error ? cause.message : 'The project could not be updated.'))} /></div>
      <AppUpdate bridge={bridge} />
      <div className="tiny-sidebar-footer"><SidebarProfile profile={profile} bridge={bridge} openSettings={openSettings} reportError={setError} /><ControlTooltip label="Settings"><Button variant="ghost" size="icon" className="tiny-sidebar-settings" aria-label="Settings" onClick={() => openSettings()} disabled={busy}><Settings /></Button></ControlTooltip></div>
    </aside></TooltipProvider>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="conversation-header window-drag" aria-label="Conversation header" onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button')) void bridge.windowControl('maximize'); }}>
        <div className="flex min-w-0 items-center gap-2">{panel === 'chat' && snapshot.settings.mode !== 'bot' && conversation && <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="conversation-title-trigger" aria-label={`Switch conversation: ${conversation?.title ?? 'New chat'}`} disabled={busy}><span>{conversation?.title ?? 'New chat'}</span><ChevronDown aria-hidden="true" /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="conversation-switcher" aria-label="Conversations"><ScrollArea type="auto" viewportClassName="conversation-switcher-viewport" viewportTabIndex={-1}><DropdownMenuRadioGroup value={conversation?.id ?? ''} onValueChange={id => void selectConversation(id)}>{library.conversations.map(chat => <DropdownMenuRadioItem key={chat.id} value={chat.id}><span className="conversation-switcher-label"><span>{chat.title}</span>{(chat.projectId || chat.archived) && <small>{[library.projects.find(item => item.id === chat.projectId)?.name, chat.archived ? 'Archived' : null].filter(Boolean).join(' · ')}</small>}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>{!library.conversations.length && <p className="composer-menu-note">Your conversations will appear here.</p>}</ScrollArea></DropdownMenuContent></DropdownMenu>}</div>
        <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">{panel === 'chat' && conversation && (!conversation.mode || conversation.mode === 'chat') && <RemoteChatControl bridge={bridge} conversationId={conversation.id} />}{panel === 'chat' && <ControlTooltip label="Pop out chat"><Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Pop out chat" disabled={busy || conversation?.id === poppedId && !!poppedId || snapshot.settings.mode === 'bot' && !botStatus.configured} onClick={() => void popOutChat()}><SquareArrowOutUpRight className="size-4" /></Button></ControlTooltip>}{panel === 'chat' && <ControlTooltip label="Show workspace"><Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Show workspace" aria-pressed={!!workspacePanel} onClick={() => void openWorkspace(workspacePanel ? null : 'web')}><PanelRight className="size-4" /></Button></ControlTooltip>}</div>
      </header>
      <div className="conversation-area">
      {error && <p role="alert" className="px-8 pt-4 text-sm text-destructive">{error}</p>}

      {panel === 'library' ? <OutputsLibrary close={() => setPanel('chat')} bridge={bridge} library={library} open={output => void selectConversation(output.conversationId, output)} /> : panel === 'scheduled' ? <Scheduled bridge={bridge} openConversation={id => void selectConversation(id)} focusJobId={scheduledJobId} jobFocused={() => setScheduledJobId(null)} /> : panel === 'plugins' ? <div className="conversation-pane flex min-h-0 flex-1 flex-col"><PluginLibrary bridge={bridge} library={library} context={{ conversationId: conversation?.id ?? null, projectId, mode: snapshot.settings.mode }} close={() => setPanel('chat')} /></div> : <Workbench customizeBot={customizingBot} onBotCustomizationClose={() => setCustomizingBot(false)} conversationPlaceholder={conversation && conversation.id === poppedId ? <div className="conversation-pane chat-popped-placeholder"><SquareArrowOutUpRight className="size-6" /><p>This chat is in its own window.</p><Button variant="pill" size="action" onClick={() => void bridge.returnChat().then(result => { if (!result.ok) setError(result.error); })}>Return chat here</Button></div> : null} bot={bot} changeBot={setBot} botStatus={botStatus} completeBot={completeBot} key={(snapshot.settings.mode === 'bot' ? 'bot' : 'conversation') + ':' + threadSession} snapshot={snapshot} conversation={conversation} library={library} bridge={bridge} update={update} updateLibrary={setLibrary} updateSnapshot={setSnapshot} createConversation={createConversation} projectId={projectId} selectProject={id => void selectComposerProject(id)} projectSelectionBusy={busy} createProject={() => newProject(undefined, true)} openSettings={section => openSettings(section ?? 'Configuration')} workspacePanel={workspacePanel} previewId={previewId} pageUrl={pageUrl} initialFile={outputFile?.conversationId === conversation?.id ? outputFile : null} openPanel={openWorkspace} reportError={setError} searchOpen={searchOpen} closeSearch={() => setSearchOpen(false)} />}
      </div>
    </main></>}
    <Dialog open={clearBotOpen} change={open => { if (!clearingBot) setClearBotOpen(open); }} title="Clear bot conversation?" description="Start a fresh conversation with your bot. Messages will be cleared. Your bot’s memory, settings, and files are kept.">
      {clearBotError && <p role="alert" className="text-sm text-destructive">{clearBotError}</p>}
      <div className="dialog-actions"><Button variant="ghost" disabled={clearingBot} onClick={() => setClearBotOpen(false)}>Cancel</Button><Button variant="destructive" disabled={clearingBot} onClick={() => void (async () => { setClearingBot(true); setClearBotError(''); try { const result = await bridge.clearBotConversation(); if (!result.ok) throw Error(result.error); update(result.value); setClearBotOpen(false); setCustomizingBot(false); if (currentId.current === result.value.conversation.id) setThreadSession(value => value + 1); } catch (error) { setClearBotError(error instanceof Error ? error.message : 'Your conversation could not be cleared.'); } finally { setClearingBot(false); } })()}>{clearingBot ? 'Clearing…' : 'Clear conversation'}</Button></div>
    </Dialog>
    {chatSearch !== null && <SearchChatsDialog library={library} close={() => setChatSearch(null)} select={id => void selectConversation(id)} newChat={() => newChat()} newProject={() => newProject()} settings={() => openSettings()} platform={snapshot.platform} />}
    {newProjectOpen && <ProjectDialog bridge={bridge} close={() => { setNewProjectOpen(false); setMoveToNewProject(null); setNewProjectForComposer(false); }} saved={async (saved, id) => { setLibrary(saved); if (newProjectForComposer) { if (currentId.current) { const moved = await bridge.organizeConversation({ id: currentId.current, action: 'move', projectId: id }); if (!moved.ok) throw new Error(`Project created, but the chat could not be moved: ${moved.error}`); setLibrary(moved.value); const selected = await bridge.conversation(currentId.current); if (!selected.ok) throw new Error(selected.error); setConversation(selected.value); } setProjectId(id); } else if (moveToNewProject) { const moved = await bridge.organizeConversation({ id: moveToNewProject, action: 'move', projectId: id }); if (!moved.ok) throw new Error(`Project created, but the chat could not be moved: ${moved.error}`); setLibrary(moved.value); await selectConversation(moveToNewProject); } else { setProjectId(id); clearConversation(); setPanel('chat'); } }} />}
    {editingProject && <ProjectDialog key={editingProject.id} bridge={bridge} project={editingProject} close={() => setEditProjectId(null)} saved={async saved => { setLibrary(saved); const id = currentId.current; if (id && conversation?.projectId === editingProject.id) { const refreshed = await bridge.conversation(id); if (refreshed.ok && currentId.current === id) setConversation(refreshed.value); } }} remove={() => organizeProject({ id: editingProject.id, action: 'remove' })} />}
    {chatEdit && <ConversationEditDialog chat={chatEdit.chat} action={chatEdit.action} close={() => setChatEdit(null)} save={async title => { const result = chatEdit.action === 'rename' ? await bridge.renameConversation(chatEdit.chat.id, title) : await bridge.deleteConversation(chatEdit.chat.id); if (!result.ok) throw new Error(result.error); setLibrary(result.value); if (chatEdit.chat.id === currentId.current) { if (chatEdit.action === 'delete') clearConversation(); else setConversation(value => value ? { ...value, title: title.trim() } : value); } }} />}
  </div></TooltipProvider>;
}
