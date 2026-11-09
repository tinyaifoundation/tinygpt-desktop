import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';
import { ToolBroker } from '../src/main/tool-broker';
import { WorkTaskController } from '../src/main/work-tasks';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import type { ToolName } from '../src/shared/tools';
import { agentTools } from '../src/core/agent-tools';
import { WorkToolCatalog } from '../src/core/work-tool-catalog';
import { StableWorkTools } from '../src/core/stable-work-tools';
import { runLibreChat } from '../src/core/librechat';

let root: string, history: HistoryStore, broker: ToolBroker, conversationId: string;
let settings: typeof defaultSettings;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tinygpt-simple-work-')));
  history = new HistoryStore(':memory:', join(root, 'generated'));
  conversationId = history.createConversation(history.createProject('Work', '', false, root).id, 'code').id;
  settings = { ...defaultSettings, toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow', write: 'allow', execute: 'allow' } };
  broker = new ToolBroker(history, () => settings, { shutdown() {}, partition() { return 'fixture'; } } as unknown as BrowserController, new ProjectFiles(history.sources), () => {});
});
afterEach(async () => { await broker.shutdown(); history.close(); await rm(root, { recursive: true, force: true }); });
const call = async (name: ToolName, input: unknown, runId = 'fixture') => JSON.parse(await broker.execute({ conversationId, runId, signal: signal() }, { id: randomUUID(), name, input }));
const task = () => { const turn = history.startTurn(conversationId, 'Build a dashboard', 'local'); return history.workTasks.begin(conversationId, turn.assistantId, turn.runId, 'Build a dashboard', undefined, undefined, true); };

