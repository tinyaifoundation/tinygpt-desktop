import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import type { ChatExecution } from '../src/shared/chat';

it('resumes failed Work after reopening the library with its plan, evidence and completed actions intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tinygpt-provider-recovery-'));
  const path = join(root, 'library.sqlite');
  let history = new HistoryStore(path);
  const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'tinygpt-pro', tools: true } };
  const actionId = randomUUID(); let actionExecutions = 0;
  const idle = async (service: ChatService, id: string) => { for (let i = 0; i < 200 && service.isActive(id); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(service.isActive(id)).toBe(false); };
  try {
    const failed: ChatExecution = { async run(input, _signal, delta, tool, _reasoning, response) {
      await tool!({ id: randomUUID(), name: 'work_plan', input: { steps: ['Create report', 'Check report'], criteria: ['Report saved and checked'] } });
      actionExecutions++;
      history.workTasks.startOperation(input.workTask!.id, actionId, 'write_project_file', { path: 'report.txt', content: 'Preserved report' });
      history.workTasks.finishOperation(input.workTask!.id, actionId, JSON.stringify({ written: true, path: 'report.txt' }));
      history.addTool(actionId, input.conversationId!, input.runId, 'write_project_file', 'Save report');
      history.finishTool(actionId, 'success', JSON.stringify({ written: true, path: 'report.txt' }));
      response?.({ type: 'work-part', id: 'saved-progress', kind: 'prose', text: 'The report is saved.' });
      delta('Partial report.');
      throw new Error('Your provider is temporarily unavailable. You can retry this reply.');
    } };
    const first = new ChatService(history, () => settings, () => undefined, failed, () => {});
    const id = history.createConversation(null, 'code').id;
    first.start(id, 'Create and verify my report'); await idle(first, id);
    const original = history.conversation(id).messages.at(-1)!;
    expect(original).toMatchObject({ status: 'error', workTask: { status: 'paused', goal: 'Create and verify my report' } });
    expect(original.workActivity?.some(part => part.text === 'The report is saved.')).toBe(true);
    history.close(); history = new HistoryStore(path);
    const resumed: ChatExecution = { async run(input, _signal, delta, tool) {
      expect(input.workTask).toMatchObject({ goal: 'Create and verify my report', steps: ['Create report', 'Check report'] });
      expect(input.messages.at(-1)?.text).toContain('Recheck uncertain effects');
      const operations = history.workTasks.operations(input.workTask!.id, true);
      expect(operations).toContainEqual(expect.objectContaining({ id: actionId, name: 'write_project_file', status: 'succeeded' }));
      expect(input.messages.flatMap(message => message.operations ?? [])).toContainEqual(expect.objectContaining({ id: actionId, status: 'succeeded' }));
      const evidence = JSON.parse(await tool!({ id: randomUUID(), name: 'work_evidence', input: { evidenceId: actionId } }));
      expect(JSON.stringify(evidence)).toContain('report.txt');
      delta('Continued from the saved report.');
    } };
    const second = new ChatService(history, () => settings, () => undefined, resumed, () => {});
    second.start(id, null, [], { type: 'continue', messageId: original.id }); await idle(second, id);
    const conversation = history.conversation(id), reply = conversation.messages.at(-1)!;
    expect(reply.continuationOf).toBe(original.id);
    expect(reply.text).toBe('Continued from the saved report.');
    expect(conversation.allMessages?.find(message => message.id === original.id)?.status).toBe('error');
    expect(conversation.tools.find(tool => tool.id === actionId)?.status).toBe('success');
    expect(actionExecutions).toBe(1);
  } finally { history.close(); rmSync(root, { recursive: true, force: true }); }
});
