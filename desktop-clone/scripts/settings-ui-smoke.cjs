const { _electron } = require('playwright');
const { build } = require('esbuild');
const { resolve, join } = require('node:path');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');

async function main() {
  mkdirSync(resolve('artifacts'), { recursive: true });
  mkdirSync(resolve('.tools-smoke-profile'), { recursive: true });
  const profile = mkdtempSync(resolve('.tools-smoke-profile/settings-'));
  const main = resolve('artifacts/settings-ui-main.cjs');
  await build({ entryPoints: ['scripts/settings-ui-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', '../out/main/index.js'] });
  const env = { ...process.env, TINYGPT_VOICE_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let app;
  const errors = [];
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', main], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    const value = async method => { const result = await page.evaluate(method => window.tinygpt[method](), method); assert.ok(result.ok, result.error); return result.value; };
    const wait = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(done => setTimeout(done, 50)); } throw Error('Settings did not update'); };
    const settings = async () => (await value('snapshot')).settings;
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    const section = name => nav.getByRole('button', { name, exact: true }).click();
    const choose = async (name, option) => { await page.getByRole('button', { name, exact: true }).click(); await page.getByRole('menuitemradio', { name: option, exact: true }).click(); };
    assert.equal(await nav.getByRole('button', { name: 'Bot', exact: true }).count(), 0);
    assert.equal(await nav.getByRole('button', { name: 'Image/Video', exact: true }).count(), 0);
    assert.equal(await nav.getByRole('button', { name: 'Notifications', exact: true }).locator('.solar-bell-linear').count(), 1);
    assert.equal(await nav.getByRole('button', { name: 'Work settings', exact: true }).locator('.solar-programming-linear').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Save settings', exact: true }).count(), 0);
    await choose('Change files', 'Never allow'); await wait(async () => (await settings()).toolPermissions.write === 'deny');
    await choose('Run commands', 'Allow automatically'); await wait(async () => (await settings()).toolPermissions.execute === 'allow');
    await page.screenshot({ path: resolve('artifacts/settings-general-light.png') });
    await section('Work settings');
    assert.equal(await page.getByRole('button', { name: 'Change files', exact: true }).innerText(), 'Never allow');
    await choose('Work effort', 'High'); await wait(async () => (await settings()).effort.code === 'high');
    await choose('Work diff markers', 'Symbols');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tinygpt-appearance-v4')).diffMarkers), 'symbols');
    await page.screenshot({ path: resolve('artifacts/settings-work-light.png') });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('tinygpt:built-in-hardware');
      ipcMain.handle('tinygpt:built-in-hardware', () => ({ ok: true, value: { includedSupported: true, proCompatible: true, checkedAt: new Date().toISOString(), status: 'compatible', message: 'Fixture device' } }));
      ipcMain.removeHandler('tinygpt:built-in-status');
      ipcMain.handle('tinygpt:built-in-status', () => ({ ok: true, value: { included: { phase: 'idle', message: 'Fixture', installed: false, ready: false }, pro: { phase: 'idle', message: 'Fixture', installed: false, ready: false } } }));
    });
    await section('Configuration');
    await page.getByRole('button', { name: 'Configure TinyGPT Pro', exact: true }).waitFor();
    assert.equal(await page.locator('.configuration-card').count(), 4);
    assert.equal(await page.locator('.built-in-card').count(), 0);
    for (const [name, icon] of [['TinyGPT', 'tinygpt-ios-default'], ['TinyGPT Pro', 'tinygpt-dark']]) {
      const card = page.getByRole('button', { name: 'Configure ' + name, exact: true });
      assert.ok((await card.locator('img').getAttribute('src')).includes(icon));
      assert.equal(await card.locator('.solar-add-linear').count(), 1);
      await card.click();
      assert.ok((await page.getByRole('dialog').locator('.connector-detail-logo img').getAttribute('src')).includes(icon));
      await page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
    }
    await page.screenshot({ path: resolve('artifacts/settings-configuration-light.png') });
    await section('Profile'); await page.getByText('Most used tools', { exact: true }).waitFor();
    for (const name of ['Calculator', 'Search files', 'Read desktop windows']) await page.locator('.usage-tools').getByText(name, { exact: true }).waitFor();
    assert.equal(await page.locator('.usage-tool-label svg').count(), 3);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Profile username', exact: true }).count(), 0);
    await page.getByRole('textbox', { name: 'First name', exact: true }).fill('Ada');
    await page.getByRole('textbox', { name: 'Last name', exact: true }).fill('Lovelace');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('heading', { name: 'Ada Lovelace', exact: true }).waitFor();
    assert.equal((await value('memorySnapshot')).memories.filter(item => item.title === 'Your name').length, 1);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Last name', exact: true }).fill('Byron');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('heading', { name: 'Ada Byron', exact: true }).waitFor();
    const memories = (await value('memorySnapshot')).memories;
    assert.equal(memories.length, 1); assert.equal(memories[0].text, "The user's name is Ada Byron.");
    await page.screenshot({ path: resolve('artifacts/settings-profile-light.png') });
    await section('Archived chats'); await page.getByRole('heading', { name: 'No archived chats', exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/settings-archived-light.png') });
    await section('Appearance'); await page.getByRole('button', { name: 'Dark', exact: true }).click();
    for (const name of ['Configuration', 'General', 'Work settings', 'Profile', 'Archived chats']) {
      await section(name); await page.screenshot({ path: resolve('artifacts/settings-' + name.toLowerCase().replaceAll(' ', '-') + '-dark.png') });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 720));
    for (const name of ['General', 'Configuration', 'Profile', 'Archived chats']) {
      await section(name);
      const overflow = await page.locator('.settings-content-inner').evaluate(element => element.scrollWidth > element.clientWidth + 1);
      assert.equal(overflow, false, name + ' should fit a narrow window');
      await page.screenshot({ path: resolve('artifacts/settings-' + name.toLowerCase().replaceAll(' ', '-') + '-narrow.png') });
    }
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await section('Profile');
    await page.getByRole('heading', { name: 'Ada Byron', exact: true }).waitFor();
    assert.equal((await settings()).effort.code, 'high');
    assert.equal((await settings()).toolPermissions.write, 'deny');
    assert.equal((await value('memorySnapshot')).memories.length, 1);
    const folder = join(profile, 'project'); mkdirSync(folder);
    writeFileSync(join(folder, 'release.md'), '# Production releases\nTwo maintainers must authorize production deployment. A release is approved only after both maintainers sign off.');
    writeFileSync(join(folder, '.env'), 'PRIVATE_INDEXING_FIXTURE');
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
    const projectId = await page.evaluate(async () => {
      const folder = await window.tinygpt.chooseNewProjectFolder(); if (!folder.ok) throw Error(folder.error);
      const project = await window.tinygpt.createProject('Retrieval fixture', '', false, folder.value.id); if (!project.ok) throw Error(project.error);
      const indexed = await window.tinygpt.projectIndex(project.value.id, 'enable'); if (!indexed.ok) throw Error(indexed.error);
      return project.value.id;
    });
    await wait(async () => { const data = await value('memorySnapshot'); return data.semantic.status === 'ready' && data.semantic.pending === 0; });
    const indexed = await value('memorySnapshot');
    assert.deepEqual(indexed.documents.map(document => document.title), ['release.md']);
    const hits = await page.evaluate(id => window.tinygpt.previewMemory(id, 'Who needs to sign off before we ship?'), projectId);
    assert.ok(hits.ok, hits.error); assert.equal(hits.value[0]?.title, 'release.md');
    const paused = await page.evaluate(id => window.tinygpt.projectIndex(id, 'disable'), projectId); assert.ok(paused.ok, paused.error);
    const afterPause = await page.evaluate(id => window.tinygpt.previewMemory(id, 'Who needs to sign off before we ship?'), projectId);
    assert.ok(afterPause.ok); assert.ok(afterPause.value.every(hit => hit.title !== 'release.md'));
    assert.deepEqual(errors, []);
    console.log('Settings UI passed: removed tabs, Solar icons, automatic approvals, real Work preferences, compact model rows and branded dialogs, readable tool usage, name-memory create/rename, archive empty state, persistence, light/dark/narrow layouts, real bundled semantic indexing and paraphrase retrieval, secret-file exclusion and pause.');
  } catch (error) {
    if (app) await (await app.firstWindow()).screenshot({ path: resolve('artifacts/settings-ui-failure.png') }).catch(() => {});
    throw error;
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
