const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const answerFirst = process.argv.includes('--answer-first');
  let finishAnswer, growInterface, finishInterface;
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'ui-order-fixture' }] }));
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const finished = body.messages.some(message => message.role === 'tool');
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'ui-order-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish) => response.write('data: ' + JSON.stringify(chunk(delta, finish)) + '\n\n');
    if (!finished) {
      if (answerFirst) emit({ role: 'assistant', content: 'The full feasibility analysis.' });
      emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'comparison', type: 'function', function: { name: 'present', arguments: '{"root":"card","elements":{"card":{"type":"Card","props":{"title":"Stable comparison"},"children":["table"]},"table":{"type":"Table","props":{"columns":[{"label":"Option"},{"label":"Cost"}],"rows":[' } }] });
      growInterface = () => emit({ tool_calls: [{ index: 0, function: { arguments: '["A","$10"],["B"' } }] });
      finishInterface = () => { emit({ tool_calls: [{ index: 0, function: { arguments: ',"$20"]]},"children":[]}}}' } }] }); emit({}, 'tool_calls'); response.end('data: [DONE]\n\n'); };
    } else {
      emit({ role: 'assistant', content: 'Choose option A.' });
      finishAnswer = () => { emit({ content: ' It costs less.' }); emit({}, 'stop'); response.end('data: [DONE]\n\n'); };
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', 'generative-order-' + Date.now()) }; env.TINYGPT_VOICE_PROFILE=env.TINYGPT_TOOLS_PROFILE;delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      await window.tinygpt.saveSettings({ ...settings, route: 'local', mode: 'chat', local: { ...settings.local, endpoint, model: 'ui-order-fixture', tools: true, contextWindowTokens: 16384 }, toolPermissions: { read: 'deny', write: 'ask', execute: 'ask', browser: 'ask', interact: 'ask' } });
    }, 'http://127.0.0.1:' + server.address().port + '/v1');
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Compare the costs.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Stable comparison', { exact: true }).waitFor();
    if (answerFirst) await page.getByText('The full feasibility analysis.', { exact: true }).waitFor();
    assert.equal(await page.locator('.chat-generative-ui[aria-busy="true"]').count(), 1, 'Interface is visible before its arguments finish');
    assert.equal(await page.evaluate(async () => (await window.tinygpt.library()).value.activeRuns.length), 1);
    await page.getByText('Stable comparison', { exact: true }).evaluate(node => { window.originalComparison = node; });
    // Leave each generation stage paused until its partial contents are painted.
    growInterface();
    await page.locator('.chat-generative-ui table tbody tr').first().waitFor();
    assert.equal(await page.locator('.chat-generative-ui table tbody tr').count(), 1, 'Complete rows render while the next row is incomplete');
    assert.equal(await page.locator('.chat-generative-ui[aria-busy="true"]').count(), 1);
    finishInterface(); finishInterface = undefined;
    await page.getByText('Choose option A.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await window.tinygpt.library()).value.activeRuns.length), 1, 'Final answer text is visible while the provider is still streaming');
    assert.equal(await page.locator('.chat-generative-ui table tbody tr').count(), 2);
    assert.equal(await page.getByText('Stable comparison', { exact: true }).evaluate(node => window.originalComparison === node), true, 'Widget survives preview-to-final without remounting');
    const assertOrder = async () => {
      const comparison = page.getByText('Stable comparison', { exact: true });
      const order = await comparison.evaluate(node => {
        const answer = node.closest('[data-slot="answer-text"]');
        const prose = [...answer.querySelectorAll('.chat-prose')].filter(prose => !prose.closest('.chat-generative-ui'));
        const footer = prose.at(-1);
        return { before: !footer || !!(node.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING), bodyBefore: prose.length > 1 && !!(prose[0].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING), count: answer.querySelectorAll('.chat-generative-ui').length };
      });
      assert.equal(order.before, true, 'Comparison stays ahead of the answer'); assert.equal(order.count, 1);
      if (answerFirst) { assert.equal(order.bodyBefore, true, 'Substantive answer stays ahead of the widget'); await page.getByText('The full feasibility analysis.', { exact: true }).waitFor(); }
    };
    await assertOrder();
    await page.screenshot({ path: resolve('artifacts/generative-order-streaming.png') });
    assert.ok(finishAnswer); finishAnswer();
    await page.waitForFunction(async () => !(await window.tinygpt.library()).value.activeRuns.length);
    await page.getByText('Choose option A. It costs less.', { exact: true }).waitFor();
    const saved = await page.evaluate(async () => { const library=(await window.tinygpt.library()).value; return (await window.tinygpt.conversation(library.conversations[0].id)).value.messages.at(-1); });
    assert.equal(saved.text, (answerFirst ? 'The full feasibility analysis.\n\n' : '') + 'Choose option A. It costs less.');
    if (answerFirst) assert.equal(saved.presentations[0].offset, 'The full feasibility analysis.'.length);
    await assertOrder();
    assert.equal(await page.getByText('Stable comparison', { exact: true }).evaluate(node => window.originalComparison === node), true, 'Widget is not remounted at completion');
    await page.screenshot({ path: resolve('artifacts/generative-order-complete.png') });
    await page.reload(); await page.getByText('Stable comparison', { exact: true }).waitFor(); await assertOrder();
    await page.screenshot({ path: resolve('artifacts/generative-order-restored.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ answerFirst, passed: ['partial interface paints before tool completion', 'answer text paints before turn completion', 'widget DOM identity and text/widget order survive preview, completion and reload', 'complete response text and widget offset saved'] }));
  } catch (error) { const page = await app.firstWindow(); console.error(await page.locator('body').innerText()); console.error(JSON.stringify(await page.evaluate(async () => { const library=(await window.tinygpt.library()).value; return window.tinygpt.conversation(library.conversations[0].id); }))); throw error; } finally { if (finishInterface) finishInterface(); if (finishAnswer) finishAnswer(); await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
