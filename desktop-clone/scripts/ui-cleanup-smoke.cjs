// Exercise the cleanup with isolated app data and a local model fixture.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'ui-fixture' }] }));
    for await (const _ of request) { /* Drain fixture input. */ }
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'ui-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'A completed cleanup fixture reply.' }))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `ui-cleanup-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  let app; const errors = [];
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const snapshot = await window.tinygpt.snapshot();
      await window.tinygpt.saveSettings({ ...snapshot.value.settings, route: 'local', local: { ...snapshot.value.settings.local, endpoint, model: 'ui-fixture' } });
      const first = await window.tinygpt.createConversation(null); await window.tinygpt.renameConversation(first.value.id, 'First conversation');
      const second = await window.tinygpt.createConversation(null); await window.tinygpt.renameConversation(second.value.id, 'Second conversation');
      const archived = await window.tinygpt.createConversation(null); await window.tinygpt.renameConversation(archived.value.id, 'Archived conversation'); await window.tinygpt.organizeConversation({ id: archived.value.id, action: 'archive', value: true });
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.locator('.conversation-title-trigger').waitFor();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    assert.equal(await page.locator('[data-sidebar-section="Archived"]').count(), 0);
    const resize = page.getByRole('separator', { name: 'Resize sidebar' }); await resize.hover();
    assert.equal(await resize.evaluate(node => getComputedStyle(node, '::after').content), 'none');
    assert.equal(await page.locator('.sidebar-nav-action [data-robot-avatar]').evaluate(node => [...node.querySelectorAll('path')].map(path=>getComputedStyle(path).fill).find(fill=>fill==='rgb(255, 255, 255)')), 'rgb(255, 255, 255)');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('navigation', { name: 'Settings sections' }); assert.equal(await settings.getByRole('button', { name: 'Apps', exact: true }).count(), 0);
    await settings.getByRole('button', { name: 'Archived chats', exact: true }).click(); await page.getByRole('button', { name: 'Restore Archived conversation' }).waitFor();
    await page.screenshot({ path: resolve('artifacts/ui-cleanup-archived-settings.png') });
    await page.getByRole('textbox', { name: 'Search archived chats' }).fill('missing'); await page.getByText('No matching archived chats.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search archived chats' }).fill('Archived'); await page.getByRole('button', { name: 'Restore Archived conversation' }).click(); await page.getByText('No archived chats.', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.tinygpt.library())).value.conversations.find(chat => chat.title === 'Archived conversation').archived, false);
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Archived chats', exact: true }).click(); await page.getByText('No archived chats.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('heading', { name: 'Where should we begin?', exact: true }).waitFor();
    const input = page.getByRole('textbox', { name: 'Message', exact: true }); assert.equal(await input.getAttribute('placeholder'), 'Ask TinyGPT');
    await input.fill('Preserve this draft across modes'); await input.evaluate(node => { window.cleanupDraftInput = node; });
    await page.getByRole('tab', { name: 'Work', exact: true }).click(); await page.getByRole('heading', { name: 'What should we work on?', exact: true }).waitFor();
    assert.equal(await input.getAttribute('placeholder'), 'Work with TinyGPT'); assert.equal(await input.inputValue(), 'Preserve this draft across modes'); assert.equal(await input.evaluate(node => window.cleanupDraftInput === node), true);
    await page.waitForFunction(() => document.querySelector('.conversation-greeting').getAnimations().length > 0 && document.querySelector('.composer-footer').getAnimations().length > 0);
    await page.evaluate(async () => { await Promise.all(document.querySelector('.composer-footer').getAnimations().map(animation => animation.finished)); document.documentElement.dataset.motion = 'reduce'; });
    await page.getByRole('tab', { name: 'Chat', exact: true }).click(); await page.getByRole('heading', { name: 'Where should we begin?', exact: true }).waitFor();
    assert.equal(await input.inputValue(), 'Preserve this draft across modes'); assert.equal(await page.locator('.composer-footer').evaluate(node => node.getAnimations().length), 0);
    await input.fill(''); await page.evaluate(() => { document.documentElement.dataset.motion = 'full'; });
    assert.deepEqual(await page.locator('.sidebar-nav-action .sidebar-action-label').allTextContents(), ['New chat', 'Your Bot', 'Library', 'Plugins', 'Scheduled']);
    assert.equal(await page.locator('[data-slot="composer-extras"]').count(), 0);
    await page.getByRole('tab', { name: 'Work', exact: true }).click();
    assert.equal(await page.locator('.work-composer-extras .lucide-chevron-down').count(), 0);
    assert.equal(await page.locator('.work-composer-extras button[aria-label="Plugins"]').innerText(), 'Plugins');
    await page.getByRole('button', { name: 'Project: Choose project' }).click(); assert.equal(await page.getByRole('menuitemradio', { name: 'No project' }).count(), 0); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Plugins', exact: true }).click(); await page.getByRole('menuitem', { name: 'Manage plugins' }).waitFor(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ask for approval', exact: true }).click();
    assert.ok(await page.locator('.approval-menu').evaluate(node => parseFloat(getComputedStyle(node).width) <= 380));
    await page.screenshot({ path: resolve('artifacts/ui-cleanup-approval.png') });
    await page.getByRole('menuitem', { name: /Approve for me/ }).click(); await page.getByRole('button', { name: 'Approve for me', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.tinygpt.snapshot())).value.settings.toolPermissions.browser, 'allow');
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.mouse.move(700, 400); await page.getByRole('button', { name: 'Show workspace' }).hover();
    await page.getByRole('button', { name: 'Show workspace' }).focus(); await page.locator('[data-slot="tooltip-content"]').filter({ hasText: 'Show workspace' }).waitFor(); await page.mouse.move(700, 400);
    assert.equal(await page.locator('.conversation-header .conversation-title-trigger').count(), 0);
    await page.locator('.sidebar-chat-row').filter({ hasText: 'First conversation' }).click();
    await page.getByRole('button', { name: 'Switch conversation: First conversation' }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A completed cleanup fixture reply.'); await page.getByRole('button', { name: 'Send message' }).click();
    await page.locator('[data-slot="answer-text"]').filter({ hasText: 'A completed cleanup fixture reply.' }).waitFor().catch(async error => { await page.screenshot({ path: resolve('artifacts/ui-cleanup-failure.png') }); console.error(await page.locator('.thread-message-column').innerText()); throw error; });
    await page.waitForFunction(async () => !(await window.tinygpt.library()).value.activeRuns[0]);
    await page.locator('.thread-message-column').waitFor();
    const currentTitle = await page.locator('.conversation-title-trigger > span').innerText(); assert.ok(currentTitle.length);
    await page.mouse.move(700, 400); assert.equal(await page.locator('.conversation-title-trigger > svg').evaluate(node => getComputedStyle(node).opacity), '0');
    await page.locator('.conversation-title-trigger').hover(); assert.equal(await page.locator('.conversation-title-trigger > svg').evaluate(node => getComputedStyle(node).opacity), '1');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.locator('.conversation-title-trigger').waitFor();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.locator('.sidebar-nav-action [data-robot-avatar]').evaluate(node => [...node.querySelectorAll('path')].map(path=>getComputedStyle(path).fill).find(fill=>fill==='rgb(255, 255, 255)')), 'rgb(255, 255, 255)');
      await page.getByRole('button', { name: 'Recents', exact: true }).hover();
      assert.equal(await page.getByRole('button', { name: 'Recents', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
      const colors = await page.locator('.sidebar-nav-action, .sidebar-chat-row, .sidebar-section-toggle').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color)); assert.equal(new Set(colors).size, 1);
      assert.equal(await page.locator('.sidebar-search svg').evaluate(node => getComputedStyle(node).width), '15px');
      await page.screenshot({ path: resolve(`artifacts/ui-cleanup-${theme}.png`) });
    }
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.locator('.conversation-title-trigger').click(); await page.getByRole('menuitemradio', { name: 'Second conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Switch conversation: Second conversation' }).waitFor();
    await page.getByRole('button', { name: 'View activity' }).click(); await page.locator('.sidebar-activity-popover').waitFor(); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Library', exact: true }).click(); await page.getByRole('heading', { name: 'All', exact: true }).waitFor(); await page.getByRole('tab', { name: 'Images', exact: true }).click(); await page.getByRole('heading', { name: 'No images yet', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Scheduled', exact: true }).click(); await page.getByRole('heading', { name: 'Scheduled', exact: true }).waitFor(); await page.getByText('Coming soon', { exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/ui-cleanup-collapsed.png') });
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.getByRole('heading', { name: 'All', exact: true }).waitFor();
    const codeId = await page.evaluate(async () => { const snapshot = await window.tinygpt.snapshot(); await window.tinygpt.saveSettings({ ...snapshot.value.settings, mode: 'code' }); const chat = await window.tinygpt.createConversation(null); await window.tinygpt.renameConversation(chat.value.id, 'Code conversation'); return chat.value.id; });
    await page.reload(); await page.locator('.conversation-title-trigger').waitFor();
    await page.locator('.conversation-title-trigger').click(); await page.getByRole('menuitemradio', { name: 'Code conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Switch conversation: Code conversation' }).waitFor();
    assert.equal((await page.evaluate(id => window.tinygpt.conversation(id), codeId)).value.mode, 'code');
    assert.deepEqual(errors, []);
    console.log('UI cleanup passed: title switching, collapsed sidebar, themes, shared sidebar colors, transparent section and resize hover, white bot eyes, archived Settings search/restore/persistence, Plugins-only integrations, V2 greetings/placeholders, mode animation/draft preservation/reduced motion, workspace tooltip, compact permissions and saved rules, composer pickers, activity, Library, Scheduled and history.');
  } catch (error) { if (app) await (await app.firstWindow()).screenshot({ path: resolve('artifacts/ui-cleanup-failure.png') }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
