import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../src/main/chat-service';
import { HistoryStore } from '../src/main/history';
import { ReplyDiagnostics } from '../src/main/reply-diagnostics';
import { defaultSettings } from '../src/shared/config';
import { REPLY_TIMEOUT_MESSAGE } from '../src/shared/chat-timeouts';
import { ToolBroker } from '../src/main/tool-broker';
import type { ProjectFiles } from '../src/main/files';
import type { BrowserController } from '../src/main/browser';
import { randomUUID } from 'node:crypto';
describe('reply trace integration', () => {
  it('records tool execution after the approval wait, including denial and cancellation', async () => {
    const history = new HistoryStore(':memory:'); let time = 0; const diagnostics = new ReplyDiagnostics(':memory:', () => Date.now(), () => time); const conversation = history.createConversation(null);
    const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'ask';
    const files = { list: vi.fn(async () => { time += 10; return { entries: [] }; }) } as unknown as ProjectFiles;
    const browser = { partition: () => 'fixture', shutdown: vi.fn() } as unknown as BrowserController;
    const broker = new ToolBroker(history, () => settings, browser, files, () => {}, undefined, undefined, diagnostics);
    const begin = () => { const runId = randomUUID(); diagnostics.begin({ runId, startedAt: Date.now(), route: 'local', provider: 'local', protocol: 'openai-compatible', fingerprint: '0123456789abcdef', platform: 'win32', version: '0.1.0' }); return { conversationId: conversation.id, runId, controller: new AbortController() }; };
    try {
      const run = begin(); const result = broker.execute({ ...run, signal: run.controller.signal }, { id: randomUUID(), name: 'list_project_files', input: { path: '.' } });
      await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); time += 1000; broker.respond(broker.approvals()[0].id, 'allow-once'); await result;
      expect(diagnostics.reports()[0].metrics).toMatchObject({ approvalMs: 1000, toolMs: 10 });
      const deny = begin(); const denied = broker.execute({ ...deny, signal: deny.controller.signal }, { id: randomUUID(), name: 'list_project_files', input: { path: '.' } }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'deny'); await denied;
      expect(diagnostics.reports()[0].events.some(event => event.event === 'tool-start')).toBe(false);
      const stop = begin(); const cancelled = broker.execute({ ...stop, signal: stop.controller.signal }, { id: randomUUID(), name: 'list_project_files', input: { path: '.' } }); const rejection = expect(cancelled).rejects.toThrow(); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); stop.controller.abort(); await rejection;
      expect(diagnostics.reports()[0].events).toContainEqual(expect.objectContaining({ event: 'approval-end', outcome: 'cancelled' }));
      expect(files.list).toHaveBeenCalledTimes(1);
    } finally { await broker.shutdown(); diagnostics.close(); history.close(); }
  });
  it('correlates retry runs and sanitized failures while keeping the conversation out of diagnostics', async () => {
    const history = new HistoryStore(':memory:'); const diagnostics = new ReplyDiagnostics(':memory:'); let calls = 0;
    const settings = { ...defaultSettings, local: { ...defaultSettings.local, model: 'private-model-label', tools: false } };
    const chat = new ChatService(history, () => settings, () => 'private-secret', { async run(_input, _signal, delta, _tool, _reasoning, _response, context, trace) {
      trace?.({ event: 'runtime-ready' }); context?.({ type: 'usage', inputTokens: 12, outputTokens: 3 });
      if (++calls === 1) throw new Error(REPLY_TIMEOUT_MESSAGE); delta('private-answer');
    } }, () => {}, undefined, undefined, undefined, diagnostics);
    try {
      const conversation = history.createConversation(null); const first = chat.start(conversation.id, 'private-prompt'); expect(first.conversation.diagnostics?.runId).toBe(first.library.activeRuns[0]?.runId);
      await vi.waitFor(() => expect(chat.library().activeRuns[0]).toBeUndefined());
      expect(diagnostics.reports()[0]).toMatchObject({ status: 'error', metrics: { inputTokens: 12, outputTokens: 3 } });
      expect(diagnostics.reports()[0].events.at(-1)).toMatchObject({ event: 'run-error', failure: 'timeout' });
      chat.start(conversation.id, null); await vi.waitFor(() => expect(chat.library().activeRuns[0]).toBeUndefined());
      const reports = diagnostics.reports(); expect(reports).toHaveLength(2); expect(new Set(reports.map(run => run.runId)).size).toBe(2); expect(reports[0].events.some(event => event.event === 'execution-start')).toBe(true);
      expect(JSON.stringify(reports)).not.toContain('private'); expect(history.conversation(conversation.id).messages.at(-1)?.text).toBe('private-answer');
    } finally { await chat.shutdown(); diagnostics.close(); history.close(); }
  });
});
