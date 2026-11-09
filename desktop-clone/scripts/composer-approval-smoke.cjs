const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  let origin, app, page, sequence = 0;
  let releaseOpen; const openGate = new Promise(done => { releaseOpen = done; });
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/challenge')) return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Verify you are human</title><h1>Verify you are human</h1><button onclick="document.title=\'Verified article\';document.querySelector(\'h1\').textContent=\'Verification completed\';this.remove()">Complete verification</button>');
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'footer-fixture', supports_tool_calling: true, context_length: 64000 }] }));
    if (!req.url.startsWith('/v1/')) return res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Browser approval fixture</title><h1>Browser fixture</h1><button>Sign in</button>');
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const responseId = `fixture-${++sequence}`;
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: responseId, object: 'chat.completion.chunk', model: 'footer-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (JSON.stringify(body.messages).includes('Describe a saved conversation')) return res.end(frame({ content: JSON.stringify({ title: 'Browser approval test', summary: 'Checking browser approval layout.', topicChanged: false }) }, 'stop') + 'data: [DONE]\n\n');
    const lastUser = body.messages.findLastIndex(m => m.role === 'user');
    const turnTools = body.messages.slice(lastUser + 1).filter(m => m.role === 'tool');
    const result = turnTools.at(-1);
    if (turnTools.length >= 2) return res.end(frame({ role: 'assistant', content: 'The browser task has finished.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
    let name = 'browser_open', args = { url: origin + '/page' };
    if (result) { const opened = JSON.parse(result.content); name = 'browser_scroll'; args = { tabId: opened.tabId, direction: 'down', pixels: 100 }; }
    if (name === 'browser_open') await openGate;
    res.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `footer-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.stack); });
    page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { w.setPosition(-10000, -10000); w.setIgnoreMouseEvents(true); w.webContents.setBackgroundThrottling(false); w.showInactive(); } });
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await page.evaluate(async endpoint => { const s = (await window.tinygpt.snapshot()).value.settings; const saved = await window.tinygpt.saveSettings({ ...s, mode: 'chat', route: 'local', local: { ...s.local, endpoint, model: 'footer-fixture', tools: true }, effort: { ...s.effort, chat: 'instant' }, toolPermissions: { ...s.toolPermissions, browser: 'allow', interact: 'ask' } }); if (!saved.ok) throw Error(saved.error); const used = await window.tinygpt.useLocalModel(endpoint, 'footer-fixture'); if (!used.ok) throw Error(used.error); }, origin + '/v1');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Open the browser fixture and scroll the page.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const draft = 'Keep this follow-up draft while permission is pending.';
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
    await page.getByRole('button', { name: 'Add files and tools', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add context', exact: true }).waitFor(); releaseOpen();
    await page.getByRole('region', { name: 'Tool approval', exact: true }).waitFor(); await page.getByRole('complementary', { name: 'Agent browser preview', exact: true }).waitFor();
    await page.getByRole('dialog', { name: 'Add context', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.composer:visible').count(), 0);
    assert.equal(await page.locator('.composer textarea').inputValue(), draft);
    const inspect = async target => target.evaluate(() => { const v = document.querySelector('.thread-viewport'), f = document.querySelector('.composer-footer'); return { composers: document.querySelectorAll('.composer').length, approvals: document.querySelectorAll('[data-slot="permission-grant"]').length, height: v.clientHeight, scrollHeight: v.scrollHeight, scrollTop: v.scrollTop, footer: f.getBoundingClientRect().toJSON(), viewport: v.getBoundingClientRect().toJSON() }; });
    console.log('Initial', await inspect(page));
    for (let i = 0; i < 24; i++) { await page.locator('.thread-viewport').evaluate((v, i) => { v.scrollTop = i % 2 ? v.scrollHeight : 0; }, i); await page.waitForTimeout(100); }
    await page.screenshot({ path: resolve('artifacts/composer-approval-main.png') }); console.log('Scrolled', await inspect(page));
    assert.equal(await page.locator('.thread-viewport').count(), 1); assert.equal(await page.locator('.composer').count(), 1); assert.equal(await page.locator('[data-slot="permission-grant"]').count(), 1);
    await page.getByRole('region', { name: 'Tool approval', exact: true }).getByRole('button', { name: 'Deny', exact: false }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), draft);
    async function idle() { for (let i = 0; i < 200; i++) { const library = (await page.evaluate(() => window.tinygpt.library())).value; if (!library.activeRuns.length) return; await page.waitForTimeout(100); } throw Error('Reply did not finish.'); }
    await idle();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Open the browser fixture and scroll again.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('region', { name: 'Tool approval', exact: true }).waitFor();
    const opened = app.waitForEvent('window'); await page.getByRole('button', { name: 'Pop out chat', exact: true }).click(); const floating = await opened; floating.setDefaultTimeout(20000);
    floating.on('pageerror', e => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { w.setPosition(-10000, -10000); w.setIgnoreMouseEvents(true); w.webContents.setBackgroundThrottling(false); w.showInactive(); } });
    await floating.getByRole('region', { name: 'Tool approval', exact: true }).waitFor();
    for (let i = 0; i < 24; i++) { await floating.locator('.thread-viewport').evaluate((v, i) => { v.scrollTop = i % 2 ? v.scrollHeight : 0; }, i); await floating.waitForTimeout(100); }
    await floating.screenshot({ path: resolve('artifacts/composer-approval-popout.png') }); console.log('Popout', await inspect(floating));
    assert.equal(await floating.locator('.thread-viewport').count(), 1); assert.equal(await floating.locator('.composer').count(), 1); assert.equal(await floating.locator('[data-slot="permission-grant"]').count(), 1);
    assert.equal(await floating.locator('.composer:visible').count(), 0);
    await floating.getByRole('region', { name: 'Tool approval', exact: true }).getByRole('button', { name: 'Allow once', exact: false }).click();
    await floating.getByRole('region', { name: 'Tool approval', exact: true }).waitFor({ state: 'hidden' });
    await floating.getByRole('complementary', { name: 'Agent browser preview', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await floating.locator('.thread-viewport').count(), 1); assert.equal(await floating.locator('.composer').count(), 1);
    assert.equal(await floating.locator('.composer:visible').count(), 1);
    await idle();
    await floating.getByRole('button', { name: 'Return chat to TinyGPT', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.equal(await page.locator('.thread-viewport').count(), 1); assert.equal(await page.locator('.composer').count(), 1); assert.equal(await page.locator('[data-slot="permission-grant"]').count(), 0);
    // Browser login/verification handoffs share the approval design, including
    // compact pop-outs, while retaining their real reveal/resume/stop behavior.
    const challenge = origin + '/challenge?continue=' + 'long-path-'.repeat(30);
    await page.evaluate(async url => { const library = (await window.tinygpt.library()).value; window.fixtureReading = window.tinygpt.readPage(library.lastConversationId, url); }, challenge);
    const handoff = page.getByRole('region', { name: 'Browser handoff', exact: true });
    await handoff.waitFor();
    assert.equal(await page.locator('.composer:visible').count(), 0);
    assert.equal(await handoff.getAttribute('class'), 'permission-grant');
    assert.equal(await handoff.locator('.permission-grant-controls button').last().innerText(), 'Resume task');
    await page.screenshot({ path: resolve('artifacts/browser-handoff-dark.png') });
    await handoff.getByRole('button', { name: 'Show browser', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search or enter a URL', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Light', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click();
    await handoff.waitFor(); await page.screenshot({ path: resolve('artifacts/browser-handoff-light.png') });
    const reopened = app.waitForEvent('window'); await page.getByRole('button', { name: 'Pop out chat', exact: true }).click(); const compact = await reopened; compact.setDefaultTimeout(20000); compact.on('pageerror', e => errors.push(e.message));
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { w.setPosition(-10000, -10000); w.setIgnoreMouseEvents(true); w.webContents.setBackgroundThrottling(false); w.showInactive(); } });
    const compactHandoff = compact.getByRole('region', { name: 'Browser handoff', exact: true }); await compactHandoff.waitFor();
    assert.equal(await compact.locator('.composer:visible').count(), 0);
    assert.ok(await compactHandoff.evaluate(e => e.scrollWidth <= e.clientWidth));
    await compact.screenshot({ path: resolve('artifacts/browser-handoff-popout.png') });
    await app.evaluate(async ({ webContents }, url) => { const browser = webContents.getAllWebContents().find(w => w.getURL() === url); await browser.executeJavaScript('document.querySelector("button").click()'); }, challenge);
    await compactHandoff.getByRole('button', { name: 'Resume task', exact: true }).click(); await compactHandoff.waitFor({ state: 'hidden' });
    await compact.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    const verified = await page.evaluate(() => window.fixtureReading); assert.equal(verified.ok, true); assert.match(verified.value.page.text, /Verification completed/);
    await compact.getByRole('button', { name: 'Return chat to TinyGPT', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await page.evaluate(async url => { const library = (await window.tinygpt.library()).value; window.fixtureReading = window.tinygpt.readPage(library.lastConversationId, url); }, challenge + '&again=1');
    await handoff.waitFor(); await handoff.getByRole('button', { name: 'Stop task', exact: true }).click(); await handoff.waitFor({ state: 'hidden' });
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.fixtureReading)).ok, false);
    console.log('Approval replacement passed: draft retained, context menu closed, deny/allow restore composer, main/pop-out, browser handoffs in dark/light, reveal, resume, and stop.');
    assert.deepEqual(errors, []); console.log('Composer/approval browser reproduction completed.');
  } catch (e) { if (page) { console.log(await page.evaluate(() => ({ panes: document.querySelectorAll('.conversation-pane').length, viewports: document.querySelectorAll('.thread-viewport').length, footers: document.querySelectorAll('.composer-footer').length }))); await page.screenshot({ path: resolve('artifacts/composer-approval-failure.png') }); } throw e; }
  finally { releaseOpen(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
