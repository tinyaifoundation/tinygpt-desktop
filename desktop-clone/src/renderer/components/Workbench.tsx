import { visibleMessageGraph } from '../lib/message-graph';
import { useMessages } from '../lib/conversation-messages';
import { WindowedMessages } from './WindowedMessages';
import { chatUIConfig } from './ChatGenerativeUI';
import { ComposerExtras } from './ComposerExtras';
import { ComposerAddMenu, ComposerAttachments, ComposerReferences, useComposerPlugins } from './ComposerContext';
import { isComposerSource } from '../../shared/tools';
import { ReadAloudProvider } from './ReadAloud';
import { ToolIconProvider } from '../tool-icons';
import { DictationButton } from './DictationButton';
import { ComposerInput } from './ComposerInput';
import { SkillPicker } from './SkillPicker';
import { RequestQueue } from './RequestQueue';
import { ApprovalSelector } from './ApprovalSelector';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AssistantRuntimeProvider, ComposerPrimitive, ExportedMessageRepository, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage, type ExportedMessageRepositoryItem, type ThreadMessageLike } from '@assistant-ui/react';
import { ArrowUp, Square, X, Plus, ChevronDown, ChevronUp, Search } from '../icons';
import { BotSetup } from './BotSetup';
import { RobotAvatar } from './RobotAvatar';
import { BotCompanionPanel } from './BotCompanionPanel';
import { createPortal } from 'react-dom';
import type { BotSnapshot, BotSetup as Setup } from '../../shared/bot';
import type { BotDesign } from '../lib/bot';
import { inferenceIssue } from '../../core/readiness';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { ChatUpdate, Conversation, LibrarySnapshot, QueueAction, QueuedRequest } from '../../shared/chat';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Popover, PopoverAnchor, PopoverTrigger } from './ui/popover';
import { Workspace } from './Workspace';
import { BotUserMessage, BotAssistantMessage } from './BotMessages';
import { AssistantMessage, ConversationActions, UserMessage } from './ConversationMessages';
import { ConversationMap } from './ConversationMap';
import { WorkQuestionCard } from './WorkQuestionCard';
import { ToolApprovals } from './ToolApprovals';
import { AnswerImagesProvider } from './AnswerImage';
import { AgentBrowserPreview } from './AgentBrowserPreview';
import { ScrollAnchor } from './ConversationElements';
import { ControlTooltip, TooltipProvider } from './ui/tooltip';
import type { CreatedFile } from '../../core/created-files';
import { useReplyTrace } from '../lib/reply-trace';
import { hasStartedAnswer } from '../../core/answer-visibility';
import { ComposerEffortPicker, useComposerInference } from './InferenceControls';

const messageComponents = { UserMessage, AssistantMessage };
const botMessageComponents = { UserMessage: BotUserMessage, AssistantMessage: BotAssistantMessage };
const convertMessage = (message: ThreadMessageLike) => message;
const noMatches: string[] = [];
type QueueChange = QueueAction extends infer Action ? Action extends QueueAction ? Omit<Action, 'conversationId'> : never : never;

// IPC snapshots have new identities. Keep earlier messages stable while streaming.

