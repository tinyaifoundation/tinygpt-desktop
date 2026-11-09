// Focused v2 design verification. Uses a disposable profile and local inference.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'design-fixture' }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    for await (const _ of request) { /* Drain the local fixture request. */ }
    const event = (delta, finish_reason = null) => JSON.stringify({ id: 'design-fixture', object: 'chat.completion.chunk', created: 1, model: 'design-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${event({ role: 'assistant', content: '## A thoughtful workspace\n\nConversation text now follows the compact v2 rhythm.\n\n- Clear typography\n- A composed desktop shell\n\n```js\nconst tiny = "hello";\n```' })}\n\ndata: ${event({}, 'stop')}\n\ndata: [DONE]\n\n`);
    setTimeout(() => response.end(), 200);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `design-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  let app; const errors = [];
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const settings = await page.evaluate(async endpoint => { const snapshot = await window.tinygpt.snapshot(); return window.tinygpt.saveSettings({ ...snapshot.value.settings, route: 'local', local: { ...snapshot.value.settings.local, endpoint, model: 'design-fixture' } }); }, `http://127.0.0.1:${server.address().port}/v1`); assert.equal(settings.ok, true);
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor(); await page.evaluate(() => document.fonts.ready);
    await mkdir(resolve('artifacts'), { recursive: true });
    assert.equal(await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('.tiny-sidebar').evaluate(element => getComputedStyle(element).borderRightWidth), '0px');
    assert.equal(await page.locator('.tiny-sidebar').evaluate(element => getComputedStyle(element).borderRadius), '0px');
    assert.equal(await page.locator('.conversation-pane').evaluate(element => getComputedStyle(element).borderRadius), '14px');
    assert.equal(await page.locator('.conversation-pane').evaluate(element => getComputedStyle(element).borderWidth), await page.locator('.desktop-shell').evaluate(element => getComputedStyle(element).borderWidth));
    assert.equal(await page.locator('.conversation-header').evaluate(element => getComputedStyle(element).backgroundColor), await page.locator('.tiny-sidebar').evaluate(element => getComputedStyle(element).backgroundColor));
    assert.equal(await page.locator('.work-composer').evaluate(element => getComputedStyle(element).borderRadius), '19px');
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate(element => getComputedStyle(element).fontSize), '14px');
    await page.screenshot({ path: resolve('artifacts/v2-desktop-welcome.png') });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Show the new conversation design'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('heading', { name: 'A thoughtful workspace', exact: true }).waitFor();
    await page.waitForFunction(async () => !(await window.tinygpt.library()).value.activeRuns[0]);
    assert.equal(await page.locator('.thread-message-column').evaluate(element => getComputedStyle(element).width), '740px');
    assert.equal(await page.locator('.thread-message').last().evaluate(element => getComputedStyle(element).fontSize), '14px');
    assert.equal(await page.locator('.thread-message').last().evaluate(element => getComputedStyle(element).lineHeight), '23.8px');
    await page.screenshot({ path: resolve('artifacts/v2-desktop-conversation.png') });
    await page.getByRole('button', { name: 'Your Bot', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.getByRole('heading', { name: 'A thoughtful workspace' }).waitFor();
    await page.getByRole('button', { name: 'Forward', exact: true }).click(); assert.equal(await page.getByRole('button', { name: 'Your Bot', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.getByRole('heading', { name: 'A thoughtful workspace' }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await nav.getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.screenshot({ path: resolve('artifacts/v2-desktop-appearance-light.png') });
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.getByRole('switch', { name: 'Use pointer cursors', exact: true }).click();
    await page.getByRole('switch', { name: 'Font smoothing', exact: true }).click();
    await page.getByRole('button', { name: 'On', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-motion'), 'reduce');
    await page.getByRole('button', { name: 'App icon clear-dark', exact: true }).click();
    await page.screenshot({ path: resolve('artifacts/v2-desktop-appearance-dark.png') });
    await nav.getByRole('button', { name: 'Profile', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('textbox', { name: 'Profile name', exact: true }).fill('Taylor'); await page.getByRole('textbox', { name: 'Profile username', exact: true }).fill('taylor'); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.screenshot({ path: resolve('artifacts/v2-desktop-profile.png') });
    await nav.getByRole('button', { name: 'Browser', exact: true }).click(); await page.getByLabel('Default search engine', { exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Bing', exact: true }).click(); await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await page.getByText('Settings saved.', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.tinygpt.snapshot())).value.settings.browser.engine, 'bing');
    await nav.getByRole('button', { name: 'Configuration', exact: true }).click(); await page.getByRole('button', { name: 'Save & check connection', exact: true }).click(); await page.getByText(/model.*listed/).waitFor();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.getByRole('heading', { name: 'A thoughtful workspace' }).waitFor();
    assert.equal(await page.locator('.sidebar-profile-name').innerText(), 'Taylor');
    await page.reload(); await page.getByRole('button', { name: 'Open profile menu', exact: true }).waitFor();
    assert.equal(await page.locator('.sidebar-profile-name').innerText(), 'Taylor'); assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark'); assert.equal(await page.locator('html').getAttribute('data-pointer'), 'true'); assert.equal(await page.locator('html').getAttribute('data-motion'), 'reduce');
    await page.screenshot({ path: resolve('artifacts/v2-desktop-conversation-dark.png') });
    await page.getByRole('button', { name: 'Maximize window', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.desktop-shell').dataset.maximized === 'true');
    assert.equal(await page.locator('.desktop-shell').evaluate(element => getComputedStyle(element).borderRadius), '0px');
    await page.getByRole('button', { name: 'Restore window', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.desktop-shell').dataset.maximized === 'false');
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html')).getBounds());
    const resize = await page.evaluate(async () => { const api = window.tinygpt; await api.resizeWindow({ edge: 'e', phase: 'start', x: 100, y: 100 }); await api.resizeWindow({ edge: 'e', phase: 'move', x: 160, y: 100 }); return api.resizeWindow({ edge: 'e', phase: 'end', x: 160, y: 100 }); }); assert.equal(resize.ok, true);
    const resizedWidth = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html')).getBounds().width);
    assert.ok(Math.abs(resizedWidth - (bounds.width + 60)) <= 1, 'Native window resizing stays within one scaled display pixel.');
    assert.equal((await page.evaluate(() => window.tinygpt.windowControl('invalid'))).ok, false);
    assert.equal((await page.evaluate(() => window.tinygpt.setAppIcon('../../anything'))).ok, false);
    const denied = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const remote = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
      try { await remote.loadURL('data:text/html,<p>Untrusted fixture</p>'); return await remote.webContents.executeJavaScript("window.tinygpt.windowControl('close')"); }
      finally { remote.destroy(); }
    }, resolve('out/preload/index.js'));
    assert.equal(denied.ok, false);
    await page.getByRole('button', { name: 'Minimize window', exact: true }).click();
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html')).isMinimized()), true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html')).restore());
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html')).setSize(850, 600));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve('artifacts/v2-desktop-narrow.png') });
    assert.deepEqual(errors, []);
    const closed = app.waitForEvent('close');
    await page.getByRole('button', { name: 'Close window', exact: true }).click().catch(error => { if (!/closed/i.test(error.message)) throw error; }); await closed; app = null;
    console.log('Desktop design passed: conversation, composer, local profile, theme/preferences persistence, settings saves, history navigation, icons, minimize/restore, maximize/restore, resizing, narrow layout, native close, and untrusted/invalid window commands.');
  } catch (error) { if (app) { const page = await app.firstWindow().catch(() => null); if (page) await page.screenshot({ path: resolve('artifacts/v2-desktop-failure.png') }).catch(() => {}); } console.error('Renderer errors:', errors); throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

