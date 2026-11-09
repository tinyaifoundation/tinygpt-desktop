const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  const live = process.argv.includes('--openrouter');
  const fixture = '<title>Large target fixture</title><main>' + '<p>Long page context.</p>'.repeat(1800) + Array.from({ length: 210 }, (_, i) => `<button onclick="this.textContent='Clicked ${i}'">${i === 205 ? 'Image' : 'Control ' + i}</button>`).join('') + '</main>';
  const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(fixture));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let app;
  try {
  const directory = resolve('artifacts/browser-targets');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'browser-accessibility-preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('browserFixture',{operate:data=>ipcRenderer.invoke('fixture:operation',data)});");
  await build({ entryPoints: [resolve('scripts/browser-accessibility-smoke-main.ts')], outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], loader: { '.png': 'file', '.ico': 'file' } });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', 'browser-targets-' + Date.now()) }; delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [resolve(directory, 'main.cjs')], env });
    const page = await app.firstWindow(); await page.waitForFunction(() => !!window.browserFixture);
    const conversationId = randomUUID(); let tabId;
    async function operation(method, args = {}) {
      const result = await page.evaluate(data => window.browserFixture.operate(data), { method, conversationId, tabId, origin, model: true, ...args });
      if (!result.ok) throw new Error(result.error); return result.value;
    }
    let snapshot = await operation('open'); tabId = snapshot.tabId;
    assert.ok(JSON.stringify(snapshot).length <= 6000);
    const seen = [...snapshot.elements];
    while (snapshot.targets.nextOffset !== undefined) {
      snapshot = await operation('read', { options: { offset: snapshot.targets.nextOffset } });
      seen.push(...snapshot.elements);
    }
    assert.equal(seen.length, 210); assert.equal(new Set(seen.map(element => element.id)).size, 210);
    snapshot = await operation('read', { options: { query: 'image', role: 'button' } });
    assert.equal(snapshot.targets.matched, 1); assert.equal(snapshot.elements[0].label, 'Image');
    const id = snapshot.elements[0].id;
    await operation('read'); // Paging must not invalidate an unchanged target.
    await operation('click', { elementId: id });
    snapshot = await operation('read', { options: { query: 'Clicked 205' } });
    assert.equal(snapshot.elements.length, 1); assert.notEqual(snapshot.elements[0].id, id);
    await assert.rejects(operation('click', { elementId: id }), /element changed/);
    const report = { fixture: { targets: seen.length, filterBeyond150: true, stableAcrossPages: true, staleReferenceRejected: true } };
    if (live) {
      snapshot = await operation('open', { url: 'https://openrouter.ai/rankings' }); tabId = snapshot.tabId;
      // Hydration may finish after the initial load; these are reads, not actions.
      for (let i = 0; i < 10 && !snapshot.elements.some(element => element.role === 'tab' && element.label === 'Image'); i++) {
        await new Promise(done => setTimeout(done, 500));
        snapshot = await operation('read', { options: { role: 'tab' } });
      }
      assert.ok(snapshot.elements.some(element => element.label === 'Image'), 'Image tab must reach the model');
      assert.ok(JSON.stringify(snapshot).length <= 6000);
      snapshot = await operation('read', { options: { query: 'Image', role: 'tab' } });
      const image = snapshot.elements.find(element => element.label === 'Image'); assert.ok(image);
      const clicked = await operation('click', { elementId: image.id });
      snapshot = await operation('read', { options: { query: 'Image', role: 'tab' } });
      assert.ok(snapshot.elements.some(element => element.label === 'Image' && element.selected === true), 'Click must select the Image ranking tab');
      report.openrouter = { url: clicked.url, target: image.id, selected: true, resultCharacters: JSON.stringify(clicked).length, targets: clicked.targets };
      await writeFile(resolve(directory, 'openrouter-model-result.json'), JSON.stringify(clicked, null, 2));
    }
    await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, ...report }));
  } finally {
    if (app) await app.close().catch(() => {});
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
