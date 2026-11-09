import { chatUIConfig } from './components/ChatGenerativeUI';
import { RemoteToolIconProvider } from './tool-icons';
import {MobileSettings} from './components/MobileSettings';
import {readMobilePreferences,saveMobilePreferences,applyMobilePreferences} from './lib/mobile-preferences';
import {forgetPairingKey} from './lib/mobile-keys';
import {pairingRequest,cachedComputers,saveComputers} from './lib/mobile-pairing';
import { PluginUseCard } from './components/PluginConnectionCards';
import { visibleMessageGraph } from './lib/message-graph';
import { MobileInference } from './components/MobileInference';
import type { RemoteInferenceState } from '../shared/remote-inference';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, ComposerPrimitive, ExportedMessageRepository, ThreadPrimitive, useExternalStoreRuntime, type AppendMessage, type ExportedMessageRepositoryItem, type ThreadMessageLike } from '@assistant-ui/react';
import { ArrowUp, Square, PanelLeft, SquarePen, Search, Monitor, Sun, Moon, Plus, Bell, X, FileText, ChevronDown, LoaderCircle, RefreshCw, Settings } from './icons';
import { useMobileAttachments } from './lib/mobile-attachments';
import type { ChatUpdate } from '../shared/chat';
import type { DesktopBridge } from '../shared/contracts';
import type { RemoteScope } from '../shared/remote';
import type { CitationSource } from '../shared/citations';
import { sourceUrl } from '../core/citations';
import { useMessages } from './lib/conversation-messages';
import { RemoteClient, type RemoteConnection } from './lib/remote-client';
import { readMobileTheme, type MobileTheme } from './lib/mobile-appearance';
import { AssistantMessage, ConversationActions, UserMessage } from './components/ConversationMessages';
import { WindowedMessages } from './components/WindowedMessages';
import { ComposerInput } from './components/ComposerInput';
import { ScrollAnchor } from './components/ConversationElements';
import { TooltipProvider } from './components/ui/tooltip';
import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import { ApprovalCard } from './components/ApprovalCard';
import { WorkQuestionCard } from './components/WorkQuestionCard';
import { DictationButton } from './components/DictationButton';
import { ReadAloudProvider } from './components/ReadAloud';
import { SearchChatsDialog } from './components/LibraryDialogs';
import { mobileVoiceBridge } from './lib/mobile-voice';
import { noRemoteVoice, type RemoteVoiceCapabilities } from '../shared/remote-voice';
import { dictationPreferencesSchema, readAloudPreferencesSchema } from '../shared/voice';
import { MobileCompanion } from './components/MobileCompanion';
import { MobileChatList } from './components/MobileChatList';
import { MobileQueue, MobileSendControls } from './components/MobileQueue';
import { REMOTE_DRAFT_ID } from '../shared/remote';
import type { QueueAction } from '../shared/chat';
import { finishMobileBoot } from './lib/mobile-boot';

