// Real Electron, LibreChat and native OpenCode; isolated files and local inference.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { mkdir, readFile, access } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const profile = resolve('.tools-smoke-profile', `concurrent-${Date.now()}`);
  const folder = join(profile, 'shared Project with spaces'); await mkdir(folder, { recursive: true });
  const calls = new Map(); const waiting = new Map(); const errors = []; let app, page;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); const text = JSON.stringify(body.messages);
      const lane = ['CHAT_SLOW', 'CHAT_LONG', 'CODE_ALPHA', 'CODE_BETA', 'CHAT_LOOP'].find(lane => text.includes(lane)) ?? 'METADATA';
      const n = (calls.get(lane) ?? 0) + 1; calls.set(lane, n);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: `${lane}-${n}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}) })}\n\n`;
      const finish = text => response.end(frame({ role: 'assistant', content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n');
      const tool = (suffix, args) => {
        const name = (body.tools ?? []).map(tool => tool.function.name).find(name => name === suffix || name.endsWith(`_${suffix}`));
        if (!name) throw new Error(`Missing fixture tool: ${suffix}`);
        response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: `${lane}-call-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
      };
      if (lane === 'CHAT_SLOW') { response.write(frame({ role: 'assistant', content: 'Chat remains running.' })); waiting.set(lane, () => finish('Finished CHAT_SLOW.')); }
      else if (lane === 'CHAT_LONG') { if (n <= 25) tool('search_sources', { query: `Evidence ${n}` }); else finish('Completed CHAT_LONG with 25 searches.'); }
      else if (lane === 'CHAT_LOOP') tool('read_project_file', { path: 'missing.md' });
      else if (lane.startsWith('CODE_')) {
        if (n === 1) tool('write', { filePath: join(folder, `${lane}.md`), content: `Saved ${lane}.\n`, status: `Saving ${lane}`, permission: 'May I save this task’s report?' });
        else if (n === 2) tool('bash', { command: `node -e "setTimeout(()=>console.log('${lane}_CHECK'),5000)"`, description: `Check ${lane}`, workdir: folder, timeout: 20000 });
        else waiting.set(lane, () => finish(`Finished ${lane}.`));
      } else finish('{"title":"Fixture task","summary":"Local fixture work.","topicChanged":false}');
      const keepalive = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(': waiting\n\n'); }, 1000);
      response.on('close', () => { clearInterval(keepalive); waiting.delete(lane); });
    } catch (error) { errors.push(error.message); response.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const library = () => page.evaluate(async () => { const result = await window.tinygpt.library(); if (!result.ok) throw new Error(result.error); return result.value; });
  const conversation = id => page.evaluate(async id => (await window.tinygpt.conversation(id)).value, id);
  async function wait(predicate, message, timeout = 90000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await predicate()) return; await new Promise(done => setTimeout(done, 75)); } throw new Error(message); }
  async function launch() {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(90000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow, dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } }, folder);
  }
  try {
    await launch();
    await page.evaluate(async endpoint => { const current = (await window.tinygpt.snapshot()).value; const result = await window.tinygpt.saveSettings({ ...current.settings, mode: 'chat', route: 'local', local: { endpoint, model: 'fixture', tools: true, contextWindowTokens: 64000 }, toolPermissions: { ...current.settings.toolPermissions, read: 'allow', write: 'ask', execute: 'allow' } }); if (!result.ok) throw new Error(result.error); }, endpoint);
    await page.reload();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('CHAT_SLOW'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await wait(() => waiting.has('CHAT_SLOW'), 'The first Chat stream did not start.');
    const slowId = (await library()).activeRuns[0].conversationId;
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('CHAT_LONG');
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), true);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await wait(async () => (await library()).activeRuns.length === 2, 'Concurrent Chat runs did not appear.');
    const longId = (await library()).activeRuns.find(run => run.conversationId !== slowId).conversationId;
    await wait(async () => !(await library()).activeRuns.some(run => run.conversationId === longId), 'Long Chat did not complete.');
    const long = await conversation(longId); assert.equal(long.messages.at(-1).status, 'complete'); assert.equal(long.tools.length, 25); assert.ok(long.tools.every(tool => tool.status === 'success'));
    assert.ok((await library()).activeRuns.some(run => run.conversationId === slowId));
    const ids = await page.evaluate(async () => {
      const bridge = window.tinygpt; const settings = (await bridge.snapshot()).value.settings;
      await bridge.saveSettings({ ...settings, mode: 'code' });
      const choice = (await bridge.chooseNewProjectFolder()).value;
      const project = (await bridge.createProject('Concurrent tasks', '', false, choice.id)).value;
      const a = (await bridge.createConversation(project.id)).value, b = (await bridge.createConversation(project.id)).value;
      const first = await bridge.sendMessage(a.id, 'CODE_ALPHA', []), second = await bridge.sendMessage(b.id, 'CODE_BETA', []);
      if (!first.ok || !second.ok) throw new Error(first.error ?? second.error);
      return { a: a.id, b: b.id, projectId: project.id };
    });
    await page.reload();
    await wait(async () => (await library()).approvals.filter(approval => [ids.a, ids.b].includes(approval.conversationId)).length === 2, 'Concurrent native approvals did not appear.');
    assert.equal((await library()).activeRuns.length, 3);
    await wait(async () => await page.locator('.sidebar-run-spinner').count() === 3, 'Sidebar did not show all running conversations.');
    const approvals = (await library()).approvals;
    // Approve Beta first while Alpha remains waiting: no global queue blockage.
    await page.evaluate(async id => { const result = await window.tinygpt.approveTool(id, 'allow-once'); if (!result.ok) throw new Error(result.error); }, approvals.find(approval => approval.conversationId === ids.b).id);
    await wait(async () => (await conversation(ids.b)).tools.some(tool => tool.name === 'code_bash' && tool.status === 'running'), 'Beta was blocked by Alpha’s approval.');
    assert.ok((await library()).approvals.some(approval => approval.conversationId === ids.a));
    await page.evaluate(async id => { const result = await window.tinygpt.approveTool(id, 'allow-once'); if (!result.ok) throw new Error(result.error); }, approvals.find(approval => approval.conversationId === ids.a).id);
    await wait(async () => (await conversation(ids.a)).tools.some(tool => tool.name === 'code_bash' && tool.status === 'running'), 'Alpha’s command did not start.');
    await page.evaluate(async id => { const result = await window.tinygpt.cancelMessage(id); if (!result.ok) throw new Error(result.error); }, ids.a);
    assert.equal((await conversation(ids.a)).messages.at(-1).status, 'cancelled'); assert.ok((await library()).activeRuns.some(run => run.conversationId === ids.b));
    await wait(() => waiting.has('CODE_BETA'), 'Beta did not reach its final response.');
    const slowTitle = (await library()).conversations.find(chat => chat.id === slowId).title;
    await page.locator('.sidebar-chat-row').filter({ hasText: slowTitle }).click();
    await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
    await wait(async () => !(await library()).activeRuns.some(run => run.conversationId === slowId), 'Chat Stop did not stop the selected reply.');
    assert.ok((await library()).activeRuns.some(run => run.conversationId === ids.b));
    waiting.get('CODE_BETA')();
    await wait(async () => !(await library()).activeRuns.length, 'All completed runs did not clear.');
    assert.equal((await conversation(ids.b)).messages.at(-1).status, 'complete');
    assert.equal(await readFile(join(folder, 'CODE_ALPHA.md'), 'utf8'), 'Saved CODE_ALPHA.\n'); assert.equal(await readFile(join(folder, 'CODE_BETA.md'), 'utf8'), 'Saved CODE_BETA.\n');
    const loopId = await page.evaluate(async projectId => { const settings = (await window.tinygpt.snapshot()).value.settings; await window.tinygpt.saveSettings({ ...settings, mode: 'chat' }); const chat = (await window.tinygpt.createConversation(projectId)).value; await window.tinygpt.sendMessage(chat.id, 'CHAT_LOOP', []); return chat.id; }, ids.projectId);
    await wait(async () => !(await library()).activeRuns.some(run => run.conversationId === loopId), 'Failed-action loop did not pause.');
    const loop = await conversation(loopId); assert.equal(loop.messages.at(-1).status, 'interrupted'); assert.match(loop.messages.at(-1).error, /same action kept failing/); assert.equal(loop.tools.length, 3);
    // Shutdown cancels multiple real worker streams; restart preserves their partials.
    const shutdownIds = await page.evaluate(async () => { const result = []; for (let n = 0; n < 2; n++) { const chat = (await window.tinygpt.createConversation(null)).value; await window.tinygpt.sendMessage(chat.id, `CHAT_SLOW shutdown ${n}`, []); result.push(chat.id); } return result; });
    await wait(() => calls.get('CHAT_SLOW') >= 3, 'Shutdown streams did not start.'); await app.close(); app = null;
    await launch(); assert.equal((await library()).activeRuns.length, 0);
    for (const id of shutdownIds) assert.equal((await conversation(id)).messages.at(-1).status, 'cancelled');
    assert.equal((await conversation(ids.b)).messages.at(-1).status, 'complete'); await access(join(folder, 'CODE_BETA.md'));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ profile, calls: Object.fromEntries(calls), checks: ['concurrent Chat and Code', '25-tool Chat beyond old step limit', 'independent native approval queues', 'all sidebar spinners', 'scoped Chat and native-command cancellation', 'preserved native files', 'recoverable failed-action loop', 'multi-run shutdown/restart'], errors }));
  } catch (error) {
    if (page) console.error(await library().then(value => ({ activeRuns: value.activeRuns, approvals: value.approvals.map(approval => ({ conversationId: approval.conversationId, name: approval.name })), calls: Object.fromEntries(calls) })).catch(() => ({})));
    throw error;
  } finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
