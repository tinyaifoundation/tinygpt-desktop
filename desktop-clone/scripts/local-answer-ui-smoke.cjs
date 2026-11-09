// Real renderer + worker acceptance. Isolated profile, loopback fixture only.
const { _electron } = require('playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  let app, page, calls = 0, release; const errors = [];
  let scenario = 'clean'; let terminal = false;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'local-answer-fixture', context_length: 65536 }] })); return; }
    const body = JSON.parse(raw); calls++;
    const metadata = /title|summary/i.test(body.messages?.[0]?.content ?? '') && body.max_tokens < 2000;
    const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: `local-answer-${calls}`, object: 'chat.completion.chunk', model: 'local-answer-fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (metadata) { response.end(frame({ role: 'assistant', content: '{"title":"Fixture","description":"Synthetic acceptance"}' }) + frame({}, 'stop') + 'data: [DONE]\n\n'); return; }
    response.write(frame({ role: 'assistant', reasoning_content: 'Checking the synthetic evidence.' }));
    response.write(frame({ role: 'assistant', content: scenario === 'clean' ? 'Verified priority list.' : scenario === 'boundary' ? 'UNPUBLISHED WORKING NOTES\n</thi' : 'UNFINISHED OUTPUT MUST STAY HIDDEN' }));
    if (scenario === 'clean') await new Promise(done => { release = done; });
    if (scenario === 'boundary') response.write(frame({ content: 'nk>\nMore unfinished notes.' }));
    terminal = true; response.end(frame({}, scenario.includes('truncated') ? 'length' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const bridge = async (name, ...args) => { const result = await page.evaluate(({ name, args }) => window.tinygpt[name](...args), { name, args }); assert.equal(result.ok, true, result.error); return result.value; };
  async function idle() { for (let n = 0; n < 400; n++) { if (!(await bridge('library')).activeRuns.length) return; await new Promise(done => setTimeout(done, 100)); } throw Error('Fixture did not finish'); }
  async function send(text) { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
  try {
    const profile = resolve('.tools-smoke-profile', `local-answer-${Date.now()}`);
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile, TINYGPT_VOICE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env, timeout: 30000 });
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const settings = (await bridge('snapshot')).settings;
    await bridge('saveSettings', { ...settings, mode: 'chat', effort: { ...settings.effort, chat: 'max' }, voice: { ...settings.voice, readAloud: { ...settings.voice.readAloud, enabled: false } }, route: 'local', local: { ...settings.local, endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-answer-fixture', tools: false, contextWindowTokens: 65536, maxOutputTokens: 8192, reasoningOverride: { kind: 'llamacpp', efforts: [], canDisable: true } } });
    await page.reload();
    await send('Return a synthetic priority list.');
    await page.getByText('Checking the synthetic evidence.', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(terminal, false); assert.equal(await page.getByText('Verified priority list.', { exact: true }).count(), 0);
    release(); await idle(); await page.getByText('Verified priority list.', { exact: true }).waitFor();
    await mkdir(resolve('artifacts/gmail-triage'), { recursive: true });
    await page.screenshot({ path: resolve('artifacts/gmail-triage/clean-local-answer.png') });
    for (const next of ['boundary', 'truncated']) {
      scenario = next; terminal = false;
      await bridge('createConversation', null); await page.reload();
      await send('Exercise the synthetic answer boundary.'); await idle();
      const library = await bridge('library'); const chat = await bridge('conversation', library.lastConversationId); const answer = chat.messages.at(-1);
      assert.equal(answer.text, ''); assert.equal(answer.status, next === 'truncated' ? 'interrupted' : 'error');
      assert.match(answer.error, next === 'truncated' ? /reply is incomplete/ : /clean final answer/);
      assert.equal(await page.getByText(/UNPUBLISHED WORKING NOTES|UNFINISHED OUTPUT MUST STAY HIDDEN/).count(), 0);
      await page.screenshot({ path: resolve(`artifacts/gmail-triage/${next}-local-answer.png`) });
    }
    scenario = 'cloud-truncated';
    const current = (await bridge('snapshot')).settings;
    await bridge('saveSettings', { ...current, route: 'byok', byok: { ...current.byok, provider: 'custom', protocol: 'openai-compatible', endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'partial-fixture', tools: false, maxOutputTokens: 8192, contextWindowTokens: 65536 } });
    await bridge('saveSecret', 'byok', 'synthetic-fixture-only');
    await bridge('createConversation', null); await page.reload(); await send('Exercise a saved partial reply.'); await idle();
    await page.getByText('Incomplete reply', { exact: true }).waitFor();
    const notices = page.locator('[data-slot="error-state"]');
    assert.match(await notices.first().innerText(), /Incomplete reply/);
    await page.screenshot({ path: resolve('artifacts/gmail-triage/incomplete-reply-notice.png') });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['thinking separate', 'answer held until terminal', 'clean final visible', 'misplaced marker rejected', 'truncated answer withheld', 'renderer error-free'], calls }));
  } finally { release?.(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
