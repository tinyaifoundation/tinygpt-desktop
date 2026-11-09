const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild'); const { resolve } = require('node:path'); const { createServer } = require('node:http'); const assert = require('node:assert/strict');
const delay = ms => new Promise(done => setTimeout(done, ms));
async function poll(read) { const until = Date.now() + 60000; while (Date.now() < until) { if (await read()) return; await delay(100); } throw Error('Workspace cache fixture timed out'); }
async function main() {
  const main = resolve('artifacts/workspace-cache-smoke-main.cjs');
  await build({ entryPoints: ['scripts/workspace-design-smoke-main.ts'], outfile: main, platform: 'node', format: 'cjs', bundle: true, external: ['electron', '../out/main/index.js'], logLevel: 'silent' });
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'cache-fixture' }] })); return; }
    for await (const _chunk of request) {} response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (delta, finish = null) => `data: ${JSON.stringify({ id: 'cache-fixture', object: 'chat.completion.chunk', created: 1, model: 'cache-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.end(frame({ role: 'assistant', content: 'Cache fixture reply.' }) + frame({}, 'stop') + 'data: [DONE]\n\n');
  }); await new Promise(done => server.listen(0, '127.0.0.1', done));
  let app, page; const errors = [];
  try {
    const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', 'workspace-cache-' + Date.now()) }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [main], env }); page = await app.firstWindow(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setPosition(-10000, -10000); window.setIgnoreMouseEvents(true); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
    const initial = await page.evaluate(async endpoint => { const bridge = window.tinygpt, snapshot = (await bridge.snapshot()).value, library = (await bridge.library()).value; const result = await bridge.saveSettings({ ...snapshot.settings, mode: 'chat', route: 'local', local: { ...snapshot.settings.local, endpoint, model: 'cache-fixture', tools: false, contextWindowTokens: 64000 }, toolPermissions: { ...snapshot.settings.toolPermissions, read: 'deny' } }); if (!result.ok) throw Error(result.error); return library.conversations[0]; }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload(); await page.getByRole('button', { name: 'Show workspace', exact: true }).click(); const workspace = page.getByRole('complementary', { name: 'Workspace', exact: true });
    await workspace.getByRole('button', { name: 'Add workspace tab', exact: true }).click(); await page.getByRole('menuitem', { name: 'Files', exact: true }).click();
    await workspace.getByRole('treeitem', { name: 'document-0.md', exact: true }).click(); await workspace.getByRole('button', { name: 'Source', exact: true }).click();
    const editor = workspace.getByRole('textbox', { name: 'Edit document-0.md', exact: true }); await editor.fill('UNSAVED_CACHE_PROOF'); await workspace.getByRole('tab', { name: 'document-0.md •', exact: true }).waitFor();
    for (let index = 0; index < 18; index++) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Cache navigation fixture ' + index); await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await poll(() => page.evaluate(async () => !(await window.tinygpt.library()).value.activeRuns.length)); await delay(60);
    }
    const persisted = await page.evaluate(async key => { const db = await new Promise((done, fail) => { const request = indexedDB.open('tinygpt-workspace-sessions', 1); request.onsuccess = () => done(request.result); request.onerror = fail; }); return new Promise((done, fail) => { const request = db.transaction('sessions').objectStore('sessions').get(key); request.onsuccess = () => { db.close(); done(request.result?.files.some(tab => tab.draft === 'UNSAVED_CACHE_PROOF')); }; request.onerror = fail; }); }, `${initial.id}:${initial.projectId ?? ''}`); assert.equal(persisted, true);
    await page.getByRole('button', { name: 'Workspace design fixture', exact: true }).click(); await page.getByRole('button', { name: 'Show workspace', exact: true }).click();
    await workspace.getByRole('tab', { name: 'document-0.md •', exact: true }).click(); await editor.waitFor(); assert.equal(await editor.textContent(), 'UNSAVED_CACHE_PROOF');
    await workspace.getByRole('button', { name: 'Save file', exact: true }).click(); await poll(async () => await workspace.getByRole('button', { name: 'Save file', exact: true }).isDisabled());
    await page.getByRole('button', { name: 'New chat', exact: true }).click(); await page.getByRole('button', { name: 'Workspace design fixture', exact: true }).click(); await page.getByRole('button', { name: 'Show workspace', exact: true }).click(); await workspace.getByRole('tab', { name: 'document-0.md', exact: true }).click(); await editor.waitFor(); assert.equal(await editor.textContent(), 'UNSAVED_CACHE_PROOF');
    assert.deepEqual(errors, []); console.log(JSON.stringify({ checks: ['real IndexedDB spill after 18 conversations', 'evicted unsaved edit restored', 'restored draft can be saved safely', 'clean file text reloads after cache stripping'], errors }));
  } catch (error) { if (page) await page.screenshot({ path: resolve('artifacts/workspace-cache-failure.png') }).catch(() => {}); throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
