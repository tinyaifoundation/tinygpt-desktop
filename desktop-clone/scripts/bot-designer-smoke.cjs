const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain fixture request */ }
    const event = (delta, finish_reason = null, usage) => ({ id: 'bot-fixture', object: 'chat.completion.chunk', created: 1, model: 'bot-fixture', choices: [{ index: 0, delta, finish_reason }], usage });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(event({ role: 'assistant', content: 'A completed reply for the usage preview.' }))}\n\ndata: ${JSON.stringify(event({}, 'stop', { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `bot-designer-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async endpoint => { const snapshot = (await window.tinygpt.snapshot()).value; await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, model: 'bot-fixture', endpoint } }); }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check conversation usage.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('A completed reply for the usage preview.', { exact: true }).waitFor();
    const row = page.locator('.sidebar-chat-row').first(); await row.hover();
    await page.locator('.conversation-preview-usage').waitFor();
    const stats = await page.locator('.conversation-preview-usage').evaluate(element => { const a = element.firstElementChild.getBoundingClientRect(); const b = element.lastElementChild.getBoundingClientRect(); return { text: element.textContent, line: Math.abs(a.top - b.top), width: element.getBoundingClientRect().width, scroll: element.scrollWidth }; });
    assert.match(stats.text, /1.5K tokens/); assert.match(stats.text, /tokens\/sec/); assert.ok(stats.line < 3); assert.ok(stats.scroll <= stats.width + 1);
    await page.getByRole('button', { name: 'Your bot', exact: true }).click(); await page.getByRole('heading', { name: 'Introducing Your Bot', exact: true }).waitFor();
    assert.equal(await page.locator('.bot-designer').evaluate(element => getComputedStyle(element).animationName), 'bot-arrive');
    const title = await page.locator('.bot-introduction h1').evaluate(element => ({ introduction: element.firstElementChild.getBoundingClientRect().bottom, name: element.lastElementChild.getBoundingClientRect().top })); assert.ok(title.name >= title.introduction);
    for (const text of ['Make your assistant your own.', 'Live preview', 'Task features are coming soon.']) assert.equal(await page.getByText(text, { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Roundness', { exact: true }).count(), 0); assert.equal(await page.locator('input[type="color"]').count(), 0);
    assert.deepEqual(await page.locator('.bot-preview').evaluate(element => ({ border: getComputedStyle(element).borderTopWidth, background: getComputedStyle(element).backgroundColor })), { border: '0px', background: 'rgba(0, 0, 0, 0)' });
    await page.getByRole('button', { name: 'Edit bot name' }).click(); await page.getByRole('textbox', { name: 'Bot name', exact: true }).fill('  Nova  '); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Introducing Nova', exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'Your bot', exact: true }).locator('.sidebar-action-label').textContent(), 'Nova');
    await page.getByRole('button', { name: 'Edit bot name' }).click(); await page.getByRole('textbox', { name: 'Bot name', exact: true }).fill('Cancelled'); await page.keyboard.press('Escape'); await page.getByRole('heading', { name: 'Introducing Nova', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit bot name' }).click(); await page.getByRole('textbox', { name: 'Bot name', exact: true }).fill('   '); await page.keyboard.press('Enter'); await page.getByRole('heading', { name: 'Introducing Nova', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Violet color' }).click();
    const avatar = page.locator('.bot-welcome-avatar');
    const actions = ['Idle','Thinking','Wink','Wide eyes','Alert','Notification','Surprise','Sleep','Egg','Hexagon','Play','Orbit','Burst','Comet','Nod','Shake','Jump','Spin','Love','Party','Dizzy','Shiver','Melt','Snooze','Rain','Loading','Success','Question'];
    const outlines = [];
    for (const shape of ['Squircle', 'Circle', 'Triangle', 'Droplet']) {
      await page.getByRole('button', {name:shape+' shape',exact:true}).click();
      outlines.push(await avatar.locator('svg').innerHTML());
      for (const action of actions) {
        await page.getByRole('button', { name: 'Preview animation', exact: true }).click(); await page.getByRole('menuitemradio', { name: action, exact: true }).click();
        const geometry = await avatar.evaluate(element => ({ shape:element.dataset.shape,finite:!(/NaN|Infinity/.test(element.querySelector('svg').innerHTML)),engine:element.dataset.avatarEngine }));
        assert.equal(geometry.shape,shape.toLowerCase());assert.equal(geometry.finite,true);assert.equal(geometry.engine,'blob-avatar');
      }
      await page.getByRole('button', { name: 'Preview animation', exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Idle', exact: true }).click();
      await page.locator('.bot-designer').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))); });
      await page.screenshot({ path: resolve(`artifacts/bot-designer-${shape.toLowerCase()}.png`) });
    }
    assert.equal(new Set(outlines).size, 4);
    await page.getByRole('button',{name:'Circle shape',exact:true}).click();await page.getByRole('tab',{name:'Color',exact:true}).click();
    const custom = page.getByRole('button', {name:'Custom bot color',exact:true});
    await custom.click(); const picker = page.getByRole('dialog', { name: 'Custom bot color', exact: true }); await picker.waitFor();
    await picker.getByRole('slider', { name: 'Hue', exact: true }).focus(); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.bot-welcome-avatar').getAttribute('data-color') !== '#8b5cf6');
    assert.notEqual(await avatar.getAttribute('data-color'), '#8b5cf6');
    const field = picker.getByRole('textbox', { name: 'Hex color', exact: true });
    const beforeInvalid = await avatar.getAttribute('data-color'); await field.fill('#zzzzzz'); await field.press('Enter'); assert.equal(await field.inputValue(), beforeInvalid.toUpperCase()); assert.equal(await avatar.getAttribute('data-color'), beforeInvalid);
    await field.fill('#abc'); await field.press('Enter'); assert.equal(await avatar.getAttribute('data-color'), '#aabbcc');
    await field.fill('#a35476'); assert.equal(await avatar.getAttribute('data-color'), '#a35476');
    await page.screenshot({ path: resolve('artifacts/bot-color-picker-light.png') }); await field.press('Escape'); await picker.waitFor({ state: 'hidden' }); const selectedColor=await avatar.getAttribute('data-color');
    await page.getByRole('button', { name: 'Replay animation', exact: true }).click();
    await page.reload(); await page.getByRole('heading', { name: 'Introducing Nova', exact: true }).waitFor();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tinygpt-bot-v4'))); assert.deepEqual(saved, { name: 'Nova', color:selectedColor, shape: 'circle', expression: 'neutral' });
    assert.equal(await page.locator('.tiny-sidebar [data-robot-avatar]').getAttribute('data-color'), selectedColor); assert.equal(await page.locator('.tiny-sidebar [data-robot-avatar]').getAttribute('data-shape'), 'circle');
    await page.evaluate(() => { const appearance = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); appearance.theme = 'dark'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(appearance)); });
    await page.reload(); await page.getByRole('heading', { name: 'Introducing Nova', exact: true }).waitFor(); await page.locator('.bot-designer').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))); }); await page.screenshot({ path: resolve('artifacts/bot-designer-dark.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(950, 700));
    await page.getByRole('tab',{name:'Color',exact:true}).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 600));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await custom.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve('artifacts/bot-designer-narrow.png') });
    await custom.click(); await picker.waitFor(); await page.screenshot({ path: resolve('artifacts/bot-color-picker-dark.png') }); const bounds = await picker.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 850); await page.keyboard.press('Escape');
    const viewport = await page.locator('.bot-designer-viewport').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, height: element.clientHeight, contentHeight: element.scrollHeight })); assert.ok(viewport.scroll <= viewport.width); assert.ok(viewport.contentHeight > viewport.height);
    await page.evaluate(() => { const appearance = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); appearance.reduceMotion = 'on'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(appearance)); });
    await page.reload(); await page.getByRole('heading', { name: 'Introducing Nova', exact: true }).waitFor(); assert.equal(await page.locator('.bot-designer').evaluate(element => getComputedStyle(element).animationName), 'none'); assert.equal(await page.locator('.bot-welcome-avatar').getAttribute('data-paused'), 'true');
    assert.deepEqual(errors, []);
    console.log('Bot designer passed: simplified two-line introduction, unframed preview, removed copy/roundness, adjacent rainbow swatch, ShadCN picker with keyboard hue/hex validation/shorthand/live updates, 4 shapes × 28 animations, sidebar sync, persistence, themes, narrow scrolling and reduced motion.');
  } catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/bot-designer-failure.png') }); console.error('Renderer errors:', errors); throw error; }
  finally { await app.close(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
