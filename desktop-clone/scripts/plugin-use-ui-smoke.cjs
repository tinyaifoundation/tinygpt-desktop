// Isolated real desktop/worker acceptance; synthetic provider and Gmail only.
const { _electron } = require('playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const assert = require('node:assert/strict');
async function main() {
  let app, page, calls = 0; const errors = [];
  const profile = resolve('.tools-smoke-profile', `plugin-use-${Date.now()}`);
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.end(JSON.stringify({ data: [{ id: 'plugin-use-fixture', context_length: 65536 }] })); return; }
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); const n = ++calls;
    const frame = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ id: `plugin-use-fixture-${n}`, object: 'chat.completion.chunk', model: 'plugin-use-fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const finish = text => response.end(frame({ role: 'assistant', content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n');
    if (JSON.stringify(body.messages).includes('Describe a saved conversation')) return finish('{"title":"Plugin permission","summary":"Synthetic Gmail permission check","topicChanged":false}');
    const lastUser = body.messages.map((message, i) => ({ ...message, i })).filter(message => message.role === 'user').at(-1);
    const tools = body.messages.slice((lastUser?.i ?? -1) + 1).filter(message => message.role === 'tool'); const tail = tools.at(-1);
    if (tail && String(tail.content).includes('PLUGIN_USE_DENIED')) return finish('Gmail was not used.');
    if (tail && String(tail.content).includes('"emailAddress":')) return finish('Verified the synthetic Gmail account.');
    const tool = tail ? body.tools.find(tool => tool.function.name.startsWith('ext_') && tool.function.description.includes('Get the connected Gmail account'))?.function.name : 'load_tools';
    if (!tool) return finish('Fixture could not find the loaded Gmail action.');
    response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: `permission-call-${n}`, type: 'function', function: { name: tool, arguments: JSON.stringify(tail ? {} : { group: 'services', query: 'Gmail get_mail_profile' }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const bridge = async (name, ...args) => { const result = await page.evaluate(({ name, args }) => window.tinygpt[name](...args), { name, args }); assert.equal(result.ok, true, result.error); return result.value; };
  const idle = async () => { for (let n = 0; n < 400; n++) { if (!(await bridge('library')).activeRuns.length) return; await new Promise(done => setTimeout(done, 100)); } throw Error('Plugin permission fixture did not finish'); };
  const send = async text => { await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); };
  async function launch() {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile, TINYGPT_VOICE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env }); page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); }
      globalThis.syntheticMailReads = 0; const original = globalThis.fetch;
      globalThis.fetch = async (address, options) => { if (new URL(String(address)).hostname !== 'gmail.googleapis.com') return original(address, options); globalThis.syntheticMailReads++; return Response.json({ emailAddress: 'synthetic@example.org' }); };
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
  }
  const reads = () => app.evaluate(() => globalThis.syntheticMailReads);
  try {
    await launch(); const settings = (await bridge('snapshot')).settings;
    await bridge('saveSettings', { ...settings, mode: 'chat', route: 'byok', byok: { ...settings.byok, provider: 'custom', protocol: 'openai-compatible', model: 'plugin-use-fixture', endpoint: `http://127.0.0.1:${server.address().port}/v1`, contextWindowTokens: 65536, tools: true }, voice: { ...settings.voice, readAloud: { ...settings.voice.readAloud, enabled: false } }, toolPermissions: { ...settings.toolPermissions, read: 'ask' } });
    await bridge('saveSecret', 'byok', 'synthetic-provider-only');
    const snapshot = await bridge('installConnector', 'gmail'); const gmail = snapshot.entries.find(entry => entry.manifest.connector === 'gmail');
    await bridge('pluginCredentials', gmail.id, { bearer: 'synthetic-mail-only' }); await bridge('connectPlugin', gmail.id); await page.reload();
    const before = await reads(); await send('Check my Gmail account.');
    let card = page.locator('[data-slot="permission-grant"][data-plugin-use="true"]'); await card.waitFor();
    assert.equal(await reads(), before); assert.equal(await page.locator('[data-slot="permission-grant"]').count(), 1);
    await card.locator('[data-connector="gmail"]').waitFor();
    await mkdir(resolve('artifacts/plugin-use'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/plugin-use/ask.png') });
    await card.getByRole('button', { name: 'Allow Gmail in this chat', exact: true }).click(); await idle();
    await page.getByText('Allowed in this chat', { exact: true }).waitFor(); assert.equal(await reads(), before + 1);
    await send('Check Gmail again.'); await idle(); assert.equal(await reads(), before + 2); assert.equal(await page.locator('[data-slot="plugin-use-card"]').count(), 1);
    await page.screenshot({ path: resolve('artifacts/plugin-use/allowed.png') });
    await app.close(); app = null; await launch(); card = page.locator('[data-slot="permission-grant"][data-plugin-use="true"]'); await bridge('connectPlugin', gmail.id); await send('Check Gmail after restart.'); await idle(); assert.equal((await bridge('library')).approvals.length, 0); assert.equal(await reads(), 2);
    await bridge('createConversation', null); await page.reload(); const beforeDeny = await reads(); await send('Check Gmail in a separate chat.'); await card.waitFor();
    await card.getByRole('button', { name: 'Not now', exact: true }).click(); await idle(); assert.equal(await reads(), beforeDeny); await page.getByText('Not allowed', { exact: true }).waitFor();
    await page.screenshot({ path: resolve('artifacts/plugin-use/denied.png') });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['standard composer approval with Gmail logo', 'no read before consent', 'no duplicate action prompt for read', 'one approval across turns and restart', 'new chat asks separately', 'decline prevents reads', 'renderer error-free'], calls }));
  } catch (error) { if (page) { console.log(await page.evaluate(() => document.body.innerText).catch(() => 'No fixture page')); await page.screenshot({ path: resolve('artifacts/plugin-use/failure.png') }).catch(() => {}); } throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
