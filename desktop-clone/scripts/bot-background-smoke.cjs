const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { readFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
async function poll(read, timeout = 60000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await read()) return; await new Promise(done => setTimeout(done, 100)); } throw Error('Native background proof did not settle.'); }
async function main() {
  const profile = resolve('.tools-smoke-profile', `bot-background-${Date.now()}`); const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ data: [{ id: 'bot-fixture' }] })); return; }
    let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw); calls.push(body);
    assert.ok(['bot-fixture', 'bot-background-fixture'].includes(body.model)); assert.equal(request.headers.authorization, 'Bearer tinygpt-local');
    const users = JSON.stringify((body.messages ?? []).filter(message => message.role === 'user'));
    const result = (body.messages ?? []).some(message => message.role === 'tool'); const id = randomUUID();
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'bot-fixture', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}) })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (users.includes('BG_REPLY_PROOF')) { assert.equal(body.model, 'bot-background-fixture'); response.end(frame({ role: 'assistant', content: 'BOT_BACKGROUND_FINISHED' }) + frame({}, 'stop') + 'data: [DONE]\n\n'); return; }
    if (!result) {
      const tool = body.tools.find(tool => ['automations', 'cron'].includes(tool.function?.name)); assert.ok(tool, 'Native automation tool was not available');
      response.end(frame({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ action: 'add', job: { name: 'TinyGPT background proof', enabled: true, deleteAfterRun: true, schedule: { kind: 'at', at: new Date(Date.now() + 45000).toISOString() }, sessionTarget: 'isolated', payload: { kind: 'agentTurn', message: 'BG_REPLY_PROOF' }, delivery: { mode: 'none' } } }) } }] }) + frame({}, 'tool_calls') + 'data: [DONE]\n\n'); return;
    }
    console.log('Native schedule result:', (body.messages ?? []).filter(message => message.role === 'tool').at(-1)?.content);
    response.end(frame({ role: 'assistant', content: 'BOT_SCHEDULED_FINISHED' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile, TINYGPT_BOT_PROOF_DEBUG: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let desktop, page, stderr = ''; const errors = [];
  async function launch() { desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/bot-conversation-smoke-main.cjs')], env }); desktop.process().stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); }); page = await desktop.firstWindow(); page.on('pageerror', error => errors.push(error.message)); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); }
  try {
    await launch(); await page.evaluate(async endpoint => { const snapshot = (await window.tinygpt.snapshot()).value; const saved = await window.tinygpt.saveSettings({ ...snapshot.settings, route: 'local', local: { ...snapshot.settings.local, endpoint, model: 'bot-fixture', tools: true, contextWindowTokens: 64000 } }); if (!saved.ok) throw Error(saved.error); }, `http://127.0.0.1:${server.address().port}/v1`);
    const botId = await page.evaluate(async () => { const prepared = await window.tinygpt.prepareBot({ name: 'Milo', projectId: null }); if (!prepared.ok) throw Error(prepared.error); const status = (await window.tinygpt.botSnapshot()).value; const completed = await window.tinygpt.completeBot({ name: 'Milo', projectId: null, configuration: { ...status.configuration, background: true } }); if (!completed.ok) throw Error(completed.error); return completed.value.id; });
    await page.evaluate(async id => { const result = await window.tinygpt.sendMessage(id, 'BG_SCHEDULE_PROOF', []); if (!result.ok) throw Error(result.error); }, botId);
    await poll(() => page.evaluate(async id => !(await window.tinygpt.library()).value.activeRuns.some(run => run.conversationId === id), botId));
    const jobs = await page.evaluate(async () => { const result = await window.tinygpt.botJobs(); if (!result.ok) throw Error(result.error); return result.value; }); const job = jobs.find(job => job.name === 'TinyGPT background proof'); assert.ok(job, 'Native job did not persist');
    for (const action of ['pause', 'resume']) { const result = await page.evaluate(async ({ id, action }) => window.tinygpt.changeBotJob({ id, action }), { id: job.id, action }); assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.value.find(item => item.id === job.id).enabled, action === 'resume'); }
    const note = await page.evaluate(async () => window.tinygpt.saveBotNote({ file: 'SOUL.md', text: 'Be calm and thoughtful.\nBOT_PERSONA_PRESERVED' })); assert.equal(note.ok, true);
    const identity = await readFile(join(profile, 'bot-runtime', botId, 'workspace/IDENTITY.md'), 'utf8'); assert.match(identity, /Name:\*\* Milo/);
    await desktop.close(); desktop = null; await launch();
    await page.evaluate(async () => { const snapshot = (await window.tinygpt.snapshot()).value; const result = await window.tinygpt.saveSettings({ ...snapshot.settings, local: { ...snapshot.settings.local, model: 'bot-background-fixture' } }); if (!result.ok) throw Error(result.error); });
    const restored = await page.evaluate(async () => (await window.tinygpt.botSnapshot()).value); assert.equal(restored.configuration.background, true); assert.equal(restored.configuration.heartbeat, 'off');
    await poll(() => page.evaluate(async id => (await window.tinygpt.conversation(id)).value.messages.some(message => message.text === 'BOT_BACKGROUND_FINISHED' && message.status === 'complete'), botId), 150000);
    assert.equal(await readFile(join(profile, 'bot-runtime', botId, 'workspace/SOUL.md'), 'utf8'), 'Be calm and thoughtful.\nBOT_PERSONA_PRESERVED');
    assert.ok(calls.some(call => JSON.stringify(call.messages).includes('Milo'))); assert.deepEqual(errors, []);
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('button', { name: 'Bot', exact: true }).click(); await page.getByRole('textbox', { name: 'Bot personalization text', exact: true }).waitFor(); await page.screenshot({ path: resolve('artifacts/bot-native-settings.png') });
    console.log('Native background proof passed: native scheduling, pause/resume, restart recovery, current inference connection, saved background reply, native identity and preserved personalization; no paid calls.', calls.length);
  } catch (error) { console.error('Fixture failure:', stderr); throw error; } finally { await desktop?.close(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
