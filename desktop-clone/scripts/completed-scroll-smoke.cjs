const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const main = resolve('artifacts/completed-scroll-smoke-main.cjs');
  await build({ entryPoints: ['scripts/completed-scroll-smoke-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', external: ['electron', '../out/main/index.js'] });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `completed-scroll-${Date.now()}`) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [main], env });
  let page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const step = name => app.evaluate((_electron, name) => globalThis.completedScrollFixture[name](), name);
  const geometry = () => page.evaluate(() => {
    const viewport = document.querySelector('.thread-viewport');
    const column = viewport.querySelector('.thread-message-column');
    const footer = viewport.querySelector('.composer-footer');
    const last = [...viewport.querySelectorAll('[data-message-id]')].at(-1);
    const measure = node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, height: node.offsetHeight, scrollHeight: node.scrollHeight, cssHeight: getComputedStyle(node).height, minHeight: getComputedStyle(node).minHeight, position: getComputedStyle(node).position });
    return { viewport: measure(viewport), scrollTop: viewport.scrollTop, column: measure(column), footer: measure(footer), last: measure(last), style: last.getAttribute('style') };
  });
  try {
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await step('begin'); await step('answer');
    await page.getByText('Here is the detailed comparison.', { exact: true }).waitFor();
    await step('grow'); await page.getByText(/^Paragraph 30\./).waitFor();
    await step('finish');
    await page.getByText('Final section of the completed comparison.', { exact: true }).waitFor();
    console.log('Finished geometry', JSON.stringify(await geometry()));
    await page.screenshot({ path: resolve('artifacts/completed-scroll-before.png') });
    const viewport = page.locator('.thread-viewport');
    await viewport.evaluate(node => { node.scrollTop = 0; });
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.wheel(0, 450);
    await page.waitForFunction(() => document.querySelector('.thread-viewport').scrollTop > 100);
    console.log('Wheel geometry', JSON.stringify(await geometry()));
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    console.log('Bottom geometry', JSON.stringify(await geometry()));
    await page.screenshot({ path: resolve('artifacts/completed-scroll-bottom.png') });
    const bottom = await geometry();
    assert.ok(bottom.last.bottom <= bottom.footer.top + 2, 'The completed answer ends above the docked composer');
    assert.ok(Math.abs(bottom.footer.bottom - bottom.viewport.bottom) <= 2, 'The composer stays docked at the bottom');
    // A final save can arrive after the completion event. The control must
    // notice the newly rendered Markdown rather than staying in a stale state.
    await step('late'); await page.getByText(/^Supplement 45\./).waitFor();
    await viewport.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    // Repeat in the same mounted viewport, with top-turn anchoring active.
    await step('begin'); await step('answer'); await step('finish');
    await page.getByText('Final section of the completed comparison.', { exact: true }).last().waitFor();
    await viewport.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    assert.ok((await geometry()).last.bottom <= (await geometry()).footer.top + 2, 'Repeated turns keep the answer before the composer');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(620, 650));
    await viewport.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    const narrow = await geometry();
    assert.ok(narrow.last.bottom <= narrow.footer.top + 2, 'Resizing preserves access to the final answer');
    await page.screenshot({ path: resolve('artifacts/completed-scroll-narrow.png') });
    const popupReady = app.waitForEvent('window');
    const popped = await page.evaluate(async () => {
      const library = (await window.tinygpt.library()).value;
      return window.tinygpt.popOutChat(library.conversations.find(chat => chat.title === 'Completed scroll fixture').id);
    });
    assert.equal(popped.ok, true);
    page = await popupReady; page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    const popoutViewport = page.locator('.thread-viewport');
    await popoutViewport.evaluate(node => { node.scrollTop = 0; });
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).click();
    await page.getByRole('button', { name: 'Scroll to latest message', exact: true }).waitFor({ state: 'hidden' });
    const popoutBottom = await geometry();
    assert.ok(popoutBottom.last.bottom <= popoutBottom.footer.top + 2, 'Pop-out scrolling reaches the final answer above its composer');
    assert.ok(Math.abs(popoutBottom.footer.bottom - popoutBottom.viewport.bottom) <= 2, 'Pop-out composer stays docked');
    await page.screenshot({ path: resolve('artifacts/completed-scroll-popout.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: streaming and completed replies, late Markdown, repeated turns, wheel scrolling, latest button, composer docking, narrow resizing, and pop-out chats.');
  } catch (error) { console.log('Failure geometry', JSON.stringify(await geometry())); throw error; }
  finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
