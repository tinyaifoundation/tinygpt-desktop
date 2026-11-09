const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let desktop; const errors = [];
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `conversation-switcher-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async () => {
      let selected;
      for (let i = 1; i <= 48; i++) {
        const result = await window.tinygpt.createConversation(null); if (!result.ok) throw Error(result.error);
        const renamed = await window.tinygpt.renameConversation(result.value.id, i === 24 ? 'A deliberately long conversation title that must stay within the switcher width without adding a horizontal scrollbar' : `Conversation ${i}`);
        if (!renamed.ok) throw Error(renamed.error); selected = result.value.id;
      }
      const result = await window.tinygpt.conversation(selected); if (!result.ok) throw Error(result.error);
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const key = 'tinygpt-appearance-v4'; const value = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.locator('.conversation-title-trigger').waitFor(); await page.locator('.conversation-title-trigger').click();
      const menu = page.locator('.conversation-switcher'); await menu.waitFor();
      const viewport = menu.locator('[data-slot=scroll-area-viewport]');
      const metrics = await viewport.evaluate(element => ({ height: element.clientHeight, total: element.scrollHeight, horizontal: element.scrollWidth > element.clientWidth, native: getComputedStyle(element).scrollbarWidth, outerOverflow: getComputedStyle(element.closest('[role=menu]')).overflowY }));
      assert.ok(metrics.height <= 406 && metrics.total > 1000, JSON.stringify(metrics)); assert.equal(metrics.horizontal, false); assert.equal(metrics.native, 'none'); assert.equal(metrics.outerOverflow, 'hidden'); await menu.locator('[data-slot=scroll-area-thumb]').waitFor();
      await viewport.hover(); await page.mouse.wheel(0, 250); await page.waitForTimeout(100); assert.ok(await viewport.evaluate(element => element.scrollTop) > 0);
      const last = await menu.getByRole('menuitemradio').last().innerText(); await menu.getByRole('menuitemradio').first().focus(); await page.keyboard.press('End');
      assert.equal(await menu.getByRole('menuitemradio').last().evaluate(element => element === document.activeElement), true); assert.ok(await viewport.evaluate(element => element.scrollTop) > 900);
      await page.screenshot({ path: resolve(`artifacts/conversation-switcher-${theme}.png`) });
      await page.keyboard.press('Enter'); await menu.waitFor({ state: 'hidden' }); await page.getByRole('button', { name: `Switch conversation: ${last}`, exact: true }).waitFor();
    }
    assert.deepEqual(errors, []); console.log('Conversation switcher passed: ShadCN vertical scrollbar, mouse wheel and keyboard scrolling, long-title containment, conversation selection, light/dark themes.');
  } finally { if (desktop) await desktop.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
