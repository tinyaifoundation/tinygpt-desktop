// Disposable, bounded end-to-end build using the previously authorized BYOK.
// Credentials are copied encrypted by code-live-main, never logged.
const {_electron}=require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE||'playwright');
const {resolve,join}=require('node:path');
const {mkdir,readdir,readFile,writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
async function main(){
 const profile=resolve('.tools-smoke-profile',`code-build-${Date.now()}`);const folder=join(profile,'repo');await mkdir(folder,{recursive:true});
 const env={...process.env,TINYGPT_TOOLS_PROFILE:profile,TINYGPT_CODE_REQUEST_LIMIT:'12'};delete env.ELECTRON_RUN_AS_NODE;
 let app,page;const errors=[];const approvals=[];let previousTools=0;let conversationId;
 try{
  app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[resolve('scripts/code-live-main.cjs')],env});page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({BrowserWindow,dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});for(const window of BrowserWindow.getAllWindows()){window.setIgnoreMouseEvents(true);window.setPosition(-10000,-10000);window.webContents.setBackgroundThrottling(false);window.showInactive();}},folder);
  await page.getByRole('button',{name:'New chat',exact:true}).waitFor();
  conversationId=await page.evaluate(async()=>{
   const bridge=window.tinygpt;const choice=await bridge.chooseNewProjectFolder();const project=await bridge.createProject('TinySkills smoke','',false,choice.value.id);const conversation=await bridge.createConversation(project.value.id);
   const sent=await bridge.sendMessage(conversation.value.id,'Create a beautiful ShadCN web app for an agent skills marketplace called TinySkills. Highlight popular skills.md projects on GitHub with quick one-click copy commands to give the skills to agents. For this disposable smoke run, build a small functional starter with representative seed data and no external browsing. Use a few files, actually save the app in this empty Project, and run a meaningful check before answering. Keep the implementation concise.',[]);
   if(!sent.ok)throw new Error(sent.error);return conversation.value.id;
  });
  await page.reload();const started=Date.now();let status;
  while(Date.now()-started<600000){
   const state=await page.evaluate(async id=>{const bridge=window.tinygpt;const library=(await bridge.library()).value;const chat=(await bridge.conversation(id)).value;return {active:!!library.activeRuns[0],approvals:library.approvals.map(a=>({id:a.id,name:a.name})),tools:chat.tools.map(t=>({name:t.name,status:t.status})),status:chat.messages.at(-1).status,error:chat.messages.at(-1).error};},conversationId);
   if(state.tools.length!==previousTools){previousTools=state.tools.length;console.log(JSON.stringify({elapsedMs:Date.now()-started,tools:state.tools}));}
   for(const approval of state.approvals){approvals.push(approval.name);await page.evaluate(async id=>{const result=await window.tinygpt.approveTool(id,'allow-conversation');if(!result.ok)throw new Error(result.error);},approval.id);}
   if(!state.active){status=state;break;}await new Promise(done=>setTimeout(done,1000));
  }
  if(!status)throw new Error('Bounded live build exceeded ten minutes.');
  const data=await page.evaluate(async id=>{const bridge=window.tinygpt;const chat=(await bridge.conversation(id)).value;const changes=(await bridge.codeChanges(id)).value;const diagnostics=(await bridge.diagnostics()).value;return {status:chat.messages.at(-1).status,error:chat.messages.at(-1).error,textChars:chat.messages.at(-1).text.length,echo:chat.messages.at(-1).text.includes('Saved conversation context'),tools:chat.tools.map(t=>{let value={};try{value=JSON.parse(t.result||'{}');}catch{}return{name:t.name,status:t.status,exitCode:value.exitCode,hasArtifact:!!value.artifact};}),changes:changes.map(c=>({path:c.path,state:c.state})),metrics:diagnostics.runs[0]?.metrics};},conversationId);
  await writeFile(join(profile,'build-report.json'),JSON.stringify({...data,approvals,errors},null,2));console.log(JSON.stringify({profile,...data,approvals,errors}));
  assert.equal(data.status,'complete',data.error);assert.equal(data.echo,false);assert.ok(data.textChars>0);
  assert.ok(data.changes.filter(c=>c.state==='applied').length>=2,'Expected a multi-file build');assert.ok(data.tools.some(t=>t.name==='code_bash'&&t.exitCode===0),'Expected a real successful check');assert.deepEqual(errors,[]);
 }finally{if(app)await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
