const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  let app; let requests = 0; const errors = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) {}
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    requests++;
    const event = (delta, finish = null, usage) => JSON.stringify({ id: 'toggle-fixture', object: 'chat.completion.chunk', created: 1, model: 'toggle-fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${event({ role: 'assistant', content: 'The shared composer works.' })}\n\ndata: ${event({}, 'stop', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `chat-code-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs'), '--disable-features=CalculateNativeWinOcclusion'], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const project = await page.evaluate(async endpoint => { const snapshot = await window.tinygpt.snapshot(); await window.tinygpt.saveSettings({ ...snapshot.value.settings, mode: 'chat', route: 'local', local: { ...snapshot.value.settings.local, endpoint, model: 'toggle-fixture' } }); return window.tinygpt.createProject('Hover project', '', false); }, `http://127.0.0.1:${server.address().port}/v1`); assert.equal(project.ok, true);
    await page.reload(); const composer = page.getByRole('textbox', { name: 'Message', exact: true }); await composer.waitFor();
    assert.equal(await page.locator('.tiny-sidebar').getByRole('button', { name: 'Code', exact: true }).count(), 0);
    await composer.fill('A draft across both modes');
    const input = await composer.elementHandle();
    await page.getByRole('tab', { name: 'Code', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="tab"][data-mode="code"]').getAttribute('aria-selected') === 'true');
    assert.equal(await composer.inputValue(), 'A draft across both modes'); assert.equal(await input.evaluate(element => element.isConnected), true);
    assert.equal(await page.locator('.work-composer').count(), 1); assert.equal(await page.locator('[data-slot="composer-extras"]').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
    await composer.press('Enter'); assert.equal(requests, 0);
    await page.getByRole('tab', { name: 'Code', exact: true }).focus(); await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('[role="tab"][data-mode="chat"]').getAttribute('aria-selected') === 'true');
    assert.equal(await composer.inputValue(), 'A draft across both modes');
    await page.getByRole('button', { name: 'Project: Choose project', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Hover project', exact: true }).click();
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await page.getByText('The shared composer works.', { exact: true }).waitFor({ timeout: 60000 });
    await page.waitForFunction(async () => !(await window.tinygpt.library()).value.activeRuns[0]);
    assert.equal(await page.getByRole('tablist', { name: 'Conversation mode', exact: true }).count(), 0); assert.equal(await page.locator('[data-slot="composer-extras"]').count(), 0);
    const chat = page.locator('.sidebar-chat-row').filter({ hasText: 'A draft across both modes' }); await chat.hover();
    const card = page.locator('.conversation-preview'); await card.waitFor(); await card.getByText('Hover project', { exact: true }).waitFor(); await card.getByText('2 messages · 1 response · 0 tools', { exact: true }).waitFor();
    const usage = await page.evaluate(async () => { const saved = await window.tinygpt.library(); return window.tinygpt.conversationUsage(saved.value.lastConversationId); }); assert.equal(usage.ok, true); assert.equal(usage.value.messages, 2);
    await mkdir(resolve('artifacts'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/conversation-hover-light.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    const row = page.locator('.sidebar-project-row'); await row.hover();
    const colors = await row.evaluate(element => ({ row: getComputedStyle(element).backgroundColor, child: getComputedStyle(element.querySelector('.sidebar-project-toggle')).backgroundColor }));
    assert.equal(colors.child, 'rgba(0, 0, 0, 0)'); assert.notEqual(colors.row, 'rgb(232, 234, 235)');
    await page.getByRole('button', { name: 'New chat in Hover project', exact: true }).hover();
    const control = await page.getByRole('button', { name: 'New chat in Hover project', exact: true }).evaluate(element => getComputedStyle(element).backgroundColor); assert.notEqual(control, 'rgb(255, 255, 255)');
    await chat.hover(); await card.waitFor(); await card.getByText('2 messages · 1 response · 0 tools', { exact: true }).waitFor(); await page.screenshot({ path: resolve('artifacts/conversation-hover-dark.png') });
    await page.getByRole('button', { name: 'New chat', exact: true }).click(); await page.getByRole('tab', { name: 'Code', exact: true }).click(); await page.screenshot({ path: resolve('artifacts/chat-code-toggle-dark.png') });
    await page.waitForFunction(() => document.querySelector('[role="tab"][data-mode="code"]').getAttribute('aria-selected') === 'true');
    await page.reload(); await page.getByRole('tab', { name: 'Code', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Code', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.thread-message').count(), 0);
    assert.deepEqual(errors, []); console.log('Chat/Code sidebar passed: identical composer, preserved draft and Project, keyboard toggle, disabled pending Code runtime, working Chat send, new-chat-only controls, scoped hover stats, and dark Project/button hover styling.');
  } catch (error) {
    console.error(error);
    if (app) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/chat-code-failure.png'), timeout: 3000 }).catch(() => {}); console.error(await page.evaluate(async () => { const library = (await window.tinygpt.library()).value; return { mode: (await window.tinygpt.snapshot()).value.settings.mode, active: library.activeRuns[0], conversation: library.lastConversationId ? (await window.tinygpt.conversation(library.lastConversationId)).value.messages : null }; })); }
    console.error({ requests, errors }); throw error;
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
