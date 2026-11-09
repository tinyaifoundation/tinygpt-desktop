import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import type { ChatExecution, ChatWorkerInput, RunSteering } from '../src/shared/chat';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(mode: 'chat' | 'code' = 'chat') {
  const history = new HistoryStore(':memory:'); cleanup.push(() => history.close());
  const project = mode === 'code' ? history.createProject('Work', '', false, tmpdir()) : null;
  const conversation = history.createConversation(project?.id ?? null);
  const runs: { input: ChatWorkerInput; steering?: RunSteering; finish: () => void }[] = [];
  const execution: ChatExecution = { run(input, signal, delta, _tool, _reasoning, _response, _context, _trace, _native, steering) {
    return new Promise((resolve, reject) => { runs.push({ input, steering, finish: () => { delta('Done.'); resolve(); } }); signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true }); });
  } };
  const settings = { ...defaultSettings, mode, route: 'local' as const, local: { ...defaultSettings.local, model: 'fixture', tools: mode === 'code' } };
  const service = new ChatService(history, () => settings, () => undefined, execution, () => {}, undefined, undefined, undefined, undefined, execution);
  cleanup.push(() => service.shutdown()); return { history, conversation, service, runs };
}
describe('durable request queues and active-run steering', () => {
  it('saves Work steering inline before publishing the consumed request, retaining it for follow-up context', async () => {
    const { conversation, service, history, runs } = fixture('code');
    service.send(conversation.id, 'Initial'); service.send(conversation.id, 'Use blue.');
    const queued = history.queue.list(conversation.id)[0];
    service.queueAction({ conversationId: conversation.id, action: 'steer', id: queued.id });
    runs[0].steering!.consume([queued.id]);
    const assistant = history.conversation(conversation.id).messages.at(-1)!;
    expect(assistant.workActivity).toEqual([expect.objectContaining({ kind: 'steering', messageId: queued.id, text: 'Use blue.', runId: assistant.runId })]);
    runs[0].finish(); await vi.waitFor(() => expect(service.isActive(conversation.id)).toBe(false));
    service.send(conversation.id, 'Continue.');
    expect(runs[1].input.messages.some(message => message.text === 'Use blue.')).toBe(true);
  });
  it('preserves order and attachments across restart without auto-sending, and rejects foreign reorder IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinygpt-queue-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
    let history = new HistoryStore(join(root, 'library.sqlite'));
    const chat = history.createConversation(null); const other = history.createConversation(null);
    const source = history.sources.add(chat.id, { kind: 'attachment', title: 'Notes', text: 'Private notes' });
    const first = history.queue.add(chat.id, 'First', [source.id]); const second = history.queue.add(chat.id, 'Second', []);
    const foreign = history.queue.add(other.id, 'Other', []);
    expect(() => history.queue.reorder(chat.id, [first.id, foreign.id])).toThrow('queue changed');
    expect(() => history.queue.add(chat.id, 'Duplicate', [source.id])).toThrow('already belongs');
    history.queue.reorder(chat.id, [second.id, first.id]); history.queue.steer(chat.id, first.id); history.close();
    history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
    expect(history.conversation(chat.id).queuedRequests?.map(item => item.id)).toEqual([second.id, first.id]);
    expect(history.queue.paused(chat.id)).toBe(true); expect(history.queue.get(chat.id, first.id).lane).toBe('queue');
    expect(history.sources.detail(chat.id, source.id).messageId).toBeNull();
  });
  it('drains one request at a time in the reordered sequence, including away from the displayed chat', async () => {
    const { conversation, service, history, runs } = fixture();
    service.send(conversation.id, 'Initial');
    service.send(conversation.id, 'Second'); service.send(conversation.id, 'Third');
    const items = history.queue.list(conversation.id);
    service.queueAction({ conversationId: conversation.id, action: 'reorder', ids: [items[1].id, items[0].id] });
    expect(runs).toHaveLength(1); runs[0].finish();
    await vi.waitFor(() => expect(runs).toHaveLength(2)); expect(runs[1].input.messages.at(-1)?.text).toBe('Third');
    runs[1].finish(); await vi.waitFor(() => expect(runs).toHaveLength(3)); expect(runs[2].input.messages.at(-1)?.text).toBe('Second');
    runs[2].finish(); await vi.waitFor(() => expect(service.isActive(conversation.id)).toBe(false));
    expect(history.queue.list(conversation.id)).toEqual([]);
  });
  it.each(['chat', 'code'] as const)('injects steering into the same %s run and records it only upon delivery', async mode => {
    const { conversation, service, history, runs } = fixture(mode);
    service.send(conversation.id, 'Initial'); service.send(conversation.id, 'Change the approach');
    const item = history.queue.list(conversation.id)[0]; const runId = runs[0].input.runId;
    service.queueAction({ conversationId: conversation.id, action: 'steer', id: item.id });
    expect(history.conversation(conversation.id).messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(runs[0].steering?.pending().map(item => item.text)).toEqual(['Change the approach']);
    runs[0].steering?.consume([item.id]);
    const saved = history.conversation(conversation.id);
    expect(saved.messages.map(message => message.text)).toEqual(['Initial', 'Change the approach', '']);
    expect(saved.messages.at(-1)?.runId).toBe(runId); expect(history.queue.list(conversation.id)).toEqual([]); expect(runs).toHaveLength(1);
    const inserted = new Set<string>();
    for (const message of saved.allMessages!) { if (message.parentId) expect(inserted.has(message.parentId)).toBe(true); inserted.add(message.id); }
  });
  it('keeps queued requests on cancel and resumes explicitly; editing can swap an existing draft without loss', async () => {
    const { conversation, service, history, runs } = fixture(); service.send(conversation.id, 'Initial'); service.send(conversation.id, 'Queued');
    const item = history.queue.list(conversation.id)[0];
    service.queueAction({ conversationId: conversation.id, action: 'edit', id: item.id, replacement: { text: 'Existing draft', attachmentIds: [] } });
    expect(history.queue.get(conversation.id, item.id).text).toBe('Existing draft');
    await service.cancel(conversation.id); expect(runs).toHaveLength(1); expect(history.queue.paused(conversation.id)).toBe(true);
    service.queueAction({ conversationId: conversation.id, action: 'resume' }); expect(runs).toHaveLength(2);
    expect(runs[1].input.messages.at(-1)?.text).toBe('Existing draft');
  });
  it('restores undelivered steering and pauses after a failed run or shutdown', async () => {
    const { conversation, service, history } = fixture(); service.send(conversation.id, 'Initial'); service.send(conversation.id, 'Steer later');
    const item = history.queue.list(conversation.id)[0]; service.queueAction({ conversationId: conversation.id, action: 'steer', id: item.id });
    await service.shutdown(); expect(history.queue.get(conversation.id, item.id).lane).toBe('queue'); expect(history.queue.paused(conversation.id)).toBe(true);
  });
  it('rejects bot queue operations and attachments outside the owning conversation', () => {
    const { conversation, service, history } = fixture(); service.send(conversation.id, 'Initial');
    const other = history.createConversation(null); const source = history.sources.add(other.id, { kind: 'attachment', title: 'Private', text: 'Other conversation' });
    expect(() => service.send(conversation.id, 'Queued', [source.id])).toThrow();
    const bot = history.createConversation(null); history.setConversationMode(bot.id, 'bot');
    expect(() => service.queueAction({ conversationId: bot.id, action: 'resume' })).toThrow('Bot conversations');
  });
});
