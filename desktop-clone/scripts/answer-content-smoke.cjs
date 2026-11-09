const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve, join } = require('node:path');
const { mkdirSync, readFileSync } = require('node:fs');
const assert = require('node:assert/strict');

const ui = { root: 'root', elements: {
  root: { type: 'Stack', props: {}, children: ['metrics', 'chart', 'comparison', 'code', 'followups'] },
  metrics: { type: 'MetricGrid', props: { title: 'Service health', metrics: [{ label: 'Requests', value: '12,400' }, { label: 'Latency', value: '42 ms', delta: '-8 ms', trend: 'down', upIsGood: false }, { label: 'Availability', value: '99.98%' }] }, children: [] },
  chart: { type: 'ChartPanel', props: { title: 'Response time', unit: 'Milliseconds', variant: 'line', data: [{ label: 'January', value: 50 }, { label: 'February', value: 46 }, { label: 'March', value: 42 }], summary: 'Latency fell **16%** over three months.' }, children: [] },
  comparison: { type: 'Comparison', props: { title: 'Hosting options', columns: [{ label: 'Option' }, { label: 'Monthly cost', format: { kind: 'currency', currency: 'USD', decimals: 0 } }, { label: 'Best fit' }], rows: [['Shared', 20, 'Small sites'], ['Dedicated', 100, 'Busy services']], sortable: true, summary: 'Shared hosting is sufficient for a **small site**.' }, children: [] },
  code: { type: 'Text', props: { value: 'An example configuration:\n\n\x60\x60\x60typescript\n  const timeout: number = 42;\n\x60\x60\x60' }, children: [] },
  followups: { type: 'FollowUpGroup', props: { suggestions: [{ label: 'Compare providers', message: 'Compare hosting providers for a small site.' }, { label: 'Explore latency', message: 'Explain the response-time trend.' }] }, children: [] },
} };
const answer = [
  'Here are the measurements and a deployment flow.',
  '| Environment | Status | Owner | Region | Last updated |',
  '| :--- | :---: | --- | --- | ---: |',
  '| Development | **Ready** | Platform team | US East | Today |',
  '| Production | Review | Operations | Europe West | Yesterday |',
  '', '```typescript', '  const retries: number = 3;', '  console.log(retries);', '```',
  '', '```mermaid', 'flowchart LR', '  A[Draft] --> B[Review]', '  B --> C[Deploy]', '```',
  '', '```mermaid', 'flowchart LR', '  A -->', '```',
  '', '```unknown-language', 'Preserve this unrecognized code fence.', '```',
].join('\n');

