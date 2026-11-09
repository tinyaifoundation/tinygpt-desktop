const {_electron}=require('playwright');
const {build}=require('esbuild');
const {createServer}=require('http');
const {resolve}=require('path');
const {mkdirSync,writeFileSync}=require('fs');
const {randomUUID}=require('crypto');
const assert=require('assert/strict');
(async()=>{
  mkdirSync('artifacts/browser-session-audit',{recursive:true});
  const outfile=resolve('artifacts/browser-session-audit/main.cjs');
  await build({stdin:{contents:`
    const {app,BrowserWindow}=require('electron');
    const {BrowserController}=require('./src/main/browser');
    const {BrowserProfiles}=require('./src/main/browser-profiles');
    app.setPath('userData',process.env.TINYGPT_TOOLS_PROFILE);
    let browser;
    app.whenReady().then(async()=>{
      const prefs=()=>({adBlock:false,webLinkDestination:'workspace',localLinkDestination:'workspace',showFullUrl:true,engine:'bing'});
      const profiles=new BrowserProfiles(app.getPath('userData'),prefs);await profiles.load();
      const main=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      browser=new BrowserController(()=>{},()=>main,()=>{},()=>{},profiles,prefs);
      globalThis.browserAudit={browser,profiles};await main.loadURL('about:blank');
    });
    app.on('before-quit',()=>browser?.shutdown());
  `,resolveDir:process.cwd(),sourcefile:'browser-session-audit.js'},outfile,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],loader:{'.png':'dataurl','.ico':'dataurl'}});
  const server=createServer((req,res)=>{
    if(req.url==='/authenticate'){res.writeHead(200,{'Set-Cookie':'audit_session=fixture; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600'}).end('ok');return;}
    const signed=(req.headers.cookie||'').includes('audit_session=fixture');
    res.writeHead(200,{'Content-Type':'text/html'}).end(req.url==='/login'?'<title>Sign in</title><main><h1>Sign in to continue</h1><input type="password" aria-label="Password"><button id="finish" onclick="fetch(\'/authenticate\').then(()=>location=\'/account\')">Finish synthetic login</button></main>':req.url==='/manual-login'?'<title>Verification</title><main><input type="password"><h1>Pending</h1></main>':'<title>Session fixture</title><main><h1>'+(signed?'Authenticated fixture':'Guest fixture')+'</h1></main>');
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const origin='http://127.0.0.1:'+server.address().port,profile=resolve('.tools-smoke-profile','browser-session-audit-'+Date.now());
  const conversationId=randomUUID(),otherConversation=randomUUID(),projectId=randomUUID(),runId=randomUUID();
  mkdirSync(profile,{recursive:true});
  const env={...process.env,TINYGPT_TOOLS_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.TINYGPT_VOICE_DEBUG_PORT;
  let app;
  const launch=async()=>{
    app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[outfile],env});await app.firstWindow();
    for(let i=0;i<100;i++){if(await app.evaluate(()=>!!globalThis.browserAudit))return;await new Promise(done=>setTimeout(done,30));}
    throw Error('Fixture did not initialize');
  };
  const open=(path,conv=conversationId,isolated=false)=>app.evaluate(async(_,args)=>{
    const {browser}=globalThis.browserAudit;
    return browser.open(args.conv,browser.partition(args.projectId,args.isolated),args.url,new AbortController().signal,args.runId);
  },{conv,projectId,isolated,url:origin+path,runId});
  const handoff=async()=>{
    for(let i=0;i<160;i++){const waiting=await app.evaluate(()=>globalThis.browserAudit.browser.handoffs());if(waiting.length)return waiting[0];await new Promise(done=>setTimeout(done,50));}
    throw Error('No sign-in handoff');
  };
  const evaluate=(tabId,code,conv=conversationId)=>app.evaluate(async(_,args)=>globalThis.browserAudit.browser.contents(args.conv,args.tabId).executeJavaScript(args.code),{conv,tabId,code});
  const checks=[];
  try{
    await launch();
    const first=await open('/public');assert.equal((await open('/public')).tabId,first.tabId);
    const list=(conv=conversationId,isolated=false,options={})=>app.evaluate((_,args)=>{const {browser}=globalThis.browserAudit;return browser.listTabs(args.conv,browser.partition(args.projectId,args.isolated),args.options);},{conv,projectId,isolated,options});
    assert.equal((await list()).tabs[0].tabId,first.tabId);
    checks.push('exact URL reuses existing owned tab');
    const next=await app.evaluate(async(_,args)=>globalThis.browserAudit.browser.navigateAgent(args.conversationId,args.tabId,args.url,new AbortController().signal),{conversationId,tabId:first.tabId,url:origin+'/other'});
    assert.equal(next.tabId,first.tabId);checks.push('navigation keeps tab identity');
    const pending=open('/login');const wait=await handoff();
    const original=await app.evaluate(async(_,args)=>{
      const {browser}=globalThis.browserAudit;browser.reveal(args.conversationId,args.tabId);
      const native=browser.contents(args.conversationId,args.tabId);await native.executeJavaScript('document.querySelector("#finish").click()');return native.id;
    },{conversationId,tabId:wait.tabId});
    const signed=await pending;assert.equal(signed.tabId,wait.tabId);assert.match(signed.text,/Authenticated fixture/);
    assert.equal(await app.evaluate((_,args)=>globalThis.browserAudit.browser.contents(args.conversationId,args.tabId).id,{conversationId,tabId:signed.tabId}),original);
    checks.push('synthetic login resumes automatically in same native tab');
    await evaluate(signed.tabId,'localStorage.setItem("audit_profile","shared")');
    const second=await open('/second');assert.notEqual(second.tabId,signed.tabId);assert.match(second.text,/Authenticated fixture/);
    const cross=await open('/third',otherConversation);assert.match(cross.text,/Authenticated fixture/);
    assert.equal(await evaluate(cross.tabId,'localStorage.getItem("audit_profile")',otherConversation),'shared');
    const isolated=await open('/isolated',otherConversation,true);assert.match(isolated.text,/Guest fixture/);
    assert.equal(await evaluate(isolated.tabId,'localStorage.getItem("audit_profile")',otherConversation),null);
    checks.push('HTTP-only login cookie and localStorage shared across tabs and conversations','isolated Project has separate site data');
    assert.ok(!(await list()).tabs.some(tab=>[cross.tabId,isolated.tabId].includes(tab.tabId)));
    assert.equal((await list(otherConversation,true)).tabs.length,1);
    assert.equal((await list(otherConversation,true)).tabs[0].tabId,isolated.tabId);
    const pageOne=await list(conversationId,false,{offset:0,limit:1});assert.equal(pageOne.tabs.length,1);assert.equal(pageOne.nextOffset,1);
    assert.notEqual((await list(conversationId,false,{offset:pageOne.nextOffset,limit:1})).tabs[0].tabId,pageOne.tabs[0].tabId);
    const recovered=(await list()).tabs.find(tab=>tab.tabId===signed.tabId);
    const fresh=await app.evaluate(async(_,args)=>{const {browser}=globalThis.browserAudit;browser.prepareInteraction(args.conversationId,args.tabId,args.runId,false);return browser.snapshot(args.conversationId,args.tabId,new AbortController().signal);},{conversationId,tabId:recovered.tabId,runId:randomUUID()});
    assert.equal(fresh.tabId,recovered.tabId);assert.match(fresh.text,/Authenticated fixture/);
    checks.push('agent tab listing is limited to current conversation and profile','tab listing pagination','listed tab reused with fresh authenticated snapshot');
    const manualPending=open('/manual-login');const manual=await handoff();
    await evaluate(manual.tabId,'document.body.innerHTML="<main>Manual verification complete</main>"');
    await app.evaluate((_,tabId)=>globalThis.browserAudit.browser.resume(tabId),manual.tabId);
    assert.match((await manualPending).text,/Manual verification complete/);checks.push('explicit Resume continues paused tool');
    await app.evaluate(async()=>globalThis.browserAudit.profiles.flush());
    await app.close();app=null;await launch();
    const restored=await open('/after-restart');assert.match(restored.text,/Authenticated fixture/);
    assert.equal(await evaluate(restored.tabId,'localStorage.getItem("audit_profile")'),'shared');
    checks.push('persistent login cookie and localStorage survive Electron restart');
    const report={passed:true,checks,realWebsiteSignIns:0};
    writeFileSync('artifacts/browser-session-audit/proof.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{if(app)await app.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
})().catch(e=>{console.error(e);process.exitCode=1});
