const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const main = resolve('artifacts/working-chain-smoke-main.cjs');
  await build({ entryPoints: ['scripts/working-chain-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron', '../out/main/index.js'] });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `working-chain-${Date.now()}`) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [main], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on('pageerror', e => errors.push(e.message));
  const step = (name, arg) => app.evaluate((_electron, { name, arg }) => globalThis.workingChainFixture[name](arg), { name, arg });
  try {
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { w.setIgnoreMouseEvents(true); w.setPosition(-10000, -10000); w.webContents.setBackgroundThrottling(false); w.showInactive(); } });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    for (const mode of ['chat', 'code']) {
      const title = mode === 'code' ? 'Work chain fixture' : 'Chat chain fixture';
      await page.locator('.sidebar-chat-row').filter({ hasText: title }).evaluate(e => e.click());
      const assistantId = await step('begin', mode); const message = page.locator(`[data-message-id="${assistantId}"]`);
      const chain = message.locator('.tool-chain'); await chain.waitFor();
      assert.equal(await chain.count(), 1); assert.equal(await chain.locator('summary').first().innerText(), 'Working…');
      assert.equal(await message.locator('p[data-slot="work-status"]').count(), 0);
      assert.equal(await chain.locator('.tool-chain-scroll').count(), 0, 'An empty placeholder has no blank details panel.');
      await chain.evaluate(e => { e.fixtureIdentity = 'original-working-chain'; });
      await step('thinking'); await chain.locator('[data-slot="thinking"]').waitFor({ state: 'attached' });
      assert.equal(await chain.evaluate(e => e.fixtureIdentity), 'original-working-chain', 'Thinking joins the existing chain.');
      assert.equal(await message.locator(':scope > [data-slot="thinking"]').count(), 0);
      await chain.locator('summary').first().click();
      await chain.locator('[data-slot="thinking"] > summary').click();
      await page.screenshot({ path: resolve(`artifacts/working-chain-${mode}-thinking.png`) });
      await step('tool'); await chain.locator('[data-tool-name="search_sources"]').waitFor({ state: 'attached' });
      assert.equal(await chain.count(), 1); assert.equal(await chain.evaluate(e => e.fixtureIdentity), 'original-working-chain');
      await step('answer'); await message.getByText('The answer begins here.', { exact: true }).waitFor();
      assert.equal(await chain.evaluate(e => e.open), false);
      assert.match(await chain.locator('[data-slot="work-summary"]').innerText(), /^Worked for /);
      assert.equal(await chain.locator('.shimmer').count(), 0);
      await step('finish');
      const directId = await step('begin', mode); const direct = page.locator(`[data-message-id="${directId}"]`);
      await direct.locator('.tool-chain').waitFor(); await step('answer');
      await direct.getByText('The answer begins here.', { exact: true }).waitFor();
      assert.equal(await direct.locator('.tool-chain').count(), 0, 'A direct answer removes the empty chain.');
      await step('finish'); await page.reload(); await direct.waitFor();
      assert.equal(await direct.locator('.tool-chain').count(), 0, 'No phantom work summary after reopening.');
      await message.locator('.tool-chain [data-slot="thinking"]').waitFor({ state: 'attached' });
    }
    assert.deepEqual(errors, []);
    console.log('Passed in Chat and Work: initial chain header, nested thinking, stable chain through tool steps, answer collapse, direct-answer placeholder removal, and reload persistence.');
  } catch (e) { await page.screenshot({ path: resolve('artifacts/working-chain-failure.png') }).catch(() => {}); throw e; }
  finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
