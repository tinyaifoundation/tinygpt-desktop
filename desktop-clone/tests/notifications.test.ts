import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotificationLog } from '../src/main/notification-log';
import { NotificationService, type NotificationDelivery } from '../src/main/notification-service';
import { NotificationSoundStore, defaultNotificationSound } from '../src/main/notification-sound';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings, settingsSchema } from '../src/shared/config';
import { inQuietHours } from '../src/shared/notifications';
import type { ChatExecution, ResponseEvent } from '../src/shared/chat';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(mode: 'chat' | 'code' | 'bot' = 'chat') {
  const history = new HistoryStore(':memory:'); cleanup.push(() => history.close());
  const conversation = history.createConversation(mode === 'code' ? history.createProject('Work', '', false, tmpdir()).id : null);
  history.setConversationMode(conversation.id, mode);
  const settings = structuredClone(defaultSettings); settings.mode = mode; settings.route = 'local'; settings.local.model = 'fixture'; settings.local.tools = mode === 'code';
  const runs: { finish(silent?:boolean): void; fail(): void; emit(event:ResponseEvent):void }[] = [];
  const execution: ChatExecution = { run(_input, signal, delta, _tool, _reasoning, response) { return new Promise((resolve, reject) => {
    runs.push({ finish: silent => { if(!silent)delta('Private completion text'); resolve(); }, fail: () => reject(new Error('Fixture failure')),emit:event=>response?.(event) });
    signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true });
  }); } };
  let viewing = false; let now = new Date(2026, 9, 9, 12);
  const delivery: NotificationDelivery = { supported: () => true, viewing: () => viewing, show: vi.fn(), sound: vi.fn(async () => {}), open: vi.fn(), customSoundName: () => null };
  const activity=vi.fn();
  const changed = vi.fn();
  const notifications = new NotificationService(new NotificationLog(':memory:'), history, () => settings.notifications, delivery, changed, () => now,activity);
  cleanup.push(() => notifications.close());
  const service = new ChatService(history, () => settings, () => undefined, execution, update => notifications.observe(update), undefined, undefined, undefined, undefined, execution, false, execution);
  cleanup.push(() => service.shutdown());
  const idle = () => vi.waitFor(() => expect(service.isActive(conversation.id)).toBe(false));
  const finish = async () => { runs.at(-1)!.finish(); await idle(); };
  return { conversation, history, service, notifications, delivery, changed, activity,runs, settings, finish, idle, view: (value: boolean) => { viewing = value; }, clock: (value: Date) => { now = value; } };
}

