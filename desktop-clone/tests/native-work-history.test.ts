import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import type { ToolBroker } from '../src/main/tool-broker';
import type { ChatExecution } from '../src/shared/chat';
import { defaultSettings } from '../src/shared/config';

it('makes settled native verification available to work_history and preserves failed exit status', async () => {
  const history = new HistoryStore(':memory:');
  const broker = { browser: { handoffs: () => [] }, approvals: () => [], nativeCode: async (_context: unknown, event: any) => event.phase === 'after' ? { output: event.output } : {}, endRun() {} } as unknown as ToolBroker;
  const execution: ChatExecution = { async run(_input, _signal, delta, tool, _reasoning, _response, _context, _trace, native) {
    const id = randomUUID();
    await native!({ phase: 'before', id, name: 'code_bash', args: { command: 'node test.mjs' } });
    await native!({ phase: 'after', id, status: 'success', output: 'VERIFIED=42', metadata: { exit: 0 } });
    const failed = randomUUID();
    await native!({ phase: 'before', id: failed, name: 'code_bash', args: { command: 'node failing.mjs' } });
    await native!({ phase: 'after', id: failed, status: 'success', output: 'Failed verification', metadata: { exit: 7 } });
    const result = JSON.parse(await tool!({ id: randomUUID(), name: 'work_history', input: { query: 'VERIFIED=42' } }));
    expect(result.text).toContain('VERIFIED=42'); expect(result.text).toContain('succeeded');
    const errors = JSON.parse(await tool!({ id: randomUUID(), name: 'work_history', input: { query: 'failing.mjs' } }));
    expect(errors.text).toContain('failed'); expect(errors.text).toContain('exitCode');
    delta('HISTORY_VERIFIED');
  } };
  const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
  const originalRun = execution.run; let executionError: unknown;
  execution.run = async (...args) => { try { await originalRun(...args); } catch (error) { executionError = error; throw error; } };
  const service = new ChatService(history, () => settings, () => 'fixture', execution, () => {}, broker, undefined, undefined, undefined, execution);
  try {
    const conversation = history.createConversation(null, 'code'); service.start(conversation.id, 'Verify the saved native results.');
    for (let i = 0; i < 200 && service.isActive(conversation.id); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(service.isActive(conversation.id)).toBe(false);
    expect(executionError).toBeUndefined();
    expect(history.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'HISTORY_VERIFIED', status: 'complete' });
  } finally { await service.shutdown(); history.close(); }
});
