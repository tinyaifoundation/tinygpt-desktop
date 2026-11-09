const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `menu-preview-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async () => {
      const first = await window.tinygpt.createConversation(null); await window.tinygpt.renameConversation(first.value.id, 'Menu preview chat');
      const second = await window.tinygpt.createConversation(null); await window.tinygpt.renameConversation(second.value.id, 'Other preview chat');
      await window.tinygpt.createProject('Preview project', '');
    });
    await page.reload(); const row = page.locator('.sidebar-chat-container').filter({ has: page.getByRole('button', { name: 'Menu preview chat', exact: true }) });
    const preview = page.locator('.conversation-preview');
    await row.getByRole('button', { name: 'Menu preview chat', exact: true }).hover(); await row.getByRole('button', { name: 'Menu preview chat', exact: true }).focus(); await preview.waitFor();
    await row.getByRole('button', { name: 'More for Menu preview chat', exact: true }).click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor(); await preview.waitFor({ state: 'hidden' });
    await row.hover(); await page.waitForTimeout(400); assert.equal(await preview.count(), 0);
    const other = page.getByRole('button', { name: 'Other preview chat', exact: true }); await other.hover(); await page.waitForTimeout(400); assert.equal(await preview.count(), 0);
    await page.getByRole('menuitem', { name: 'Move to Project', exact: true }).hover(); await page.getByRole('menuitem', { name: 'Preview project', exact: true }).waitFor(); assert.equal(await preview.count(), 0);
    await page.screenshot({ path: resolve('artifacts/conversation-menu-no-preview.png') });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.mouse.move(600, 400); await other.hover(); await other.focus(); await preview.waitFor();
    await page.mouse.move(600, 400); await page.getByRole('button', { name: 'New chat', exact: true }).focus(); await preview.waitFor({ state: 'hidden' });
    const more = row.getByRole('button', { name: 'More for Menu preview chat', exact: true }); await row.hover(); await more.focus(); await more.press('Enter'); await page.getByRole('menuitem', { name: 'Rename', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).focus(); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(400); assert.ok(await page.getByRole('menu').count() > 0); assert.equal(await preview.count(), 0);
    await page.keyboard.press('Escape'); await page.mouse.move(600, 400); await row.getByRole('button', { name: 'Menu preview chat', exact: true }).hover(); await row.getByRole('button', { name: 'Menu preview chat', exact: true }).focus(); await preview.waitFor();
    await more.click(); await page.getByRole('menuitem', { name: 'Rename', exact: true }).click(); await page.getByRole('dialog').waitFor(); assert.equal(await preview.count(), 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.mouse.move(600, 400); await other.hover(); await other.focus(); await preview.waitFor();
    assert.deepEqual(errors, []); console.log('Conversation preview passed: hidden during pointer/keyboard options menus and submenus, no other-row previews during a menu, normal hover restored after dismissal and Rename.');
  } catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/conversation-menu-preview-failure.png') }); throw error; } finally { await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
