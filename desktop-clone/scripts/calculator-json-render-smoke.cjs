const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { _electron } = require('playwright');

async function main() {
  const profile = resolve('.tools-smoke-profile', `calculator-json-render-${Date.now()}`);
  mkdirSync(profile, { recursive: true }); mkdirSync('artifacts', { recursive: true });
  const elements = {
    root: { type: 'Card', props: { title: 'Project budget' }, children: ['metrics', 'chart', 'comparison', 'checklist', 'timeline', 'followups'] },
    metrics: { type: 'MetricGrid', props: { metrics: [{ label: 'Tax', value: '$225' }, { label: 'Subtotal', value: '$1,250' }] }, children: [] },
    chart: { type: 'ChartPanel', props: { title: 'Monthly costs', unit: 'USD', variant: 'bar', data: [{ label: 'Hosting', value: 20 }, { label: 'Design', value: 100 }], summary: 'Design is the larger expense.' }, children: [] },
    comparison: { type: 'Comparison', props: { title: 'Cost breakdown', columns: [{ label: 'Item' }, { label: 'Cost', format: { kind: 'currency', currency: 'USD' }, align: 'end' }], rows: [['Hosting', 20], ['Design', 100]], sortable: true }, children: [] },
    checklist: { type: 'Checklist', props: { title: 'Next steps', items: [{ text: 'Review the design budget' }, { text: 'Confirm hosting' }] }, children: [] },
    timeline: { type: 'Timeline', props: { title: 'Delivery', items: [{ title: 'Review', date: 'Monday' }, { title: 'Launch', date: 'Friday' }] }, children: [] },
    followups: { type: 'FollowUpGroup', props: { suggestions: [{ label: 'Revise budget', message: 'Help me revise this budget.' }] }, children: [] },
  };
  const spec = { root: 'root', elements }; const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url.endsWith('/models')) return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'output-fixture' }] }));
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const results = body.messages.filter(message => message.role === 'tool');
    const count = results.length;
    const chunk = (delta, finish_reason = null) => ({ id: `fixture-${count}`, object: 'chat.completion.chunk', created: 1, model: 'output-fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (count < 2) {
      const name = count === 0 ? 'calculate' : 'present';
      const args = JSON.stringify(count === 0 ? { expression: '1250 * 0.18' } : spec);
      // Split the output into real incremental tool argument fragments.
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `${name}-${count}`, type: 'function', function: { name, arguments: args.slice(0, 100) } }] }))}\n\n`);
      await new Promise(done => setTimeout(done, 80));
      response.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(100) } }] }))}\n\n`);
      response.end(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\ndata: [DONE]\n\n`);
    } else response.end(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'Your budget is ready.' }))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: profile, TINYGPT_VOICE_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  let app;
  try { app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env }); } catch (error) { await new Promise(done => server.close(done)); throw error; }
  const errors = [];
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    await page.evaluate(async endpoint => {
      const settings = (await window.tinygpt.snapshot()).value.settings;
      const saved = await window.tinygpt.saveSettings({ ...settings, route: 'local', mode: 'chat', voice: { ...settings.voice, readAloud: { ...settings.voice.readAloud, enabled: false } }, local: { ...settings.local, endpoint, model: 'output-fixture', tools: true, contextWindowTokens: 32768 }, toolPermissions: Object.fromEntries(Object.keys(settings.toolPermissions).map(key => [key, 'deny'])) });
      if (!saved.ok) throw new Error(JSON.stringify(saved));
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message', exact: true });
    await input.fill('Calculate 18% tax on $1,250 and show the project budget.'); await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Your budget is ready.', { exact: true }).waitFor();
    const visual = page.locator('[data-renderer="json-render"]');
    await visual.getByRole('heading', { name: 'Project budget', exact: true }).waitFor();
    assert.equal(await visual.locator('svg.jr-chart').count(), 1);
    assert.equal(await visual.getByText('$225', { exact: true }).count(), 1);
    await visual.getByRole('button', { name: 'Item', exact: true }).click();
    assert.match(await visual.locator('.jr-comparison tbody tr').first().innerText(), /Design/);
    await visual.getByRole('checkbox', { name: 'Review the design budget' }).check();
    assert.equal(await visual.getByRole('checkbox', { name: 'Review the design budget' }).isChecked(), true);
    await visual.getByRole('button', { name: 'Revise budget' }).click();
    assert.equal(await input.inputValue(), 'Help me revise this budget.'); assert.equal(requests.length, 3);
    assert.ok(requests[0].tools.some(tool => tool.function.name === 'calculate'));
    assert.ok(requests[0].tools.some(tool => tool.function.name === 'present' && tool.function.parameters.properties.elements));
    assert.ok(JSON.stringify(requests[0].messages).includes('The user need not ask for a visual'));
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && JSON.parse(message.content).result === '225'));
    assert.ok(requests[2].messages.some(message => message.role === 'tool' && JSON.parse(message.content).presented === true));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4') ?? '{}'); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme })); }, theme);
      await page.reload(); await page.getByRole('heading', { name: 'Project budget', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Project budget', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(`artifacts/calculator-json-render-${theme}.png`) });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 850));
    await page.getByRole('heading', { name: 'Project budget', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve('artifacts/calculator-json-render-narrow.png') });
    assert.equal(await page.locator('.thread-viewport').evaluate(node => node.scrollWidth > node.clientWidth), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ profile, checks: ['decimal calculator receipt', 'json-render schema and proactive instructions', 'streamed chart/metrics/table/checklist/timeline', 'sorting', 'checkbox', 'follow-up draft without sending', 'saved output reload', 'light/dark/narrow layout'], errors }));
  } catch (error) {
    const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/calculator-json-render-failure.png') });
    console.error((await page.locator('body').innerText()).slice(-8000)); throw error;
  } finally { await app.close(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
