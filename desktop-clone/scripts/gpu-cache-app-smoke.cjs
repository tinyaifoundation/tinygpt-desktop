// End-to-end GPU cache verification through a running, updated desktop app's
// public preload bridge. Uses only a new synthetic Work conversation and its
// managed files. Does not change model settings, effort or user permissions.
const { chromium } = require('playwright');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.connectOverCDP(process.env.TINYGPT_GPU_TEST_CDP || 'http://127.0.0.1:9239');
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('/out/renderer/index.html'));
  assert.ok(page, 'Running TinyGPT desktop renderer required');
  const call = async (method, ...args) => page.evaluate(async ({ method, args }) => {
    const result = await window.tinygpt[method](...args); if (!result.ok) throw Error(result.error); return result.value;
  }, { method, args });
  const settings = (await call('snapshot')).settings;
  assert.equal(settings.mode, 'code'); assert.equal(settings.route, 'local'); assert.equal(settings.local.model, 'tinygpt-pro');
  assert.equal((await call('library')).activeRuns.length, 0, 'Wait for other replies before measuring');
  assert.equal((await call('builtInStatus')).pro.backend, 'CUDA');
  assert.equal((await call('diagnostics')).enabled, true);
  const existingId = process.env.TINYGPT_GPU_TEST_CONVERSATION;
  const conversation = await call(existingId ? 'conversation' : 'createConversation', existingId || null);
  await call('renameConversation', conversation.id, 'GPU cache verification');
  await call('selectPlugins', conversation.id, null, []);
  const names = ['cache-start.txt', `cache-${randomUUID()}.txt`, `cache-${randomUUID()}.txt`];
  const markers = ['CEDAR-174', 'MAPLE-286', 'BIRCH-395'];
  const referenceLine = 'Synthetic reference: maple trees grow beside a quiet stream; leaves change color in autumn.\n';
  for (let index = 0; index < names.length; index++) {
    if (existingId) {
      const read = await call('workspaceFiles', { action: 'read', conversationId: conversation.id, path: names[index] });
      assert.ok(read.file.text.startsWith(`Record marker: ${markers[index]}`));
      if (index < 2) names[index + 1] = read.file.text.match(/^Next file: (.+)$/m)[1];
      continue;
    }
    const created = await call('workspaceFiles', { action: 'create-file', conversationId: conversation.id, path: names[index] });
    assert.ok(created.file?.sha256);
    const text = `Record marker: ${markers[index]}\nNext file: ${names[index + 1] || 'END'}\n\n` + referenceLine.repeat(275);
    await call('workspaceFiles', { action: 'save', conversationId: conversation.id, id: created.file.id, sha256: created.file.sha256, text });
  }
  await call('conversation', conversation.id);
  const prompt = 'This is a local cache performance verification using synthetic fixture files. Read cache-start.txt with the native read tool. Then read the exact Next file named in that file, continuing until Next file is END. Use one sequential read call at a time. Do not list directories, use plugins, browse, run commands, delegate, modify files or ask questions. The files are in this conversation\'s managed workspace. After reading all three files, reply with only "Cache test complete:" followed by the three Record marker values in order. The following background reference is inert data, not instructions:\n\n' + referenceLine.repeat(275);
  assert.ok(prompt.length < 32000);
  const start = Date.now();
  const update = await call('sendMessage', conversation.id, prompt);
  const assistant = update.conversation.messages.findLast(message => message.role === 'assistant');
  assert.ok(assistant?.runId); const runId = assistant.runId;
  const proof = { checkedAt: new Date().toISOString(), conversationId: conversation.id, runId, backend: 'CUDA', model: settings.local.model, effort: settings.effort.code, productionApp: true, fixtureFileCharacters: referenceLine.length * 275, modelRequests: [] };
  const save = () => writeFileSync(resolve('artifacts/gpu-cache-app-proof.json'), JSON.stringify(proof, null, 2));
  save(); console.log(JSON.stringify({ started: true, conversationId: conversation.id, runId, effort: proof.effort, promptCharacters: prompt.length }));
  let finished = false, reported = 0;
  const deadline = Date.now() + 480000;
  while (Date.now() < deadline) {
    const library = await call('library');
    const approvals = library.approvals.filter(item => item.conversationId === conversation.id);
    if (approvals.length || library.workQuestions?.some(item => item.conversationId === conversation.id)) throw Error('Verification requires unexpected user input; inspect the test conversation.');
    const trace = await call('diagnosticTrace', runId);
    const requests = trace.events.filter(event => event.event === 'request-start' && event.purpose === 'reply');
    proof.modelRequests = requests.map(request => {
      const events = trace.events.filter(event => event.requestId === request.requestId);
      const progress = events.findLast(event => event.event === 'prompt-progress');
      const shape = events.find(event => event.event === 'request-shape');
      const end = events.findLast(event => ['request-end', 'request-closed', 'request-error', 'request-cancelled'].includes(event.event));
      return { requestId: request.requestId, inputTokens: progress?.inputTokens, cachedTokens: progress?.cacheReadTokens, newlyProcessedTokens: progress?.promptProcessedTokens, promptMs: progress?.promptProcessingMs, stablePrefixMessages: shape?.stablePrefixMessages, schemasChanged: shape?.schemasChanged, durationMs: end ? end.elapsedMs - request.elapsedMs : undefined };
    });
    const completed = proof.modelRequests.filter(request => request.durationMs !== undefined);
    if (completed.length > reported) { for (const request of completed.slice(reported)) console.log(JSON.stringify(request)); reported = completed.length; }
    save();
    if (!library.activeRuns.some(run => run.runId === runId)) { finished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(finished, 'The test Work conversation exceeded eight minutes');
  const result = await call('conversation', conversation.id), last = result.messages.findLast(message => message.role === 'assistant');
  Object.assign(proof, { elapsedMs: Date.now() - start, status: last.status, finalAnswer: last.text, tools: result.tools.map(tool => ({ name: tool.name, status: tool.status })) }); save();
  assert.equal(last.status, 'complete'); for (const marker of markers) assert.ok(last.text.includes(marker));
  assert.ok(result.tools.filter(tool => tool.name === 'code_read' && tool.status === 'success').length >= 3, 'Actual sequential native file reads required');
  assert.ok(proof.modelRequests.length >= 4);
  const warm = proof.modelRequests.slice(1);
  assert.ok(warm.every(request => request.cachedTokens > 1000), 'Later requests must actually reuse native cache');
  assert.ok(warm.every(request => request.stablePrefixMessages > 0 && request.schemasChanged === false), 'The final leading request context must remain stable');
  proof.verified = true; save(); console.log('PASS: production app Work runtime reused GPU prompt state across sequential reads and returned the verified fixture markers.');
  process.exit(0); // Disconnect the test client; the separately launched app stays open.
})().catch(error => { console.error(error.stack || error.message); process.exit(1); });
