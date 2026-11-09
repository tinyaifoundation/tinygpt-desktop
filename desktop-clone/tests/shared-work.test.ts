import { afterEach, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLibreChat } from '../src/core/librechat';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import type { ChatExecution } from '../src/shared/chat';
import type { BrowserController } from '../src/main/browser';

const stores: HistoryStore[] = [], services: ChatService[] = [], brokers: ToolBroker[] = [], roots: string[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.shutdown())); await Promise.all(brokers.splice(0).map(b => b.shutdown())); stores.splice(0).forEach(h => h.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function idle(service: ChatService, id: string) { const deadline = Date.now() + 20000; while (service.isActive(id) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5)); if (service.isActive(id)) { await service.cancel(id); throw Error('The fixture did not stop'); } }

it('recovers the recorded invalid skill-path write and ends on normal prose through the real graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-lifecycle-')); roots.push(root);
  const h = new HistoryStore(':memory:', root); stores.push(h); const chat = h.createConversation(null, 'code'); const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; bodies.push(JSON.parse(raw)); const index = bodies.length;
    const step = index === 1 ? ['write_file', { path: '/skill/frontend-design/dashboard.html', content: '<h1>Dashboard</h1>' }] : index === 2 ? ['write_file', { path: 'dashboard.html', content: '<h1>Dashboard</h1>' }] : index === 3 ? ['read_file', { path: 'dashboard.html' }] : undefined;
    const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: 'step-' + index, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { role: 'assistant', content: 'Created and verified dashboard.html.' };
    const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'reply-' + index, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(delta, null) + frame({}, step ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, tools: true, contextWindowTokens: 65536 }, toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow' as const, write: 'allow' as const } };
  const broker = new ToolBroker(h, () => settings, { partition: () => 'fixture', shutdown() {}, endRun() {}, handoffs: () => [], tasks: () => [] } as unknown as BrowserController, new ProjectFiles(h.sources), () => {}); brokers.push(broker);
  const engine: ChatExecution = { run: (input, signal, delta, tool, reasoning, response, context, trace, _native, steering, control) => runLibreChat(input, signal, delta, tool, reasoning, response, context, undefined, trace, steering, control) };
  const service = new ChatService(h, () => settings, () => undefined, engine, () => {}, broker); services.push(service);
  try {
    service.start(chat.id, 'Create and verify dashboard.html.'); await idle(service, chat.id);
    const conversation = service.update(chat.id).conversation, reply = conversation.messages.at(-1)!;
    expect(reply.status).toBe('complete'); expect(reply.text).toBe('Created and verified dashboard.html.'); expect(reply.workTask?.status).toBe('completed');
    expect(reply.workTask?.criteria).toEqual([]); expect(bodies).toHaveLength(4);
    expect(conversation.tools.map(t => [t.name, t.status])).toEqual([['write_file', 'error'], ['write_file', 'success'], ['read_file', 'success']]);
    expect(bodies[0].tools.map((t: any) => t.function.name)).toContain('search_web');
    expect(bodies.every(body => body.messages.every((m: any) => !/Current host Work|Repair the recorded|Current host Work task/.test(String(m.content))))).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it('finishes an ordinary Work reply without forcing a finish tool or another model request', async () => {
  const h = new HistoryStore(':memory:'); stores.push(h); const chat = h.createConversation(null, 'code'); let calls = 0;
  const engine: ChatExecution = { async run(_input, _signal, delta) { calls++; delta('Here is the requested explanation.'); } };
  const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
  const service = new ChatService(h, () => settings, () => undefined, engine, () => {}); services.push(service);
  service.start(chat.id, 'Explain the result'); await idle(service, chat.id);
  const reply = service.update(chat.id).conversation.messages.at(-1)!;
  expect(calls).toBe(1); expect(reply.status).toBe('complete'); expect(reply.workTask?.status).toBe('completed'); expect(reply.text).toBe('Here is the requested explanation.');
});

it('preserves explicit waiting reports and continuation without host blocker adjudication', async () => {
  const h = new HistoryStore(':memory:'); stores.push(h); const chat = h.createConversation(null, 'code'); let calls = 0;
  const engine: ChatExecution = { async run(input, _signal, delta, tool) { calls++; if (calls === 1) await tool!({ id: crypto.randomUUID(), name: 'work_finish', input: { status: 'waiting', answer: 'I need the account connection.' } }); else expect(input.workTask?.goal).toContain('Check the account'); delta(calls === 1 ? 'I need the account connection.' : 'The requested information is available.'); } };
  const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
  const service = new ChatService(h, () => settings, () => undefined, engine, () => {}); services.push(service);
  service.start(chat.id, 'Check the account'); await idle(service, chat.id);
  const first = service.update(chat.id).conversation.messages.at(-1)!;
  expect(first.workTask?.status).toBe('waiting'); expect(first.status).toBe('complete');
  service.start(chat.id, null, [], { type: 'continue', messageId: first.id }); await idle(service, chat.id);
  expect(service.update(chat.id).conversation.messages.at(-1)?.workTask?.status).toBe('completed');
});
