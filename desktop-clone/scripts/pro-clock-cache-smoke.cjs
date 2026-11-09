// Synthetic native-cache regression. Own CPU-only server, never the app's GPU
// server, credentials, browser, conversation or inference queue.
const { buildSync } = require('esbuild');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { freemem } = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const profile = process.env.TINYGPT_PRO_LIVE_PROFILE;
if (!profile) throw Error('Set TINYGPT_PRO_LIVE_PROFILE to locate already downloaded weights.');
if (freemem() < 18 * 2 ** 30) throw Error('Insufficient spare RAM for an isolated CPU-only probe.');
const run = fs.mkdtempSync(path.join(root, '.tools-smoke-profile/pro-clock-cache-'));
for (const [name, file] of [['managed', 'src/main/managed-local.ts'], ['clock', 'src/core/runtime-context.ts']]) buildSync({ entryPoints: [path.join(root, file)], outfile: path.join(run, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const { managedLocalPins, managedServerArgs } = require(path.join(run, 'managed.cjs'));
const { withRuntimeContext, runtimeContextFetch } = require(path.join(run, 'clock.cjs'));
const modelRoot = path.join(profile, 'local-models/pro');
const file = pin => path.join(modelRoot, path.basename(new URL(pin.url).pathname));
for (const pin of [managedLocalPins.pro, managedLocalPins.proVision, managedLocalPins.proMtp]) assert.equal(fs.statSync(file(pin)).size, pin.size, 'Only existing pinned weights may be used.');
const runtime = path.join(profile, 'local-models/minicpm5-2b/llama-b11960-CUDA');
const key = randomBytes(32).toString('hex'), keyFile = path.join(run, 'server.key'); fs.writeFileSync(keyFile, key);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  const args = managedServerArgs(file(managedLocalPins.pro), port, keyFile, 'CPU', true, 'pro', file(managedLocalPins.proVision), { cacheMiB: 4096, mtpModel: file(managedLocalPins.proMtp) });
  for (const [key, value] of [['--ctx-size', '4096'], ['--threads', '2'], ['--spec-draft-ngl', '0']]) args[args.indexOf(key) + 1] = value;
  args.push('--threads-batch', '2', '--cache-prompt', '--log-verbosity', '5');
  const fd = fs.openSync(path.join(run, 'server.log'), 'w');
  const child = spawn(path.join(runtime, 'llama-server.exe'), args, { cwd: runtime, windowsHide: true, stdio: ['ignore', fd, fd] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const proof = { isolatedCpuOnly: true, productionWeightsProjectorAndMtp: true, contextTokens: 4096, threads: 2, run, results: [] };
  try {
    const base = `http://127.0.0.1:${port}`, headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const deadline = Date.now() + 120000;
    while (true) {
      if (child.exitCode !== null || Date.now() > deadline) throw Error('Isolated server did not become ready.');
      try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
      await delay(250);
    }
    const reference = 'A maple tree grows beside a quiet stream. Its leaves change color in autumn.\n'.repeat(36);
    const body = { model: 'tinygpt-pro', messages: [{ role: 'system', content: 'Read the reference and reply OK.' }, { role: 'user', content: reference }], max_tokens: 1, cache_prompt: true, temperature: 0, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
    const complete = async (name, payload, send = fetch) => {
      const response = await send(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error(`Synthetic completion failed with HTTP ${response.status}`);
      const result = await response.json(), t = result.timings;
      assert.ok(t, 'Native cache timings required');
      const row = { name, cacheTokens: t.cache_n, processedTokens: t.prompt_n, promptMs: t.prompt_ms, generationMs: t.predicted_ms };
      proof.results.push(row); console.log(JSON.stringify(row)); return result;
    };
    const firstClock = new Date('2026-11-05T15:00:01Z'), nextClock = new Date('2026-11-05T15:01:02Z');
    await complete('changing-clock-first', withRuntimeContext(body, 'chat/completions', firstClock, 'UTC'));
    await complete('changing-clock-next', withRuntimeContext(body, 'chat/completions', nextClock, 'UTC'));
    // Same public adapter used by the app; one instance per reply/worker chain.
    const stable = runtimeContextFetch(fetch, new Date('2026-11-05T16:00:01Z'), 'UTC');
    await complete('stable-clock-first', body, stable);
    const repeat = await complete('stable-clock-repeat', body, stable);
    await complete('stable-clock-tool-followup', { ...body, messages: [...body.messages, repeat.choices[0].message, { role: 'user', content: 'Reply OK again.' }] }, stable);
    assert.equal(proof.results[1].cacheTokens, 0, 'Changing a pre-user clock must reproduce the cache loss');
    assert.ok(proof.results[3].cacheTokens > 400, 'Stable header must reuse the reference');
    assert.ok(proof.results[3].processedTokens < proof.results[1].processedTokens / 5, 'Stable header must avoid full reprocessing');
    assert.ok(proof.results[4].cacheTokens > 400, 'Appending history must retain substantial prefix reuse');
    proof.verified = true;
    console.log('PASS: changing clock reproduces full prefill; the shared fixed-clock adapter restores native reuse, including appended history.');
  } finally {
    fs.writeFileSync(path.join(root, 'artifacts/pro-clock-cache-proof.json'), JSON.stringify(proof, null, 2));
    if (child.exitCode === null) child.kill(); await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } fs.closeSync(fd);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
