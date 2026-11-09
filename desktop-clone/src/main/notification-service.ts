import type { HistoryStore } from './history';
import { NotificationLog } from './notification-log';
import { createHash } from 'node:crypto';
import type { ChatMessage, ChatUpdate } from '../shared/chat';
import { inQuietHours, type ActivityNotification, type NotificationAction, type NotificationPreferences, type NotificationSnapshot } from '../shared/notifications';

export interface NotificationDelivery {
  supported(): boolean;
  viewing(conversationId: string): boolean;
  show(entry: ActivityNotification, preview: string | null, open: () => void, failed: () => void): void;
  sound(): Promise<void>;
  open(conversationId: string): void;
  customSoundName(): string | null;
}
export class NotificationService {
  private runs = new Map<string, string>();
  private botMessages = new Set<string>();
  private stopped = false;
  private error: string | null = null;
  private lastSound = -Infinity;
  constructor(readonly log: NotificationLog, private history: HistoryStore, private preferences: () => NotificationPreferences, private delivery: NotificationDelivery, private changed: () => void, private now = () => new Date(), private activity:(entry:ActivityNotification)=>void = () => {}, private visible:(id:string)=>boolean = () => true) {
    const existing = new Set(history.conversations().map(chat => chat.id));
    for (const id of new Set(log.list(500).map(item => item.conversationId))) if (!existing.has(id) || !this.visible(id)) log.forgetConversation(id);
    // Restore missed activity without replaying native alerts on launch.
    for (const chat of history.conversations().filter(chat => chat.unread && this.visible(chat.id))) {
      const message = history.conversation(chat.id).messages.filter(message => message.role === 'assistant' && ['complete', 'error', 'interrupted'].includes(message.status)).at(-1);
      if (message) this.recordReply(chat.id, chat.mode ?? 'chat', message, true);
    }
    // Historical bubbles are a baseline, not fresh incoming messages. Persist
    // their keys too so clearing read notifications cannot replay old alerts.
    for(const chat of history.conversations().filter(chat=>chat.mode==='bot'&&this.visible(chat.id))){
      const messages=history.conversation(chat.id).messages.filter(message=>message.role==='assistant'&&['complete','error','interrupted'].includes(message.status));
      for(const message of messages)this.botMessages.add(message.id);
      this.log.remember(messages.map(message=>'bot-message:'+message.id),chat.id);
    }
  }
  snapshot(): NotificationSnapshot {
    return { items: this.log.list(), unreadCount: this.log.unreadCount(), unreadConversationIds: this.log.unreadConversations(), unreadCounts: this.log.unreadCounts(), desktopSupported: this.delivery.supported(), deliveryError: this.error, customSoundName: this.delivery.customSoundName() };
  }
  private recordReply(id: string, mode: ActivityNotification['mode'], message: ChatMessage, restoring = false, queued = false) {
    if (!message.runId || !['complete', 'error', 'interrupted'].includes(message.status)) return;
    const failed = message.status !== 'complete';
    if(mode==='bot'&&!failed&&!message.text.trim())return;
    if(mode==='bot'&&restoring&&this.log.hasEvent(`run:${message.runId}`))return;
    const blocked = mode === 'code' && ['blocked', 'waiting'].includes(message.workTask?.status ?? '');
    const entry = this.log.add(mode==='bot'?`bot-message:${message.id}`:`run:${message.runId}`, { conversationId: id, messageId: message.id, kind: failed ? 'failed' : blocked ? 'attention' : 'completed', mode,
      title: mode==='bot' ? failed?'Bot needs attention':'New bot message' : failed || blocked ? 'Work needs attention' : mode === 'code' ? 'Work finished' : 'Reply ready',
      detail: failed ? message.error ?? 'The reply was interrupted. Open the chat to continue.' : blocked ? message.workTask!.summary : mode==='bot'?'Your bot sent you a message.':queued ? 'Request complete. Continuing with the next queued request.' : 'Your reply is ready to read.',
      createdAt: restoring ? Math.max(message.createdAt, this.history.conversation(id).updatedAt) : this.now().getTime(), read: !restoring && this.delivery.viewing(id) });
    if (entry && !restoring) this.deliver(entry, message.text, !failed && queued);
  }
  observe(update: ChatUpdate): void {
    if (this.stopped) return;
    try { this.observeUpdate(update); } catch { this.deliveryFailed('Activity could not be saved. Restart TinyGPT to try again.'); }
  }
  private observeUpdate(update: ChatUpdate): void {
    const before = this.log.revision;
    const { conversation: chat, library } = update;
    if (!this.visible(chat.id)) return;
    const active = new Set(library.activeRuns.map(run => run.runId));
    for (const run of library.activeRuns.filter(run => this.visible(run.conversationId))) this.runs.set(run.runId, run.conversationId);
    for (const [runId, id] of this.runs) if (id === chat.id && !active.has(runId)) {
      this.runs.delete(runId);
      const message = (chat.allMessages ?? chat.messages).filter(message => message.role === 'assistant' && message.runId === runId).at(-1);
      if (message && chat.mode!=='bot') this.recordReply(id, chat.mode ?? 'chat', message, false, !!chat.queuedRequests?.length && !chat.queuePaused);
    }
    const pending: { key: string; title: string; detail: string }[] = [];
    const latest = chat.messages.at(-1);
    if(chat.mode==='bot')for(const message of chat.messages){
      if(message.role!=='assistant'||!message.runId||this.botMessages.has(message.id)||!['complete','error','interrupted'].includes(message.status))continue;
      this.recordReply(chat.id,'bot',message);this.botMessages.add(message.id);
    }
    if (chat.mode === 'code' && latest?.status === 'complete' && latest.runId && ['blocked', 'waiting'].includes(latest.workTask?.status ?? '')) pending.push({ key: `run:${latest.runId}`, title: 'Work needs attention', detail: latest.workTask!.summary });
    for (const question of (library.workQuestions ?? []).filter(item => item.conversationId === chat.id && item.status === 'pending')) pending.push({ key: `question:${question.id}`, title: 'Work has a question', detail: question.question });
    for (const approval of library.approvals.filter(item => item.conversationId === chat.id)) pending.push({ key: `approval:${approval.id}`, title: 'Approval needed', detail: approval.prompt ?? approval.summary });
    for (const handoff of library.browserHandoffs.filter(item => item.conversationId === chat.id)) pending.push({ key: `browser:${handoff.tabId}:${createHash('sha256').update(`${chat.messages.at(-1)?.runId ?? ''}:${handoff.url}:${handoff.reason}`).digest('hex').slice(0, 24)}`, title: 'Browser needs your input', detail: handoff.reason });
    for (const tool of chat.tools.filter(tool => tool.name === 'request_plugin_connection' && tool.status === 'success' && chat.messages.at(-1)?.runId === tool.runId)) {
      try { if (JSON.parse(tool.result ?? '{}').status === 'pending') pending.push({ key: `connection:${tool.id}`, title: 'Connection needed', detail: 'Open this chat to connect the requested plugin.' }); } catch { /* No pending card. */ }
    }
    const resolved = this.log.resolveAttention(chat.id, pending.map(item => item.key));
    for (const item of pending) {
      const entry = this.log.add(item.key, { conversationId: chat.id, messageId: null, mode: chat.mode ?? 'chat', kind: 'attention', title: item.title, detail: item.detail, createdAt: this.now().getTime(), read: this.delivery.viewing(chat.id) });
      if (entry) this.deliver(entry, item.detail);
    }
    if (before !== this.log.revision || resolved) this.changed();
  }
  private deliver(entry: ActivityNotification, text: string, queued = false): void {
    const preferences = this.preferences();
    const enabled = entry.kind === 'attention' ? preferences.events.attention : entry.kind === 'failed' ? preferences.events.errors : preferences.events[entry.mode === 'code' ? 'work' : entry.mode];
    if (!enabled || queued || preferences.paused || inQuietHours(preferences, this.now())) return;
    try { this.activity(entry); } catch { /* Phone delivery cannot interrupt desktop work. */ }
    if (preferences.onlyWhenAway && this.delivery.viewing(entry.conversationId)) return;
    const preview = preferences.previews ? `${this.history.conversation(entry.conversationId).title}\n${text.replace(/\s+/g, ' ').slice(0, 180)}` : null;
    if (preferences.desktop && this.delivery.supported()) {
      try { this.delivery.show(entry, preview, () => this.open(entry.id), () => this.deliveryFailed('Desktop alerts could not be shown. Check your system notification settings.')); }
      catch { this.deliveryFailed('Desktop alerts could not be shown. Check your system notification settings.'); }
    }
    if (preferences.sound.enabled && preferences.sound.volume > 0 && this.now().getTime() - this.lastSound >= 3000) {
      this.lastSound = this.now().getTime();
      void this.delivery.sound().catch(() => this.deliveryFailed('Notification sound could not play. Try another WAV or MP3 file.'));
    }
  }
  deliveryFailed(error: string): void { if (!this.stopped && this.error !== error) { this.error = error; try { this.changed(); } catch { /* Notification failures must not interrupt a reply. */ } } }
  resetError(): void { this.error = null; }
  readConversation(id: string, messageId?: string): void {
    const messages = this.history.conversation(id).messages;
    const through = messageId ? messages.findIndex(message => message.id === messageId) : -1;
    this.log.readConversation(id, through >= 0 ? messages.slice(0, through + 1).filter(message => message.role === 'assistant').map(message => message.id) : []);
    this.changed();
  }
  action(action: NotificationAction): NotificationSnapshot {
    if (action.action === 'open') this.open(action.id);
    else if (action.action === 'read-all') {
      const items = this.log.list(500).filter(item => item.sequence <= action.throughSequence);
      for (const item of items) this.readReceipt(item);
      this.log.readThrough(action.throughSequence);
    } else if (action.action === 'clear-read') this.log.clearRead();
    else { const item = this.log.get(action.id); this.readReceipt(item); if (action.action === 'dismiss') this.log.dismiss(item.id); else this.log.read(item.id); }
    this.changed(); return this.snapshot();
  }
  private readReceipt(item: ActivityNotification) { if (item.messageId) {
    this.history.markConversationRead(item.conversationId, item.messageId);
    const messages = this.history.conversation(item.conversationId).messages; const index = messages.findIndex(message => message.id === item.messageId);
    this.log.readConversation(item.conversationId, index >= 0 ? messages.slice(0, index + 1).filter(message => message.role === 'assistant').map(message => message.id) : [item.messageId]);
  } }
  private open(id: string) { const item = this.log.get(id); this.history.conversation(item.conversationId); this.delivery.open(item.conversationId); }
  forgetConversation(id: string): void { this.log.forgetConversation(id); this.changed(); }
  close(): void { this.stopped = true; this.runs.clear(); this.botMessages.clear(); this.log.close(); }
}
