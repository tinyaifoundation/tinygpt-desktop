// Optional live engine diagnostic. No inference, user credentials, or user browser profile.
const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  let app; const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `live-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve('scripts/tools-smoke-main.cjs')], env });
    const page = await app.firstWindow(); await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    const created = await page.evaluate(() => window.tinygpt.createConversation(null)); assert.equal(created.ok, true); const id = created.value.id;
    const reports = [];
    for (const engine of ['google', 'bing', 'brave', 'duckduckgo']) {
      let finished = false;
      const pending = page.evaluate(({ id, engine }) => window.tinygpt.searchWeb(id, 'Electron desktop documentation', engine), { id, engine }).finally(() => { finished = true; });
      let handoff = false; const deadline = Date.now() + 35000;
      while (!finished && Date.now() < deadline) {
        const library = await page.evaluate(() => window.tinygpt.library());
        if (library.ok && library.value.browserHandoffs.length) { handoff = true; await page.evaluate(id => window.tinygpt.cancelBrowserTasks(id), id); break; }
        await new Promise(done => setTimeout(done, 250));
      }
      if (!finished && !handoff) await page.evaluate(id => window.tinygpt.cancelBrowserTasks(id), id);
      const result = await pending;
      reports.push(result.ok ? { engine, results: result.value.results.length, firstHost: result.value.results[0] ? new URL(result.value.results[0].url).hostname : null } : { engine, handoff, error: result.error });
      console.log(JSON.stringify(reports.at(-1)));
    }
    console.log('Live engine diagnostics complete. A challenge or empty extraction is a limitation, not a successful search check.');
  } finally { if (app) await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
