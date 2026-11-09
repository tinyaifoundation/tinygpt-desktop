const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `search-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  let app; const errors = [];
  try {
    await mkdir('artifacts', { recursive: true });
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.showInactive(); } });
    await page.getByRole('button', { name: 'Search chats', exact: true }).waitFor();
    const titles = ['Add live dictation to composers', 'Add agent browser activity preview', 'Show browser use preview', 'Clean up UI inconsistencies', 'Add seamless model connection setup', 'Review OpenClaw integration plan', 'Plan TinyGPT desktop MVP', 'Handle output length limits', 'Core context management'];
    await page.evaluate(async titles => {
      const project = await window.tinygpt.createProject('tinygpt-desktop-v4', '', false);
      if (!project.ok) throw new Error(project.error);
      const archived = await window.tinygpt.createConversation(project.value.id); if (!archived.ok) throw new Error(archived.error);
      await window.tinygpt.renameConversation(archived.value.id, 'Archived search fixture');
      const hidden = await window.tinygpt.organizeConversation({ id: archived.value.id, action: 'archive', value: true }); if (!hidden.ok) throw new Error(hidden.error);
      for (const title of [...titles].reverse()) { const chat = await window.tinygpt.createConversation(project.value.id); if (!chat.ok) throw new Error(chat.error); const saved = await window.tinygpt.renameConversation(chat.value.id, title); if (!saved.ok) throw new Error(saved.error); }
    }, titles);
    await page.reload(); await page.getByRole('button', { name: 'Search chats', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.sidebar-header-actions button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))), ['View activity', 'Search chats']);
    await page.getByRole('button', { name: 'Search chats', exact: true }).click();
    const input = () => page.getByRole('combobox', { name: 'Search saved chats' });
    const options = () => page.locator('.search-dialog-results [role=option]');
    await input().waitFor(); assert.equal(await options().count(), 9);
    const opening = await page.locator('.search-chats-dialog').boundingBox();
    assert.ok(!(await options().allTextContents()).some(text => text.includes('Archived search fixture')));
    await input().fill('Archived search fixture'); await page.getByText('No matching chats', { exact: true }).waitFor(); assert.equal(await options().count(), 0);
    const filtered = await page.locator('.search-chats-dialog').boundingBox(); assert.ok(Math.abs(filtered.y - opening.y) < 1); assert.ok(filtered.height < opening.height);
    await input().fill(''); assert.ok(Math.abs((await page.locator('.search-chats-dialog').boundingBox()).y - opening.y) < 1);
    assert.equal(await input().getAttribute('aria-activedescendant'), await options().first().getAttribute('id'));
    await page.screenshot({ path: resolve('artifacts/search-chats-light.png') });
    await input().press('ArrowDown'); assert.equal(await options().nth(1).getAttribute('aria-selected'), 'true');
    const target = await options().nth(1).locator('strong').innerText(); await input().press('Enter');
    await page.getByRole('dialog', { name: 'Search chats' }).waitFor({ state: 'hidden' });
    await page.waitForFunction(async title => { const library = (await window.tinygpt.library()).value; return library.conversations.find(chat => chat.id === library.lastConversationId)?.title === title; }, target);
    await page.keyboard.press('Control+k'); await input().fill('context'); assert.equal(await options().count(), 1); assert.equal(await options().first().locator('strong').innerText(), 'Core context management');
    await input().fill('no such chat'); await page.getByText('No matching chats', { exact: true }).waitFor(); await input().press('Enter'); assert.equal(await page.getByRole('dialog').count(), 1);
    await input().fill(''); const altTarget = await options().nth(2).locator('strong').innerText(); await input().press('Alt+3');
    await page.waitForFunction(async title => { const library = (await window.tinygpt.library()).value; return library.conversations.find(chat => chat.id === library.lastConversationId)?.title === title; }, altTarget);
    await page.keyboard.press('Control+k'); await input().fill('settings'); await input().press('Enter');
    await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await page.evaluate(() => { const key = 'tinygpt-appearance-v4'; const appearance = JSON.parse(localStorage.getItem(key)); appearance.theme = 'dark'; localStorage.setItem(key, JSON.stringify(appearance)); });
    await page.reload(); await page.getByRole('button', { name: 'Search chats', exact: true }).click();
    await input().waitFor(); await page.screenshot({ path: resolve('artifacts/search-chats-dark.png') });
    await input().fill('New Project'); await input().press('Enter'); await page.getByRole('dialog', { name: 'Create project', exact: true }).waitFor(); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.keyboard.press('Control+k'); await input().press('Control+j'); await page.getByRole('dialog').waitFor({ state: 'hidden' }); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(360, 480); window.setSize(440, 620); });
    await page.keyboard.press('Control+k'); await input().waitFor(); await page.screenshot({ path: resolve('artifacts/search-chats-narrow.png') });
    assert.equal(await page.locator('.search-chats-dialog').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await input().press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('Search smoke passed: sidebar order, recent rows, filtering, arrows/Enter, Alt shortcuts, quick actions, Escape, light/dark and narrow layout.');
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
