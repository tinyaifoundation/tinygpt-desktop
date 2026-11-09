const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  let app;
  const form = `<title>Background fixture</title><main style="min-height:3000px"><form onsubmit="event.preventDefault();window.submissions++;document.querySelector('#result').textContent='Submitted'"><label>Work note<input id="note"></label><button id="hover" onmouseover="document.querySelector('#hover-result').textContent='Hovered'">Hover action</button><p id="hover-result">Waiting</p><p id="result">Not submitted</p><label>Password<input id="password" type="password"></label><input type="file" id="file" aria-label="Upload"><p>${'Readable background evidence. '.repeat(160)}</p></form></main><script>window.submissions=0;</script>`;
  const server = createServer((request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(request.url === '/search' ? '<title>Search fixture</title><main><article><h2><a class="result__a" href="https://example.org/evidence">Fixture evidence</a></h2><p>Search evidence snippet</p></article></main>' : form));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(resolve('artifacts'), { recursive: true });
  const fixtureMain = resolve('artifacts/browser-accessibility-main.cjs');
  await writeFile(resolve('artifacts/browser-accessibility-preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('browserFixture',{operate:data=>ipcRenderer.invoke('fixture:operation',data)});");
  await build({ entryPoints: [resolve('scripts/browser-accessibility-smoke-main.ts')], outfile: fixtureMain, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `background-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  let tabId; let page; const conversationId = randomUUID(); const runId = randomUUID();
  async function operation(method, args = {}) {
    const result = await page.evaluate(data => window.browserFixture.operate(data), { method, conversationId, tabId, runId, origin, ...args });
    if (!result.ok) throw new Error(result.error); return result.value;
  }
  async function count(expected) {
    for (let i=0; i<50; i++) { if (await operation('count') === expected) return; await new Promise(done => setTimeout(done, 50)); }
    assert.equal(await operation('count'), expected);
  }
  const evaluate = code => operation('evaluate', { code });
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [fixtureMain], env });
    page = await app.firstWindow(); await page.waitForFunction(() => !!window.browserFixture);
    for (let index=0;index<8;index++) await operation('page', { url: origin + '/page-' + index });
    const hidden = await operation('state'); assert.deepEqual(hidden.state.tabs, []); assert.equal(hidden.reveals, 0); assert.equal(hidden.attached, 0);
    await count(8); await operation('end'); await count(0); await operation('end');
    for (let index=0;index<3;index++) { const search = await operation('search'); assert.equal(search.results[0].title, 'Fixture evidence'); assert.equal(search.tabId, undefined); await count(0); }
    await assert.rejects(operation('abort'), /abort/i); await count(0);

    const otherRun = randomUUID(); let snapshot = await operation('page'); tabId = snapshot.tabId;
    assert.equal((await operation('page', { runId: otherRun })).tabId, tabId);
    await operation('end'); await count(1); await operation('end', { runId: otherRun }); await count(0);

    snapshot = await operation('open'); tabId = snapshot.tabId;
    let state = await operation('state'); assert.equal(state.state.tabs.length, 1); assert.equal(state.reveals, 0); assert.equal(state.attached, 0);
    const hover = snapshot.elements.find(element => element.label === 'Hover action').id;
    await operation('hover', { elementId: hover }); assert.equal(await evaluate('document.querySelector("#hover-result").textContent'), 'Hovered');
    await operation('scroll', { pixels: 500 }); assert.ok(await evaluate('scrollY') > 0);
    await operation('type', { elementId: snapshot.elements.find(element => element.label === 'Work note').id, text: 'Hidden edit' });
    await operation('key', { key: 'Enter' }); assert.equal(await evaluate('window.submissions'), 1);
    await evaluate('document.querySelector("#password").focus()'); await assert.rejects(operation('key', { key: 'Backspace' }), /manual interaction/);
    await evaluate('document.querySelector("#file").focus()'); await assert.rejects(operation('key', { key: 'Enter' }), /manual interaction/);
    snapshot = await operation('navigate', { url: origin + '/next' }); assert.match(snapshot.url, /\/next$/);
    await assert.rejects(operation('describe', { elementId: hover }), /element changed/);
    assert.equal((await operation('state')).reveals, 0);
    await operation('end'); await count(0); assert.deepEqual((await operation('state')).state.tabs, []);

    snapshot = await operation('open'); tabId = snapshot.tabId; await operation('reveal');
    state = await operation('state'); assert.equal(state.reveals, 1); assert.equal(state.attached, 1);
    await operation('end'); await count(1); assert.equal((await operation('state')).state.tabs[0].id, tabId);
    await operation('close'); await count(0);
    const manual = await operation('manual');
    const background = await operation('page'); tabId = background.tabId;
    await operation('end'); await assert.rejects(operation('read'), /not available/);
    assert.equal((await operation('state')).state.tabs[0].id, manual);
    await operation('close', { tabId: manual });
    assert.equal((await operation('state')).state.activeId, null);
    console.log(JSON.stringify({ ok: true, checks: ['research hidden from workspace', 'reply cleanup and idempotency', 'search tabs released immediately', 'cancellation cleanup', 'shared run leases', 'interactive opt-in viewing', 'hidden native hover and Enter', 'scroll and navigation reuse', 'password/upload guards', 'watched and manual tabs preserved', 'explicit close'] }));
  } finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
