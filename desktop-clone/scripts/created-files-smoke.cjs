// Isolated desktop profile, loopback inference, and a disposable Project folder.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, readFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', `created-files-${Date.now()}`); const folder = join(profile, 'files'); await mkdir(folder, { recursive: true });
  let release; const prepared = new Promise(done => { release = done; }); let calls = 0; let app; let page; const errors = [];
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* consume */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: 'created-file-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (++calls === 1) {
      response.write(frame({ role: 'assistant', reasoning: 'Preparing the local report.' }));
      response.write(frame({ tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: { name: 'write_project_file', arguments: '{"path":"TOOL_IDEAS.md","content":"' } }] }));
      await prepared; response.end(frame({ tool_calls: [{ index: 0, function: { arguments: '# Verified artifact\\n\\nCreated through the approved file tool.","status":"Writing the report"}' } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
    } else response.end(frame({ role: 'assistant', content: 'Saved your report.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow, dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } }, folder);
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      let result = await window.tinygpt.saveSettings({ ...settings, mode: 'chat', route: 'byok', byok: { ...settings.byok, provider: 'openrouter', protocol: 'openai-compatible', endpoint, model: 'fixture', tools: true, contextWindowTokens: 1048576 }, toolPermissions: { ...settings.toolPermissions, write: 'allow', read: 'allow' } }); if (!result.ok) throw new Error(result.error);
      result = await window.tinygpt.saveSecret('byok', 'local-fixture-only'); if (!result.ok) throw new Error(result.error);
      const chosen = await window.tinygpt.chooseNewProjectFolder(); const project = await window.tinygpt.createProject('File cards fixture', '', false, chosen.value.id); if (!project.ok) throw new Error(project.error);
      result = await window.tinygpt.createConversation(project.value.id); if (!result.ok) throw new Error(result.error);
    }, `http://127.0.0.1:${server.address().port}/v1`); await page.reload();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create a report.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Preparing an action…', { exact: true }).waitFor();
    await page.getByText('Preparing the local report.', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-tool-name="write_project_file"]').count(), 0); assert.equal(await page.locator('[data-slot="created-files"]').count(), 0);
    release(); await page.waitForFunction(async () => !(await window.tinygpt.library()).value.activeRuns[0]);
    assert.match(await readFile(join(folder, 'TOOL_IDEAS.md'), 'utf8'), /Verified artifact/);
    const card = page.getByRole('button', { name: 'Open TOOL_IDEAS.md in workspace', exact: true }); await card.waitFor(); await page.screenshot({ path: resolve('artifacts/created-file-card-light.png') });
    await card.click(); const workspace = page.getByRole('complementary', { name: 'Workspace', exact: true }); await workspace.getByRole('heading', { name: 'Verified artifact', exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/created-file-workspace.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await card.waitFor(); await page.screenshot({ path: resolve('artifacts/created-file-card-dark.png') });
    await page.reload(); await card.waitFor(); await card.click(); await workspace.getByRole('heading', { name: 'Verified artifact', exact: true }).waitFor();
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['thinking shown', 'preparing action before complete arguments', 'no premature execution or file card', 'confirmed generated file card', 'opens actual Markdown in workspace', 'light/dark', 'survives reload'], errors }));
  } catch (error) { if (page) { console.log('Fixture state', await page.evaluate(async () => { const library = (await window.tinygpt.library()).value; const chat = (await window.tinygpt.conversation(library.lastConversationId)).value; return { active: library.activeRuns[0], status: chat.messages.at(-1)?.status, tools: chat.tools.length, reasoningChars: chat.messages.at(-1)?.reasoning?.length, rendered: document.querySelector('[data-slot="answer-text"]')?.parentElement?.textContent }; }).catch(() => ({}))); await page.screenshot({ path: resolve('artifacts/created-file-failure.png') }).catch(() => {}); } throw error; }
  finally { release(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
