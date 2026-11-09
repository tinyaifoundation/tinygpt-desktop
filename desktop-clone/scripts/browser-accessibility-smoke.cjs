const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');

async function main() {
  let app; let origin;
  const form = `<title>Accessibility fixture</title><main><label for="note">Work note</label><input id="note" value="Initial note"><span id="save-label">Save note</span><button id="save" aria-labelledby="save-label" onclick="window.saves++; document.getElementById('result').textContent='Saved '+document.getElementById('note').value">Save</button><p id="result">Not saved</p><label>Password<input type="password" id="password" value="PASSWORD_VALUE_MUST_NOT_APPEAR"></label><input id="file" type="file" aria-label="Upload file"><input id="readonly" readonly aria-label="Read-only note"><input disabled aria-label="Disabled note"><div contenteditable="true" role="textbox" aria-label="Editable note" id="editor">Old content</div><a id="link" href="/first">Destination</a><div id="shadow"></div><p>${"Background fixture context. ".repeat(120)}</p></main><script>window.saves=0; window.inputs=0; document.getElementById('note').addEventListener('input',()=>window.inputs++); const shadow=document.getElementById('shadow').attachShadow({mode:'closed'}); shadow.innerHTML='<button onclick="window.shadowClicks=(window.shadowClicks||0)+1">Shadow action</button>';</script>`;
  const server = createServer((request, response) => response.writeHead(request.url === '/denied' ? 401 : 200, { 'Content-Type': 'text/html' }).end(request.url === '/form' ? form : '<title>New document</title><main><button>Save note</button></main>'));
  await new Promise(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  await mkdir(resolve('artifacts'), { recursive: true });
  const fixtureMain = resolve('artifacts/browser-accessibility-main.cjs');
  await writeFile(resolve('artifacts/browser-accessibility-preload.cjs'), "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('browserFixture',{operate:data=>ipcRenderer.invoke('fixture:operation',data)});");
  await build({ entryPoints: [resolve('scripts/browser-accessibility-smoke-main.ts')], outfile: fixtureMain, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], loader: { '.png': 'file', '.ico': 'file' } });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `accessibility-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const conversationId = randomUUID(); let tabId;
  let page;
  async function operation(method, args = {}) {
    if (process.env.TINYGPT_BROWSER_TRACE) console.log('Browser fixture:', method, JSON.stringify(args).slice(0, 140));
    let timer; const result = await Promise.race([page.evaluate(data => window.browserFixture.operate(data), {method, conversationId, tabId, origin, ...args}), new Promise((_, reject)=>{timer=setTimeout(()=>reject(new Error('Fixture operation timed out: '+method)),15000);})]).finally(()=>clearTimeout(timer));
    if (!result.ok) throw new Error(result.error); return result.value;
  }
  async function read() { return operation('read'); }
  async function describe(elementId) { return operation('describe', { elementId }); }
  async function click(elementId, expected) { return operation('click', { elementId, expected }); }
  async function type(elementId, text) { return operation('type', { elementId, text }); }
  async function mutate(code) { return operation('mutate', { code }); }
  try {
    
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: [fixtureMain], env });  page = await app.firstWindow(); await page.waitForFunction(()=>!!window.browserFixture); 
    let snapshot = await operation('page'); tabId = snapshot.tabId;
    const hidden = await operation('state'); assert.deepEqual(hidden.state.tabs, []); assert.equal(hidden.state.activeId, null); assert.equal(hidden.reveals, 0); assert.equal(hidden.attached, 0);
    await operation('reveal');
    const watched = await operation('state'); assert.equal(watched.state.activeId, tabId); assert.equal(watched.state.tabs[0].tool, true); assert.equal(watched.reveals, 1); assert.equal(watched.attached, 1);
    
    assert.equal(snapshot.snapshotKind, 'accessibility'); assert.equal(snapshot.elements.find(element => element.label === 'Work note').role, 'textbox'); assert.equal(snapshot.elements.find(element => element.label === 'Save note').role, 'button'); assert.match(snapshot.accessibility, /textbox "Work note"/); assert.equal(JSON.stringify(snapshot).includes('PASSWORD_VALUE_MUST_NOT_APPEAR'), false); assert.equal(await mutate('document.querySelectorAll("[data-tinygpt-target]").length'), 0);
    const note = snapshot.elements.find(element => element.label === 'Work note').id;
    snapshot = await type(note, 'Native CDP note'); assert.equal(await mutate('document.getElementById("note").value'), 'Native CDP note'); assert.ok(await mutate('window.inputs') > 0); assert.equal(snapshot.elements.find(element => element.label === 'Work note').id, note);
    const cursor = await operation('cursor'); assert.equal(cursor.visible, '1'); assert.match(cursor.position, /translate\([\d.-]+px,[\d. -]+px\)/); assert.equal(cursor.hidden, 'true'); assert.equal(cursor.interactive, 'none'); assert.equal(snapshot.accessibility.includes('tinygptAgentCursor'), false);
    await operation('capture');
    
    await type(note, ''); assert.equal(await mutate('document.getElementById("note").value'), ''); await type(note, 'Saved note');
    const editor = snapshot.elements.find(element => element.label === 'Editable note').id; await type(editor, 'Edited content'); assert.equal(await mutate('document.getElementById("editor").textContent'), 'Edited content');
    
    await assert.rejects(type(snapshot.elements.find(element => element.label === 'Password').id, 'Forbidden'), /manual interaction/);
    await assert.rejects(type(snapshot.elements.find(element => element.label === 'Read-only note').id, 'Forbidden'), /cannot be edited/);
    await assert.rejects(click(snapshot.elements.find(element => element.label === 'Upload file').id), /manual interaction/);
    const shadow = snapshot.elements.find(element => element.label === 'Shadow action'); assert.ok(shadow); await click(shadow.id); assert.equal(await mutate('window.shadowClicks'), 1);
    
    let save = snapshot.elements.find(element => element.label === 'Save note').id; const approved = await describe(save);
    await mutate('document.getElementById("save").replaceWith(document.getElementById("save").cloneNode(true))');
    await assert.rejects(click(save, approved), /element changed/); assert.equal(await mutate('window.saves'), 0);
    snapshot = await read(); const replacement = snapshot.elements.find(element => element.label === 'Save note').id; assert.notEqual(replacement, save); await click(replacement); assert.equal(await mutate('window.saves'), 1);
    save = replacement; const beforeRename = await describe(save); await mutate('document.getElementById("save-label").textContent="Delete note"'); await assert.rejects(click(save, beforeRename), /element changed/); assert.equal(await mutate('window.saves'), 1);
    snapshot = await read(); assert.notEqual(snapshot.elements.find(element => element.label === 'Delete note').id, save);
    const link = snapshot.elements.find(element => element.label === 'Destination').id; await mutate('document.getElementById("link").setAttribute("href","/second")'); await assert.rejects(click(link), /element changed/);
    await mutate('document.getElementById("save-label").textContent="Save note"'); snapshot = await read(); save = snapshot.elements.find(element => element.label === 'Save note').id;
    await mutate('document.querySelector("main").append(document.getElementById("save"))'); await click(save); assert.equal(await mutate('window.saves'), 2);
    await mutate('const overlay=document.createElement("div");overlay.id="overlay";overlay.style="position:fixed;inset:0;z-index:100;background:white";overlay.onclick=()=>window.overlayClicks=(window.overlayClicks||0)+1;document.body.append(overlay)'); await assert.rejects(click(save), /covered by another element/); assert.equal(await mutate('window.overlayClicks||0'), 0); assert.equal(await mutate('window.saves'), 2); await mutate('document.getElementById("overlay").remove()');
    await mutate('for(let i=0;i<75;i++){const b=document.createElement("button");b.textContent="Background "+i;document.querySelector("main").append(b)}const modal=document.createElement("div");modal.id="dialog-fixture";modal.setAttribute("role","dialog");modal.setAttribute("aria-modal","true");modal.setAttribute("aria-label","Preferences");modal.style="position:fixed;inset:0;z-index:200;background:white";modal.innerHTML="<h2>Preferences</h2><p>Only dialog text</p><label><input type=checkbox>Updates</label><a href=/second>Help destination</a><button onclick=this.parentNode.remove()>Close dialog</button>";document.body.append(modal)');
    snapshot = await read(); assert.equal(snapshot.activeDialog.title, 'Preferences'); assert.equal(snapshot.targets.scope, 'dialog'); assert.ok(snapshot.elements.every(e=>e.inActiveDialog)); assert.equal(snapshot.elements.length, 3); assert.equal(snapshot.textCoverage.scope, 'dialog'); assert.ok(!snapshot.text.includes('Background fixture')); assert.equal(snapshot.elements.find(e=>e.role==='link').href, origin+'/second');
    await assert.rejects(click(save), /covered by another element/); assert.equal(await mutate('window.saves'), 2);
    const background = await operation('read', {options:{scope:'page',query:'Save note'}}); assert.equal(background.elements.find(e=>e.id===save).inActiveDialog, false);
    await click(snapshot.elements.find(e=>e.label==='Close dialog').id);
    assert.equal((await read()).activeDialog, undefined);
    await mutate('for(const b of [...document.querySelectorAll("main button")])if(b.textContent.startsWith("Background "))b.remove()');
    await mutate('const button=document.createElement("button");button.textContent="Scroll action";button.style="display:block;margin-top:2000px";button.onclick=()=>window.scrollClicks=(window.scrollClicks||0)+1;document.body.append(button);addEventListener("scroll",()=>{if(scrollY>100)history.replaceState(null,"","#scroll-section")})');
    snapshot = await read(); const scrollTarget = snapshot.elements.find(element => element.label === 'Scroll action').id;
    const scrollApproval = await describe(scrollTarget); await click(scrollTarget, scrollApproval);
    assert.equal(await mutate('window.scrollClicks'), 1); assert.match((await read()).url, /#scroll-section$/);
    await mutate('history.replaceState(null,"","#another-section")');
    assert.equal((await describe(scrollTarget)).backendNodeId, scrollApproval.backendNodeId);
    assert.equal((await read()).elements.find(element => element.label === 'Scroll action').id, scrollTarget);
    await assert.rejects(operation('read', { conversationId: 'another-conversation' }), /not available to the conversation/);
    const beforeNavigation = await describe(save); await mutate(`location.href=${JSON.stringify(`${origin}/other`)}`); await new Promise(done => setTimeout(done, 500)); await assert.rejects(click(save, beforeNavigation), /element changed/);
    snapshot = await read(); assert.notEqual(snapshot.elements.find(element => element.label === 'Save note').id, save);
    const denied = await operation('navigate', {url:origin+'/denied'}); assert.equal(denied.httpStatus,401); assert.equal(denied.pageError,'authentication-required');
    snapshot = await operation('page'); tabId = snapshot.tabId; const beforeRoute = snapshot.elements.find(element => element.label === 'Work note').id;
    await mutate('history.pushState(null,"","/form?route=changed")'); await assert.rejects(describe(beforeRoute), /element changed/);
    await operation('hide'); const hiddenStart = Date.now(); await operation('page'); await type((await read()).elements.find(element => element.label === 'Work note').id, 'Background edit'); assert.ok(Date.now() - hiddenStart < 4000, 'Hidden browser work must not wait for animation frames'); assert.equal((await operation('state')).reveals, 1); assert.equal((await operation('cursor')).visible, '1', 'Background actions must paint the agent cursor for the live preview');
    console.log(JSON.stringify({ ok: true, checks: ['computed AX names/roles', 'no injected DOM tags', 'password values omitted', 'native input events', 'replace and clear text', 'contenteditable', 'protected/read-only fields', 'closed shadow DOM', 'rerender invalidates old reference', 'rename and link destination validation', 'reorder preserves identity', 'overlay interception blocked', 'scrollspy fragment changes preserve target', 'conversation ownership', 'document and SPA route navigation invalidate references'] }));
  } finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
