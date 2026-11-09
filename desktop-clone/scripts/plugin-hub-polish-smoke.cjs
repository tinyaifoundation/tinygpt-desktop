// Isolated renderer acceptance: no user accounts, tokens, or external writes.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `plugin-polish-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  const publish = (channel, value) => app.evaluate(({ BrowserWindow }, { channel, value }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, value); }, { channel, value });
  try {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'Plugins library', exact: true }).waitFor();
    const initial = await page.evaluate(async () => {
      for (const kind of ['gmail', 'gdrive', 'gcalendar', 'notion', 'github', 'slack']) { const result = await window.tinygpt.installConnector(kind); if (!result.ok) throw Error(result.error); }
      const plugins = (await window.tinygpt.plugins()).value, calendar = plugins.entries.find(entry => entry.manifest.connector === 'gcalendar');
      const disabled = await window.tinygpt.savePlugin({ id: calendar.id, manifest: calendar.manifest, config: { ...calendar.config, enabled: false } }); if (!disabled.ok) throw Error(disabled.error);
      return disabled.value;
    });
    await page.getByRole('button', { name: 'Plugins library', exact: true }).click(); await page.getByRole('tab', { name: 'Public', exact: true }).waitFor();
    const fixture = structuredClone(initial); for (const entry of fixture.entries) {
      if (entry.manifest.connector === 'gmail') { entry.status = 'connected'; entry.account = { name: 'Fixture account' }; }
      if (entry.manifest.connector === 'github') entry.status = 'error';
      if (entry.manifest.connector === 'slack') entry.status = 'connecting';
    }
    await publish('tinygpt:plugins-update', fixture);
    const popular = page.locator('.connector-catalog'), library = page.locator('.plugin-library-list');
    await popular.getByText('Connected', { exact: true }).waitFor(); assert.equal(await popular.locator('.plugin-connection-status.is-connected').count(), 1); assert.equal(await library.locator('.plugin-connection-status.is-connected').count(), 1);
    assert.equal(await page.getByRole('tab', { name: 'Personal', exact: true }).count(), 0); assert.equal(await page.locator('.plugin-library-note').count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('img.connector-brand-icon')].every(image => image.complete && image.naturalWidth > 0));
    for (const kind of ['gmail', 'gdrive', 'gcalendar', 'notion', 'github', 'slack']) assert.equal(await popular.locator(`img[data-connector="${kind}"]`).count(), 1);
    assert.equal(await library.locator('.plugin-library-item-toggle .lucide-check').count(), 0);
    const notion = library.locator('.plugin-library-item').filter({ has: page.getByText('Notion', { exact: true }) });
    const logo = await notion.locator('img').getAttribute('src'); assert.equal(await notion.locator('img[data-connector="notion"]').count(), 1);
    await notion.locator('summary').click(); await page.getByRole('heading', { name: 'Notion', exact: true }).waitFor(); assert.equal(await page.locator('.connector-detail-logo img').getAttribute('src'), logo);
    await page.locator('.connector-detail-actions').getByRole('button', { name: 'Connect', exact: true }).click(); await page.getByRole('dialog').waitFor(); assert.equal(await page.getByRole('dialog').locator('.connector-detail-logo img').getAttribute('src'), logo); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back to plugins', exact: true }).click(); await page.getByRole('tab', { name: 'Installed', exact: true }).click();
    assert.equal(await popular.count(), 0); assert.equal(await library.locator('.plugin-library-item').count(), initial.entries.filter(entry => entry.manifest.kind !== 'skill').length);
    const calendar = library.locator('.plugin-library-item').filter({ has: page.getByText('Google Calendar', { exact: true }) }); assert.equal(await calendar.locator('.plugin-connection-status').innerText(), 'Disabled'); assert.equal(await calendar.locator('img[data-connector="gcalendar"]').count(), 1);
    await calendar.getByRole('switch', { name: 'Google Calendar enabled', exact: true }).click(); await calendar.getByText('Disconnected', { exact: true }).waitFor(); assert.equal(await calendar.locator('.lucide-check').count(), 0);
    await page.getByRole('tab', { name: 'Public', exact: true }).click(); await publish('tinygpt:plugins-update', fixture); await popular.getByText('Connected', { exact: true }).waitFor(); await page.screenshot({ path: resolve('artifacts/plugin-hub-polish.png') });
    await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
    const items = Array.from({ length: 30 }, (_, index) => ({ id: randomUUID(), sequence: 30 - index, conversationId: randomUUID(), messageId: null, kind: 'completed', mode: 'chat', title: `Reply ready ${index + 1}`, detail: 'Fixture', createdAt: Date.now() - index * 1000, read: false, resolved: false }));
    await publish('tinygpt:notifications-update', { items, unreadCount: items.length, unreadConversationIds: [], desktopSupported: false, deliveryError: null, customSoundName: null });
    await page.getByRole('button', { name: 'View activity', exact: true }).click(); const popover = page.locator('.sidebar-activity-popover'), viewport = popover.locator('[data-slot="scroll-area-viewport"]'); await viewport.waitFor();
    await page.waitForFunction(() => { const el = document.querySelector('.activity-scroll-viewport'); return el && el.scrollHeight > el.clientHeight && el.clientHeight > 0; });
    const before = await viewport.evaluate(el => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, top: el.scrollTop }));
    await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; }); assert.ok(await viewport.evaluate(el => el.scrollTop) > before.top);
    assert.equal(await popover.evaluate(el => getComputedStyle(el).overflowY), 'hidden'); await popover.locator('[data-slot="scroll-area-scrollbar"]').waitFor();
    assert.ok(await popover.getByRole('button', { name: 'Notification settings', exact: true }).isVisible()); assert.ok(await popover.getByRole('button', { name: 'Mark all read', exact: true }).isVisible());
    await page.screenshot({ path: resolve('artifacts/notifications-scrollbar.png') }); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: ['official logos decode for all six catalog services', 'Notion logo and detail navigation consistent across surfaces', 'Public and Installed tabs', 'connected-only checkmarks', 'all installed entries include disabled plugins', 'enabling does not imply connected', 'footer removed', 'shadcn notification scrollbar overflows and scrolls with fixed controls'], notificationViewport: before, errors }));
  } catch (error) { await page.screenshot({ path: resolve('artifacts/plugin-hub-polish-failure.png') }).catch(() => {}); throw error; }
  finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
