// Focused local-only verification of browser preferences and the v2 composer.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir, readFile } = require('node:fs/promises');
const assert = require('node:assert/strict');

async function main() {
  let app; let origin; let trackerHits = 0; const pageHeaders = []; const errors = [];
  const server = createServer(async (request, response) => {
    const address = new URL(request.url, 'http://fixture');
    if (address.pathname === '/tracking.js') { trackerHits++; response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('window.trackerLoaded=true'); return; }
    if (address.pathname === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'browser-settings-fixture' }] })); return; }
    if (address.pathname === '/v1/chat/completions') {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw);
      const called = body.messages.some(message => message.role === 'tool');
      const delta = called ? { role: 'assistant', content: 'A grounded local answer [1].' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'privacy-page', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ url: origin + '/page', status: 'Checking the local page' }) } }] };
      const event = (value, finish = null) => JSON.stringify({ id: 'browser-settings-reply', object: 'chat.completion.chunk', created: 1, model: 'browser-settings-fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${event(delta)}\n\ndata: ${event({}, called ? 'stop' : 'tool_calls')}\n\ndata: [DONE]\n\n`); return;
    }
    if (address.pathname === '/challenge') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Verify you are human</title><main data-testid="challenge">Complete the security check</main><script>setTimeout(()=>location.replace("/resolved"),1800)</script>'); return; }
    if (address.pathname === '/resolved') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Verification cleared</title><main>Verification finished in the same tab.</main>'); return; }
    if (address.pathname === '/favicon.ico') { response.writeHead(404).end(); return; }
    pageHeaders.push(request.headers);
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<title>Privacy fixture</title><main><h1>Privacy fixture</h1><p>Evidence from a local browser page.</p><button onclick="window.clicks=(window.clicks||0)+1">Test browser button</button></main><script src="http://analytics.google.com:${server.address().port}/tracking.js"></script>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  const profile = resolve('.tools-smoke-profile', `browser-settings-${Date.now()}`);
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  async function launch() { app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs'), '--host-resolver-rules=MAP analytics.google.com 127.0.0.1', '--no-proxy-server'], env }); const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); return page; }
  async function bridge(page, name, ...args) { const result = await page.evaluate(({ name, args }) => window.tinygpt[name](...args), { name, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function idle(page) { for (let i = 0; i < 150; i++) { const library = await bridge(page, 'library'); if (!library.activeRuns[0]) return library; await new Promise(done => setTimeout(done, 100)); } throw new Error('Local reply did not complete.'); }
  async function settings(page, section = 'Browser') { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click(); }
  async function remote(url, expression) { return app.evaluate(async ({ webContents }, { url, expression }) => { const contents = webContents.getAllWebContents().find(item => item.getURL() === url); if (!contents) throw new Error('Fixture tab not found'); return contents.executeJavaScript(expression); }, { url, expression }); }
  async function toggle(page, name) { await page.getByRole('switch', { name, exact: true }).click(); await page.getByText('Saved', { exact: true }).waitFor(); }
  try {
    let page = await launch(); let snapshot = await bridge(page, 'snapshot');
    await bridge(page, 'saveSettings', { ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint: origin + '/v1', model: 'browser-settings-fixture', tools: true }, toolPermissions: { ...snapshot.settings.toolPermissions, browser: 'allow', interact: 'allow' } });
    await page.reload(); const composer = page.getByRole('textbox', { name: 'Message', exact: true }); await composer.waitFor(); await mkdir(resolve('artifacts'), { recursive: true });
    assert.equal(await page.getByLabel('Ideas to get started').count(), 0);
    for (const name of ['Find in conversation', 'Rename chat', 'Delete chat']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
    assert.equal(await page.locator('.tiny-sidebar-footer').evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    await composer.fill('Draft preserved while choosing a project');
    await page.getByRole('button', { name: 'Project: Choose project', exact: true }).click(); await page.getByRole('menuitem', { name: 'New Project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Composer project'); await page.getByRole('button', { name: 'Create Project', exact: true }).click();
    await page.getByRole('button', { name: 'Project: Composer project', exact: true }).waitFor(); assert.equal(await composer.inputValue(), 'Draft preserved while choosing a project');
    await page.getByRole('button', { name: 'Project: Composer project', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'No project', exact: true }).click();
    await page.getByRole('button', { name: 'Project: Choose project', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Composer project', exact: true }).click();
    assert.equal(await composer.inputValue(), 'Draft preserved while choosing a project');
    await page.getByRole('button', { name: 'Plugins', exact: true }).click(); await page.getByText(/No plugins installed/).waitFor(); await page.keyboard.press('Escape');
    await page.screenshot({ path: resolve('artifacts/composer-v2-new-chat.png') });
    await composer.fill('Find the local evidence'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); const library = await idle(page); const chatId = library.lastConversationId;
    assert.equal((await bridge(page, 'conversation', chatId)).projectId, library.projects.find(item => item.name === 'Composer project').id);
    await page.getByRole('button', { name: '1 source', exact: true }).waitFor(); assert.equal(trackerHits, 0); assert.ok(pageHeaders.some(headers => /Chrome\//.test(headers['user-agent']) && !/Electron|TinyGPT/.test(headers['user-agent'])));
    await settings(page, 'Appearance'); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    assert.equal(await page.locator('[data-slot=sources]').evaluate(element => getComputedStyle(element).backgroundColor), await page.locator('.work-composer').evaluate(element => getComputedStyle(element).backgroundColor));
    await page.screenshot({ path: resolve('artifacts/source-chip-dark.png') });
    await page.getByRole('button', { name: '1 source', exact: true }).click(); await page.getByRole('button', { name: 'Open source: Privacy fixture', exact: true }).click(); await page.getByRole('tab', { name: 'Privacy fixture', exact: true }).waitFor();
    const address = page.getByRole('textbox', { name: 'Search or enter a URL', exact: true });
    await address.blur(); assert.equal(await address.inputValue(), new URL(origin).host); await address.focus(); await page.waitForFunction(url => document.querySelector('[aria-label="Search or enter a URL"]').value === url, origin + '/page');
    assert.equal(await page.locator('.workspace-browser-viewport').evaluate(element => getComputedStyle(element).borderTopLeftRadius), '0px');
    const native = await app.evaluate(({ BrowserWindow, webContents }, url) => { const owner = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('out/renderer')); const content = webContents.getAllWebContents().find(item => item.getURL() === url); const frame = owner.contentView.children.find(item => item.children.some(child => child.webContents === content)); const child = frame?.children.find(item => item.webContents === content); return { attached: !!child, frame: frame?.getBounds(), child: child?.getBounds(), zoom: owner.webContents.getZoomFactor(), preferences: content.getLastWebPreferences() }; }, origin + '/page');
    assert.equal(native.attached, true); assert.equal(native.preferences.nodeIntegration, false); assert.equal(native.preferences.sandbox, true);
    const viewport = await page.locator('.workspace-browser-viewport').boundingBox(); assert.ok(Math.abs(native.frame.y + native.child.y - viewport.y * native.zoom) <= 1); assert.ok(Math.abs(native.frame.x + native.child.x - viewport.x * native.zoom) <= 1);
    await remote(origin + '/page', 'document.querySelector("button").click()'); assert.equal(await remote(origin + '/page', 'window.clicks'), 1);
    await settings(page); await toggle(page, 'TinyGPT AdBlock'); assert.equal((await bridge(page, 'snapshot')).settings.browser.adBlock, false);
    await toggle(page, 'Show full URL'); await page.getByRole('button', { name: 'Local link open destination', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Default browser', exact: true }).click(); await page.getByText('Saved', { exact: true }).waitFor();
    await app.evaluate(({ shell }) => { globalThis.openedFixtureLinks = []; shell.openExternal = async url => { globalThis.openedFixtureLinks.push(url); }; });
    assert.equal(await bridge(page, 'openBrowserLink', origin + '/page'), 'system'); assert.deepEqual(await app.evaluate(() => globalThis.openedFixtureLinks), [origin + '/page']); assert.equal((await page.evaluate(() => window.tinygpt.openBrowserLink('file:///private'))).ok, false);
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.getByRole('button', { name: 'Reload page', exact: true }).click();
    for (let i = 0; i < 30 && !trackerHits; i++) await new Promise(done => setTimeout(done, 100)); assert.ok(trackerHits > 0, 'Disabling AdBlock lets the local tracker fixture load.');
    await address.blur(); assert.equal(await address.inputValue(), origin + '/page');
    // Every profile survives a restart even if its tab and history were cleared.
    const dormant = await bridge(page, 'createProject', 'Dormant isolated browser', '', true); const dormantChat = await bridge(page, 'createConversation', dormant.id); const dormantTab = await bridge(page, 'workspaceBrowser', { action: 'new', conversationId: dormantChat.id, url: origin + '/dormant' });
    for (let i = 0; i < 30; i++) { if (await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().some(item => item.getURL() === url), origin + '/dormant')) break; await new Promise(done => setTimeout(done, 100)); }
    await remote(origin + '/dormant', 'document.cookie="kept=isolated; path=/; max-age=3600"'); await remote(origin + '/page', 'document.cookie="kept=shared; path=/; max-age=3600"');
    await bridge(page, 'workspaceBrowser', { action: 'close', conversationId: dormantChat.id, tabId: dormantTab.activeId });
    await settings(page); await page.locator('.browser-history-row').first().waitFor(); await page.screenshot({ path: resolve('artifacts/browser-settings-dark.png') });
    await page.getByRole('button', { name: 'Clear history', exact: true }).click(); await page.getByRole('dialog', { name: 'Clear browser history?', exact: true }).getByRole('button', { name: 'Clear', exact: true }).click(); await page.getByText('Browsing history cleared.', { exact: true }).waitFor();
    assert.deepEqual(await bridge(page, 'browserHistory'), []);
    assert.ok((await remote(origin + '/page', 'document.cookie')).includes('kept=shared'));
    await app.close(); app = null; page = await launch(); snapshot = await bridge(page, 'snapshot'); assert.equal(snapshot.settings.browser.adBlock, false); assert.equal(snapshot.settings.browser.showFullUrl, true); assert.deepEqual(await bridge(page, 'browserHistory'), []);
    const partition = `persist:tinygpt-browser-${dormant.id}`;
    assert.ok((await app.evaluate(async ({ session }, partition) => session.fromPartition(partition).cookies.get({ name: 'kept' }), partition)).length);
    await settings(page); await page.getByRole('button', { name: 'Clear browsing data', exact: true }).click(); await page.getByRole('dialog', { name: 'Clear browsing data?', exact: true }).getByRole('button', { name: 'Clear', exact: true }).click(); await page.getByText('Browser history, cookies, site data, and cache cleared.', { exact: true }).waitFor();
    assert.equal((await app.evaluate(async ({ session }, partition) => session.fromPartition(partition).cookies.get({ name: 'kept' }), partition)).length, 0);
    assert.ok((await bridge(page, 'conversation', chatId)).sources.length, 'Clearing browser data preserves saved chat sources.');
    // Verification clears in the same tool tab; no second browser or rerun.
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.evaluate(() => { window.fixtureHandoffs = []; window.tinygpt.onChatUpdate(update => window.fixtureHandoffs.push(...update.library.browserHandoffs)); });
    const verification = await bridge(page, 'readPage', chatId, origin + '/challenge'); assert.equal(verification.page.url, origin + '/resolved'); assert.equal(verification.page.challenge, false);
    const handoffs = await page.evaluate(() => window.fixtureHandoffs); assert.ok(handoffs.some(item => item.tabId === verification.page.tabId));
    const saved = JSON.parse(await readFile(resolve(profile, 'browser-data.json'), 'utf8')); assert.ok(saved.profiles.includes(partition)); assert.ok(saved.history.length <= 500);
    assert.deepEqual(errors, []); console.log('Browser/composer UI passed: empty welcome, clean header/footer, draft-safe Project picker, plugins menu, dark source chip, native bottom-only clipping, live interaction, ad/tracker blocking toggle, normal Chromium headers, URL display, link routing, persistent history, profile-aware clearing, preserved sources, and same-tab verification recovery.');
  } catch (error) { if (app) { const page = await app.firstWindow().catch(() => null); if (page) await page.screenshot({ path: resolve('artifacts/browser-settings-failure.png') }).catch(() => {}); } console.error('Renderer errors:', errors); throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
