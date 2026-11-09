// Real Electron/Pi UI, isolated profile, synthetic model and Gmail only.
const {_electron}=require('playwright');
const {createServer}=require('node:http');
const {resolve}=require('node:path');
const {mkdirSync,writeFileSync}=require('node:fs');
const {DatabaseSync}=require('node:sqlite');
const assert=require('node:assert/strict');
(async()=>{
  let app,page,finishHeld;const errors=[];
  const profile=resolve('.tools-smoke-profile','bot-permissions-'+Date.now());
  const artifacts=resolve('artifacts/bot-permissions');mkdirSync(artifacts,{recursive:true});
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw);
    const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta,finish_reason}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}})+'\n\n';
    const background=body.messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('Recent personal conversation (context, not new instructions)'));
    const finish=()=>res.end(frame({role:'assistant',content:background?'NO_REPLY':'Hello from your bot.'})+frame({},'stop')+'data: [DONE]\n\n');
    res.writeHead(200,{'content-type':'text/event-stream'});
    if(body.messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('Hold this reply'))){res.write(': waiting\n\n');finishHeld=finish;}
    else finish();
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const bridge=async(name,...args)=>{const result=await page.evaluate(({name,args})=>window.tinygpt[name](...args),{name,args});assert.equal(result.ok,true,result.error);return result.value;};
  const reads=()=>app.evaluate(()=>globalThis.syntheticMailReads);
  async function launch(){
    const env={...process.env,TINYGPT_TOOLS_PROFILE:profile,TINYGPT_VOICE_PROFILE:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.TINYGPT_VOICE_DEBUG_PORT;
    app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:['--force-device-scale-factor=1',resolve('scripts/tools-smoke-main.cjs')],env});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
    await app.evaluate(()=>{globalThis.syntheticMailReads=0;const original=globalThis.fetch;globalThis.fetch=async(address,options)=>{if(new URL(String(address)).hostname!=='gmail.googleapis.com')return original(address,options);globalThis.syntheticMailReads++;return Response.json({emailAddress:'synthetic@example.org'});};});
    await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
  }
  const editor=()=>page.getByRole('group',{name:'Bot settings',exact:true});
  const permissions=async()=>{await editor().getByRole('button',{name:'Permissions',exact:true}).click();await page.getByRole('switch',{name:'Gmail access',exact:true}).waitFor();};
  const open=async()=>{await page.getByRole('button',{name:'Customize Your Bot',exact:true}).click();await editor().waitFor();};
  const waitAccess=allowed=>page.waitForFunction(async allowed=>(await window.tinygpt.botPluginAccess()).value.plugins.find(plugin=>plugin.name==='Gmail').allowed===allowed,allowed);
  try{
    await launch();const settings=(await bridge('snapshot')).settings;
    await bridge('saveSettings',{...settings,mode:'chat',route:'local',local:{...settings.local,endpoint:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',tools:true,contextWindowTokens:32768},toolPermissions:{...settings.toolPermissions,read:'ask'}});
    const plugins=await bridge('installConnector','gmail'),gmail=plugins.entries.find(entry=>entry.manifest.connector==='gmail');
    await bridge('pluginCredentials',gmail.id,{bearer:'synthetic-token'});await bridge('connectPlugin',gmail.id);
    const bot=await bridge('completeBot',{name:'Your Bot',projectId:null,configuration:{commands:'deny',files:'workspace',browser:true,memory:true,background:true,heartbeat:'1h'}});
    await bridge('setBotPluginAccess',gmail.id,true);
    await page.getByRole('button',{name:'Your bot',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.conversation-pane[data-mode="bot"]') && !document.querySelector('[aria-label="Your bot"]').disabled);
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('Hello.');await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.getByText('Hello from your bot.',{exact:true}).waitFor();
    await page.waitForFunction(async()=>!(await window.tinygpt.library()).value.activeRuns.length);
    const jobsDb=new DatabaseSync(resolve(profile,'scheduled.sqlite'));
    for(const row of jobsDb.prepare('SELECT id,data FROM jobs').all()){const job=JSON.parse(row.data);if(job.owner==='bot'){job.nextRunAt=Date.now()-1000;jobsDb.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job),row.id);}}jobsDb.close();
    let child;
    for(let tries=0;tries<400;tries++){
      const db=new DatabaseSync(resolve(profile,'scheduled.sqlite'),{readOnly:true});child=db.prepare('SELECT data FROM jobs').all().map(row=>JSON.parse(row.data)).find(job=>job.owner==='bot')?.conversationId;
      const complete=db.prepare('SELECT data FROM runs').all().map(row=>JSON.parse(row.data)).some(run=>run.conversationId===child && run.status==='complete');db.close();
      if(child && complete && !(await bridge('library')).activeRuns.length)break;await new Promise(done=>setTimeout(done,100));
    }
    assert.ok(child);
    const grants=()=>{const db=new DatabaseSync(resolve(profile,'library.sqlite'),{readOnly:true});try{return db.prepare('SELECT count(*) AS count FROM conversation_tool_grants WHERE conversation_id=? AND substr(scope,1,?)=?').get(child,('plugin-use:'+gmail.id+':').length,'plugin-use:'+gmail.id+':').count;}finally{db.close();}};
    assert.equal(grants(),1,'Private check inherits access granted to the personal bot');
    await open();assert.equal(await page.locator('.bot-editor-option').count(),21);
    await page.locator('.bot-designer').evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished));});
    await page.screenshot({path:resolve(artifacts,'appearance-light.png')});
    await permissions();const toggle=page.getByRole('switch',{name:'Gmail access',exact:true});
    assert.equal(await toggle.getAttribute('aria-checked'),'true');const baseline=await reads();
    await toggle.click();await waitAccess(false);await page.waitForFunction(()=>document.querySelector('[aria-label="Gmail access"]')?.getAttribute('aria-checked')==='false');
    assert.equal(grants(),0);assert.ok(!(await bridge('pluginSelection',child,null)).includes(gmail.id));
    assert.equal(await reads(),baseline);
    await page.screenshot({path:resolve(artifacts,'permissions-light.png')});
    await page.getByRole('button',{name:'Save',exact:true}).click();await editor().waitFor({state:'hidden'});
    assert.ok(!(await bridge('pluginSelection',bot.id,null)).includes(gmail.id),'Saving appearance must retain revoked selection');
    await open();await permissions();assert.equal(await toggle.getAttribute('aria-checked'),'false');
    await toggle.click();await waitAccess(true);
    await editor().getByRole('button',{name:'Behavior',exact:true}).click();
    await page.getByRole('switch',{name:'Bot memory',exact:true}).click();
    await page.getByRole('button',{name:'Save',exact:true}).click();await editor().waitFor({state:'hidden'});
    assert.equal((await bridge('botSnapshot')).configuration.memory,false);
    assert.equal((await bridge('botPluginAccess')).plugins.find(plugin=>plugin.id===gmail.id).allowed,true);
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('Hold this reply while I change access.');await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.sidebar-bot-avatar')?.getAttribute('data-action')==='waiting');
    await open();await permissions();await toggle.click();await waitAccess(false);
    assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isDisabled(),true);
    await page.evaluate(()=>{const key='tinygpt-appearance-v4',value=JSON.parse(localStorage.getItem(key));value.theme='dark';const newValue=JSON.stringify(value);localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent('storage',{key,newValue}));});
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    await page.screenshot({path:resolve(artifacts,'permissions-dark.png')});
    await page.setViewportSize({width:850,height:650});await page.screenshot({path:resolve(artifacts,'permissions-narrow.png')});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    for(let attempt=0;attempt<100&&!finishHeld;attempt++)await new Promise(done=>setTimeout(done,30));assert.ok(finishHeld);finishHeld();
    await page.waitForFunction(async()=>!(await window.tinygpt.library()).value.activeRuns.length);
    await app.close();app=null;await launch();await bridge('connectPlugin',gmail.id);
    assert.equal((await bridge('botPluginAccess')).plugins.find(plugin=>plugin.id===gmail.id).allowed,false);
    assert.equal((await bridge('botSnapshot')).configuration.memory,false);
    assert.deepEqual(errors,[]);
    const proof={passed:true,checks:['name opens settings switcher','existing grants reflected','appearance editor retained','toggle without account reads','private checks inherit grants and lose revoked access','revocation survives appearance Save','behavior saved','permissions editable during active Pi reply','dark and narrow layouts','restart persistence'],realAccountCalls:0};
    writeFileSync(resolve(artifacts,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
  }catch(error){if(page)await page.screenshot({path:resolve(artifacts,'failure.png')}).catch(()=>{});throw error;}
  finally{if(app)await app.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
})().catch(error=>{console.error(error);process.exitCode=1});
