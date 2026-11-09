import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { ConversationDescriptions, type DescriptionConnection } from '../src/main/conversation-descriptions';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import { descriptionTranscript, parseDescription } from '../src/core/conversation-description';
import { matchesConversation } from '../src/shared/conversation-search';
import type { ChatExecution, ChatWorkerInput } from '../src/shared/chat';

const connection: DescriptionConnection = { route: 'local', endpoint: 'http://localhost:8080/v1', model: 'local-model', provider: 'local', protocol: 'openai-compatible' };
const result = { title: 'TinyGPT sidebar and Bot customization', summary: 'Refining TinyGPT navigation, conversation previews, and a customizable Bot.', topicChanged: false };
const stores: HistoryStore[] = []; const services: ConversationDescriptions[] = [];
function setup(execution: ChatExecution = { async run(_input, _signal, delta) { delta(JSON.stringify(result)); } }) {
  vi.useFakeTimers(); const history = new HistoryStore(':memory:'); stores.push(history);
  const changed = vi.fn(); const descriptions = new ConversationDescriptions(history, execution, changed); services.push(descriptions);
  const chat = history.createConversation(null);
  const turn = () => { const next = history.startTurn(chat.id, 'Improve the sidebar and Bot designer', 'local'); history.saveReply(next.assistantId, 'Added the sidebar and customization controls.', 'complete'); return next; };
  turn(); return { history, descriptions, changed, chat, turn };
}
afterEach(async () => { for (const service of services.splice(0)) await service.shutdown(); for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });
async function run(service: ConversationDescriptions, id: string, config = connection) { service.schedule(id, config); await vi.advanceTimersByTimeAsync(751); }

