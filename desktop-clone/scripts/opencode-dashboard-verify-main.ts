import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { devtoolsMcpConfig } from '../src/main/devtools-mcp';
import { McpConnection } from '../src/main/mcp-client';
import { serveBrowserPreview } from '../src/main/browser-preview';

app.setPath('userData', process.env.TINYGPT_PI_TEST_PROFILE!);
app.whenReady().then(async () => {
  const proof = process.env.TINYGPT_VERIFY_WORKSPACE ? { reports: [{ kind: process.env.TINYGPT_VERIFY_KIND || 'debug', workspace: process.env.TINYGPT_VERIFY_WORKSPACE }] } : JSON.parse(await readFile(resolve('artifacts/opencode-dashboard-live-proof.json'), 'utf8'));
  const results = [];
  const completed = proof.reports.filter((report: any) => !report.error);
  assert.ok(completed.length, 'No completed dashboard reports to verify');
  for (const report of completed) {
    const root = join(app.getPath('userData'), report.kind); await mkdir(root, { recursive: true });
    const config = devtoolsMcpConfig(root, resolve('artifacts'))!;
    const client = new McpConnection({ transport: 'stdio', command: config.command[0], args: config.command.slice(1), environment: Object.keys(config.environment) }, { environment: config.environment });
    const signal = AbortSignal.timeout(120000);
    const preview = await serveBrowserPreview(report.workspace, 'index.html');
    const text = (result: any) => result.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') ?? '';
    try {
      await client.connect(signal);
      const opened = text(await client.call('new_page', { url: preview.url }, signal));
      const pageId = Number(opened.match(/(\d+):[^\n]*\[selected\]/)?.[1]); assert.ok(pageId);
      const inspect = `() => ({title:document.title,clock:document.querySelector('#clock,#clockTime')?.textContent,tableRows:document.querySelectorAll('table tbody tr').length,cards:document.querySelectorAll('.card').length,panelOpen:document.querySelector('#panel')?.classList.contains('open'),body:document.body.innerText,clickable:[...document.querySelectorAll('button,[tabindex="0"],[role="button"]')].map(e=>({label:e.getAttribute('aria-label'),text:e.innerText.slice(0,120)}))})`;
      const before = text(await client.call('evaluate_script', { pageId, function: inspect }, signal));
      const laterClock = text(await client.call('evaluate_script', { pageId, function: `async () => {await new Promise(resolve=>setTimeout(resolve,1200));return document.querySelector('#clock,#clockTime')?.textContent}` }, signal));
      const snapshot = text(await client.call('take_snapshot', { pageId }, signal));
      const consoleErrors = text(await client.call('list_console_messages', { pageId, types: ['error'], includeStackTraces: true }, signal));
      const network = text(await client.call('list_network_requests', { pageId }, signal));
      const cardUid = snapshot.split('\n').find(line => /uid=\S+/.test(line) && /GLM-5/.test(line))?.match(/uid=(\S+)/)?.[1];
      let interaction: unknown, closed: unknown;
      if (cardUid) {
        await client.call('click', { pageId, uid: cardUid }, signal);
        interaction = text(await client.call('evaluate_script', { pageId, function: inspect }, signal));
        await client.call('press_key', { pageId, key: 'Escape' }, signal);
        closed = text(await client.call('evaluate_script', { pageId, function: inspect }, signal));
      }
      const screenshot = resolve(`artifacts/opencode-dashboard-${report.kind}.png`);
      const captured = await client.call('take_screenshot', { pageId, filePath: screenshot, format: 'png', fullPage: report.kind === 'build' }, signal) as any;
      assert.ok(!captured.isError, text(captured));
      await writeFile(resolve(`artifacts/opencode-dashboard-${report.kind}-browser-state.json`), JSON.stringify({ before, laterClock, consoleErrors, network, snapshot, interaction, closed, screenshot }, null, 2));
      if (['debug', 'build'].includes(report.kind)) {
        assert.match(before, /"cards"\s*:\s*10/);
        assert.match(before, /"clock"\s*:\s*"\d{2}:\d{2}:\d{2}"/);
        assert.ok(!/Uncaught (?:SyntaxError|TypeError|ReferenceError)/.test(consoleErrors), consoleErrors);
        assert.ok(cardUid, 'The model detail control must be accessible');
        assert.match(String(interaction), /"panelOpen"\s*:\s*true/);
        assert.match(String(closed), /"panelOpen"\s*:\s*false/);
        const initialClock = before.match(/"clock"\s*:\s*"([^"]+)"/)?.[1];
        assert.ok(initialClock && !laterClock.includes(initialClock), 'The clock must advance');
      }
      results.push({ kind: report.kind, before, consoleErrors, network, snapshot, interaction, closed, laterClock, screenshot, captureResult: captured });
    } finally { await client.close(); await preview.close(); }
  }
  await writeFile(resolve('artifacts/opencode-dashboard-independent-verification.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map(({ kind, consoleErrors, screenshot }) => ({ kind, consoleErrors, screenshot }))));
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
