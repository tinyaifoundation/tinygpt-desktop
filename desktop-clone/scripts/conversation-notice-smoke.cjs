const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let app, sequence = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'notice-fixture', context_length: 64000 }] }));
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
    const id = `notice-${++sequence}`;
    const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: 'notice-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (JSON.stringify(body.messages).includes('Describe a saved conversation')) return res.end(frame({ content: JSON.stringify({ title: 'Notice fixture', summary: 'Checking the revisit notice.', topicChanged: false }) }, 'stop') + 'data: [DONE]\n\n');
    res.write(frame({ role: 'assistant', content: 'Fixture answer.' }));
    await new Promise(done => setTimeout(done, 300)); res.end(frame({}, 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `notice-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) { w.setPosition(-10000, -10000); w.setIgnoreMouseEvents(true); w.webContents.setBackgroundThrottling(false); w.showInactive(); } });
    await page.evaluate(async endpoint => { const settings = (await window.tinygpt.snapshot()).value.settings; const saved = await window.tinygpt.saveSettings({ ...settings, mode: 'chat', local: { ...settings.local, endpoint, model: 'notice-fixture', tools: false } }); if (!saved.ok) throw Error(saved.error); const used = await window.tinygpt.useLocalModel(endpoint, 'notice-fixture'); if (!used.ok) throw Error(used.error); }, `http://127.0.0.1:${server.address().port}/v1`);
    const note = page.locator('[data-slot="conversation-notice"]');
    const currentChat = page.locator('.sidebar-chat-row').first();
    const idle = text => page.waitForFunction(async text => { const library = (await window.tinygpt.library()).value; const conversation = (await window.tinygpt.conversation(library.lastConversationId)).value; const latest = conversation.messages.at(-1); return conversation.messages.filter(m => m.role === 'user').at(-1)?.text === text && latest?.role === 'assistant' && latest.status === 'complete' && !library.activeRuns.length; }, text);
    const send = async text => { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); await note.waitFor({ state: 'detached' }); await idle(text); assert.equal(await note.count(), 0); };
    assert.equal(await note.count(), 0); await send('Check conversation notice');
    await currentChat.click(); assert.equal(await note.count(), 0, 'Selecting the already-open chat is not a revisit.');
    await page.getByRole('button', { name: 'Plugins library', exact: true }).click(); await currentChat.click(); await note.waitFor();
    const geometry = await note.evaluate(e => { const composer = document.querySelector('.composer').getBoundingClientRect(); const footer = e.closest('.composer-footer').getBoundingClientRect(); return { above: e.getBoundingClientRect().bottom <= composer.top, bottomGap: footer.bottom - composer.bottom }; });
    assert.equal(geometry.above, true); assert.ok(geometry.bottomGap < 16, 'No disclaimer space remains below the composer.');
    await page.screenshot({ path: resolve('artifacts/conversation-notice-revisit.png') });
    await send('Follow up after revisiting'); await page.waitForTimeout(400); assert.equal(await note.count(), 0);
    await page.getByRole('button', { name: 'New chat', exact: true }).click(); assert.equal(await note.count(), 0); await currentChat.click(); await note.waitFor();
    await page.screenshot({ path: resolve('artifacts/conversation-notice-return.png') });
    await send('Another follow up'); assert.deepEqual(errors, []);
    console.log('Conversation notice passed: new chat stays hidden, revisit shows above composer, sending hides through replies, active-chat reselect stays hidden, leave/return restores notice, composer sits lower.');
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