describe('notification event routing and durable activity', () => {
  it('notifies each committed Bot bubble during one active run, without a final duplicate',async()=>{
    const f=fixture('bot');f.service.send(f.conversation.id,'Check this for me');
    f.runs.at(-1)!.emit({type:'bot-messages',messages:['I will check now.'],complete:false});
    const first=f.history.conversation(f.conversation.id).messages.find(message=>message.role==='assistant'&&message.status==='complete')!;
    f.notifications.observe(f.service.update(f.conversation.id));f.notifications.observe(f.service.update(f.conversation.id));
    expect(f.service.isActive(f.conversation.id)).toBe(true);expect(f.delivery.show).toHaveBeenCalledTimes(1);
    expect(f.notifications.snapshot().items[0]).toMatchObject({messageId:first.id,title:'New bot message'});
    f.runs.at(-1)!.emit({type:'bot-messages',messages:['I will check now.','I found the setting.'],complete:false});
    f.notifications.observe(f.service.update(f.conversation.id));
    expect(f.delivery.show).toHaveBeenCalledTimes(2);expect(f.activity).toHaveBeenCalledTimes(2);
    expect(f.notifications.snapshot().unreadCounts[f.conversation.id]).toBe(2);
    f.runs.at(-1)!.emit({type:'bot-messages',messages:['I will check now.','I found the setting.','Here is the final result.']});
    f.runs.at(-1)!.finish(true);await f.idle();
    // End observation of the same completed bubbles must not add a run summary.
    const ended=f.service.update(f.conversation.id);
    f.notifications.observe(ended);f.notifications.observe(ended);expect(f.delivery.show).toHaveBeenCalledTimes(3);
    expect(f.activity).toHaveBeenCalledTimes(3);expect(f.notifications.snapshot().items).toHaveLength(3);
  });
  it('does not replay historical Bot bubbles on upgrade, dismissal or startup',()=>{
    const f=fixture('bot');f.history.appendProactiveMessage(f.conversation.id,'An earlier update.','old-run','local');
    const log=new NotificationLog(':memory:');
    const restored=new NotificationService(log,f.history,()=>f.settings.notifications,f.delivery,()=>{});cleanup.push(()=>restored.close());
    const initial=restored.snapshot().items.length;restored.observe(f.service.update(f.conversation.id));
    expect(restored.snapshot().items).toHaveLength(initial);expect(f.delivery.show).not.toHaveBeenCalled();
    if(initial)restored.action({action:'dismiss',id:restored.snapshot().items[0].id});
    restored.observe(f.service.update(f.conversation.id));expect(restored.snapshot().items).toHaveLength(0);
    f.history.appendProactiveMessage(f.conversation.id,'A new update.','new-run','local');restored.observe(f.service.update(f.conversation.id));
    expect(f.delivery.show).toHaveBeenCalledTimes(1);expect(restored.snapshot().items).toHaveLength(1);
  });
  it('preserves legacy run notification deduplication when restoring a Bot conversation',()=>{
    const f=fixture('bot');f.history.appendProactiveMessage(f.conversation.id,'An existing update.','legacy-run','local');
    const message=f.history.conversation(f.conversation.id).messages.at(-1)!;
    const log=new NotificationLog(':memory:');log.add('run:legacy-run',{conversationId:f.conversation.id,messageId:message.id,mode:'bot',kind:'completed',title:'Bot finished',detail:'',createdAt:1,read:false});
    const restored=new NotificationService(log,f.history,()=>f.settings.notifications,f.delivery,()=>{});cleanup.push(()=>restored.close());restored.observe(f.service.update(f.conversation.id));
    expect(restored.snapshot().items).toHaveLength(1);expect(f.delivery.show).not.toHaveBeenCalled();
  });
  it('counts unread bot events beyond the visible activity page and updates counts after reading or dismissing', () => {
    const f = fixture('bot');
    const other = f.history.createConversation(null,'chat');
    const entries = Array.from({length:5},(_,index) => f.notifications.log.add(`bot-count-${index}`, { conversationId:f.conversation.id,messageId:`bot-message-${index}`,kind:'completed',mode:'bot',title:'Bot update',detail:'A useful update.',createdAt:index,read:false })!);
    for (let index=0;index<110;index++) f.notifications.log.add(`other-count-${index}`, { conversationId:other.id,messageId:null,kind:'completed',mode:'chat',title:'Reply ready',detail:'Another chat.',createdAt:10+index,read:false });
    expect(f.notifications.snapshot().items.every(item=>item.conversationId===other.id)).toBe(true);
    expect(f.notifications.snapshot().unreadCounts[f.conversation.id]).toBe(5);
    f.notifications.action({action:'read',id:entries[0].id});
    f.notifications.action({action:'dismiss',id:entries[1].id});
    expect(f.notifications.snapshot().unreadCounts[f.conversation.id]).toBe(3);
    f.notifications.log.readConversation(f.conversation.id,[entries[4].messageId!]);
    expect(f.notifications.snapshot().unreadCounts[f.conversation.id] ?? 0).toBe(0);
    expect(f.notifications.snapshot().unreadCounts[other.id]).toBe(110);
  });
  it('routes phone activity independently of desktop focus without replaying completed events',async()=>{const f=fixture();f.view(true);f.service.send(f.conversation.id,'Prompt');await f.finish();f.notifications.observe(f.service.update(f.conversation.id));expect(f.delivery.show).not.toHaveBeenCalled();expect(f.activity).toHaveBeenCalledTimes(1);expect(f.activity.mock.calls[0][0].kind).toBe('completed');});
  it('honors pause and event preferences before forwarding phone activity',async()=>{const f=fixture();f.settings.notifications.paused=true;f.service.send(f.conversation.id,'Prompt');await f.finish();expect(f.activity).not.toHaveBeenCalled();});

  it('does not call a completed blocked report finished work', async () => {
    const f = fixture('code'); f.service.send(f.conversation.id, 'Complete a task');
    const message = f.service.update(f.conversation.id).conversation.messages.at(-1)!; const task = f.history.workTasks.forMessage(message.id)!;
    f.history.workTasks.save({ ...task, status: 'blocked', summary: 'A required result is unavailable.' }, task.revision);
    await f.finish(); f.notifications.observe(f.service.update(f.conversation.id));
    expect(f.notifications.snapshot().items[0]).toMatchObject({ kind: 'attention', title: 'Work needs attention', detail: 'A required result is unavailable.' });
    expect(f.delivery.show).toHaveBeenCalledTimes(1);
  });
  it('raises one attention event for a pending Work question and resolves it after an answer', () => {
    const f = fixture('code'); f.service.send(f.conversation.id, 'Choose an account'); const update = f.service.update(f.conversation.id);
    update.library.workQuestions = [{ id: 'question', taskId: 'task', conversationId: f.conversation.id, messageId: update.conversation.messages.at(-1)!.id, operationId: 'operation', question: 'Which account should I use?', options: [], status: 'pending', createdAt: Date.now() }];
    f.notifications.observe(update); f.notifications.observe(update);
    expect(f.delivery.show).toHaveBeenCalledTimes(1); expect(f.notifications.snapshot().items[0].title).toBe('Work has a question');
    update.library.workQuestions = []; f.notifications.observe(update); expect(f.delivery.show).toHaveBeenCalledTimes(1);
  });
  it.each(['chat', 'code', 'bot'] as const)('records one %s completion, preserves privacy, and opens its exact chat', async mode => {
    const f = fixture(mode); f.service.send(f.conversation.id, 'Prompt');
    for (let i = 0; i < 10; i++) f.notifications.observe(f.service.update(f.conversation.id));
    expect(f.notifications.snapshot().items).toHaveLength(0);
    await f.finish();
    f.notifications.observe(f.service.update(f.conversation.id));
    expect(f.delivery.show).toHaveBeenCalledTimes(1);
    const entry = f.notifications.snapshot().items[0]; expect(entry.mode).toBe(mode); expect(entry.read).toBe(false);
    expect(vi.mocked(f.delivery.show).mock.calls[0][1]).toBeNull();
    f.notifications.action({ action: 'open', id: entry.id }); expect(f.delivery.open).toHaveBeenCalledWith(f.conversation.id);
    // Opening an alert alone is not a read receipt until the conversation is displayed.
    expect(f.notifications.snapshot().unreadCount).toBe(1);
    f.history.markConversationRead(f.conversation.id, entry.messageId!); f.notifications.readConversation(f.conversation.id, entry.messageId!);
    expect(f.notifications.snapshot().unreadCount).toBe(0); expect(f.history.conversations()[0].unread).toBe(false);
  });
  it('keeps all queue completions in Activity but alerts only once when the queue finishes', async () => {
    const f = fixture(); f.service.send(f.conversation.id, 'First'); f.service.send(f.conversation.id, 'Second');
    f.runs[0].finish(); await vi.waitFor(() => expect(f.runs).toHaveLength(2));
    expect(f.notifications.snapshot().items).toHaveLength(1); expect(f.delivery.show).not.toHaveBeenCalled();
    await f.finish(); expect(f.notifications.snapshot().items).toHaveLength(2); expect(f.delivery.show).toHaveBeenCalledTimes(1);
  });
  it('suppresses alerts and unread state for the chat currently being viewed', async () => {
    const f = fixture(); f.view(true); f.settings.notifications.sound.enabled = true;
    f.service.send(f.conversation.id, 'Prompt'); await f.finish();
    expect(f.delivery.show).not.toHaveBeenCalled(); expect(f.delivery.sound).not.toHaveBeenCalled(); expect(f.notifications.snapshot().unreadCount).toBe(0);
    f.settings.notifications.onlyWhenAway = false; f.service.send(f.conversation.id, 'Prompt'); await f.finish();
    expect(f.delivery.show).toHaveBeenCalledTimes(1); expect(f.delivery.sound).toHaveBeenCalledTimes(1);
  });
  it.each(['paused', 'category', 'quiet'] as const)('silences %s alerts while preserving Activity and unread dots', async control => {
    const f = fixture(); f.settings.notifications.sound.enabled = true;
    if (control === 'paused') f.settings.notifications.paused = true;
    if (control === 'category') f.settings.notifications.events.chat = false;
    if (control === 'quiet') { f.settings.notifications.quietHours.enabled = true; f.clock(new Date(2026, 9, 9, 23)); }
    f.service.send(f.conversation.id, 'Prompt'); await f.finish();
    expect(f.notifications.snapshot().unreadCount).toBe(1); expect(f.delivery.show).not.toHaveBeenCalled(); expect(f.delivery.sound).not.toHaveBeenCalled();
  });
  it('plays optional sound independently of desktop alerts, rate-limits bursts, and enables explicit previews', async () => {
    const f = fixture(); f.settings.notifications.desktop = false; f.settings.notifications.sound.enabled = true;
    f.service.send(f.conversation.id, 'First'); await f.finish(); f.service.send(f.conversation.id, 'Second'); await f.finish();
    expect(f.delivery.sound).toHaveBeenCalledTimes(1); expect(f.delivery.show).not.toHaveBeenCalled();
    f.settings.notifications.desktop = true; f.settings.notifications.previews = true; f.clock(new Date(2026, 9, 9, 12, 0, 4));
    f.service.send(f.conversation.id, 'Third'); await f.finish();
    expect(f.delivery.sound).toHaveBeenCalledTimes(2); expect(vi.mocked(f.delivery.show).mock.calls[0][1]).toContain('Private completion text');
  });
  it('alerts on failure, preserves queued work, and does not alert for cancellation', async () => {
    const f = fixture(); f.service.send(f.conversation.id, 'First'); f.service.send(f.conversation.id, 'Queued'); f.runs[0].fail(); await f.idle();
    expect(f.notifications.snapshot().items[0].kind).toBe('failed'); expect(f.delivery.show).toHaveBeenCalledTimes(1);
    f.service.send(f.conversation.id, 'Another'); await f.service.cancel(f.conversation.id);
    expect(f.notifications.snapshot().items).toHaveLength(1); expect(f.delivery.show).toHaveBeenCalledTimes(1);
  });
  it('deduplicates approvals even after dismissal, and resolves pending attention without new alerts', () => {
    const f = fixture(); f.service.send(f.conversation.id, 'First');
    const update = f.service.update(f.conversation.id); const runId = update.library.activeRuns[0].runId;
    update.library.approvals = [{ id: 'approval', conversationId: f.conversation.id, runId, name: 'write_project_file', summary: 'Write a file', details: '' }];
    f.notifications.observe(update); f.notifications.observe(update);
    expect(f.delivery.show).toHaveBeenCalledTimes(1); const id = f.notifications.snapshot().items[0].id;
    f.notifications.action({ action: 'dismiss', id }); f.notifications.observe(update);
    expect(f.notifications.snapshot().items).toHaveLength(0); expect(f.delivery.show).toHaveBeenCalledTimes(1);
    update.library.approvals[0].id = 'second-approval'; f.notifications.observe(update);
    update.library.approvals = []; f.notifications.observe(update);
    expect(f.notifications.snapshot().items[0].resolved).toBe(true); expect(f.notifications.snapshot().unreadCount).toBe(0);
  });
  it('marks only activity present at the time of a read-all action and prevents cleared history from returning', async () => {
    const f = fixture(); f.service.send(f.conversation.id, 'First'); await f.finish(); const sequence = f.notifications.snapshot().items[0].sequence;
    f.service.send(f.conversation.id, 'Second'); await f.finish();
    f.notifications.action({ action: 'read-all', throughSequence: sequence });
    expect(f.notifications.snapshot().unreadCount).toBe(1);
    f.notifications.action({ action: 'clear-read' }); f.notifications.observe(f.service.update(f.conversation.id));
    expect(f.notifications.snapshot().items).toHaveLength(1);
    f.notifications.forgetConversation(f.conversation.id); expect(f.notifications.snapshot().items).toHaveLength(0);
  });
  it('reports delivery failures without failing or interrupting the model response', async () => {
    const f = fixture(); vi.mocked(f.delivery.show).mockImplementation(() => { throw new Error('OS failure'); });
    f.service.send(f.conversation.id, 'First'); await f.finish();
    expect(f.history.conversation(f.conversation.id).messages.at(-1)?.status).toBe('complete'); expect(f.notifications.snapshot().deliveryError).toContain('system notification settings');
  });
  it('persists dismissed event identities and read state through restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinygpt-notifications-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'notifications.sqlite'); const entry = { conversationId: 'chat', messageId: 'message', mode: 'chat' as const, kind: 'completed' as const, title: 'Reply ready', detail: '', createdAt: 1, read: false };
    let log = new NotificationLog(path); const first = log.add('run:one', entry)!; log.dismiss(first.id); log.add('run:two', entry); log.close();
    log = new NotificationLog(path); cleanup.push(() => log.close()); expect(log.add('run:one', entry)).toBeNull(); expect(log.unreadCount()).toBe(1);
  });
  it('restores missed responses on startup without replaying desktop alerts', async () => {
    const f = fixture(); f.service.send(f.conversation.id, 'Prompt'); await f.finish();
    const log = new NotificationLog(':memory:'); const restarted = new NotificationService(log, f.history, () => f.settings.notifications, f.delivery, () => {}); cleanup.push(() => restarted.close());
    expect(restarted.snapshot().unreadCount).toBe(1); expect(f.delivery.show).toHaveBeenCalledTimes(1);
    restarted.action({ action: 'dismiss', id: restarted.snapshot().items[0].id });
    const second = new NotificationService(log, f.history, () => f.settings.notifications, f.delivery, () => {});
    expect(second.snapshot().items).toHaveLength(0);
  });
});

