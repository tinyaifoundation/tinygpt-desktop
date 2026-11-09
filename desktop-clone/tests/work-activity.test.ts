import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { WorkActivityRecorder, workBlocks, workSteeringMessageIds, workToolSummary, WORK_DISPLAY_CHARACTER_LIMIT } from '../src/core/work-activity';
import { CodeStream } from '../src/core/code-stream';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import { OUTPUT_LIMIT_MESSAGE, type ChatExecution, type ChatMessage, type ChatWorkerInput, type ContextActivity } from '../src/shared/chat';
import type { ToolBroker } from '../src/main/tool-broker';

it('bounds Work notes without losing tool ordering, replay safety or the final answer', () => {
  const recorder = new WorkActivityRecorder('run');
  recorder.part('old', 'reasoning', 'a'.repeat(WORK_DISPLAY_CHARACTER_LIMIT)); recorder.tool('write');
  recorder.part('recent', 'prose', 'b'.repeat(WORK_DISPLAY_CHARACTER_LIMIT));
  const beforeReplay = recorder.snapshot();
  expect(beforeReplay.find(entry => entry.id === 'run:old')).toMatchObject({ text: '', omittedCharacters: WORK_DISPLAY_CHARACTER_LIMIT });
  recorder.part('old', 'reasoning', 'a'.repeat(WORK_DISPLAY_CHARACTER_LIMIT));
  expect(recorder.snapshot()).toEqual(beforeReplay);
  recorder.part('recent', 'prose', 'b'.repeat(WORK_DISPLAY_CHARACTER_LIMIT - 1));
  expect(recorder.snapshot()).toEqual(beforeReplay);
  recorder.part('recent', 'prose', 'b'.repeat(WORK_DISPLAY_CHARACTER_LIMIT) + 'continued');
  const restored = new WorkActivityRecorder('next', recorder.snapshot());
  restored.part('final', 'prose', 'Finished successfully.');
  expect(restored.complete(['final'])).toBe('Finished successfully.');
  expect(restored.snapshot().reduce((size, entry) => size + (['prose', 'reasoning'].includes(entry.kind) ? entry.text.length : 0), 0)).toBeLessThanOrEqual(WORK_DISPLAY_CHARACTER_LIMIT);
  const blocks = workBlocks(restored.snapshot(), [{ id: 'write', name: 'code_write' } as ToolActivity]);
  expect(blocks.filter(block => block.id === 'work-display-omitted')).toHaveLength(1);
  expect(blocks.some(block => block.kind === 'tools' && block.tools.some(tool => tool.id === 'write'))).toBe(true);
});

it('accepts bounded native stream snapshots with increasing original offsets', () => {
  const recorder = new WorkActivityRecorder('run');
  recorder.part('part', 'reasoning', 'abc');
  recorder.part('part', 'reasoning', 'cde', undefined, undefined, 2);
  expect(recorder.snapshot()[0]).toMatchObject({ text: 'cde', omittedCharacters: 2 });
  recorder.part('part', 'reasoning', 'abcdef');
  expect(recorder.snapshot()[0]).toMatchObject({ text: 'cdef', omittedCharacters: 2 });
  recorder.part('part', 'reasoning', 'xyz', undefined, undefined, 100);
  expect(recorder.snapshot()[0]).toMatchObject({ text: 'xyz', omittedCharacters: 100 });
});

it('preserves the single-reply display guard in Chat', async () => {
  const history = new HistoryStore(':memory:');
  const conversation = history.createConversation(null, 'chat');
  const execution: ChatExecution = { async run(_input, _signal, _delta, _tool, reasoning) { reasoning?.('x'.repeat(500001)); } };
  const settings = { ...defaultSettings, route: 'local' as const, local: { ...defaultSettings.local, model: 'fixture' } };
  const service = new ChatService(history, () => settings, () => undefined, execution, () => {});
  try {
    service.start(conversation.id, 'Hello.');
    await vi.waitFor(() => expect(service.library().activeRuns).toHaveLength(0));
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ status: 'error', error: 'The reply exceeded the supported size.' });
  } finally { await service.shutdown(); history.close(); }
});
import type { ToolActivity } from '../src/shared/tools';

