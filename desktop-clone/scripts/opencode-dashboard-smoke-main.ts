import { app, safeStorage } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { HistoryStore } from '../src/main/history';
import { BrowserController } from '../src/main/browser';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { runCodeTask } from '../src/main/work-code';
import { defaultSettings } from '../src/shared/config';
import type { ChatWorkerInput } from '../src/shared/chat';

app.setPath('userData', process.env.TINYGPT_PI_TEST_PROFILE!);
app.setAppPath(resolve('.'));
app.whenReady().then(async () => {
  const profile = app.getPath('userData'), source = process.env.TINYGPT_PI_LIVE_PROFILE;
  const settings = structuredClone(defaultSettings); settings.route = 'local'; settings.mode = 'code';
  for (const key of ['read','write','execute','browser','interact'] as const) settings.toolPermissions[key] = 'allow';
  let secret: string | undefined;
  let calls = 0, compactions = 0, fixtureFailure: unknown, activeController: AbortController | undefined;
  const fixture = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (!body.tools?.length) {
        compactions++;
        const delta = { role: 'assistant', content: 'The browser fixture was repaired in index.html. Console and network tools were exercised. Continue by checking the console once more and report the saved result.' };
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: ' + JSON.stringify({ id: 'summary', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ id: 'summary', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030 } }) + '\n\ndata: [DONE]\n\n');
        return;
      }
      const tools = body.tools.map((tool: any) => tool.function.name); calls++;
      assert.equal(body.model, 'tinygpt-pro', 'The gateway must send the selected real model ID upstream');
      assert.ok(tools.includes('write') && tools.includes('edit') && !tools.includes('apply_patch'), 'TinyGPT branding must not select GPT-specific patch tools');
      const preview = raw.match(/http:\/\/127\.0\.0\.1:\d+\/index\.html/)?.[0];
      assert.ok(tools.includes('chrome_devtools_new_page') && tools.includes('chrome_devtools_list_console_messages'));
      const steps: [string, unknown][] = [
        ['chrome_devtools_new_page', { url: preview }],
        ['chrome_devtools_list_console_messages', { types: ['error'] }],
        ['chrome_devtools_list_network_requests', {}],
        ['write', { filePath: join(workspace, 'index.html'), content: '<!doctype html><title>Fixed fixture</title><button onclick="this.textContent=\'Clicked\'">Test</button><script>const pageTop=document.body;</script>' }],
        ['chrome_devtools_navigate_page', { type: 'reload' }],
        ['chrome_devtools_take_snapshot', {}],
        ['chrome_devtools_list_console_messages', { types: ['error'] }],
      ];
      const [name, args] = steps[calls - 1] ?? [];
      if (calls === 3 && !/Identifier.*top.*already been declared/.test(raw)) throw new Error('Expected the literal browser exception; received: ' + JSON.stringify(body.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content)).slice(-1500));
      const schema = body.tools.find((tool: any) => tool.function.name === name)?.function.parameters;
      if (schema?.required?.includes('pageId') && args) (args as any).pageId = 2;
      const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `fixture-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Fixed and verified the browser fixture.' };
      const frame = (delta: unknown, reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: reason }], ...(reason ? { usage: { prompt_tokens: calls === 6 ? 63000 : 1000, completion_tokens: 30, total_tokens: calls === 6 ? 63030 : 1030 } } : {}) }) + '\n\n';
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(delta, null) + frame({}, name ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) { fixtureFailure = error; response.writeHead(500).end(JSON.stringify({ error: String(error) })); activeController?.abort(error); }
  });
  if (source) {
    const registry = JSON.parse(await readFile(join(source, 'inference-connections.json'), 'utf8'));
    const connection = registry.connections.find((value: any) => value.config.model === 'tinygpt-pro');
    assert.ok(connection && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(connection.config.endpoint).hostname));
    settings.local = { ...settings.local, ...connection.config };
    const credentials = JSON.parse(await readFile(join(source, 'credentials.json'), 'utf8'));
    const encrypted = credentials['connection:' + connection.id] ?? credentials.local;
    if (encrypted) secret = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } else {
    await new Promise<void>(done => fixture.listen(0, '127.0.0.1', done));
    settings.local = { ...settings.local, endpoint: `http://127.0.0.1:${(fixture.address() as any).port}/v1`, model: 'tinygpt-pro', tools: true, contextWindowTokens: 64000, maxOutputTokens: 8192 };
  }
  const history = new HistoryStore(join(profile, 'library.sqlite')), browser = new BrowserController(() => {});
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  const reports: any[] = [];
  let workspace = '';
  try {
    for (const kind of source ? process.env.TINYGPT_DASHBOARD_CASE ? [process.env.TINYGPT_DASHBOARD_CASE] : ['debug', 'build'] : ['fixture']) {
      const resuming = !!process.env.TINYGPT_DASHBOARD_RESUME_SESSION;
      const chat = resuming ? history.conversation(process.env.TINYGPT_DASHBOARD_RESUME_CHAT!) : history.createConversation(null, 'code'), turn = history.startTurn(chat.id, `${kind} dashboard test`, 'local');
      workspace = join(history.generatedFilesRoot, chat.id); await mkdir(workspace, { recursive: true });
      if (!resuming) execFileSync('git', ['init', '--quiet'], { cwd: workspace, windowsHide: true });
      const original = await readFile(resolve('artifacts/work-html-initial.html'), 'utf8');
      if (resuming) {}
      else if (kind === 'debug') await writeFile(join(workspace, 'index.html'), original);
      else if (kind === 'fixture') await writeFile(join(workspace, 'index.html'), '<!doctype html><title>Broken fixture</title><script>const top=document.body;</script>');
      else {
        const start = original.indexOf('const MODELS'), end = original.indexOf('const BENCHES', start);
        await writeFile(join(workspace, 'reference-data.txt'), original.slice(start, end > start ? end : start + 10000));
      }
      const task = resuming ? 'Continue the saved dashboard build. Inspect the current implementation and any previous errors, finish it, then use Chrome DevTools MCP to verify model cards, clock, detail panel and real console/network results. The previous connection was interrupted, so use the preview URL supplied for this task.' : kind === 'debug'
        ? 'Repair the existing index.html dashboard. It looks attractive but model cards and its live clock do not work. Preserve its appearance and data. Diagnose it in Chromium with Chrome DevTools MCP, fix the actual causes, and verify model cards, the clock, and opening/closing a model detail panel. Check actual browser console/network errors. Report concrete results and any remaining blocker.'
        : kind === 'build'
          ? 'Build a beautiful, modern minimalist interactive dashboard in index.html for recent open-weight language models and their benchmarks. Use reference-data.txt as the supplied dataset; no web research or dependencies are needed. Include model cards, benchmark comparisons, a live clock, and an interactive model detail panel. Use Chrome DevTools MCP to test the real app, inspect console/network errors, exercise the detail panel, and fix any failures before reporting the result.'
          : 'Fix and verify this browser fixture.';
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('The bounded dashboard test exceeded 15 minutes.')), 900000);
      activeController = controller;
      const input: ChatWorkerInput = { runId: turn.runId, conversationId: chat.id, route: 'local', provider: 'local', endpoint: settings.local.endpoint, protocol: 'openai-compatible', model: settings.local.model, secret, effort: 'medium', reasoning: settings.local.reasoningOverride ?? settings.local.modelCapabilities?.reasoning, contextWindowTokens: settings.local.contextWindowTokens, maxOutputTokens: settings.local.maxOutputTokens, instructions: '', messages: [{ role: 'user', text: task }] };
      const started = Date.now(), traces: unknown[] = [], actions: any[] = [];
      console.log(JSON.stringify({ stage: 'started', kind, model: input.model, effort: input.effort, conversationId: chat.id }));
      try {
        const result = await runCodeTask({ input, directory: workspace, root: join(profile, 'coding', chat.id), sessionId: process.env.TINYGPT_DASHBOARD_RESUME_SESSION, browser: true, task, signal: controller.signal, native: async event => {
          actions.push(event); if (event.phase === 'before') console.log(JSON.stringify({ kind, seconds: Math.round((Date.now() - started) / 1000), tool: event.name, ...(event.name === 'code_devtools' ? { browserTool: event.args.tool } : {}) }));
          return broker.nativeCode({ conversationId: chat.id, runId: turn.runId, signal: controller.signal }, event);
        }, trace: event => traces.push(event), progress: () => {} });
        if (fixtureFailure) throw fixtureFailure;
        assert.ok(actions.some(event => event.phase === 'before' && event.name === 'code_devtools'));
        if (kind === 'fixture') {
          assert.ok(history.conversation(chat.id).tools.some(tool => tool.name === 'code_devtools' && tool.result?.includes("Identifier 'top' has already been declared")), 'Literal MCP diagnostics must be retained in the Work history');
          assert.ok(compactions > 0, 'Native compaction must create a continuation before completion');
        }
        history.saveReply(turn.assistantId, result.answer, 'complete');
        reports.push({ kind, durationMs: Date.now() - started, workspace, result, actions, traces, ...(kind === 'fixture' ? { nativeCompactions: compactions } : {}) });
        console.log(JSON.stringify({ stage: 'finished', kind, seconds: Math.round((Date.now() - started) / 1000), answer: result.answer }));
      } catch (error) {
        reports.push({ kind, durationMs: Date.now() - started, workspace, error: String(error), actions, traces });
        throw error;
      } finally { clearTimeout(timer); broker.endRun(turn.runId); const proof = JSON.stringify({ profile, model: input.model, effort: 'medium', reports }, null, 2); await writeFile(resolve(`artifacts/opencode-dashboard-${source ? 'live' : 'fixture'}-proof.json`), proof); await writeFile(resolve(`artifacts/opencode-dashboard-${kind}-proof.json`), proof); }
    }
  } finally { await broker.shutdown(); history.close(); fixture.closeAllConnections(); await new Promise<void>(done => fixture.close(() => done())); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
