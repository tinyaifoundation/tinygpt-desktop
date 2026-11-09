const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let desktop; const errors = [];
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `projects-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New Project', exact: true }).waitFor();
    await desktop.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, resolve('.tools-smoke-profile'));
    async function library() { const result = await page.evaluate(() => window.tinygpt.library()); assert.equal(result.ok, true); return result.value; }
    async function more(name) { const row = page.locator('.sidebar-project-row').filter({ has: page.getByRole('button', { name, exact: true }) }); await row.hover(); await row.getByRole('button', { name: `More for project ${name}`, exact: true }).click(); }
    async function edit(name) { await more(name); await page.getByRole('menuitem', { name: 'Edit project', exact: true }).click(); await page.getByRole('dialog', { name: 'Edit project', exact: true }).waitFor(); }
    await page.locator('[data-sidebar-section="Projects"] .sidebar-section-heading').hover(); await page.getByRole('button', { name: 'New Project', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Create project', exact: true }); await dialog.waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Create project', exact: true }).isDisabled(), true);
    await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('Project fixture');
    await page.screenshot({ path: resolve('artifacts/project-create-light.png') });
    await dialog.getByRole('button', { name: 'Add source folder', exact: true }).click();
    await dialog.getByText('.tools-smoke-profile', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Project options', exact: true }).click(); await page.getByRole('textbox', { name: 'Project instructions', exact: true }).fill('Preserve these instructions'); await page.getByRole('checkbox', { name: 'Use a separate browser profile', exact: true }).check(); await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Create project', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    const project = (await library()).projects[0]; assert.equal(project.name, 'Project fixture'); assert.equal(project.rootPath, resolve('.tools-smoke-profile')); assert.equal(project.browserIsolated, true); assert.equal(project.instructions, 'Preserve these instructions');
    const row = page.locator('.sidebar-project-row').filter({ has: page.getByRole('button', { name: project.name, exact: true }) }); await row.hover();
    const placement = await row.evaluate(row => { const menu = row.querySelector('[aria-label^="More for project"]'), chat = row.querySelector('[aria-label^="New chat in"]'); return { menu: menu.getBoundingClientRect().right, chat: chat.getBoundingClientRect().left, cog: row.querySelectorAll('svg.lucide-settings').length }; }); assert.ok(placement.chat > placement.menu); assert.equal(placement.cog, 0);
    await more(project.name); assert.equal(await page.getByRole('menuitem').count(), 5); await page.getByRole('menuitem', { name: 'Favorite', exact: true }).click(); await page.waitForFunction(async () => (await window.tinygpt.library()).value.projects[0].favorite);
    await page.reload(); await page.getByRole('button', { name: project.name, exact: true }).waitFor(); assert.equal((await library()).projects[0].favorite, true);
    await edit(project.name); dialog = page.getByRole('dialog', { name: 'Edit project', exact: true }); await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('Canceled name'); await dialog.getByRole('button', { name: 'Remove source folder', exact: true }).click(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal((await library()).projects[0].rootPath, project.rootPath); assert.equal((await library()).projects[0].name, project.name);
    await edit(project.name); await page.screenshot({ path: resolve('artifacts/project-edit-light.png') }); await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Renamed project'); await page.getByRole('button', { name: 'Remove source folder', exact: true }).click(); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.waitForFunction(async () => (await window.tinygpt.library()).value.projects[0].name === 'Renamed project');
    let saved = (await library()).projects[0]; assert.equal(saved.rootPath, null); assert.equal(saved.instructions, project.instructions); assert.equal(saved.browserIsolated, true); assert.equal(saved.favorite, true);
    await edit('Renamed project'); await page.getByRole('button', { name: 'Add source folder', exact: true }).click(); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.waitForFunction(async () => !!(await window.tinygpt.library()).value.projects[0].rootPath);
    await more('Renamed project'); await page.getByRole('menuitem', { name: 'Open in workspace', exact: true }).click(); await page.getByRole('button', { name: 'Select workspace Project', exact: true }).waitFor();
    assert.equal((await library()).conversations[0].projectId, project.id);
    const second = await page.evaluate(id => window.tinygpt.createConversation(id), project.id); assert.equal(second.ok, true);
    const other = await page.evaluate(() => window.tinygpt.createConversation(null)); assert.equal(other.ok, true); await page.reload(); await page.getByRole('button', { name: 'Renamed project', exact: true }).waitFor();
    await more('Renamed project'); await page.getByRole('menuitem', { name: 'Archive all chats', exact: true }).click(); await page.waitForFunction(async id => (await window.tinygpt.library()).value.conversations.filter(chat => chat.projectId === id).every(chat => chat.archived), project.id);
    assert.equal((await library()).conversations.find(chat => chat.id === other.value.id).archived, false);
    await page.evaluate(() => { const key = 'tinygpt-appearance-v4'; const value = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...value, theme: 'dark' })); }); await page.reload(); await page.locator('html[data-theme=dark]').waitFor();
    await page.locator('[data-sidebar-section="Projects"] .sidebar-section-heading').hover(); await page.getByRole('button', { name: 'New Project', exact: true }).click(); await page.screenshot({ path: resolve('artifacts/project-create-dark.png') }); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await edit('Renamed project'); await page.screenshot({ path: resolve('artifacts/project-edit-dark.png') });
    assert.equal(await page.getByRole('dialog').evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
    await page.getByRole('button', { name: 'Remove local project', exact: true }).click(); await page.waitForFunction(async () => (await window.tinygpt.library()).value.projects.length === 0);
    assert.equal((await library()).conversations.length, 3); assert.ok((await library()).conversations.every(chat => chat.projectId === null));
    const extra = await page.evaluate(() => window.tinygpt.createProject('Menu removal', '')); assert.equal(extra.ok, true); await page.reload(); await page.getByRole('button', { name: 'Menu removal', exact: true }).waitFor(); await more('Menu removal'); await page.getByRole('menuitem', { name: 'Remove project', exact: true }).click(); await page.waitForFunction(async () => (await window.tinygpt.library()).value.projects.length === 0);
    assert.deepEqual(errors, []); console.log('Projects smoke passed: action order, shared modal, native folder selection, draft cancellation, saved edits, favorite persistence, scoped workspace, bulk archive, safe removal, light/dark styling.');
  } finally { if (desktop) await desktop.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
