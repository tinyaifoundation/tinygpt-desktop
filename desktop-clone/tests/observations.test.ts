import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import { ObservationStore } from '../src/main/observations';
import { workContextPolicy } from '../src/core/work-context-policy';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
it('preserves exact observations across restart, permits range retrieval and removes deleted conversation data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-observations-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new ObservationStore(join(root, 'library.sqlite'));
  const conversationId = randomUUID(), text = 'head\n' + 'source text '.repeat(4000) + '\nexact identifier at the end: abc-123';
  const record = await store.save({ conversationId, runId: randomUUID(), tool: 'read_page', permission: 'browser', text });
  expect(store.excerpt(record).length).toBeLessThan(4600);
  expect((await new ObservationStore(join(root, 'library.sqlite')).get(conversationId, record.id)).text).toBe(text);
  await expect(store.get(randomUUID(), record.id)).rejects.toThrow();
  await expect(store.get(conversationId, '../escape')).rejects.toThrow('Invalid');
  await store.clear(conversationId); await expect(store.get(conversationId, record.id)).rejects.toThrow();
});
it('retrieves the original page without refetching and rejects foreign branches and revoked access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-observation-access-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(async () => history.close());
  const settings = structuredClone(defaultSettings); settings.toolPermissions.browser = 'allow'; settings.toolPermissions.read = 'allow';
  const chat = history.createConversation(null), turn = history.startTurn(chat.id, 'Research it.', 'local');
  let fetches = 0;
  const browser = { partition: () => 'fixture', async page() { fetches++; return { tabId: randomUUID(), title: 'Source', url: 'https://example.org', text: 'snapshot '.repeat(3000) + 'EXACT-END', elements: [] }; }, shutdown() {} } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {}); cleanup.push(() => broker.shutdown());
  const context = { conversationId: chat.id, runId: turn.runId, signal: new AbortController().signal };
  const result = JSON.parse(await broker.execute(context, { id: randomUUID(), name: 'read_page', input: { url: 'https://example.org' } }));
  expect(JSON.stringify(result).length).toBeLessThan(6500); expect(result.observationId).toBeTruthy();
  const wrongKind = JSON.parse(await broker.execute(context, { id: randomUUID(), name: 'read_observation', input: { id: result.sourceId } }));
  expect(wrongKind).toMatchObject({ code: 'REFERENCE_TYPE_MISMATCH', nextRead: { tool: 'read_source', input: { sourceId: result.sourceId } } });
  const absent = JSON.parse(await broker.execute(context, { id: randomUUID(), name: 'read_observation', input: { id: randomUUID() } }));
  expect(absent.code).toBe('OBSERVATION_UNAVAILABLE'); expect(absent.error).not.toContain('create a new file');
  const raw = await broker.observations.get(chat.id, result.observationId), offset = raw.text.indexOf('EXACT-END');
  const read = () => broker.execute(context, { id: randomUUID(), name: 'read_observation', input: { id: result.observationId, offset, limit: 9 } });
  expect(JSON.parse(await read()).text).toBe('EXACT-END'); expect(fetches).toBe(1);
  const search = () => broker.execute(context, { id: randomUUID(), name: 'read_observation', input: { id: result.observationId, query: 'exact-end', limit: 100 } });
  const found = JSON.parse(await search()); expect(found.found).toBe(true); expect(found.text).toContain('EXACT-END'); expect(found.text.length).toBeLessThanOrEqual(100); expect(fetches).toBe(1);
  settings.toolPermissions.browser = 'deny'; expect(JSON.parse(await search()).error).toBeTruthy(); settings.toolPermissions.browser = 'allow';
  settings.toolPermissions.browser = 'deny'; expect(JSON.parse(await read()).error).toBeTruthy(); settings.toolPermissions.browser = 'allow';
  history.saveReply(turn.assistantId, 'Done.', 'complete'); history.startTurn(chat.id, null, 'local', [], { type: 'regenerate', messageId: turn.assistantId });
  expect(JSON.parse(await read()).error).toBeTruthy();
  expect(JSON.parse(await search()).error).toBeTruthy();
});
it('searches large saved observations literally with bounded pages and Unicode-correct offsets', () => {
  const store = new ObservationStore('/unused/library.sqlite');
  const text = '🚀'.repeat(30000) + 'TERM=[a+b]? first ' + 'x'.repeat(20000) + 'term=[a+b]? second';
  const record = { id: randomUUID(), conversationId: randomUUID(), runId: randomUUID(), tool: 'read', createdAt: 1, permission: 'read' as const, text };
  const first = store.page(record, 0, 100, 'TERM=[a+b]?');
  expect(first.found).toBe(true); expect(first.matchOffset).toBe(60000); expect(first.text).toContain('first'); expect(first.text.length).toBeLessThanOrEqual(100);
  const second = store.page(record, first.nextMatchOffset!, 100, 'TERM=[a+b]?');
  expect(second.text).toContain('second'); expect(second.matchOffset).toBe(text.indexOf('term='));
  expect(store.page(record, second.nextMatchOffset!, 100, 'TERM=[a+b]?')).toMatchObject({ found: false, text: '' });
});
it('scales native retention and summary budgets for 8K, 16K and 64K windows', () => {
  for (const window of [8192, 16384, 65536]) {
    const output = window / 4, policy = workContextPolicy(window, output);
    expect(policy.keepRecentTokens).toBeLessThan((window - output) / 3);
    expect(policy.summaryOutputTokens).toBeLessThanOrEqual(output);
    expect(policy.summaryOutputTokens).toBeLessThanOrEqual(4096);
  }
});
