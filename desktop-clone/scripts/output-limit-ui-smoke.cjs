// Exercise the production worker and renderer with isolated, local-only fixtures.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');

async function main() {
  let app; let origin; let generation = 0; const requests = []; const errors = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/article') { response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<title>Local evidence</title><main>${'<p>Local evidence for scrollbar verification.</p>'.repeat(100)}</main>`); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const text = body.messages.filter(message => message.role === 'user').at(-1).content;
    const id = `chatcmpl-limit-${generation++}`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'limit-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const end = reason => { send({}, reason); response.end('data: [DONE]\n\n'); };
    if (text === 'Truncate answer') { send({ role: 'assistant', content: 'Partial fixture answer' }); end('length'); }
    else if (text.startsWith('Continue the interrupted answer') || text.startsWith('Continue the original task')) { send({ role: 'assistant', content: ' and completed.' }); end('stop'); }
    else if (text === 'Truncate tool') { send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_cutoff', type: 'function', function: { name: 'write_project_file', arguments: '{"path":"large.md","content":"unfinished' } }] }); end('length'); }
    else if (text === 'Inspect local evidence') {
      const toolCount = body.messages.filter(message => message.role === 'tool').length;
      if (!toolCount) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ url: `${origin}/article` }) } }] }); end('tool_calls');
      } else if (toolCount === 1) {
        send({ role: 'assistant', tool_calls: Array.from({ length: 10 }, (_, index) => ({ index, id: `call_search_${index}`, type: 'function', function: { name: 'search_sources', arguments: JSON.stringify({ query: 'Local evidence' }) } })) }); end('tool_calls');
      } else { send({ role: 'assistant', content: 'Toolchain fixture completed.' }); end('stop'); }
    } else { send({ role: 'assistant', content: 'Fixture answer.' }); end('stop'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `output-limit-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  async function bridge(page, method, ...args) { const result = await page.evaluate(({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function idle(page) { for (let i = 0; i < 300; i++) { const library = await bridge(page, 'library'); if (!library.activeRuns[0]) return library; await new Promise(done => setTimeout(done, 100)); } throw new Error('Fixture did not finish.'); }
  async function prompt(page, text) { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 30000 });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const snapshot = await bridge(page, 'snapshot');
    await bridge(page, 'saveSettings', { ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint: `${origin}/v1`, model: 'limit-fixture', tools: true, contextWindowTokens: 32768, maxOutputTokens: 12000 }, toolPermissions: { ...snapshot.settings.toolPermissions, browser: 'allow', read: 'allow' } });
    await page.reload(); await mkdir(resolve('artifacts'), { recursive: true });
    await prompt(page, 'Truncate answer'); let library = await idle(page);
    let saved = await bridge(page, 'conversation', library.lastConversationId); const original = saved.messages.at(-1);
    assert.equal(original.status, 'interrupted'); assert.equal(original.text, 'Partial fixture answer');
    await page.getByRole('status').filter({ hasText: 'output limit' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.screenshot({ path: resolve('artifacts/output-limit-recovery.png') });
    await page.getByRole('button', { name: 'Continue', exact: true }).click(); await idle(page);
    await page.getByText('Partial fixture answer and completed.', { exact: true }).waitFor();
    saved = await bridge(page, 'conversation', library.lastConversationId);
    assert.equal(saved.messages.at(-1).status, 'complete'); assert.equal(saved.messages.at(-1).continuationOf, original.id);
    assert.equal(saved.allMessages.find(message => message.id === original.id).status, 'interrupted');
    assert.equal(requests[0].max_tokens ?? requests[0].max_completion_tokens, 12000);
    await page.keyboard.press('Control+j'); await prompt(page, 'Truncate tool'); library = await idle(page);
    saved = await bridge(page, 'conversation', library.lastConversationId);
    assert.equal(saved.messages.at(-1).status, 'interrupted'); assert.equal(saved.tools.length, 0);
    await page.getByRole('status').filter({ hasText: 'incomplete call was not executed' }).waitFor();
    await page.keyboard.press('Control+j'); await prompt(page, 'Inspect local evidence'); await idle(page);
    await page.getByText('Toolchain fixture completed.', { exact: true }).waitFor();
    const chain = page.locator('.tool-chain'); await chain.locator(':scope > summary').click();
    assert.equal(await chain.locator('[data-tool-name=read_page] svg.lucide-scan-search').count(), 1);
    assert.equal(await chain.locator('[data-tool-name=search_sources] svg.lucide-search').count(), 10);
    await chain.locator('[data-tool-name=read_page] [data-tool-result-toggle]').click();
    const viewport = chain.locator('.tool-chain-scroll > [data-slot=scroll-area-viewport]');
    assert.equal(await viewport.evaluate(element => element.scrollHeight > element.clientHeight), true);
    await viewport.focus(); assert.equal(await viewport.evaluate(element => element === document.activeElement), true);
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.equal(await viewport.evaluate(element => element.scrollTop > 0), true);
    await chain.hover(); await chain.locator('.tool-chain-scroll > [data-slot=scroll-area-scrollbar] [data-slot=scroll-area-thumb]').waitFor({ state: 'visible' });
    await page.screenshot({ path: resolve('artifacts/toolchain-shadcn-scrollbar.png') });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Configuration', exact: true }).click();
    await page.getByText('Advanced conversation settings', { exact: true }).click();
    assert.equal(await page.getByLabel('Maximum output tokens', { exact: true }).inputValue(), '12000');
    assert.deepEqual(errors, []);
    console.log('Output-limit UI passed: saved partial answer, Continue, preserved original, configurable budget, blocked incomplete tool call, Search/ScanSearch icons, keyboard scrolling, and shadcn scrollbar.');
  } catch (error) {
    if (app) { const page = await app.firstWindow().catch(() => null); if (page) await page.screenshot({ path: resolve('artifacts/output-limit-ui-failure.png') }).catch(() => {}); }
    throw error;
  } finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
