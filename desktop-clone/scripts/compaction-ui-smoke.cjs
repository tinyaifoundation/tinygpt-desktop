const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let app; let permanentFailure = false; let summaryCalls = 0; let generation = 0;
  const budgets = []; const errors = []; const oldText = 'Recorded BLUEBIRD evidence and decisions. '.repeat(5000);
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); const summary = JSON.stringify(body.messages).includes('Write a concise conversation checkpoint');
    const prompt = body.messages.filter(message => message.role === 'user').at(-1).content;
    const truncated = summary && (++summaryCalls === 1 || permanentFailure);
    if (summary) budgets.push(body.max_tokens ?? body.max_completion_tokens);
    const text = truncated ? 'NEVER SAVE THIS PARTIAL CHECKPOINT' : summary ? 'Goal BLUEBIRD. Preserve recorded decisions and outcomes.' : prompt.startsWith('Produce oversized history') ? oldText : 'BLUEBIRD preserved.';
    const id = `chatcmpl-compaction-${generation++}`;
    const frame = (delta, finish_reason) => JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'compaction-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${frame({ role: 'assistant', content: text }, null)}\n\ndata: ${frame({}, truncated ? 'length' : 'stop')}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `compaction-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  async function bridge(page, method, ...args) { const result = await page.evaluate(({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function idle(page) { for (let i = 0; i < 300; i++) { const library = await bridge(page, 'library'); if (!library.activeRuns[0]) return library; await new Promise(done => setTimeout(done, 100)); } throw new Error('Compaction fixture did not finish.'); }
  async function prompt(page, text) { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const snapshot = await bridge(page, 'snapshot');
    await bridge(page, 'saveSettings', { ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint, model: 'compaction-fixture', tools: false, contextWindowTokens: 32768 } }); await page.reload();
    await prompt(page, 'Produce oversized history'); let library = await idle(page); const id = library.lastConversationId;
    await prompt(page, 'What is the goal?'); await idle(page);
    let saved = await bridge(page, 'conversation', id);
    assert.equal(saved.messages.at(-1).status, 'complete'); assert.equal(saved.messages.at(-1).text, 'BLUEBIRD preserved.');
    assert.ok(summaryCalls >= 2); assert.equal(budgets[0], 4096); assert.ok(budgets[1] > budgets[0]);
    assert.equal(saved.messages[1].text, oldText); assert.ok(saved.contextActivities.some(activity => activity.status === 'complete'));
    assert.equal(JSON.stringify(saved).includes('NEVER SAVE'), false);
    await prompt(page, 'Produce oversized history again'); await idle(page);
    permanentFailure = true; const beforeFailure = summaryCalls;
    await prompt(page, 'Confirm the goal again'); await idle(page);
    saved = await bridge(page, 'conversation', id); const failed = saved.messages.at(-1);
    assert.equal(failed.status, 'error'); assert.match(failed.error, /Conversation optimization reached the model’s output limit/);
    assert.ok(summaryCalls - beforeFailure <= 2); assert.equal(saved.messages[1].text, oldText); assert.equal(JSON.stringify(saved).includes('NEVER SAVE'), false);
    await page.getByRole('alert').filter({ hasText: 'last valid checkpoint are preserved' }).waitFor();
    permanentFailure = false; await bridge(page, 'regenerateMessage', id, failed.id); await idle(page);
    saved = await bridge(page, 'conversation', id); assert.equal(saved.messages.at(-1).status, 'complete'); assert.equal(saved.messages.at(-1).text, 'BLUEBIRD preserved.');
    assert.deepEqual(errors, []);
    console.log('Compaction desktop check passed: separate generation budget, one larger retry, no partial checkpoint leakage, specific limit error through the worker, preserved history, and successful retry.');
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
