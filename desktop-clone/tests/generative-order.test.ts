import { describe, expect, it, vi } from 'vitest';
import { HistoryStore } from '../src/main/history';
import { generativeAnswerParts } from '../src/core/generative-parts';
import type { Conversation } from '../src/shared/chat';
import type { ChatExecution, ChatWorkerInput } from '../src/shared/chat';
import { ChatService } from '../src/main/chat-service';
import { ToolBroker } from '../src/main/tool-broker';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import type { ProjectFiles } from '../src/main/files';
import { holdAnswerText } from '../src/core/answer-visibility';

const ui = (type: string, props: Record<string, unknown>) => ({ root: 'main', elements: { main: { type, props, children: [] } } });

function service(history: HistoryStore, execution: ChatExecution, changed: () => void = () => {}) {
  const settings = { ...defaultSettings, local: { ...defaultSettings.local, tools: true, model: 'fixture' }, toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow' as const } };
  const browser = { handoffs: () => [], tasks: () => [] } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, {} as ProjectFiles, changed);
  return new ChatService(history, () => settings, () => '', execution, () => {}, broker);
}

function parts(conversation: Conversation) {
  const message = conversation.messages.at(-1)!;
  return generativeAnswerParts(message, conversation.tools, new Map(conversation.allMessages?.map(item => [item.id, item])));
}
function order(conversation: Conversation) {
  return parts(conversation).map(part => part.type === 'text' ? part.text : part.type === 'tool-call' ? part.toolCallId : part.type);
}
function present(history: HistoryStore, conversationId: string, runId: string, id: string) {
  history.addTool(id, conversationId, runId, 'present', 'Present an interface');
  history.finishTool(id, 'success', JSON.stringify({ ui: { $type: 'Markdown', value: id } }));
}

