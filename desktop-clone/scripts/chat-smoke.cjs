// Actual Electron + LibreChat + HTTP fixtures; no cloud keys or inference.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let app; const requests = []; const errors = []; let status = 200; let slow = false; let disconnected = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'chat-fixture' }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    requests.push({ body: JSON.parse(raw), authorization: request.headers.authorization });
    const largeContext = requests.at(-1).body.messages.at(-1).content === 'Create oversized context fixture';
    const summarizing = JSON.stringify(requests.at(-1).body.messages).includes('Write a concise conversation checkpoint');
    if (status !== 200) { response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'private-provider-error', type: 'api_error' } })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (text, end = false) => JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'chat-fixture', choices: [{ index: 0, delta: end ? {} : { role: 'assistant', content: text }, finish_reason: end ? 'stop' : null }] });
    response.write(`data: ${chunk('Fixture streaming ')}\n\n`);
    const timer = setTimeout(() => response.end(`data: ${chunk(summarizing ? 'Goal: Continue the conversation. Prior evidence and constraints were reviewed.' : largeContext ? 'Earlier evidence and constraints. '.repeat(6000) : 'answer.')}\n\ndata: ${chunk('', true)}\n\ndata: [DONE]\n\n`), slow ? 15000 : 700);
    response.on('close', () => { clearTimeout(timer); disconnected++; });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const environment = { ...process.env, TINYGPT_CHAT_PROFILE: resolve('.chat-smoke-profile', `chat-${Date.now()}`) }; delete environment.ELECTRON_RUN_AS_NODE;
  async function launch() {
    app = await _electron.launch({ executablePath: resolve(process.env.TINYGPT_SMOKE_EXECUTABLE || 'node_modules/electron/dist/electron.exe'), args: [resolve('scripts/chat-smoke-main.cjs')], env: environment, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    return page;
  }
  async function idle(page) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await page.evaluate(() => window.tinygpt.library()); assert.equal(result.ok, true);
      if (!result.value.activeRuns[0]) return result.value;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error('The Chat worker did not become idle.');
  }
  async function selected(page, id) { const result = await page.evaluate(id => window.tinygpt.conversation(id), id); assert.equal(result.ok, true); return result.value; }
  try {
    let page = await launch();
    // Set only test-owned local connection values through the same validated bridge.
    const configured = await page.evaluate(async endpoint => {
      const current = await window.tinygpt.snapshot();
      return window.tinygpt.saveSettings({ ...current.value.settings, mode: 'chat', route: 'local', local: { endpoint, model: 'chat-fixture' } });
    }, endpoint); assert.equal(configured.ok, true);
    await page.reload(); await page.locator('[data-sidebar-section=Projects]').hover(); await page.getByRole('button', { name: 'New Project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Chat smoke Project');
    await page.getByRole('textbox', { name: 'Project instructions', exact: true }).fill('Use the project marker BLUEBIRD.');
    await page.getByRole('button', { name: 'Save Project', exact: true }).click();
    await page.getByRole('heading', { name: 'Project settings', exact: true }).waitFor();
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.cwd()] }); });
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await page.getByText(resolve('.'), { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Hello from the first chat');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Fixture streaming', { exact: true }).waitFor({ timeout: 30000 });
    let library = await idle(page); const id = library.lastConversationId;
    let conversation = await selected(page, id);
    assert.equal(conversation.messages.at(-1).status, 'complete'); assert.equal(conversation.messages.at(-1).text, 'Fixture streaming answer.');
    assert.equal(requests.at(-1).body.messages[0].content.includes('BLUEBIRD'), true);
    assert.equal(library.projects.find(project => project.id === conversation.projectId).rootPath.toLowerCase(), resolve('.').toLowerCase());
    assert.equal(requests.at(-1).authorization, 'Bearer tinygpt-local');
    slow = true;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Give me a long reply');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Fixture streaming', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await idle(page);
    conversation = await selected(page, id); assert.equal(conversation.messages.at(-1).status, 'cancelled'); assert.equal(conversation.messages.at(-1).text, 'Fixture streaming ');
    slow = false; await page.getByRole('button', { name: 'Retry reply', exact: true }).last().click(); await idle(page);
    conversation = await selected(page, id); assert.equal(conversation.messages.length, 4); assert.equal(conversation.messages.at(-1).status, 'complete');
    assert.equal(requests.at(-1).body.messages.length, 4);
    status = 401;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Test a failed reply'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await idle(page);
    await page.getByText('Your provider did not accept the API key. Check it in Settings.', { exact: true }).waitFor();
    conversation = await selected(page, id); assert.equal(conversation.messages.at(-1).status, 'error'); assert.equal(JSON.stringify(conversation).includes('private-provider-error'), false);
    status = 200; await page.getByRole('button', { name: 'Retry reply', exact: true }).last().click(); await idle(page);
    // Reopen the application and continue with the saved context.
    await app.close(); app = null; page = await launch();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue after reopening'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await idle(page);
    conversation = await selected(page, id); assert.equal(conversation.messages.length, 8); assert.equal(requests.at(-1).body.messages.length, 8);
    await page.getByRole('button', { name: 'Rename chat', exact: true }).click(); await page.getByRole('textbox', { name: 'Chat title', exact: true }).fill('Saved Project conversation'); await page.getByRole('button', { name: 'Save title', exact: true }).click();
    const projectToggle = page.getByRole('button', { name: 'Chat smoke Project', exact: true });
    if (await projectToggle.getAttribute('aria-expanded') === 'false') await projectToggle.click();
    await page.getByRole('button', { name: 'Saved Project conversation', exact: true }).waitFor();
    await mkdir(resolve('artifacts'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/chat.png') });
    // Separate personal chat, using BYOK against the local fixture to prove key handling.
    const byok = await page.evaluate(async endpoint => {
      const current = await window.tinygpt.snapshot();
      const saved = await window.tinygpt.saveSettings({ ...current.value.settings, route: 'byok', byok: { provider: 'custom', protocol: 'openai-compatible', endpoint, model: 'chat-fixture' } });
      if (!saved.ok) return saved;
      return window.tinygpt.saveSecret('byok', 'fixture-only-byok-key');
    }, endpoint); assert.equal(byok.ok, true);
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A personal chat'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); library = await idle(page); await page.getByText('Fixture streaming answer.', { exact: true }).waitFor();
    const personal = await selected(page, library.lastConversationId); assert.equal(personal.projectId, null); assert.equal(requests.at(-1).body.messages.length, 2);
    assert.equal(requests.at(-1).body.messages[0].content.includes('BLUEBIRD'), false); assert.equal(requests.at(-1).authorization, 'Bearer fixture-only-byok-key');
    await page.getByRole('button', { name: 'Delete chat', exact: true }).click(); await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
    const removed = await page.evaluate(id => window.tinygpt.conversation(id), personal.id); assert.equal(removed.ok, false);
    // Oversized legacy history now recovers through automatic compaction.
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Create oversized context fixture'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    library = await idle(page);
    const requestCount = requests.length;
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue this conversation'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.locator('[data-slot="context-optimization"]').first().waitFor(); library = await idle(page);
    assert.ok(requests.length > requestCount); assert.equal((await selected(page, library.lastConversationId)).messages.length, 4);
    assert.ok(JSON.stringify(requests.at(-1).body.messages).length < 6000);
    assert.equal(disconnected >= requests.length - 1, true); assert.deepEqual(errors, []);
    console.log('Chat smoke passed: actual LibreChat in Electron, streaming, stop/retry, provider errors, restart/context, Project instructions/folder, BYOK/local, rename/delete, scope isolation, and automatic context optimization.');
  } finally {
    if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
