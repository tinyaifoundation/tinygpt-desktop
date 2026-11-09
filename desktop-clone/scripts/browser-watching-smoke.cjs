const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  let origin; let sequence=0; const pending = new Map();
  const server = createServer(async (request, response) => {
    if (!request.url.startsWith('/v1')) { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Watched agent page</title><style>body{background:#f5f3ed;color:#252525;font:20px system-ui;padding:40px;min-height:3000px}button{padding:16px;border-radius:12px}</style><h1>Agent browser preview</h1><p>This is a live page.</p><button onclick="this.textContent=\'Page responds\'">Interactive page</button>'); return; }
    let raw=''; for await (const part of request) raw+=part; const body=JSON.parse(raw);
    const responseId='fixture-'+(++sequence);
    const event=(delta,finish_reason=null)=>({ id:responseId,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}] });
    const finish=text=>response.end(`data: ${JSON.stringify(event({role:'assistant',content:text}))}\n\ndata: ${JSON.stringify(event({},'stop'))}\n\ndata: [DONE]\n\n`);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (JSON.stringify(body.messages).includes('Describe a saved conversation')) { finish(JSON.stringify({title:'Browser fixture review',summary:'Checking optional browser viewing.',topicChanged:false})); return; }
    const watching=body.messages.some(message=>message.role==='user'&&String(message.content).includes('WATCH_THIS'));
    const loaded=body.tools?.some(tool=>tool.function.name==='browser_open');
    const opened=body.messages.some(message=>message.role==='tool'&&String(message.content).includes('"tabId":'));
    if (!loaded || !opened) {
      response.end(`data: ${JSON.stringify(event({role:'assistant',tool_calls:[{index:0,id:'browser_fixture_'+(loaded?'open':'load'),type:'function',function:{name:loaded?'browser_open':'load_tools',arguments:JSON.stringify(loaded?{url:origin+(watching?'/watch':'/quiet')}:{group:'browser'})}}]}))}\n\ndata: ${JSON.stringify(event({},'tool_calls'))}\n\ndata: [DONE]\n\n`);
    } else { response.write(': browser ready\n\n'); pending.set(watching?'watch':'quiet',()=>finish(watching?'Watched task finished.':'Hidden task finished.')); }
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done)); origin=`http://127.0.0.1:${server.address().port}`;
  const env={...process.env,TINYGPT_TOOLS_PROFILE:resolve('.tools-smoke-profile',`watched-browser-${Date.now()}`)}; delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[resolve('scripts/tools-smoke-main.cjs')],env});
    const page=await app.firstWindow(); page.setDefaultTimeout(60000); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.setPosition(-10000,-10000);window.setIgnoreMouseEvents(true);window.webContents.setBackgroundThrottling(false);window.showInactive();}});
    await page.locator('.sidebar-nav-action[aria-label="New chat"]').waitFor();
    await page.evaluate(()=>{const value=JSON.parse(localStorage.getItem('tinygpt-appearance-v4')||'{}');localStorage.setItem('tinygpt-appearance-v4',JSON.stringify({...value,theme:'dark'}));});
    await page.evaluate(async endpoint=>{const settings=(await window.tinygpt.snapshot()).value.settings;const result=await window.tinygpt.saveSettings({...settings,mode:'chat',route:'local',local:{...settings.local,endpoint,model:'fixture',tools:true,contextWindowTokens:32768},toolPermissions:{...settings.toolPermissions,browser:'allow',interact:'allow'}});if(!result.ok)throw Error(result.error);},origin+'/v1');
    await page.reload();
    const id=await page.evaluate(async origin=>{const created=await window.tinygpt.createConversation(null);const read=await window.tinygpt.readPage(created.value.id,origin+'/research');if(!read.ok)throw Error(read.error);return created.value.id;},origin);
    const pane=page.getByRole('complementary',{name:'Workspace',exact:true}); assert.equal(await pane.isVisible(),false);
    const state=await page.evaluate(id=>window.tinygpt.workspaceBrowser({conversationId:id,action:'state'}),id); assert.ok(state.ok,state.error); assert.deepEqual(state.value.tabs,[]);
    for(const watching of [false,true]) {
      await page.locator('.sidebar-nav-action[aria-label="New chat"]').click();
      await page.getByRole('textbox',{name:'Message',exact:true}).fill(watching?'WATCH_THIS browser fixture':'QUIET browser fixture'); await page.getByRole('button',{name:'Send message',exact:true}).click();
      const watch=page.getByRole('button',{name:'Watch browser',exact:true}); await watch.waitFor(); assert.equal(await pane.isVisible(),false);
      for(let tries=0;tries<100&&!pending.has(watching?'watch':'quiet');tries++)await new Promise(done=>setTimeout(done,50));
      assert.ok(pending.has(watching?'watch':'quiet'));
      const preview=page.getByRole('complementary',{name:'Agent browser preview',exact:true}); await preview.waitFor();
      await preview.getByText('TinyGPT is using the browser',{exact:true}).waitFor();
      await page.waitForFunction(()=>{const image=document.querySelector('.agent-browser-preview-page img');return image?.complete&&image.naturalWidth>0;});
      const start=await preview.boundingBox(); const conversation=await page.locator('.conversation-pane').boundingBox(); const composer=await page.locator('.composer-footer').last().boundingBox();
      assert.ok(Math.abs(start.x+start.width-(conversation.x+conversation.width-17))<3); assert.ok(start.y+start.height<=composer.y);
      const handle=page.getByRole('button',{name:'Move browser preview',exact:true}); const grip=await handle.boundingBox();
      await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2); await page.mouse.down(); await page.mouse.move(grip.x+grip.width/2-90,grip.y+grip.height/2-75,{steps:8}); await page.mouse.up();
      const dragged=await preview.boundingBox(); assert.ok(Math.abs(dragged.x-(start.x-90))<3); assert.ok(Math.abs(dragged.y-(start.y-75))<3); assert.equal(await pane.isVisible(),false);
      await handle.focus(); await handle.press('ArrowRight'); assert.ok(Math.abs((await preview.boundingBox()).x-(dragged.x+12))<3); await handle.press('Home');
      const oldFrame=await preview.locator('img').getAttribute('src');
      await app.evaluate(async({webContents},url)=>{const native=webContents.getAllWebContents().find(contents=>contents.getURL()===url);await native.executeJavaScript('document.querySelector("h1").textContent="Preview updated live"');},origin+(watching?'/watch':'/quiet'));
      await page.waitForFunction(old=>document.querySelector('.agent-browser-preview-page img')?.src!==old,oldFrame);
      if(watching) {
        await handle.blur(); await page.screenshot({path:resolve('artifacts/agent-browser-preview-dark.png')});
        await watch.click(); await pane.waitFor(); const tab=pane.getByRole('tab',{name:'Watched agent page',exact:true}); await tab.waitFor();
        const nativeId=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(contents=>contents.getURL()===url).id,origin+'/watch');
        const native=code=>app.evaluate(async({webContents},args)=>webContents.fromId(args.nativeId).executeJavaScript(args.code),{nativeId,code});
        for(let attempt=0;attempt<50;attempt++){const bounds=await page.locator('.workspace-browser-viewport').boundingBox();if(Math.abs(await native('innerWidth')-bounds.width)<2)break;await page.waitForTimeout(50);}
        assert.ok(Math.abs(await native('innerWidth')-(await page.locator('.workspace-browser-viewport').boundingBox()).width)<2);
        // Send actual native page input after moving it from the hidden preview.
        await app.evaluate(async({webContents},nativeId)=>{const contents=webContents.fromId(nativeId);if(!contents.debugger.isAttached())contents.debugger.attach('1.3');await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:100,y:150,deltaX:0,deltaY:300});},nativeId);
        for(let attempt=0;attempt<50&&await native('scrollY')<100;attempt++)await page.waitForTimeout(50);
        assert.ok(await native('scrollY')>100,'Watched page must accept native wheel input');
        await native('scrollTo(0,0)');
        const point=await native('(()=>{const r=document.querySelector("button").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
        await app.evaluate(async({webContents},{nativeId,point})=>{const contents=webContents.fromId(nativeId);await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await contents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});},{nativeId,point});
        assert.equal(await native('document.querySelector("button").textContent'),'Page responds');
        assert.equal(await tab.locator('small').count(),0); const cursor=tab.locator('.agent-tab-cursor'); await cursor.hover(); await page.getByRole('tooltip',{name:'Watched agent page · Agent is using this tab',exact:true}).waitFor(); await page.mouse.move(0,0);
        await page.waitForFunction(()=>{const pane=document.querySelector('.conversation-pane'),preview=document.querySelector('.agent-browser-preview'),composer=Array.from(pane.querySelectorAll('.composer-footer')).at(-1);return preview.getBoundingClientRect().bottom<=composer.getBoundingClientRect().top&&preview.getBoundingClientRect().top>pane.getBoundingClientRect().top+150;});
        await page.screenshot({path:resolve('artifacts/agent-browser-preview-watching.png')});
        const dragBounds=await handle.boundingBox(); await page.mouse.move(dragBounds.x+100,dragBounds.y+16);await page.mouse.down();await page.mouse.move(-2000,-2000,{steps:5});await page.mouse.up();
        const constrained=await preview.boundingBox();const resizedPane=await page.locator('.conversation-pane').boundingBox();assert.ok(constrained.x>=resizedPane.x+10&&constrained.y>=resizedPane.y+10);
        await handle.focus();await handle.press('Home');
        await page.evaluate(()=>{const value=JSON.parse(localStorage.getItem('tinygpt-appearance-v4'));localStorage.setItem('tinygpt-appearance-v4',JSON.stringify({...value,theme:'light'}));});await page.reload();await page.getByRole('complementary',{name:'Agent browser preview',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.agent-browser-preview-page img')?.naturalWidth>0);await page.screenshot({path:resolve('artifacts/agent-browser-preview-light.png')});
      }
      pending.get(watching?'watch':'quiet')(); await page.getByText(watching?'Watched task finished.':'Hidden task finished.',{exact:true}).waitFor(); await watch.waitFor({state:'hidden'});
      const active=await page.evaluate(async()=>{const library=(await window.tinygpt.library()).value;return(await window.tinygpt.workspaceBrowser({conversationId:library.lastConversationId,action:'state'})).value;});
      assert.equal(active.tabs.length,watching?1:0);
      await preview.waitFor({state:'hidden'}); if(watching)assert.equal(await pane.locator('.agent-tab-cursor').count(),0);
      if(watching&&await pane.isVisible()) { await pane.getByRole('button',{name:'Close workspace',exact:true}).click(); await pane.waitFor({state:'hidden'}); }
      if(watching) { let throttled=false; for(let tries=0;tries<40&&!throttled;tries++){throttled=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(contents=>contents.getURL()===url)?.getBackgroundThrottling(),origin+'/watch');if(!throttled)await new Promise(done=>setTimeout(done,50));} assert.equal(throttled,true,'Retained idle browser pages must throttle after hiding the workspace.'); }
    }
    assert.deepEqual(errors,[]); console.log('Real Chat verified: live floating preview, mouse/keyboard dragging, default placement, preview updates, cursor favicon tooltip, completion cleanup, optional Watch, and no renderer errors.');
  } catch(error) { if(app){const page=await app.firstWindow();await page.screenshot({path:resolve('artifacts/agent-browser-preview-failure.png')});console.log(await page.evaluate(async()=>{const lib=(await window.tinygpt.library()).value;const chat=lib.lastConversationId?(await window.tinygpt.conversation(lib.lastConversationId)).value:null;return{active:lib.activeRuns,browserTasks:lib.browserTasks,tools:chat?.tools.map(tool=>({name:tool.name,status:tool.status})),errors:chat?.messages.filter(message=>message.error).map(message=>message.error)}}));} throw error; }
  finally {if(app)await app.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
