const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let app, page, releaseFirst, releaseFinal;
  const errors = [], bodies = [];
  const profile = resolve('.tools-smoke-profile', `inference-${Date.now()}`);
  const off = { kind: 'openai', efforts: ['none', 'low', 'medium', 'high'], canDisable: true };
  const mandatory = { kind: 'openai', efforts: ['low', 'medium', 'high', 'xhigh'], canDisable: false };
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [
        { id: 'swift-model', context_length: 32768, supports_tool_calling: true, tinygpt_reasoning: off },
        { id: 'deep-model', context_length: 64000, supports_tool_calling: true, tinygpt_reasoning: mandatory },
      ] })); return;
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const metadata = JSON.stringify(body.messages).includes('Describe a saved conversation');
    const step = metadata ? 99 : bodies.push(body);
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'inference-fixture-' + step, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (metadata) { response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame({ role: 'assistant', content: JSON.stringify({ title: 'Effort fixture', summary: 'Verifying model controls.', topicChanged: false }) }, 'stop') + 'data: [DONE]\n\n'); return; }
    if (step === 1) await new Promise(done => { releaseFirst = done; });
    else await new Promise(done => { releaseFinal = done; });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (step === 1) {
      response.write(frame({ role: 'assistant', content: 'FLEETING_PRELUDE' }));
      await new Promise(done => setTimeout(done, 50));
      response.end(frame({ tool_calls: [{ index: 0, id: 'tool_search', type: 'function', function: { name: 'search_sources', arguments: JSON.stringify({ query: 'Fixture' }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
    } else response.end(frame({ role: 'assistant', content: 'Verified effort fixture answer.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const wait = async (predicate, description, timeout = 30000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await predicate()) return; await new Promise(done => setTimeout(done, 50)); }
    throw Error('Timed out: ' + description);
  };
  const snapshot = async () => (await page.evaluate(() => window.tinygpt.snapshot())).value;
  const headingStyle = async () => page.locator('.effort-picker-heading').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, caret: getComputedStyle(element.querySelector('.composer-model-trigger > svg')).opacity }));
  const effort = async (mode, value) => {
    await page.getByRole('button', { name: /^Level of effort:/ }).click();
    const slider = page.getByRole('slider', { name: 'Level of effort', exact: true });
    await slider.press(value === 'instant' ? 'Home' : 'End');
    await wait(async () => (await snapshot()).settings.effort[mode] === value, 'effort saved');
    await wait(async () => !(await slider.isDisabled()), 'effort ready');
  };
  const setTheme = async theme => {
    await page.evaluate(theme => { const key = 'tinygpt-appearance-v4'; const value = JSON.parse(localStorage.getItem(key) || '{}'); localStorage.setItem(key, JSON.stringify({ ...value, theme })); }, theme);
    await page.reload(); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await wait(async () => (await page.locator('html').getAttribute('data-theme')) === theme, 'theme');
  };
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      const result = await window.tinygpt.saveSettings({ ...settings, route: 'local', mode: 'chat', local: { ...settings.local, endpoint, model: 'swift-model', tools: true, contextWindowTokens: 32768 }, toolPermissions: { ...settings.toolPermissions, read: 'allow' } });
      if (!result.ok) throw Error(result.error);
      const connected = await window.tinygpt.useLocalModel(endpoint, 'swift-model');
      if (!connected.ok) throw Error(connected.error);
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await setTheme('dark');
    assert.equal(await page.locator('.composer-surface .composer-model-heading').count(), 0, 'Model picker is not above the composer');
    await page.getByRole('button', { name: /^Level of effort:/ }).click();
    await page.mouse.move(0, 0); await page.waitForTimeout(180);
    assert.deepEqual(await headingStyle(), { background: 'rgba(0, 0, 0, 0)', caret: '0' }, 'Opening the popover does not paint a hover state');
    await page.getByRole('button', { name: 'Choose model: swift-model', exact: true }).hover(); await page.waitForTimeout(180);
    assert.notEqual((await headingStyle()).background, 'rgba(0, 0, 0, 0)'); assert.equal((await headingStyle()).caret, '1');
    await page.mouse.move(0, 0); await page.waitForTimeout(180);
    assert.deepEqual(await headingStyle(), { background: 'rgba(0, 0, 0, 0)', caret: '0' }, 'Focus does not leave the heading highlighted after mouse exit');
    const metrics = await page.evaluate(() => {
      const composer = document.querySelector('.composer'), popover = document.querySelector('.effort-popover'), trigger = popover.querySelector('.composer-model-trigger');
      const rect = composer.getBoundingClientRect(), model = trigger.getBoundingClientRect(), level = popover.querySelector('.effort-popover-value').getBoundingClientRect(), track = popover.querySelector('.effort-slider-track').getBoundingClientRect();
      return { width: rect.width, centered: Math.abs((level.left + level.width / 2) - (model.left + model.width / 2)), belowLevel: model.top >= level.bottom, aboveTrack: model.bottom < track.top, font: getComputedStyle(trigger).fontSize };
    });
    assert.ok(metrics.width <= 601 && metrics.centered <= 1 && metrics.belowLevel && metrics.aboveTrack, JSON.stringify(metrics)); assert.equal(metrics.font, '11px');
    assert.equal(await page.getByText('Your API key', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Choose model: swift-model', exact: true }).click();
    await page.getByRole('option', { name: 'deep-model', exact: true }).waitFor();
    await page.mouse.move(0, 0); await page.waitForTimeout(180);
    assert.deepEqual(await headingStyle(), { background: 'rgba(0, 0, 0, 0)', caret: '0' }, 'An open model menu does not retain hover styling');
    await wait(async () => (await snapshot()).settings.local.modelCapabilities?.reasoning?.canDisable === true, 'catalog capabilities saved');
    await page.getByRole('textbox', { name: 'Search models', exact: true }).fill('deep');
    await page.screenshot({ path: resolve('artifacts/effort-model-dropdown.png') });
    await page.getByRole('option', { name: 'deep-model', exact: true }).click();
    await wait(async () => (await snapshot()).settings.local.model === 'deep-model', 'model saved');
    assert.equal((await snapshot()).settings.local.contextWindowTokens, 64000);
    await page.getByRole('button', { name: 'Choose model: deep-model', exact: true }).waitFor();
    assert.equal(await page.locator('.effort-popover').count(), 1, 'Choosing a model keeps the effort picker open');
    await page.keyboard.press('Escape');
    await effort('chat', 'instant');
    assert.equal(await page.locator('.effort-slider-labels').count(), 0);
    assert.equal(await page.locator('.effort-popover .inference-picker-note').count(), 0);
    assert.equal(await page.locator('.effort-max-star').count(), 0);
    const dark = await page.locator('.effort-popover').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderTopWidth, composer: getComputedStyle(document.querySelector('.composer')).backgroundColor }));
    assert.equal(dark.background, dark.composer); assert.equal(dark.border, '0px');
    await page.screenshot({ path: resolve('artifacts/effort-dark.png') });
    const bounds = await page.getByRole('slider', { name: 'Level of effort', exact: true }).boundingBox();
    await page.mouse.move(bounds.x + 10, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 10 }); await page.mouse.up();
    await wait(async () => (await snapshot()).settings.effort.chat === 'medium', 'pointer drag snaps and saves');
    await page.keyboard.press('Escape');
    await effort('chat', 'max');
    assert.equal(await page.locator('.effort-max-star').count(), 14);
    assert.equal(await page.locator('.effort-max-star').first().evaluate(element => getComputedStyle(element, '::before').backgroundColor), 'rgb(237, 237, 240)');
    const animated = await page.locator('.effort-max-star').first().evaluate(element => ({ name: getComputedStyle(element).animationName, transform: getComputedStyle(element).transform }));
    assert.equal(animated.name, 'effort-star-flight');
    await page.waitForTimeout(400);
    const travelled = await page.locator('.effort-max-star').first().evaluate(element => getComputedStyle(element).transform);
    assert.ok(Number(travelled.split(',')[4]) < Number(animated.transform.split(',')[4]), 'Max stars travel left');
    await page.screenshot({ path: resolve('artifacts/effort-max-dark.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.effort-max-star').first().evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.keyboard.press('Escape');
    await setTheme('light');
    await effort('chat', 'instant');
    const light = await page.locator('.effort-popover').evaluate(element => ({ border: getComputedStyle(element).borderTopWidth, background: getComputedStyle(element).backgroundColor }));
    assert.ok(parseFloat(light.border) > 0); await page.screenshot({ path: resolve('artifacts/effort-light.png') }); await page.keyboard.press('Escape');
    await effort('chat', 'max'); await page.screenshot({ path: resolve('artifacts/effort-max-light.png') }); await page.keyboard.press('Escape');
    await effort('chat', 'instant'); await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Work', exact: true }).click();
    await page.getByRole('button', { name: 'Level of effort: Medium', exact: true }).waitFor();
    await effort('code', 'max'); await page.keyboard.press('Escape');
    assert.deepEqual((await snapshot()).settings.effort, { chat: 'instant', code: 'max' });
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.getByRole('button', { name: /^Level of effort:/ }).click();
    await page.getByRole('button', { name: 'Choose model: deep-model', exact: true }).click();
    await page.getByRole('option', { name: 'swift-model', exact: true }).click();
    await wait(async () => (await snapshot()).settings.local.model === 'swift-model', 'switch model back');
    await setTheme('dark');
    await page.evaluate(() => {
      window.preludeFlashes = []; window.ackFlashes = [];
      new MutationObserver(() => {
        const ack = document.querySelector('[data-slot="instant-acknowledgment"]');
        if (ack) window.ackFlashes.push(ack.textContent);
        for (const text of document.querySelectorAll('[data-slot="answer-text"]')) if (text.textContent.includes('FLEETING_PRELUDE')) window.preludeFlashes.push(text.textContent);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Find the fixture evidence and answer.');
    const submitted = Date.now(); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.locator('[data-slot="work-status"]').waitFor(); const workingMs = Date.now() - submitted;
    assert.equal(await page.locator('[data-slot="work-status"]').innerText(), 'Working…');
    assert.equal(await page.locator('[data-slot="instant-acknowledgment"]').count(), 0);
    await wait(() => Boolean(releaseFirst), 'first request held');
    assert.equal(bodies[0].reasoning_effort, 'none'); releaseFirst();
    await wait(() => Boolean(releaseFinal), 'tool follow-up held');
    assert.equal(await page.locator('[data-slot="instant-acknowledgment"]').count(), 0);
    assert.equal(bodies[1].reasoning_effort, 'none'); assert.equal(bodies[1].messages.at(-1).role, 'tool');
    releaseFinal();
    await page.getByText('Verified effort fixture answer.', { exact: true }).waitFor();
    await wait(async () => !(await page.evaluate(() => window.tinygpt.library())).value.activeRuns.length, 'run finished');
    assert.equal(await page.locator('[data-slot="instant-acknowledgment"]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.preludeFlashes), []); assert.deepEqual(await page.evaluate(() => window.ackFlashes), []);
    const saved = await page.evaluate(async () => { const library = (await window.tinygpt.library()).value; return (await window.tinygpt.conversation(library.lastConversationId)).value.messages.at(-1); });
    assert.equal(saved.text, 'Verified effort fixture answer.'); assert.equal(saved.status, 'complete');
    await page.reload(); await page.getByText('Verified effort fixture answer.', { exact: true }).waitFor();
    assert.deepEqual((await snapshot()).settings.effort, { chat: 'instant', code: 'max' }); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ metrics, dark, light, workingMs, requests: bodies.length, profile, checks: ['live model catalog and capabilities', 'model selection persistence', 'separate Chat and Work effort', 'dark/light styling', 'Working status before provider bytes', 'no synthetic acknowledgment through tools', 'native reasoning off on every tool round', 'zero prelude flashes', 'durable final answer'], errors }));
  } catch (error) {
    if (page) { await page.screenshot({ path: resolve('artifacts/effort-failure.png') }); console.error((await page.locator('body').innerText()).slice(-7000)); }
    throw error;
  } finally { releaseFirst?.(); releaseFinal?.(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
