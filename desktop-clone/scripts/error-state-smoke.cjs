// Isolated profile and local inference; no user credentials or paid requests.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function main() {
  let app; let page; const errors = []; const attempts = new Map();
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part; const input = JSON.parse(raw);
    const task = input.messages.filter(message => message.role === 'user').at(-1).content; const attempt = (attempts.get(task) ?? 0) + 1; attempts.set(task, attempt);
    if (attempt === 1 && task === 'Recover this reply') { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'fixture-upstream-secret-private-details' } })); return; }
    const chunk = (text, finish = null) => JSON.stringify({ id: 'error-fixture', object: 'chat.completion.chunk', created: 1, model: 'error-fixture', choices: [{ index: 0, delta: text ? { role: 'assistant', content: text } : {}, finish_reason: finish }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (attempt === 1) { response.write(`data: ${chunk('A partial answer saved before the connection failed.')}\n\n`); setTimeout(() => response.destroy(), 150); return; }
    response.write(': provider keepalive\n\n'); await delay(500); response.end(`data: ${chunk('Recovered reply.')}\n\ndata: ${chunk('', 'stop')}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `error-state-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => { const current = (await window.tinygpt.snapshot()).value.settings; const result = await window.tinygpt.saveSettings({ ...current, mode: 'chat', route: 'local', local: { ...current.local, endpoint, model: 'error-fixture', tools: false } }); if (!result.ok) throw new Error(result.error); }, `http://127.0.0.1:${server.address().port}/v1`); await page.reload();
    for (const task of ['Recover this reply', 'Interrupt this reply']) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill(task); await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const card = page.locator('[data-slot="error-state"]'); await card.waitFor(); assert.equal(await card.getAttribute('role'), 'alert'); assert.equal(await page.locator('[data-slot="stopped-run"]').count(), 0); assert.ok(!(await page.locator('body').innerText()).includes('fixture-upstream-secret'));
      if (task === 'Recover this reply') {
        await card.getByText('Your provider is temporarily unavailable. You can retry this reply.', { exact: true }).waitFor(); await page.screenshot({ path: resolve('artifacts/error-state-light.png') });
        await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); await card.waitFor(); await page.screenshot({ path: resolve('artifacts/error-state-dark.png') });
      } else await page.getByText('A partial answer saved before the connection failed.', { exact: true }).waitFor();
      const id = (await page.evaluate(() => window.tinygpt.library())).value.lastConversationId;
      await card.getByRole('button', { name: 'Retry failed reply', exact: true }).click(); await card.waitFor({ state: 'hidden' }); await page.getByText('Recovered reply.', { exact: true }).waitFor();
      const saved = (await page.evaluate(id => window.tinygpt.conversation(id), id)).value; assert.equal(saved.messages.filter(message => message.role === 'user').length, 1); assert.ok(saved.allMessages.some(message => message.status === 'error')); assert.equal(saved.messages.at(-1).status, 'complete');
      if (task === 'Interrupt this reply') assert.ok(saved.allMessages.some(message => message.status === 'error' && message.text.includes('A partial answer')));
    }
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['assistant-ui runtime error text', 'light/dark quiet error banner', 'real Reload retry', 'partial answer preserved', 'failed sibling branch preserved', 'upstream error sanitization'], errors }));
  } catch (error) { if (page) await page.screenshot({ path: resolve('artifacts/error-state-failure.png') }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
