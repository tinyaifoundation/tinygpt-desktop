import { app, safeStorage } from 'electron';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { chatExecution, closeChatRuntime } from '../src/main/chat-execution';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings, type Settings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';

// Run from out/main so the real utility-process chat-worker.js is exercised.
if (process.env.TINYGPT_WORK_TEST_PROFILE) app.setPath('userData', process.env.TINYGPT_WORK_TEST_PROFILE);
app.whenReady().then(async () => {
  await mkdir(resolve('.tools-smoke-profile'), { recursive: true });
  await mkdir(resolve('artifacts'), { recursive: true });
  const root = process.env.TINYGPT_WORK_TEST_PROFILE || await mkdtemp(resolve('.tools-smoke-profile/shared-work-'));
  app.setPath('userData', root);
  const history = new HistoryStore(join(root, 'library.sqlite'));
  let scenario = 'complete', calls = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); calls++;
      assert.equal(body.messages[0]?.role, 'system', 'Local templates require a leading system message');
      assert.ok(body.messages.slice(1).every((message: any) => message.role !== 'system'), 'Work state must not introduce a late system message');
      const tools = body.tools.map((t: any) => t.function.name);
      assert.ok(tools.includes('write_file') && tools.includes('run_command')); if (calls === 1) { assert.equal(tools.length, 12); assert.ok(!tools.includes('command_status')); } if (scenario === 'complete' && calls >= 6) assert.ok(tools.includes('command_status'));
      const results = body.messages.filter((m: any) => m.role === 'tool').map((m: any) => { try { return JSON.parse(m.content); } catch { return {}; } });
      const job = results.findLast((r: any) => r.jobId);
      const steps: [string, unknown][] = scenario === 'complete' ? [
        ['work_plan', { steps: ['Create a report', 'Verify it'] }],
        ['work_ask_user', { question: 'Which report format should I use?', options: [{ id: 'plain', label: 'Plain text' }, { id: 'json', label: 'JSON' }] }],
        ['write_file', { path: 'outputs/report.txt', content: 'Shared Work verified' }],
        ['run_command', { executable: 'node', args: ['-e', "console.log(require('node:fs').readFileSync('outputs/report.txt','utf8'));setTimeout(()=>console.log('verified'),150)"], cwd: '.', background: true, timeoutSeconds: 5 }],
        ['load_tools', { group: 'jobs' }],
        ['command_status', { jobId: job?.jobId, waitSeconds: 1 }],
        ['answer', 'Created and verified outputs/report.txt: Shared Work verified.'],
      ] : [
        ['write_file', { path: 'denied.txt', content: 'Must not be written' }],
        ['work_finish', { status: 'blocked', answer: 'File writing is denied by the current policy.' }],
      ];
      const step = steps[calls - 1];
      const delta = step?.[0] === 'answer' ? { role: 'assistant', content: step[1] } : step ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-' + calls, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { role: 'assistant', content: scenario === 'complete' ? 'Created and verified the report.' : 'Writing is blocked by your current policy.' };
      const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'response-' + calls, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(delta, null) + frame({}, step && step[0] !== 'answer' ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch { response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings: Settings = { ...defaultSettings, route: 'local', mode: 'code', effort: { ...defaultSettings.effort, code: 'instant' }, local: { ...defaultSettings.local, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fixture-model', tools: true, contextWindowTokens: 64000 }, toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow', write: 'allow', execute: 'allow' } };
  const fixtureEndpoint = settings.local.endpoint;
  const live = process.env.TINYGPT_WORK_LIVE_ENDPOINT;
  let localSecret: string | undefined;
  if (live) {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(live).hostname), 'Live smoke tests use loopback models only');
    settings.local.endpoint = live; settings.local.model = process.env.TINYGPT_WORK_LIVE_MODEL || 'MiniCPM5-2B';
    settings.toolPermissions = { ...settings.toolPermissions, execute: 'deny', browser: 'deny', interact: 'deny', desktop: 'deny', desktopInteract: 'deny' };
    if (process.env.TINYGPT_WORK_LIVE_PROFILE) {
      const profile = process.env.TINYGPT_WORK_LIVE_PROFILE;
      const credentials = JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8'));
      const registry = JSON.parse(await readFile(join(profile, 'inference-connections.json'), 'utf8'));
      const connection = registry.connections.find((c: any) => c.id === registry.selected.local);
      assert.equal(connection?.config.endpoint, live, 'Use only the selected local connection');
      const encrypted = credentials['connection:' + registry.selected.local] ?? credentials.local;
      if (encrypted) localSecret = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    }
  }
  const browser = { partition: () => 'fixture', handoffs: () => [], tasks: () => [], endRun() {}, shutdown() {} } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  const service = new ChatService(history, () => settings, () => localSecret, chatExecution, () => {}, broker);
  async function idle(id: string) { const deadline = Date.now() + (live ? 75000 : 30000); while (service.isActive(id) && Date.now() < deadline) { const question = service.library().workQuestions?.find(q => q.conversationId === id); if (question) { assert.equal(service.update(id).conversation.messages.at(-1)?.workTask?.status, 'awaiting-input'); await service.answerWorkQuestion({ questionId: question.id, optionId: 'plain' }); } await new Promise(resolve => setTimeout(resolve, 20)); } if (service.isActive(id)) await service.cancel(id); assert.ok(Date.now() < deadline, 'Work must settle'); }
  try {
    const conversation = history.createConversation(null, 'code'); service.start(conversation.id, live ? 'Create outputs/report.txt containing exactly the text "Shared Work verified" (without quotation marks or a trailing newline). Read it back to verify its exact contents, then report the result. Use the managed workspace. Do not install packages or run commands.' : 'Create a report and verify its contents.'); await idle(conversation.id);
    const result = service.update(conversation.id).conversation;
    if (live) console.log(JSON.stringify({ status: result.messages.at(-1)?.workTask?.status, summary: result.messages.at(-1)?.workTask?.summary, tools: result.tools.map(t => ({ name: t.name, status: t.status })) }));
    assert.equal(result.messages.at(-1)?.status, 'complete'); assert.equal(result.messages.at(-1)?.workTask?.status, 'completed');
    if (!live) { assert.equal(result.messages.at(-1)?.text, 'Created and verified outputs/report.txt: Shared Work verified.'); assert.equal(calls, 7); assert.equal(result.tools.filter(t => t.name === 'work_finish').length, 0); assert.equal(result.tools.filter(t => t.name === 'run_command').length, 1); assert.equal(result.tools.filter(t => t.name === 'write_file').length, 1); }
    assert.equal(await readFile(join(history.generatedFilesRoot, conversation.id, 'outputs/report.txt'), 'utf8'), 'Shared Work verified');
    assert.ok(result.tools.some(tool => tool.name === (live ? 'read_file' : 'command_status') && tool.result?.includes('verified')));
    scenario = 'denied'; calls = 0; settings.toolPermissions.write = 'deny';
    localSecret = undefined;
    settings.local.endpoint = fixtureEndpoint; settings.local.model = 'fixture-model';
    const denied = history.createConversation(null, 'code'); service.start(denied.id, 'Create a report'); await idle(denied.id);
    const blocked = service.update(denied.id).conversation.messages.at(-1)!;
    assert.equal(blocked.workTask?.status, 'blocked'); assert.equal(blocked.status, 'complete'); assert.equal(blocked.error, null);
    await assert.rejects(stat(join(history.generatedFilesRoot, denied.id, 'denied.txt')));
    await writeFile(resolve(live ? 'artifacts/shared-work-live-proof.json' : 'artifacts/shared-work-proof.json'), JSON.stringify({ verified: true, profile: root, realWorker: true, liveModel: !!live, bundledNodeCommand: !live, managedWorkspace: true, backgroundJob: !live, normalFinalAnswer: true, userQuestionContinuation: !live, simpleLifecycle: true, denialRespected: true }, null, 2));
    console.log('PASS: real shared worker, host task control, managed Work files, bundled Node background command, normal final answers, and denied writes.');
  } finally { await service.shutdown(); await broker.shutdown(); closeChatRuntime(); history.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}).then(() => app.quit(), error => { console.error(error); app.exit(1); });
