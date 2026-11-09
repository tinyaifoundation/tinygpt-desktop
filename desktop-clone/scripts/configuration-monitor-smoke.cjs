const { _electron } = require('playwright');
const { build } = require('esbuild');
const { resolve } = require('node:path');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
async function main() {
  mkdirSync(resolve('artifacts'), { recursive: true }); mkdirSync(resolve('.tools-smoke-profile'), { recursive: true });
  const profile = mkdtempSync(resolve('.tools-smoke-profile/configuration-monitor-'));
  const main = resolve('artifacts/configuration-monitor-main.cjs');
  await build({ entryPoints: ['scripts/settings-ui-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', '../out/main/index.js'] });
  const env = { ...process.env, TINYGPT_VOICE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let app; const errors = [];
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', main], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
      window.monitorHidden = false;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.monitorHidden ? 'hidden' : 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.monitorHidden });
    });
    const before = Date.now();
    const native = await page.evaluate(() => window.tinygpt.configurationMonitor()); assert.ok(native.ok, native.error);
    assert.ok(native.value.systemMemory.totalBytes > 0);
    assert.ok(native.value.components.find(component => component.name === 'App & background services').memoryBytes > 0);
    if (native.value.graphics.some(device => device.name.includes('NVIDIA'))) {
      assert.ok(native.value.graphics[0].totalBytes > 0);
      assert.ok(native.value.graphics[0].usedBytes >= 0);
      assert.ok(native.value.graphics[0].activity >= 0);
      assert.ok(native.value.graphics[0].temperature > 0);
    }
    writeFileSync(resolve('artifacts/configuration-monitor-native.json'), JSON.stringify({ elapsedMs: Date.now() - before, sample: native.value }, null, 2));
    await app.evaluate(({ ipcMain }) => {
      global.monitorCalls = 0; global.monitorMode = 'windows'; global.monitorError = false;
      global.modelStates = { included: { phase: 'running', ready: true, installed: true, message: 'Fixture' }, pro: { phase: 'idle', ready: true, installed: true, message: 'Fixture' } };
      ipcMain.removeHandler('tinygpt:built-in-hardware'); ipcMain.handle('tinygpt:built-in-hardware', () => ({ ok: true, value: { includedSupported: true, proCompatible: true, checkedAt: new Date().toISOString(), status: 'compatible', message: 'Fixture device' } }));
      ipcMain.removeHandler('tinygpt:built-in-status'); ipcMain.handle('tinygpt:built-in-status', () => ({ ok: true, value: global.modelStates }));
      ipcMain.removeHandler('tinygpt:configuration-monitor'); ipcMain.handle('tinygpt:configuration-monitor', () => {
        global.monitorCalls++;
        if (global.monitorError) return { ok: false, error: 'Fixture unavailable' };
        const mac = global.monitorMode === 'mac'; const n = global.monitorCalls;
        return { ok: true, value: { sampledAt: Date.now(), platform: mac ? 'darwin' : 'win32', unified: mac, systemMemory: { totalBytes: 32 * 2 ** 30, usedBytes: (15 + n % 3) * 2 ** 30, pressure: mac ? 'normal' : null }, graphics: [{ id: mac ? 'unified' : 'GPU-fixture', name: mac ? 'Apple M2' : 'NVIDIA GeForce RTX 3090', totalBytes: mac ? null : 24 * 2 ** 30, usedBytes: mac ? null : (4 + n % 3) * 2 ** 30, activity: mac ? null : 20 + n % 8, temperature: mac ? null : 47 + n % 3 }], components: [
          { id: 'included', name: 'TinyGPT', state: 'Active', memoryBytes: 2 ** 30, graphicsBytes: mac ? null : 2 * 2 ** 30 },
          { id: 'pro', name: 'TinyGPT Pro', state: 'Not loaded', memoryBytes: 0, graphicsBytes: mac ? null : 0 },
          { id: 'vision', name: 'Image understanding', state: 'On demand', memoryBytes: 0, graphicsBytes: mac ? null : 0 },
          { id: 'app', name: 'App & background services', state: 'Running', memoryBytes: 600 * 2 ** 20, graphicsBytes: mac ? null : 50 * 2 ** 20 },
        ] } };
      });
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    const section = name => nav.getByRole('button', { name, exact: true }).click();
    await section('Configuration');
    const included = page.getByRole('button', { name: 'Configure TinyGPT', exact: true }), pro = page.getByRole('button', { name: 'Configure TinyGPT Pro', exact: true });
    await included.getByText('Active', { exact: true }).waitFor(); await pro.getByText('Ready', { exact: true }).waitFor();
    assert.equal(await included.locator('.solar-check-linear').count(), 1); assert.equal(await pro.locator('.solar-check-linear').count(), 1);
    await page.waitForFunction(() => [...document.querySelectorAll('.device-trend-line')].some(path => path.getAttribute('d').includes(' L')));
    await page.locator('.configuration-page').evaluate(element => element.scrollIntoView());
    await page.screenshot({ path: resolve('artifacts/configuration-monitor-light.png') });
    await page.locator('.device-components summary').click();
    await page.getByRole('columnheader', { name: 'Component', exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/configuration-monitor-breakdown.png') });
    await page.locator('.device-components summary').click();
    await app.evaluate(() => { global.modelStates.included.phase = 'idle'; global.modelStates.pro.phase = 'error'; });
    await included.getByText('Ready', { exact: true }).waitFor(); await pro.getByText('Needs attention', { exact: true }).waitFor();
    assert.equal(await pro.locator('.solar-check-linear').count(), 0);
    await app.evaluate(() => { global.modelStates.pro.phase = 'idle'; global.modelStates.pro.ready = false; });
    await pro.locator('.solar-add-linear').waitFor();
    const count = await app.evaluate(() => global.monitorCalls);
    await page.evaluate(() => { window.monitorHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await page.getByText('Paused', { exact: true }).waitFor();
    await new Promise(done => setTimeout(done, 3400)); assert.equal(await app.evaluate(() => global.monitorCalls), count);
    await page.evaluate(() => { window.monitorHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.querySelector('.device-monitor-live')?.textContent === 'Live');
    await app.evaluate(() => { global.monitorError = true; });
    await page.getByText('Reconnecting', { exact: true }).waitFor();
    await app.evaluate(() => { global.monitorError = false; });
    await page.waitForFunction(() => document.querySelector('.device-monitor-live')?.textContent === 'Live');
    await app.evaluate(() => { global.modelStates.included.phase = 'running'; global.modelStates.pro.phase = 'idle'; global.modelStates.pro.ready = true; });
    await section('Appearance'); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await section('Configuration');
    await page.waitForFunction(() => document.querySelector('.device-monitor-live')?.textContent === 'Live');
    await page.screenshot({ path: resolve('artifacts/configuration-monitor-dark.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(860, 760));
    assert.equal(await page.locator('.settings-content-inner').evaluate(element => element.scrollWidth > element.clientWidth + 1), false);
    await page.screenshot({ path: resolve('artifacts/configuration-monitor-narrow.png') });
    await app.evaluate(() => { global.monitorMode = 'mac'; });
    await page.locator('.device-metric-label').getByText('Shared memory', { exact: true }).waitFor();
    assert.equal(await page.locator('.device-metric').count(), 3);
    await page.getByText('Not reported by this device', { exact: true }).first().waitFor();
    await page.screenshot({ path: resolve('artifacts/configuration-monitor-mac-fixture.png') });
    await section('General'); const stopped = await app.evaluate(() => global.monitorCalls);
    await new Promise(done => setTimeout(done, 3400)); assert.equal(await app.evaluate(() => global.monitorCalls), stopped);
    assert.deepEqual(errors, []);
    console.log('Configuration monitor passed: native Windows telemetry, Active/Ready/incomplete/error states, real chart history, pause/resume, reconnect, no polling after leaving, light/dark/narrow layouts, Mac shared-memory/unavailable-sensor fixture.');
  } catch (error) { if (app) await (await app.firstWindow()).screenshot({ path: resolve('artifacts/configuration-monitor-failure.png') }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