describe('notification preferences and sound', () => {
  it('migrates existing settings and validates quiet-hour boundaries, including overnight windows', () => {
    const previous = { ...defaultSettings } as Partial<typeof defaultSettings>; delete previous.notifications;
    expect(settingsSchema.parse(previous).notifications).toEqual(defaultSettings.notifications);
    const preferences = structuredClone(defaultSettings.notifications); preferences.quietHours.enabled = true;
    const at = (hour: number, minute = 0) => inQuietHours(preferences, new Date(2026, 9, 9, hour, minute));
    expect(at(21, 59)).toBe(false); expect(at(22)).toBe(true); expect(at(7, 59)).toBe(true); expect(at(8)).toBe(false);
    preferences.quietHours = { enabled: true, start: '12:00', end: '13:00' }; expect(at(12)).toBe(true); expect(at(13)).toBe(false);
    expect(settingsSchema.safeParse({ ...defaultSettings, notifications: { ...preferences, quietHours: { enabled: true, start: '27:00', end: '08:00' } } }).success).toBe(false);
  });
  it('copies valid custom audio locally and retains it if the original is removed; rejects other content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinygpt-sound-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'ElevenLabs.wav'); await writeFile(file, Buffer.from(defaultNotificationSound().split(',')[1], 'base64'));
    const store = new NotificationSoundStore(join(root, 'profile')); await store.choose(file); await rm(file);
    const reloaded = new NotificationSoundStore(join(root, 'profile')); await reloaded.load(); expect(reloaded.name()).toBe('ElevenLabs.wav'); expect(reloaded.url('custom')).toBe(store.url('custom'));
    await writeFile(file, 'this is not an audio file'); await expect(store.choose(file)).rejects.toThrow('Choose a WAV or MP3');
    await writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1)); await expect(store.choose(file)).rejects.toThrow('smaller than 5 MB');
  });
});