export function Workbench({ compact = false, conversationPlaceholder, botHeaderTarget, customizeBot = false, onBotCustomizationClose, bot, changeBot, botStatus, completeBot, snapshot, conversation, library, bridge, update, updateLibrary, updateSnapshot, createConversation, projectId, selectProject, projectSelectionBusy, createProject, openSettings, workspacePanel, previewId, pageUrl, initialFile, openPanel, reportError, searchOpen, closeSearch }: {
  compact?: boolean;
  customizeBot?: boolean; onBotCustomizationClose?: () => void;
  conversationPlaceholder?: ReactNode;
  botHeaderTarget?: HTMLElement | null;
  bot: BotDesign; changeBot: (value: BotDesign) => void;
  botStatus: BotSnapshot; completeBot: (setup: Setup) => Promise<void>;
  snapshot: AppSnapshot; conversation: Conversation | null; library: LibrarySnapshot; bridge: DesktopBridge;
  update: (update: ChatUpdate) => void; updateLibrary: (value: LibrarySnapshot) => void; updateSnapshot: (value: AppSnapshot) => void; createConversation: () => Promise<Conversation>; openSettings: (section?: string) => void;
  workspacePanel: 'sources' | 'web' | 'files' | null; previewId: string | null; pageUrl: string | null; openPanel: (value: 'sources' | 'web' | 'files' | null, sourceId?: string, url?: string) => Promise<void>; reportError: (value: string) => void;
  searchOpen: boolean; closeSearch: () => void;
  initialFile?: (CreatedFile & { requestId: number; conversationId: string }) | null;
  projectId: string | null; selectProject: (id: string | null) => void; projectSelectionBusy: boolean; createProject: () => void;
}) {
  const poppedOut = !!conversationPlaceholder;
  const [error, setError] = useState('');
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [requestedFile, setRequestedFile] = useState<(CreatedFile & { requestId: number; conversationId: string }) | null>(initialFile ?? null);
  const [starting, setStarting] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const [mapActive, setMapActive] = useState('');
  const [editingBot, setEditingBot] = useState(customizeBot);
  useEffect(() => { if (customizeBot) setEditingBot(true); }, [customizeBot]);
  function closeBotCustomization() { setEditingBot(false); onBotCustomizationClose?.(); }
  const [typing, setTyping] = useState(false);
  const [visit, setVisit] = useState({ conversationId: conversation?.id ?? null, prompted: false });
  if (visit.conversationId !== (conversation?.id ?? null)) {
    // Creating a saved chat from this visit's first prompt is not a revisit.
    setVisit({ conversationId: conversation?.id ?? null, prompted: visit.conversationId === null && visit.prompted });
  }
  const root = useRef<HTMLDivElement>(null);
  const [wideBot, setWideBot] = useState(false);
  useEffect(() => {
    const node = root.current; if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWideBot(entry.contentRect.width >= 1040));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  useReplyTrace(bridge, conversation, library, root);
  const searchInput = useRef<HTMLInputElement>(null);
  const activeMode = conversation?.messages.length ? conversation.mode ?? 'chat' : snapshot.settings.mode;
  const isBot = snapshot.settings.mode === 'bot';
  const isChat = activeMode !== 'code';
  const inference = useComposerInference(snapshot, bridge, updateSnapshot, reportError);
  const composerPlugins = useComposerPlugins(bridge, conversation?.id ?? null, projectId, activeMode, reportError);
  const [dictating, setDictating] = useState(false);
  const hasComposer = !isBot || !!(botStatus.configured && conversation?.mode === 'bot' && !editingBot);
  const botConversationLoading = isBot && botStatus.configured && !editingBot && !hasComposer;
  const activeRun = library.activeRuns.find(run => run.conversationId === conversation?.id);
  const running = starting || !!activeRun;
  const awaitingPermission = library.approvals.some(approval => approval.conversationId === conversation?.id);
  const pendingQuestions = (library.workQuestions ?? []).filter(question => question.conversationId === conversation?.id);
  const awaitingAction = pendingQuestions.length > 0 || awaitingPermission || library.browserHandoffs.some(handoff => handoff.conversationId === conversation?.id);
  useEffect(() => { if (awaitingAction) setAddOpen(false); }, [awaitingAction]);
  const botActivity = botStatus.snoozed || awaitingPermission ? undefined : running ? activeRun?.phase === 'answer' ? 'writing' : activeRun?.phase === 'tool' || activeRun?.phase === 'tool-input' ? 'reviewing' : 'working' : botStatus.phase === 'preparing' ? 'working' : undefined;
  const botAction = botStatus.snoozed ? 'snooze' : awaitingPermission ? 'blocked' : botActivity === 'writing' ? 'input' : botActivity === 'reviewing' ? 'inspect' : botActivity === 'working' ? 'waiting' : conversation?.messages.at(-1)?.status === 'error' || botStatus.phase === 'error' ? 'error' : typing ? 'input' : 'idle';
  const issue = inferenceIssue(snapshot.settings, snapshot.secrets) ?? (activeMode === 'code' && !snapshot.settings[snapshot.settings.route as 'byok' | 'local']?.tools ? 'Enable tool calling for this connection in Settings before using Work.' : null);
  const queuedRequests = conversation?.queuedRequests ?? [];
  const reservedAttachments = new Set(queuedRequests.flatMap(item => item.attachmentIds));
  const drafts = conversation?.sources.filter(source => source.conversationId === conversation.id && !source.messageId && isComposerSource(source) && !reservedAttachments.has(source.id)) ?? [];
  const hasContext = !!drafts.length || !!composerPlugins.references.length;
  const hasReferences = drafts.some(source => source.kind === 'conversation') || !!composerPlugins.references.length;
  const graph = useMemo(() => conversation ? { ...conversation, messages: conversation.allMessages ?? conversation.messages } : null, [conversation]);
  const messages = useMessages(graph, activeRun);
  const normalized = useRef(new WeakMap<ThreadMessageLike, ExportedMessageRepositoryItem['message']>());
  const visibleGraph = useMemo(() => visibleMessageGraph(graph?.messages ?? [], messages.map(message => message.id!), conversation?.headId ?? conversation?.messages.at(-1)?.id ?? null), [graph, messages, conversation?.headId]);
  const repository = useMemo(() => ({
    headId: visibleGraph.headId,
    messages: messages.map(message => {
      const parentId = visibleGraph.parents.get(message.id!) ?? null;
      let value = normalized.current.get(message);
      if (!value) { value = ExportedMessageRepository.fromBranchableArray([{ message, parentId }]).messages[0].message; normalized.current.set(message, value); }
      return { message: value, parentId };
    }),
  }), [messages, visibleGraph]);
  const empty = !messages.length;
  const matches = useMemo(() => !searchOpen || !query.trim() ? noMatches : (conversation?.messages ?? []).filter(message => `${message.text}\n${message.reasoning ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(message => message.id), [conversation?.messages, query, searchOpen]);
  const selectedMatch = matches[matchIndex % (matches.length || 1)] ?? '';
  const turns = conversation?.messages.filter(message => message.role === 'user') ?? [];
  const turnIds = turns.map(turn => turn.id).join(',');
  const mapEntries = useMemo(() => (conversation?.messages ?? []).flatMap((message, index, list) => message.role === 'user' ? [{ id: message.id, title: message.text, preview: list[index + 1]?.role === 'assistant' ? list[index + 1].text.slice(0, 300).replace(/[#*_`]/g, '') : '' }] : []), [conversation?.messages]);
  function jump(id: string) { window.dispatchEvent(new CustomEvent('tinygpt-message-jump', { detail: id })); setMapActive(id); }
  useEffect(() => {
    if (!empty || !hasComposer) return;
    const policy = document.documentElement.dataset.motion;
    if (policy === 'reduce' || policy !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Animate the existing elements so switching modes preserves the draft and focus.
    const greeting = root.current?.querySelector('.conversation-greeting');
    const composer = root.current?.querySelector('.composer-footer');
    const easing = 'cubic-bezier(.18,.75,.28,1)';
    const animations = [
      greeting?.animate([{ opacity: 0, translate: '0 10px', filter: 'blur(2px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }], { duration: 340, easing }),
      composer?.animate([{ opacity: 0, translate: '0 7px', scale: '.985' }, { opacity: 1, translate: '0 0', scale: '1' }], { duration: 380, delay: 55, easing, fill: 'backwards' }),
    ];
    return () => animations.forEach(animation => animation?.cancel());
  }, [activeMode, empty, hasComposer]);
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  useEffect(() => { if (selectedMatch) window.dispatchEvent(new CustomEvent('tinygpt-message-jump', { detail: selectedMatch })); }, [selectedMatch]);
  useEffect(() => {
    const viewport = root.current?.querySelector('.thread-viewport');
    if (!viewport || empty) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const anchor = viewport.getBoundingClientRect().top + 80;
      let id = turns[0]?.id;
      for (const turn of turns) {
        const element = viewport.querySelector(`[data-message-id="${turn.id}"]`);
        if (element && element.getBoundingClientRect().top <= anchor) id = turn.id;
      }
      if (id) setMapActive(id);
    };
    const scroll = () => { if (!frame) frame = requestAnimationFrame(sync); };
    scroll(); viewport.addEventListener('scroll', scroll, { passive: true });
    return () => { viewport.removeEventListener('scroll', scroll); if (frame) cancelAnimationFrame(frame); };
  }, [conversation?.id, turnIds, empty]);
  const act = useCallback(async (operation: () => Promise<void>) => {
    setError(''); setStarting(true);
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : 'The message could not be sent.'); }
    finally { setStarting(false); }
  }, []);
  async function queueAction(action: QueueChange): Promise<boolean> {
    if (!conversation) return false;
    setContextBusy(true); setError('');
    try { const result = await bridge.queueRequest({ ...action, conversationId: conversation.id } as QueueAction); if (!result.ok) throw new Error(result.error); update(result.value); return true; }
    catch (error) { setError(error instanceof Error ? error.message : 'The queue could not be updated.'); return false; }
    finally { setContextBusy(false); }
  }
  const [botReceived, setBotReceived] = useState(0);
  useEffect(() => { if (!botReceived) return; const timer = setTimeout(() => setBotReceived(0), 1100); return () => clearTimeout(timer); }, [botReceived]);
  async function sendNew(message: AppendMessage, steer = false) {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    setVisit(previous => ({ ...previous, prompted: true }));
    setTyping(false); setError(''); setStarting(true); if (isBot) setBotReceived(Date.now());
    try {
      const current = conversation ?? await createConversation();
      const result = await bridge.sendMessage(current.id, text, drafts.map(source => source.id));
      if (!result.ok) throw new Error(result.error);
      update(result.value);
      if (steer) {
        const item = result.value.conversation.queuedRequests?.at(-1);
        if (item) { const steered = await bridge.queueRequest({ conversationId: current.id, action: 'steer', id: item.id }); if (!steered.ok) { setError(steered.error); return; } update(steered.value); }
      }
    } catch (error) { runtime.thread.composer.setText(text); setTyping(!!text.trim()); setError(error instanceof Error ? error.message : 'The message could not be sent.'); }
    finally { setStarting(false); }
  }
  const queueItems = (lane: QueuedRequest['lane']) => queuedRequests.filter(item => item.lane === lane).map(item => ({ id: item.id, prompt: item.text, parts: [{ type: 'text' as const, text: item.text }] }));
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    queue: isBot ? undefined : {
      items: queueItems('queue'), steerItems: queueItems('steer'),
      enqueue: message => { void sendNew(message); },
      // The runtime defaults mid-run appends to steer; plain Enter stays queued.
      steer: message => { void sendNew(message, message.steer === true); },
      remove: id => { void queueAction({ action: 'remove', id }); },
      edit: (id, message) => { void queueAction({ action: 'edit', id, replacement: { text: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'), attachmentIds: queuedRequests.find(item => item.id === id)?.attachmentIds ?? [] } }); },
      move: (id, placement) => {
        if (placement.lane === 'steer') { void queueAction({ action: 'steer', id }); return; }
        const ids = queuedRequests.map(item => item.id).filter(value => value !== id);
        const at = placement.insertBefore ? ids.indexOf(placement.insertBefore) : placement.insertAfter ? ids.indexOf(placement.insertAfter) + 1 : ids.length;
        ids.splice(Math.max(0, at), 0, id); void queueAction({ action: 'reorder', ids });
      },
    },
    messageRepository: repository, isRunning: running, isDisabled: !hasComposer,
    isSendDisabled: dictating || !hasComposer || isBot && (botStatus.snoozed || botStatus.phase !== 'ready') || projectSelectionBusy || !!issue || starting || modeBusy || inference.busy || contextBusy || composerPlugins.busy, convertMessage,
    onNew: sendNew,
    onCancel: async () => { if (!conversation) return; const result = await bridge.cancelMessage(conversation.id); if (result.ok) update(result.value); else setError(result.error); },
    onEdit: isBot ? undefined : async message => {
      if (!conversation || !message.sourceId) return;
      setVisit(previous => ({ ...previous, prompted: true }));
      const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      setError(''); setStarting(true);
      try { const result = await bridge.editMessage(conversation.id, message.sourceId, text); if (!result.ok) throw new Error(result.error); update(result.value); }
      catch (error) { runtime.thread.getMessageById(message.sourceId).composer.beginEdit(); runtime.thread.getMessageById(message.sourceId).composer.setText(text); setError(error instanceof Error ? error.message : 'The edit could not be sent.'); }
      finally { setStarting(false); }
    },
    onReload: isBot ? undefined : async (_parentId, config) => { if (conversation && config.sourceId) await act(async () => { const result = await bridge.regenerateMessage(conversation.id, config.sourceId!); if (!result.ok) throw new Error(result.error); update(result.value); }); },
    // BranchPicker owns navigation; SQLite remains the authority for the
    // selected path and every preserved sibling. Never rewrite a linear list.
    setMessages: () => {},
    unstable_onBranchChange: event => { if (conversation && event.headId) void bridge.selectBranch(conversation.id, event.headId).then(result => { if (result.ok) update(result.value); else { setError(result.error); void bridge.conversation(conversation.id).then(saved => { if (saved.ok) update({ conversation: saved.value, library }); }); } }, () => setError('The branch could not be opened.')); },
    onDelete: async id => { if (conversation) await act(async () => { const result = await bridge.discardReply(conversation.id, id); if (!result.ok) throw new Error(result.error); update(result.value); }); },
  });
  const conversationId = conversation?.id;
  useEffect(() => {
    // The floating composer owns draft storage while this chat is popped out.
    if (!conversationId || poppedOut) return;
    const key = `tinygpt-chat-draft:${conversationId}`;
    try { const saved = localStorage.getItem(key); if (saved !== null) runtime.thread.composer.setText(saved); } catch { /* Draft remains usable without storage. */ }
    const persist = () => {
      try { const text = runtime.thread.composer.getState().text; if (text) localStorage.setItem(key, text); else localStorage.removeItem(key); } catch { /* Draft remains usable without storage. */ }
    };
    persist(); return runtime.thread.composer.subscribe(persist);
  }, [conversationId, runtime, poppedOut]);
  const openSource = useCallback((id: string) => { void openPanel('sources', id); }, [openPanel]);
  const openFile = useCallback((file: CreatedFile) => { if (!conversationId) return; setRequestedFile(previous => ({ ...file, conversationId, requestId: (previous?.requestId ?? 0) + 1 })); void openPanel('files'); }, [openPanel, conversationId]);
  const openWeb = useCallback((url: string) => { void bridge.openBrowserLink(url).then(result => { if (!result.ok) setError(result.error); else if (result.value === 'workspace') void openPanel('web', undefined, url); }, () => setError('The link could not be opened.')); }, [bridge, openPanel]);
  const exportAnswer = useCallback((id: string) => { if (conversationId) void bridge.exportMessage(conversationId, id).then(result => { if (!result.ok) setError(result.error); }, () => setError('The answer could not be exported.')); }, [bridge, conversationId]);
  const retry = useCallback((id: string) => { if (!conversationId) return; void act(async () => { const result = await bridge.regenerateMessage(conversationId, id); if (!result.ok) throw new Error(result.error); update(result.value); }); }, [act, bridge, conversationId, update]);
  const continueReply = useCallback((id: string) => { if (!conversationId) return; void act(async () => { const result = await bridge.continueMessage(conversationId, id); if (!result.ok) throw new Error(result.error); update(result.value); }); }, [act, bridge, conversationId, update]);
  const discardReply = useCallback((id: string) => { if (!conversationId) return; void act(async () => { const result = await bridge.discardReply(conversationId, id); if (!result.ok) throw new Error(result.error); update(result.value); }); }, [act, bridge, conversationId, update]);
  const setDraft = useCallback((text: string) => { runtime.thread.composer.setText(text); root.current?.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.focus(); }, [runtime]);
  async function editQueued(item: QueuedRequest) {
    const text = runtime.thread.composer.getState().text.trim();
    const replacement = text ? { text, attachmentIds: drafts.map(source => source.id) } : undefined;
    // Swap an existing draft into this queue slot so editing never discards it.
    if (await queueAction({ action: 'edit', id: item.id, replacement })) { setDraft(item.text); setTyping(true); }
  }
  const answerStartedId = [...(conversation?.messages ?? [])].reverse().find(message => message.role === 'assistant' && hasStartedAnswer(message, activeRun))?.id ?? '';
  const react = useCallback((messageId: string, emoji: import('../../shared/bot-reactions').MessageReaction['emoji'] | null) => { if (!conversationId) return; void bridge.reactToMessage(conversationId, messageId, emoji).then(result => { if (result.ok) update(result.value); else setError(result.error); }, () => setError('The reaction could not be saved.')); }, [bridge, conversationId, update]);
  const actions = useMemo(() => ({ loadPresentation:null, previewTool:null, react, answerStartedId, bridge, setDraft, connectionUpdated: update, matches: new Set(matches), selectedMatch, retryDisabled: !!issue || running || isBot && botStatus.phase !== 'ready', openFile, openSource, openWeb, exportAnswer, retry, continueReply, discardReply }), [react, answerStartedId, bridge, setDraft, update, matches, selectedMatch, issue, running, isBot, botStatus.phase, openFile, openSource, openWeb, exportAnswer, retry, continueReply, discardReply]);
  useEffect(() => { const apply = () => { const text = sessionStorage.getItem('tinygpt-plugin-prompt'); if (text) { sessionStorage.removeItem('tinygpt-plugin-prompt'); runtime.thread.composer.setText(text); } }; apply(); window.addEventListener('tinygpt-plugin-prompt', apply); return () => window.removeEventListener('tinygpt-plugin-prompt', apply); }, [runtime]);
  async function attach(folder = false) {
    setAddOpen(false); reportError(''); setError(''); setContextBusy(true);
    try { const current = conversation ?? await createConversation(); const result = await (folder ? bridge.chooseAttachmentFolder(current.id) : bridge.chooseAttachments(current.id)); if (!result.ok) throw new Error(result.error); update(result.value); }
    catch (error) { reportError(error instanceof Error ? error.message : 'The attachments could not be added.'); }
    finally { setContextBusy(false); }
  }
  async function linkConversation(id: string) {
    setAddOpen(false); setContextBusy(true); setError('');
    try { const current = conversation ?? await createConversation(); const result = await bridge.linkConversation(current.id, id); if (!result.ok) throw Error(result.error); update(result.value); }
    catch (error) { reportError(error instanceof Error ? error.message : 'The conversation could not be linked.'); }
    finally { setContextBusy(false); }
  }
  async function removeContext(id: string) {
    if (!conversation) return; setContextBusy(true);
    try { const result = await bridge.removeSource(conversation.id, id); if (!result.ok) throw Error(result.error); update(result.value); }
    catch (error) { reportError(error instanceof Error ? error.message : 'The attachment could not be removed.'); }
    finally { setContextBusy(false); }
  }
  async function selectComposerMode(mode: 'chat' | 'code') {
    if (modeBusy || inference.busy || running || !empty || mode === snapshot.settings.mode) return;
    setModeBusy(true); setError('');
    try { const result = await bridge.saveSettings({ ...snapshot.settings, mode }); if (!result.ok) throw new Error(result.error); updateSnapshot(result.value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The mode could not be changed.'); }
    finally { setModeBusy(false); }
  }
  const BotHeaderElement = compact ? 'div' : 'header';
  const browserTasks = library.browserTasks?.filter(task => task.conversationId === conversation?.id) ?? [];
  const showBotPanel = isBot && hasComposer && !compact && !poppedOut && wideBot && !workspacePanel;
  const botStatusText = botStatus.snoozed ? 'Sleeping' : awaitingAction ? 'Waiting for you' : running ? 'Working on it' : botStatus.phase === 'error' ? 'Connection needs attention' : 'Here for you';
  const botHeader = isBot && hasComposer && <BotHeaderElement className={`bot-conversation-header ${compact ? 'is-compact' : ''}`}>
        <RobotAvatar design={bot} size={compact ? 34 : 44} interactive action={botStatus.snoozed ? 'snooze' : awaitingPermission ? 'blocked' : botReceived ? 'send' : botAction} activity={awaitingPermission || botReceived ? undefined : botActivity} playbackKey={botReceived} />
        <button type="button" className="bot-name-pill" aria-label={'Customize ' + bot.name} onClick={() => setEditingBot(true)}>{bot.name}</button>
        <span className={botStatus.snoozed ? 'bot-floating-status' : 'sr-only'} role="status">{botStatusText}</span>
        {awaitingPermission ? <Button variant="ghost" size="sm" aria-label="Stop reply" onClick={() => void act(async () => { const result = await bridge.cancelMessage(conversation!.id); if (!result.ok) throw Error(result.error); update(result.value); })}>Stop</Button>
          : botStatus.phase === 'error' ? <Button variant="ghost" size="sm" disabled={running} onClick={() => void act(async () => { const result = await bridge.prepareBot({ name: bot.name, projectId: botStatus.projectId }); if (!result.ok) throw Error(result.error); })}>Retry connection</Button>
          : null}
      </BotHeaderElement>;
  return <TooltipProvider><AssistantRuntimeProvider runtime={runtime} config={chatUIConfig}><ReadAloudProvider bridge={bridge} conversationId={conversation?.id ?? null} preferences={snapshot.settings.voice.readAloud}><ToolIconProvider bridge={bridge}><ConversationActions.Provider value={actions}><AnswerImagesProvider bridge={bridge} conversationId={conversation?.id ?? null}>
    <div className="workbench-panes relative flex min-h-0 flex-1" data-bot-layout={showBotPanel ? 'wide' : isBot && !compact && hasComposer ? 'overlay' : undefined} ref={root}>
    {poppedOut ? <div className="flex min-h-0 min-w-0 flex-1" style={workspacePanel && workspaceExpanded ? { display: 'none' } : undefined}>{conversationPlaceholder}</div> : <ThreadPrimitive.Root data-mode={isBot ? 'bot' : activeMode} className="conversation-pane relative flex min-h-0 min-w-0 flex-1 flex-col" style={{ ...(workspacePanel && workspaceExpanded ? { display: 'none' } : {}), ...(isBot ? { '--bot-accent': bot.color } : {}) } as CSSProperties}>
      {compact ? botHeaderTarget && botHeader && createPortal(botHeader, botHeaderTarget) : !showBotPanel && botHeader}
      {!compact && hasComposer && empty && !isBot && <div className="chat-mode-switch" role="tablist" aria-label="Conversation mode"><span className={`chat-mode-indicator ${isChat ? '' : 'is-code'}`} aria-hidden="true" />{(['chat', 'code'] as const).map(mode => <button key={mode} type="button" role="tab" aria-selected={snapshot.settings.mode === mode} tabIndex={snapshot.settings.mode === mode ? 0 : -1} className={`chat-mode-option ${snapshot.settings.mode === mode ? 'is-selected' : ''}`} disabled={modeBusy || running || projectSelectionBusy} onClick={() => void selectComposerMode(mode)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'code' : mode === 'chat' ? 'code' : 'chat'; void selectComposerMode(next); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus(); } }} data-mode={mode}>{mode === 'chat' ? 'Chat' : 'Work'}</button>)}</div>}
      {searchOpen && isChat && <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2" role="search" aria-label="Conversation search"><Search className="size-4 shrink-0 text-muted-foreground" /><Input ref={searchInput} aria-label="Search conversation" placeholder="Find in this conversation" className="h-8 flex-1 border-0 shadow-none" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0); }} onKeyDown={event => { if (event.key === 'Enter' && matches.length) setMatchIndex(index => (index + (event.shiftKey ? matches.length - 1 : 1)) % matches.length); }} /><span className="whitespace-nowrap text-xs text-muted-foreground" role="status">{matches.length ? `${matchIndex % matches.length + 1} of ${matches.length}` : query ? 'No matches' : ''}</span><Button variant="ghost" size="icon" className="size-8" aria-label="Previous match" disabled={!matches.length} onClick={() => setMatchIndex(index => (index + matches.length - 1) % matches.length)}><ChevronUp /></Button><Button variant="ghost" size="icon" className="size-8" aria-label="Next match" disabled={!matches.length} onClick={() => setMatchIndex(index => (index + 1) % matches.length)}><ChevronDown /></Button><Button variant="ghost" size="icon" className="size-8" aria-label="Close conversation search" onClick={closeSearch}><X /></Button></div>}
      {!compact && !isBot && hasComposer && turns.length > 1 && <ConversationMap entries={mapEntries} activeId={mapActive} select={jump} />}
      <ThreadPrimitive.Viewport key={`thread-viewport:${conversation?.id ?? 'new'}`} turnAnchor="top" data-empty={hasComposer && empty} className="thread-viewport relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" onClick={event => {
        const anchor = (event.target as HTMLElement).closest('a'); if (!anchor) return;
        const href = anchor.getAttribute('href'); if (!href) return; event.preventDefault();
        if (href.startsWith('tinygpt-source:')) void openPanel('sources', href.slice('tinygpt-source:'.length));
        else if (/^https?:\/\//i.test(href)) openWeb(href);
      }}>
        {botConversationLoading ? <div role="status" className="m-auto px-6 text-sm text-muted-foreground">Opening {bot.name}…</div> : !hasComposer ? <BotSetup design={bot} changeDesign={changeBot} status={botStatus} bridge={bridge} snapshot={snapshot} updateSnapshot={updateSnapshot} library={library} openSettings={() => openSettings('Configuration')} close={botStatus.configured ? closeBotCustomization : undefined} complete={async setup => { await completeBot(setup); closeBotCustomization(); }} /> : <>
          {empty && isBot ? <div className="bot-empty-space" aria-hidden="true" /> : empty ? <div className="conversation-greeting mx-auto w-full max-w-[46rem] px-4 text-center"><h1 className="mb-6 text-2xl font-medium tracking-tight">{isBot ? 'What can I help you with?' : isChat ? 'Where should we begin?' : 'What should we work on?'}</h1></div> : <div className="mx-auto w-full thread-message-column grow shrink-0 basis-auto"><WindowedMessages components={isBot ? botMessageComponents : messageComponents} /></div>}
          <ThreadPrimitive.ViewportFooter data-docked={!empty} className={`composer-footer flex w-full shrink-0 flex-col pb-4 ${empty ? '' : 'sticky bottom-0 mt-auto pt-3'}`}>
            <div className="mx-auto flex w-full thread-composer-column flex-col">
            {!empty && !(isBot && running) && <ScrollAnchor />}
            {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
            {issue && <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground"><p>{issue}</p>{issue && <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => openSettings()}>Open settings</Button>}</div>}
            {!isBot && <RequestQueue items={queuedRequests} paused={conversation?.queuePaused} error={conversation?.queueError} busy={contextBusy || starting} running={running} remove={id => void queueAction({ action: 'remove', id })} steer={id => void queueAction({ action: 'steer', id })} edit={item => void editQueued(item)} reorder={ids => void queueAction({ action: 'reorder', ids })} resume={() => void queueAction({ action: 'resume' })} />}
            <ToolApprovals library={library} bridge={bridge} conversationId={conversation?.id} update={updateLibrary} />
            {pendingQuestions.map(question => <WorkQuestionCard key={question.id} question={question} bridge={bridge} update={update} />)}
            {isBot && botStatus.snoozed && <div className="bot-sleep-notice" role="status"><span>{bot.name} is sleeping. Wake me to resume replies and watches.</span><button type="button" onClick={() => void bridge.setBotSnoozed(false).then(result => { if (!result.ok) setError(result.error); }, () => setError('Your bot could not wake up.'))}>Wake bot</button></div>}
            <div className="composer-surface" hidden={awaitingAction || isBot && botStatus.snoozed}>
            {!isBot && !empty && !visit.prompted && <p data-slot="conversation-notice" className="mb-3 text-center text-[11px] text-muted-foreground">TinyGPT can make mistakes. Check important info.</p>}
            <Popover open={addOpen && !awaitingAction} onOpenChange={setAddOpen}><PopoverAnchor asChild><ComposerPrimitive.Root className={`composer work-composer ${isChat ? 'chat-composer' : ''} ${hasContext ? 'has-context' : ''}`}>
              <div className="work-composer-prompt">
              <ComposerAttachments drafts={drafts} conversationId={conversation?.id ?? null} bridge={bridge} disabled={running || contextBusy} open={openSource} remove={id => void removeContext(id)} />
              <div className={`composer-input-line ${hasReferences ? 'has-references' : ''}`}>
              <ComposerInput highlightSkillCommand references={hasReferences ? <ComposerReferences drafts={drafts} plugins={composerPlugins} disabled={running || contextBusy} open={openSource} remove={id => void removeContext(id)} /> : undefined} onBackspaceAtStart={!running && !contextBusy && !composerPlugins.busy && hasReferences ? () => { const plugin = composerPlugins.references.at(-1); const source = drafts.filter(source => source.kind === 'conversation').at(-1); if (plugin) void composerPlugins.toggle(plugin.id); else if (source) void removeContext(source.id); } : undefined} autoFocus cancelOnEscape={!dictating} aria-label="Message" placeholder={hasReferences ? '' : isBot ? `Message ${bot.name}` : empty ? isChat ? 'Ask TinyGPT' : 'Work with TinyGPT' : 'Send a follow-up'} onChange={event => setTyping(!!event.currentTarget.value.trim())} maxLength={32000} rows={1} className="work-composer-input w-full resize-none outline-none" />
              </div>
              <SkillPicker showButton={activeMode !== 'code'} bridge={bridge} projectId={projectId} mode={activeMode} disabled={running || contextBusy || dictating} />
              </div><div className="work-composer-controls">
                <div className="composer-add-controls flex min-w-0 items-center gap-1">
                  <ControlTooltip label="Add files and tools"><PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Add files and tools" disabled={contextBusy}><Plus className="size-5" /></Button></PopoverTrigger></ControlTooltip>
                  {activeMode === 'code' && !dictating && <ApprovalSelector snapshot={snapshot} bridge={bridge} update={updateSnapshot} learnMore={() => openSettings('General')} reportError={reportError} />}
                </div>
                <div className="work-composer-right">
                <DictationButton preferences={snapshot.settings.voice.dictation} bridge={bridge} scope={`${conversation?.id ?? 'new'}:${activeMode}`} disabled={awaitingAction || isBot && running || modeBusy} activeChanged={setDictating} idleControls={<ComposerEffortPicker controller={inference} mode={isChat ? 'chat' : 'code'} disabled={running || awaitingAction || modeBusy} iconOnly={compact} openSettings={() => openSettings('Configuration')} />} />
                {running && <ComposerPrimitive.Cancel asChild><Button size="icon" className="size-8 rounded-full" aria-label="Stop reply"><Square className="size-3.5 fill-current" /></Button></ComposerPrimitive.Cancel>}
                {(!running || !isBot && typing) && <ComposerPrimitive.Send asChild><Button size="icon" className="size-8 rounded-full" aria-label={running ? 'Queue message' : 'Send message'}><ArrowUp className="size-4" /></Button></ComposerPrimitive.Send>}</div>
              </div>
            </ComposerPrimitive.Root></PopoverAnchor>
            <ComposerAddMenu empty={empty} disabled={running || contextBusy} plugins={composerPlugins} conversations={library.conversations} conversationId={conversation?.id ?? null} drafts={drafts} attach={() => void attach()} folder={() => void attach(true)} link={id => void linkConversation(id)} sources={() => { setAddOpen(false); void openPanel('sources'); }} files={() => { setAddOpen(false); void openPanel('files'); }} browser={() => { setAddOpen(false); void openPanel('web'); }} managePlugins={() => { setAddOpen(false); openSettings('Plugins'); }} />
            </Popover>
            {empty && activeMode === 'code' && <ComposerExtras required={!isChat} updateProject={project => updateLibrary({ ...library, projects: library.projects.map(item => item.id === project.id ? project : item) })} projects={library.projects} projectId={projectId} select={selectProject} create={createProject} disabled={running || projectSelectionBusy} openSettings={openSettings} bridge={bridge} conversationId={conversation?.id ?? null} reportError={reportError} />}
            </div>
            </div>
          </ThreadPrimitive.ViewportFooter>
        </>}
      </ThreadPrimitive.Viewport>
      {hasComposer && !showBotPanel && browserTasks.length > 0 && <AgentBrowserPreview key={`agent-browser:${browserTasks[0].conversationId}`} tasks={browserTasks} bridge={bridge} />}
    </ThreadPrimitive.Root>}
    {showBotPanel && conversation && <BotCompanionPanel bot={bot} status={botStatus} conversation={conversation} bridge={bridge} identity={botStatusText} action={botStatus.snoozed ? 'snooze' : awaitingPermission ? 'blocked' : botReceived ? 'send' : botAction} activity={botActivity} edit={() => setEditingBot(true)} message={() => root.current?.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.focus()} openBrowser={() => void openPanel('web')} openSource={openSource} jump={jump} activeBrowser={running && browserTasks.length > 0} browserPreview={browserTasks.length ? <AgentBrowserPreview tasks={browserTasks} bridge={bridge} docked /> : undefined} />}
    {!compact && conversation && <Workspace key={`${conversation.id}:${conversation.projectId ?? ''}`} conversation={conversation} library={library} bridge={bridge} snapshot={snapshot} update={update} open={!!workspacePanel} route={workspacePanel} sourceId={previewId} initialUrl={pageUrl} requestedFile={requestedFile} close={() => void openPanel(null)} expanded={workspaceExpanded} setExpanded={setWorkspaceExpanded} />}
    </div>
  </AnswerImagesProvider></ConversationActions.Provider></ToolIconProvider></ReadAloudProvider></AssistantRuntimeProvider></TooltipProvider>;
}