import { BotUserMessage, BotAssistantMessage } from './components/BotMessages';
import { MobileBotAvatar, MobileBotInfo, mobileBotStatus } from './components/MobileBot';
import type { MessageReaction } from '../shared/bot-reactions';
const botComponents = { UserMessage: BotUserMessage, AssistantMessage: BotAssistantMessage };
const components = { UserMessage, AssistantMessage };
const convertMessage = (message: ThreadMessageLike) => message;
function savedComputerName(desktop: string) { try { return localStorage.getItem('tinygpt-computer:' + desktop)?.slice(0,120) || 'Computer'; } catch { return 'Computer'; } }
export default function MobileChat({ desktop,manage,notifications,initialConversationId,activityChanged }: { desktop: string; manage: () => void; notifications:()=>void; initialConversationId?: string; activityChanged?: (items: ChatUpdate["library"]["notificationItems"]) => void }) {
  const [update, setUpdate] = useState<ChatUpdate | null>(null), [connection, setConnection] = useState<RemoteConnection>('connecting');
  const [scope, setScope] = useState<RemoteScope>('conversation'), [attention, setAttention] = useState(false);
  const [computerName, setComputerName] = useState(() => savedComputerName(desktop));
  const computerNameRef = useRef(computerName);
  const [theme, setTheme] = useState<MobileTheme>(() => readMobileTheme() ?? (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'));
  const [preferencesOpen,setPreferencesOpen]=useState(false), [botInfoOpen,setBotInfoOpen]=useState(false), [botBusy,setBotBusy]=useState(false);
  const [phonePreferences,setPhonePreferences]=useState(readMobilePreferences);useEffect(()=>applyMobilePreferences(phonePreferences),[phonePreferences]);
  const [source, setSource] = useState<CitationSource | null>(null);
  const [voice, setVoice] = useState<RemoteVoiceCapabilities>(noRemoteVoice), [dictating, setDictating] = useState(false), [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const [error, setError] = useState(''), [sending, setSending] = useState(false), [acting, setActing] = useState(false), [navigating, setNavigating] = useState(false);
  const [sidebar, setSidebar] = useState(false), [searchOpen, setSearchOpen] = useState(false), [draft, setDraft] = useState(!initialConversationId), [draftMode, setDraftMode] = useState<'chat' | 'code'>('chat');
  const client = useRef<RemoteClient | null>(null), latest = useRef<ChatUpdate | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, last = 0;
    const typing = (event: Event) => {
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.value.trim()) return;
      clearTimeout(timer); timer = setTimeout(() => {
        if (!client.current || Date.now() - last < 15000) return;
        last = Date.now(); void client.current.command({ id: crypto.randomUUID(), op: 'warm' }).catch(() => {});
      }, 300);
    };
    document.addEventListener('input', typing);
    return () => { clearTimeout(timer); document.removeEventListener('input', typing); };
  }, []);
  const conversation = draft ? null : update?.conversation ?? null;
  const bot = update?.library.bot;
  const botMode = conversation?.mode === 'bot' && !!bot && conversation.id === bot.conversationId;
  const botWorking = !!bot && !!update?.library.activeRuns.some(run => run.conversationId === bot.conversationId);
  const botUnread = bot ? update?.library.notificationItems?.filter(item => item.conversationId === bot.conversationId && !item.read).length ?? 0 : 0;
  const [mediaAvailable,setMediaAvailable]=useState(false);
  const [inference,setInference]=useState<RemoteInferenceState>();
  const [inferenceBusy,setInferenceBusy]=useState(false);
  const files=useRef<HTMLInputElement>(null);
  const uploads=useMobileAttachments(client,conversation?.id??null,ensureConversation);
  const ensureRef = useRef<() => Promise<string>>(async () => REMOTE_DRAFT_ID); ensureRef.current = async () => conversation?.id ?? REMOTE_DRAFT_ID;
  const voiceBridge = useMemo(() => mobileVoiceBridge(() => client.current, () => ensureRef.current()), []);
  const activeRun = update?.library.activeRuns.find(run => run.conversationId === conversation?.id);
  const graph = useMemo(() => conversation ? { ...conversation, messages: conversation.allMessages ?? conversation.messages } : null, [conversation]);
  const messages = useMessages(graph, activeRun), defaults = useContext(ConversationActions);
  const normalized = useRef(new WeakMap<ThreadMessageLike,ExportedMessageRepositoryItem['message']>());
  const visibleGraph = useMemo(() => visibleMessageGraph(graph?.messages ?? [], messages.map(message => message.id!), conversation?.headId ?? conversation?.messages.at(-1)?.id ?? null), [graph, messages, conversation?.headId]);
  const repository = useMemo(() => ({
    headId: visibleGraph.headId,
    messages: messages.map(message => {
      const parentId = visibleGraph.parents.get(message.id!) ?? null;
      let value = normalized.current.get(message);
      if (!value) { value = ExportedMessageRepository.fromBranchableArray([{message,parentId}]).messages[0].message; normalized.current.set(message,value); }
      return {message:value,parentId};
    }),
  }),[messages,visibleGraph]);
  const mode = conversation?.mode === 'code' ? 'code' : conversation ? 'chat' : draftMode;
  const fullAccess = scope === 'library';
  const empty = !conversation?.messages.length;
  const connectionLabel = connection === 'online' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Disconnected';
  useEffect(() => {
    const remote = new RemoteClient(desktop, setConnection, (value, attention, scope, computerName, voice,media,inference) => {
      latest.current = value; setUpdate(value); activityChanged?.(value.library.notificationItems ?? []); setAttention(attention); setScope(scope); setError('');
      if (value.conversation.id === REMOTE_DRAFT_ID) setDraft(true); else if (scope === 'conversation') setDraft(false);
      finishMobileBoot();
      setVoice(voice ?? noRemoteVoice);
      setMediaAvailable(!!media); setInference(inference);
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
      if (computerName?.trim() && computerNameRef.current !== computerName) { computerNameRef.current = computerName; setComputerName(computerName); try { localStorage.setItem('tinygpt-computer:' + desktop, computerName); } catch {} }
    }, setError, !initialConversationId);
    client.current = remote; remote.restore(); void remote.connect();
    const wake = () => { setVisible(document.visibilityState !== 'hidden'); if (document.visibilityState === 'visible') remote.wake(); };
    document.addEventListener('visibilitychange', wake); window.addEventListener('online', wake); window.addEventListener('pageshow', wake);
    return () => { remote.close(); client.current = null; document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); window.removeEventListener('pageshow', wake); };
  }, [desktop]);
  useEffect(() => { if (connection === 'offline' || connection === 'revoked') finishMobileBoot(); if(connection==='revoked'){setPreferencesOpen(false);setSidebar(false);} }, [connection]);
  async function ensureConversation(){
    if(!draft&&conversation&&conversation.id!==REMOTE_DRAFT_ID)return conversation.id;
    const text=runtime.thread.composer.getState().text;
    await client.current!.command({id:crypto.randomUUID(),op:'create',mode:draftMode});
    const id=latest.current?.conversation.id;if(!id)throw Error('Open a conversation first.');
    setDraft(false);runtime.thread.composer.setText(text);return id;
  }
  const pendingNavigation=useRef<{conversationId:string;notificationId?:string} | undefined>(undefined);
  const navigatingNotification=useRef(false);
  async function openPendingNotification(){
    if(connection!=='online'||navigatingNotification.current||!pendingNavigation.current)return;
    const target=pendingNavigation.current;navigatingNotification.current=true;
    try{if(!await select(target.conversationId))return;if(pendingNavigation.current===target)pendingNavigation.current=undefined;if(target.notificationId)await client.current!.command({id:crypto.randomUUID(),op:'notification-read',conversationId:target.conversationId,notificationId:target.notificationId});}
    catch(cause){setError(cause instanceof Error?cause.message:'This conversation could not be opened.');}
    finally{navigatingNotification.current=false;if(pendingNavigation.current&&pendingNavigation.current!==target)void openPendingNotification();}
  }
  useEffect(()=>{if(initialConversationId)pendingNavigation.current={conversationId:initialConversationId};},[initialConversationId]);
  useEffect(()=>{void openPendingNotification();},[connection,initialConversationId]);
  useEffect(()=>{const navigate=(event:Event)=>{const target=(event as CustomEvent<{desktop:string;conversationId:string;notificationId?:string}>).detail;if(target?.desktop===desktop){pendingNavigation.current=target;void openPendingNotification();}};window.addEventListener('tinygpt-notification-open',navigate);return()=>window.removeEventListener('tinygpt-notification-open',navigate);},[desktop,connection]);
  useEffect(()=>{if(conversation?.id&&visible)navigator.serviceWorker?.controller?.postMessage({type:'conversation-open',desktop,conversationId:conversation.id});},[desktop,conversation?.id,visible]);
  function newConversation() { setDraft(true); setDraftMode('chat'); setSidebar(false); setSource(null); setError(''); runtime.thread.composer.setText(''); if (connection === 'online') void client.current!.command({ id: crypto.randomUUID(), op: 'get', home: true }).catch(cause => setError(cause.message)); }
  async function select(id: string) {
    setNavigating(true); setSource(null); setError('');
    try { await client.current!.command({ id: crypto.randomUUID(), op: 'get', conversationId: id }); setDraft(false); setSidebar(false); runtime.thread.composer.setText(''); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'This conversation could not be opened.'); return false; }
    finally { setNavigating(false); }
  }
  async function send(message: AppendMessage) {
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    await sendText(text);
  }
  async function sendText(text:string, delivery: 'queue' | 'steer' = 'queue'){
    if(inferenceBusy||uploads.busy||uploads.items.some(item=>!item.source)||botMode&&bot?.snoozed)return;
    setError(''); setSending(true);
    try {
      const id=await ensureConversation(),attachmentIds=uploads.items.flatMap(item=>item.source?[item.source.sourceId]:[]);
      await client.current!.command({ id: crypto.randomUUID(), op: 'send', conversationId: id, text, delivery,...(attachmentIds.length?{attachmentIds}:{}) });
      uploads.sent(id);runtime.thread.composer.setText('');
    } catch (cause) { runtime.thread.composer.setText(text); setError(cause instanceof Error ? cause.message : 'The message could not be sent.'); }
    finally { setSending(false); }
  }
  async function stop() {
    setError('');
    try { await client.current!.command({ id: crypto.randomUUID(), op: 'stop', conversationId: conversation?.id }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The reply could not be stopped.'); }
  }
  async function edit(message: AppendMessage) {
    const conversationId = conversation?.id, messageId = message.sourceId;
    if (!conversationId || !messageId) return;
    const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    setError(''); setActing(true);
    try { await client.current!.command({ id: crypto.randomUUID(), op: 'edit', conversationId, messageId, text }); }
    catch (cause) {
      if (latest.current?.conversation.id === conversationId && latest.current.conversation.messages.some(message => message.id === messageId)) {
        runtime.thread.getMessageById(messageId).composer.beginEdit(); runtime.thread.getMessageById(messageId).composer.setText(text);
      }
      setError(cause instanceof Error ? cause.message : 'The edit could not be sent.');
    } finally { setActing(false); }
  }
  async function messageAction(op: 'regenerate' | 'branch', messageId: string) {
    if (!conversation) return; setError(''); setActing(true);
    try { await client.current!.command({ id: crypto.randomUUID(), op, conversationId: conversation.id, messageId }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The response could not be changed.'); client.current?.wake(); }
    finally { setActing(false); }
  }
  async function snoozeBot(snoozed: boolean) {
    if (!bot) return; setBotBusy(true); setError('');
    try { await client.current!.command({ id: crypto.randomUUID(), op: 'bot-snooze', conversationId: bot.conversationId, snoozed }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Your Bot could not be changed.'); }
    finally { setBotBusy(false); }
  }
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({ messageRepository: repository, convertMessage, isRunning: !!activeRun || sending || acting, isSendDisabled: inferenceBusy || dictating || uploads.busy || uploads.items.some(item=>!item.source), onNew: send, onCancel: stop, onEdit: edit,
    onReload: async (_parentId, config) => { if (config.sourceId) await messageAction('regenerate', config.sourceId); },
    setMessages: () => {}, unstable_onBranchChange: event => { if (event.headId) void messageAction('branch', event.headId); },
  });
  function exportAnswer(id: string) {
    const message = update?.conversation.messages.find(message => message.id === id); if (!message) return;
    const url = URL.createObjectURL(new Blob([message.text], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = 'TinyGPT-answer.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const unavailable = inferenceBusy || connection !== 'online' || !update || navigating || acting || sending || uploads.busy;
  const approvals = conversation ? update?.library.approvals.filter(item => item.conversationId === conversation.id) ?? [] : [];
  const questions = conversation ? update?.library.workQuestions?.filter(item => item.conversationId === conversation.id && item.status === 'pending') ?? [] : [];
  const waiting = approvals.length > 0 || questions.length > 0;
  useEffect(()=>{if(approvals.length&&document.activeElement instanceof HTMLElement&&document.activeElement.closest('.mobile-composer'))document.activeElement.blur();},[approvals.length]);
  const presentationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const loadPresentation = useCallback((conversationId:string,toolId:string,signal?:AbortSignal) => {
    const remote = client.current!;
    const result = presentationQueue.current.then(() => { signal?.throwIfAborted(); return remote.media({id:crypto.randomUUID(),jobId:crypto.randomUUID(),op:'tool-ui',conversationId,toolId}); }) as Promise<{ui:import('../shared/generative-ui').ChatUINode;partial:boolean}>;
    presentationQueue.current = result.then(() => {}, () => {}); return result;
  },[]);
  const actions = { ...defaults,
    react: (messageId: string, emoji: MessageReaction['emoji'] | null) => { if (botMode && bot) void client.current!.command({id: crypto.randomUUID(), op: 'bot-react', conversationId: bot.conversationId, messageId, emoji}).catch(cause => setError(cause.message)); }, retryDisabled: unavailable || !!activeRun || waiting || dictating, bridge: null, exportAnswer, loadPresentation, setDraft:(text:string)=>runtime.thread.composer.setText(text),
    previewTool: (conversationId:string,toolId:string)=>client.current!.media({id:crypto.randomUUID(),jobId:crypto.randomUUID(),op:'tool-image',conversationId,toolId}),
    previewAttachment: (conversationId:string,sourceId:string,full:boolean)=>client.current!.media({id:crypto.randomUUID(),jobId:crypto.randomUUID(),op:'attachment-image',conversationId,sourceId,size:full?'full':'thumbnail'}),
    retry: (id: string) => { void messageAction('regenerate', id); },
    openSource: (id: string) => { const source = (conversation?.allMessages ?? conversation?.messages ?? []).flatMap(message => message.citations ?? []).find(source => source.sourceId === id); if (source) setSource(source); else {const attachment=conversation?.sources.find(item=>item.id===id);if(attachment)setSource({key:'attachment:'+id,sourceId:id,title:attachment.title,domain:'',snippet:(attachment.kind==='image'?'Photo':'File')+' · '+(attachment.size<1024*1024?Math.ceil(attachment.size/1024)+' KB':(attachment.size/1024/1024).toFixed(1)+' MB')});} },
    openWeb: (url: string) => { const safe = sourceUrl(url); if (safe) window.open(safe, '_blank', 'noopener,noreferrer'); },
  };
  const questionBridge: Pick<DesktopBridge, 'answerWorkQuestion' | 'cancelWorkQuestion'> = {
    answerWorkQuestion: async input => { try { if (!conversation) throw Error('No conversation'); await client.current!.command({ id: crypto.randomUUID(), op: 'answer', conversationId: conversation.id, ...input }); return { ok: true, value: latest.current! }; } catch (cause) { return { ok: false, error: cause instanceof Error ? cause.message : 'Answer could not be saved.' }; } },
    cancelWorkQuestion: async () => { try { await stop(); return { ok: true, value: latest.current! }; } catch { return { ok: false, error: 'The task could not be stopped.' }; } },
  };
  async function approve(id: string, decision: 'allow-once' | 'deny') {
    if (!conversation) return; setActing(true); setError('');
    try { await client.current!.command({ id: crypto.randomUUID(), op: 'approve', conversationId: conversation.id, approvalId: id, decision }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Approval could not be saved.'); }
    finally { setActing(false); }
  }
  async function changeQueue(change: QueueAction) { await client.current!.command({ id: crypto.randomUUID(), op: 'queue', conversationId: change.conversationId, change }); }
  return <><header className="mobile-toolbar" data-empty={empty || undefined}><Button variant="ghost" size="icon" className="tiny-sidebar-chrome mobile-chrome-button" aria-label="Expand sidebar" onClick={() => { setSidebar(true); client.current?.wake(); }}><PanelLeft /></Button><div className="mobile-toolbar-center">
      {empty && !botMode && fullAccess && <div className="mobile-mode-picker" role="tablist" aria-label="Conversation mode"><button type="button" role="tab" aria-selected={mode === 'chat'} disabled={sending || unavailable || dictating || !!uploads.items.length} onClick={() => { if (conversation) setDraft(true); setDraftMode('chat'); }}>Chat</button><button type="button" role="tab" aria-selected={mode === 'code'} disabled={sending || unavailable || dictating || !!uploads.items.length} onClick={() => { if (conversation) setDraft(true); setDraftMode('code'); }}>Work</button></div>}
      {botMode && bot && <button type="button" className="mobile-bot-identity" aria-label={'About ' + bot.name} onClick={() => setBotInfoOpen(true)}><MobileBotAvatar bot={bot} working={botWorking} /><span><strong>{bot.name}</strong><small>{mobileBotStatus(bot, botWorking)}</small></span></button>}
      <span className="sr-only" role="status">{connectionLabel}</span>
    </div><Button variant="ghost" size="icon" className="tiny-sidebar-chrome mobile-chrome-button" aria-label="New conversation" disabled={!fullAccess || unavailable || dictating} onClick={newConversation}><SquarePen /></Button></header>
    <Dialog open={sidebar} change={setSidebar} title="Conversations" titleHidden className="mobile-sidebar" showClose={false}>
      <div className="mobile-sidebar-top"><span className="mobile-sidebar-brand">TinyGPT</span><div className="mobile-sidebar-actions"><Button variant="ghost" size="icon" className="tiny-sidebar-chrome mobile-chrome-button" aria-label="Notifications" onClick={()=>{setSidebar(false);notifications();}}><Bell />{update?.library.notificationItems?.some(item=>!item.read)&&<i className="mobile-unread-dot"/>}</Button><Button variant="ghost" size="icon" className="tiny-sidebar-chrome mobile-chrome-button" aria-label="Search conversations" disabled={dictating || unavailable} onClick={() => { setSidebar(false); setSearchOpen(true); }}><Search /></Button><Button variant="ghost" size="icon" className="tiny-sidebar-chrome mobile-chrome-button" aria-label="Collapse sidebar" onClick={() => setSidebar(false)}><PanelLeft /></Button></div></div>
      <Button variant="ghost" className={`mobile-new-chat ${draft ? 'is-active' : ''}`} aria-label="Start a new conversation" disabled={!fullAccess || unavailable} onClick={newConversation}><SquarePen /><span>New chat</span></Button>
      {bot && <Button variant="ghost" className={'mobile-new-chat mobile-bot-entry ' + (botMode ? 'is-active' : '')} aria-label={'Chat with ' + bot.name} aria-current={botMode ? 'page' : undefined} disabled={unavailable || dictating} onClick={() => { void select(bot.conversationId); }}><span className="mobile-bot-icon"><MobileBotAvatar bot={bot} working={botWorking} size={24} /></span><span className="mobile-bot-name">{bot.name}</span>{botUnread > 0 && <span className="mobile-bot-unread"><i />{botUnread}</span>}</Button>}
      <MobileChatList update={update} selected={draft ? undefined : conversation?.id} disabled={unavailable || dictating || !fullAccess} select={id => { void select(id); }} command={value => client.current!.command(value)} deleted={id => { if (conversation?.id === id) { setDraft(true); runtime.thread.composer.setText(''); } }} />
      {!fullAccess && <p className="mobile-access-note">This device has access to one conversation. Enable conversations for this device in desktop Remote Control settings to browse and start chats.</p>}
      <div className="mobile-sidebar-footer"><button type="button" className="mobile-computer" onClick={() => { setSidebar(false); manage(); }} aria-label={`Switch computer: ${computerName}`} title={`${computerName} · ${connectionLabel}`}><span className="mobile-computer-device"><Monitor aria-hidden="true" /><i className="mobile-connection-dot" data-state={connection} aria-hidden="true" /></span><span className="mobile-computer-copy"><strong>{computerName}</strong><small>Switch computer</small></span><ChevronDown className="mobile-computer-switch" aria-hidden="true" /></button><Button variant="ghost" size="icon" className="mobile-settings-button" aria-label="Mobile settings" onClick={()=>{setSidebar(false);setPreferencesOpen(true);}}><Settings/></Button></div>
    </Dialog>
    <MobileSettings open={preferencesOpen} close={()=>setPreferencesOpen(false)} client={()=>client.current} online={connection==='online'} computer={computerName} theme={theme} changeTheme={value=>{client.current?.setTheme(value);setTheme(value);}} preferences={phonePreferences} changePreferences={value=>setPhonePreferences(saveMobilePreferences(value))} inference={inference} inferenceChanged={setInference} update={update} select={id=>{void select(id);}} stop={async id=>{await client.current!.command({id:crypto.randomUUID(),op:'stop',conversationId:id});}} computers={manage} notifications={()=>window.dispatchEvent(new Event('tinygpt-notification-settings'))} forget={async()=>{await pairingRequest('/api/d/'+desktop+'/forget',{}).catch(()=>{});client.current?.close();await forgetPairingKey(desktop);saveComputers(cachedComputers().filter(item=>item.desktop!==desktop));for(const key of ['tinygpt-selected:','tinygpt-navigation:','tinygpt-pending:'])sessionStorage.removeItem(key+desktop);setPreferencesOpen(false);window.dispatchEvent(new CustomEvent('tinygpt-computer-forgotten',{detail:desktop}));}}/>
    {bot && <MobileBotInfo bot={bot} working={botWorking} open={botInfoOpen && connection !== 'revoked'} close={() => setBotInfoOpen(false)} busy={botBusy} online={connection === 'online'} snooze={value => { void snoozeBot(value); }} />}
    {searchOpen && update && <SearchChatsDialog library={update.library} close={() => setSearchOpen(false)} select={id => { void select(id); }} newChat={() => { if (fullAccess) newConversation(); }} newProject={() => {}} settings={() => {}} platform="mobile" />}
    <Dialog open={!!source} change={open => { if (!open) setSource(null); }} title={source?.title || 'Source'} description={source?.key.startsWith('attachment:')?'Attached to this message':'Saved source excerpt'} className="mobile-source-dialog"><p className="whitespace-pre-wrap break-words text-sm leading-6">{source?.snippet || 'Open this source on your computer to see its full contents.'}</p></Dialog>
    {connection === 'revoked' ? <div className="mobile-pair-page"><p>Remote access has ended. Generate a new QR code in TinyGPT on your computer to pair again.</p></div> : <AssistantRuntimeProvider runtime={runtime} config={chatUIConfig}><RemoteToolIconProvider tools={conversation?.tools ?? []}><ReadAloudProvider bridge={voiceBridge} conversationId={conversation?.id ?? null} stopWhenHidden preferences={readAloudPreferencesSchema.parse({ enabled: phonePreferences.readAloud && voice.readAloud && connection === 'online' && visible, speed: phonePreferences.speed })}><ConversationActions.Provider value={actions}>
      <ThreadPrimitive.Root key={conversation?.id ?? 'draft'} className={'conversation-pane mobile-thread' + (botMode ? ' mobile-bot-thread' : '')} data-mode={botMode ? 'bot' : mode} data-conversation-id={conversation?.id ?? 'draft'} data-empty={empty || undefined}><ThreadPrimitive.Viewport className="thread-viewport relative flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto" onClick={event => { const anchor = (event.target as HTMLElement).closest('a'); if (anchor?.href) { event.preventDefault(); actions.openWeb(anchor.href); } }}>
        {conversation?.messages.length ? <div className="mx-auto w-full thread-message-column grow shrink-0 basis-auto"><WindowedMessages components={botMode ? botComponents : components} /></div> : botMode ? <div className="grow" aria-label="Start your Bot conversation" /> : <div className="conversation-greeting mx-auto w-full text-center"><h1 className="mb-6 text-2xl font-medium tracking-tight">{update ? mode === 'code' ? 'What should we work on?' : 'Where should we begin?' : 'Opening your conversation…'}</h1></div>}
        <ThreadPrimitive.ViewportFooter className="composer-footer mobile-composer-footer sticky bottom-0 mt-auto flex w-full shrink-0 flex-col pt-3">
          <div className="mx-auto flex w-full thread-composer-column flex-col"><ScrollAnchor />
            {(connection!=='online'||!update)&&<div className="mobile-connection-status" role="status"><span className="mobile-connection-orbit"><LoaderCircle className="animate-spin" /></span><span>{connection==='connecting'?'Connecting to ':'Reconnecting to '}{computerName}<span className="mobile-connection-ellipsis">…</span></span><button type="button" aria-label="Reconnect now" onClick={()=>void client.current?.connect()}><RefreshCw /></button></div>}
            {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
            {attention && !waiting && !draft && <p role="status" className="mobile-attention">This conversation needs an action on your computer.</p>}
            {questions.map(question => <WorkQuestionCard key={question.id} question={question} bridge={questionBridge} update={value => { latest.current = value; setUpdate(value); }} />)}
            {(uploads.error||uploads.items.length>0)&&<div className="mobile-attachments-area">{uploads.error&&<p role="alert">{uploads.error}</p>}<div className="mobile-attachment-list">{uploads.items.map(item=><div className="mobile-attachment" key={item.id} data-upload-state={item.error?'error':item.source?'ready':'uploading'}>{item.preview?<img src={item.preview} alt="" />:<span className="mobile-attachment-file"><FileText /></span>}<span className="mobile-attachment-copy"><strong>{item.file.name}</strong><small>{item.error?item.error:item.source?'Ready':item.progress<99?'Uploading · '+item.progress+'%':'Adding file…'}</small></span>{item.error?<button type="button" aria-label={'Retry upload: '+item.file.name} title={item.error} disabled={connection!=='online'||uploads.busy} onClick={()=>void uploads.retry(item)}><RefreshCw /></button>:!item.source&&<LoaderCircle className="animate-spin" />}<button type="button" aria-label={'Remove attachment: '+item.file.name} onClick={()=>uploads.remove(item)}><X /></button></div>)}</div></div>}
            <MobileQueue conversation={conversation} running={!!activeRun} disabled={unavailable} change={changeQueue} />
            <input ref={files} type="file" multiple hidden aria-label="Choose files" onChange={event=>{void uploads.add(Array.from(event.currentTarget.files??[]));event.currentTarget.value='';}} />
            {botMode && bot?.snoozed ? <div className="mobile-bot-sleeping"><span>{bot.name} is sleeping</span><Button disabled={unavailable || botBusy} onClick={() => { void snoozeBot(false); }}>Wake up</Button></div> : <ComposerPrimitive.Root inert={!!approvals.length} aria-hidden={!!approvals.length||undefined} className="composer work-composer chat-composer mobile-composer" data-running={!!activeRun}><div className="composer-add-controls"><Button type="button" variant="ghost" size="icon" className="mobile-add-button rounded-full" aria-label="Add photos or files" disabled={unavailable||waiting||!!activeRun||dictating||!mediaAvailable||uploads.items.length>=8} onClick={()=>files.current?.click()}><Plus /></Button></div><div className="work-composer-prompt"><div className="composer-input-line"><ComposerInput aria-label="Message" placeholder={unavailable ? 'Waiting for your computer…' : botMode && bot ? 'Message ' + bot.name : mode === 'code' ? 'Work with TinyGPT' : 'Ask TinyGPT'} rows={1} maxLength={32000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!unavailable && (!waiting || activeRun)) void sendText(runtime.thread.composer.getState().text); } }} disabled={unavailable || sending || waiting && !activeRun || acting} className="work-composer-input w-full resize-none outline-none" /></div></div><div className="work-composer-controls"><div className="work-composer-right">
              {fullAccess&&!botMode&&<MobileInference value={inference} mode={mode} request={command=>client.current!.inference(command)} changed={setInference} busyChanged={setInferenceBusy} disabled={connection!=='online'||!update||navigating||acting||sending||uploads.busy||dictating} switchingDisabled={!!update?.library.activeRuns.length||waiting} />}
              <DictationButton bridge={voiceBridge} scope={`${conversation?.id ?? 'draft'}:${mode}`} stopWhenHidden preferences={dictationPreferencesSchema.parse({ enabled: phonePreferences.dictation && voice.dictation,noiseSuppression:phonePreferences.noiseSuppression,echoCancellation:phonePreferences.echoCancellation })} disabled={unavailable || waiting && !activeRun || !visible} activeChanged={setDictating} />
              
              {!dictating && <MobileSendControls stop={()=>void stop()} running={!!activeRun} attachments={uploads.items.length > 0} disabled={unavailable || waiting && !activeRun || uploads.items.some(item => !item.source)} send={delivery => { void sendText(runtime.thread.composer.getState().text, delivery); }} />}
            </div></div></ComposerPrimitive.Root>}
            {!!approvals.length&&<div className="mobile-composer-approval">{approvals.map(item => item.pluginUse ? <PluginUseCard key={item.id} plugin={item.pluginUse} status="pending" busy={acting || unavailable} allow={() => void approve(item.id, 'allow-once')} deny={() => void approve(item.id, 'deny')} /> : <ApprovalCard key={item.id} aria-label="Tool approval" descriptionId={`approval-${item.id}`} heading="Ask permission" title={item.prompt || item.summary} description={<p className="mobile-approval-details">{item.details}</p>} actions={<><Button type="button" variant="ghost" disabled={acting || unavailable} onClick={() => void approve(item.id, 'deny')}>Deny</Button><Button type="button" disabled={acting || unavailable} onClick={() => void approve(item.id, 'allow-once')}>Allow once</Button></>} />)}</div>}
          </div>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport></ThreadPrimitive.Root>
    </ConversationActions.Provider></ReadAloudProvider></RemoteToolIconProvider></AssistantRuntimeProvider>}
  </>;
}
