import { expect, it, vi } from 'vitest';
import { HistoryStore } from '../src/main/history';
import { ChatUpdateEncoder, ChatUpdateDecoder } from '../src/core/chat-updates';
import { ChatBroadcast } from '../src/main/chat-broadcast';
import { SessionCache } from '../src/core/session-cache';
import type { ChatUpdate, Conversation, LibrarySnapshot } from '../src/shared/chat';

const library = (): LibrarySnapshot => ({ projects: [], conversations: [], lastConversationId: null, activeRuns: [], approvals: [], browserHandoffs: [], outputsRevision: 0 });
function fixture(id = 'chat'): ChatUpdate {
  const messages: Conversation['messages'] = Array.from({ length: 100 }, (_, index) => ({ id: `${id}-m-${index}`, role: index % 2 ? 'assistant' : 'user', text: 'History '.repeat(2000), status: 'complete', error: null, createdAt: index, runId: `${id}-run-${index}`, route: 'local' }));
  return { conversation: { id, title: id, projectId: null, createdAt: 0, updatedAt: 0, messages, allMessages: messages, tools: [{ id: id + '-tool', conversationId: id, runId: 'run', name: 'read_project_file', summary: 'Read file', status: 'success', result: 'Result '.repeat(10000), createdAt: 0 }], sources: [], contextActivities: [] }, library: library() };
}
it('sends only appended text and preserves historical references across context-bridge packet copies', () => {
  const encoder = new ChatUpdateEncoder(), decoder = new ChatUpdateDecoder(), first = fixture();
  const before = decoder.decode(structuredClone(encoder.encode(first)));
  const last = { ...first.conversation.messages.at(-1)!, text: first.conversation.messages.at(-1)!.text + ' new token', status: 'streaming' as const };
  const allMessages = [...first.conversation.messages.slice(0, -1), last];
  const next = { ...first, conversation: { ...first.conversation, messages: allMessages, allMessages } };
  const packet = structuredClone(encoder.encode(next)); expect(JSON.stringify(packet).length).toBeLessThan(1000);
  const after = decoder.decode(packet); expect(after.conversation).toEqual(next.conversation);
  expect(after.conversation.messages[0]).toBe(before.conversation.messages[0]); expect(after.conversation.tools).toBe(before.conversation.tools); expect(after.library).toBe(before.library);
});
it('reconciles branches, tool changes, activity, deleted rows and cleared optional fields', () => {
  const encoder = new ChatUpdateEncoder(), decoder = new ChatUpdateDecoder(), first = fixture(); decoder.decode(structuredClone(encoder.encode(first)));
  const allMessages = first.conversation.messages.slice(0, 4).map((message, index) => index === 3 ? { ...message, workActivity: [{ id: 'part', runId: 'run', kind: 'prose' as const, text: 'Progress' }] } : message);
  const next = { conversation: { ...first.conversation, messages: allMessages.slice(0, 2), allMessages, tools: [{ ...first.conversation.tools[0], status: 'error' as const, result: null }] }, library: { ...first.library, outputsRevision: 1 } };
  const decoded = decoder.decode(structuredClone(encoder.encode(next))); expect(decoded).toEqual(next);
  const cleared = { ...next, conversation: { ...next.conversation, allMessages: allMessages.map(message => ({ ...message, workActivity: undefined })), messages: next.conversation.messages } };
  expect(decoder.decode(structuredClone(encoder.encode(cleared)))).toEqual(cleared);
});
it('restarts with full packets after bounded base eviction and rejects stale patches', () => {
  const encoder = new ChatUpdateEncoder(), decoder = new ChatUpdateDecoder();
  for (let index = 0; index < 18; index++) decoder.decode(structuredClone(encoder.encode(fixture('chat-' + index))));
  const first = encoder.encode(fixture('chat-0')); expect(first.full).toBeDefined(); decoder.decode(structuredClone(first));
  const next = encoder.encode(fixture('chat-0')); decoder.decode(structuredClone(next)); expect(() => decoder.decode(structuredClone(next))).toThrow('Outdated');
});
it('appends growing Work activity without retransmitting its accumulated text', () => {
  const encoder = new ChatUpdateEncoder(), decoder = new ChatUpdateDecoder(), first = fixture();
  const part = { id: 'part', runId: 'run', kind: 'prose' as const, text: 'History '.repeat(20000) };
  const message = { ...first.conversation.messages.at(-1)!, workActivity: [part] };
  first.conversation.messages = first.conversation.allMessages = [...first.conversation.messages.slice(0, -1), message]; decoder.decode(structuredClone(encoder.encode(first)));
  const nextMessage = { ...message, workActivity: [{ ...part, text: part.text + ' New progress.' }] }, allMessages = [...first.conversation.messages.slice(0, -1), nextMessage];
  const next = { ...first, conversation: { ...first.conversation, messages: allMessages, allMessages } }, packet = structuredClone(encoder.encode(next));
  expect(JSON.stringify(packet).length).toBeLessThan(1000); expect(decoder.decode(packet).conversation).toEqual(next.conversation);
});
it('does not thrash full snapshots when concurrent active histories exceed the inactive budget', () => {
  const encoder = new ChatUpdateEncoder(), decoder = new ChatUpdateDecoder(), chats = Array.from({ length: 8 }, (_, index) => fixture('active-' + index));
  const activeRuns = chats.map(chat => ({ conversationId: chat.conversation.id, runId: chat.conversation.id + '-run' }));
  for (const chat of chats) { chat.library = { ...chat.library, activeRuns }; chat.conversation.messages = chat.conversation.allMessages = chat.conversation.messages.map(message => ({ ...message, text: message.text.repeat(2) })); decoder.decode(structuredClone(encoder.encode(chat))); }
  for (const chat of chats) { const message = { ...chat.conversation.messages.at(-1)!, text: chat.conversation.messages.at(-1)!.text + ' token' }, allMessages = [...chat.conversation.messages.slice(0, -1), message], next = { ...chat, conversation: { ...chat.conversation, messages: allMessages, allMessages } }, packet = structuredClone(encoder.encode(next)); expect(packet.full).toBeUndefined(); expect(JSON.stringify(packet).length).toBeLessThan(1000); expect(decoder.decode(packet).conversation.messages.at(-1)?.text).toBe(message.text); }
});
it('coalesces concurrent updates without rolling global library state backward', () => {
  vi.useFakeTimers();
  try {
    const send = vi.fn(), events = new Map<string, () => void>();
    const contents = { send, once: (event: string, action: () => void) => events.set(event, action) };
    const window = { isDestroyed: () => false, webContents: contents } as unknown as import('electron').BrowserWindow;
    const broadcast = new ChatBroadcast(() => [window]);
    const a = fixture('a'), b = fixture('b'); broadcast.publish(a); broadcast.publish(b); broadcast.publish({ ...a, library: { ...a.library, outputsRevision: 3 } }); vi.advanceTimersByTime(33);
    expect(send).toHaveBeenCalledTimes(1); const packets = send.mock.calls[0][1]; expect(packets.map((packet: any) => packet.id)).toEqual(['b', 'a']);
    const decoder = new ChatUpdateDecoder(); expect(packets.map((packet: any) => decoder.decode(structuredClone(packet))).at(-1).library.outputsRevision).toBe(3);
    events.get('did-start-loading')!(); broadcast.publish(a); vi.advanceTimersByTime(33); expect(send.mock.calls[1][1][0].full).toBeDefined();
  } finally { vi.useRealTimers(); }
});
it('reads changed live rows without rebuilding historical messages and invalidates structural changes', () => {
  const store = new HistoryStore(':memory:');
  try {
    const chat = store.createConversation(null, 'code'), turn = store.startTurn(chat.id, 'Build', 'local'); store.watchConversation(chat.id, turn.conversation);
    const full = vi.spyOn(store, 'conversation');
    store.saveReply(turn.assistantId, 'Working', 'streaming'); store.addTool('tool-z', chat.id, turn.runId, 'read_project_file', 'Read'); store.finishTool('tool-z', 'success', '{"text":"Evidence"}');
    store.contextActivity('context', chat.id, turn.runId, 'running');
    const next = store.liveConversation(chat.id); expect(full).not.toHaveBeenCalled(); expect(next.messages[0]).toBe(turn.conversation.messages[0]); expect(next.messages.at(-1)?.text).toBe('Working'); expect(next.tools[0].status).toBe('success'); expect(next.contextActivities?.[0].status).toBe('running');
    store.sources.add(chat.id, { kind: 'page', title: 'Evidence', text: 'Source', url: 'https://example.com' }); full.mockClear(); expect(store.liveConversation(chat.id).sources[0].title).toBe('Evidence'); expect(full).not.toHaveBeenCalled();
    store.queue.add(chat.id, 'Next', []); full.mockClear(); expect(store.liveConversation(chat.id).queuedRequests).toHaveLength(1); expect(full).toHaveBeenCalledOnce();
    store.unwatchConversation(chat.id);
  } finally { store.close(); }
});
it('refreshes outputs only for artifact changes rather than streaming or unrelated tool completions', () => {
  const store = new HistoryStore(':memory:');
  try {
    const chat = store.createConversation(null), turn = store.startTurn(chat.id, 'Write', 'local'), before = store.outputsRevision();
    store.saveReply(turn.assistantId, 'Streaming', 'streaming'); store.addTool('read', chat.id, turn.runId, 'read_project_file', 'Read'); store.finishTool('read', 'success', '{"text":"Content"}'); expect(store.outputsRevision()).toBe(before);
    store.addTool('write', chat.id, turn.runId, 'write_project_file', 'Write'); store.finishTool('write', 'success', '{"path":"report.md"}'); expect(store.outputsRevision()).toBeGreaterThan(before);
    const saved = store.outputsRevision(); store.renameConversation(chat.id, 'Renamed'); expect(store.outputsRevision()).toBeGreaterThan(saved);
  } finally { store.close(); }
});
it('spills least-recently-used drafts before eviction and restores them within the memory budget', async () => {
  const disk = new Map<string, { draft: string }>();
  const cache = new SessionCache({ get: async (key: string) => disk.get(key), put: async (key: string, value: { draft: string }) => { disk.set(key, structuredClone(value)); }, remove: async (key: string) => { disk.delete(key); } }, value => value.draft.length, 10, 2);
  await cache.set('one', { draft: 'unsaved' }); await cache.set('two', { draft: 'another' }); expect(cache.stats().bytes).toBeLessThanOrEqual(10); expect(disk.get('one')?.draft).toBe('unsaved');
  expect((await cache.get('one'))?.draft).toBe('unsaved'); await cache.set('one', { draft: 'saved' }); expect(disk.has('one')).toBe(false);
  await cache.set('three', { draft: 'third' }); expect(cache.stats().entries).toBeLessThanOrEqual(2);
});
it('keeps drafts and reports failed storage instead of silently losing edits', async () => {
  const cache = new SessionCache({ get: async () => undefined, put: async () => { throw Error('Storage failed'); }, remove: async () => {} }, (value: string) => value.length, 2, 1);
  await cache.set('draft', 'unsaved'); await expect(cache.set('next', 'new')).rejects.toThrow('Storage failed'); expect(cache.peek('draft')).toBe('unsaved');
});
