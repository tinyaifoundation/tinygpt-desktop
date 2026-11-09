const {_electron}=require('playwright');
const {build}=require('esbuild');
const {resolve,join}=require('path');
const {mkdirSync,readFileSync,writeFileSync}=require('fs');
const {randomUUID}=require('crypto');
const assert=require('assert/strict');

(async()=>{
  const root=resolve('artifacts/passwords-smoke');mkdirSync(root,{recursive:true});
  const profile=resolve('.tools-smoke-profile','passwords-'+Date.now());mkdirSync(profile,{recursive:true});
  await build({entryPoints:['src/preload/passwords.ts'],outfile:join(root,'passwords-preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron']});
  // The production service rejects remote debugging. This fixture explicitly
  // removes the test launcher's switches and uses a fake store, never OS logins.
  const main=join(root,'main.cjs');
  await build({stdin:{contents:`
    const {app,BrowserWindow,session,ipcMain,webContents}=require('electron');
    const {PasswordManager}=require('./src/main/passwords');
    const {passwordPrivacy}=require('./src/main/password-privacy');
    const {BrowserController}=require('./src/main/browser');
    const {ToolBroker}=require('./src/main/tool-broker');
    const {HistoryStore}=require('./src/main/history');
    const {preparePasswordForm,fillPasswordForm}=require('./src/core/password-form');
    app.setPath('userData',process.env.TINYGPT_TOOLS_PROFILE);
    app.on('window-all-closed',()=>{});
    app.whenReady().then(async()=>{
      const partition='persist:tinygpt-browser',profile=session.fromPartition(partition);
      profile.setPermissionRequestHandler((_c,_p,done)=>done(false));profile.setPermissionCheckHandler(()=>false);
      const form='<form action="/account" method="post"><label>User<input id="user" autocomplete="username"></label><label>Password<input id="pass" type="password" autocomplete="current-password"></label><button>Sign in</button></form>';
      await profile.protocol.handle('https',async request=>{
        if(new URL(request.url).pathname==='/account'){await profile.cookies.set({url:'https://password-fixture.invalid',name:'synthetic_session',value:'signed-in',secure:true,httpOnly:true});return new Response('<h1>Signed in</h1>',{headers:{'content-type':'text/html'}});}
        return new Response('<!doctype html><title>Synthetic sign-in</title><style>input,button{display:block;margin:16px;padding:12px}</style>'+form,{headers:{'content-type':'text/html'}});
      });
      const main=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await main.loadURL('about:blank');
      const browser=new BrowserController(()=>{},()=>main);
      const items=new Map();const auth={cancel:false,waiting:false,release:null,delay:false};
      const store={available:async()=>true,put:async(target,value)=>{items.set(target,{...value});},remove:async target=>{items.delete(target);},fill:async(target,_owner,consume)=>{if(auth.delay){auth.waiting=true;await new Promise(done=>auth.release=done);auth.waiting=false;}if(auth.cancel)throw Error('Password access was canceled or could not be verified.');await consume({...items.get(target)});}};
      const manager=new PasswordManager(async()=>{if(!passwordPrivacy.active)throw Error('Privacy barrier was late');},store);
      // Use the dedicated test preload location without changing the product URL.
      const open=manager.open.bind(manager);
      manager.open=async(...args)=>{
        app.commandLine.removeSwitch('remote-debugging-port');app.commandLine.removeSwitch('remote-debugging-pipe');process.execArgv=process.execArgv.filter(arg=>!arg.startsWith('--inspect'));
        return open(...args);
      };
      const {copyFileSync,mkdirSync}=require('fs'),{join}=require('path');
      mkdirSync(join(__dirname,'../preload'),{recursive:true});copyFileSync(${JSON.stringify(join(root,'passwords-preload.cjs'))},join(__dirname,'../preload/passwords.js'));
      const broker=new ToolBroker(new HistoryStore(':memory:'),()=>({}),browser,{},()=>{});
      globalThis.passwordAudit={main,browser,manager,store,items,auth,privacy:passwordPrivacy,broker,form,preparePasswordForm,fillPasswordForm};
    }).catch(error=>{globalThis.passwordAuditError=String(error?.stack||error);});
  `,resolveDir:process.cwd(),sourcefile:'passwords-smoke-main.ts'},outfile:main,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron','koffi'],loader:{'.png':'dataurl','.ico':'dataurl'}});
  const env={...process.env,TINYGPT_TOOLS_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.TINYGPT_VOICE_DEBUG_PORT;
  const app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[main],env});
  const checks=[];const sentinel='SYNTHETIC_PASSWORD_SENTINEL_7z!';
  const pageEval=code=>app.evaluate(async(_,{code})=>globalThis.passwordAudit.manager.current.page.webContents.executeJavaScript(code),{code});
  let conversationId=randomUUID(),tabId;
  const open=async()=>{
    for(let i=0;i<100;i++){if(await app.evaluate((_,{conversationId,tabId})=>!globalThis.passwordAudit.browser.contents(conversationId,tabId).isLoadingMainFrame(),{conversationId,tabId}))break;await new Promise(done=>setTimeout(done,30));}
    const pending=app.waitForEvent('window');
    void pending.catch(()=>{});
    await app.evaluate(async(_,{conversationId,tabId})=>{
      const a=globalThis.passwordAudit;await a.manager.open(a.main,a.browser.passwordContext(conversationId,tabId),async()=>a.browser.navigateWorkspace(conversationId,tabId,'https://password-fixture.invalid/'));
    },{conversationId,tabId});
    const page=await pending;await page.getByRole('button',{name:'Fill password',exact:true}).waitFor();
    for(let i=0;i<100;i++){if(await pageEval('!!document.querySelector("#pass")'))break;await new Promise(done=>setTimeout(done,30));}
    return page;
  };
  try{
    await app.firstWindow();for(let i=0;i<100;i++){const error=await app.evaluate(()=>globalThis.passwordAuditError);if(error)throw Error(error);if(await app.evaluate(()=>!!globalThis.passwordAudit))break;await new Promise(done=>setTimeout(done,30));}
    tabId=await app.evaluate(async(_,conversationId)=>{const a=globalThis.passwordAudit,id=a.browser.newWorkspaceTab(conversationId,'persist:tinygpt-browser');await a.browser.navigateWorkspace(conversationId,id,'https://password-fixture.invalid/login');return id;},conversationId);
    let page=await open();
    await page.screenshot({path:join(root,'private-sign-in-empty.png')});
    assert.equal(await app.evaluate(()=>globalThis.passwordAudit.privacy.active),true);
    assert.equal(await app.evaluate((_,conversationId)=>globalThis.passwordAudit.browser.workspaceState(conversationId).tabs.length,conversationId),1);
    const blocked=await app.evaluate(async(_,{conversationId,tabId})=>{
      const a=globalThis.passwordAudit,out=[];for(const action of [()=>a.browser.capture(conversationId,tabId),()=>a.browser.snapshot(conversationId,tabId,new AbortController().signal),()=>Promise.resolve(a.browser.contents(conversationId,tabId))])try{await action();out.push(false);}catch{out.push(true);}
      const result=JSON.parse(await a.broker.execute({conversationId,runId:crypto.randomUUID(),signal:new AbortController().signal},{id:crypto.randomUUID(),name:'load_tools',input:{group:'browser'}}));return {out,result};
    },{conversationId,tabId});assert.deepEqual(blocked.out,[true,true,true]);assert.equal(blocked.result.code,'PRIVATE_SIGN_IN');checks.push('browser/preview/tools cannot read or capture while private sign-in is open');
    assert.equal(await pageEval('typeof window.electron+":"+typeof window.tinygpt+":"+typeof require'),'undefined:undefined:undefined');
    const forged=await app.evaluate(async({ipcMain})=>{const a=globalThis.passwordAudit,handler=ipcMain._invokeHandlers.get('tinygpt:private-password');return handler({sender:a.main.webContents,senderFrame:a.main.webContents.mainFrame},{action:'state'});});assert.equal(forged.ok,false);checks.push('password IPC rejects other app renderers');
    await page.getByRole('textbox',{name:'Username',exact:true}).fill('fixture-user');await page.locator('#password').fill(sentinel);await page.getByRole('button',{name:'Save',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Saved locally'}).waitFor();assert.equal(await page.locator('#password').inputValue(),'');
    const bytes=readFileSync(join(profile,'browser-passwords/accounts.enc'));assert.equal(bytes.includes(Buffer.from(sentinel)),false);assert.equal(bytes.includes(Buffer.from('fixture-user')),false);checks.push('save clears input and persists no plaintext password or account label');
    await page.getByRole('button',{name:'Fill password',exact:true}).click();await page.getByRole('status').filter({hasText:'Filled.'}).waitFor();
    assert.equal(await pageEval('document.querySelector("#pass").value=== '+JSON.stringify(sentinel)),true);assert.equal(await pageEval('document.querySelector("#user").value'),'fixture-user');checks.push('user-triggered fill reaches only private native page; no automatic submit');
    await pageEval('document.querySelector("#pass").value=""');await app.evaluate(()=>{globalThis.passwordAudit.auth.cancel=true;});await page.getByRole('button',{name:'Fill password',exact:true}).click();await page.getByRole('status').filter({hasText:'canceled'}).waitFor();assert.equal(await pageEval('document.querySelector("#pass").value'),'');checks.push('canceled OS-auth adapter does not fill');
    await app.evaluate(()=>{const a=globalThis.passwordAudit;a.auth.cancel=false;a.auth.delay=true;});await page.getByRole('button',{name:'Fill password',exact:true}).click();
    for(let i=0;i<100;i++){if(await app.evaluate(()=>globalThis.passwordAudit.auth.waiting))break;await new Promise(done=>setTimeout(done,20));}
    await pageEval('document.querySelector("#pass").outerHTML="<input id=pass type=password>"');await app.evaluate(()=>{const a=globalThis.passwordAudit;a.auth.delay=false;a.auth.release();});await page.getByRole('status').filter({hasText:'page changed'}).waitFor();assert.equal(await pageEval('document.querySelector("#pass").value'),'');checks.push('a form replaced during authentication cannot receive a saved password');
    await app.evaluate(async()=>{const a=globalThis.passwordAudit;await a.manager.current.page.webContents.loadURL('https://other-fixture.invalid/login');});await page.getByRole('button',{name:'Fill password',exact:true}).click();await page.getByRole('status').filter({hasText:'page changed'}).waitFor();assert.equal(await pageEval('document.querySelector("#pass").value'),'');checks.push('cross-origin navigation rejects fill');
    await app.evaluate(async()=>{const a=globalThis.passwordAudit;await a.manager.current.page.webContents.loadURL('https://password-fixture.invalid/login');});
    await page.getByRole('button',{name:'Fill password',exact:true}).click();await page.getByRole('status').filter({hasText:'Filled.'}).waitFor();
    await pageEval('document.querySelector("form").requestSubmit()');for(let i=0;i<100;i++){if(await pageEval('!!document.querySelector("h1")'))break;await new Promise(done=>setTimeout(done,30));}
    await page.getByRole('button',{name:'Finish sign-in',exact:true}).click();for(let i=0;i<100;i++){if(!await app.evaluate(()=>globalThis.passwordAudit.privacy.active))break;await new Promise(done=>setTimeout(done,30));}
    assert.equal(await app.evaluate(()=>globalThis.passwordAudit.privacy.active),false);
    const cookie=await app.evaluate(async({session})=>(await session.fromPartition('persist:tinygpt-browser').cookies.get({name:'synthetic_session'})).length);assert.equal(cookie,1);checks.push('finishing destroys private page and preserves authenticated browser session');
    // Test each form guard directly on a synthetic document; return booleans only.
    page=await open();
    const guards=await app.evaluate(async()=>{
      const a=globalThis.passwordAudit,w=a.manager.current.page.webContents,origin='https://password-fixture.invalid';const result=[];
      const check=async edit=>{await w.executeJavaScript('document.body.innerHTML='+JSON.stringify(a.form)+';'+edit);return w.executeJavaScriptInIsolatedWorld(2001,[{code:'('+a.preparePasswordForm.toString()+')('+JSON.stringify(origin)+',"test")'}]);};
      result.push(await check('document.querySelector("form").action="https://evil.invalid/steal"'));
      result.push(await check('document.querySelector("form").method="get"'));
      result.push(await check('document.querySelector("#pass").style.opacity="0"'));
      result.push(await check('document.querySelector("#pass").autocomplete="new-password"'));
      result.push(await check('document.body.insertAdjacentHTML("beforeend","<iframe srcdoc=\\"<input type=password>\\"></iframe>");document.querySelector("form").remove()'));
      return result;
    });assert.deepEqual(guards,[false,false,false,false,false]);checks.push('cross-origin submit, GET, invisible, new-password, and iframe-only forms fail closed');
    // Reload a normal form, then close during delayed OS authentication. Tools
    // remain blocked until that pending auth completes and its secret is dropped.
    await app.evaluate(async()=>{const a=globalThis.passwordAudit;await a.manager.current.page.webContents.loadURL('https://password-fixture.invalid/login');a.auth.delay=true;});
    await page.getByRole('button',{name:'Fill password',exact:true}).click();for(let i=0;i<100;i++){if(await app.evaluate(()=>globalThis.passwordAudit.auth.waiting))break;await new Promise(done=>setTimeout(done,20));}
    await pageEval('window.onbeforeunload=event=>{event.preventDefault();event.returnValue="stay";};void 0');
    await app.evaluate(({powerMonitor})=>{powerMonitor.emit('lock-screen');});assert.equal(await app.evaluate(()=>globalThis.passwordAudit.privacy.active),true);
    await app.evaluate(()=>{globalThis.passwordAudit.auth.release();});for(let i=0;i<100;i++){if(!await app.evaluate(()=>globalThis.passwordAudit.privacy.active))break;await new Promise(done=>setTimeout(done,20));}assert.equal(await app.evaluate(()=>globalThis.passwordAudit.privacy.active),false);checks.push('OS lock destroys private page despite beforeunload; tools wait for pending auth to finish');
    const report={passed:true,checks,realWebsiteSignIns:0,realPasswordsRead:0};writeFileSync(join(root,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
