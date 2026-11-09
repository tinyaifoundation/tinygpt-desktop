const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdir, readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');

(async () => {
  const profile = join(tmpdir(), `tinygpt-chat-window-${Date.now()}`), folder = join(profile, 'project');
  await mkdir(folder, { recursive: true }); await mkdir(resolve('artifacts'), { recursive: true });
  const requests = [], held = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'window-fixture' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'window-fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}) })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const content = body.messages?.filter(message => message.role === 'user').at(-1)?.content;
    if (typeof content === 'string' && content.includes('BOT_TYPING_PROOF')) {
      held.add(response); response.on('close', () => held.delete(response));
      response.write(': waiting\n\n');
      const timer = setInterval(() => response.write(': waiting\n\n'), 1000); response.on('close', () => clearInterval(timer));
      return;
    }
    response.write(frame({ role: 'assistant', content: 'A live reply in the pop-out.' }));
    const timer = setTimeout(() => response.end(frame({ content: ' The same conversation is saved.' }) + frame({}, 'stop') + 'data: [DONE]\n\n'), 2200);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let desktop, floating, page, stderr = ''; const errors = [];
  const watch = target => { target.setDefaultTimeout(30000); target.on('pageerror', error => errors.push(error.message)); return target; };
  try {
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/chat-window-smoke-main.cjs')], env });
    desktop.process().stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    page = watch(await desktop.firstWindow()); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const snapshot = (await window.tinygpt.snapshot()).value;
      const result = await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, model: 'window-fixture', tools: true, contextWindowTokens: 64000, endpoint } }); if (!result.ok) throw Error(result.error);
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent draft goes with the chat');
    let opened = desktop.waitForEvent('window'); await page.getByRole('button', { name: 'Pop out chat', exact: true }).click(); floating = watch(await opened);
    await floating.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.equal(await floating.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Unsent draft goes with the chat');
    await page.getByText('This chat is in its own window.', { exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/return-chat-pill.png') });
    const id = await floating.evaluate(async () => (await window.tinygpt.chatWindow()).value.conversationId);
    assert.deepEqual(await desktop.evaluate(({ BrowserWindow }, url) => { const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url); return { top: window.isAlwaysOnTop(), min: window.getMinimumSize(), max: window.isMaximizable(), fullscreen: window.isFullScreenable() }; }, floating.url()), { top: true, min: [320, 420], max: false, fullscreen: false });
    assert.equal(await floating.locator('.floating-chat-header').evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'drag');
    // A matching local URL and preload are insufficient: IPC requires window ownership.
    const extraWindow = desktop.waitForEvent('window');
    await desktop.evaluate(({ BrowserWindow }, input) => { const extra = new BrowserWindow({ show: false, webPreferences: { preload: input.preload, contextIsolation: true, sandbox: true, nodeIntegration: false } }); void extra.loadURL(input.url); }, { url: floating.url(), preload: resolve('out/preload/index.js') });
    const untrusted = await extraWindow; await untrusted.waitForFunction(() => !!window.tinygpt);
    assert.deepEqual(await untrusted.evaluate(async () => window.tinygpt.snapshot()), { ok: false, error: 'This request is not allowed.' });
    assert.equal((await untrusted.evaluate(async id => window.tinygpt.popOutChat(id), id)).ok, false);
    await desktop.evaluate(({ BrowserWindow }) => { const extra = BrowserWindow.getAllWindows().find(window => !window.isAlwaysOnTop() && window.webContents.getURL().endsWith('#popout')); extra.close(); });
    // Changing main-window mode must not change this empty, pinned Chat's harness.
    await page.evaluate(async () => { const snapshot = (await window.tinygpt.snapshot()).value; await window.tinygpt.saveSettings({ ...snapshot.settings, mode: 'code' }); });
    await floating.getByRole('textbox', { name: 'Message', exact: true }).fill('CHAT_WINDOW_PROOF');
    await floating.screenshot({ path: resolve('artifacts/chat-popout-before-send.png') });
    await floating.getByRole('button', { name: 'Send message', exact: true }).click();
    await floating.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
    assert.equal((await floating.evaluate(async id => (await window.tinygpt.conversation(id)).value, id)).mode, 'chat');
    await floating.getByRole('button', { name: 'Return chat to TinyGPT', exact: true }).click();
    await page.getByText('A live reply in the pop-out. The same conversation is saved.', { exact: true }).waitFor();
    assert.equal(requests.filter(body => body.messages?.some(message => message.content === 'CHAT_WINDOW_PROOF')).length, 1, 'A pop-out must not start duplicate inference');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft before another handoff');
    opened = desktop.waitForEvent('window'); await page.getByRole('button', { name: 'Pop out chat', exact: true }).click(); floating = watch(await opened);
    await floating.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await floating.getByRole('textbox', { name: 'Message', exact: true }).fill('Draft edited in the floating chat');
    await floating.screenshot({ path: resolve('artifacts/chat-popout-light.png') });
    await page.evaluate(() => { const preferences = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); preferences.theme = 'dark'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(preferences)); window.dispatchEvent(new StorageEvent('storage', { key: 'tinygpt-appearance-v4', newValue: JSON.stringify(preferences) })); });
    await floating.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await floating.screenshot({ path: resolve('artifacts/chat-popout-dark.png') });
    await desktop.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url).setSize(320, 440), floating.url());
    await floating.waitForFunction(() => innerWidth === 320);
    assert.equal(await floating.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.conversation-pane, .thread-viewport, .composer')].some(element => element.scrollWidth > element.clientWidth)), false, 'Compact chat must fit without horizontal overflow');
    // Resized hidden frameless windows can stall screenshot capture on Windows.
    // Verify their dimensions and overflow directly, then continue the handoff checks.
    await floating.getByRole('button', { name: 'Close pop-out', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Draft edited in the floating chat');
    opened = desktop.waitForEvent('window'); await page.getByRole('button', { name: 'Pop out chat', exact: true }).click(); floating = watch(await opened);
    await floating.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await desktop.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url).close(), page.url());
    assert.equal(await floating.evaluate(async () => (await window.tinygpt.snapshot()).ok), true, 'Closing main must keep the floating chat and services alive');
    await floating.getByRole('textbox', { name: 'Message', exact: true }).fill('MAIN_CLOSED_PROOF'); await floating.getByRole('button', { name: 'Send message', exact: true }).click();
    await floating.getByText('A live reply in the pop-out. The same conversation is saved.', { exact: true }).last().waitFor();
    await floating.waitForFunction(async id => !(await window.tinygpt.library()).value.activeRuns.some(run => run.conversationId === id), id);
    opened = desktop.waitForEvent('window'); await floating.getByRole('button', { name: 'Return chat to TinyGPT', exact: true }).click(); page = watch(await opened);
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await window.tinygpt.library()).value.lastConversationId), id);
    const radii = await page.evaluate(() => ({ outer: parseFloat(getComputedStyle(document.querySelector('.desktop-shell')).borderRadius), inner: parseFloat(getComputedStyle(document.querySelector('.conversation-pane')).borderRadius) }));
    assert.deepEqual(radii, { outer: 14, inner: 14 });
    // Work uses the same compact window while keeping its own project/harness.
    await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
    const workId = await page.evaluate(async () => { const snapshot = (await window.tinygpt.snapshot()).value; await window.tinygpt.saveSettings({ ...snapshot.settings, mode: 'code' }); const project = (await window.tinygpt.createProject('Work fixture', '')).value; await window.tinygpt.chooseProjectFolder(project.id); return (await window.tinygpt.createConversation(project.id)).value.id; });
    opened = desktop.waitForEvent('window'); await page.evaluate(async id => { const result = await window.tinygpt.popOutChat(id); if (!result.ok) throw Error(result.error); }, workId); floating = watch(await opened);
    await floating.locator('.conversation-pane[data-mode="code"]').waitFor();
    assert.equal(await floating.getByRole('tablist', { name: 'Conversation mode' }).count(), 0);
    await floating.getByRole('button', { name: 'Close pop-out', exact: true }).click();
    // Real OpenClaw setup: Bot typing bubble, settings scroll areas, and pop-out.
    const botId = await page.evaluate(async () => { const snapshot = (await window.tinygpt.snapshot()).value; await window.tinygpt.saveSettings({ ...snapshot.settings, mode: 'bot' }); const result = await window.tinygpt.completeBot({ name: 'Milo', projectId: null }); if (!result.ok) throw Error(result.error); return result.value.id; });
    await page.reload(); await page.getByRole('button', { name: 'Your Bot', exact: true }).click(); await page.locator('.bot-conversation-header').waitFor();
    await page.waitForFunction(async () => (await window.tinygpt.botSnapshot()).value.phase === 'ready', null, { timeout: 180000 });
    opened = desktop.waitForEvent('window'); await page.getByRole('button', { name: 'Pop out chat', exact: true }).click(); floating = watch(await opened);
    await floating.locator('.bot-conversation-header [data-robot-avatar]').waitFor();
    assert.equal(await floating.locator('.floating-chat-header .bot-conversation-header [data-robot-avatar]').count(), 1);
    assert.equal(await floating.locator('.conversation-pane .bot-conversation-header').count(), 0);
    const surfaces = await floating.evaluate(() => ({ header: getComputedStyle(document.querySelector('.floating-chat')).backgroundColor, pane: getComputedStyle(document.querySelector('.conversation-pane')).backgroundColor }));
    assert.equal(surfaces.header, surfaces.pane, 'The pop-out header and chat must share one background');
    await floating.getByRole('textbox', { name: 'Message', exact: true }).fill('BOT_TYPING_PROOF'); await floating.getByRole('button', { name: 'Send message', exact: true }).click();
    await floating.locator('[data-slot="bot-typing-bubble"]').waitFor();
    assert.equal(await floating.locator('[data-slot="work-status"], [data-slot="scroll-anchor"]').count(), 0);
    await floating.screenshot({ path: resolve('artifacts/bot-popout-typing.png') });
    await floating.getByRole('button', { name: 'Return chat to TinyGPT', exact: true }).click();
    await page.locator('[data-slot="bot-typing-bubble"]').waitFor();
    await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Bot', exact: true }).click();
    await page.getByRole('switch', { name: 'Agent Browser', exact: true }).waitFor();
    assert.equal(await page.locator('.settings-content[data-slot="scroll-area"], .settings-nav-scroll[data-slot="scroll-area"]').count(), 2);
    const notes = Array.from({ length: 150 }, (_, index) => `Personalization line ${index}`).join('\n');
    await page.getByRole('textbox', { name: 'Bot personalization text', exact: true }).fill(notes);
    const metrics = await page.locator('.bot-note-scroll').evaluate(element => { const viewport = element.querySelector('[data-slot="scroll-area-viewport"]'), textarea = element.querySelector('textarea'); viewport.scrollTop = 500; return { viewportHeight: viewport.clientHeight, contentHeight: viewport.scrollHeight, scrolled: viewport.scrollTop > 0, nativeTextarea: textarea.scrollHeight > textarea.clientHeight, slots: element.querySelectorAll('[data-slot="scroll-area-scrollbar"]').length, overflowX: element.scrollWidth > element.clientWidth }; });
    assert.equal(metrics.scrolled, true); assert.equal(metrics.nativeTextarea, false); assert.equal(metrics.overflowX, false);
    await page.locator('.bot-note-scroll').hover(); await page.locator('.bot-note-scroll [data-slot="scroll-area-scrollbar"]').waitFor();
    await page.screenshot({ path: resolve('artifacts/bot-settings-scrollbars.png') });
    assert.deepEqual(errors, []);
    console.log('Pop-out proof passed: Chat/Work/Bot, pinned mode, no duplicate inference, both draft handoffs, stream handoff, always-on-top compact window, main-window close/reopen, light/dark/narrow layout, concentric corners, Bot typing bubble, and ShadCN settings/note scrollbars.');
  } catch (error) {
    if (floating && !floating.isClosed()) await floating.screenshot({ path: resolve('artifacts/chat-popout-failure.png') }).catch(() => {});
    if (page && !page.isClosed()) await page.screenshot({ path: resolve('artifacts/chat-popout-main-failure.png') }).catch(() => {});
    console.error('Renderer errors:', errors, stderr); throw error;
  } finally { if (desktop) await desktop.close(); for (const response of held) response.destroy(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
