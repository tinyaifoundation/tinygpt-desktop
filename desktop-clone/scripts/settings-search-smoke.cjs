const { _electron } = require('playwright');
const { build } = require('esbuild');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync } = require('node:fs');
const assert = require('node:assert/strict');
async function main() {
  mkdirSync(resolve('artifacts'), { recursive: true }); mkdirSync(resolve('.tools-smoke-profile'), { recursive: true });
  const profile = mkdtempSync(resolve('.tools-smoke-profile/settings-search-'));
  const main = resolve('artifacts/settings-search-main.cjs');
  await build({ entryPoints: ['scripts/settings-search-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', '../out/main/index.js'] });
  const env = { ...process.env, TINYGPT_VOICE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let app; const errors = [];
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', main], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByText('Settings search fixture is ready.', { exact: true }).waitFor();
    const settings = () => page.evaluate(async () => (await window.tinygpt.snapshot()).value.settings);
    const initial = await settings();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    const search = page.getByRole('textbox', { name: 'Search settings', exact: true });
    const jump = async (query, title, section, target) => {
      await search.fill(query);
      await nav.getByRole('button', { name: `${title} in ${section}`, exact: true }).click();
      assert.equal((await page.locator('.settings-nav-item[aria-current="page"]').textContent()).trim(), section);
      if (target) await page.locator(`${target}[data-settings-search-match="true"]`).waitFor();
    };
    await jump('noise suppression', 'Reduce background noise', 'Voice', '[data-setting-title="Reduce background noise"]');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Transcription noise suppression');
    await jump('unread dots', 'Unread dots', 'Notifications', '[data-setting-title="Unread dots"]');
    await jump('quiet from', 'Quiet from', 'Notifications', '[data-setting-title="Use quiet hours"]');
    assert.equal((await settings()).notifications.quietHours.enabled, initial.notifications.quietHours.enabled, 'Finding a dependent control never enables its feature');
    await jump('system sleep', 'Keep this computer awake', 'Remote Control', '[data-setting-title="Keep this computer awake"]');
    await jump('first name', 'First name', 'Profile', '.profile-edit-field');
    await page.getByRole('textbox', { name: 'First name', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'First name');
    await jump('project indexing', 'Project folders', 'Personalization', '.settings-content-group');
    await jump('light theme ui font', 'Light theme ui font', 'Appearance', '[data-setting-title="UI font"]');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Light theme uiFont');
    await jump('ad blocker', 'TinyGPT AdBlock', 'Browser', '.settings-row');
    await search.fill('default search engine'); await search.press('Enter');
    await page.locator('[data-setting-title="Default search engine"][data-settings-search-match="true"]').waitFor();
    await search.fill('work effort'); await search.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('settings-search-result')), true);
    await page.keyboard.press('Enter'); await page.locator('[data-setting-title="Work effort"][data-settings-search-match="true"]').waitFor();
    await jump('vram', 'Graphics memory', 'Configuration', '.device-metric');
    await page.screenshot({ path: resolve('artifacts/settings-search-graphics.png') });
    await jump('data collection', 'Allow data collection', 'Configuration');
    await page.getByRole('dialog').getByRole('heading', { name: 'OpenRouter', exact: true }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await jump('mcp', 'MCP servers', 'Plugins');
    assert.equal(await page.getByRole('tab', { name: 'MCP', exact: true }).getAttribute('aria-selected'), 'true');
    await search.fill('there-is-no-such-setting-987'); await nav.getByText('No settings found', { exact: true }).waitFor();
    await search.press('Escape'); assert.equal(await nav.locator('.settings-nav-item').count(), 15);
    assert.deepEqual(await settings(), initial, 'Finding settings must not alter preferences');
    await nav.getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await search.fill('font'); await page.screenshot({ path: resolve('artifacts/settings-search-dark.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 760));
    await jump('noise suppression', 'Reduce background noise', 'Voice', '[data-setting-title="Reduce background noise"]');
    assert.equal(await page.locator('.settings-sidebar').evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    await page.screenshot({ path: resolve('artifacts/settings-search-narrow.png') });
    assert.deepEqual(errors, []);
    console.log('Settings search passed: names, descriptions and synonyms across unvisited sections; result navigation, focus and highlighting; conditional settings stay unchanged; profile editor and management dialogs; MCP tab; Enter/Arrow Down/Escape; clear/no results; dark/narrow layouts.');
  } catch (error) { if (app) await (await app.firstWindow()).screenshot({ path: resolve('artifacts/settings-search-failure.png') }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
