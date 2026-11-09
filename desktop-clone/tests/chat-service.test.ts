import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings, type Settings } from '../src/shared/config';
import type { ChatExecution, ChatUpdate, ChatWorkerInput } from '../src/shared/chat';
import { OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE, COMPACTION_OUTPUT_LIMIT_MESSAGE } from '../src/shared/chat';
import { builtInModels } from '../src/shared/managed-local';
const stores: HistoryStore[] = [];
function setup(execution: ChatExecution, initial: Settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'fixture' } }) {
  const history = new HistoryStore(':memory:'); stores.push(history);
  let settings = initial; let secret = 'fixture-key'; const events: ChatUpdate[] = [];
  const chat = new ChatService(history, () => settings, () => secret, execution, update => events.push(update));
  return { history, chat, events, settings: (value: Settings) => { settings = value; }, secret: (value: string) => { secret = value; } };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); });
async function idle(chat: ChatService) { for (let i = 0; i < 100 && chat.library().activeRuns[0]; i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(chat.library().activeRuns[0]).toBeUndefined(); }
describe('Chat orchestration', () => {
  it('protects only the owned model used by a pinned run, even after the selected route changes', async () => {
    const initial = { ...defaultSettings, local: { ...defaultSettings.local, model: builtInModels.included.id } };
    const { history, chat, settings } = setup({ run: async (_input, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })) }, initial);
    const local = history.createConversation(null), cloud = history.createConversation(null); chat.start(local.id, 'Local work');
    settings({ ...initial, route: 'byok', byok: { ...initial.byok, model: 'cloud-fixture' } }); chat.start(cloud.id, 'Cloud work');
    expect(chat.usesOwnedModel('included')).toBe(true); expect(chat.usesOwnedModel('pro')).toBe(false);
    expect(chat.library().activeRuns[0]).not.toHaveProperty('model');
    await chat.cancel(local.id); expect(chat.usesOwnedModel('included')).toBe(false); expect(chat.hasActiveRuns()).toBe(true);
    await chat.cancel(cloud.id);
  });
  it('accepts Send immediately and lets cancellation finish while a shared model continues loading', async () => {
    let release!: () => void; const shared = new Promise<void>(resolve => { release = resolve; }), run = vi.fn(async () => {});
    const { history, chat } = setup({ run });
    chat.prepareRun = async (_input, _signal, activity) => activity('Loading TinyGPT…', () => shared);
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Hello');
    expect(chat.library().activeRuns).toHaveLength(1);
    await vi.waitFor(() => expect(history.conversation(conversation.id).tools[0]).toMatchObject({ name: 'model_load', status: 'running' }));
    await chat.cancel(conversation.id); await idle(chat);
    expect(history.conversation(conversation.id).tools[0].status).toBe('cancelled'); expect(run).not.toHaveBeenCalled(); release();
  });
  it('publishes interface previews without persisting partial tools and removes them on cancellation', async () => {
    const previewId = 'd5d0f18d-9eb4-4529-8da0-e3ea66b8b6ea';
    const { history, chat, events } = setup({ async run(_input, signal, _delta, _tool, _reasoning, response) {
      response?.({ type: 'ui-preview', id: previewId, ui: { $type: 'Text', value: 'Still generating' } });
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Abort')), { once: true }));
    } });
    const conversation = history.createConversation(null, 'chat'); chat.start(conversation.id, 'Show a comparison');
    expect(chat.update(conversation.id).conversation.tools).toEqual([expect.objectContaining({ id: previewId, status: 'running', result: JSON.stringify({ ui: { $type: 'Text', value: 'Still generating' } }) })]);
    expect(history.conversation(conversation.id).tools).toEqual([]);
    await chat.cancel(conversation.id);
    expect(chat.update(conversation.id).conversation.tools).toEqual([]);
    expect(events.at(-1)?.conversation.tools).toEqual([]);
  });
  it('publishes complete Bot bubbles immediately, keeps stable IDs, and reserves a separate typing tail', async () => {
    const history = new HistoryStore(':memory:'); stores.push(history);
    const settings: Settings = { ...defaultSettings, mode: 'bot', local: { ...defaultSettings.local, model: 'fixture' } }, conversation = history.createConversation(null, 'bot');
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    let firstId = '';
    const execution: ChatExecution = { async run(_input, _signal, _delta, _tool, _reasoning, response) {
      response?.({ type: 'bot-messages', messages: ['First complete message.'], complete: false });
      let messages = history.conversation(conversation.id).messages; firstId = messages[1].id;
      expect(messages.slice(1).map(message => [message.text, message.status])).toEqual([['First complete message.', 'complete'], ['', 'streaming']]);
      response?.({ type: 'start', lane: 'answer' }); response?.({ type: 'tool' });
      response?.({ type: 'bot-messages', messages: ['First complete message.', 'Second complete message.'], complete: false });
      response?.({ type: 'bot-messages', messages: ['First complete message.', 'Second complete message.'], complete: false });
      messages = history.conversation(conversation.id).messages; expect(messages).toHaveLength(4); expect(messages[1].id).toBe(firstId);
      expect(messages.slice(1).map(message => [message.text, message.status])).toEqual([['First complete message.', 'complete'], ['Second complete message.', 'complete'], ['', 'streaming']]);
      await waiting;
      response?.({ type: 'bot-messages', messages: ['First complete message.', 'Second complete message.'] });
    } };
    const chat = new ChatService(history, () => settings, () => 'fixture', execution, () => {}, undefined, undefined, undefined, undefined, undefined, false, execution);
    chat.start(conversation.id, 'Check that.'); await vi.waitFor(() => expect(history.conversation(conversation.id).messages).toHaveLength(4));
    expect(chat.library().activeRuns).toHaveLength(1); release(); await idle(chat);
    const messages = history.conversation(conversation.id).messages; expect(messages).toHaveLength(3); expect(messages[1].id).toBe(firstId); expect(messages.slice(1).every(message => message.status === 'complete')).toBe(true);
  });
  it('preserves Bot text across tools and persists multiple native replies as a single turn', async () => {
    const history = new HistoryStore(':memory:'); stores.push(history);
    const settings: Settings = { ...defaultSettings, mode: 'bot', local: { ...defaultSettings.local, model: 'fixture' } };
    const conversation = history.createConversation(null, 'bot');
    const execution: ChatExecution = { async run(_input, _signal, delta, _tool, _reasoning, response) {
      response?.({ type: 'start', lane: 'answer' }); delta('I’ll check.');
      response?.({ type: 'tool' });
      expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('I’ll check.');
      response?.({ type: 'bot-messages', messages: ['I’ll check.', 'Here’s what I found.', 'One more thing.'] });
    } };
    const chat = new ChatService(history, () => settings, () => 'fixture', execution, () => {}, undefined, undefined, undefined, undefined, undefined, false, execution);
    chat.start(conversation.id, 'Check that.'); await idle(chat);
    const messages = history.conversation(conversation.id).messages;
    expect(messages.map(message => message.text)).toEqual(['Check that.', 'I’ll check.', 'Here’s what I found.', 'One more thing.']);
    expect(messages.slice(1).every(message => message.status === 'complete' && message.runId === messages[1].runId)).toBe(true);
    expect(messages[2].parentId).toBe(messages[1].id); expect(messages[3].parentId).toBe(messages[2].id);
    expect(history.conversation(conversation.id).headId).toBe(messages[3].id);
    chat.start(conversation.id, 'Next question.'); await idle(chat);
    expect(history.conversation(conversation.id).messages).toHaveLength(8);
  });
  it('keeps a popped-out empty Chat in Chat mode when the main window switches to Work', async () => {
    let captured!: ChatWorkerInput;
    const { chat, history, settings } = setup({ async run(input, _signal, delta) { captured = input; delta('Pinned Chat reply'); } });
    const conversation = history.createConversation(null, 'chat');
    settings({ ...defaultSettings, mode: 'code', local: { ...defaultSettings.local, model: 'fixture', tools: true } });
    chat.start(conversation.id, 'A floating chat', [], undefined, undefined, true);
    await idle(chat);
    expect(captured.mode).toBe('chat');
    expect(history.conversation(conversation.id)).toMatchObject({ mode: 'chat' });
    expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Pinned Chat reply');
  });
  it('publishes Instant before model work and captures its effort across later setting changes', async () => {
    let finish!: () => void;
    let captured!: ChatWorkerInput;
    const initial = { ...defaultSettings, effort: { chat: 'instant' as const, code: 'max' as const }, local: { ...defaultSettings.local, model: 'fixture', reasoningOverride: { kind: 'ollama' as const, efforts: ['low' as const, 'high' as const], canDisable: true } } };
    const { chat, history, settings } = setup({ async run(input, _signal, delta, _tool, _reasoning, response) {
      captured = input;
      await new Promise<void>(resolve => { finish = resolve; });
      response?.({ type: 'start', lane: 'answer' }); delta('Actual final answer.');
    } }, initial);
    const conversation = history.createConversation(null);
    const started = chat.start(conversation.id, 'Check this.');
    expect(started.library.activeRuns[0]).toMatchObject({ effort: 'instant', phase: 'connecting' });
    expect(captured.effort).toBe('instant'); expect(captured.reasoning).toEqual(initial.local.reasoningOverride);
    expect(captured.instructions).toContain('Do not add a generic acknowledgment or preamble');
    settings({ ...initial, effort: { chat: 'max', code: 'low' } });
    expect(chat.library().activeRuns[0].effort).toBe('instant');
    expect(captured.effort).toBe('instant');
    finish(); await idle(chat);
    expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Actual final answer.');
  });
  it('isolates concurrent progress, context, captured connections and cancellation', async () => {
    const controls = new Map<string, { finish: () => void; delta: (text: string) => void; input: ChatWorkerInput }>();
    const { chat, history, settings, events } = setup({ async run(input, signal, delta, _tool, _thinking, response) {
      response?.({ type: 'start', lane: 'progress' }); delta(`Working on ${input.messages.at(-1)?.text}`); response?.({ type: 'end' });
      await new Promise<void>(resolve => {
        controls.set(input.conversationId!, { finish: resolve, delta, input });
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (!signal.aborted) { response?.({ type: 'start', lane: 'answer' }); delta(`Finished ${input.messages.at(-1)?.text}`); }
    } });
    const a = history.createConversation(null), b = history.createConversation(null);
    chat.start(a.id, 'Alpha');
    settings({ ...defaultSettings, local: { ...defaultSettings.local, model: 'second-model' } });
    chat.start(b.id, 'Beta');
    expect(chat.library().activeRuns.map(run => [run.conversationId, run.prose])).toEqual([[a.id, 'Working on Alpha'], [b.id, 'Working on Beta']]);
    expect(controls.get(a.id)?.input.model).toBe('fixture'); expect(controls.get(b.id)?.input.model).toBe('second-model');
    expect(JSON.stringify(controls.get(b.id)?.input.messages)).not.toContain('Alpha');
    expect(() => chat.start(a.id, 'Overlapping')).toThrow('Stop the current reply');
    await chat.cancel(a.id);
    expect(chat.library().activeRuns.map(run => run.conversationId)).toEqual([b.id]);
    expect(history.conversation(a.id).messages.at(-1)?.status).toBe('cancelled');
    expect(history.conversation(b.id).messages.at(-1)?.status).toBe('streaming');
    controls.get(b.id)!.finish(); await idle(chat);
    expect(history.conversation(b.id).messages.at(-1)).toMatchObject({ status: 'complete', text: 'Finished Beta' });
    expect(events.at(-1)?.library.activeRuns).toEqual([]);
  });
  it('runs Chat and Code together and stops every active task on shutdown', async () => {
    const history = new HistoryStore(':memory:'); stores.push(history);
    let settings: Settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
    const controllers: AbortSignal[] = []; const starts: string[] = [];
    const execution: ChatExecution = { async run(input, signal, delta) { starts.push(input.mode!); controllers.push(signal); delta(`${input.mode} partial`); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } };
    const service = new ChatService(history, () => settings, () => 'fixture', execution, () => {}, undefined, undefined, undefined, undefined, execution);
    const chat = history.createConversation(null); service.start(chat.id, 'Chat task');
    settings = { ...settings, mode: 'code' }; const code = history.createConversation(history.createProject('Work', '', false, process.cwd()).id, 'code');
    service.start(code.id, 'Code task'); expect(starts).toEqual(['chat', 'code']);
    expect(() => service.assertProjectIdle(code.projectId!)).toThrow(); expect(() => service.assertProjectIdle(history.createProject('Unrelated', '').id)).not.toThrow();
    await service.shutdown(); expect(controllers.every(signal => signal.aborted)).toBe(true); expect(service.library().activeRuns).toEqual([]);
    expect(history.conversation(chat.id).messages.at(-1)?.status).toBe('cancelled'); expect(history.conversation(code.id).messages.at(-1)?.status).toBe('cancelled');
    expect(() => service.start(chat.id, 'Late task')).toThrow('shutting down');
  });
  it('keeps action preparation visible when an earlier thinking delta arrives after the transport notification', async () => {
    const { chat, history } = setup({ async run(_input, _signal, delta, _tool, reasoning, response) {
      response?.({ type: 'preparing-tool' }); reasoning?.('Earlier buffered thinking.');
      expect(chat.library().activeRuns[0]?.phase).toBe('tool-input'); expect(history.conversation(conversation.id).tools).toEqual([]);
      response?.({ type: 'start', lane: 'unclassified' }); delta('An earlier prelude.'); expect(chat.library().activeRuns[0]?.phase).toBe('tool-input');
      response?.({ type: 'tool' }); expect(chat.library().activeRuns[0]?.phase).toBe('tool-input');
      response?.({ type: 'start', lane: 'answer' }); delta('Done.');
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Write a file.'); await idle(chat);
    expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Done.');
  });
  it('confines narrated permission metadata to progress cleanup while preserving the final answer', async () => {
    const { chat, history } = setup({ async run(input, _signal, delta, _tool, _reasoning, response) {
      expect(input.instructions).toContain('exclusively inside tool-call JSON arguments');
      response?.({ type: 'start', lane: 'progress' }); delta('Status: Checking the references\n\nPermission: May I read the references?'); response?.({ type: 'end' });
      expect(chat.library().activeRuns[0]?.prose).toBe('Checking the references'); expect(chat.library().approvals).toEqual([]);
      response?.({ type: 'start', lane: 'answer' }); delta('The document contains the label Permission: for its settings.');
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Compare these documents.'); await idle(chat);
    expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('The document contains the label Permission: for its settings.');
  });
  it('preserves a valid checkpoint and gives compaction failures a task-resume instruction', async () => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, _signal, delta) {
      requests.push(input);
      if (requests.length === 1) throw new Error(COMPACTION_OUTPUT_LIMIT_MESSAGE);
      delta('BLUEBIRD answer.');
    } });
    const conversation = history.createConversation(null);
    const old = history.startTurn(conversation.id, 'Remember BLUEBIRD', 'local'); history.saveReply(old.assistantId, 'Recorded old evidence', 'complete');
    history.saveContextCheckpoint(conversation.id, { throughMessageId: old.assistantId, text: 'Valid BLUEBIRD checkpoint.' });
    chat.start(conversation.id, 'What was the goal?'); await idle(chat);
    const saved = history.conversation(conversation.id); const failed = saved.messages.at(-1)!;
    expect(failed).toMatchObject({ status: 'error', error: COMPACTION_OUTPUT_LIMIT_MESSAGE, text: '' });
    expect(history.contextCheckpoint(conversation.id, saved.messages)?.text).toBe('Valid BLUEBIRD checkpoint.');
    expect(saved.messages[1].text).toBe('Recorded old evidence');
    chat.start(conversation.id, null, [], { type: 'continue', messageId: failed.id }); await idle(chat);
    expect(requests[1].messages.at(-1)?.text).toContain('Resume the original task');
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ status: 'complete', text: 'BLUEBIRD answer.' });
  });
  it.each([OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE])('keeps output-limit replies recoverable and forwards the chosen budget (%s)', async error => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, _signal, delta) {
      requests.push(input); delta(requests.length === 1 ? 'Saved partial' : ' and finish.');
      if (requests.length === 1) throw new Error(error);
    } }, { ...defaultSettings, local: { ...defaultSettings.local, model: 'fixture', maxOutputTokens: 6000 } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question'); await idle(chat);
    const original = history.conversation(conversation.id).messages.at(-1)!;
    expect(original).toMatchObject({ text: 'Saved partial', status: 'interrupted', error });
    expect(requests[0].maxOutputTokens).toBe(6000);
    chat.start(conversation.id, null, [], { type: 'continue', messageId: original.id }); await idle(chat);
    if (error === TOOL_OUTPUT_LIMIT_MESSAGE) expect(requests[1].messages.at(-1)?.text).toContain('that incomplete call was not executed');
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Saved partial and finish.', status: 'complete', error: null, continuationOf: original.id });
    expect(history.conversation(conversation.id).allMessages?.find(message => message.id === original.id)?.text).toBe('Saved partial');
  });
  it('persists automatic optimization outside tool activity and replays only the checkpoint tail', async () => {
    const requests: ChatWorkerInput[] = []; let compact = true;
    const { history, chat, events } = setup({ async run(input, _signal, delta, _tool, _reasoning, _response, context) {
      requests.push(input);
      if (compact) {
        const id = input.runId; context?.({ type: 'optimizing', id });
        context?.({ type: 'checkpoint', id, checkpoint: { throughMessageId: input.messages[1].id!, text: 'BLUEBIRD goal. Completed evidence review.' } });
        context?.({ type: 'optimized', id }); compact = false;
      }
      delta('New answer');
    } });
    const conversation = history.createConversation(null); const old = history.startTurn(conversation.id, 'BLUEBIRD goal', 'local'); history.saveReply(old.assistantId, 'Large older answer', 'complete');
    chat.start(conversation.id, 'Recent question'); await idle(chat);
    const saved = history.conversation(conversation.id);
    expect(saved.tools).toEqual([]); expect(saved.contextActivities?.[0].status).toBe('complete');
    expect(events.some(event => event.library.activeRuns[0]?.phase === 'optimizing')).toBe(true);
    chat.start(conversation.id, 'Follow up'); await idle(chat);
    expect(requests[1].checkpoint?.text).toContain('BLUEBIRD');
    expect(requests[1].messages.map(message => message.text)).toEqual(['Recent question', 'New answer', 'Follow up']);
    expect(history.conversation(conversation.id).messages[1].text).toBe('Large older answer');
  });
  it('retains completed and denied tools across a continuation without leaking sibling actions', async () => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, _signal, delta) { requests.push(input); delta('Continued answer'); } });
    const conversation = history.createConversation(null); const first = history.startTurn(conversation.id, 'Write the note', 'local'); history.saveReply(first.assistantId, 'Partial', 'cancelled');
    history.addTool('11111111-1111-4111-8111-111111111111', conversation.id, first.runId, 'write_project_file', 'Write note'); history.finishTool('11111111-1111-4111-8111-111111111111', 'denied', 'Denied by user');
    chat.start(conversation.id, null, [], { type: 'continue', messageId: first.assistantId }); await idle(chat);
    const continued = history.conversation(conversation.id).headId!;
    chat.start(conversation.id, 'Next'); await idle(chat);
    expect(requests[1].messages.map(message => message.text).join('\n')).toContain('write_project_file: denied');
    const user = history.conversation(conversation.id).messages[0];
    chat.start(conversation.id, 'Other branch', [], { type: 'edit', messageId: user.id }); await idle(chat);
    expect(requests[2].messages.map(message => message.text).join('\n')).not.toContain('Write note');
    history.selectBranch(conversation.id, continued);
  });
  it('uses only the selected ancestry for earlier edits and regenerations', async () => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, _signal, delta) { requests.push(input); delta(`Answer ${requests.length}`); } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Original question'); await idle(chat);
    const first = history.conversation(conversation.id); chat.start(conversation.id, 'Later question'); await idle(chat);
    const later = history.conversation(conversation.id).headId!;
    chat.start(conversation.id, 'Edited question', [], { type: 'edit', messageId: first.messages[0].id }); await idle(chat);
    expect(requests[2].messages.map(message => message.text)).toEqual(['Edited question']);
    history.selectBranch(conversation.id, later);
    chat.start(conversation.id, null, [], { type: 'regenerate', messageId: first.messages[1].id }); await idle(chat);
    expect(requests[3].messages.map(message => message.text)).toEqual(['Original question']);
    expect(history.conversation(conversation.id).allMessages).toHaveLength(7);
    expect(() => chat.start(history.createConversation(null).id, null, [], { type: 'regenerate', messageId: first.messages[1].id })).toThrow('Message not found');
  });
  it('continues partial text as a preserved sibling and never drops the saved prefix at response boundaries', async () => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, signal, delta, _tool, _reasoning, response) {
      requests.push(input);
      if (requests.length === 1) { delta('Saved partial'); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Abort')), { once: true })); }
      else { response?.({ type: 'start', lane: 'progress' }); delta('Temporary progress'); response?.({ type: 'tool' }); response?.({ type: 'start', lane: 'answer' }); delta(' and continuation.'); }
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question'); await chat.cancel(conversation.id);
    const original = history.conversation(conversation.id).messages[1];
    chat.start(conversation.id, null, [], { type: 'continue', messageId: original.id }); await idle(chat);
    expect(requests[1].messages.map(message => message.text)).toEqual(['Question', 'Saved partial', expect.stringContaining('Resume the original task using recorded tool outcomes')]);
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Saved partial and continuation.', status: 'complete', continuationOf: original.id });
    expect(history.conversation(conversation.id).allMessages?.find(message => message.id === original.id)).toMatchObject({ text: 'Saved partial', status: 'cancelled' });
    expect(() => chat.start(conversation.id, null, [], { type: 'continue', messageId: history.conversation(conversation.id).headId! })).toThrow('cannot be continued');
  });
  it('streams then saves a completed reply', async () => {
    const { history, chat, events } = setup({ async run(_input, _signal, delta) { delta('Hello '); await new Promise(resolve => setTimeout(resolve, 10)); delta('world'); } });
    const conversation = history.createConversation(null); const started = chat.start(conversation.id, 'Question');
    expect(started.library.activeRuns[0]?.conversationId).toBe(conversation.id); await idle(chat);
    expect(events.some(event => event.conversation.messages.at(-1)?.status === 'streaming')).toBe(true);
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Hello world', status: 'complete' });
  });
  it('marks undecided chunks before publishing them, preserves partial recovery, and commits only the last step', async () => {
    let finish!: () => void;
    const { history, chat, events } = setup({ async run(_input, _signal, delta, tool, _reasoning, response) {
      response?.({ type: 'start', lane: 'unclassified' }); delta('A streamed prelude.');
      await new Promise<void>(resolve => { finish = resolve; });
      response?.({ type: 'tool' });
      await tool!({ id: 'undecided-research', name: 'search_sources', input: { query: 'fixture' } });
      await new Promise(resolve => setTimeout(resolve, 60));
      response?.({ type: 'start', lane: 'unclassified' }); delta('Final streamed answer.');
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question');
    expect(events.at(-1)?.library.activeRuns[0]).toMatchObject({ textLane: 'unclassified', phase: 'prose' });
    expect(events.at(-1)?.conversation.messages.at(-1)?.text).toBe('A streamed prelude.');
    finish(); await idle(chat);
    expect(events.some(event => event.library.activeRuns[0]?.textLane === 'progress' && event.library.activeRuns[0]?.prose === 'A streamed prelude.')).toBe(true);
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Final streamed answer.', status: 'complete' });
    const stopped = setup({ async run(_input, signal, delta, _tool, _reasoning, response) {
      response?.({ type: 'start', lane: 'unclassified' }); delta('Recoverable undecided text.');
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Abort')), { once: true }));
    } });
    const interrupted = stopped.history.createConversation(null); stopped.chat.start(interrupted.id, 'Question');
    await stopped.chat.cancel(interrupted.id);
    expect(stopped.history.conversation(interrupted.id).messages.at(-1)).toMatchObject({ text: 'Recoverable undecided text.', status: 'cancelled' });
  });
  it('streams one replaceable prose update and clears it when an identified final answer begins', async () => {
    let next!: () => void; let stage = 0;
    const pause = () => new Promise<void>(resolve => { next = resolve; stage++; });
    const { history, chat } = setup({ async run(_input, _signal, delta, _tool, _reasoning, response) {
      response?.({ type: 'start', lane: 'progress' }); delta('First complete'); delta(' update.'); await pause();
      response?.({ type: 'end' });
      response?.({ type: 'start', lane: 'progress' }); delta('Second'); await pause();
      delta(' complete update.'); response?.({ type: 'end' }); await pause();
      response?.({ type: 'start', lane: 'answer' }); delta('Final streamed'); await pause(); delta(' answer.');
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question');
    expect(chat.library().activeRuns[0]?.prose).toBe('First complete update.'); next();
    await vi.waitFor(() => expect(stage).toBe(2));
    expect(chat.library().activeRuns[0]?.prose).toBe('Second'); next();
    await vi.waitFor(() => expect(stage).toBe(3));
    expect(chat.library().activeRuns[0]?.prose).toBe('Second complete update.'); next();
    await vi.waitFor(() => expect(stage).toBe(4));
    expect(chat.library().activeRuns[0]?.prose).toBe('');
    await vi.waitFor(() => expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Final streamed')); next(); await idle(chat);
    expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Final streamed answer.');
  });
  it('stop preserves partial text and releases the active run for retry', async () => {
    const { history, chat } = setup({ async run(_input, signal, delta) { delta('Saved partial'); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Abort')), { once: true })); } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question');
    expect(() => chat.start(conversation.id, 'Another question')).toThrow('Stop the current reply');
    const cancelled = await chat.cancel(conversation.id);
    expect(cancelled.conversation.messages.at(-1)).toMatchObject({ text: 'Saved partial', status: 'cancelled' });
    expect(cancelled.library.activeRuns[0]).toBeUndefined();
  });
  it('flushes the trailing chunk while the provider is still waiting', async () => {
    let finish!: () => void;
    const { history, chat, events } = setup({ async run(_input, _signal, delta) {
      delta('First'); delta(' trailing chunk');
      await new Promise<void>(resolve => { finish = resolve; });
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(chat.library().activeRuns[0]).toBeDefined();
    expect(events.at(-1)?.conversation.messages.at(-1)?.text).toBe('First trailing chunk');
    finish(); await idle(chat);
  });
  it('saves provider reasoning separately and excludes it from the next model input', async () => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, _signal, delta, _tool, reasoning) {
      requests.push(input); reasoning?.('Provider reasoning summary.'); delta('Answer.');
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question'); await idle(chat);
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Answer.', reasoning: 'Provider reasoning summary.' });
    chat.start(conversation.id, 'Next question'); await idle(chat);
    expect(JSON.stringify(requests[1].messages)).not.toContain('Provider reasoning');
  });
  it('overwrites progress prose, saves only the final answer, and freezes work time at its first token', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    let finish!: () => void;
    let finalStarted!: () => void; const atFinal = new Promise<void>(resolve => { finalStarted = resolve; });
    const requests: ChatWorkerInput[] = [];
    const { history, chat, events } = setup({ async run(input, _signal, delta, tool, _reasoning, response) {
      requests.push(input);
      if (requests.length > 1) { delta('Next answer'); return; }
      response?.({ type: 'start', lane: 'answer' }); delta('First progress update.');
      clock.mockReturnValue(1100); response?.({ type: 'tool' });
      await tool!({ id: 'first-research', name: 'search_sources', input: { query: 'fixture' } });
      await new Promise(resolve => setTimeout(resolve, 60));
      clock.mockReturnValue(1200); response?.({ type: 'start', lane: 'progress' }); delta('Second progress'); delta(' update.'); response?.({ type: 'end' });
      await new Promise(resolve => setTimeout(resolve, 60));
      clock.mockReturnValue(1300); response?.({ type: 'tool' });
      await tool!({ id: 'second-research', name: 'search_sources', input: { query: 'fixture' } });
      clock.mockReturnValue(1500); response?.({ type: 'start', lane: 'answer' }); delta('Clean final');
      finalStarted();
      await new Promise<void>(resolve => { finish = resolve; });
      clock.mockReturnValue(9000); delta(' answer.');
    } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question');
    await atFinal;
    expect(events.some(event => event.library.activeRuns[0]?.prose === 'First progress update.' && event.conversation.messages.at(-1)?.text === '')).toBe(true);
    expect(events.some(event => event.library.activeRuns[0]?.prose === 'Second progress update.' && event.conversation.messages.at(-1)?.text === '')).toBe(true);
    expect(chat.library().activeRuns[0]?.prose).toBe('');
    await vi.waitFor(() => expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Clean final'));
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Clean final', workDurationMs: 500 });
    finish(); await idle(chat);
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Clean final answer.', workDurationMs: 500 });
    chat.start(conversation.id, 'Next question'); await idle(chat);
    expect(JSON.stringify(requests[1].messages)).not.toContain('progress update');
  });
  it('captures connection and key per reply and applies only its own Project instructions', async () => {
    const requests: ChatWorkerInput[] = [];
    const state = setup({ async run(input, _signal, delta) { requests.push(input); await new Promise(resolve => setTimeout(resolve, 10)); delta('Done'); } });
    const a = state.history.createProject('First', 'scope-one'); state.history.createProject('Second', 'scope-two');
    const conversation = state.history.createConversation(a.id); state.chat.start(conversation.id, 'Hello');
    state.settings({ ...defaultSettings, route: 'byok', byok: { ...defaultSettings.byok, model: 'changed' } }); state.secret('changed-key');
    await idle(state.chat);
    expect(requests[0]).toMatchObject({ route: 'local', model: 'fixture', secret: 'fixture-key' });
    expect(requests[0].instructions).toContain('scope-one'); expect(requests[0].instructions).not.toContain('scope-two');
    const personal = state.history.createConversation(null); state.chat.start(personal.id, 'Personal'); await idle(state.chat);
    expect(requests[1].instructions).not.toContain('scope-one'); expect(requests[1].messages).toMatchObject([{ role: 'user', text: 'Personal' }]);
  });
  it('retry sends prior history and the last question, excluding the replaced answer', async () => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, _signal, delta) { requests.push(input); delta(`Answer ${requests.length}`); } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question one'); await idle(chat); chat.start(conversation.id, 'Question two'); await idle(chat); chat.start(conversation.id, null); await idle(chat);
    expect(requests[2].messages).toMatchObject([{ role: 'user', text: 'Question one' }, { role: 'assistant', text: 'Answer 1' }, { role: 'user', text: 'Question two' }]);
    expect(history.conversation(conversation.id).messages.map(message => message.text)).toEqual(['Question one', 'Answer 1', 'Question two', 'Answer 3']);
  });
  it('never stores arbitrary upstream failures containing secrets', async () => {
    const { history, chat, events } = setup({ async run() { throw new Error('fixture-key-private-upstream'); } });
    const conversation = history.createConversation(null); chat.start(conversation.id, 'Question'); await idle(chat);
    expect(history.conversation(conversation.id).messages.at(-1)?.status).toBe('error');
    expect(JSON.stringify(events)).not.toContain('fixture-key'); expect(JSON.stringify(history.conversation(conversation.id))).not.toContain('private-upstream');
  });
  it.each(['portal', 'bot', 'no-model', 'no-key'] as const)('blocks unready %s without writing a turn or calling inference', async reason => {
    let requests = 0; const state = setup({ async run() { requests++; } });
    state.settings({ ...defaultSettings, route: reason === 'portal' ? 'portal' : reason === 'no-key' ? 'byok' : 'local', mode: reason === 'bot' ? 'bot' : 'chat', byok: { ...defaultSettings.byok, model: 'fixture' } });
    if (reason === 'no-key') state.secret('');
    const conversation = state.history.createConversation(null); expect(() => state.chat.start(conversation.id, 'Question')).toThrow();
    expect(requests).toBe(0); expect(state.history.conversation(conversation.id).messages).toEqual([]);
  });
  it('allows legacy oversized history to reach automatic context management', async () => {
    const requests: ChatWorkerInput[] = [];
    const { history, chat } = setup({ async run(input, _signal, delta) { requests.push(input); delta('Recovered'); } });
    const conversation = history.createConversation(null); const turn = history.startTurn(conversation.id, 'Earlier', 'local'); history.saveReply(turn.assistantId, 'x'.repeat(120000), 'complete');
    chat.start(conversation.id, 'Next'); await idle(chat); expect(requests[0].messages.some(message => message.text.length === 120000)).toBe(true); expect(history.conversation(conversation.id).messages).toHaveLength(4);
  });
});
