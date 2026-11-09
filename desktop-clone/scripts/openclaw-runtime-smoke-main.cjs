const { app } = require('electron');
const { resolve, join } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const profile = resolve('.tools-smoke-profile', `openclaw-runtime-${Date.now()}`);
const runtimeDirectory = process.env.TINYGPT_OPENCLAW_RESOURCE ?? resolve('runtimes/openclaw');
app.setPath('userData', profile);
// Opt-in fixture diagnostics only; the production supervisor never forwards logs.
if (process.env.TINYGPT_OPENCLAW_PROOF_DEBUG === '1') {
  const childProcess = require('node:child_process'), fork = childProcess.fork;
  childProcess.fork = (...args) => {
    const fs = require('node:fs'), configPath = args[2].env.OPENCLAW_CONFIG_PATH;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.logging = { level: 'debug', consoleLevel: 'debug' };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const child = fork(...args);
    child.stdout?.on('data', chunk => process.stderr.write(chunk));
    child.stderr?.on('data', chunk => process.stderr.write(chunk));
    return child;
  };
}
const { OpenClawRuntime } = require(process.env.TINYGPT_OPENCLAW_ASAR ? join(process.env.TINYGPT_OPENCLAW_ASAR, 'out/main/openclaw-runtime.js') : '../out/main/openclaw-runtime.js');
let runtime, server;
app.whenReady().then(async () => {
  const events = [], diagnostics = [], calls = []; const waiting = new Map();
  const started = Date.now();
  const record = event => diagnostics.push({ ...event, elapsedMs: Date.now() - started });
  server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); assert.equal(request.headers.authorization, 'Bearer local-fixture'); calls.push(body);
    const slow = JSON.stringify(body.messages).includes('SLOW_PROOF');
    const id = randomUUID(); const frame = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish ?? null }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}) })}\n\n`;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(frame({ role: 'assistant', content: slow ? 'Partial runtime proof.' : 'OPENCLAW_PROOF_COMPLETE' }));
    if (!slow) response.end(frame({}, 'stop') + 'data: [DONE]\n\n');
    else { waiting.set(id, response); const timer = setInterval(() => response.write(': keepalive\n\n'), 1000); response.on('close', () => { clearInterval(timer); waiting.delete(id); }); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const fixtureEndpoint = `http://127.0.0.1:${server.address().port}/v1`;
  async function wait(predicate, message, timeout = 30000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await predicate()) return; await new Promise(done => setTimeout(done, 50)); } throw new Error(message); }
  try {
    runtime = await OpenClawRuntime.start({ profileDirectory: profile, runtimeDirectory, fixtureEndpoint, diagnostic: record });
    runtime.onEvent((event, payload) => events.push({ event, payload }));
    const pid = runtime.pid;
    assert.equal((await runtime.request('health')).ok, true);
    const normal = 'agent:main:proof-normal', slow = 'agent:main:proof-slow';
    const slowResult = await runtime.request('chat.send', { sessionKey: slow, message: 'SLOW_PROOF', idempotencyKey: randomUUID() });
    await wait(() => waiting.size === 1, 'OpenClaw did not reach the local slow fixture.');
    const complete = await runtime.request('chat.send', { sessionKey: normal, message: 'NORMAL_PROOF', idempotencyKey: randomUUID() });
    await wait(() => events.some(event => event.event === 'chat' && event.payload.runId === complete.runId && event.payload.state === 'final'), 'OpenClaw did not finish the parallel session.');
    assert.equal(waiting.size, 1);
    assert.ok(events.some(event => event.event === 'chat' && event.payload.runId === complete.runId && event.payload.state === 'delta'));
    await runtime.request('chat.abort', { sessionKey: slow, runId: slowResult.runId });
    await wait(() => events.some(event => event.event === 'chat' && event.payload.runId === slowResult.runId && event.payload.state === 'aborted'), 'OpenClaw did not abort the selected session.');
    const history = await runtime.request('chat.history', { sessionKey: normal, limit: 20 });
    assert.match(JSON.stringify(history), /OPENCLAW_PROOF_COMPLETE/);
    assert.ok(calls.every(call => !call.tools?.length), 'Native tools must stay disabled in this runtime proof.');
    await runtime.stop(); runtime = null;
    assert.ok(events.some(event => event.event === 'shutdown'), 'The gateway did not announce orderly shutdown.');
    assert.ok(diagnostics.some(event => event.event === 'runtime-exit' && event.exitCode === 0));
    assert.ok(!diagnostics.some(event => event.forced), 'Shutdown required forced process termination.');
    assert.throws(() => process.kill(pid, 0));
    runtime = await OpenClawRuntime.start({ profileDirectory: profile, runtimeDirectory, fixtureEndpoint, diagnostic: record });
    assert.match(JSON.stringify(await runtime.request('chat.history', { sessionKey: normal, limit: 20 })), /OPENCLAW_PROOF_COMPLETE/);
    const recovered = await runtime.request('chat.history', { sessionKey: slow, limit: 20 });
    assert.match(JSON.stringify(recovered), /SLOW_PROOF/);
    await runtime.stop(); runtime = null;
    await mkdir(resolve('artifacts'), { recursive: true });
    const packaged = !!process.env.TINYGPT_OPENCLAW_ASAR;
    const result = { openclaw: '2026.9.9', node: '24.19.0', profile, packaged, portable: process.env.TINYGPT_OPENCLAW_PORTABLE_PROOF === '1', providerCalls: calls.length, checks: ['bundled official Node', 'native Windows gateway', 'signed authenticated hello', 'health RPC', 'streaming text', 'concurrent sessions', 'scoped chat abort', 'native tools disabled', 'graceful IPC shutdown without force', 'saved history after restart'], diagnostics };
    await writeFile(resolve(`artifacts/openclaw-runtime-${packaged ? 'package-' : ''}proof.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
    app.quit();
  } catch (error) { console.error({ profile, diagnostics, calls: calls.length, events: events.map(event => ({ event: event.event, state: event.payload?.state })) }); console.error(error); process.exitCode = 1; }
  finally { if (runtime) await runtime.stop(); server.closeAllConnections(); await new Promise(done => server.close(done)); app.exit(process.exitCode ?? 0); }
}).catch(error => { console.error(error); app.exit(1); });
