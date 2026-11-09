// End-to-end context management through the real Electron worker and SDK.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');

async function main() {
  let app; const bodies = []; const errors = [];
  const longAnswer = 'Prior evidence with requirements and preferences. '.repeat(2400);
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'context-fixture', context_length: 8192 }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); bodies.push(body);
    const summary = JSON.stringify(body.messages).includes('Write a concise conversation checkpoint');
    const latest = body.messages.filter(message => message.role === 'user').at(-1)?.content;
    const answer = summary ? 'Goal: BLUEBIRD. The prior evidence was reviewed. Keep replies concise and continue the task.' : latest === 'Create long history' ? longAnswer : 'BLUEBIRD is the saved goal.';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) => JSON.stringify({ id: 'chatcmpl-context', object: 'chat.completion.chunk', created: 1, model: 'context-fixture', choices: [{ index: 0, delta, finish_reason }] });
    setTimeout(() => response.end(`data: ${frame({ role: 'assistant', content: answer })}\n\ndata: ${frame({}, 'stop')}\n\ndata: [DONE]\n\n`), summary ? 300 : 20);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `context-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  env.TINYGPT_VOICE_PROFILE = env.TINYGPT_TOOLS_PROFILE;
  async function bridge(page, method, ...args) { const result = await page.evaluate(({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function launch() {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); return page;
  }
  async function idle(page) { for (let i = 0; i < 400; i++) { if (!(await bridge(page, 'library')).activeRuns[0]) return; await new Promise(done => setTimeout(done, 100)); } throw new Error('Context fixture did not finish'); }
  async function prompt(page, text) { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
  try {
    let page = await launch(); const snapshot = await bridge(page, 'snapshot');
    await bridge(page, 'saveSettings', { ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint, model: 'context-fixture', contextWindowTokens: 8192, tools: false } });
    await page.reload();
    await prompt(page, 'Create long history'); await idle(page);
    await prompt(page, 'What is the BLUEBIRD goal?');
    const activity = page.locator('[data-slot="context-optimization"]'); await activity.first().waitFor({ timeout: 30000 });
    assert.equal(await activity.first().locator('xpath=ancestor::*[contains(@class,"tool-chain")]').count(), 0);
    assert.equal(await activity.first().locator('svg.solar-revote-linear').count(), 1);
    assert.match(await activity.first().innerText(), /Automatically optimizing conversation/);
    await mkdir(resolve('artifacts'), { recursive: true });
    await page.screenshot({ path: resolve('artifacts/context-optimizing.png') });
    await idle(page);
    const completedActivity = page.locator('[data-slot="context-optimization"][data-status="complete"]').first();
    await completedActivity.waitFor();
    assert.equal(await completedActivity.innerText(), 'Optimized the conversation');
    assert.equal(await completedActivity.locator('svg.solar-revote-linear').count(), 1);
    assert.equal(await completedActivity.locator('.shimmer').count(), 0);
    await page.screenshot({ path: resolve('artifacts/context-optimized.png') });
    const library = await bridge(page, 'library'); const id = library.lastConversationId;
    const conversation = await bridge(page, 'conversation', id);
    assert.equal(conversation.messages[1].text, longAnswer); assert.equal(conversation.tools.length, 0);
    assert.equal(conversation.messages.at(-1).text, 'BLUEBIRD is the saved goal.');
    assert.ok(JSON.stringify(bodies.at(-1).messages).length < 5000);
    const beforeRestart = bodies.length;
    await app.close(); app = null; page = await launch();
    await prompt(page, 'Keep it concise'); await idle(page);
    assert.equal(bodies.length, beforeRestart + 1); assert.match(JSON.stringify(bodies.at(-1).messages), /BLUEBIRD/);
    assert.ok(JSON.stringify(bodies.at(-1).messages).length < 5000);
    assert.deepEqual(errors, []);
    const { createTokenCounter } = await import('@librechat/agents');
    const { HumanMessage, AIMessage, SystemMessage } = await import('@librechat/agents/langchain/messages');
    const count = await createTokenCounter();
    const promptTokens = bodies.at(-1).messages.reduce((total, message) => total + count(message.role === 'system' ? new SystemMessage(message.content) : message.role === 'assistant' ? new AIMessage(message.content) : new HumanMessage(message.content)), 3);
    assert.ok(promptTokens < 2000);
    console.log(`Context smoke passed: bounded automatic compaction, standalone activity, saved originals, restart/checkpoint reuse. Follow-up prompt: approximately ${promptTokens} input tokens.`);
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
