const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const main = resolve('artifacts/conversation-ui-smoke-main.cjs');
  await build({ entryPoints: ['scripts/conversation-ui-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron', '../out/main/index.js'] });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `conversation-ui-${Date.now()}`) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [main], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const step = name => app.evaluate((_electron, name) => globalThis.conversationUIFixture[name](), name);
  try {
    await page.getByText('Earlier answer.', { exact: true }).waitFor();
    // Keep layout/animation frames active without displaying the fixture over
    // the user's desktop. A hidden Electron window throttles scroll observers.
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.locator('.tool-chain > summary').click();
    await step('begin');
    const latest = page.locator('.tool-chain').last();
    await latest.locator('summary').first().click();
    const summary = latest.locator('[data-slot="work-summary"]');
    const layout = await summary.evaluate(node => ({ height: node.offsetHeight, lineHeight: parseFloat(getComputedStyle(node).lineHeight), overflow: node.scrollWidth > node.clientWidth, duration: getComputedStyle(node.querySelector('.shimmer')).animationDuration }));
    assert.equal(layout.height, layout.lineHeight); assert.ok(layout.overflow); assert.equal(layout.duration, '2.2s');
    assert.ok((await latest.locator('[data-slot="work-description"]').innerText()).length > 500);
    await page.mouse.move(10, 10);
    const thinking = latest.locator('[data-slot="thinking"]');
    assert.equal(await thinking.locator('.tool-result-caret').evaluate(node => getComputedStyle(node).opacity), '0');
    const iconSizes = await latest.evaluate(node => [...node.querySelectorAll('ol > li')].map(row => row.querySelector('svg')?.getBoundingClientRect().height));
    assert.ok(iconSizes.filter(Boolean).every(size => size === 16));
    const caretSizes = await latest.locator('.tool-result-caret svg').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.ok(caretSizes.length >= 2 && caretSizes.every(size => size === 16), 'Thinking and tool carets match');
    await thinking.locator('summary').click();
    await page.screenshot({ path: resolve('artifacts/conversation-ui-working.png') });
    await step('answer');
    await page.getByText('The final answer starts here.', { exact: true }).waitFor();
    assert.equal(await page.locator('.tool-chain[open]').count(), 0, 'All tool chains close at first visible final text');
    assert.equal(await page.locator('[data-slot="thinking"][open]').count(), 0);
    assert.match(await latest.locator('[data-slot="work-summary"]').innerText(), /^Worked for /);
    assert.equal(await latest.locator('.shimmer').count(), 0, 'Completed work does not shimmer while the answer streams');
    await latest.locator('summary').first().click(); assert.ok(await latest.evaluate(node => node.open), 'Completed chains can still be reopened');
    await step('grow');
    await page.getByText(/^Paragraph 70\./).waitFor();
    const viewport = page.locator('.thread-viewport');
    await viewport.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor();
    // Wheel at the bottom of a nested panel must continue into the conversation.
    await latest.locator('.tool-chain-viewport').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const panel = await latest.locator('.tool-chain-viewport').boundingBox();
    await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height - 5); await page.mouse.wheel(0, 350);
    await page.waitForFunction(() => document.querySelector('.thread-viewport').scrollTop > 0);
    await step('finish');
    await viewport.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    await viewport.evaluate(node => { node.scrollTop -= 500; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.sidebar-chat-row').filter({ hasText: 'Other fixture' }).click();
    await page.getByText('Other fixture answer.', { exact: true }).waitFor();
    await page.locator('.sidebar-chat-row').filter({ hasText: 'Conversation UI fixture' }).click();
    await page.getByText(/^Paragraph 70\./).waitFor();
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.thread-viewport').evaluate(node => { node.scrollTop -= 500; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor();
    await page.locator('.thread-viewport').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    await page.evaluate(() => { const key = 'tinygpt-appearance-v4'; const preferences = JSON.parse(localStorage.getItem(key)); preferences.theme = 'dark'; const newValue = JSON.stringify(preferences); localStorage.setItem(key, newValue); window.dispatchEvent(new StorageEvent('storage', { key, newValue })); });
    await page.getByRole('button', { name: 'Dictate message', exact: true }).hover();
    const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: 'Dictate message' }); await tooltip.waitFor();
    const colors = await tooltip.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, arrow: getComputedStyle(node.querySelector('[data-slot="tooltip-arrow"]')).fill }));
    assert.equal(colors.background, colors.arrow, 'Dark tooltip body and arrow use the same surface');
    await page.screenshot({ path: resolve('artifacts/conversation-ui-dark.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: first-token collapse across chains, duration state, compact summaries, thinking consistency, nested wheel scrolling, latest-button round trips and chat switching, matching dark tooltip arrows.');
  } catch (error) { console.error((await page.locator('body').innerText()).slice(-1500)); await page.screenshot({ path: resolve('artifacts/conversation-ui-failure.png') }); throw error; }
  finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