describe('Recorded Work responses', () => {
  it('keeps unclassified Work prose in the chain until native final confirmation', async () => {
    const history = new HistoryStore(':memory:');
    const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
    const conversation = history.createConversation(null, 'code');
    let controls: { prose(id: string, text: string): void; tool(): void; confirm(): void; finish(): void } | undefined;
    const execution: ChatExecution = { run(_input, _signal, delta, _tool, _reasoning, response) {
      return new Promise<void>(resolve => { controls = {
        prose(id, text) { response?.({ type: 'start', lane: 'progress' }); delta(text); response?.({ type: 'work-part', id, kind: 'prose', text }); },
        tool() { response?.({ type: 'preparing-tool' }); response?.({ type: 'work-part', id: 'child', kind: 'prose', text: 'Delegated coding progress.' }); },
        confirm() { response?.({ type: 'work-complete', answerPartIds: ['final'] }); response?.({ type: 'end' }); },
        finish: resolve,
      }; });
    } };
    const service = new ChatService(history, () => settings, () => undefined, execution, () => {}, undefined, undefined, undefined, undefined, execution);
    try {
      service.start(conversation.id, 'Do it.'); await vi.waitFor(() => expect(controls).toBeDefined());
      for (const [id, text] of [['intro', 'Inspecting.'], ['between', 'Checking the result.'], ['final', 'Done.']]) {
        controls!.prose(id, text);
        await vi.waitFor(() => expect(history.conversation(conversation.id).messages.at(-1)?.workActivity?.some(part => part.text === text)).toBe(true));
        const reply = history.conversation(conversation.id).messages.at(-1)!;
        expect(reply.text).toBe(''); expect(reply.workActivity?.some(part => part.answer)).toBe(false);
        expect(service.library().activeRuns[0].hasVisibleAnswer).not.toBe(true);
        expect(service.library().activeRuns[0].phase).not.toBe('answer');
        if (id !== 'final') controls!.tool();
      }
      controls!.confirm();
      await vi.waitFor(() => expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Done.'));
      expect(service.library().activeRuns[0]).toMatchObject({ phase: 'answer', hasVisibleAnswer: true });
      expect(history.conversation(conversation.id).messages.at(-1)?.status).toBe('streaming');
      controls!.finish(); await vi.waitFor(() => expect(service.library().activeRuns).toEqual([]));
      const reply = history.conversation(conversation.id).messages.at(-1)!;
      expect(reply.text).toBe('Done.'); expect(reply.workActivity?.filter(part => part.answer).map(part => part.text)).toEqual(['Done.']);
    } finally { await service.shutdown(); history.close(); }
  });
  it('supports explicitly identified answer streams while retaining progress if tools follow', async () => {
    const history = new HistoryStore(':memory:');
    const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
    const conversation = history.createConversation(null, 'code');
    let controls: { answer: (id: string, text: string) => void; tool: () => void; finish: () => void } | undefined;
    const execution: ChatExecution = { run(_input, _signal, delta, _tool, _reasoning, response) {
      return new Promise<void>(resolve => { controls = {
        answer: (id, text) => { response?.({ type: 'start', lane: 'answer' }); delta(text); response?.({ type: 'work-part', id, kind: 'prose', text }); },
        tool: () => { response?.({ type: 'preparing-tool' }); response?.({ type: 'work-part', id: 'delegated', kind: 'prose', text: 'Coding progress.' }); },
        finish: () => { response?.({ type: 'work-complete', answerPartIds: ['final'] }); resolve(); },
      }; });
    } };
    const service = new ChatService(history, () => settings, () => undefined, execution, () => {}, undefined, undefined, undefined, undefined, execution);
    try {
      service.start(conversation.id, 'Do it.'); await vi.waitFor(() => expect(controls).toBeDefined());
      controls!.answer('intro', 'Inspecting.');
      await vi.waitFor(() => expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Inspecting.'));
      expect(service.library().activeRuns[0].hasVisibleAnswer).toBe(true);
      controls!.tool();
      await vi.waitFor(() => expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe(''));
      expect(service.library().activeRuns[0].hasVisibleAnswer).toBe(false);
      expect(history.conversation(conversation.id).messages.at(-1)?.workActivity?.every(part => !part.answer)).toBe(true);
      controls!.answer('final', 'Done.');
      await vi.waitFor(() => expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('Done.'));
      expect(service.library().activeRuns[0].hasVisibleAnswer).toBe(true);
      expect(history.conversation(conversation.id).messages.at(-1)?.status).toBe('streaming');
      controls!.finish(); await vi.waitFor(() => expect(service.library().activeRuns).toEqual([]));
      const reply = history.conversation(conversation.id).messages.at(-1)!;
      expect(reply.text).toBe('Done.'); expect(reply.workActivity?.filter(part => part.answer).map(part => part.text)).toEqual(['Done.']);
    } finally { await service.shutdown(); history.close(); }
  });
  it('places compaction between the steps where it ran and updates it without duplicates', () => {
    const recorder = new WorkActivityRecorder('run');
    recorder.part('before', 'prose', 'Before optimization.', 100);
    recorder.part('after', 'prose', 'After optimization.', 300);
    const context: ContextActivity = { id: 'compact', runId: 'run', status: 'running', createdAt: 200 };
    expect(workBlocks(recorder.snapshot(), [], [context]).map(block => block.kind)).toEqual(['prose', 'context', 'prose']);
    const complete = { ...context, status: 'complete' as const };
    const blocks = workBlocks(recorder.snapshot(), [], [complete, complete]);
    expect(blocks).toHaveLength(3); expect(blocks[1]).toMatchObject({ kind: 'context', activity: { status: 'complete' } });
  });
  it('shows consumed steering at its position only during the owning run and hides its standalone user message', () => {
    const recorder = new WorkActivityRecorder('run');
    recorder.part('before', 'prose', 'Inspecting.', Date.now() - 1000);
    recorder.steer('user-steer', 'Use blue.'); recorder.steer('user-steer', 'Use blue.');
    recorder.part('after', 'prose', 'Applying blue.', Date.now() + 1000);
    expect(workBlocks(recorder.snapshot(), [], [], 'run').map(block => block.kind)).toEqual(['prose', 'steering', 'prose']);
    for (const activeRunId of [undefined, 'next-run']) expect(workBlocks(recorder.snapshot(), [], [], activeRunId).map(block => block.kind)).toEqual(['prose', 'prose']);
    const messages = [{ id: 'assistant', workActivity: recorder.snapshot() }] as ChatMessage[];
    expect([...workSteeringMessageIds(messages)]).toEqual(['user-steer']);
    recorder.complete([]); expect([...workSteeringMessageIds(messages)]).toEqual(['user-steer']);
  });
  it('groups mixed tools and intervening thinking into one ordered chain between prose updates', () => {
    const recorder = new WorkActivityRecorder('run');
    recorder.part('before', 'prose', 'Adding the changes.');
    recorder.tool('edit'); recorder.part('think-one', 'reasoning', 'Check the file.'); recorder.tool('read');
    recorder.part('think-two', 'reasoning', 'Run the verification.'); recorder.tool('bash'); recorder.tool('edit');
    recorder.part('after', 'prose', 'The changes passed.');
    const tools = [{ id: 'edit', name: 'code_edit' }, { id: 'read', name: 'code_read' }, { id: 'bash', name: 'code_bash' }] as ToolActivity[];
    const blocks = workBlocks(recorder.snapshot(), tools);
    expect(blocks.map(block => block.kind)).toEqual(['prose', 'tools', 'prose']);
    const chain = blocks[1]; if (chain.kind !== 'tools') throw new Error('Missing chain.');
    expect(chain.steps.map(step => step.id)).toEqual(['edit', 'run:think-one', 'read', 'run:think-two', 'bash']);
    expect(chain.tools.map(tool => tool.id)).toEqual(['edit', 'read', 'bash']);
    expect(workBlocks([], tools)).toHaveLength(1);
  });
  it('places delayed native prose before the tool hook which followed it', () => {
    const recorder = new WorkActivityRecorder('run'); recorder.tool('tool');
    recorder.part('p', 'prose', 'Before the tool.', Date.now() - 1000);
    recorder.part('p', 'prose', 'Before the tool.', Date.now() - 1000);
    expect(recorder.snapshot().map(entry => entry.kind)).toEqual(['prose', 'tool']);
  });
  it('keeps chronological prose and parallel tools, deduplicates snapshots, and separates the native final answer', () => {
    const recorder = new WorkActivityRecorder('run');
    recorder.part('a', 'prose', 'I will inspect.'); recorder.tool('one'); recorder.tool('two');
    recorder.part('b', 'prose', 'I found'); recorder.part('b', 'prose', 'I found the issue.');
    recorder.part('b', 'prose', 'I found the issue.'); recorder.part('b', 'prose', 'I found'); recorder.tool('one');
    recorder.part('final-a', 'prose', 'Fixed it.'); recorder.part('final-b', 'prose', 'Checks passed.');
    expect(recorder.complete(['final-a', 'final-b'])).toBe('Fixed it.\n\nChecks passed.');
    const saved = recorder.snapshot();
    expect(saved.map(entry => entry.kind)).toEqual(['prose', 'tool', 'tool', 'prose', 'prose', 'prose']);
    const tools = [{ id: 'one', name: 'code_bash' }, { id: 'two', name: 'search_web' }] as ToolActivity[];
    const blocks = workBlocks(saved, tools);
    expect(blocks.map(block => block.kind)).toEqual(['prose', 'tools', 'prose']);
    expect(blocks.at(-1)).toMatchObject({ text: 'I found the issue.' });
    expect(workToolSummary(tools)).toContain('Ran commands'); expect(workToolSummary(tools)).toContain('searched the web');
    const resumed = new WorkActivityRecorder('next', saved); resumed.part('a', 'prose', 'Next work.');
    expect(saved).toHaveLength(6); expect(resumed.snapshot()).toHaveLength(7);
  });

  it('observes only assistant snapshots and identifies all final text parts using native message metadata', () => {
    const seen = vi.fn(); const stream = new CodeStream('session', vi.fn(), vi.fn(), vi.fn(), vi.fn(), seen);
    const message = (id: string, role: 'user' | 'assistant', finish?: string) => ({ id, role, sessionID: 'session', finish } as Message);
    const part = (id: string, messageID: string, text: string) => ({ id, messageID, sessionID: 'session', type: 'text', text } as Part);
    stream.part(part('user-part', 'user', 'Private prompt')); stream.message(message('user', 'user'));
    stream.message(message('progress', 'assistant', 'tool-calls')); stream.part(part('p', 'progress', 'Inspecting.'));
    stream.message(message('final', 'assistant', 'stop')); stream.part(part('a', 'final', 'Done.')); stream.part(part('b', 'final', 'Passed.'));
    stream.part(part('a', 'final', 'Done.')); stream.assertFinished();
    expect(seen).toHaveBeenCalledTimes(3); expect(stream.finalTextPartIds()).toEqual(['a', 'b']);
  });

  it('persists activity across reopening and keeps regenerated branches isolated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tinygpt-work-')); const path = join(directory, 'history.sqlite');
    let history = new HistoryStore(path);
    try {
      const chat = history.createConversation(null, 'code'); const turn = history.startTurn(chat.id, 'Do it.', 'local');
      const recorder = new WorkActivityRecorder(turn.runId); recorder.part('progress', 'prose', 'Inspecting.'); recorder.part('answer', 'prose', 'Done.'); recorder.complete(['answer']);
      history.saveReply(turn.assistantId, 'Done.', 'complete', null, '', 9000, recorder.snapshot());
      history.saveReply(turn.assistantId, 'Done.', 'complete', null, '', 9000);
      history.close(); history = new HistoryStore(path);
      expect(history.conversation(chat.id).messages.at(-1)?.workActivity).toEqual(recorder.snapshot());
      const alternate = history.startTurn(chat.id, null, 'local', [], { type: 'regenerate', messageId: turn.assistantId });
      history.saveReply(alternate.assistantId, 'Alternate.', 'complete');
      expect(history.conversation(chat.id).messages.at(-1)?.workActivity).toBeUndefined();
      history.selectBranch(chat.id, turn.assistantId);
      expect(history.conversation(chat.id).messages.at(-1)).toMatchObject({ text: 'Done.', workActivity: recorder.snapshot() });
    } finally { history.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('records native progress without extra executions or tools and assembles a multipart final answer', async () => {
    const history = new HistoryStore(':memory:'); const inputs: ChatWorkerInput[] = []; const phases: string[] = [];
    const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
    const project = history.createProject('Work', '', false, process.cwd()); const conversation = history.createConversation(project.id, 'code');
    const broker = { approvals: () => [], browser: { handoffs: () => [], tasks: () => [] }, endRun: () => {},
      async nativeCode(context: { conversationId: string; runId: string }, event: { phase: string; id: string; output?: string }) {
        phases.push(event.phase);
        if (event.phase === 'before') history.addTool(event.id, context.conversationId, context.runId, 'code_bash', 'Run check');
        else history.finishTool(event.id, 'success', event.output ?? '');
        return {};
      },
    } as unknown as ToolBroker;
    const execution: ChatExecution = { async run(input, _signal, delta, _tool, _reasoning, response, _context, _trace, native) {
      inputs.push(input); response?.({ type: 'work-part', id: 'p', kind: 'prose', text: 'Inspecting.' });
      response?.({ type: 'start', lane: 'unclassified' }); delta('Inspecting.');
      const id = randomUUID(); await native?.({ phase: 'before', id, name: 'code_bash', args: { command: 'check' } });
      await native?.({ phase: 'after', id, status: 'success', output: 'Passed' });
      for (const [partId, text] of [['a', 'Done.'], ['b', 'Passed.']]) {
        response?.({ type: 'work-part', id: partId, kind: 'prose', text }); response?.({ type: 'start', lane: 'unclassified' }); delta(text);
      }
      response?.({ type: 'work-complete', answerPartIds: ['a', 'b'] });
    } };
    const service = new ChatService(history, () => settings, () => 'fixture', execution, () => {}, broker, undefined, undefined, undefined, execution);
    try {
      service.start(conversation.id, 'Do the task.'); await vi.waitFor(() => expect(service.library().activeRuns).toEqual([]));
      const saved = history.conversation(conversation.id);
      expect(saved.messages.at(-1)).toMatchObject({ text: 'Done.\n\nPassed.', status: 'complete' });
      expect(saved.messages.at(-1)?.workActivity?.map(entry => entry.kind)).toEqual(['prose', 'tool', 'prose', 'prose']);
      expect(phases).toEqual(['before', 'after']); expect(saved.tools).toHaveLength(1); expect(inputs).toHaveLength(1);
      expect(inputs[0].messages.map(message => message.text)).toEqual(['Do the task.']);
    } finally { await service.shutdown(); history.close(); }
  });

  it('preserves interrupted history through continuation without adding it to model input', async () => {
    const history = new HistoryStore(':memory:'); const inputs: ChatWorkerInput[] = [];
    const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
    const conversation = history.createConversation(history.createProject('Work', '', false, process.cwd()).id, 'code');
    const execution: ChatExecution = { async run(input, _signal, delta, _tool, _reasoning, response) {
      inputs.push(input); const first = inputs.length === 1;
      response?.({ type: 'work-part', id: 'p', kind: 'prose', text: first ? 'First progress.' : 'Resumed progress.' });
      response?.({ type: 'start', lane: 'unclassified' }); delta(first ? 'First progress.' : 'Resumed progress.');
      if (first) throw new Error(OUTPUT_LIMIT_MESSAGE);
      response?.({ type: 'work-part', id: 'answer', kind: 'prose', text: 'Finished.' });
      response?.({ type: 'start', lane: 'unclassified' }); delta('Finished.'); response?.({ type: 'work-complete', answerPartIds: ['answer'] });
    } };
    const service = new ChatService(history, () => settings, () => 'fixture', execution, () => {}, undefined, undefined, undefined, undefined, execution);
    try {
      service.start(conversation.id, 'Do it.'); await vi.waitFor(() => expect(service.library().activeRuns).toEqual([]));
      const interrupted = history.conversation(conversation.id).messages.at(-1)!;
      expect(interrupted.status).toBe('interrupted'); expect(interrupted.workActivity?.[0].answer).toBeUndefined();
      service.start(conversation.id, null, [], { type: 'continue', messageId: interrupted.id });
      await vi.waitFor(() => expect(service.library().activeRuns).toEqual([]));
      const saved = history.conversation(conversation.id).messages.at(-1)!;
      expect(saved.workActivity?.map(entry => entry.text)).toEqual(['First progress.', 'Resumed progress.', 'Finished.']);
      expect(inputs[1].messages.every(message => !('workActivity' in message))).toBe(true);
    } finally { await service.shutdown(); history.close(); }
  });
});


describe('Inline coding agent activity', () => {
  const tool = (id: string, name: ToolActivity['name']) => ({ id, name, createdAt: 0, status: 'success' } as ToolActivity);
  it('keeps separate agent prose between toolchains across saved history and replay', () => {
    const recorder = new WorkActivityRecorder('run');
    recorder.part('intro', 'prose', 'Starting the task.', 1);
    recorder.tool('agent');
    recorder.part('first', 'prose', 'Inspecting the file.', 10, undefined, 0, 'agent');
    recorder.tool('read', 'agent');
    recorder.part('second', 'prose', 'Found the issue.', Date.now() + 1, undefined, 0, 'agent');
    recorder.tool('edit', 'agent');
    recorder.part('third', 'prose', 'Verified the change.', Date.now() + 2, undefined, 0, 'agent');
    // Set deterministic timestamps for the native tool hooks.
    const saved = recorder.snapshot().map(entry => ({ ...entry, startedAt: ({ agent: 2, read: 11, edit: 21 } as Record<string, number>)[entry.toolId!] ?? ({ 'run:second': 20, 'run:third': 30 } as Record<string, number>)[entry.id] ?? entry.startedAt }));
    const restored = new WorkActivityRecorder('run', JSON.parse(JSON.stringify(saved)));
    restored.part('second', 'prose', 'Found the issue.', 20, undefined, 0, 'agent');
    const blocks = workBlocks(restored.snapshot(), [tool('agent', 'code_delegate'), tool('read', 'code_read'), tool('edit', 'code_edit')]);
    expect(blocks.map(block => block.kind)).toEqual(['prose', 'agent']);
    const agent = blocks[1]; if (agent.kind !== 'agent') throw Error('Missing coding agent');
    expect(agent.blocks.map(block => block.kind)).toEqual(['prose', 'tools', 'prose', 'tools', 'prose']);
    expect(agent.blocks.filter(block => block.kind === 'prose').map(block => block.text)).toEqual(['Inspecting the file.', 'Found the issue.', 'Verified the change.']);
    expect(agent.blocks.flatMap(block => block.kind === 'tools' ? block.tools.map(tool => tool.id) : [])).toEqual(['read', 'edit']);
  });
  it('never promotes agent prose to the parent final answer', () => {
    const recorder = new WorkActivityRecorder('run');
    recorder.part('child', 'prose', 'Agent result.', 1, true, 0, 'agent');
    recorder.part('final', 'prose', 'Parent answer.', 2);
    expect(recorder.complete(['child', 'final'])).toBe('Parent answer.');
    expect(recorder.snapshot()[0]).toMatchObject({ agentId: 'agent', answer: false });
  });
  it('keeps independent agent calls and ordinary parent tools separate', () => {
    const activity = [
      { id: 'first', runId: 'run', kind: 'tool' as const, text: '', toolId: 'a', startedAt: 1 },
      { id: 'a-child', runId: 'run', kind: 'tool' as const, text: '', toolId: 'read-a', agentId: 'a', startedAt: 2 },
      { id: 'parent', runId: 'run', kind: 'tool' as const, text: '', toolId: 'parent-read', startedAt: 3 },
      { id: 'second', runId: 'run', kind: 'tool' as const, text: '', toolId: 'b', startedAt: 4 },
      { id: 'b-child', runId: 'run', kind: 'tool' as const, text: '', toolId: 'read-b', agentId: 'b', startedAt: 5 },
    ];
    const blocks = workBlocks(activity, [tool('a', 'code_delegate'), tool('read-a', 'code_read'), tool('parent-read', 'code_read'), tool('b', 'code_delegate'), tool('read-b', 'code_read')]);
    expect(blocks.map(block => block.kind)).toEqual(['agent', 'tools', 'agent']);
    expect(blocks.map(block => block.kind === 'agent' ? block.tool.id : block.kind === 'tools' ? block.tools[0].id : '')).toEqual(['a', 'parent-read', 'b']);
  });
  it('retains orphaned activity visibly when its parent tool is unavailable', () => {
    const recorder = new WorkActivityRecorder('run');
    recorder.part('child', 'prose', 'Saved coding progress.', 1, undefined, 0, 'missing');
    expect(workBlocks(recorder.snapshot(), [])).toMatchObject([{ kind: 'prose', text: 'Saved coding progress.' }]);
  });
});
