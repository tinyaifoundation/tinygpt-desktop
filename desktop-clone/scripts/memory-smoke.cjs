const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdir, writeFile, rename } = require('node:fs/promises');
const assert = require('node:assert/strict');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function main() {
  const stress = process.argv.includes('--stress'), distractors = stress ? 300 : 0;
  const profile = resolve('.tools-smoke-profile', `memory-run-${Date.now()}`);
  const root = resolve('.tools-smoke-profile', `memory-folder-${Date.now()}`);
  await mkdir(root, { recursive: true }); await mkdir(profile, { recursive: true });
  await writeFile(join(root, 'release.md'), '# Production releases\nTwo maintainers must authorize production deployment. A release is approved only after both maintainers sign off.');
  await writeFile(join(root, 'hours.md'), '# Opening hours\nThe office opens at nine in the morning and closes at five in the afternoon.');
  await writeFile(join(root, 'travel.md'), '# Travel policy\nRail travel is reimbursed when the employee submits the receipt.');
  await writeFile(join(root, '.env'), 'Do not index this secret.');
  for (let i = 0; i < distractors; i++) await writeFile(join(root, `case-${String(i).padStart(4, '0')}.md`), `# Archived support case ${i}\n${Array.from({ length: 8 }, (_, j) => `Case ${i}-${j}: ${['parcel delivery', 'office inventory', 'beta testing', 'supplier invoice', 'customer return'][i % 5]} was reviewed. Reference ${((i + 1) * (j + 37) * 14731).toString(16)}. Quantity ${i % 97}. This historical case does not change company policy.`).join('\n')}`);
  const prompts = []; const errors = []; let desktop;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const bytes of request) body += bytes;
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    const input = JSON.parse(body); prompts.push(input);
    const citation = input.messages.map(message => message.content).join('\n').match(/tinygpt-source:[a-f0-9-]+/)?.[0];
    const answer = `The retrieved evidence is available${citation ? ` [Evidence](${citation})` : ''}.`;
    const event = (delta, finish = null) => JSON.stringify({ id: 'memory-fixture', object: 'chat.completion.chunk', created: 1, model: 'memory-fixture', choices: [{ index: 0, delta, finish_reason: finish }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${event({ role: 'assistant', content: answer })}\n\ndata: ${event({}, 'stop')}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  async function launch() {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs'), '--disable-features=CalculateNativeWinOcclusion'], env });
    const page = await desktop.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await desktop.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor(); return page;
  }
  try {
    let page = await launch();
    await desktop.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
    const project = await page.evaluate(async endpoint => {
      const snapshot = (await window.tinygpt.snapshot()).value;
      await window.tinygpt.saveSettings({ ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint, model: 'memory-fixture', tools: false } });
      const folder = (await window.tinygpt.chooseNewProjectFolder()).value;
      return (await window.tinygpt.createProject(`Memory ${Date.now()}`, '', false, folder.id)).value;
    }, `http://127.0.0.1:${server.address().port}/v1`);
    assert.ok(project.id);
    let automatic;
    for (let i = 0; i < 240; i++) {
      automatic = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value;
      const index = automatic.indexes.find(index => index.projectId === project.id);
      assert.equal(index.enabled, true, 'Granted Project folders index without a setup step');
      if (index.status === 'ready' && index.files === 3 + distractors) break;
      await delay(500);
    }
    assert.equal(automatic.includePersonal, true, 'Saved personal memories work by default');
    assert.equal(automatic.indexes.find(index => index.projectId === project.id).files, 3 + distractors);
    await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Personalization', exact: true }).click();
    await page.getByRole('button', { name: 'Add memory', exact: true }).click();
    await page.getByRole('textbox', { name: 'Memory title', exact: true }).fill('Response preference'); await page.getByRole('textbox', { name: 'Memory text', exact: true }).fill('I prefer a concise response with practical examples.'); await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    await page.getByText('Response preference', { exact: true }).first().waitFor();
    const memoryRow = page.locator('.memory-entry').filter({ has: page.getByText('Response preference', { exact: true }) });
    await memoryRow.getByRole('button', { name: 'Edit', exact: true }).click(); await page.getByRole('textbox', { name: 'Memory text', exact: true }).fill('I prefer concise answers with practical examples. EDITED_PREFERENCE'); await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    await memoryRow.getByRole('button', { name: 'Pause', exact: true }).click(); await memoryRow.getByRole('button', { name: 'Enable', exact: true }).waitFor(); await memoryRow.getByRole('button', { name: 'Enable', exact: true }).click(); await memoryRow.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    const personalSwitch = page.getByRole('switch', { name: 'Use personal memories', exact: true }); if (await personalSwitch.getAttribute('aria-checked') !== 'true') await personalSwitch.click();
    const state = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value;
    assert.equal(state.semantic.enabled, true);
    assert.equal(await page.getByText('Local retrieval', { exact: true }).count(), 0);
    let ready;
    for (let i = 0; i < 180; i++) { ready = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value; if (ready.semantic.status === 'ready') break; if (ready.semantic.status === 'error') throw new Error(ready.semantic.message); await delay(1000); }
    assert.equal(ready.semantic.status, 'ready');
    for (let i = 0; i < (stress ? 600 : 60); i++) { ready = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value; if (ready.semantic.pending === 0) break; if (stress && i % 20 === 0) console.log(JSON.stringify({ stage: 'indexing', pending: ready.semantic.pending })); await delay(500); }
    assert.equal(ready.semantic.pending, 0);
    const evalCases = [
      ['Who needs to sign off before we ship?', 'release.md'],
      ['How many people have to approve a production rollout?', 'release.md'],
      ['When can I visit the office?', 'hours.md'],
      ['What time does the workplace shut?', 'hours.md'],
      ['Can I get my train fare paid back?', 'travel.md'],
      ['What proof do I need for a rail expense?', 'travel.md'],
    ];
    const evaluation = [];
    if (stress) evalCases.push(['Must two people approve a production push?', 'release.md'], ['Can a single engineer authorize shipping a new release?', 'release.md'], ['At what hour do the office doors open?', 'hours.md'], ['Does the workplace close at seventeen hundred?', 'hours.md'], ['Is a train ticket expense refundable?', 'travel.md'], ['What must I submit to claim railway transportation costs?', 'travel.md']);
    for (const [query, expected] of evalCases) {
      const started = Date.now();
      const result = await page.evaluate(({ projectId, query }) => window.tinygpt.previewMemory(projectId, query), { projectId: project.id, query }); assert.equal(result.ok, true);
      evaluation.push({ query, expected, first: result.value[0]?.title, top3: result.value.slice(0, 3).map(hit => hit.title), milliseconds: Date.now() - started });
    }
    assert.ok(evaluation.every(row => row.top3.includes(row.expected)), JSON.stringify(evaluation));
    const hidden = await page.evaluate(async () => { const p = (await window.tinygpt.createProject('Unrelated private Project', '', false)).value; return (await window.tinygpt.saveMemory({ projectId: p.id, title: 'Private deployment', text: 'Two maintainers authorize production deployment. PRIVATE_MARKER', enabled: true })).value; }); assert.ok(hidden);
    const scoped = (await page.evaluate(id => window.tinygpt.previewMemory(id, 'PRIVATE_MARKER'), project.id)).value; assert.ok(scoped.every(hit => !hit.text.includes('PRIVATE_MARKER')));
    const conversation = (await page.evaluate(id => window.tinygpt.createConversation(id), project.id)).value;
    assert.equal((await page.evaluate(id => window.tinygpt.sendMessage(id, 'Who needs to sign off before we ship?'), conversation.id)).ok, true);
    for (let i = 0; i < 200; i++) { const saved = (await page.evaluate(() => window.tinygpt.library())).value; if (!saved.activeRuns[0]) break; await delay(100); }
    assert.ok(prompts.length, JSON.stringify((await page.evaluate(id => window.tinygpt.conversation(id), conversation.id)).value.messages));
    assert.ok(prompts[0].messages.some(message => String(message.content).includes('Two maintainers'))); assert.ok(prompts[0].messages.every(message => !String(message.content).includes('PRIVATE_MARKER')));
    await page.reload(); await page.locator('[data-slot="sources"]').waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Personalization', exact: true }).click();
    await mkdir(resolve('artifacts'), { recursive: true }); await page.screenshot({ path: resolve('artifacts/memory-settings-light.png') });
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance', exact: true }).click(); await page.getByRole('button', { name: 'Dark', exact: true }).click(); await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Personalization', exact: true }).click(); await page.screenshot({ path: resolve('artifacts/memory-settings-dark.png') });
    const before = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value.documents.find(doc => doc.projectId === project.id && doc.title === 'release.md');
    await writeFile(join(root, 'release.md'), 'Four maintainers must approve production deployment. UPDATED_MARKER'); await page.evaluate(id => window.tinygpt.projectIndex(id, 'refresh'), project.id);
    const changed = (await page.evaluate(id => window.tinygpt.previewMemory(id, 'UPDATED_MARKER'), project.id)).value; assert.equal(changed[0].sourceId, before.id); assert.ok(changed[0].text.includes('Four maintainers'));
    await rename(join(root, 'release.md'), join(root, 'rollout.md')); await page.evaluate(id => window.tinygpt.projectIndex(id, 'refresh'), project.id);
    const moved = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value.documents.find(doc => doc.projectId === project.id && doc.title === 'rollout.md'); assert.ok(moved); assert.notEqual(moved.id, before.id);
    assert.equal((await page.evaluate(id => window.tinygpt.forgetMemory(id), moved.id)).ok, true); await page.evaluate(id => window.tinygpt.projectIndex(id, 'refresh'), project.id);
    assert.ok(!(await page.evaluate(() => window.tinygpt.memorySnapshot())).value.documents.some(doc => doc.id === moved.id));
    await desktop.close(); desktop = undefined; page = await launch();
    for (let i = 0; i < 100; i++) { const state = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value; if (state.semantic.status === 'ready') break; await delay(100); }
    const restored = (await page.evaluate(() => window.tinygpt.memorySnapshot())).value;
    assert.equal(restored.semantic.status, 'ready');
    assert.ok(restored.memories.some(memory => memory.title === 'Response preference')); assert.ok(!restored.documents.some(doc => doc.id === moved.id));
    assert.equal((await page.evaluate(({ conversationId, sourceId }) => window.tinygpt.source(conversationId, sourceId), { conversationId: conversation.id, sourceId: moved.id })).ok, false);
    const workerMetrics = await desktop.evaluate(({ app }) => app.getAppMetrics().filter(item => item.name === 'TinyGPT local retrieval' || item.name === 'TinyGPT document reader').map(({ name, memory, pid }) => ({ name, memory, pid })));
    const results = { stress, corpusFiles: 3 + distractors, evaluation, recallAt3: evaluation.filter(row => row.top3.includes(row.expected)).length / evaluation.length, accuracyAt1: evaluation.filter(row => row.first === row.expected).length / evaluation.length, embedded: restored.semantic.embedded, workerMetrics, errors };
    await writeFile(resolve(stress ? 'artifacts/memory-stress-evaluation.json' : 'artifacts/memory-evaluation.json'), JSON.stringify(results, null, 2)); assert.deepEqual(errors, []);
    console.log(JSON.stringify(results, null, 2)); console.log('Memory desktop passed: Settings CRUD, local embedding utility process, real-model retrieval, scoped Chat injection/citations, file updates/moves/forget, persistence, model-cache reload and clean shutdown.');
  } finally { if (desktop) await desktop.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
