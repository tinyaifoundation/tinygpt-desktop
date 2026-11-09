// Large disposable library, local inference only, no account access.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild'); const { mkdir, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path'); const { randomUUID } = require('node:crypto'); const { createServer } = require('node:http'); const assert = require('node:assert/strict');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function poll(read, timeout = 60000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await read()) return; await delay(100); } throw Error('Performance fixture timed out.'); }
async function main() {
  const profile = resolve('.tools-smoke-profile', `performance-${Date.now()}`); await mkdir(profile, { recursive: true });
  await build({ entryPoints: ['src/main/history.ts'], outfile: resolve('artifacts/performance-smoke-history.cjs'), platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
  const { HistoryStore } = require(resolve('artifacts/performance-smoke-history.cjs')), history = new HistoryStore(join(profile, 'library.sqlite')), db = history.db;
  const chats = [], messageIds = []; let workId;
  const chat = db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,mode,title_source) VALUES(?,?,?,?,?,?)'), message = db.prepare('INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route,parent_id,work_activity) VALUES(?,?,?,?,?,?,?,?,?,?)'), tool = db.prepare('INSERT INTO tool_calls(id,conversation_id,run_id,name,summary,status,result,created_at) VALUES(?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let index = 0; index < 500; index++) {
    const id = randomUUID(); chats.push(id); const work = index === 8; if (work) workId = id;
    chat.run(id, index === 0 ? 'Long history fixture' : work ? 'Collapsed Work fixture' : `Performance chat ${index}`, index, 1000 - index, work ? 'code' : 'chat', 'manual'); let parent = null;
    for (let turn = 0; turn < (index === 0 ? 100 : work ? 20 : 1); turn++) {
      const user = randomUUID(), assistant = randomUUID(), run = randomUUID();
      message.run(user, id, 'user', `Historical user ${index}:${turn}`, 'complete', turn * 2, null, 'local', parent, '[]');
      const tools = []; for (let step = 0; step < (work ? 20 : 5); step++) { const toolId = randomUUID(); tool.run(toolId, id, run, 'read_project_file', 'Read fixture evidence', 'success', JSON.stringify({ text: 'Recorded tool evidence. '.repeat(30) }), turn); tools.push({ id: run + ':' + step, runId: run, kind: 'tool', toolId, text: '', startedAt: turn }); }
      message.run(assistant, id, 'assistant', `Historical answer ${index}:${turn}. Complete fixture evidence.`, 'complete', turn * 2 + 1, run, 'local', user, work ? JSON.stringify([{ id: run + '-prose', runId: run, kind: 'prose', text: 'Verified the fixture.', startedAt: turn }, ...tools]) : '[]');
      parent = assistant; if (index === 0) messageIds.push(user, assistant);
    } db.prepare('UPDATE conversations SET active_leaf=? WHERE id=?').run(parent, id);
  } db.exec('COMMIT'); history.selectConversation(chats[0]); history.close();
  const replies = new Set(); let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'perf-fixture' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', created: 1, model: 'perf-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (JSON.stringify(input.messages).includes('Describe a saved conversation')) { response.end(frame({ role: 'assistant', content: JSON.stringify({ title: 'Fixture', summary: 'Performance fixture completed.', topicChanged: false }) }) + frame({}, 'stop') + 'data: [DONE]\n\n'); return; }
    requests++; replies.add(response); response.write(frame({ role: 'assistant', content: 'Completed local fixture ' }));
    let count = 0; const timer = setInterval(() => { if (++count > 80) { clearInterval(timer); response.end(frame({ content: ' finished.' }) + frame({}, 'stop') + 'data: [DONE]\n\n'); } else response.write(frame({ content: 'smooth ' })); }, 40);
    response.on('close', () => { clearInterval(timer); replies.delete(response); });
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  let app, page; const errors = [], checks = [];
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/bot-conversation-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => { const settings = (await window.tinygpt.snapshot()).value.settings; const result = await window.tinygpt.saveSettings({ ...settings, mode: 'chat', route: 'local', local: { ...settings.local, endpoint, model: 'perf-fixture', tools: false, contextWindowTokens: 128000 }, toolPermissions: { ...settings.toolPermissions, read: 'deny' } }); if (!result.ok) throw Error(result.error); }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.locator('[data-slot="windowed-messages"]').waitFor(); await delay(800);
    const mounted = await page.locator('[data-message-id]').count(); assert.ok(mounted < 60, `Too many mounted messages: ${mounted}`); checks.push({ name: '200-message history mounts a bounded viewport', mounted });
    await page.keyboard.press('Control+f'); await page.getByRole('textbox', { name: 'Search conversation', exact: true }).fill('Historical answer 0:1.'); await page.locator(`[data-message-id="${messageIds[3]}"]`).waitFor();
    assert.ok(await page.locator('[data-message-id]').count() < 60); checks.push({ name: 'search mounts offscreen history without mounting the whole chat' }); await page.getByRole('button', { name: 'Close conversation search', exact: true }).click();
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('tinygpt-message-jump', { detail: id })), messageIds.at(-1)); await delay(300);
    await page.evaluate(() => { window.perfSample = { gaps: [], tasks: [], packets: 0, biggestIncrement: 0 }; let previous = performance.now(); const tick = now => { window.perfSample.gaps.push(now - previous); previous = now; window.perfFrame = requestAnimationFrame(tick); }; window.perfFrame = requestAnimationFrame(tick); window.perfObserver = new PerformanceObserver(list => window.perfSample.tasks.push(...list.getEntries().map(entry => entry.duration))); window.perfObserver.observe({ type: 'longtask' }); window.perfUnsubscribe = window.tinygpt.onChatPackets(packets => { for (const packet of packets) { window.perfSample.packets++; if (packet.patch) window.perfSample.biggestIncrement = Math.max(window.perfSample.biggestIncrement, JSON.stringify(packet).length); } }); });
    const start = async group => page.evaluate(async ({ ids, group }) => { for (const id of ids) { const result = await window.tinygpt.sendMessage(id, 'PERF_RUN_' + group, []); if (!result.ok) throw Error(result.error); } }, { ids: chats.slice(0, 8), group });
    await start('VISIBLE'); await poll(() => requests >= 8); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('The composer remains responsive during eight replies.');
    await poll(() => page.evaluate(async () => !(await window.tinygpt.library()).value.activeRuns.length)); await delay(200);
    const visible = await page.evaluate(() => { cancelAnimationFrame(window.perfFrame); window.perfObserver.disconnect(); window.perfUnsubscribe(); const value = window.perfSample; value.gaps.sort((a, b) => a - b); return { packets: value.packets, biggestIncrement: value.biggestIncrement, p95FrameGapMs: value.gaps[Math.floor(value.gaps.length * .95)], maxFrameGapMs: Math.max(...value.gaps), longTaskCount: value.tasks.length, maxLongTaskMs: Math.max(0, ...value.tasks), mountedMessages: document.querySelectorAll('[data-message-id]').length }; });
    assert.ok(visible.biggestIncrement < 20000, JSON.stringify(visible)); assert.ok(visible.p95FrameGapMs < 50, JSON.stringify(visible)); assert.ok(visible.mountedMessages < 60); checks.push({ name: 'eight simultaneous real Chat replies with compact packets and bounded rendering', ...visible });
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'The composer remains responsive during eight replies.');
    // Count output fetches only in this isolated fixture, keeping production handlers unchanged.
    await app.evaluate(({ ipcMain }) => { globalThis.perfOutputsReads = 0; ipcMain.removeHandler('tinygpt:outputs'); ipcMain.handle('tinygpt:outputs', () => { globalThis.perfOutputsReads++; return { ok: true, value: [] }; }); });
    await page.getByRole('button', { name: 'Library', exact: true }).click(); await delay(200); const before = await app.evaluate(() => globalThis.perfOutputsReads);
    const currentRequests = requests; await start('OUTPUTS'); await poll(() => requests >= currentRequests + 8); await delay(1000); assert.equal(await app.evaluate(() => globalThis.perfOutputsReads), before); checks.push({ name: 'Outputs Library does not refetch during unrelated concurrent streaming', reads: before });
    await poll(() => page.evaluate(async () => !(await window.tinygpt.library()).value.activeRuns.length));
    await page.evaluate(async id => { const snapshot = (await window.tinygpt.snapshot()).value; await window.tinygpt.saveSettings({ ...snapshot.settings, mode: 'code' }); await window.tinygpt.conversation(id); }, workId); await page.reload(); await page.locator('[data-slot="work-response"]').first().waitFor();
    assert.equal(await page.locator('[data-tool-name]').count(), 0); const collapsedNodes = await page.locator('*').count(); const response = page.locator('[data-slot="work-response"]').last(); await response.locator('.work-response-heading').click();
    const chain = response.locator('.work-tool-chain').first(); await chain.locator('summary').click(); await chain.locator('[data-tool-name]').first().waitFor(); assert.equal(await chain.locator('[data-tool-name]').count(), 20); await chain.locator('summary').click(); await poll(async () => !await chain.locator('[data-tool-name]').count());
    checks.push({ name: 'collapsed Work history mounts no tool rows; expansion and re-collapse work', collapsedNodes });
    assert.deepEqual(errors, []); await writeFile(resolve('artifacts/performance-smoke-results.json'), JSON.stringify({ checks, errors }, null, 2)); console.log(JSON.stringify({ checks, errors }));
  } catch (error) { if (page) { await page.screenshot({ path: resolve('artifacts/performance-smoke-failure.png') }).catch(() => {}); console.log(await page.evaluate(async () => ({ library: (await window.tinygpt.library()).value.activeRuns, alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent), mounted: document.querySelectorAll('[data-message-id]').length })).catch(() => ({}))); } throw error; }
  finally { for (const response of replies) response.destroy(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
