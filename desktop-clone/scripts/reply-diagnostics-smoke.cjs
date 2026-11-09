// Isolated desktop profile, loopback inference, and a disposable Project folder.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, readFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', `reply-diagnostics-${Date.now()}`); const folder = join(profile, 'files'); await mkdir(folder, { recursive: true });
  let release; const prepared = new Promise(done => { release = done; }); let releaseFinal; const finalReady = new Promise(done => { releaseFinal = done; }); let calls = 0; let app; let page; const errors = [];
  const waitFor = async predicate => { const deadline = Date.now() + 30000; while (Date.now() < deadline) { if (await page.evaluate(predicate)) return; await new Promise(done => setTimeout(done, 50)); } throw new Error('Fixture condition timed out.'); };
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* consume */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: 'created-file-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...(finish ? { usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } } : {}), choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (++calls === 1) {
      response.write(frame({ role: 'assistant', reasoning: 'Preparing the local report.' }));
      response.write(frame({ tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: { name: 'write_project_file', arguments: '{"path":"TOOL_IDEAS.md","content":"' } }] }));
      await prepared; response.end(frame({ tool_calls: [{ index: 0, function: { arguments: '# Verified artifact\\n\\nCreated through the approved file tool.","status":"Writing the report"}' } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
    } else { response.write(frame({ role: 'assistant', content: 'Saved your report.' })); await finalReady; response.end(frame({}, 'stop') + 'data: [DONE]\n\n'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } }, folder);
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      let result = await window.tinygpt.saveSettings({ ...settings, mode: 'chat', route: 'byok', byok: { ...settings.byok, provider: 'openrouter', protocol: 'openai-compatible', endpoint, model: 'fixture', tools: true, contextWindowTokens: 1048576 }, toolPermissions: { ...settings.toolPermissions, write: 'ask', read: 'allow' } }); if (!result.ok) throw new Error(result.error);
      result = await window.tinygpt.saveSecret('byok', 'local-fixture-only'); if (!result.ok) throw new Error(result.error);
      const chosen = await window.tinygpt.chooseNewProjectFolder(); const project = await window.tinygpt.createProject('File cards fixture', '', false, chosen.value.id); if (!project.ok) throw new Error(project.error);
      result = await window.tinygpt.createConversation(project.value.id); if (!result.ok) throw new Error(result.error);
    }, `http://127.0.0.1:${server.address().port}/v1`); await page.reload();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create a report.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Preparing an action…', { exact: true }).waitFor();
    await page.getByText('Preparing the local report.', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-tool-name="write_project_file"]').count(), 0); assert.equal(await page.locator('[data-slot="created-files"]').count(), 0);
    release();
    await page.getByRole('region', { name: 'Tool approval', exact: true }).waitFor();
    await new Promise(done => setTimeout(done, 250));
    await page.getByRole('button', { name: 'Allow once', exact: false }).click();
    await waitFor(async () => { const snapshot = (await window.tinygpt.diagnostics()).value; const report = (await window.tinygpt.diagnosticTrace(snapshot.runs[0].runId)).value; return report.events.some(event => event.event === 'ui-frame' && event.textHeld); });
    releaseFinal(); await waitFor(async () => !(await window.tinygpt.library()).value.activeRuns[0]);
    await waitFor(async () => { const snapshot = (await window.tinygpt.diagnostics()).value; const report = (await window.tinygpt.diagnosticTrace(snapshot.runs[0].runId)).value; return report.events.some(event => event.event === 'ui-frame' && event.answerVisible); });
    const report = await page.evaluate(async () => { const snapshot = (await window.tinygpt.diagnostics()).value; return (await window.tinygpt.diagnosticTrace(snapshot.runs[0].runId)).value; });
    for (const name of ['run-start','execution-start','worker-ready','runtime-ready','tokenizer-ready','context-budget','request-start','request-headers','request-first-data','first-thinking','preparing-tool','tool-queued','approval-start','approval-end','tool-start','tool-end','first-text','text-lane','usage','run-complete','ui-frame']) assert.ok(report.events.some(event => event.event === name), name);
    assert.equal(report.status, 'complete'); assert.equal(report.metrics.requestCount, 2); assert.ok(report.metrics.approvalMs >= 200); assert.ok(report.metrics.heldTextMs > 0); assert.ok(report.metrics.firstAnswerMs > report.metrics.firstModelMs); assert.ok(report.events.some(event => event.event === 'ui-frame' && event.approvalVisible));
    for (const secret of ['local-fixture-only','Create a report.','Saved your report.','Preparing the local report.','TOOL_IDEAS.md',folder]) assert.ok(!JSON.stringify(report).includes(secret), 'Content excluded: ' + secret);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.locator('.diagnostics-run').click(); await page.getByText('First model output', { exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/reply-diagnostics-timeline.png') });
    const exportPath = resolve('artifacts/reply-diagnostics-fixture.json');
    await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: path }); }, exportPath);
    await page.getByRole('button', { name: 'Export', exact: true }).click(); await page.getByText('Diagnostics exported.', { exact: true }).waitFor();
    const exported = JSON.parse(await readFile(exportPath, 'utf8')); assert.equal(exported.schemaVersion, 1); assert.equal(exported.runs[0].runId, report.runId);
    await page.getByRole('switch', { name: 'Record reply diagnostics', exact: true }).click(); await waitFor(async () => !(await window.tinygpt.diagnostics()).value.enabled);
    await page.getByRole('switch', { name: 'Record reply diagnostics', exact: true }).click();
    await page.getByRole('button', { name: 'Clear records', exact: true }).click(); await page.getByText('Local diagnostics cleared.', { exact: true }).waitFor(); assert.equal((await page.evaluate(async () => (await window.tinygpt.diagnostics()).value)).runs.length, 0);
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();

    assert.match(await readFile(join(folder, 'TOOL_IDEAS.md'), 'utf8'), /Verified artifact/);
    const card = page.getByRole('button', { name: 'Open TOOL_IDEAS.md in workspace', exact: true }); await card.waitFor(); await page.screenshot({ path: resolve('artifacts/created-file-card-light.png') });
    await card.click(); const workspace = page.getByRole('complementary', { name: 'Workspace', exact: true }); await workspace.getByRole('heading', { name: 'Verified artifact', exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/created-file-workspace.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await card.waitFor(); await page.screenshot({ path: resolve('artifacts/created-file-card-dark.png') });
    await page.reload(); await card.waitFor(); await card.click(); await workspace.getByRole('heading', { name: 'Verified artifact', exact: true }).waitFor();
    assert.deepEqual(errors, []); console.log(JSON.stringify({ profile, diagnostics: { events: report.events.length, metrics: report.metrics }, checks: ['thinking shown', 'preparing action before complete arguments', 'no premature execution or file card', 'confirmed generated file card', 'opens actual Markdown in workspace', 'light/dark', 'survives reload'], errors }));
  } catch (error) { if (page) { console.log('Fixture state', await page.evaluate(async () => { const library = (await window.tinygpt.library()).value; const chat = (await window.tinygpt.conversation(library.lastConversationId)).value; return { active: library.activeRuns[0], status: chat.messages.at(-1)?.status, tools: chat.tools.length, reasoningChars: chat.messages.at(-1)?.reasoning?.length, rendered: document.querySelector('[data-slot="answer-text"]')?.parentElement?.textContent }; }).catch(() => ({}))); await page.screenshot({ path: resolve('artifacts/created-file-failure.png') }).catch(() => {}); } throw error; }
  finally { release(); releaseFinal(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