describe('Generated answer placement', () => {
  it('publishes an immediate tool completion with the entire unflushed text and its widget boundary together', async () => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null, 'chat');
      let chat!: ChatService; const published: Conversation[] = [];
      chat = service(history, { async run(_input, _signal, delta, tool, _reasoning, response) {
        response?.({ type: 'start', lane: 'answer' }); delta('Full'); delta(' answer.');
        response?.({ type: 'tool' }); await tool!({ id: 'inline', name: 'present', input: ui('Text', { value: 'Widget' }) });
        response?.({ type: 'start', lane: 'answer' }); delta('Closing.');
      } }, () => { published.push(chat.update(conversation.id).conversation); });
      chat.start(conversation.id, 'Explain.'); await vi.waitFor(() => expect(chat.library().activeRuns).toHaveLength(0));
      expect(published.filter(conversation => conversation.tools.some(tool => tool.id === 'inline')).map(order)).toEqual([['Full answer.', 'inline']]);
    } finally { history.close(); }
  });
  it('retains streamed answer → preview → widget → closing text through completion, reload and the next model input', async () => {
    const history = new HistoryStore(':memory:');
    let finish!: () => void;
    try {
      const requests: ChatWorkerInput[] = [];
      const chat = service(history, { async run(input, _signal, delta, tool, _reasoning, response) {
        requests.push(input);
        if (requests.length > 1) { delta('Next answer.'); return; }
        response?.({ type: 'start', lane: 'answer' }); delta('The full feasibility analysis.');
        response?.({ type: 'end' }); response?.({ type: 'preparing-tool' }); response?.({ type: 'tool' });
        response?.({ type: 'ui-preview', id: 'suggestions', ui: ui('Text', { value: 'Suggested next questions' }) });
        await tool!({ id: 'suggestions', name: 'present', input: ui('FollowUpGroup', { suggestions: [{ label: 'Explore', message: 'Go deeper.' }] }) });
        response?.({ type: 'start', lane: 'answer' }); delta('Happy to');
        await new Promise<void>(resolve => { finish = resolve; }); delta(' go deeper.');
      } });
      const conversation = history.createConversation(null, 'chat'); chat.start(conversation.id, 'Discuss feasibility.');
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      await vi.waitFor(() => expect(chat.update(conversation.id).conversation.messages.at(-1)?.text).toContain('Happy to'));
      const live = chat.update(conversation.id);
      expect(order(live.conversation)).toEqual(['The full feasibility analysis.', 'suggestions', '\n\nHappy to']);
      expect(holdAnswerText(live.conversation.messages.at(-1)!, live.library.activeRuns[0])).toBe(false);
      finish(); await vi.waitFor(() => expect(chat.library().activeRuns).toHaveLength(0));
      const restored = JSON.parse(JSON.stringify(history.conversation(conversation.id))) as Conversation;
      expect(restored.messages.at(-1)).toMatchObject({ status: 'complete', text: 'The full feasibility analysis.\n\nHappy to go deeper.', presentations: [{ toolId: 'suggestions', offset: 30 }] });
      expect(order(restored)).toEqual(['The full feasibility analysis.', 'suggestions', '\n\nHappy to go deeper.']);
      chat.start(conversation.id, 'Next question.'); await vi.waitFor(() => expect(chat.library().activeRuns).toHaveLength(0));
      expect(requests[1].messages.some(message => message.role === 'assistant' && message.text.includes('The full feasibility analysis.') && message.text.includes('Happy to go deeper.'))).toBe(true);
    } finally { finish?.(); history.close(); }
  });
  it('keeps committed text through later research, excludes commentary and interleaves multiple presentations', async () => {
    const history = new HistoryStore(':memory:');
    try {
      const chat = service(history, { async run(_input, _signal, delta, tool, _reasoning, response) {
        response?.({ type: 'start', lane: 'answer' }); delta('I will search first.'); response?.({ type: 'tool' });
        await tool!({ id: 'research', name: 'search_sources', input: { query: 'evidence' } });
        response?.({ type: 'start', lane: 'answer' }); delta('First answer.');
        response?.({ type: 'tool' }); await tool!({ id: 'first', name: 'present', input: ui('Text', { value: 'First widget' }) });
        response?.({ type: 'start', lane: 'progress' }); delta('More research commentary.'); response?.({ type: 'end' }); response?.({ type: 'tool' });
        await tool!({ id: 'research-2', name: 'search_sources', input: { query: 'more evidence' } });
        response?.({ type: 'start', lane: 'answer' }); delta('Second answer.');
        response?.({ type: 'tool' }); await tool!({ id: 'second', name: 'present', input: ui('Text', { value: 'Second widget' }) });
        response?.({ type: 'start', lane: 'answer' }); delta('Closing.');
      } });
      const conversation = history.createConversation(null, 'chat'); chat.start(conversation.id, 'Explain.');
      await vi.waitFor(() => expect(chat.library().activeRuns).toHaveLength(0));
      expect(order(history.conversation(conversation.id))).toEqual(['First answer.', 'first', '\n\nSecond answer.', 'second', '\n\nClosing.']);
      expect(history.conversation(conversation.id).messages.at(-1)?.text).not.toMatch(/search first|research commentary/);
    } finally { history.close(); }
  });
  it('retains text and positions when stopped, continued, and finished with a presentation alone', async () => {
    const history = new HistoryStore(':memory:');
    try {
      let attempt = 0;
      const chat = service(history, { async run(_input, signal, delta, tool, _reasoning, response) {
        const first = ++attempt === 1;
        response?.({ type: 'start', lane: 'answer' }); delta(first ? 'Saved answer.' : ' Continued answer.');
        response?.({ type: 'tool' }); await tool!({ id: first ? 'first' : 'second', name: 'present', input: ui('Text', { value: 'Widget' }) });
        if (first) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
      } });
      const conversation = history.createConversation(null, 'chat'); chat.start(conversation.id, 'Explain.');
      await vi.waitFor(() => expect(chat.update(conversation.id).conversation.tools.some(tool => tool.id === 'first')).toBe(true));
      await chat.cancel(conversation.id);
      const stopped = history.conversation(conversation.id).messages.at(-1)!;
      expect(stopped).toMatchObject({ text: 'Saved answer.', status: 'cancelled' });
      chat.start(conversation.id, null, [], { type: 'continue', messageId: stopped.id });
      await vi.waitFor(() => expect(chat.library().activeRuns).toHaveLength(0));
      const completed = history.conversation(conversation.id);
      expect(order(completed)).toEqual(['Saved answer.', 'first', '\n\n Continued answer.', 'second']);
      expect(completed.messages.at(-1)?.status).toBe('complete');
    } finally { history.close(); }
  });
  it('keeps a comparison ahead of the following answer during streaming, completion and saved reconstruction', () => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null);
      const turn = history.startTurn(conversation.id, 'Compare the options', 'local');
      present(history, conversation.id, turn.runId, 'comparison');
      expect(order(history.conversation(conversation.id))).toEqual(['comparison']);
      history.saveReply(turn.assistantId, 'Choose ', 'streaming');
      expect(order(history.conversation(conversation.id))).toEqual(['comparison', 'Choose ']);
      history.saveReply(turn.assistantId, 'Choose A.', 'complete');
      const restored = JSON.parse(JSON.stringify(history.conversation(conversation.id))) as Conversation;
      expect(order(restored)).toEqual(['comparison', 'Choose A.']);
      expect(parts(restored)[0]).toMatchObject({ toolCallId: 'comparison', result: { presented: true } });
    } finally { history.close(); }
  });
  it('preserves the order of consecutive widgets instead of moving each behind the answer', () => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null);
      const turn = history.startTurn(conversation.id, 'Compare', 'local');
      for (const id of ['metrics', 'table', 'chart']) present(history, conversation.id, turn.runId, id);
      history.saveReply(turn.assistantId, 'Recommendation.', 'complete');
      expect(order(history.conversation(conversation.id))).toEqual(['metrics', 'table', 'chart', 'Recommendation.']);
    } finally { history.close(); }
  });
  it('keeps earlier widgets with their saved text through multiple continued runs', () => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null);
      let turn = history.startTurn(conversation.id, 'Compare', 'local');
      present(history, conversation.id, turn.runId, 'first');
      history.saveReply(turn.assistantId, 'First answer. ', 'cancelled');
      turn = history.startTurn(conversation.id, null, 'local', [], { type: 'continue', messageId: turn.assistantId });
      present(history, conversation.id, turn.runId, 'second');
      expect(order(history.conversation(conversation.id))).toEqual(['first', 'First answer. ', 'second']);
      history.saveReply(turn.assistantId, 'First answer. Second answer. ', 'cancelled');
      turn = history.startTurn(conversation.id, null, 'local', [], { type: 'continue', messageId: turn.assistantId });
      present(history, conversation.id, turn.runId, 'third');
      history.saveReply(turn.assistantId, 'First answer. Second answer. Last answer.', 'complete');
      expect(order(history.conversation(conversation.id))).toEqual(['first', 'First answer. ', 'second', 'Second answer. ', 'third', 'Last answer.']);
    } finally { history.close(); }
  });
  it('leaves ordinary text intact and handles missing continuation history', () => {
    expect(generativeAnswerParts({ text: 'Plain answer.', runId: 'run', continuationOf: 'missing' }, [])).toEqual([{ type: 'text', text: 'Plain answer.' }]);
  });
});
