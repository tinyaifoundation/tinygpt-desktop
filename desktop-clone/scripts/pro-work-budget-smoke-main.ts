import { app, safeStorage } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { createWorkExecution } from '../src/main/work-execution';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import { builtInModelInfo } from '../src/shared/managed-local';
import { runCodeTask } from '../src/main/work-code';
import { randomUUID } from 'node:crypto';

app.setPath('userData', process.env.TINYGPT_PRO_TEST_PROFILE!);
app.whenReady().then(async () => {
  const profile = process.env.TINYGPT_PRO_LIVE_PROFILE!, stage = app.getPath('userData');
  const live = new DatabaseSync(join(profile, 'library.sqlite'), { readOnly: true });
  const isBusy = () => !!live.prepare("SELECT 1 FROM messages WHERE status IN ('streaming','pending') LIMIT 1").get();
  if (process.env.TINYGPT_PRO_WAIT_IDLE === '1' && isBusy()) {
    console.log('Waiting for the live model to become idle; no inference sent.');
    const idleDeadline = Date.now() + 600000;
    while (isBusy() && Date.now() < idleDeadline) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(!isBusy(), 'Live model is busy; do not compete with a user run.');
  const registry = JSON.parse(await readFile(join(profile, 'inference-connections.json'), 'utf8'));
  const connection = registry.connections.find((c: any) => c.config.model === 'tinygpt-pro');
  assert.ok(connection && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.config.endpoint).hostname));
  const credentials = JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8'));
  const encrypted = credentials['connection:' + connection.id] ?? credentials.local;
  const secret = encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '';
  const endpoint = connection.config.endpoint.replace(/\/+$/, '');
  const controller = new AbortController();
  const guard = setInterval(() => { if (isBusy()) controller.abort(new Error('User work resumed; isolated test stopped.')); }, 250);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
  const history = new HistoryStore(join(stage, 'library.sqlite'));
  const settings = structuredClone(defaultSettings); settings.route = 'local'; settings.mode = 'code'; settings.effort.code = 'max';
  settings.local = { ...connection.config, endpoint, tools: true, images: false, reasoningOverride: builtInModelInfo('pro').reasoning };
  settings.toolPermissions = { ...settings.toolPermissions, read: 'allow', write: 'allow', execute: 'deny', browser: 'deny', desktop: 'deny', desktopInteract: 'deny' };
  const browser = { partition: () => 'fixture', handoffs: () => [], tasks: () => [], endRun() {}, shutdown() {} } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  const execution = createWorkExecution(history);
  const service = new ChatService(history, () => settings, () => secret, execution, () => {}, broker, undefined, undefined, undefined, execution);
  try {
    const started = Date.now();
    // Deliberately tiny reasoning allowance exercises the native end-of-thinking
    // boundary. The offered write is synthetic and is never executed.
    const probe = await fetch(endpoint + '/chat/completions', { method: 'POST', signal, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tinygpt-pro', reasoning_effort: 'xhigh', reasoning_budget_tokens: 64, max_tokens: 2048, temperature: 0, chat_template_kwargs: { enable_thinking: true }, messages: [{ role: 'system', content: 'Use the write tool for the requested file. Return only the tool call, without commentary.' }, { role: 'user', content: 'Think through a complete dashboard layout with cards, filters, charts and responsive styling. First save exactly <h1>Ready</h1> to index.html using write, before any further work.' }], tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } } }] }) });
    assert.ok(probe.ok, 'Native budget request accepted'); const body = await probe.json();
    const choice = body.choices[0], message = choice.message;
    assert.equal(choice.finish_reason, 'tool_calls'); assert.ok(!message.content?.trim(), 'No unfinished reasoning in content channel');
    assert.equal(message.tool_calls[0].function.name, 'write');
    assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { filePath: 'index.html', content: '<h1>Ready</h1>' });
    assert.ok((message.reasoning_content?.length ?? 0) < 2000, 'The tiny allowance actually bounds thinking');
    console.log('PASS: native Pro thinking boundary returned a complete, clean tool call.');
    const input = { mode: 'code' as const, runId: randomUUID(), route: 'local' as const, provider: 'local', protocol: 'openai-compatible' as const, model: 'tinygpt-pro', endpoint, secret, tools: true, effort: 'max' as const, reasoning: builtInModelInfo('pro').reasoning, contextWindowTokens: 65536, maxOutputTokens: 16384, instructions: '', messages: [] };
    const chat = history.createConversation(null, 'code'), directory = join(history.generatedFilesRoot, chat.id); await mkdir(directory, { recursive: true });
    const context = { conversationId: chat.id, runId: input.runId, signal };
    const code = await runCodeTask({ input, root: join(stage, 'coder'), directory, signal, task: 'Create a tiny local dashboard with index.html, style.css and app.js. First write a minimal working index.html, then add its supporting files through small complete changes. It should display three hardcoded example deals and a functioning text filter. No web research, commands, package installs or browser. Read the three files back and check script/stylesheet links before finishing. Keep the total implementation under 3 KB.', native: event => broker.nativeCode(context, event) });
    for (const file of ['index.html', 'style.css', 'app.js']) assert.ok((await readFile(join(directory, file), 'utf8')).length > 0);
    console.log('PASS: native Coding agent at Pro Max saved and read back a multi-file dashboard.');
    signal.throwIfAborted();
    const direct = history.createConversation(null, 'code');
    service.start(direct.id, 'Use your direct native file tools, without delegation, research or commands. Save notes.txt with exactly "First draft", read it, use edit to change it to exactly "Verified draft", read it back and finish.');
    while (service.isActive(direct.id)) { if (signal.aborted) { await service.cancel(direct.id); signal.throwIfAborted(); } await new Promise(resolve => setTimeout(resolve, 100)); }
    const result = history.conversation(direct.id).messages.at(-1)!; assert.equal(result.status, 'complete', result.error ?? 'Pi must complete');
    assert.equal(await readFile(join(history.generatedFilesRoot, direct.id, 'notes.txt'), 'utf8'), 'Verified draft');
    const proof = { verified: true, model: 'TinyGPT Pro', effort: 'Max (native xhigh)', totalOutputTokens: 16384, thinkingAllowance: 8192, forcedBoundaryProbe: { reasoningAllowance: 64, finish: choice.finish_reason, reasoningChars: message.reasoning_content?.length ?? 0, cleanToolArguments: true }, nativeCoderSession: code.sessionId, codingFiles: 3, piWriteEditRead: true, elapsedMs: Date.now() - started };
    await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/pro-work-budget-proof.json', JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
  } finally { clearInterval(guard); controller.abort(); await service.shutdown(); await broker.shutdown(); history.close(); live.close(); }
}).then(() => app.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : 'Pro verification failed.'); app.exit(1); });
