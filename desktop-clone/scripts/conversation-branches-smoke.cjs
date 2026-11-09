const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');

async function main() {
  let app; let origin; let generation = 0; let firstAnswers = 0; const errors = []; const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/article') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Permission fixture</title><main><p>Verified permission evidence.</p></main>'); return; }
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'branches-fixture' }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const text = body.messages.filter(message => message.role === 'user').at(-1).content;
    const id = `chatcmpl-branch-${generation++}`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'branches-fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    const end = reason => { send({}, reason); response.end('data: [DONE]\n\n'); };
    if (text === 'Slow reply') { send({ role: 'assistant', content: 'Saved partial' }); const timer = setTimeout(() => { send({ content: ' completed too late' }); end('stop'); }, 15000); response.on('close', () => clearTimeout(timer)); }
    else if (text.startsWith('Continue the interrupted answer')) { send({ role: 'assistant', content: ' and continued.' }); end('stop'); }
    else if (text === 'Need permission' && !body.messages.some(message => message.role === 'tool')) { send({ role: 'assistant', tool_calls: [{ index: 0, id: 'permission_call', type: 'function', function: { name: 'read_page', arguments: JSON.stringify({ status: 'Checking the permission fixture', url: `${origin}/article` }) } }] }); end('tool_calls'); }
    else if (text === 'Need permission') { send({ role: 'assistant', content: `Verified evidence from [the permission fixture](${origin}/article).` }); end('stop'); }
    else { send({ role: 'assistant', content: text === 'First question' ? `First answer ${++firstAnswers}` : text === 'Rewritten question' ? 'Rewritten answer' : 'Follow-up answer' }); end('stop'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  const profile = resolve('.tools-smoke-profile', `branches-${Date.now()}`); const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
  async function bridge(page, method, ...args) { const result = await page.evaluate(({ method, args }) => window.tinygpt[method](...args), { method, args }); assert.equal(result.ok, true, result.error); return result.value; }
  async function idle(page) { for (let i = 0; i < 200; i++) { const library = await bridge(page, 'library'); if (!library.activeRuns[0]) return library; await new Promise(done => setTimeout(done, 100)); } throw new Error('Fixture did not finish.'); }
  async function prompt(page, text) { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
  async function launch() { app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 30000 }); const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); return page; }
  try {
    let page = await launch(); const snapshot = await bridge(page, 'snapshot'); await bridge(page, 'saveSettings', { ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint: `${origin}/v1`, model: 'branches-fixture', contextWindowTokens: 131072, tools: true }, toolPermissions: { ...snapshot.settings.toolPermissions, browser: 'ask' } }); await page.evaluate(dark => { if (dark) { const appearance = JSON.parse(localStorage.getItem('tinygpt-appearance-v4') || '{}'); appearance.theme = 'dark'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(appearance)); } }, process.argv.includes('--dark')); await page.reload();
    await prompt(page, 'First question'); let library = await idle(page); const id = library.lastConversationId;
    await prompt(page, 'Follow-up question'); await idle(page); await page.getByText('Follow-up answer', { exact: true }).waitFor();
    const firstUserId = (await bridge(page, 'conversation', id)).messages[0].id;
    const firstUser = page.locator(`[data-message-id="${firstUserId}"]`);
    const userOrder = await firstUser.evaluate(element => { const copy = element.querySelector('[aria-label="Copy message"]').getBoundingClientRect(); const time = element.querySelector('time').getBoundingClientRect(); return copy.right <= time.left; }); assert.equal(userOrder, true);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep my follow-up draft');
    await firstUser.getByRole('button', { name: 'Edit message', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit message', exact: true }).fill('Cancelled edit'); await firstUser.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Keep my follow-up draft');
    await firstUser.getByRole('button', { name: 'Edit message', exact: true }).click();
    const edit = page.getByRole('textbox', { name: 'Edit message', exact: true }); await edit.fill('Rewritten question');
    assert.equal(await firstUser.getByRole('button', { name: 'Dictate message', exact: true }).count(), 1);
    assert.equal(await firstUser.locator('[data-slot="edit-message"] p').count(), 0);
    const beforeSend = requests.length;
    await firstUser.getByRole('button', { name: 'Send', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Undo changes and send edit?', exact: true }); await confirmation.waitFor();
    assert.equal(requests.length, beforeSend);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await edit.inputValue(), 'Rewritten question');
    await mkdir(resolve('artifacts'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/message-edit-composer.png') });
    const editor = firstUser.locator('[data-slot="edit-message"]');
    assert.notEqual(await editor.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await editor.screenshot({ path: resolve(process.argv.includes('--dark') ? 'artifacts/message-edit-composer-dark.png' : 'artifacts/message-edit-composer-light.png') });
    await edit.press('Enter'); await confirmation.waitFor(); assert.equal(requests.length, beforeSend);
    await confirmation.screenshot({ path: resolve('artifacts/message-edit-confirmation.png') });
    await confirmation.getByRole('button', { name: 'Undo and send', exact: true }).click();
    await idle(page); await page.getByText('Rewritten answer', { exact: true }).waitFor(); assert.equal(await page.getByText('Follow-up answer', { exact: true }).count(), 0);
    assert.equal(requests.at(-1).messages.filter(message => message.role !== 'system').length, 1);
    if (process.argv.includes('--edit-only')) { assert.deepEqual(errors, []); console.log(JSON.stringify({ ok: true, checks: ['clean edit composer', 'microphone', 'cancel keeps draft', 'Send and Enter confirmation', 'no request before confirmation', 'saved message versions'] })); return; }
    await page.locator('[data-slot=message-branches]').getByRole('button', { name: 'Show previous response', exact: true }).click(); await page.getByText('Follow-up answer', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry reply', exact: true }).first().click(); await idle(page); await page.getByText('First answer 2', { exact: true }).waitFor(); assert.equal(await page.getByText('Follow-up answer', { exact: true }).count(), 0);
    await page.locator('[data-slot=message-branches]').last().getByRole('button', { name: 'Show previous response', exact: true }).click(); await page.getByText('Follow-up answer', { exact: true }).waitFor();
    await page.getByRole('navigation', { name: 'Conversation map', exact: true }).waitFor();
    const copy = page.getByRole('button', { name: 'Copy answer', exact: true }).last(); assert.equal(await copy.getAttribute('title'), null); await page.getByRole('textbox', { name: 'Message', exact: true }).hover(); await copy.hover();
    try { await page.locator('[data-slot=tooltip-content]').filter({ hasText: 'Copy answer' }).waitFor({ timeout: 3000 }); } catch (error) { console.log('Tooltip diagnostic', await page.locator('body').evaluate(element => ({ tooltip: [...element.querySelectorAll('[role=tooltip], [data-slot=tooltip-content]')].map(item => ({ html: item.outerHTML, text: item.textContent })), trigger: element.querySelectorAll('[aria-label="Copy answer"]')[1]?.outerHTML }))); throw error; }
    await page.getByRole('textbox', { name: 'Message', exact: true }).hover();
    await prompt(page, 'Slow reply'); await page.getByText('Saved partial', { exact: true }).waitFor(); await page.getByLabel('Assistant is typing', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await idle(page); await page.locator('[data-slot="error-state"][data-tone="muted"]').waitFor();
    const partial = (await bridge(page, 'conversation', id)).messages.at(-1); assert.equal(partial.status, 'cancelled');
    await app.close(); page = await launch(); await page.getByText('Saved partial', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Continue', exact: true }).click(); await idle(page); await page.getByText('Saved partial and continued.', { exact: true }).waitFor();
    let saved = await bridge(page, 'conversation', id); assert.equal(saved.allMessages.find(message => message.id === partial.id).text, 'Saved partial'); assert.equal(saved.messages.at(-1).continuationOf, partial.id);
    await prompt(page, 'Slow reply'); await page.getByText('Saved partial', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await idle(page);
    await page.getByRole('button', { name: 'Discard', exact: true }).click(); await page.locator('[data-slot="error-state"][data-tone="muted"]').waitFor({ state: 'detached' });
    await prompt(page, 'Need permission'); const grant = page.locator('[data-slot=permission-grant]'); await grant.waitFor();
    const placement = await grant.evaluate(element => { const composer = document.querySelector('.composer'); return element.closest('.composer-footer') === composer.closest('.composer-footer') && element.getBoundingClientRect().bottom <= composer.getBoundingClientRect().top; }); assert.equal(placement, true);
    await grant.getByRole('button', { name: 'Allow once', exact: true }).click(); await idle(page); await page.getByRole('button', { name: '1 source', exact: true }).waitFor();
    const row = page.locator('[data-slot=answer-actions]').last(); assert.equal(await row.getByRole('button', { name: 'Copy answer', exact: true }).getAttribute('title'), null); assert.equal(await row.getByRole('button', { name: 'Retry reply', exact: true }).getAttribute('title'), null); assert.equal(await row.getByRole('button', { name: 'More answer actions', exact: true }).getAttribute('title'), null);
    assert.equal(await row.evaluate(element => { const source = element.querySelector('[data-slot=sources]').getBoundingClientRect(); const controls = element.querySelector('[aria-label="Copy answer"]').getBoundingClientRect(); return controls.left >= source.right && Math.abs(controls.top + controls.height / 2 - source.top - source.height / 2) < 1; }), true);
    await mkdir(resolve('artifacts'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/conversation-branches.png') });
    saved = await bridge(page, 'conversation', id); const head = saved.headId; await app.close(); page = await launch(); assert.equal((await bridge(page, 'conversation', id)).headId, head);
    assert.deepEqual(errors, []); console.log(JSON.stringify({ ok: true, checks: ['user control ordering', 'edit/cancel draft preservation', 'saved edit and regenerate branches', 'earlier-turn context', 'branch follow-ups', 'conversation map', 'shadcn tooltips', 'typing/scroll anchor', 'stop/restart/continue', 'discard', 'composer permission grant', 'sources and actions share one row', 'branch persistence after restart'] }));
  } finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
