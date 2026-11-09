// Focused Electron checks: disposable profile, local inference, no user data.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'sidebar-fixture' }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    for await (const _ of request) { /* Drain fixture request. */ }
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'sidebar-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const answer = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}: a saved response for scrolling.`).join('\n\n');
    response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: answer }))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `sidebar-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  let app; const errors = [];
  try {
    await mkdir(resolve('artifacts'), { recursive: true });
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    assert.equal((await page.evaluate(async endpoint => { const snapshot = await window.tinygpt.snapshot(); return window.tinygpt.saveSettings({ ...snapshot.value.settings, route: 'local', local: { ...snapshot.value.settings.local, endpoint, model: 'sidebar-fixture' } }); }, `http://127.0.0.1:${server.address().port}/v1`)).ok, true);
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A sidebar conversation'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Paragraph 30: a saved response for scrolling.', { exact: true }).waitFor(); await page.waitForFunction(async () => !(await window.tinygpt.library()).value.activeRuns[0]);
    const chat = (await page.evaluate(() => window.tinygpt.library())).value.conversations[0];
    assert.equal(await page.locator('.thread-viewport').evaluate(element => getComputedStyle(element).scrollbarWidth), 'none');
    const resize = page.getByRole('separator', { name: 'Resize sidebar' }); await resize.focus(); await resize.press('ArrowRight'); assert.equal(await resize.getAttribute('aria-valuenow'), '276');
    const bounds = await resize.boundingBox(); await page.mouse.move(bounds.x + 4, bounds.y + 80); await page.mouse.down(); await page.mouse.move(bounds.x + 104, bounds.y + 80); await page.mouse.up(); assert.equal(await resize.getAttribute('aria-valuenow'), '360');
    await resize.focus(); await resize.press('ArrowLeft'); assert.equal(await resize.getAttribute('aria-valuenow'), '348');
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click(); assert.equal(await page.locator('.tiny-sidebar').evaluate(element => getComputedStyle(element).backgroundColor), await page.locator('.desktop-shell > main').evaluate(element => getComputedStyle(element).backgroundColor));
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    assert.equal(await page.locator('.tiny-sidebar').evaluate(element => getComputedStyle(element).borderRadius), '0px');
    await page.getByRole('button', { name: 'New chat', exact: true }).click(); await page.getByRole('tab', { name: 'Work', exact: true }).click();
    await page.getByRole('button', { name: 'Ask for approval', exact: true }).click(); await page.screenshot({ path: resolve('artifacts/sidebar-approval-menu.png') }); await page.getByRole('menuitem', { name: /Approve for me/ }).click();
    await page.getByRole('button', { name: 'Approve for me', exact: true }).waitFor(); assert.equal((await page.evaluate(() => window.tinygpt.snapshot())).value.settings.toolPermissions.browser, 'allow');
    await page.getByRole('button', { name: 'Approve for me', exact: true }).click(); await page.getByRole('menuitem', { name: /Full access/ }).click(); await page.getByRole('button', { name: 'Full access', exact: true }).waitFor();
    assert.ok(Object.values((await page.evaluate(() => window.tinygpt.snapshot())).value.settings.toolPermissions).every(rule => rule === 'allow'));
    await page.getByRole('button', { name: 'Full access', exact: true }).click(); await page.getByRole('button', { name: 'Learn more', exact: true }).click();
    await page.getByRole('heading', { name: 'General', exact: true }).waitFor(); assert.equal(await page.locator('select').count(), 0);
    await page.locator('#approval-purchase').click(); await page.getByRole('menuitemradio', { name: 'Never allow', exact: true }).click(); await page.getByRole('button', { name: 'Save settings', exact: true }).click(); await page.getByText('Settings saved.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.getByRole('button', { name: 'Custom approvals', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open profile menu', exact: true }).click(); await page.screenshot({ path: resolve('artifacts/sidebar-profile-menu.png') }); await page.locator('.profile-menu-identity').click();
    await page.getByRole('region', { name: 'Usage and activity' }).waitFor(); await page.getByText('Lifetime tokens', { exact: true }).waitFor(); assert.equal((await page.evaluate(() => window.tinygpt.profileUsage())).value.totalTokens, 125);
    assert.equal(await page.locator('.usage-metrics strong').first().innerText(), '125'); assert.ok(await page.locator('.activity-heatmap button').count() >= 365); await page.locator('.activity-heatmap button').last().click();
    await page.screenshot({ path: resolve('artifacts/sidebar-profile-usage.png') });
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); assert.equal(await page.locator('select').count(), 0);
    await page.getByLabel('Light theme uiFont', { exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Manrope', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    const projectsBefore = (await page.evaluate(() => window.tinygpt.library())).value.projects.length;
    await page.locator('[data-sidebar-section=Projects]').hover(); await page.getByRole('button', { name: 'New Project', exact: true }).click(); await page.getByRole('dialog', { name: 'Create project' }).waitFor(); await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Cancelled'); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.equal((await page.evaluate(() => window.tinygpt.library())).value.projects.length, projectsBefore);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, resolve('.tools-smoke-profile'));
    await page.locator('[data-sidebar-section=Projects]').hover(); await page.getByRole('button', { name: 'New Project', exact: true }).click(); await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Sidebar Project'); await page.getByRole('button', { name: 'Add source folder', exact: true }).click();
    await page.getByRole('button', { name: 'Project options', exact: true }).click(); await page.getByRole('textbox', { name: 'Project instructions', exact: true }).fill('Keep this organized.'); await page.keyboard.press('Escape'); await page.screenshot({ path: resolve('artifacts/sidebar-project-modal-dark.png') }); await page.getByRole('button', { name: 'Create project', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const project = (await page.evaluate(() => window.tinygpt.library())).value.projects.find(project => project.name === 'Sidebar Project'); assert.equal(project.rootPath.toLowerCase(), resolve('.tools-smoke-profile').toLowerCase());
    assert.equal((await page.evaluate(id => window.tinygpt.createProject('Invalid token Project', '', false, id), '11111111-1111-4111-8111-111111111111')).ok, false);
    async function more(title) { const row = page.locator('.sidebar-chat-container').filter({ has: page.getByRole('button', { name: title, exact: true }) }).first(); await row.hover(); await row.getByRole('button', { name: `More for ${title}`, exact: true }).click(); }
    await more(chat.title); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click(); await page.getByRole('textbox', { name: 'Chat title', exact: true }).fill('Renamed sidebar chat'); await page.getByRole('button', { name: 'Save title', exact: true }).click();
    await page.waitForFunction(async () => (await window.tinygpt.library()).value.conversations.some(chat => chat.title === 'Renamed sidebar chat'));
    await more('Renamed sidebar chat'); await page.getByRole('menuitem', { name: 'Favorite', exact: true }).click(); await page.getByRole('navigation', { name: 'Favorite conversations' }).waitFor();
    await more('Renamed sidebar chat'); await page.getByRole('menuitem', { name: 'Move to Project', exact: true }).hover(); await page.getByRole('menuitem', { name: 'Sidebar Project', exact: true }).click();
    await page.waitForFunction(async id => (await window.tinygpt.library()).value.conversations.find(chat => chat.title === 'Renamed sidebar chat').projectId === id, project.id);
    await more('Renamed sidebar chat'); await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Archived chats', exact: true }).click();
    await page.getByRole('button', { name: 'Restore Renamed sidebar chat', exact: true }).click(); await page.getByText('No archived chats.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.getByRole('navigation', { name: 'Favorite conversations' }).waitFor();
    await page.getByRole('button', { name: 'Search chats', exact: true }).click(); await page.getByRole('combobox', { name: 'Search saved chats', exact: true }).fill('Renamed'); await page.screenshot({ path: resolve('artifacts/sidebar-search-modal-dark.png') }); await page.getByRole('combobox', { name: 'Search saved chats', exact: true }).press('Enter'); await page.getByText('Paragraph 30: a saved response for scrolling.', { exact: true }).waitFor(); assert.equal(await page.getByRole('dialog').count(), 0);
    await page.reload(); await page.getByRole('button', { name: 'Open profile menu', exact: true }).waitFor(); assert.equal(await page.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow'), '348'); assert.equal((await page.evaluate(() => window.tinygpt.snapshot())).value.settings.toolPermissions.purchase, 'deny');
    await more('Renamed sidebar chat'); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal((await page.evaluate(() => window.tinygpt.library())).value.conversations.length, 1);
    await more('Renamed sidebar chat'); await page.getByRole('menuitem', { name: 'Delete', exact: true }).click(); await page.getByRole('button', { name: 'Delete conversation', exact: true }).click(); await page.waitForFunction(async () => (await window.tinygpt.library()).value.conversations.length === 0);
    assert.deepEqual(errors, []); console.log('Sidebar interactions passed: scrollbar, resizing/persistence, collapse color, corner rounding, real approval rules, shadcn settings menus, profile menu/metrics/heatmap, Project modal and native folder selection, rename/favorite/move/archive/restore/delete, search, and dark-theme dialogs.');
  } catch (error) { if (app) { const page = await app.firstWindow().catch(() => null); if (page) console.error('Overlay state:', await page.evaluate(() => ({ pointerEvents: document.body.style.pointerEvents, dialogs: document.querySelectorAll('[role=dialog]').length, menus: document.querySelectorAll('[role=menu]').length }))); if (page) await page.screenshot({ path: resolve('artifacts/sidebar-interactions-failure.png') }).catch(() => {}); } console.error('Renderer errors:', errors); throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });




