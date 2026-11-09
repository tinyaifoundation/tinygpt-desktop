// Isolated, cached-weight comparison. Never connects to or stops the desktop's server.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:net');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const cache = path.join(root, '.tools-smoke-profile/builtins');
const run = fs.mkdtempSync(path.join(root, '.tools-smoke-profile/pro-performance-'));
const bundle = path.join(run, 'managed.cjs');
createRequire(require.resolve('vite/package.json'))('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/managed-local.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
const { managedServerArgs, managedLocalPins, ManagedLocalModel } = require(bundle);
const runtime = path.join(cache, 'runtime/llama-b11960-CUDA');
const model = path.join(cache, 'pro', path.basename(new URL(managedLocalPins.pro.url).pathname));
const mtp = path.join(cache, 'pro', path.basename(new URL(managedLocalPins.proMtp.url).pathname));
const key = randomBytes(32).toString('hex'), keyFile = path.join(run, 'server.key');
fs.writeFileSync(keyFile, key);
const requested = process.argv.find(x => x.startsWith('--variants='))?.slice(11).split(',');
const reportName = process.argv.find(x => x.startsWith('--report='))?.slice(9) || 'pro-performance-proof.json';
assert.equal(path.basename(reportName), reportName, 'Report must be a filename in artifacts.');
const variants = [
  ['baseline', { cacheMiB: 512 }], ['cache', { cacheMiB: 4096 }],
  ['sampling', { cacheMiB: 4096, backendSampling: true }],
  ['concurrency', { cacheMiB: 4096, graphConcurrency: true }],
  ['combined', { cacheMiB: 4096, backendSampling: true, graphConcurrency: true }],
  ['ubatch128', { cacheMiB: 4096, microbatch: 128 }], ['ubatch512', { cacheMiB: 4096, microbatch: 512 }],
  ['q4', { cacheMiB: 4096, cacheK: 'q4_0', cacheV: 'q4_0' }],
  ['mixed', { cacheMiB: 4096, cacheV: 'q4_0' }],
  ['mtp1', { cacheMiB: 4096, mtpModel: mtp, draftTokens: 1 }],
  ['mtp2', { cacheMiB: 4096, mtpModel: mtp, draftTokens: 2 }],
  ['mtp3', { cacheMiB: 4096, mtpModel: mtp, draftTokens: 3 }],
].filter(([name]) => !requested || requested.includes(name));
const proof = { checkedAt: new Date().toISOString(), runtime: 'b11960 CUDA 12.4', model: managedLocalPins.pro, run, variants: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert.ok(fs.existsSync(model), 'Cache Pro with built-in-model-smoke.cjs first.');
  if (process.argv.includes('--download-mtp')) {
    const pin = managedLocalPins.proMtp;
    const service = new ManagedLocalModel(path.join(cache, 'pro'), undefined, 'pro');
    let last = '';
    const timer = setInterval(() => { const s = service.status(); const next = `${s.phase} ${Math.floor((s.downloaded || 0) / (s.total || 1) * 10) * 10}%`; if (next !== last) { console.log('MTP', next); last = next; } }, 1000);
    try { await service.download(pin.url, mtp, pin.size, pin.sha256, new AbortController().signal, 'Pro prediction support'); } finally { clearInterval(timer); }
  }
  proof.hardware = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true }).trim();
  for (const [name, options] of variants) {
    if (options.mtpModel) assert.equal(fs.statSync(mtp).size, managedLocalPins.proMtp.size, 'Pass --download-mtp to cache prediction support.');
    const port = await new Promise((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const args = managedServerArgs(model, port, keyFile, 'CUDA', !!options.mtpModel, 'pro', undefined, options);
    const log = fs.openSync(path.join(run, `${name}.log`), 'w');
    const child = spawn(path.join(runtime, 'llama-server.exe'), args, { cwd: runtime, windowsHide: true, stdio: ['ignore', log, log], env: { ...process.env, GGML_CUDA_GRAPH_OPT: options.graphConcurrency ? '1' : '0', PATH: runtime + path.delimiter + process.env.PATH } });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const row = { name, options, samples: [] };
    console.log('Starting', name);
    try {
      child.on('error', error => { row.error = error.message; });
      const endpoint = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 180000;
      while (true) {
        if (child.exitCode !== null || row.error || Date.now() > deadline) throw Error(row.error || `Server ${name} failed to start. See its isolated log.`);
        try { if ((await fetch(endpoint + '/health', { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
        await sleep(300);
      }
      const complete = async (messages, extra = {}) => {
        const began = performance.now();
        const response = await fetch(endpoint + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000), body: JSON.stringify({ model: 'tinygpt-pro', messages, max_tokens: 160, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, temperature: 0, seed: 42, cache_prompt: true, ...extra }) });
        const value = await response.json();
        assert.ok(response.ok, `Completion failed: ${JSON.stringify(value).slice(0, 300)}`);
        return { elapsedMs: performance.now() - began, timings: value.timings, message: value.choices[0].message };
      };
      assert.match((await complete([{ role: 'user', content: 'Reply with exactly READY.' }])).message.content, /READY/);
      const prompts = ['Write a TypeScript implementation of stable merge sort with a comparator, then show tests for an empty array and duplicate keys.', 'Explain how a city can reduce summer heat using trees, roofs, street design, and water. Give practical examples.'];
      for (let repeat = 0; repeat < 3; repeat++) for (let task = 0; task < prompts.length; task++) {
        const sample = await complete([{ role: 'user', content: prompts[task] }]);
        row.samples.push({ task, repeat, ...sample });
      }
      const messages = [{ role: 'user', content: 'Remember the access code ORCHID-4729. Reply with READY.\n' + 'This reference entry has no other access code.\n'.repeat(800) }];
      const first = await complete(messages, { max_tokens: 16 });
      await complete([{ role: 'user', content: 'Reply with exactly INTERLUDE.' }], { max_tokens: 16 });
      const resumed = await complete([...messages, first.message, { role: 'user', content: 'What is the access code? Reply only with that code.' }], { max_tokens: 32 });
      assert.match(resumed.message.content, /ORCHID-4729/);
      row.cache = { first: first.timings, resumed: resumed.timings, resumedMs: resumed.elapsedMs };
      const tools = [{ type: 'function', function: { name: 'add', description: 'Add two numbers.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } }];
      const question = [{ role: 'user', content: 'Use add to calculate 17 plus 25.' }];
      const call = await complete(question, { tools, tool_choice: { type: 'function', function: { name: 'add' } } });
      assert.deepEqual(JSON.parse(call.message.tool_calls[0].function.arguments), { a: 17, b: 25 });
      const answer = await complete([...question, call.message, { role: 'tool', tool_call_id: call.message.tool_calls[0].id, content: '42' }], { tools, tool_choice: 'none' });
      assert.match(answer.message.content, /42/);
      row.toolRoundTrip = true;
      row.tokensPerSecond = row.samples.map(s => s.timings?.predicted_per_second);
      row.drafted = row.samples.reduce((n, s) => n + (s.timings?.draft_n || 0), 0);
      row.accepted = row.samples.reduce((n, s) => n + (s.timings?.draft_n_accepted || 0), 0);
      if (options.mtpModel) assert.ok(row.drafted > 0 && row.accepted > 0, 'MTP must actually draft and accept tokens.');
      console.log(JSON.stringify({ name, tokensPerSecond: row.tokensPerSecond, cache: row.cache, drafted: row.drafted, accepted: row.accepted }));
    } catch (error) { row.error = error.message; console.error(name, row.error); }
    finally { if (child.exitCode === null) child.kill(); await Promise.race([exited, sleep(5000)]); if (child.exitCode === null) { child.kill('SIGKILL'); await exited; } fs.closeSync(log); }
    proof.variants.push(row);
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts', reportName), JSON.stringify(proof, null, 2));
  }
  assert.ok(proof.variants.every(row => !row.error), 'One or more variants failed; see pro-performance-proof.json.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
