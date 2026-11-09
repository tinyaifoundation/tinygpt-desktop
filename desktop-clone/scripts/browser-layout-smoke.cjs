const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser layout fixture</title><style>html{background:#181818;color:white}body{margin:0;min-width:1200px}main{height:5000px;width:100%;background:linear-gradient(#181818,#333)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:12px}</style><main><div class="cards"><article>One responsive card</article><article>Another card</article></div><button onclick="this.textContent=\'Clicked\'">Interactive</button></main>'));
  await new Promise(done => server.listen(0, '127.0.0.1', done)); const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: resolve('.tools-smoke-profile', `browser-layout-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['--force-device-scale-factor=1', resolve('scripts/tools-smoke-main.cjs')], env }); const page = await app.firstWindow(); page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000, -10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    const until = async predicate => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await predicate()) return; await page.waitForTimeout(100); } throw Error('Browser state did not settle.'); };
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show workspace', exact: true }).click(); await page.getByRole('button', { name: 'Add workspace tab', exact: true }).click(); await page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search or enter a URL', exact: true }).fill(origin); await page.getByRole('textbox', { name: 'Search or enter a URL', exact: true }).press('Enter');
    const ids = await page.evaluate(async () => { const chat = (await window.tinygpt.library()).value.lastConversationId; const state = await window.tinygpt.workspaceBrowser({ action: 'state', conversationId: chat }); return { chat, tab: state.value.activeId }; });
    await page.getByRole('tab', { name: 'Browser layout fixture', exact: true }).waitFor();
    await until(() => page.evaluate(async ids => { const result = await window.tinygpt.workspaceBrowserScroll({ conversationId: ids.chat, tabId: ids.tab }); return result.ok && result.value.height >= 5000; }, ids));
    const nativeId = await app.evaluate(({ webContents }, origin) => webContents.getAllWebContents().find(contents => contents.getURL() === origin + '/').id, origin);
    const native = code => app.evaluate(async ({ webContents }, { nativeId, code }) => webContents.fromId(nativeId).executeJavaScript(code), { nativeId, code });
    const attached=()=>app.evaluate(({BrowserWindow,webContents},nativeId)=>BrowserWindow.getAllWindows().some(window=>window.contentView.children.some(frame=>frame.getVisible()&&frame.children.some(view=>view.webContents===webContents.fromId(nativeId)&&view.getVisible()))),nativeId);
    await until(attached);
    // A native page must leave the complete separator hit area uncovered.
    const separator=page.getByRole('separator',{name:'Resize workspace',exact:true});
    const hit=await separator.boundingBox(), viewport=await page.locator('.workspace-browser-viewport').boundingBox();
    assert.ok(hit.x+hit.width<=viewport.x+1,'Native page covers the resize separator');
    await page.mouse.move(hit.x+hit.width/2,viewport.y+80);await page.mouse.down();
    await page.mouse.move(hit.x+hit.width/2-75,viewport.y+80,{steps:8});await page.mouse.up();
    await until(attached);
    await until(async()=>Math.abs(await native('innerWidth')-(await page.locator('.workspace-browser-viewport').boundingBox()).width)<2);
    assert.ok((await page.locator('.workspace-browser-viewport').boundingBox()).width>viewport.width+60);
    // Closed/hidden overlay nodes must not leave an inert screenshot on screen.
    await page.evaluate(()=>{const node=document.createElement('div');node.id='browser-overlay-fixture';node.setAttribute('role','dialog');node.hidden=true;document.body.append(node);});
    await until(attached);
    await page.evaluate(()=>{const node=document.getElementById('browser-overlay-fixture');node.hidden=false;node.style.cssText='position:fixed;inset:100px;background:white;z-index:200';});
    await until(async()=>!await attached());await page.locator('.workspace-page-preview').waitFor();
    assert.equal(await page.locator('.workspace-page-preview').evaluate(node=>getComputedStyle(node).objectFit),'contain');
    await page.evaluate(()=>document.getElementById('browser-overlay-fixture').dataset.state='closed');
    await until(attached);await page.locator('.workspace-page-preview').waitFor({state:'hidden'});
    await page.evaluate(()=>document.getElementById('browser-overlay-fixture').remove());
    await native('scrollTo(0,400)');await separator.focus();await separator.press('ArrowLeft');await until(attached);
    assert.ok(await native('scrollY')>=390,'Resize must retain the live document scroll state');
    await page.waitForFunction(() => !!document.querySelector('.browser-page-scrollbar [data-slot="scroll-area-thumb"]'));
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { const value = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); localStorage.setItem('tinygpt-appearance-v4', JSON.stringify({ ...value, theme })); }, theme); await page.reload();
      await page.getByRole('button', { name: 'Show workspace', exact: true }).click(); await page.getByRole('tab', { name: 'Browser layout fixture', exact: true }).click();
      await page.waitForFunction(() => !!document.querySelector('.browser-page-scrollbar [data-slot="scroll-area-thumb"]'));
      assert.equal(await native('getComputedStyle(document.documentElement).scrollbarWidth'), 'none'); assert.equal(await native('getComputedStyle(document.documentElement).overflowX'), 'hidden');
      assert.ok(await native('document.scrollingElement.scrollWidth <= innerWidth'));
      const geometry = await page.locator('.workspace-browser-viewport').boundingBox(); const nativeWidth = await native('innerWidth'); assert.ok(Math.abs(nativeWidth - geometry.width) <= 1);
      const radii = await page.evaluate(() => ({ conversation: getComputedStyle(document.querySelector('.conversation-pane')).borderRadius, workspace: getComputedStyle(document.querySelector('.tiny-workspace')).borderRadius, browser: getComputedStyle(document.querySelector('.workspace-browser-body')).borderRadius }));
      assert.equal(radii.workspace,'14px'); assert.equal(radii.browser,'0px 0px 13px 13px');
      const body = await page.locator('.workspace-browser-body').boundingBox();
      const leftGutter=await page.locator('.workspace-browser-body').evaluate(node=>parseFloat(getComputedStyle(node).paddingLeft)||0);
      await until(async () => { const frame = await app.evaluate(({ BrowserWindow, webContents }, nativeId) => { const contents = webContents.fromId(nativeId); const window = BrowserWindow.getAllWindows().find(window => window.contentView.children.some(view => view.children.some(child => child.webContents === contents))); const parent = window?.contentView.children.find(view => view.children.some(child => child.webContents === contents)); return parent?.getBounds(); }, nativeId); return frame && Math.abs(frame.width - (body.width-leftGutter)) <= 1 && Math.abs(frame.x-(body.x+leftGutter))<=1 && Math.abs(frame.y - (body.y - 13)) <= 1; });
      const background = await page.locator('.workspace-browser-viewport').evaluate(node => getComputedStyle(node).backgroundColor); assert.equal(background, await page.locator('.tiny-workspace').evaluate(node => getComputedStyle(node).backgroundColor));
      await page.screenshot({ path: resolve(`artifacts/browser-layout-${theme}.png`) });
      await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.locator('.settings-content').waitFor(); assert.equal(await page.locator('.settings-content').evaluate(element => getComputedStyle(element).borderRadius),radii.conversation); assert.equal(await page.locator('.settings-content').evaluate(element => getComputedStyle(element).overflow), 'hidden');
      await page.screenshot({ path: resolve(`artifacts/settings-pane-${theme}.png`) });
      await page.getByRole('button', { name: 'Back to TinyGPT', exact: true }).click(); if (!await page.locator('.tiny-workspace').isVisible()) await page.getByRole('button', { name: 'Show workspace', exact: true }).click(); await page.getByRole('tab', { name: 'Browser layout fixture', exact: true }).click(); await page.waitForFunction(() => !!document.querySelector('.browser-page-scrollbar [data-slot="scroll-area-thumb"]'));
    }
    const scrollViewport = page.locator('.browser-page-scroll-viewport'); await scrollViewport.focus(); await scrollViewport.press('End');
    await until(() => page.evaluate(async ids => { const result = await window.tinygpt.workspaceBrowserScroll({ conversationId: ids.chat, tabId: ids.tab }); return result.ok && result.value.top >= result.value.height - result.value.viewport - 2; }, ids));
    await scrollViewport.press('Home'); await until(() => page.evaluate(async ids => (await window.tinygpt.workspaceBrowserScroll({ conversationId: ids.chat, tabId: ids.tab })).value.top < 2, ids));
    await native('scrollTo(0, 1000)'); await page.waitForFunction(() => document.querySelector('.browser-page-scroll-viewport').scrollTop > 900).catch(async error => { console.error('Scroll diagnostics', await page.evaluate(async ids => ({ result: await window.tinygpt.workspaceBrowserScroll({ conversationId: ids.chat, tabId: ids.tab }), top: document.querySelector('.browser-page-scroll-viewport').scrollTop, height: document.querySelector('.browser-page-scroll-viewport').clientHeight, content: document.querySelector('.browser-page-scroll-viewport').scrollHeight }), ids), await native('({top:scrollY,height:innerHeight,total:document.scrollingElement.scrollHeight})')); throw error; });
    const thumb = page.locator('.browser-page-scrollbar [data-slot="scroll-area-thumb"]'); const bounds = await thumb.boundingBox(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 90); await page.mouse.up();
    await until(() => page.evaluate(async ids => (await window.tinygpt.workspaceBrowserScroll({ conversationId: ids.chat, tabId: ids.tab })).value.top > 1400, ids));
    await page.evaluate(async ids => { for (let index = 0; index < 14; index++) await window.tinygpt.workspaceBrowser({ action: 'new', conversationId: ids.chat }); }, ids);
    await page.getByRole('button',{name:'More workspace tabs',exact:true}).waitFor();
    const tabs = page.locator('.workspace-tab'); const widths = await tabs.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width)); assert.ok(widths.every(width => width >= 90 && width <= 201));
    await page.getByRole('button',{name:'More workspace tabs',exact:true}).click();await page.locator('.workspace-overflow-item').first().waitFor();await page.keyboard.press('Escape');
    assert.equal(await page.locator('.workspace-tabs').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await page.getByRole('tab', { name: 'Browser layout fixture', exact: true }).click(); await page.waitForFunction(() => !!document.querySelector('.browser-page-scrollbar [data-slot="scroll-area-thumb"]'));
    assert.equal(await page.getByRole('tab', { name: 'Browser layout fixture', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Expand workspace', exact: true }).click(); const expanded = await page.locator('.workspace-browser-viewport').boundingBox(); assert.ok(Math.abs((await native('innerWidth')) - expanded.width) <= 1);
    await page.screenshot({ path: resolve('artifacts/browser-tabs-crowded.png') });
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/')).webContents.setZoomFactor(1.25));
    await until(async()=>Math.abs(await native('innerWidth')-(await page.locator('.workspace-browser-viewport').boundingBox()).width*1.25)<2);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(window=>window.webContents.getURL().includes('/renderer/')).webContents.setZoomFactor(1));
    const invalid = await page.evaluate(ids => window.tinygpt.workspaceBrowserScroll({ conversationId: ids.chat, tabId: ids.tab, position: 2 }), ids); assert.equal(invalid.ok, false);
    assert.deepEqual(errors, []); console.log('Browser layout passed: responsive/native bounds, themed edges, hidden native/window horizontal bars, real shadcn thumb/drag/keyboard/page-scroll synchronization, crowded selectable tabs, resizing, and validated scroll requests.');
  } catch (error) { if (app) { const page = await app.firstWindow(); await page.screenshot({ path: resolve('artifacts/browser-layout-failure.png') }); } throw error; }
  finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
