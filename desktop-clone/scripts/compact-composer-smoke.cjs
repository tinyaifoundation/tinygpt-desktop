const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let desktop, page, floating; const errors = [];
  const draft = Array.from({ length: 45 }, (_, i) => `Line ${i + 1}: A longer draft to check wrapping and composer scroll behavior.`).join('\n');
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'composer-fixture' }] })); return; }
    let raw = ''; for await (const part of request) raw += part;
    const metadata = raw.includes('Describe a saved conversation');
    const chunk = { id: 'composer-fixture', object: 'chat.completion.chunk', model: 'composer-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: metadata ? JSON.stringify({ title: 'Composer fixture', summary: 'Composer checks.', topicChanged: false }) : 'Saved composer fixture.' }, finish_reason: 'stop' }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const watch = target => { target.setDefaultTimeout(15000); target.on('pageerror', error => errors.push(error.message)); return target; };
  async function bridge(target, method, ...args) { const result = await target.evaluate(({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function checkScroll(target, label = 'Message', cap = 134) {
    const input = target.getByRole('textbox', { name: label, exact: true }); await input.fill(draft); await target.waitForTimeout(180);
    const metrics = await input.evaluate(field => {
      const viewport = field.closest('[data-slot=scroll-area-viewport]');
      return { height: viewport.clientHeight, total: viewport.scrollHeight, top: viewport.scrollTop, fieldHeight: field.clientHeight, fieldScroll: field.scrollTop, overflow: getComputedStyle(field).overflowY, horizontal: viewport.scrollWidth > viewport.clientWidth, bar: viewport.parentElement.querySelectorAll('[data-slot=scroll-area-scrollbar]').length };
    });
    assert.ok(metrics.height <= cap + 1 && metrics.total > metrics.height + 300, JSON.stringify(metrics)); assert.equal(metrics.overflow, 'hidden'); assert.equal(metrics.fieldScroll, 0); assert.ok(metrics.fieldHeight > metrics.height); assert.equal(metrics.horizontal, false); assert.equal(metrics.bar, 1);
    await input.press('Control+Home'); await target.waitForTimeout(80); assert.ok(await input.evaluate(field => field.closest('[data-slot=scroll-area-viewport]').scrollTop) <= 1, 'Home reveals the first line, allowing display-scale rounding');
    await input.press('Control+End'); await target.waitForTimeout(80); assert.ok(await input.evaluate(field => field.closest('[data-slot=scroll-area-viewport]').scrollTop) > 200);
    await input.press('Shift+Enter'); await input.pressSequentially('Caret stays visible.'); await target.waitForTimeout(80);
    assert.ok((await input.inputValue()).endsWith('\nCaret stays visible.'));
    const bottom = await input.evaluate(field => { const viewport = field.closest('[data-slot=scroll-area-viewport]'); return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop; }); assert.ok(bottom < 35, 'Typing keeps the caret visible: ' + bottom);
    const viewport = input.locator('xpath=ancestor::*[@data-slot="scroll-area-viewport"]'); await viewport.hover(); await target.mouse.wheel(0, -250); await target.waitForTimeout(150); assert.ok(await viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop) > 100);
    console.log('Composer scrolling:', label, metrics); return input;
  }
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `compact-composer-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    page = watch(await desktop.firstWindow()); await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const snapshot = await bridge(page, 'snapshot'); await bridge(page, 'saveSettings', { ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'composer-fixture', tools: true, contextWindowTokens: 32768 } });
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    let input = await checkScroll(page); await page.screenshot({ path: resolve('artifacts/composer-shadcn-chat.png') });
    await input.fill('Short draft'); assert.ok(await input.evaluate(field => field.closest('[data-slot=scroll-area-viewport]').clientHeight) < 60);
    await page.getByRole('tab', { name: 'Work', exact: true }).click(); input = await checkScroll(page, 'Message', 180); await page.screenshot({ path: resolve('artifacts/composer-shadcn-work.png') });
    await page.getByRole('tab', { name: 'Chat', exact: true }).click(); await input.fill('Original editable message'); await input.press('Enter');
    await page.getByText('Saved composer fixture.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit message', exact: true }).click(); await checkScroll(page, 'Edit message', 256); await page.screenshot({ path: resolve('artifacts/composer-shadcn-edit.png') }); await page.locator('[data-slot=edit-message]').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
    const opened = desktop.waitForEvent('window'); await page.getByRole('button', { name: 'Pop out chat', exact: true }).click(); floating = watch(await opened);
    await floating.getByRole('button', { name: 'Model and effort', exact: true }).waitFor();
    const icon = floating.getByRole('button', { name: 'Model and effort', exact: true }); assert.equal(await icon.innerText(), ''); assert.equal(await icon.locator('svg.lucide-gauge').count(), 1); assert.equal(await floating.locator('.composer .effort-model-name, .composer .effort-level, .composer .effort-nitro-indicator').count(), 0);
    const placement = await icon.evaluate(button => { const rect = button.getBoundingClientRect(), mic = document.querySelector('[aria-label="Dictate message"]').getBoundingClientRect(); return { width: rect.width, height: rect.height, gap: mic.left - rect.right, aligned: Math.abs(mic.top - rect.top), color: getComputedStyle(button).color, micColor: getComputedStyle(document.querySelector('[aria-label="Dictate message"]')).color }; });
    assert.equal(placement.width, 32); assert.equal(placement.height, 32); assert.ok(placement.gap >= 0 && placement.gap <= 10 && placement.aligned < 1, JSON.stringify(placement)); assert.equal(placement.color, placement.micColor);
    await icon.click(); await floating.getByRole('slider', { name: 'Level of effort', exact: true }).waitFor(); assert.equal(await floating.locator('.effort-picker-heading .composer-model-trigger').count(), 1);
    await floating.getByRole('slider', { name: 'Level of effort', exact: true }).press('End'); await floating.waitForFunction(async () => (await window.tinygpt.snapshot()).value.settings.effort.chat === 'max');
    await floating.keyboard.press('Escape'); assert.equal(await icon.innerText(), '');
    await checkScroll(floating); await floating.screenshot({ path: resolve('artifacts/composer-popout-icon-light.png') });
    await floating.evaluate(() => { const key = 'tinygpt-appearance-v4'; const preferences = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...preferences, theme: 'dark' })); }); await floating.reload(); await floating.locator('html[data-theme=dark]').waitFor(); await checkScroll(floating); await floating.screenshot({ path: resolve('artifacts/composer-popout-icon-dark.png') });
    await desktop.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).setSize(320, 440), floating.url()); await floating.waitForTimeout(150); await checkScroll(floating);
    assert.equal(await floating.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.querySelector('.composer').scrollWidth > document.querySelector('.composer').clientWidth), false);
    await floating.getByRole('button', { name: 'Return chat to TinyGPT', exact: true }).click(); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor(); assert.equal(await page.locator('.effort-icon-trigger').count(), 0); assert.equal(await page.locator('.effort-model-name').count(), 1);
    const savedDraft = await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue();
    await page.locator('.effort-trigger').click(); await page.getByRole('slider', { name: 'Level of effort', exact: true }).waitFor();
    await desktop.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).setSize(850, 720), page.url());
    await page.getByRole('button', { name: 'Model and effort', exact: true }).waitFor();
    assert.equal(await page.locator('.effort-trigger svg.lucide-gauge').count(), 1);
    assert.equal(await page.locator('.effort-model-name').count(), 0);
    assert.equal(await page.getByRole('slider', { name: 'Level of effort', exact: true }).count(), 1, 'Resizing preserves the open picker');
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), savedDraft);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Model and effort', exact: true }).click(); await page.getByRole('slider', { name: 'Level of effort', exact: true }).press('Home');
    await page.waitForFunction(async () => (await window.tinygpt.snapshot()).value.settings.effort.chat === 'instant');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.querySelector('.composer').scrollWidth > document.querySelector('.composer').clientWidth), false);
    await desktop.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url).setSize(1200, 820), page.url());
    await page.locator('.effort-model-name').waitFor(); assert.equal(await page.locator('.effort-icon-trigger').count(), 0);
    assert.deepEqual(errors, []); console.log('Compact composer smoke passed: Gauge picker in pop-outs and narrow composers, resize preserves the open picker and draft, effort changes persist, shared ShadCN scrollbars, keyboard caret, wheel scrolling and narrow layout.');
  } catch (error) { if (floating && !floating.isClosed()) console.log(await floating.locator('body').innerText().catch(() => '')); else if (page) { await page.screenshot({ path: resolve('artifacts/compact-composer-failure.png') }).catch(() => {}); console.log(await page.locator('body').innerText().catch(() => '')); } throw error; }
  finally { if (desktop) await desktop.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
