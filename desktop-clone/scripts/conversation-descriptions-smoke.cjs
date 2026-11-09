const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const requests = []; let replies = 0; let descriptions = 0;
  const title = 'TinyGPT navigation and Bot customization';
  const summary = 'Refining sidebar navigation, conversation previews, and the starling Bot designer.';
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); requests.push(body);
    const metadata = JSON.stringify(body.messages).includes('Describe a saved conversation for its sidebar and search.');
    const text = metadata ? JSON.stringify({ title: ++descriptions === 1 ? title : 'An unnecessary new title', summary, topicChanged: false }) : `Completed UI review ${++replies}.`;
    const event = (delta, finish_reason = null) => ({ id: 'description-fixture', object: 'chat.completion.chunk', created: 1, model: 'description-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(event({ role: 'assistant', content: text }))}\n\ndata: ${JSON.stringify(event({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `conversation-descriptions-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.evaluate(async endpoint => { const snapshot = (await window.tinygpt.snapshot()).value; await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, model: 'description-fixture', endpoint } }); }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Clean up TinyGPT sidebar navigation and the Bot customization UI.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Completed UI review 1.', { exact: true }).waitFor();
    await page.getByRole('button', { name: `Switch conversation: ${title}`, exact: true }).waitFor();
    const row = page.locator('.sidebar-chat-row').filter({ hasText: title }); await row.hover();
    await page.locator('.conversation-preview-description').filter({ hasText: summary }).waitFor();
    await page.screenshot({ path: resolve('artifacts/conversation-description-hover.png') });
    await page.getByRole('button', { name: 'Search chats', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search saved chats' }).fill('starling');
    await page.locator('.search-dialog-results button').filter({ hasText: title }).waitFor();
    assert.equal(await page.locator('.search-dialog-results button').filter({ hasText: title }).getAttribute('title'), `${title}\n${summary}`);
    await page.screenshot({ path: resolve('artifacts/conversation-description-search.png') }); await page.keyboard.press('Escape');
    for (let i = 2; i <= 3; i++) {
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`Refine this design, pass ${i}.`); await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByText(`Completed UI review ${i}.`, { exact: true }).waitFor();
      for (let attempts = 0; attempts < 100 && descriptions < i; attempts++) await new Promise(done => setTimeout(done, 100));
      assert.equal(descriptions, i);
    }
    assert.equal(await page.locator('.conversation-title-trigger').textContent(), title);
    const id = await page.evaluate(async () => (await window.tinygpt.library()).value.conversations[0].id);
    await page.evaluate(async id => { await window.tinygpt.renameConversation(id, 'My design notes'); }, id);
    await page.reload(); await page.getByRole('button', { name: 'Switch conversation: My design notes', exact: true }).waitFor();
    const saved = await page.evaluate(async id => (await window.tinygpt.conversation(id)).value, id);
    assert.equal(saved.summary, summary); assert.equal(saved.messages.length, 6);
    for (const body of requests.filter(body => JSON.stringify(body.messages).includes('Describe a saved conversation'))) { assert.equal(body.max_tokens, 512); assert.equal(body.tools?.length ?? 0, 0); assert.equal(body.model, 'description-fixture'); }
    assert.deepEqual(errors, []);
    console.log('Descriptions passed: real local runtime, background title/header/sidebar updates, hover summary, summary-only search, stable follow-up titles, persisted manual rename and summary, no added transcript messages or tools.');
  } catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/conversation-description-failure.png') }); console.error('Renderer errors:', errors); throw error; }
  finally { await app.close(); await new Promise(done => { server.closeAllConnections(); server.close(done); }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