async function main() {
  const profile = resolve('.tools-smoke-profile', `answer-content-${Date.now()}`); mkdirSync(profile, { recursive: true }); mkdirSync(resolve('artifacts'), { recursive: true });
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'answer-fixture' }] }));
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); requests.push(body);
    const finished = !body.tools?.length || body.messages.some(message => message.role === 'tool');
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'answer-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = finished ? { role: 'assistant', content: answer } : { role: 'assistant', tool_calls: [{ index: 0, id: 'present_health', type: 'function', function: { name: 'present', arguments: JSON.stringify(ui) } }] };
    response.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
    if (finished) await new Promise(done => setTimeout(done, 3000));
    response.end(`data: ${JSON.stringify(chunk({}, finished ? 'stop' : 'tool_calls'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile }; env.TINYGPT_VOICE_PROFILE=profile;delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  const app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env });
  const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      await window.tinygpt.saveSettings({ ...settings, route: 'local', mode: 'chat', local: { ...settings.local, endpoint, model: 'answer-fixture', tools: true, contextWindowTokens: 32768 } });
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('Show service health, compare hosting options, and explain deployment with a diagram.'); await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByRole('button', { name: 'Copy answer', exact: true }).waitFor();
    const answerElement = page.locator('[data-slot="answer-text"]').last();
    await answerElement.locator('[data-slot="mermaid-diagram"] svg').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.aui-shiki-base pre span[style]').length > 0);
    assert.equal(await answerElement.locator('[data-slot="mermaid-fallback"]').count(), 1, 'Incomplete diagrams preserve their source');
    assert.equal(await answerElement.locator('.answer-table-scroll tbody tr').count(), 2);
    assert.equal(await page.locator('.jr-metrics .jr-metric').count(), 3);
    assert.equal(await page.locator('.jr-chart-panel .jr-chart').count(), 1);
    assert.equal(await page.locator('.chat-ui-comparison table tbody tr').count(), 2);
    assert.equal(await page.locator('.chat-ui-follow-ups button').count(), 2);
    assert.ok((await answerElement.locator('.aui-shiki-base pre').first().textContent()).startsWith('  const retries'), 'Code indentation survives highlighting');
    assert.ok((await page.locator('.chat-generative-ui .aui-shiki-base pre').textContent()).startsWith('  const timeout'), 'Generated Markdown uses the shared highlighter');
    assert.ok(requests[0].tools.find(tool => tool.function.name === 'present').function.parameters.properties.$type.description.includes('ChartPanel'));
    await page.getByRole('button', { name: 'Compare providers', exact: true }).click();
    assert.equal(await input.inputValue(), 'Compare hosting providers for a small site.'); assert.equal(requests.length, 2);
    await page.getByRole('button', { name: 'Expand diagram', exact: true }).click(); await page.getByRole('dialog', { name: 'Diagram', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog', { name: 'Diagram', exact: true }).count(), 0);
    await page.evaluate(() => { window.copiedAnswers = []; navigator.clipboard.writeText = async text => { window.copiedAnswers.push(text); }; });
    await page.getByRole('button', { name: 'Copy answer', exact: true }).click();
    await page.waitForFunction(() => window.copiedAnswers.length === 1);
    const copied = await page.evaluate(() => window.copiedAnswers[0]);
    assert.ok(copied.includes('| January | 50 |')); assert.ok(copied.includes('**Requests:** 12,400')); assert.ok(copied.includes('```mermaid'));
    const exportPath = join(profile, 'answer.md');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, exportPath);
    await page.getByRole('button', { name: 'More answer actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Export as Markdown' }).click();
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'));
    await page.evaluate(() => window.tinygpt.library());
    assert.ok(readFileSync(exportPath, 'utf8').includes('| January | 50 |'));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4') ?? '{}'); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.getByText('Service health', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.aui-shiki-base pre span[style]').length > 0);
      await answerElement.locator('.answer-table-scroll').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
      await page.screenshot({ path: resolve(`artifacts/answer-content-${theme}.png`) });
      await answerElement.locator('[data-slot="mermaid-diagram"]').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.screenshot({ path: resolve(`artifacts/answer-diagram-${theme}.png`) });
      await page.locator('.chat-ui-metrics').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.screenshot({ path: resolve(`artifacts/answer-compositions-${theme}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 800));
    await page.locator('.chat-ui-metrics').evaluate(node => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.screenshot({ path: resolve('artifacts/answer-compositions-narrow.png') });
    assert.equal(await page.locator('.thread-viewport').evaluate(node => node.scrollWidth > node.clientWidth), false);
    // Tool-capable Chat holds unclassified text until its provider finishes.
    // A text-only answer exercises the renderer's actual streaming state.
    await page.evaluate(async () => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      await window.tinygpt.saveSettings({ ...settings, local: { ...settings.local, tools: false } });
    });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await input.fill('Show the deployment flow as a Mermaid diagram.'); await page.getByRole('button', { name: 'Send message' }).click();
    await page.locator('[data-slot="mermaid-skeleton"]').first().waitFor();
    await page.getByRole('button', { name: 'Copy answer', exact: true }).waitFor();
    await page.locator('[data-slot="mermaid-diagram"] svg').waitFor();
    assert.deepEqual(errors, []);
    console.log('Answer content passed: streaming diagram skeleton, Shiki tokens and indentation, diagram/fallback/zoom, tables, four compositions, safe follow-ups, portable copy/export, reload, light/dark themes and narrow layout.');
  } catch (error) {
    const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/answer-content-failure.png') }); console.error(await page.locator('.workbench-panes').innerText()); throw error;
  } finally { await app.close(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
