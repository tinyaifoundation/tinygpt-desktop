// Real desktop composers, worker/native runtimes and local streaming provider fixtures.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, readFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function main() {
  const work = process.argv.includes('--work');
  const profile = resolve('.tools-smoke-profile', `queue-${work ? 'work' : 'chat'}-${Date.now()}`);
  const folder = join(profile, 'project'); await mkdir(folder, { recursive: true }); await mkdir('artifacts', { recursive: true });
  const requests = []; const holds = new Set(); const errors = []; let app; let page;
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw);
    const users = input.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
    const rawText = users.at(-1);
    // Work combines historical messages into its native bootstrap prompt.
    const text = work ? rawText.match(/(?:^|\n)(HOLD (?:THINKING|ANSWER|STOP)|Queued second request|Edited queued request|After streamed answer|Survives stop and restart|TOOL APPROVAL|Steer during approval)$/)?.[1] ?? rawText : rawText;
    const record = { users, text, input }; requests.push(record);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `queue-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'queue-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (text === 'TOOL APPROVAL') {
      const name = input.tools.find(tool => tool.function.name === 'write').function.name;
      response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'queue_approval_write', type: 'function', function: { name, arguments: JSON.stringify({ filePath: join(folder, 'queue-approval.txt'), content: 'Approved queue fixture.' }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    const finish = () => { clearInterval(timer); holds.delete(finish); if (!response.destroyed) response.end(frame({ content: `Completed ${text}.` }) + frame({}, 'stop') + 'data: [DONE]\n\n'); };
    let timer;
    if (/^HOLD/.test(text)) {
      const reasoning = !text.includes('ANSWER');
      response.write(frame({ role: 'assistant', ...(reasoning ? { reasoning_content: 'Considering the request. ' } : { content: 'Working on your request. ' }) }));
      timer = setInterval(() => response.write(frame(reasoning ? { reasoning_content: 'Still thinking. ' } : { content: 'More detail. ' })), 200);
      holds.add(finish); response.on('close', () => { clearInterval(timer); holds.delete(finish); });
    } else { timer = setTimeout(finish, 750); response.on('close', () => clearTimeout(timer)); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  async function bridge(method, ...args) {
    const result = await page.evaluate(async ({ method, args }) => window.tinygpt[method](...args), { method, args });
    assert.equal(result.ok, true, result.error); return result.value;
  }
  async function wait(predicate, label, ms = 40000) {
    const until = Date.now() + ms; while (Date.now() < until) { if (await predicate()) return; await sleep(60); }
    throw new Error(`Timed out: ${label}`);
  }
  async function launch() {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 30000 });
    page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('Queue renderer:', message.text()); });
    await app.evaluate(({ BrowserWindow, dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
      for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); }
    }, folder);
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
  }
  const composer = () => page.getByRole('textbox', { name: 'Message', exact: true });
  const rows = () => page.locator('.request-queue-row');
  async function prompt(text) { await composer().fill(text); await composer().press('Enter'); }
  let id;
  const conversation = () => bridge('conversation', id);
  const idle = () => wait(async () => !(await bridge('library')).activeRuns.length, 'idle');
  try {
    await launch();
    console.log('Queue smoke: desktop ready.');
    const { settings } = await bridge('snapshot');
    await bridge('saveSettings', { ...settings, mode: work ? 'code' : 'chat', route: 'local', local: { ...settings.local, endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'queue-fixture', tools: work, contextWindowTokens: 64000 }, toolPermissions: { ...settings.toolPermissions, read: 'allow' } });
    if (work) {
      const chosen = await bridge('chooseNewProjectFolder'); const project = await bridge('createProject', 'Queue smoke project', '', false, chosen.id);
      id = (await bridge('createConversation', project.id)).id;
    }
    await page.reload();
    console.log('Queue smoke: configured.');
    await prompt('HOLD THINKING');
    await wait(() => requests.some(record => record.text === 'HOLD THINKING'), 'initial thinking request');
    id = (await bridge('library')).activeRuns[0].conversationId;
    const initialRun = (await bridge('library')).activeRuns[0];
    console.log('Queue smoke: active model request.');
    await prompt('Queued first request'); await prompt('Queued second request');
    await wait(async () => (await rows().count()) === 2, 'two queue rows');
    console.log('Queue smoke: two pending rows.');
    assert.equal(requests.filter(record => record.text.startsWith('Queued')).length, 0);
    await page.getByRole('button', { name: 'Reorder queued request 2', exact: true }).click();
    await page.getByRole('button', { name: 'Move to top', exact: true }).click();
    await wait(async () => (await conversation()).queuedRequests[0].text === 'Queued second request', 'click reorder');
    await page.getByRole('button', { name: 'Reorder queued request 1', exact: true }).dragTo(rows().nth(1));
    await wait(async () => (await conversation()).queuedRequests[0].text === 'Queued first request', 'drag reorder');
    await composer().fill('Existing composer draft');
    await page.getByRole('button', { name: 'Options for queued request 1', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Edit in composer', exact: true }).click();
    await wait(async () => (await composer().inputValue()) === 'Queued first request', 'edit in composer');
    assert.equal((await conversation()).queuedRequests[0].text, 'Existing composer draft');
    await composer().fill('Edited queued request'); await composer().press('Enter');
    await wait(async () => (await rows().count()) === 3, 'edited request requeued');
    await page.getByRole('button', { name: 'Delete queued request 1', exact: true }).click();
    await wait(async () => (await rows().count()) === 2, 'delete queue row');
    await page.screenshot({ path: resolve(`artifacts/request-queue-${work ? 'work' : 'chat'}.png`) });
    await page.evaluate(() => {
      const root = document.documentElement; const appearance = JSON.parse(localStorage.getItem('tinygpt-appearance-v4'));
      root.dataset.theme = 'dark'; root.style.colorScheme = 'dark';
      root.style.setProperty('--background', appearance.dark.background); root.style.setProperty('--foreground', appearance.dark.foreground);
    });
    await page.screenshot({ path: resolve(`artifacts/request-queue-${work ? 'work' : 'chat'}-dark.png`) });
    await page.getByRole('button', { name: 'Steer queued request 1', exact: true }).click();
    await wait(async () => (await conversation()).messages.some(message => message.role === 'user' && message.text === 'Queued second request'), 'steering acknowledged');
    assert.equal((await bridge('library')).activeRuns[0]?.runId, initialRun.runId);
    if (work) { for (const finish of [...holds]) finish(); }
    await wait(() => requests.some(record => record.text === 'Queued second request'), 'same-run steering reached provider');
    const steeredRequest = requests.find(record => record.text === 'Queued second request');
    assert.ok(steeredRequest.users.includes('HOLD THINKING'));
    await idle();
    assert.deepEqual(requests.filter(record => /^(Queued|Edited)/.test(record.text)).map(record => record.text), ['Queued second request', 'Edited queued request']);
    assert.equal((await conversation()).queuedRequests.length, 0);
    assert.equal((await conversation()).messages.filter(message => message.role === 'assistant').length, 2, 'Steering stays in the current host run');
    await page.getByText('Completed Queued second request.', { exact: true }).waitFor();
    console.log(`${work ? 'Work' : 'Chat'}: queue, click/drag order, delete, draft-preserving edit, same-run thinking steering and automatic FIFO passed.`);
    // Partial-answer steering and stopping must not silently launch queued work.
    await prompt('HOLD ANSWER'); await wait(() => requests.some(record => record.text === 'HOLD ANSWER'), 'answer streaming');
    await composer().fill('After streamed answer'); await composer().press('Control+Shift+Enter');
    await wait(async () => (await conversation()).messages.some(message => message.text === 'After streamed answer'), 'answer steering acknowledged');
    if (work) { for (const finish of [...holds]) finish(); }
    await idle(); assert.ok(requests.some(record => record.text === 'After streamed answer'));
    await prompt('HOLD STOP'); await wait(() => requests.some(record => record.text === 'HOLD STOP'), 'stoppable request');
    await prompt('Survives stop and restart'); await bridge('cancelMessage', id); await idle();
    assert.equal((await conversation()).queuePaused, true);
    assert.equal(requests.some(record => record.text === 'Survives stop and restart'), false);
    await app.close(); await launch();
    assert.equal((await conversation()).queuedRequests[0].text, 'Survives stop and restart');
    assert.equal((await conversation()).queuePaused, true);
    await page.getByRole('button', { name: 'Resume queue', exact: true }).click(); await idle();
    assert.equal((await conversation()).queuedRequests.length, 0);
    assert.ok(requests.some(record => record.text === 'Survives stop and restart'));
    if (work) {
      await prompt('TOOL APPROVAL');
      await wait(async () => (await bridge('library')).approvals.length > 0, 'native write approval');
      assert.equal(await composer().isVisible(), true, 'Keep composer visible alongside the approval');
      await prompt('Steer during approval');
      await page.getByRole('button', { name: 'Steer queued request 1', exact: true }).click();
      await wait(async () => (await conversation()).queuedRequests.length === 0, 'native steering during approval');
      await page.getByRole('button', { name: 'Allow once', exact: false }).click(); await idle();
      assert.equal(await readFile(join(folder, 'queue-approval.txt'), 'utf8'), 'Approved queue fixture.');
      assert.equal((await conversation()).tools.filter(tool => tool.name === 'code_write').length, 1);
      assert.ok(requests.some(record => record.text === 'Steer during approval'));
      console.log('Work: usable composer during native approval, accepted steering, and one approved file write passed.');
    }
    assert.deepEqual(errors, []);
    console.log(`${work ? 'Work' : 'Chat'}: answer steering, stop/pause, durable restart/resume and renderer error checks passed.`);
  } catch (error) {
    if (page) { console.log('Queue smoke state', JSON.stringify({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 1500), requests: requests.map(record => record.text), conversation: id ? await conversation().catch(() => null) : null, errors })); await page.screenshot({ path: resolve('artifacts/request-queue-failure.png') }).catch(() => {}); }
    throw error;
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
