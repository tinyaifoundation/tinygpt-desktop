// Real OpenClaw message boundaries with controlled local inference, no accounts.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { mkdir, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function main() {
  const profile = resolve('.tools-smoke-profile', `bot-bubbles-${Date.now()}`); await mkdir(profile, { recursive: true });
  let firstHeld, secondHeld, slowHeld, firstSent = false, app, page; const errors = [], responses = new Set();
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'bot-fixture' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const input = JSON.parse(raw), messages = input.messages ?? [], text = messages.filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); responses.add(response); response.on('close', () => responses.delete(response));
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: 'bot-bubbles-fixture', object: 'chat.completion.chunk', created: 1, model: 'bot-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const finish = value => response.end(frame({ content: value }) + frame({}, 'stop') + 'data: [DONE]\n\n');
    if (text.includes('BOT_SLOW_PROOF')) { response.write(frame({ role: 'assistant', content: 'Incomplete private draft.' })); slowHeld = response; return; }
    if (text.includes('BOT_NATIVE_MESSAGES')) {
      if (messages.some(message => message.role === 'tool')) { finish('NO_REPLY'); return; }
      response.end(frame({ role: 'assistant', tool_calls: ['Native first.', 'Native second.'].map((message, index) => ({ index, id: `native-send-${index}`, type: 'function', function: { name: 'message', arguments: JSON.stringify({ action: 'send', message }) } })) }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    if (!text.includes('BOT_BUBBLES_PROOF')) { response.write(frame({ role: 'assistant' })); finish('READY'); return; }
    if (!firstSent) {
      response.write(frame({ role: 'assistant', content: '[[reply_to_current]] <details><summary>First complete' }));
      firstHeld = () => { firstSent = true; response.end(frame({ content: ' message.</summary></details>', tool_calls: [{ index: 0, id: 'native-read-proof', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'probe.txt' }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); }; return;
    }
    assert.ok(messages.some(message => message.role === 'tool'), 'Expected completed native read before next message.');
    response.write(frame({ role: 'assistant', content: 'Second complete' })); secondHeld = () => finish(' message.');
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const poll = async (read, timeout = 120000) => { const until = Date.now() + timeout; while (Date.now() < until) { if (await read()) return; await delay(100); } throw Error('Bot message fixture timed out.'); };
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/bot-conversation-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const botId = await page.evaluate(async endpoint => {
      const bridge = window.tinygpt, settings = (await bridge.snapshot()).value.settings;
      const saved = await bridge.saveSettings({ ...settings, mode: 'bot', route: 'local', local: { ...settings.local, endpoint, model: 'bot-fixture', tools: true, contextWindowTokens: 64000 } }); if (!saved.ok) throw Error(saved.error);
      const setup = { name: 'Message fixture', projectId: null }; const prepared = await bridge.prepareBot(setup); if (!prepared.ok) throw Error(prepared.error);
      const completed = await bridge.completeBot(setup); if (!completed.ok) throw Error(completed.error); return completed.value.id;
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await writeFile(join(profile, 'bot-runtime', botId, 'workspace', 'probe.txt'), 'Verified fixture evidence.');
    await page.reload(); await page.locator('.bot-conversation-header').waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('BOT_BUBBLES_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await poll(() => !!firstHeld); await delay(600); assert.equal(await page.locator('.bot-message-incoming [data-slot="answer-text"]').count(), 0); await page.getByRole('status', { name: 'Bot is typing', exact: true }).waitFor();
    firstHeld(); await poll(() => !!secondHeld); await page.getByText('First complete message.', { exact: true }).waitFor(); await delay(600);
    assert.equal(await page.getByText('Second complete', { exact: true }).count(), 0);
    const first = page.locator('.bot-message-incoming').filter({ hasText: 'First complete message.' }), firstId = await first.getAttribute('data-message-id');
    assert.equal(await first.locator('[data-slot="answer-text"]').innerText(), 'First complete message.');
    await page.evaluate(id => { window.botRetractions = 0; window.botMessageObserver = new MutationObserver(() => { if (!document.querySelector(`[data-message-id="${id}"] [data-slot="answer-text"]`)) window.botRetractions++; }); window.botMessageObserver.observe(document.querySelector('.thread-viewport'), { childList: true, subtree: true }); }, firstId);
    const order = await page.evaluate(id => ({ first: document.querySelector(`[data-message-id="${id}"] [data-slot="answer-text"]`).getBoundingClientRect().bottom, typing: document.querySelector('[data-slot="bot-typing-bubble"]').getBoundingClientRect().top }), firstId); assert.ok(order.typing >= order.first);
    const live = (await page.evaluate(id => window.tinygpt.conversation(id), botId)).value; assert.deepEqual(live.messages.slice(1).map(message => [message.text, message.status]), [['First complete message.', 'complete'], ['', 'streaming']]);
    await page.screenshot({ path: resolve('artifacts/bot-bubbles-pending.png') }); secondHeld();
    await poll(() => page.evaluate(async id => !(await window.tinygpt.library()).value.activeRuns.some(run => run.conversationId === id), botId)); await page.getByText('Second complete message.', { exact: true }).waitFor();
    assert.equal(await first.getAttribute('data-message-id'), firstId); assert.equal(await page.evaluate(() => { window.botMessageObserver.disconnect(); return window.botRetractions; }), 0);
    const completed = (await page.evaluate(id => window.tinygpt.conversation(id), botId)).value; assert.deepEqual(completed.messages.slice(1).map(message => message.text), ['First complete message.', 'Second complete message.']); assert.equal(await page.locator('[data-slot="bot-typing-bubble"]').count(), 0);
    await page.reload(); await page.getByText('First complete message.', { exact: true }).waitFor(); await page.getByText('Second complete message.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('BOT_NATIVE_MESSAGES'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await page.getByText('Native first.', { exact: true }).waitFor(); await page.getByText('Native second.', { exact: true }).waitFor();
    await poll(() => page.evaluate(async () => !(await window.tinygpt.library()).value.activeRuns.length));
    const native = (await page.evaluate(id => window.tinygpt.conversation(id), botId)).value.messages; assert.deepEqual(native.slice(4).map(message => message.text), ['Native first.', 'Native second.']); assert.equal(await page.getByText('NO_REPLY', { exact: true }).count(), 0);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('BOT_SLOW_PROOF'); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await poll(() => !!slowHeld); await delay(600);
    assert.equal(await page.getByText('Incomplete private draft.', { exact: true }).count(), 0); await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await poll(() => page.evaluate(async () => !(await window.tinygpt.library()).value.activeRuns.length)); assert.equal(await page.getByText('Incomplete private draft.', { exact: true }).count(), 0);
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['real native complete-message delivery before next reply', 'no partial text streamed into Bot bubbles', 'markup and reply tags removed', 'typing below latest completed bubble', 'completed bubble ID never retracted', 'final reconciliation does not duplicate replies', 'reload persistence', 'native message tool creates two bubbles without a silent-control reply', 'Stop discards unfinished draft'], errors }));
  } catch (error) { if (page) { await page.screenshot({ path: resolve('artifacts/bot-bubbles-failure.png') }).catch(() => {}); console.log(await page.evaluate(async () => { const lib = (await window.tinygpt.library()).value; return { active: lib.activeRuns.length, bot: (await window.tinygpt.botSnapshot()).value, messages: lib.lastConversationId ? (await window.tinygpt.conversation(lib.lastConversationId)).value.messages.map(message => ({ role: message.role, text: message.text, status: message.status, error: message.error })) : [] }; }).catch(() => ({}))); } throw error; }
  finally { for (const response of responses) response.destroy(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
