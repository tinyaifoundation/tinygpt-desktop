// Actual native compaction -> approved edit -> test, without paid inference.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', `work-compaction-${Date.now()}`), folder = join(profile, 'project'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'math.js'), 'exports.add = (a,b) => a-b;\n');
  await writeFile(join(folder, 'math.test.js'), "const {test}=require('node:test');const assert=require('node:assert/strict');test('adds',()=>assert.equal(require('./math').add(2,3),5));\n");
  let app, page, compactions = 0, steps = 0; const requests = [], errors = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw), tools = (input.tools ?? []).map(tool => tool.function.name);
    const text = input.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish = null, inputTokens = 100) => `data: ${JSON.stringify({ id: 'compaction-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: inputTokens, completion_tokens: 10, total_tokens: inputTokens + 10 } } : {}) })}\n\n`;
    if (!tools.length) {
      if (text.includes('Preserve the latest real user request')) compactions++;
      response.end(frame({ role: 'assistant', content: 'The user authorized Phase 3 implementation: fix math.js and run its tests. The file was read; no edit has been made. Next: edit a-b to a+b, then run node --test math.test.js. Required tool approvals remain enforced.' }) + frame({}, 'stop') + 'data: [DONE]\n\n'); return;
    }
    const system = input.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    requests.push({ compactions, persistentInstructions: system.includes('Carry the user\'s requested work through to implementation and verification.'), project: system.includes('Current Project: Work compaction fixture.'), continuation: text.includes('Earlier user authorization and decisions remain in effect') });
    if (steps > 0 && compactions && (!requests.at(-1).persistentInstructions || !requests.at(-1).project || !requests.at(-1).continuation)) { response.end(frame({ role: 'assistant', content: 'Want me to start Phase 3 now?' }) + frame({}, 'stop') + 'data: [DONE]\n\n'); return; }
    const actions = [['read', { filePath: join(folder, 'math.js') }], ['edit', { filePath: join(folder, 'math.js'), oldString: 'a-b', newString: 'a+b', status: 'Fixing the addition helper' }], ['bash', { command: 'node --test math.test.js', workdir: folder, description: 'Verify addition', timeout: 20000 }]];
    const action = actions[steps++];
    if (action) {
      const name = tools.find(name => name === action[0]); assert.ok(name);
      // High reported input usage forces OpenCode's real auto-compaction.
      response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${steps}`, type: 'function', function: { name, arguments: JSON.stringify(action[1]) } }] }) + frame({}, 'tool_calls', steps === 1 ? 61000 : 100) + 'data: [DONE]\n\n');
    } else response.end(frame({ role: 'assistant', content: 'Phase 3 fixture implemented and tested.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); } }, folder);
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const id = await page.evaluate(async endpoint => {
      const bridge = window.tinygpt, settings = (await bridge.snapshot()).value.settings;
      const configured = await bridge.saveSettings({ ...settings, mode: 'code', route: 'local', local: { ...settings.local, endpoint, model: 'fixture', tools: true, contextWindowTokens: 64000 }, toolPermissions: { ...settings.toolPermissions, read: 'allow', write: 'ask', execute: 'ask' } }); if (!configured.ok) throw Error(configured.error);
      const chosen = await bridge.chooseNewProjectFolder(), project = await bridge.createProject('Work compaction fixture', '', false, chosen.value.id), chat = await bridge.createConversation(project.value.id);
      const result = await bridge.sendMessage(chat.value.id, 'Implement Phase 3 now: fix the addition helper in math.js and run node --test math.test.js. The implementation is authorized; do not ask whether to start.', []); if (!result.ok) throw Error(result.error); return chat.value.id;
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload();
    const waitFor = async (predicate, argument) => { const until = Date.now() + 45000; while (Date.now() < until) { if (await page.evaluate(predicate, argument)) return; await new Promise(done => setTimeout(done, 50)); } throw Error('Native compaction fixture timed out.'); };
    for (const tool of ['code_edit', 'code_bash']) {
      await waitFor(async tool => (await window.tinygpt.library()).value.approvals.some(item => item.name === tool), tool);
      const waiting = await page.evaluate(async id => (await window.tinygpt.conversation(id)).value, id); assert.equal(waiting.messages.at(-1).status, 'streaming');
      if (tool === 'code_edit') assert.equal(await readFile(join(folder, 'math.js'), 'utf8'), 'exports.add = (a,b) => a-b;\n', 'Compaction must not bypass edit approval.');
      await page.evaluate(async tool => { const approval = (await window.tinygpt.library()).value.approvals.find(item => item.name === tool); const result = await window.tinygpt.approveTool(approval.id, 'allow-once'); if (!result.ok) throw Error(result.error); }, tool);
    }
    await waitFor(async () => !(await window.tinygpt.library()).value.activeRuns.length);
    const chat = (await page.evaluate(id => window.tinygpt.conversation(id), id)).value;
    assert.equal(chat.messages.at(-1).status, 'complete', chat.messages.at(-1).error); assert.equal(chat.messages.at(-1).text, 'Phase 3 fixture implemented and tested.'); assert.ok(compactions > 0);
    assert.ok(requests.some(request => request.compactions && request.persistentInstructions && request.project && request.continuation));
    assert.equal(await readFile(join(folder, 'math.js'), 'utf8'), 'exports.add = (a,b) => a+b;\n'); assert.equal(JSON.parse(chat.tools.find(tool => tool.name === 'code_bash').result).exitCode, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ compactions, requests, tools: chat.tools.map(tool => ({ name: tool.name, status: tool.status })), checks: ['real native context compaction', 'task instructions and Project survive compaction', 'generated continuation retains existing authorization', 'edit and command approvals enforced', 'real edit and passing test after compaction', 'final answer instead of repeated confirmation'], errors }));
  } catch (error) { console.log(JSON.stringify({ compactions, requests, steps })); if (page) console.log(await page.evaluate(async () => { const lib = (await window.tinygpt.library()).value, chat = (await window.tinygpt.conversation(lib.lastConversationId)).value; return { active: lib.activeRuns.length, approvals: lib.approvals.map(item => item.name), status: chat?.messages.at(-1)?.status, error: chat?.messages.at(-1)?.error }; }).catch(() => ({}))); throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
