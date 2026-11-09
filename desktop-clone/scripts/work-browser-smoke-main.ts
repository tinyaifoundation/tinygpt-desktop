import { app } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { BrowserController } from '../src/main/browser';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { ChatService } from '../src/main/chat-service';
import { chatExecution, closeChatRuntime } from '../src/main/chat-execution';
import { createWorkExecution } from '../src/main/work-execution';
import { defaultSettings } from '../src/shared/config';
import type { TraceEvent, TraceSink } from '../src/shared/diagnostics';

app.setPath('userData', process.env.TINYGPT_PI_TEST_PROFILE!);
app.whenReady().then(async () => {
  const profile = app.getPath('userData'), history = new HistoryStore(join(profile, 'library.sqlite'));
  const browser = new BrowserController(() => {}), traces: TraceEvent[] = [];
  let phase = 'seed', step = 0, tabId = '', previewUrl = '', failed: unknown;
  let stableWire: string | undefined;
  const latest = (body: any) => JSON.parse(body.messages.filter((m: any) => m.role === 'tool').at(-1).content);
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), names = body.tools.map((t: any) => t.function.name); step++;
      stableWire ??= JSON.stringify(body.tools);
      assert.equal(JSON.stringify(body.tools), stableWire, 'Common browser wire definitions stay identical across discovery and native continuation');
      if (phase === 'display-overflow') {
        const frame = (delta: unknown, finish: string | null = null) => 'data: ' + JSON.stringify({ id: 'host-error', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
        const delta = step === 1
          ? frame({ role: 'assistant', reasoning_content: 'x'.repeat(300000) }) + frame({ reasoning_content: 'y'.repeat(200001) }) + frame({ content: 'p'.repeat(500001) }) + frame({ tool_calls: [{ index: 0, id: 'after-display-overflow', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'after-display-limit.txt', content: 'Work continued after the old limit.' }) } }] }) + frame({}, 'tool_calls')
          : frame({ role: 'assistant', content: 'Work continued and saved the file.' }) + frame({}, 'stop');
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(delta + 'data: [DONE]\n\n');
        return;
      }
      let name: string | undefined, args: unknown, answer = 'Created browser fixture without opening a tab.';
      if (phase === 'seed') {
        assert.ok(names.includes('browser_preview') && names.includes('browser_open') && names.includes('invoke_tool'), 'Common local browser schemas must be stable from the initial request');
        const writes = [
          { path: 'index.html', content: '<!doctype html><title>Work browser fixture</title><link rel="stylesheet" href="/assets/app.css"><button id="increment">Increment count</button><output id="count">Count: 0</output><script src="assets/app.js"></script>' },
          { path: 'assets/app.js', content: 'let count=0;document.querySelector("#increment").onclick=()=>document.querySelector("#count").textContent="Count: "+(++count);' },
          { path: 'assets/app.css', content: 'body{background:rgb(12,34,56);color:white}' },
        ];
        if (step <= writes.length) { name = 'write'; args = writes[step - 1]; }
      } else {
        assert.ok(raw.includes('Created browser fixture'), 'Continue must restore the previous native Pi session');
        if (step === 1) {
          assert.ok(names.includes('browser_preview') && names.includes('invoke_tool'), 'A resumed local session starts with the stable common browser selection');
          name = 'load_tools'; args = { group: 'browser' };
        } else {
          assert.ok(names.includes('browser_preview') && names.includes('browser_click'), 'Browser tools must really reach the next model request');
          if (step === 2) {
            const activated = latest(body).tools;
            assert.deepEqual([...activated].sort(), [...names].sort(), 'Tool loading must report the actual provider-visible tools');
            name = 'browser_preview'; args = { path: 'index.html' };
          } else if (step === 3) {
            const page = latest(body); assert.ok(!page.error, JSON.stringify(page));
            tabId = page.tabId; previewUrl = page.url;
            const button = page.elements.find((e: any) => e.role === 'button' && e.label === 'Increment count'); assert.ok(button, 'Local scripts must render a live accessible control');
            assert.match(page.text, /Count: 0/);
            name = 'browser_click'; args = { tabId, elementId: button.id };
          } else if (step === 4) {
            assert.match(latest(body).text, /Count: 1/, 'Click must execute the local app JavaScript');
            name = 'browser_snapshot'; args = { tabId };
          } else {
            assert.match(latest(body).text, /Count: 1/);
            const style = await browser.contents(chat.id, tabId).executeJavaScript('getComputedStyle(document.body).backgroundColor');
            assert.equal(style, 'rgb(12, 34, 56)', 'Root-relative CSS assets must load');
            browser.activate(chat.id, tabId); // Keep a watched preview after the model turn ends.
            answer = 'Verified the existing app in the browser: Count: 1.';
          }
        }
      }
      if (name) assert.ok(names.includes(name), `Tool must be offered: ${name}`);
      const delta = name ? { role: 'assistant', tool_calls: [{ index: 0, id: `browser-${phase}-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: answer };
      const frame = (value: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: `fixture-${step}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] }) + '\n\n';
      // Real models commonly emit prose before a tool call in the same response.
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end((name ? frame({ role: 'assistant', content: 'Checking the next step. ' }, null) : '') + frame(delta, null) + frame({}, name ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) { failed ??= error; console.error('Browser fixture:', error); response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept));
  const settings = { ...structuredClone(defaultSettings), route: 'local' as const, mode: 'code' as const };
  settings.local = { ...settings.local, model: 'fixture', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, tools: true, contextWindowTokens: 64000, maxOutputTokens: 8192 };
  for (const key of ['read', 'write', 'browser', 'interact'] as const) settings.toolPermissions[key] = 'allow';
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  const diagnostics: TraceSink = { begin() {}, record(_id, event) { traces.push(event); }, stamp() { return undefined; } };
  const service = new ChatService(history, () => settings, () => undefined, chatExecution, () => {}, broker, undefined, undefined, diagnostics, createWorkExecution(history));
  const chat = history.createConversation(null, 'code');
  async function finish() {
    const deadline = Date.now() + 30000;
    while (service.isActive(chat.id) && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 20));
    if (failed) throw failed;
    assert.ok(!service.isActive(chat.id), 'Work must finish');
    const reply = history.conversation(chat.id).messages.at(-1)!;
    assert.equal(reply.status, 'complete', reply.error ?? 'Expected a completed reply'); return reply;
  }
  try {
    service.start(chat.id, 'Create the fixture app.'); const first = await finish();
    const pointer = JSON.parse(await readFile(join(profile, 'work-runtime', chat.id, 'messages', first.id + '.json'), 'utf8'));
    const originalSession = await readFile(pointer.file, 'utf8');
    assert.ok(originalSession.includes('"name":"browser_preview"'), 'The saved session records the common browser declarations from startup');
    settings.toolPermissions.read = 'deny';
    const denied = JSON.parse(await broker.execute({ conversationId: chat.id, runId: randomUUID(), signal: new AbortController().signal }, { id: randomUUID(), name: 'browser_preview', input: { path: 'index.html' } }));
    assert.ok(denied.error, 'Browser permission must not bypass denied local-file reading');
    settings.toolPermissions.read = 'ask';
    const approvalContext = { conversationId: chat.id, runId: randomUUID(), signal: new AbortController().signal };
    const asking = broker.execute(approvalContext, { id: randomUUID(), name: 'browser_preview', input: { path: 'index.html' } });
    const deadline = Date.now() + 5000;
    while (!broker.approvals().length && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 10));
    assert.equal(broker.approvals().length, 1, 'Local-file access still requires approval when browser access is allowed');
    broker.respond(broker.approvals()[0].id, 'allow-run');
    const approved = JSON.parse(await asking); assert.ok(approved.tabId, JSON.stringify(approved));
    const repeated = JSON.parse(await broker.execute(approvalContext, { id: randomUUID(), name: 'browser_preview', input: { path: 'index.html' } }));
    assert.equal(repeated.tabId, approved.tabId, 'Run approval covers reloading the same preview without a new prompt or server');
    broker.endRun(approvalContext.runId);
    settings.toolPermissions.read = 'allow';
    phase = 'resume'; step = 0;
    service.start(chat.id, 'Continue the existing app. Test it in the browser.'); await finish();
    assert.equal(await readFile(pointer.file, 'utf8'), originalSession, 'Resuming must preserve the original branch');
    assert.ok(traces.some(e => e.event === 'tools-activated' && e.toolNames?.includes('browser_preview')));
    assert.ok(traces.some(e => e.event === 'text-lane' && e.lane === 'progress'));
    assert.ok(!traces.some(e => e.event === 'text-lane' && e.lane === 'answer'), 'Pi prose must never speculate that a streamed response is final');
    for (const name of ['browser_preview', 'browser_click', 'browser_snapshot']) assert.ok(history.conversation(chat.id).tools.some(t => t.name === name && t.status === 'success'));
    assert.equal((await fetch(previewUrl)).status, 200, 'A watched preview stays served after completion');
    settings.toolPermissions.read = 'deny'; assert.equal((await fetch(previewUrl)).status, 404); settings.toolPermissions.read = 'allow';
    browser.closeTab(chat.id, tabId); await new Promise(accept => setTimeout(accept, 50)); await assert.rejects(fetch(previewUrl));
    const transient = await browser.preview(chat.id, 'persist:transient-preview', join(history.generatedFilesRoot, chat.id), 'index.html', new AbortController().signal, 'transient');
    browser.endRun('transient'); await new Promise(accept => setTimeout(accept, 50)); await assert.rejects(fetch(transient.url));
    phase = 'display-overflow'; step = 0; settings.local.contextWindowTokens = 1000000;
    const errorChat = history.createConversation(null, 'code');
    service.start(errorChat.id, 'Exercise the host display limit.');
    const errorDeadline = Date.now() + 15000;
    while (service.isActive(errorChat.id) && Date.now() < errorDeadline) await new Promise(accept => setTimeout(accept, 20));
    assert.ok(!service.isActive(errorChat.id));
    const errorReply = history.conversation(errorChat.id).messages.at(-1)!;
    assert.equal(errorReply.status, 'complete', errorReply.error ?? 'Display overflow must not stop Work');
    assert.equal(errorReply.text, 'Work continued and saved the file.');
    assert.ok((errorReply.reasoning?.length ?? 0) <= 500000);
    assert.ok(errorReply.workActivity!.reduce((n, entry) => n + (['prose', 'reasoning'].includes(entry.kind) ? entry.text.length : 0), 0) <= 500000);
    assert.ok(errorReply.workActivity!.some(entry => entry.omittedCharacters));
    assert.equal(await readFile(join(history.generatedFilesRoot, errorChat.id, 'after-display-limit.txt'), 'utf8'), 'Work continued after the old limit.');
    const overflowPointer = JSON.parse(await readFile(join(profile, 'work-runtime', errorChat.id, 'messages', errorReply.id + '.json'), 'utf8'));
    const overflowRaw = await readFile(overflowPointer.file, 'utf8');
    assert.ok(overflowRaw.includes('x'.repeat(300000)) && overflowRaw.includes('y'.repeat(200001)) && overflowRaw.includes('p'.repeat(500001)), 'Native history must retain the full generation independently of display retention');
    const proof = { verified: true, profile, resumedNativeSession: true, commonBrowserToolsPresentInitially: true, stableToolDefinitions: true, actualBrowserToolsActivated: true, truthfulToolLoading: true, localHtmlAndAssets: true, clickedAppResult: 'Count: 1', fileReadDenial: true, readApprovalAndReload: true, watchedPreviewSurvivesTurn: true, revokedPreviewAccess: true, previewCleanup: true, displayOverflowContinues: true, exactNativeHistoryPreserved: true };
    await writeFile(resolve('artifacts/work-browser-proof.json'), JSON.stringify(proof, null, 2));
    console.log('PASS:', JSON.stringify(proof));
  } finally {
    await service.shutdown(); await broker.shutdown(); closeChatRuntime(); history.close();
    server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
