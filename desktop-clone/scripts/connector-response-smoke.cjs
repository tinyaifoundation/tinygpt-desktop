const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let app, releaseAnswer, answerRequested = false;
  const answerGate = new Promise(done => { releaseAnswer = done; });
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'connector-fixture', context_length: 64000, supports_tool_calling: true }] }));
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'connector-response', object: 'chat.completion.chunk', model: 'connector-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const finish = text => res.end(frame({ role: 'assistant', content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n');
    if (JSON.stringify(body.messages).includes('Describe a saved conversation')) return finish(JSON.stringify({ title: 'Connector response fixture', summary: 'Checking connector continuation controls.', topicChanged: false }));
    const tail = [...body.messages].reverse().find(m => m.role === 'tool' || m.role === 'user');
    if (tail?.role === 'tool') {
      if (tail.name === 'request_plugin_connection' || String(tail.content).includes('plugin-connection-request')) return finish('Connect Gmail and I will continue checking your inbox.');
      answerRequested = true; await answerGate; return finish('Here is the inbox triage after connecting Gmail.');
    }
    if (!String(tail?.content).includes('emails for action items') && !String(tail?.content).includes('explicitly connected')) return finish('This is a separate answer.');
    const gmail = body.tools?.find(tool => tool.function.name.startsWith('ext_') && tool.function.description.includes('Find up to 20 Gmail'));
    const name = gmail?.function.name ?? 'request_plugin_connection';
    const args = gmail ? { query: 'newer_than:1d', __tinygpt_status: 'Checking your inbox', __tinygpt_approval: 'May I check your morning emails?' } : { connector: 'gmail', reason: 'Read your morning emails and identify action items.' };
    res.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_email', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `connector-response-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) { w.setPosition(-10000, -10000); w.setIgnoreMouseEvents(true); w.webContents.setBackgroundThrottling(false); w.showInactive(); }
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => String(url).startsWith('https://gmail.googleapis.com/') ? new Response(JSON.stringify(String(url).endsWith('/profile') ? { emailAddress: 'fixture@example.org' } : { messages: [{ id: 'fixture-message', threadId: 'fixture-thread' }] }), { headers: { 'content-type': 'application/json' } }) : nativeFetch(url, options);
    });
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      const saved = await window.tinygpt.saveSettings({ ...settings, mode: 'chat', local: { ...settings.local, endpoint, model: 'connector-fixture', tools: true }, toolPermissions: { ...settings.toolPermissions, read: 'ask' } });
      if (!saved.ok) throw Error(saved.error);
      const used = await window.tinygpt.useLocalModel(endpoint, 'connector-fixture'); if (!used.ok) throw Error(used.error);
    }, `http://127.0.0.1:${server.address().port}/v1`);
    const idle = async previous => {
      for (let i = 0; i < 200; i++) {
        const ready = await page.evaluate(async previous => {
          const library = (await window.tinygpt.library()).value; if (!library.lastConversationId) return false;
          const conversation = (await window.tinygpt.conversation(library.lastConversationId)).value;
          const latest = conversation.messages.at(-1);
          return latest?.role === 'assistant' && latest.id !== previous && latest.status === 'complete' && !library.activeRuns.length;
        }, previous);
        if (ready) return;
        await page.waitForTimeout(100);
      }
      throw Error('Connector response did not finish.');
    };
    const snapshot = () => page.evaluate(async () => { const library = (await window.tinygpt.library()).value; return (await window.tinygpt.conversation(library.lastConversationId)).value; });
    const actions = page.locator('[data-slot="answer-actions"]');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Check my emails for action items this morning.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await idle(null);
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
    assert.equal(await actions.count(), 0, 'Waiting for a connector is not a finished answer.');
    // Keep three versions to verify the original branch picker moves to the end.
    for (let i = 0; i < 2; i++) {
      const before = await snapshot();
      const result = await page.evaluate(id => window.tinygpt.retryMessage(id), before.id); assert.equal(result.ok, true, result.error);
      await idle(before.messages.at(-1).id); assert.equal(await actions.count(), 0);
    }
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Use an access token instead', exact: true }).click();
    await page.getByRole('textbox', { name: 'Connector access token', exact: true }).fill('fixture-local-token');
    await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('dialog', { name: 'Connect Gmail' }).waitFor({ state: 'hidden' });
    await page.getByRole('region', { name: 'Tool approval' }).waitFor();
    assert.equal(await actions.count(), 0, 'No controls between the connector and resumed tool approval.');
    const library = (await page.evaluate(() => window.tinygpt.library())).value;
    await page.evaluate(id => window.tinygpt.approveTool(id, 'allow-once'), library.approvals[0].id);
    for (let i = 0; i < 200 && !answerRequested; i++) await page.waitForTimeout(50);
    assert.equal(answerRequested, true); assert.equal(await actions.count(), 0, 'No controls while the continuation is running.');
    const pending = await snapshot(); releaseAnswer(); await idle(pending.messages.at(-2).id); await actions.waitFor();
    const complete = await snapshot();
    assert.equal(complete.messages.filter(m => m.role === 'user').length, 1);
    assert.equal(complete.messages.filter(m => m.role === 'assistant').length, 2);
    assert.equal(await actions.count(), 1);
    assert.equal(await actions.evaluate(e => e.closest('[data-message-id]').dataset.messageId), complete.messages.at(-1).id);
    assert.match(await actions.locator('[data-slot="message-branches"]').innerText(), /3\s*\/\s*3/);
    await page.screenshot({ path: resolve('artifacts/connector-response-complete.png') });
    await actions.getByRole('button', { name: 'Show previous response', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor(); assert.equal(await actions.count(), 0);
    await page.getByRole('button', { name: 'Not now', exact: true }).click(); await actions.waitFor();
    assert.match(await actions.locator('[data-slot="message-branches"]').innerText(), /2\s*\/\s*3/);
    await actions.getByRole('button', { name: 'Show next response', exact: true }).click();
    await page.getByText('Here is the inbox triage after connecting Gmail.', { exact: true }).waitFor(); assert.equal(await actions.count(), 1);
    await page.reload(); await actions.waitFor(); assert.equal(await actions.count(), 1, 'Grouping survives reload.');
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A separate question.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await idle(complete.messages.at(-1).id);
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="answer-actions"]').length === 2);
    assert.deepEqual(errors, []);
    console.log('Passed: connector pause, three response versions, resumed tool approval, running continuation, one final control row, version switching/dismissal, persistence, separate follow-up.');
  } catch (e) { if (app) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/connector-response-failure.png') }).catch(() => {}); } throw e; }
  finally { releaseAnswer(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
