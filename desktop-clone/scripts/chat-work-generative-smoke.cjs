const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdirSync } = require('node:fs');
const assert = require('node:assert/strict');
const tree = { root: 'budget', elements: {
  budget: { type: 'Card', props: { title: 'Project budget' }, children: ['metrics', 'chart', 'table', 'followup'] },
  metrics: { type: 'MetricGrid', props: { metrics: [{ label: 'Total', value: '$120' }, { label: 'Items', value: '2' }] }, children: [] },
  chart: { type: 'ChartPanel', props: { title: 'Costs', variant: 'bar', data: [{ label: 'Hosting', value: 20 }, { label: 'Design', value: 100 }] }, children: [] },
  table: { type: 'Table', props: { columns: [{ label: 'Item' }, { label: 'Cost', format: { kind: 'currency', currency: 'USD' } }], rows: [['Hosting', 20], ['Design', 100]], sortable: true }, children: [] },
  followup: { type: 'FollowUpGroup', props: { suggestions: [{ label: 'Revise budget', message: 'Help me revise this budget.' }] }, children: [] },
} };
async function main() {
  const profile = resolve('.tools-smoke-profile', `chat-work-ui-${Date.now()}`); const root = join(profile, 'project'); mkdirSync(root, { recursive: true });
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'ui-fixture' }] }));
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); requests.push(body);
    const finished = body.messages.some(message => message.role === 'tool');
    const delta = finished ? { role: 'assistant', content: 'Here is your project budget.' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'present_budget', type: 'function', function: { name: 'present', arguments: JSON.stringify(tree) } }] };
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'ui-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(chunk(delta))}\n\ndata: ${JSON.stringify(chunk({}, finished ? 'stop' : 'tool_calls'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; env.TINYGPT_VOICE_PROFILE = profile; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env }); const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const projectId = await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      await window.tinygpt.saveSettings({ ...settings, route: 'local', mode: 'chat', local: { ...settings.local, endpoint, model: 'ui-fixture', tools: true, contextWindowTokens: 16384 }, toolPermissions: { read: 'deny', write: 'ask', execute: 'ask', browser: 'ask', interact: 'ask' } });
      return (await window.tinygpt.createProject('Work project', '')).value.id;
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('Preserve this draft'); await input.evaluate(node => { window.originalComposer = node; });
    assert.equal(await page.locator('.chat-composer .work-approval-button').count(), 0); assert.equal(await page.locator('[data-slot="composer-extras"]').count(), 0);
    const chatBox = await page.locator('.chat-composer').boundingBox(); assert.ok(chatBox.height >= 46 && chatBox.height <= 52);
    const plusBox = await page.getByRole('button', { name: 'Add files and tools' }).boundingBox(); const inputBox = await input.boundingBox(); const sendBox = await page.getByRole('button', { name: 'Send message' }).boundingBox();
    assert.ok(plusBox.x < inputBox.x && inputBox.x < sendBox.x); assert.ok(Math.abs(inputBox.y - plusBox.y) < 3);
    await page.getByRole('tab', { name: 'Work', exact: true }).click(); await page.getByRole('heading', { name: 'What should we work on?' }).waitFor();
    assert.equal(await input.inputValue(), 'Preserve this draft'); assert.equal(await input.evaluate(node => window.originalComposer === node), true);
    assert.equal(await page.getByText('Choose a Project with a folder below to start coding.', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
    await input.press('Enter'); assert.equal(requests.length, 0);
    await page.getByRole('button', { name: 'Project: Choose project', exact: true }).click(); assert.equal(await page.getByRole('menuitemradio', { name: 'No project', exact: true }).count(), 0);
    await page.getByRole('menuitemradio', { name: 'Work project', exact: true }).click(); await page.getByRole('button', { name: 'Choose folder', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[aria-label="Send message"]').disabled);
    assert.equal(await page.evaluate(id => window.tinygpt.library().then(result => result.value.projects.find(project => project.id === id).rootPath), projectId), root);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running')); await page.screenshot({ path: resolve('artifacts/work-composer.png') });
    await page.getByRole('tab', { name: 'Chat', exact: true }).click(); assert.equal(await input.inputValue(), 'Preserve this draft');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4') ?? '{}'); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await page.screenshot({ path: resolve(`artifacts/chat-composer-${theme}.png`) });
    }
    await input.fill('Show this budget as a chart and sortable table. Hosting: $20; Design: $100.'); await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Here is your project budget.', { exact: true }).waitFor(); await page.getByText('Project budget', { exact: true }).waitFor();
    assert.ok(requests[0].tools.some(tool => tool.function.name === 'present' && tool.function.parameters.properties.elements));
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && JSON.parse(message.content).presented === true));
    assert.equal(await page.locator('.chat-generative-ui .jr-chart').count(), 1); assert.equal(await page.locator('.chat-generative-ui table tbody tr').count(), 2);
    const styles = await page.locator('.chat-generative-ui').evaluate(node => ({ markdownAncestor: !!node.closest('.chat-prose'), titleMargin: getComputedStyle(node.querySelector('.jr-title')).marginTop, chartHeight: node.querySelector('.jr-chart').getBoundingClientRect().height }));
    assert.equal(styles.markdownAncestor, false, 'Generated widgets are isolated from Markdown styles');
    assert.equal(styles.titleMargin, '0px'); assert.ok(styles.chartHeight > 40);
    await page.getByRole('button', { name: /^Item/ }).click(); assert.match(await page.locator('.chat-generative-ui table tbody tr').first().innerText(), /Design/);
    await page.getByRole('button', { name: 'Revise budget', exact: true }).click(); assert.equal(await input.inputValue(), 'Help me revise this budget.'); assert.equal(requests.length, 2);
    assert.equal(await page.locator('.tool-chain').count(), 0); await page.screenshot({ path: resolve('artifacts/chat-generative-budget.png') });
    const id = await page.evaluate(async () => (await window.tinygpt.library()).value.conversations[0].id);
    await page.reload(); await page.getByText('Project budget', { exact: true }).waitFor();
    assert.equal((await page.evaluate(id => window.tinygpt.conversation(id), id)).value.tools[0].name, 'present');
    await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4') ?? '{}'); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme: 'light' })); });
    await page.reload(); await page.getByText('Project budget', { exact: true }).waitFor(); await page.screenshot({ path: resolve('artifacts/chat-generative-light.png') });
    await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4') ?? '{}'); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme: 'dark' })); });
    await page.reload(); await page.getByText('Project budget', { exact: true }).waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 800)); await page.screenshot({ path: resolve('artifacts/chat-generative-narrow.png') });
    assert.equal(await page.locator('.thread-viewport').evaluate(node => node.scrollWidth > node.clientWidth), false);
    assert.deepEqual(errors, []); console.log('Chat/Work UI passed: V2 compact composer, draft/focus preservation, Work naming and mandatory project folder, tool schema/receipt, generated chart/table, sorting, follow-up draft, saved interface restoration, themes and narrow layout.');
  } catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/chat-work-failure.png') }); console.error(await page.locator('.workbench-panes').innerText()); console.error(JSON.stringify(requests.map(request => ({ messages: request.messages.map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content.slice(0, 200) : null })) })))); throw error; } finally { await app.close(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
