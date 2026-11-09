const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  const env = { ...process.env, TINYGPT_VOICE_PROFILE: resolve('.test-profile', `plugin-library-ui-${Date.now()}`) };
  env.TINYGPT_TOOLS_PROFILE = env.TINYGPT_VOICE_PROFILE; delete env.ELECTRON_RUN_AS_NODE;
  const desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs'), '--disable-features=CalculateNativeWinOcclusion'], env });
  try {
    const page = await desktop.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Plugins library', exact: true }).waitFor();
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false);
      const original = globalThis.fetch;
      globalThis.fetch = async (url, options) => String(url).includes('gmail.googleapis.com/gmail/v1/users/me/profile') ? new Response('{}', { status: 401 }) : String(url) === 'https://slack.com/api/auth.test' ? Response.json({ ok: true, user: 'Fixture user', team: 'TinyGPT test' }) : original(url, options);
    });
    await page.evaluate(async () => {
      const bridge = window.tinygpt;
      for (const kind of ['gmail', 'slack', 'github']) {
        const installed = await bridge.installConnector(kind); if (!installed.ok) throw Error(installed.error);
        const entry = installed.value.entries.find(entry => entry.manifest.connector === kind);
        if (kind === 'github') { const saved = await bridge.savePlugin({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: false } }); if (!saved.ok) throw Error(saved.error); }
        else { await bridge.pluginCredentials(entry.id, { bearer: 'isolated-fixture-token' }); await bridge.connectPlugin(entry.id); }
      }
    });
    await page.getByRole('button', { name: 'Plugins library', exact: true }).click();
    await page.getByRole('heading', { name: 'Needs attention', exact: true }).waitFor();
    const headings = await page.locator('h2').allTextContents(); assert.ok(headings.indexOf('Needs attention') < headings.indexOf('Popular'));
    assert.equal(await page.getByRole('heading', { name: 'Your library', exact: true }).count(), 0);
    assert.equal(await page.locator('.plugin-connection-status').count(), 0);
    for (const name of ['Gmail', 'GitHub', 'Slack']) assert.equal(await page.getByRole('button', { name: `Options for ${name}`, exact: true }).count(), 1);
    for (const name of ['Google Drive', 'Google Calendar', 'Notion', 'Higgsfield', 'Linear']) assert.equal(await page.getByRole('button', { name: `Add ${name}`, exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Options for Slack', exact: true }).click(); await page.getByRole('menuitem', { name: 'Disconnect', exact: true }).waitFor(); await page.keyboard.press('Escape');
    await mkdir('artifacts/plugin-library-update', { recursive: true });
    await page.locator('h1').click(); await page.screenshot({ path: 'artifacts/plugin-library-update/public.png' });
    await page.getByRole('tab', { name: 'Installed', exact: true }).click(); await page.getByRole('button', { name: 'Options for Gmail', exact: true }).waitFor(); assert.equal(await page.locator('.plugin-connection-status').count(), 0);
    await page.screenshot({ path: 'artifacts/plugin-library-update/installed.png' });
    await page.getByRole('tab', { name: 'Public', exact: true }).click();
    await page.getByRole('button', { name: 'Add Google Drive', exact: true }).click();
    const dialog = page.getByRole('dialog'); assert.equal(await dialog.getByText('Advanced setup', {exact:true}).count(),0); assert.equal(await dialog.getByText('Use an access token instead', {exact:true}).count(),0); await dialog.getByRole('heading', { name: 'Connect Google Drive', exact: true }).waitFor();
    await dialog.locator('.connector-connect-splash').evaluate(img => img.decode());
    for (const viewport of [{ width: 1080, height: 820 }, { width: 1080, height: 600 }, { width: 390, height: 650 }]) {
      await page.setViewportSize(viewport);
      const samples = await dialog.locator('[data-slot=scroll-area-viewport]').evaluate(async element => { const widths = []; for (let i = 0; i < 60; i++) { await new Promise(requestAnimationFrame); widths.push(element.clientWidth); } return { widths, gutter: getComputedStyle(element).scrollbarGutter, overflow: element.scrollWidth > element.clientWidth }; });
      assert.equal(Math.max(...samples.widths) - Math.min(...samples.widths), 0, 'Modal content width must not oscillate'); assert.equal(await dialog.locator('[data-slot=scroll-area]').count(), 1); assert.equal(samples.overflow, false);
    }
    await page.screenshot({ path: 'artifacts/plugin-library-update/modal-narrow.png' });
    await page.setViewportSize({ width: 1080, height: 820 }); await page.screenshot({ path: 'artifacts/plugin-library-update/modal.png' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    for (const name of ['Higgsfield', 'Linear']) {
      await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
      await dialog.getByRole('heading', { name: `Connect ${name}`, exact: true }).waitFor();
      await dialog.locator('.connector-connect-splash').evaluate(img => img.decode());
      assert.equal(await dialog.getByRole('button', { name: `Sign in with ${name}`, exact: true }).isEnabled(), true);
      assert.equal(await dialog.getByText('Advanced setup', {exact:true}).count(), 0);
      assert.equal(await dialog.getByText('Use an access token instead', {exact:true}).count(), 0);
      await page.screenshot({ path: `artifacts/plugin-library-update/${name.toLowerCase()}-modal.png` });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ checks: ['attention section precedes Popular', 'plus for new plugins and menus for installed plugins', 'no card statuses or Your library duplication', 'connected menu and Installed tab', 'stable modal width across 60 frames at three window sizes', 'no horizontal modal overflow'], errors }));
  } finally { await desktop.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
