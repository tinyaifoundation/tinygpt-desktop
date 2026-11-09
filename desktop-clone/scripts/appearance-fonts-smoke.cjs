const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');
const assert = require('node:assert/strict');
const fonts = ['Inter', 'Geist', 'Figtree', 'Public Sans', 'Manrope', 'Roboto', 'DM Sans', 'Plus Jakarta Sans'];
const cssFamily = name => name === 'Inter' ? name : `${name} Variable`;
async function main() {
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* drain */ }
    const event = (delta, finish_reason = null) => ({ id: 'font-fixture', object: 'chat.completion.chunk', created: 1, model: 'font-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(event({ role: 'assistant', content: 'Fonts make TinyGPT readable. This is conversation content, with **bold text** and *italic text*.' }))}\n\ndata: ${JSON.stringify(event({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `fonts-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = []; const fontFailures = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); page.on('requestfailed', request => { if (request.resourceType() === 'font') fontFailures.push(request.url()); });
    await page.route('https://**/*', route => route.abort()); // Fonts must work without CDN access.
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async endpoint => { const snapshot = (await window.tinygpt.snapshot()).value; await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, model: 'font-fixture', endpoint } }); }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check our font rendering.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText(/Fonts make TinyGPT readable/).waitFor();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    async function renderedFont(selector, name) {
      await page.locator(selector).waitFor(); await page.evaluate(() => document.fonts.ready);
      const { root } = await cdp.send('DOM.getDocument'); const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { fonts: actual } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(actual.some(font => font.isCustomFont && font.glyphCount > 0 && font.familyName.toLowerCase().includes(name.toLowerCase())), `${name} should actually render ${selector}: ${JSON.stringify(actual)}`);
    }
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    async function appearance() { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await nav.getByRole('button', { name: 'Appearance', exact: true }).click(); }
    async function choose(label, font, expected = fonts) { await page.getByLabel(label, { exact: true }).click(); assert.deepEqual(await page.getByRole('menuitemradio').allTextContents().then(values => values.map(value => value.trim())), expected); await page.getByRole('menuitemradio', { name: font, exact: true }).click(); }
    await appearance();
    for (const theme of ['light', 'dark']) {
      const label = theme === 'light' ? 'Light theme' : 'Dark theme';
      await page.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
      for (const font of fonts) {
        await choose(`${label} uiFont`, font);
        const loaded = await page.evaluate(async family => {
          const result = [];
          for (const weight of [300, 400, 500, 600, 700]) result.push((await document.fonts.load(`${weight} 14px "${family}"`, 'TinyGPT readable 012345')).map(face => ({ family: face.family, status: face.status })));
          return result;
        }, cssFamily(font));
        assert.ok(loaded.every(faces => faces.length > 0 && faces.every(face => face.status === 'loaded')), `${font} weights should load offline`);
        await renderedFont(`[aria-label="${label} uiFont"]`, font);
      }
      for (const font of fonts) {
        await choose(`${label} contentFont`, font);
        await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
        await renderedFont('[data-slot="answer-text"] p', font);
        assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).evaluate(node => getComputedStyle(node).fontFamily.split(',')[0].replaceAll('"', '')), cssFamily(font));
        await appearance();
      }
      await page.getByLabel(`${label} codeFont`, { exact: true }).click(); assert.deepEqual(await page.getByRole('menuitemradio').allTextContents().then(values => values.map(value => value.trim())), ['System default', 'Inter', 'Arial', 'Georgia', 'Menlo']); await page.keyboard.press('Escape');
    }
    await choose('Dark theme uiFont', 'Manrope'); await choose('Dark theme contentFont', 'Geist');
    await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await page.screenshot({ path: resolve('artifacts/appearance-fonts-conversation.png') });
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await renderedFont('.sidebar-profile-name', 'Manrope'); await renderedFont('[data-slot="answer-text"] p', 'Geist');
    const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem('tinygpt-appearance-v4')));
    assert.equal(preferences.dark.uiFont, 'Manrope'); assert.equal(preferences.dark.contentFont, 'Geist'); assert.equal(preferences.light.contentFont, 'Plus Jakarta Sans');
    await appearance(); await page.getByLabel('Dark theme uiFont', { exact: true }).click(); await page.screenshot({ path: resolve('artifacts/appearance-fonts-options.png') }); await page.keyboard.press('Escape');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 600));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve('artifacts/appearance-fonts-narrow.png') });
    for (const name of ['inter', 'geist', 'figtree', 'public-sans', 'manrope', 'roboto', 'dm-sans', 'plus-jakarta-sans']) assert.ok(existsSync(resolve(`out/renderer/licenses/fonts/${name}-LICENSE.txt`)));
    assert.deepEqual(errors, []); assert.deepEqual(fontFailures, []);
    console.log('Appearance fonts passed: exact nine choices in UI/Content for both themes, actual bundled glyph rendering, offline weight loading, real conversation/composer fonts, separate UI/content choices, unchanged Code options, persistence, narrow layout, and packaged licenses.');
  } catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/appearance-fonts-failure.png') }); console.error('Renderer errors:', errors); throw error; }
  finally { await app.close(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
