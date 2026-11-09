// Run with a supported Node and Playwright. The Codex bundled Playwright path
// can be supplied through TINYGPT_PLAYWRIGHT_PACKAGE without adding it to runtime dependencies.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { mkdir, readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let app;
  const server = createServer((request, response) => {
    if (request.url !== '/v1/models') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'smoke-local-model' }] }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  try {
    app = await _electron.launch({
      executablePath: resolve('node_modules/electron/dist/electron.exe'),
      args: [resolve('scripts/smoke-main.cjs')], env: environment,
      timeout: 30000,
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await page.getByRole('heading', { name: 'Work with your assistant inside a project.' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('#approval-execute').selectOption('allow');
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByText('Settings saved.', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Configuration', exact: true }).click();
    await page.getByRole('button', { name: 'Local model', exact: true }).click();
    await page.locator('#endpoint').fill(`http://127.0.0.1:${port}/v1`);
    await page.locator('#model').fill('smoke-local-model');
    await page.locator('#api-key').fill('test-only-smoke-key');
    await page.getByRole('button', { name: 'Save & check connection', exact: true }).click();
    await page.getByText('Connected. Your selected model is available.', { exact: false }).waitFor();
    const snapshot = await page.evaluate(() => window.tinygpt.snapshot());
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.settings.mode, 'code');
    assert.equal(snapshot.value.settings.toolPermissions.execute, 'allow');
    assert.equal(snapshot.value.secrets.local, true);
    assert.equal(JSON.stringify(snapshot).includes('test-only-smoke-key'), false);
    assert.equal((await readFile(resolve('.smoke-profile/credentials.json'), 'utf8')).includes('test-only-smoke-key'), false);
    const invalid = await page.evaluate(async () => {
      const current = await window.tinygpt.snapshot();
      return window.tinygpt.saveSettings({ ...current.value.settings, apiKey: 'invalid-extra-key' });
    });
    assert.equal(invalid.ok, false);
    await mkdir(resolve('artifacts'), { recursive: true });
    await page.screenshot({ path: resolve('artifacts/settings.png') });
    await page.getByRole('button', { name: 'TinyGPT Portal', exact: true }).click();
    await page.getByText('No account or sign-in required.', { exact: false }).waitFor();
    assert.equal(await page.locator('#model').count(), 0);
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.screenshot({ path: resolve('artifacts/desktop-foundation.png') });
    assert.deepEqual(errors, []);
    console.log('Desktop smoke passed: mode navigation, disabled composer, validated IPC, local model discovery, encrypted credentials, approval persistence, and account-free Portal setup.');
  } finally {
    if (app) await app.close();
    await new Promise(done => server.close(done));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
