import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ToolBroker } from '../src/main/tool-broker';
import { HistoryStore } from '../src/main/history';
import type { BrowserController } from '../src/main/browser';
import type { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import { WAIT_EVIDENCE } from '../src/core/wait-until';
const stores: HistoryStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.useRealTimers(); });
function setup() {
  const history = new HistoryStore(':memory:'); stores.push(history);
  const conversation = history.createConversation(null), settings = structuredClone(defaultSettings), controller = new AbortController(), tabId = randomUUID();
  settings.toolPermissions.browser = 'allow';
  const state = { label: 'Saving', complete: true };
  const snapshot = vi.fn(async (_conversation: string, _tab: string, signal: AbortSignal) => { signal.throwIfAborted(); return { tabId, url: 'https://example.com', title: 'Editor', text: state.label, elements: [], challenge: false, [WAIT_EVIDENCE]: { texts: [state.label], complete: state.complete } }; });
  const browser = { partition: () => 'fixture', snapshot } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, {} as ProjectFiles, () => {});
  const context = { conversationId: conversation.id, runId: randomUUID(), signal: controller.signal };
  const run = (waitUntil: unknown) => broker.execute(context, { id: randomUUID(), name: 'browser_snapshot', input: { tabId, waitUntil } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  return { history, conversation, settings, controller, snapshot, state, run };
}
it('polls browser state within one tool call and saves only the final snapshot', async () => {
  const t = setup(); setTimeout(() => { t.state.label = 'Saved'; }, 1500);
  const pending = t.run({ text: 'Saved' }); await vi.advanceTimersByTimeAsync(2000);
  expect(JSON.parse(await pending)).toMatchObject({ text: 'Saved', wait: { matched: true, timedOut: false, polls: 3 } });
  const tools = t.history.conversation(t.conversation.id).tools;
  expect(tools).toHaveLength(1); expect(tools[0].result).not.toContain('"text":"Saving"');
  expect(t.snapshot).toHaveBeenCalledTimes(3);
});
it('returns an unverified timeout even when the browser never responds', async () => {
  const t = setup(); t.snapshot.mockImplementation(() => new Promise(() => {}));
  const pending = t.run({ text: 'Saved', timeoutMs: 1000 }); await vi.advanceTimersByTimeAsync(1000);
  expect(JSON.parse(await pending)).toMatchObject({ wait: { matched: false, timedOut: true, polls: 1 } });
  expect(t.snapshot).toHaveBeenCalledOnce();
});
it('honors browser-read revocation between polls', async () => {
  const t = setup(); const pending = t.run({ text: 'Saved' });
  await vi.advanceTimersByTimeAsync(10); t.settings.toolPermissions.browser = 'deny'; await vi.advanceTimersByTimeAsync(1000);
  expect(JSON.parse(await pending).error).toContain('disabled while waiting');
  expect(t.snapshot).toHaveBeenCalledOnce();
});
it('cancels an in-flight browser wait without returning success', async () => {
  const t = setup(); t.snapshot.mockImplementation(() => new Promise(() => {}));
  const pending = t.run({ text: 'Saved' }), stopped = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10); t.controller.abort(); await stopped;
  await vi.advanceTimersByTimeAsync(30000); expect(t.snapshot).toHaveBeenCalledOnce();
  expect(t.history.conversation(t.conversation.id).tools[0].status).toBe('cancelled');
});