describe('background conversation descriptions', () => {
  it('capitalizes automatic titles without changing the rest of the title or a manual name', async () => {
    const lower = { ...result, title: 'sticky notes with MiniCPM' };
    const { history, descriptions, chat } = setup({ async run(_input, _signal, delta) { delta(JSON.stringify(lower)); } });
    await run(descriptions, chat.id);
    expect(history.conversation(chat.id).title).toBe('Sticky notes with MiniCPM');
    expect(history.conversations()[0].title).toBe('Sticky notes with MiniCPM');
    history.renameConversation(chat.id, 'my lower case name');
    expect(history.conversation(chat.id).title).toBe('my lower case name');
    expect(history.conversations()[0].title).toBe('my lower case name');
    const fallback = history.createConversation(null); history.startTurn(fallback.id, 'a quick conversation', 'local');
    expect(history.conversation(fallback.id).title).toBe('A quick conversation');
    for (const [title, expected] of [['écrire avec MiniCPM', 'Écrire avec MiniCPM'], ['💬 sticky notes', '💬 Sticky notes'], ['中文笔记', '中文笔记']]) expect(parseDescription(JSON.stringify({ ...lower, title })).title).toBe(expected);
  });
  it('uses the captured connection without tools, instructions, files or hidden reasoning and does not reorder chats', async () => {
    let request!: ChatWorkerInput; const { history, descriptions, changed, chat } = setup({ async run(input, _signal, delta) { request = input; delta(JSON.stringify(result)); } });
    const before = history.conversations()[0]; await run(descriptions, chat.id);
    expect(request).toMatchObject({ ...connection, purpose: 'metadata', tools: false, maxOutputTokens: 512 });
    expect(request.projectRoot).toBeUndefined(); expect(request.extensionTools).toBeUndefined(); expect(request.checkpoint).toBeUndefined();
    expect(JSON.parse(request.messages[0].text).transcript.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(history.conversations()[0]).toMatchObject({ title: result.title, summary: result.summary, updatedAt: before.updatedAt, unread: before.unread });
    expect(history.conversation(chat.id).messages).toHaveLength(2); expect(changed).toHaveBeenCalledOnce();
    await run(descriptions, chat.id); expect(changed).toHaveBeenCalledOnce();
    expect(matchesConversation(history.conversation(chat.id), 'conversation previews')).toBe(true);
  });
  it('protects manual names before the first prompt and while generation is pending', async () => {
    let finish!: () => void; const { history, descriptions, chat, changed } = setup({ async run(_input, _signal, delta) { await new Promise<void>(resolve => { finish = resolve; }); delta(JSON.stringify(result)); } });
    descriptions.schedule(chat.id, connection); await vi.advanceTimersByTimeAsync(751);
    history.renameConversation(chat.id, 'My UI notes'); finish(); await vi.advanceTimersByTimeAsync(0);
    expect(history.conversation(chat.id).title).toBe('My UI notes'); expect(changed).not.toHaveBeenCalled();
    const empty = history.createConversation(null); history.renameConversation(empty.id, 'Private label'); history.startTurn(empty.id, 'First prompt', 'local'); expect(history.conversation(empty.id).title).toBe('Private label');
  });
  it('still updates summaries for manually named chats', async () => {
    const { history, descriptions, chat } = setup(); history.renameConversation(chat.id, 'My UI notes'); await run(descriptions, chat.id);
    expect(history.conversation(chat.id)).toMatchObject({ title: 'My UI notes', summary: result.summary });
  });
  it('keeps only the final JSON when a provider emits progress before its answer', async () => {
    const { history, descriptions, chat } = setup({ async run(_input, _signal, delta, _tool, _reasoning, response) {
      response?.({ type: 'start', lane: 'progress' }); delta('Preparing a description.');
      response?.({ type: 'start', lane: 'answer' }); delta(JSON.stringify(result));
    } });
    await run(descriptions, chat.id); expect(history.conversation(chat.id).summary).toBe(result.summary);
  });
  it('keeps titles stable on follow-ups and limits mature summary refreshes', async () => {
    let count = 0; const { history, descriptions, chat, turn } = setup({ async run(_input, _signal, delta) { count++; delta(JSON.stringify({ ...result, title: `Unnecessary title ${count}` })); } });
    await run(descriptions, chat.id); expect(history.conversation(chat.id).title).toBe('Unnecessary title 1');
    for (let i = 2; i <= 11; i++) { turn(); await run(descriptions, chat.id); }
    expect(count).toBe(5); expect(history.descriptionState(chat.id)?.completedTurns).toBe(11); expect(history.conversation(chat.id).title).toBe('Unnecessary title 1');
  });
  it('revises a misleading early title and a substantial later topic change', async () => {
    let count = 0; const { history, descriptions, chat, turn } = setup({ async run(_input, _signal, delta) { count++; delta(JSON.stringify({ ...result, title: `Specific topic ${count}`, topicChanged: true })); } });
    await run(descriptions, chat.id); turn(); await run(descriptions, chat.id); expect(history.conversation(chat.id).title).toBe('Specific topic 2');
    turn(); await run(descriptions, chat.id);
    for (let i = 4; i <= 11; i++) { turn(); await run(descriptions, chat.id); }
    expect(history.conversation(chat.id).title).toBe('Specific topic 5');
  });
  it('preempts generation for foreground work and resumes from the latest branch', async () => {
    let count = 0; let aborted = false; const { history, descriptions, chat, turn } = setup({ async run(_input, signal, delta) {
      count++; if (count === 1) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('Cancelled')); }, { once: true })); else delta(JSON.stringify(result));
    } });
    descriptions.schedule(chat.id, connection); await vi.advanceTimersByTimeAsync(751); descriptions.pause(); turn(); await vi.advanceTimersByTimeAsync(1000);
    expect(aborted).toBe(true); expect(count).toBe(1); expect(history.conversation(chat.id).summary).toBeNull();
    descriptions.resume(); await vi.advanceTimersByTimeAsync(751); expect(history.conversation(chat.id).summary).toBe(result.summary);
  });
  it.each(['branch', 'delete'])('discards late results after %s', async action => {
    let finish!: () => void; const { history, descriptions, chat, changed } = setup({ async run(_input, _signal, delta) { await new Promise<void>(resolve => { finish = resolve; }); delta(JSON.stringify(result)); } });
    descriptions.schedule(chat.id, connection); await vi.advanceTimersByTimeAsync(751);
    if (action === 'branch') history.selectBranch(chat.id, history.conversation(chat.id).messages[0].id); else history.deleteConversation(chat.id);
    finish(); await vi.advanceTimersByTimeAsync(0); expect(changed).not.toHaveBeenCalled();
  });
  it('hides an old-branch summary after editing and does not accept ABA branch switches', async () => {
    const { history, descriptions, chat, turn } = setup(); await run(descriptions, chat.id);
    const state = history.descriptionState(chat.id)!; const saved = history.conversation(chat.id);
    history.selectBranch(chat.id, saved.messages[0].id); expect(history.conversation(chat.id).summary).toBeNull();
    history.selectBranch(chat.id, state.headId!); expect(history.saveDescription(chat.id, { headId: state.headId!, revision: state.revision }, result, 1, true)).toBe(false);
    await run(descriptions, chat.id); turn(); const latest = history.conversation(chat.id);
    history.startTurn(chat.id, 'A different request', 'local', [], { type: 'edit', messageId: latest.messages[0].id }); expect(history.conversation(chat.id).summary).toBeNull();
  });
  it.each(['bad-json', 'timeout', 'provider'])('leaves the fallback intact on %s and throttles retries', async failure => {
    let count = 0; const { history, descriptions, chat, changed } = setup({ async run(_input, signal, delta) { count++; if (failure === 'provider') throw new Error('Unavailable'); if (failure === 'timeout') await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })); else delta('not JSON'); } });
    await run(descriptions, chat.id); if (failure === 'timeout') await vi.advanceTimersByTimeAsync(30001);
    await run(descriptions, chat.id); expect(count).toBe(1); expect(changed).not.toHaveBeenCalled(); expect(history.conversation(chat.id).title).toBe('Improve the sidebar and Bot designer');
  });
  it('does not send local history to a remote route or generate for incomplete replies', async () => {
    const execution = { run: vi.fn(async () => {}) }; const { history, descriptions, chat } = setup(execution);
    await run(descriptions, chat.id, { ...connection, route: 'byok' });
    history.startTurn(chat.id, 'Unfinished request', 'local'); await run(descriptions, chat.id); expect(execution.run).not.toHaveBeenCalled();
  });
  it('retries a ready local endpoint without waiting out the failed startup cooldown', async () => {
    let attempts = 0;
    const { history, descriptions, chat } = setup({ async run(_input, _signal, delta) { if (++attempts === 1) throw new Error('Local server not ready'); delta(JSON.stringify(result)); } });
    await run(descriptions, chat.id); await run(descriptions, chat.id);
    expect(attempts).toBe(1);
    await run(descriptions, chat.id, { ...connection, endpoint: 'http://localhost:8081/v1' });
    expect(attempts).toBe(2); expect(history.conversation(chat.id).summary).toBe(result.summary);
  });
  it('describes normal final replies in both Chat and Work', async () => {
    const { history, chat: saved } = setup(); const requests: ChatWorkerInput[] = [];
    const execution: ChatExecution = { async run(input, _signal, delta) { requests.push(input); delta(input.purpose ? JSON.stringify(result) : 'Helpful reply.'); } };
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'fixture', reasoningOverride: { kind: 'llamacpp' as const, efforts: [], canDisable: true } } };
    const chat = new ChatService(history, () => settings, () => undefined, execution, () => {}, undefined, undefined, undefined, undefined, execution, true);
    chat.start(saved.id, 'Improve this design'); await vi.advanceTimersByTimeAsync(751);
    expect(requests.map(request => request.purpose)).toEqual([undefined, 'metadata']); expect(requests[1].model).toBe('fixture');
    expect(requests[1].reasoning).toEqual(settings.local.reasoningOverride);
    settings.mode = 'code'; settings.local.tools = true;
    const project = history.createProject('Work project', '', false, tmpdir()); const work = history.createConversation(project.id, 'code');
    chat.start(work.id, 'Build the Bot designer'); await vi.advanceTimersByTimeAsync(751);
    expect(requests[2].mode).toBe('code'); expect(requests).toHaveLength(4); expect(requests[3].purpose).toBe('metadata'); expect(history.conversation(work.id).messages.at(-1)?.workTask?.status).toBe('completed');
    await chat.shutdown();
  });
  it('captures discovered local reasoning capabilities when opening a saved chat', async () => {
    const { history, chat: saved } = setup();
    const requests: ChatWorkerInput[] = [];
    const execution: ChatExecution = { async run(input, _signal, delta) { requests.push(input); delta(JSON.stringify(result)); } };
    const reasoning = { kind: 'llamacpp' as const, efforts: [], canDisable: true };
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'fixture', modelCapabilities: { model: 'fixture', reasoning } } };
    const chat = new ChatService(history, () => settings, () => undefined, execution, () => {}, undefined, undefined, undefined, undefined, undefined, true);
    chat.describe(saved.id); await vi.advanceTimersByTimeAsync(751);
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ purpose: 'metadata', provider: 'local', reasoning, tools: false });
    expect(history.conversation(saved.id).summary).toBe(result.summary);
    await chat.shutdown();
  });
  it('waits for every foreground conversation before resuming descriptions', async () => {
    const { history } = setup(); const requests: ChatWorkerInput[] = []; const finish = new Map<string, () => void>();
    const execution: ChatExecution = { async run(input, _signal, delta) { requests.push(input); if (!input.purpose) await new Promise<void>(resolve => { finish.set(input.conversationId!, resolve); }); delta(input.purpose ? JSON.stringify(result) : 'Helpful reply.'); } };
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'fixture' } };
    const chat = new ChatService(history, () => settings, () => undefined, execution, () => {}, undefined, undefined, undefined, undefined, undefined, true);
    const first = history.createConversation(null); const second = history.createConversation(null);
    chat.start(first.id, 'Explain sidebar navigation'); chat.start(second.id, 'Customize the Bot');
    finish.get(first.id)!(); await vi.advanceTimersByTimeAsync(2000); expect(requests).toHaveLength(2);
    finish.get(second.id)!(); await vi.advanceTimersByTimeAsync(1502); expect(requests.filter(request => request.purpose)).toHaveLength(2);
    await chat.shutdown();
  });
});

