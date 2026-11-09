// Real Pro runtime check. Downloads weights only with --download-pro.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, '.tools-smoke-profile', 'builtins');
const runtime = path.join(profile, 'runtime');
fs.mkdirSync(runtime, { recursive: true });
const output = path.join(profile, 'managed-local.cjs');
createRequire(require.resolve('vite/package.json'))('esbuild').buildSync({ entryPoints: [path.join(root, 'src/main/managed-local.ts')], outfile: output, bundle: true, platform: 'node', format: 'cjs' });
const { ManagedLocalModel, managedLocalPins } = require(output);
const service = new ManagedLocalModel(path.join(profile, 'pro'), undefined, 'pro', runtime);
const artifacts = path.join(root, 'artifacts');
const proof = { checkedAt: new Date().toISOString(), model: 'TinyGPT Pro' };

async function main() {
  if (!(await service.installedStatus()).installed && !process.argv.includes('--download-pro')) throw Error('Pro weights are not cached. Pass --download-pro to download 7.6 GB into the isolated smoke profile.');
  const existing = process.env.TINYGPT_RUNTIME_CACHE || path.join(process.env.APPDATA || '', 'tinygpt-desktop', 'local-models', 'minicpm5-2b');
  for (const pin of managedLocalPins.CUDA) {
    const from = path.join(existing, pin.name), to = path.join(runtime, pin.name);
    if (!fs.existsSync(to) && fs.existsSync(from)) { try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); } }
  }
  let previous = '';
  const timer = setInterval(() => {
    const state = service.status(), progress = state.total ? Math.floor((state.downloaded || 0) / state.total * 10) * 10 : '';
    const label = `${state.phase} ${progress}`;
    if (label !== previous) { previous = label; console.log(label); }
  }, 1000);
  try {
    const mtp = process.argv.includes('--mtp');
    const { endpoint, key } = await service.start(mtp);
    proof.mtp = mtp;
    const request = async (route, body) => {
      const response = await fetch(endpoint.replace(/\/v1$/, '') + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const value = await response.json();
      if (!response.ok) throw Error(`Runtime request failed (${response.status}): ${JSON.stringify(value).slice(0, 400)}`);
      return value;
    };
    const props = await request('/props');
    assert.equal(props.default_generation_settings.n_ctx, 65536);
    proof.context = 65536;
    const complete = async (messages, extra = {}) => request('/v1/chat/completions', { model: 'tinygpt-pro', messages, max_tokens: 1024, reasoning_effort: 'none', temperature: 0, ...extra });
    const ready = await complete([{ role: 'user', content: 'Reply with only the word READY.' }]);
    assert.match(ready.choices[0].message.content, /READY/);
    proof.completion = ready.choices[0].message.content;
    const tools = [{ type: 'function', function: { name: 'add', description: 'Add two numbers.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } } }];
    const messages = [{ role: 'user', content: 'Use add to calculate 17 plus 25, then report the result.' }];
    const first = await complete(messages, { tools, tool_choice: { type: 'function', function: { name: 'add' } } });
    const assistant = first.choices[0].message, call = assistant.tool_calls?.[0];
    assert.equal(call?.function.name, 'add');
    assert.deepEqual(JSON.parse(call.function.arguments), { a: 17, b: 25 });
    const answer = await complete([...messages, assistant, { role: 'tool', tool_call_id: call.id, content: '42' }], { tools, tool_choice: 'none' });
    assert.match(answer.choices[0].message.content, /42/);
    proof.toolRoundTrip = answer.choices[0].message.content;
    if (mtp) {
      const sample = await complete([{ role: 'user', content: 'Write a TypeScript merge sort implementation and explain its runtime.' }], { max_tokens: 256 });
      assert.ok(sample.timings?.draft_n > 0 && sample.timings?.draft_n_accepted > 0, 'MTP must draft and accept tokens.');
      proof.speculation = sample.timings;
    }
    if (process.argv.includes('--long-context')) {
      const block = 'This record has no access code.\n'.repeat(3200);
      const content = `Find the access code in the reference. Reply only with that code.\n${block}\nACCESS CODE: ORCHID-4729\n${block}`;
      const tokens = await request('/tokenize', { content });
      assert.ok(tokens.tokens.length > 40000 && tokens.tokens.length < 63000);
      const long = await complete([{ role: 'user', content }], { max_tokens: 64 });
      assert.match(long.choices[0].message.content, /ORCHID-4729/);
      proof.longContext = { inputTokens: tokens.tokens.length, answer: long.choices[0].message.content };
    }
    console.log(JSON.stringify(proof, null, 2));
  } finally { clearInterval(timer); await service.stop(); }
  proof.stopped = service.status().phase === 'idle';
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(artifacts, 'built-in-pro-proof.json'), JSON.stringify(proof, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