it('creates and replaces nested files with path/content only, preserving review and Undo', async () => {
  expect(await call('write_file', { path: 'dashboard/index.html', content: '<h1>First</h1>' })).toMatchObject({ action: 'created', path: 'dashboard/index.html' });
  expect(await call('write_file', { path: 'dashboard/index.html', content: '<h1>Second</h1>' })).toMatchObject({ action: 'updated' });
  expect(await readFile(join(root, 'dashboard/index.html'), 'utf8')).toBe('<h1>Second</h1>');
  const changes = history.codeChanges(conversationId);
  expect(changes.map(c => c.before)).toEqual([null, '<h1>First</h1>']);
  await broker.code.undo(conversationId, changes[1].id);
  expect(await readFile(join(root, 'dashboard/index.html'), 'utf8')).toBe('<h1>First</h1>');
  await broker.code.undo(conversationId, changes[0].id);
  await expect(readFile(join(root, 'dashboard/index.html'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('checks observed versions automatically and isolates concurrent run observations', async () => {
  await writeFile(join(root, 'file.txt'), 'original');
  await call('read_file', { path: 'file.txt' }, 'first');
  await call('read_file', { path: 'file.txt' }, 'second');
  await call('write_file', { path: 'file.txt', content: 'second run' }, 'second');
  expect(await call('write_file', { path: 'file.txt', content: 'stale' }, 'first')).toMatchObject({ code: 'FILE_CHANGED', executed: false });
  await call('read_file', { path: 'file.txt' }, 'first');
  expect(await call('edit_file', { path: 'file.txt', oldText: 'second', newText: '$& first' }, 'first')).toMatchObject({ action: 'updated' });
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('$& first run');
});

it('serializes overlapping writes from independent runs and snapshots both changes', async () => {
  const result = await Promise.all([call('write_file', { path: 'shared.txt', content: 'one' }, 'one'), call('write_file', { path: 'shared.txt', content: 'two' }, 'two')]);
  expect(result.every(r => !r.error)).toBe(true);
  const changes = history.codeChanges(conversationId);
  expect(changes).toHaveLength(2); expect(changes[1].before).toBe(changes[0].after);
  expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe(changes[1].after);
});

it('rejects ambiguous edits and escaping paths without writing', async () => {
  await writeFile(join(root, 'file.txt'), 'same same');
  expect(await call('edit_file', { path: 'file.txt', oldText: 'same', newText: 'new' })).toMatchObject({ code: 'EDIT_AMBIGUOUS', executed: false });
  expect(await call('edit_file', { path: 'file.txt', oldText: 'absent', newText: 'new' })).toMatchObject({ code: 'EDIT_NOT_FOUND' });
  expect((await call('write_file', { path: '../escape.txt', content: 'no' })).error).toContain('outside');
  expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('same same');
});

it('pages large files and searches literal content without returning giant results', async () => {
  await call('write_file', { path: 'data.txt', content: 'x'.repeat(120000) + '\nNeedle text' });
  const first = await call('read_file', { path: 'data.txt' });
  expect(first.text).toHaveLength(8000); expect(first.nextOffset).toBe(8000); expect(first).not.toHaveProperty('sha256');
  const page = await call('read_file', { path: 'data.txt', offset: 120001 });
  expect(page.text).toBe('Needle text');
  expect((await call('search_files', { query: 'needle' })).matches).toContainEqual({ path: 'data.txt', line: 2, text: 'Needle text' });
});

it('honors denied writes and records field-level argument errors', async () => {
  const bad = await call('write_file', { path: 'bad.txt', content: 123 });
  expect(bad).toMatchObject({ code: 'INVALID_ARGUMENTS', tool: 'write_file', executed: false, issues: [{ field: 'content' }] });
  expect(history.conversation(conversationId).tools.at(-1)?.status).toBe('error');
  settings.toolPermissions.write = 'deny';
  expect((await call('write_file', { path: 'denied.txt', content: 'no' })).error).toContain('blocked');
  await expect(readFile(join(root, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('runs commands with the existing permission broker and bundled runtime', async () => {
  const result = await call('run_command', { executable: 'node', args: ['-e', "console.log('verified')"] });
  // A normal Node test process also supports ELECTRON_RUN_AS_NODE.
  expect(result.exitCode).toBe(0); expect(result.output).toContain('verified');
});

it('keeps real argument validation, denial and canonical history for dispatched actions', async () => {
  const surface = new StableWorkTools(agentTools({ mode: 'code', workTask: task() }), 10000, text => Math.ceil(text.length / 3));
  surface.discover('jobs', 'command_stop');
  const action = surface.resolve({ name: 'command_stop', input: { jobId: 'invalid' } });
  expect(await call(action.name as ToolName, { jobId: 'invalid' })).toMatchObject({ code: 'INVALID_ARGUMENTS', executed: false });
  settings.toolPermissions.execute = 'deny';
  expect((await call(action.name as ToolName, { jobId: randomUUID() })).error).toContain('blocked');
  expect(history.conversation(conversationId).tools.every(tool => tool.name === 'command_stop')).toBe(true);
});

it('starts without a checklist and saves an optional finish without evidence bookkeeping', () => {
  const t = task(), controller = new WorkTaskController(history.workTasks, t.id);
  expect(controller.beforeOperation('write_file', { path: 'index.html' })).toBeUndefined();
  const id = randomUUID(); history.workTasks.startOperation(t.id, id, 'write_file', { path: 'index.html' });
  history.workTasks.finishOperation(t.id, id, '{"action":"created"}');
  expect(JSON.parse(controller.update('work_finish', { answer: 'Created index.html.' })).accepted).toBe(true);
  expect(controller.task.criteria).toEqual([]); expect(controller.task.answer).toBe('Created index.html.');
  expect(history.workTasks.operations(t.id)[0].id).toBe(id);
});

it('does not turn a recovered invalid-path attempt into an outstanding obligation', () => {
  const t = task(), controller = new WorkTaskController(history.workTasks, t.id);
  for (const [path, result] of [['/skill/frontend-design/dashboard.html', { error: 'Use a relative path inside the Project folder.' }], ['dashboard.html', { action: 'created' }]] as const) {
    const id = randomUUID(); history.workTasks.startOperation(t.id, id, 'write_file', { path }); history.workTasks.finishOperation(t.id, id, JSON.stringify(result));
  }
  expect(JSON.parse(controller.update('work_finish', { answer: 'Created dashboard.html.' })).accepted).toBe(true);
  expect(controller.task.status).toBe('completed');
});

it('records a blocked outcome without making the model prove the blocker to the host', () => {
  const t = task(), controller = new WorkTaskController(history.workTasks, t.id);
  expect(JSON.parse(controller.update('work_finish', { answer: 'The required account is unavailable.', status: 'blocked' })).accepted).toBe(true);
  expect(controller.task.status).toBe('blocked'); expect(controller.task.criteria).toEqual([]);
});

it('does not inject recovery decisions or task state after tool batches', () => {
  const t = task(), controller = new WorkTaskController(history.workTasks, t.id);
  for (let i = 0; i < 8; i++) { const id = randomUUID(); history.workTasks.startOperation(t.id, id, 'read_file', { path: 'x.txt' }); history.workTasks.finishOperation(t.id, id, '{"text":"unchanged"}'); }
  expect(controller.decision('batch')).toEqual({ action: 'continue' });
  expect(controller.decision('context')).toEqual({ action: 'continue' });
});

it('records the model outcome without inferring task semantics from a unit or status label', () => {
  const t = task(), controller = new WorkTaskController(history.workTasks, t.id);
  expect(JSON.parse(controller.update('work_finish', { answer: 'The measurement is unavailable.', status: 'waiting' })).accepted).toBe(true);
});

it('advertises a small core and loads focused groups across provider formats', () => {
  const definitions = agentTools({ mode: 'code', workTask: task(), computer: true, vision: true });
  const catalog = new WorkToolCatalog(definitions);
  expect(catalog.available()).toHaveLength(15);
  expect(catalog.available().map(tool => tool.name)).toContain('read_source');
  expect(definitions.find(tool => tool.name === 'work_finish')?.schema.properties.status).toBeDefined();
  expect(catalog.available().map(t => t.name)).not.toContain('edit_project_file');
  expect(JSON.stringify(catalog.available())).not.toMatch(/expectedSha256|expectedContent|criterionId|workEvidenceRef/);
  const tools = definitions.map(t => ({ type: 'function', function: { name: t.name, parameters: {} } }));
  expect(catalog.select({ tools }).tools).toHaveLength(15);
  catalog.enable('research'); expect(catalog.has('search_web')).toBe(true); expect(catalog.has('browser_click')).toBe(false);
  catalog.enable('desktop'); expect(catalog.guide()).toContain('computer_');
  const anthropic = catalog.select({ tools: definitions.map(t => ({ name: t.name, input_schema: {} })) });
  expect(anthropic.tools.find((t: any) => t.name === 'write_file').input_schema.required).toEqual(['path', 'content']);
});

it('executes the actual graph with lazy tools, a malformed call, file verification, and simple completion', async () => {
  const t = task(), controller = new WorkTaskController(history.workTasks, t.id); let requests = 0;
  const toolCall = (name: string, args: unknown) => ({ id: 'call-' + requests, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), names = body.tools.map((t: any) => t.function.name);
    const calls = [toolCall('load_tools', { group: 'research' }), toolCall('write_file', { path: 'dashboard/index.html', content: 123 }), toolCall('write_file', { path: 'dashboard/index.html', content: '<h1>Verified</h1>' }), toolCall('read_file', { path: 'dashboard/index.html' }), toolCall('work_finish', { answer: 'Created and checked dashboard/index.html.' })];
    if (requests === 0) { expect(names).toHaveLength(15); expect(names).toContain('read_source'); expect(names).toContain('search_web'); } else { expect(names).toContain('search_web'); expect(names).not.toContain('browser_click'); }
    const call = calls[requests++];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'completion-' + requests, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ ...call, index: 0 }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runLibreChat({ mode: 'code', workTask: t, runId: t.runId, route: 'local', provider: 'local', model: 'fixture', protocol: 'openai-compatible', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, tools: true, contextWindowTokens: 64000, instructions: 'Build and verify the dashboard.', messages: [{ role: 'user', text: t.goal }] }, signal(), () => {}, async request => {
      if (request.name.startsWith('work_')) return controller.update(request.name, request.input);
      history.workTasks.startOperation(t.id, request.id, request.name, request.input);
      const result = await broker.execute({ conversationId, runId: t.runId, signal: signal() }, request);
      history.workTasks.finishOperation(t.id, request.id, result); return result;
    }, undefined, undefined, undefined, undefined, undefined, undefined, async event => controller.decision(event));
    expect(requests).toBe(5); expect(controller.task.status).toBe('completed');
    expect(await readFile(join(root, 'dashboard/index.html'), 'utf8')).toBe('<h1>Verified</h1>');
    expect(history.workTasks.operations(t.id).filter(op => op.status === 'failed')).toMatchObject([{ name: 'write_file' }]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it.each(['unknown-tool', 'invalid-json'])('recovers from %s through the actual graph without losing the operation history', async failure => {
  const t = task(), controller = new WorkTaskController(history.workTasks, t.id); let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume request before responding. */ }
    const step = requests++;
    let delta: Record<string, unknown>, finish = 'tool_calls';
    if (step === 0 && failure === 'reasoning-stall') { delta = { role: 'assistant', reasoning_content: 'Reconsidering the same file write. '.repeat(700) }; finish = 'stop'; }
    else {
      const name = step === 0 ? failure === 'unknown-tool' ? 'nonexistent_tool' : 'write_file' : step === 1 ? 'write_file' : step === 2 ? 'read_file' : 'work_finish';
      const args = step === 0 && failure === 'invalid-json' ? '{' : JSON.stringify(step === 0 ? {} : step === 1 ? { path: 'recovered.html', content: '<h1>Recovered</h1>' } : step === 2 ? { path: 'recovered.html' } : { answer: 'Created and verified recovered.html.' });
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'recover-' + step, type: 'function', function: { name, arguments: args } }] };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'recovery-' + step, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runLibreChat({ mode: 'code', workTask: t, runId: t.runId, route: 'local', provider: 'local', model: 'fixture', protocol: 'openai-compatible', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, tools: true, contextWindowTokens: 64000, instructions: 'Build and verify a file.', messages: [{ role: 'user', text: t.goal }] }, signal(), () => {}, async request => {
      if (request.name.startsWith('work_')) return controller.update(request.name, request.input);
      history.workTasks.startOperation(t.id, request.id, request.name, request.input);
      const result = await broker.execute({ conversationId, runId: t.runId, signal: signal() }, request);
      history.workTasks.finishOperation(t.id, request.id, result); return result;
    }, undefined, undefined, undefined, undefined, undefined, undefined, async event => controller.decision(event));
    expect(requests).toBe(4); expect(controller.task.status).toBe('completed');
    expect(await readFile(join(root, 'recovered.html'), 'utf8')).toBe('<h1>Recovered</h1>');
    // Some providers/SDKs normalize a partial JSON object to {}; that still
    // reaches host validation and is durably recorded as INVALID_ARGUMENTS.
    if (failure !== 'reasoning-stall') expect(history.workTasks.operations(t.id).some(op => op.status === 'failed' && /INVALID_TOOL_JSON|INVALID_ARGUMENTS|UNKNOWN_TOOL/.test(op.result))).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);
