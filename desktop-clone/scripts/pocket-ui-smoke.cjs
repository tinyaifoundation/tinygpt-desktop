const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(done => setTimeout(done, ms));
(async () => {
  let app, page; const errors = [];
  await mkdir(resolve('artifacts'), { recursive: true });
  try {
    const env = { ...process.env, TINYGPT_VOICE_PROFILE: resolve('.test-profile/pocket-ui-' + Date.now()) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/pocket-ui-smoke-main.cjs')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Voice', exact: true }).click();
    await page.getByRole('button', { name: 'Read aloud voice', exact: true }).waitFor();
    assert.match(await page.getByRole('button', { name: 'Read aloud speech model', exact: true }).innerText(), /Text-to-speech/);
    await page.getByRole('button', { name: 'Preview voice', exact: true }).click(); await page.getByRole('button', { name: 'Stop preview', exact: true }).waitFor(); await delay(350); await page.getByRole('button', { name: 'Stop preview', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Create a voice', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Delete voice', exact: true }).count(), 0);
    assert.equal(await page.getByRole('dialog', { name: 'Create your voice', exact: true }).count(), 0);
    await page.screenshot({ path: resolve('artifacts/pocket-read-aloud.png') });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ result: 'passed', checks: ['Pocket TTS default', 'real streaming preview and Stop', 'voice-cloning controls removed'], errors }));
  } catch (error) { if (page) { await page.screenshot({ path: resolve('artifacts/pocket-ui-failure.png') }).catch(() => {}); console.log((await page.locator('body').innerText()).slice(-3000)); } throw error; }
  finally { if (app) await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
