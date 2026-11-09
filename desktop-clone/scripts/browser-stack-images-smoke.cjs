const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
async function poll(check) { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(done => setTimeout(done,50)); } throw Error('Fixture condition timed out'); }
async function main() {
  const sourceDb = new DatabaseSync(resolve(process.env.APPDATA, 'tinygpt-desktop/library.sqlite'), { readOnly: true });
  const original = sourceDb.prepare('SELECT id,image,mime,size,title FROM sources WHERE conversation_id=? AND image IS NOT NULL ORDER BY created_at').all('04a12ede-e47e-40f1-aff3-8c12df8be3fb'); sourceDb.close();
  assert.equal(original.length,4);
  const labels = ['Male Human Rogue','Female Human Rogue','Night Elf Rogue','Male Gnome Rogue'];
  const foreignId = randomUUID(); const missingId = randomUUID(); let origin; let finish; const requests = []; let app; let page;
  const profile = resolve('.tools-smoke-profile', 'browser-stack-images-' + Date.now());
  const server = createServer(async (request,response) => {
    if (!request.url.startsWith('/v1')) {
      if (request.url === '/photo.png') { response.writeHead(200,{'Content-Type':'image/png'}).end(Buffer.from(original[0].image.split(',')[1],'base64')); return; }
      response.writeHead(200,{'Content-Type':'text/html'}).end('<title>Agent page ' + request.url.slice(1) + '</title><style>body{background:#edf0fa;color:#30364a;font:22px system-ui;padding:32px}h1{font-size:32px}</style><h1>Browser ' + request.url.slice(1) + '</h1><p>Each preview keeps its own live page.</p>'); return;
    }
    if (request.method === 'GET') { response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({data:[{id:'fixture',name:'Fixture',context_length:1048576,architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools','reasoning']}]})); return; }
    let raw=''; for await (const part of request) raw+=part; const body=JSON.parse(raw);
    const agent=body.tools?.some(tool=>tool.function?.name==='browser_open');
    const frame=(delta,end=null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:end}]})+'\n\n';
    const done=text=>response.end(frame({role:'assistant',content:text})+frame({},'stop')+'data: [DONE]\n\n'); response.writeHead(200,{'Content-Type':'text/event-stream'});
    if (!agent) { done('Browser preview and saved images'); return; }
    requests.push(body);
    if (!body.messages.some(message=>message.role==='tool')) {
      response.end(frame({role:'assistant',tool_calls:[1,2,3,4,5].map((number,index)=>({index,id:'open_'+number,type:'function',function:{name:'browser_open',arguments:JSON.stringify({url:origin+'/page-'+number})}}))})+frame({},'tool_calls')+'data: [DONE]\n\n');
    } else { response.write(': tabs ready\n\n'); finish=()=>done('Saved comparison photos:\n\n'+original.map((source,index)=>'!['+labels[index]+'](tinygpt-image:'+source.id+')').join('\n\n')+'\n\n![Web photo]('+origin+'/photo.png)\n\n![Missing photo](tinygpt-image:'+missingId+')\n\n![Private photo](tinygpt-image:'+foreignId+')\n\n![Unsafe photo](file:///C:/private.png)\n\nImages stay in their original response position.'); }
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done)); origin='http://127.0.0.1:'+server.address().port;
  try {
    const env={...process.env,TINYGPT_TOOLS_PROFILE:profile}; delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[resolve('scripts/tools-smoke-main.cjs')],env}); page=await app.firstWindow(); page.setDefaultTimeout(30000); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await app.evaluate(({BrowserWindow})=>{ for (const window of BrowserWindow.getAllWindows()) { window.setIgnoreMouseEvents(true); window.setPosition(-10000,-10000); window.webContents.setBackgroundThrottling(false); window.showInactive(); } });
    await page.getByRole('button',{name:'New chat',exact:true}).waitFor();
    await page.evaluate(()=>{localStorage.setItem('tinygpt-appearance-v4',JSON.stringify({...JSON.parse(localStorage.getItem('tinygpt-appearance-v4')||'{}'),theme:'dark'}));});
    const chat=await page.evaluate(async endpoint=>{
      const settings=(await window.tinygpt.snapshot()).value.settings;
      const result=await window.tinygpt.saveSettings({...settings,mode:'chat',route:'byok',byok:{...settings.byok,provider:'openrouter',protocol:'openai-compatible',endpoint,model:'fixture',tools:true,contextWindowTokens:1048576},toolPermissions:{...settings.toolPermissions,browser:'allow',interact:'allow'}}); if(!result.ok)throw Error(result.error);
      await window.tinygpt.saveSecret('byok','loopback-fixture');
      const other=(await window.tinygpt.createConversation(null)).value.id;
      const id=(await window.tinygpt.createConversation(null)).value.id; return {id,other};
    },origin+'/v1');
    const fixtureDb=new DatabaseSync(resolve(profile,'library.sqlite')); fixtureDb.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    const insert=fixtureDb.prepare('INSERT INTO sources(id,conversation_id,project_id,kind,title,url,mime,size,created_at,message_id,text,image) VALUES(?,?,NULL,?, ?,NULL,?,?,?,NULL,?,?)');
    for (const source of original) insert.run(source.id,chat.id,'project-file',source.title,source.mime,source.size,Date.now(),'Saved screenshot fixture',source.image);
    insert.run(foreignId,chat.other,'image','Private image','image/png',original[0].size,Date.now(),'',original[0].image); fixtureDb.close();
    await page.reload(); await page.getByRole('textbox',{name:'Message',exact:true}).fill('Open five browser tabs and show the saved comparison images.'); await page.getByRole('button',{name:'Send message',exact:true}).click();
    await poll(()=>!!finish);
    const stack=page.getByRole('complementary',{name:'Agent browser preview',exact:true}); await stack.waitFor();
    const workspace=page.getByRole('complementary',{name:'Workspace',exact:true}); assert.equal(await workspace.isVisible(),false);
    await page.waitForFunction(()=>document.querySelectorAll('.agent-browser-preview').length===4&&document.querySelector('.agent-browser-preview.is-front img')?.naturalWidth>0);
    await stack.getByText('5 / 5 tabs',{exact:true}).waitFor();
    const order=await stack.locator('article').evaluateAll(nodes=>nodes.map(node=>node.dataset.tabId));
    const first=stack.locator('article.is-front'); const old=await first.getAttribute('data-tab-id');
    const before=await stack.locator('article').nth(1).evaluate(node=>getComputedStyle(node).transform); await first.hover();
    await page.waitForFunction(prior=>getComputedStyle(document.querySelectorAll('.agent-browser-preview')[1]).transform!==prior,before);
    await page.screenshot({path:resolve('artifacts/browser-stack-dark.png')});
    await stack.getByRole('button',{name:'Next browser tab',exact:true}).click();
    await page.waitForFunction(id=>document.querySelector('.agent-browser-preview.is-front').dataset.tabId!==id,old); await stack.getByText('1 / 5 tabs',{exact:true}).waitFor();
    await stack.getByRole('button',{name:'Previous browser tab',exact:true}).click(); await stack.getByText('5 / 5 tabs',{exact:true}).waitFor();
    const rear=stack.locator('.agent-browser-preview-select').first(); const rearId=await rear.evaluate(node=>node.parentElement.dataset.tabId); await rear.focus(); await rear.press('Enter');
    await page.waitForFunction(id=>document.querySelector('.agent-browser-preview.is-front').dataset.tabId===id,rearId);
    assert.equal(await workspace.isVisible(),false);
    const handle=stack.getByRole('button',{name:'Move browser preview',exact:true}); const previous=await stack.boundingBox(); await handle.focus(); await handle.press('ArrowLeft'); assert.ok(Math.abs((await stack.boundingBox()).x-(previous.x-12))<3); await handle.press('Home');
    await stack.getByRole('button',{name:'Watch browser',exact:true}).click(); await workspace.waitFor();
    const browser=await page.evaluate(id=>window.tinygpt.workspaceBrowser({conversationId:id,action:'state'}),chat.id); assert.equal(browser.value.activeId,rearId);
    await page.getByRole('button',{name:'Close workspace',exact:true}).click();
    // Closing the selected active browser tab should smoothly select a surviving card.
    await page.evaluate(async ({id,tabId})=>{const result=await window.tinygpt.workspaceBrowser({conversationId:id,tabId,action:'close'}); if(!result.ok)throw Error(result.error);},{id:chat.id,tabId:rearId});
    await page.waitForFunction(id=>document.querySelector('.agent-browser-preview.is-front')?.dataset.tabId!==id,rearId);
    await page.waitForFunction(()=>document.querySelectorAll('.agent-browser-preview').length===4); assert.equal(await workspace.isVisible(),false);
    await page.evaluate(()=>{localStorage.setItem('tinygpt-appearance-v4',JSON.stringify({...JSON.parse(localStorage.getItem('tinygpt-appearance-v4')),theme:'light'}));}); await page.reload(); await stack.waitFor(); await page.waitForFunction(()=>document.querySelector('.agent-browser-preview.is-front img')?.naturalWidth>0);
    await page.screenshot({path:resolve('artifacts/browser-stack-light.png')});
    await app.evaluate(({BrowserWindow})=>{ const window=BrowserWindow.getAllWindows()[0]; window.setMinimumSize(600,400); window.setSize(760,700); }); await page.setViewportSize({width:760,height:700}); await stack.getByRole('button',{name:'Move browser preview',exact:true}).focus();
    await page.waitForFunction(()=>{const cards=[...document.querySelectorAll('.agent-browser-preview')];const pane=document.querySelector('.conversation-pane').getBoundingClientRect();return pane.width<500&&cards.every(card=>{const box=card.getBoundingClientRect();return box.left>=pane.left&&box.right<=pane.right&&box.top>=pane.top});});
    for(let i=0;i<25;i++)await stack.getByRole('button',{name:'Move browser preview',exact:true}).press('Shift+ArrowLeft');
    for(let i=0;i<25;i++)await stack.getByRole('button',{name:'Move browser preview',exact:true}).press('Shift+ArrowUp');
    await page.waitForFunction(()=>{const pane=document.querySelector('.conversation-pane').getBoundingClientRect();return [...document.querySelectorAll('.agent-browser-preview')].every(card=>{const box=card.getBoundingClientRect();return box.left>=pane.left&&box.right<=pane.right&&box.top>=pane.top});});
    await stack.getByRole('button',{name:'Move browser preview',exact:true}).press('Home');
    assert.ok((await page.locator('.conversation-pane').boundingBox()).width<500); await page.screenshot({path:resolve('artifacts/browser-stack-narrow.png')}); await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,1000)); await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(async id=>{const state=(await window.tinygpt.workspaceBrowser({conversationId:id,action:'state'})).value; for(const tab of state.tabs.slice(0,-1)) { const result=await window.tinygpt.workspaceBrowser({conversationId:id,tabId:tab.id,action:'close'}); if(!result.ok)throw Error(result.error); }},chat.id);
    await page.waitForFunction(()=>document.querySelectorAll('.agent-browser-preview').length===1); assert.equal(await stack.locator('.agent-browser-preview-navigation').count(),0);
    await stack.getByRole('button',{name:'Move browser preview',exact:true}).blur();
    await page.evaluate(()=>document.documentElement.dataset.motion='reduce'); assert.equal(await stack.locator('article').evaluate(node=>getComputedStyle(node).transitionDuration),'0s');
    finish(); await stack.waitFor({state:'hidden'});
    for(const label of [...labels,'Web photo']) { const image=page.getByRole('img',{name:label,exact:true}); await image.waitFor(); await image.scrollIntoViewIfNeeded(); await poll(()=>image.evaluate(node=>node.complete&&node.naturalWidth>0)); assert.equal(await image.evaluate(node=>getComputedStyle(node).borderRadius),'12px'); }
    for(const label of ['Missing photo','Private photo','Unsafe photo']) await page.getByRole('img',{name:label,exact:true}).waitFor();
    assert.equal(await page.locator('img[src^="tinygpt-image:"]').count(),0); assert.equal(await page.locator('img[src^="file:"]').count(),0);
    await page.getByRole('img',{name:labels[0],exact:true}).scrollIntoViewIfNeeded(); await page.screenshot({path:resolve('artifacts/answer-images-light.png')});
    await page.evaluate(()=>{localStorage.setItem('tinygpt-appearance-v4',JSON.stringify({...JSON.parse(localStorage.getItem('tinygpt-appearance-v4')),theme:'dark'}));}); await page.reload(); await page.getByRole('img',{name:labels[0],exact:true}).scrollIntoViewIfNeeded(); await poll(()=>page.getByRole('img',{name:labels[0],exact:true}).evaluate(node=>node.naturalWidth>0)); await page.screenshot({path:resolve('artifacts/answer-images-dark.png')});
    assert.deepEqual(errors,[]); console.log(JSON.stringify({checks:['five active tabs, four visible stacked cards','smooth fan animation','previous/next overflow and wrap','select rear card by keyboard','drag keyboard placement preserved','Watch opens selected tab only','closed front tab recovers','narrow pane fit','single tab needs no navigation','reduced-motion honored','completion cleans previews','actual four saved comparison photos render','remote HTTP photo renders','12px image rounding','reload preserves photos','unavailable and cross-conversation images fail safely','no renderer errors'],requests:requests.length,errors}));
  } catch(error) { if(page)await page.screenshot({path:resolve('artifacts/browser-stack-images-failure.png')}).catch(()=>{}); throw error; }
  finally { if(app)await app.close(); server.closeAllConnections(); await new Promise(done=>server.close(done)); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});