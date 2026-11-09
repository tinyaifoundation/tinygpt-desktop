// Isolated desktop profile and loopback inference; no Project is selected.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, readFile } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const profile = resolve('.tools-smoke-profile', `generated-chat-files-${Date.now()}`); let folder; await mkdir(profile, { recursive: true });
  let release; const prepared = new Promise(done => { release = done; }); let calls = 0; let app; let page; const errors = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'fixture', name: 'Fixture', context_length: 1048576, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'] }] })); return; }
    const payload = JSON.parse(body); const agent = payload.tools?.some(tool => tool.function?.name === 'write_project_file');
    console.log(JSON.stringify({ request: request.url, agent, calls, toolCount: payload.tools?.length ?? 0 }));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: 'created-file-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (agent && ++calls === 1) {
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
      result = await window.tinygpt.createConversation(null); if (!result.ok) throw new Error(result.error);
    }, `http://127.0.0.1:${server.address().port}/v1`); await page.reload();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create a report.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(async () => (await window.tinygpt.library()).value.activeRuns.some(run => run.phase === 'tool-input')); 
    await page.getByText('Preparing the local report.', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-tool-name="write_project_file"]').count(), 0); assert.equal(await page.locator('[data-slot="created-files"]').count(), 0);
    release(); const card = page.getByRole('button', { name: 'Open TOOL_IDEAS.md in workspace', exact: true }); await card.waitFor(); await page.getByText('Saved your report.', { exact: true }).waitFor();
    const outputs = await page.evaluate(() => window.tinygpt.outputs()); assert.equal(outputs.ok, true); const output = outputs.value.find(file => file.name === 'TOOL_IDEAS.md'); assert.equal(output.generated, true); assert.equal(output.projectId, undefined); folder = join(profile, 'generated-files', output.conversationId); assert.match(await readFile(join(folder, 'TOOL_IDEAS.md'), 'utf8'), /Verified artifact/);
    await card.waitFor(); await page.screenshot({ path: resolve('artifacts/generated-chat-file-card-light.png') });
    await card.click(); const workspace = page.getByRole('complementary', { name: 'Workspace', exact: true }); await workspace.getByRole('heading', { name: 'Verified artifact', exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/generated-chat-file-workspace.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await card.waitFor(); await page.screenshot({ path: resolve('artifacts/generated-chat-file-card-dark.png') });
    await page.reload(); await card.waitFor(); await card.click(); await workspace.getByRole('heading', { name: 'Verified artifact', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('button', { name: /TOOL_IDEAS.md/ }).first().click(); await workspace.getByRole('heading', { name: 'Verified artifact', exact: true }).waitFor();
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['thinking shown', 'tool input streams before execution', 'no premature execution or file card', 'managed file created without a Project', 'Library opens managed output', 'confirmed generated file card', 'opens actual Markdown in workspace', 'light/dark', 'survives reload'], errors }));
  } catch (error) { if (page) { console.log('Fixture state', await page.evaluate(async () => { const library = (await window.tinygpt.library()).value; const chat = (await window.tinygpt.conversation(library.lastConversationId)).value; return { active: library.activeRuns[0], status: chat.messages.at(-1)?.status, tools: chat.tools.length, reasoningChars: chat.messages.at(-1)?.reasoning?.length, rendered: document.querySelector('[data-slot="answer-text"]')?.parentElement?.textContent }; }).catch(() => ({}))); await page.screenshot({ path: resolve('artifacts/generated-chat-file-failure.png') }).catch(() => {}); } throw error; }
  finally { release(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
