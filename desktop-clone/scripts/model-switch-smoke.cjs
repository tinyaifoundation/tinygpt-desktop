const { _electron } = require('playwright');
const { resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const assert = require('node:assert/strict');

(async () => {
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', 'model-switch-' + Date.now()) }; env.TINYGPT_VOICE_PROFILE = env.TINYGPT_TOOLS_PROFILE; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: require('electron'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
  const page = await app.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
  const wait = async (check, message) => { for (let i = 0; i < 100; i++) { if (await check()) return; await page.waitForTimeout(100); } throw Error(message); };
  try {
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    const original = (await page.evaluate(() => window.tinygpt.snapshot())).value;
    await app.evaluate(({ ipcMain }, original) => {
      const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
      const models = ['tinygpt-included', 'tinygpt-pro'];
      const connections = ids.map((id, index) => ({ id, route: 'local', name: index ? 'TinyGPT Pro' : 'TinyGPT', connected: true, config: { ...original.settings.local, model: models[index], tools: true, modelCapabilities: undefined } }));
      const fixture = global.modelSwitchFixture = { snapshot: { ...original, settings: { ...original.settings, route: 'local', local: connections[0].config }, inferenceConnections: connections, activeConnectionId: ids[0] }, phase: 'idle', target: undefined, resolve: undefined, calls: 0 };
      const handle = (name, handler) => { ipcMain.removeHandler(name); ipcMain.handle(name, handler); };
      handle('tinygpt:snapshot', () => ({ ok: true, value: fixture.snapshot }));
      handle('tinygpt:inference-models', (_event, id) => ({ ok: true, value: { models: [connections.find(c => c.id === id).config.model], modelDetails: [{ id: connections.find(c => c.id === id).config.model }] } }));
      handle('tinygpt:built-in-status', () => ({ ok: true, value: { included: { phase: fixture.target === ids[0] ? fixture.phase : 'running', message: '' }, pro: { phase: fixture.target === ids[1] ? fixture.phase : 'idle', message: '' } } }));
      handle('tinygpt:inference-model', (_event, input) => { fixture.calls++; fixture.target = input.id; fixture.phase = 'idle'; return new Promise(resolve => { fixture.resolve = success => { if (success) fixture.snapshot = { ...fixture.snapshot, activeConnectionId: input.id, settings: { ...fixture.snapshot.settings, local: connections.find(c => c.id === input.id).config } }; resolve(success ? { ok: true, value: fixture.snapshot } : { ok: false, error: 'Model could not load.' }); }; }); });
    }, original);
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    const openPicker = async () => {
      if (!await page.getByRole('button', { name: /^Choose model:/ }).isVisible().catch(() => false)) await page.getByRole('button', { name: /^Level of effort:/ }).click();
      await page.getByRole('button', { name: /^Choose model:/ }).click();
      await page.getByRole('listbox', { name: 'Available models' }).waitFor();
    };
    const phase = value => app.evaluate((_electron, value) => { global.modelSwitchFixture.phase = value; }, value);
    const finish = success => app.evaluate((_electron, success) => global.modelSwitchFixture.resolve(success), success);
    await openPicker(); await page.getByRole('option', { name: 'TinyGPT Pro', exact: true }).click();
    const loading = page.locator('.composer-model-option[data-switching="true"]');
    await wait(async () => await loading.count() === 1, 'Pending selection must show a spinner');
    assert.equal(await loading.locator('.animate-spin').count(), 1); assert.equal(await loading.getAttribute('aria-busy'), 'true');
    await phase('verifying'); await wait(async () => (await loading.innerText()).includes('Checking files'), 'Checking files status');
    await phase('starting'); await wait(async () => (await loading.innerText()).includes('Loading model'), 'Loading model status');
    mkdirSync('artifacts', { recursive: true }); await page.screenshot({ path: 'artifacts/model-switch-progress.png' });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    assert.equal(await page.locator('.effort-trigger .animate-spin').count(), 1);
    await openPicker(); assert.equal(await loading.locator('.animate-spin').count(), 1);
    await finish(true); await wait(async () => !await page.getByRole('listbox', { name: 'Available models' }).isVisible(), 'Success closes the model picker');
    await openPicker(); const selected = page.getByRole('option', { name: 'TinyGPT Pro', exact: true }); assert.equal(await selected.getAttribute('aria-selected'), 'true'); assert.equal(await selected.locator('.animate-spin').count(), 0); assert.equal(await selected.locator(':scope > svg').count(), 1);
    await page.getByRole('option', { name: 'TinyGPT', exact: true }).click(); await wait(async () => await loading.count() === 1, 'Reverse switch spinner');
    await finish(false); await wait(async () => await page.getByRole('alert').filter({ hasText: 'Couldn’t switch' }).count() === 1, 'Failed switch must allow retry');
    assert.equal(await page.locator('.composer-model-option .animate-spin').count(), 0);
    await page.locator('.composer-model-option').filter({ hasText: 'Couldn’t switch' }).click();
    await wait(async () => await loading.count() === 1, 'Retry spinner'); await finish(true);
    await wait(async () => !await page.getByRole('listbox', { name: 'Available models' }).isVisible(), 'Retry succeeds');
    assert.equal(await app.evaluate(() => global.modelSwitchFixture.calls), 3); assert.deepEqual(errors, []);
    console.log('PASS: model-row spinner, live stages, dismissed-menu progress, ready selection, failure cleanup and retry.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