describe('description persistence and bounded evidence', () => {
  it('migrates legacy manual titles conservatively and persists metadata across restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tinygpt-descriptions-')); const path = join(directory, 'library.sqlite');
    let history: HistoryStore | undefined;
    try {
      history = new HistoryStore(path); const auto = history.createConversation(null); const manual = history.createConversation(null);
      for (const chat of [auto, manual]) { const turn = history.startTurn(chat.id, 'First  prompt\nwith spaces', 'local'); history.saveReply(turn.assistantId, 'Reply', 'complete'); }
      history.renameConversation(manual.id, 'Chosen name'); history.close(); history = undefined;
      const db = new DatabaseSync(path); db.exec('DROP TABLE conversation_descriptions; ALTER TABLE conversations DROP COLUMN title_source; ALTER TABLE conversations DROP COLUMN description_revision; PRAGMA user_version=13;'); db.close();
      history = new HistoryStore(path); expect(history.descriptionState(auto.id)?.titleSource).toBe('fallback'); expect(history.descriptionState(manual.id)?.titleSource).toBe('manual');
      const state = history.descriptionState(auto.id)!; expect(history.saveDescription(auto.id, { headId: state.headId!, revision: state.revision }, result, 1, true)).toBe(true);
      history.close(); history = undefined;
      const oldTitles = new DatabaseSync(path); oldTitles.prepare('UPDATE conversations SET title=? WHERE id=?').run('tinyGPT sidebar and Bot customization', auto.id); oldTitles.exec("DELETE FROM metadata WHERE key='capitalized-conversation-titles-v1'"); oldTitles.close();
      history = new HistoryStore(path); expect(history.conversation(auto.id)).toMatchObject({ title: result.title, summary: result.summary }); expect(history.conversation(manual.id).title).toBe('Chosen name');
      expect(history.conversations().find(item => item.id === auto.id)?.title).toBe(result.title);
    } finally { history?.close(); if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('tinygpt-descriptions-')) throw new Error('Unexpected test directory.'); rmSync(directory, { recursive: true, force: true }); }
  });
  it('bounds long transcripts and rejects malformed or oversized descriptions', () => {
    const { history, chat, turn } = setup(); for (let i = 0; i < 20; i++) turn();
    const messages = history.conversation(chat.id).messages.map(message => ({ ...message, text: message.text.repeat(2000), reasoning: 'SECRET THOUGHTS' }));
    const transcript = descriptionTranscript(messages); expect(transcript).toHaveLength(8); expect(JSON.stringify(transcript).length).toBeLessThan(6600); expect(JSON.stringify(transcript)).not.toContain('SECRET THOUGHTS');
    expect(parseDescription('```json\n' + JSON.stringify(result) + '\n```')).toEqual(result);
    expect(() => parseDescription(JSON.stringify({ ...result, summary: 'x'.repeat(281) }))).toThrow(); expect(() => parseDescription(JSON.stringify({ ...result, title: 'two\nlines' }))).toThrow();
  });
});
