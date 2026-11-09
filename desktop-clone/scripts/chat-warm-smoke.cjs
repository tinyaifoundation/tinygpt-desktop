// Two actual LibreChat replies against a free local fixture. No cloud key.
const {_electron}=require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE||'playwright');
const {createServer}=require('node:http'); const {resolve}=require('node:path'); const assert=require('node:assert/strict');
async function main(){
  const server=createServer(async(request,response)=>{for await(const chunk of request){} response.writeHead(200,{'Content-Type':'text/event-stream'});const frame=(delta,finish)=>`data: ${JSON.stringify({id:'warm',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:finish||null}]})}\n\n`;response.end(frame({role:'assistant',content:'Fixture answer.'})+frame({},'stop')+'data: [DONE]\n\n');});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));let app;
  try{
    const env={...process.env,TINYGPT_CHAT_PROFILE:resolve('.chat-smoke-profile',`warm-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;
    app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[resolve('scripts/chat-smoke-main.cjs')],env});const page=await app.firstWindow();await page.getByRole('button',{name:'New chat',exact:true}).waitFor();
    await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows()){window.setIgnoreMouseEvents(true);window.setPosition(-10000,-10000);window.webContents.setBackgroundThrottling(false);}});
    const id=await page.evaluate(async endpoint=>{const bridge=window.tinygpt;const settings=(await bridge.snapshot()).value.settings;const saved=await bridge.saveSettings({...settings,mode:'chat',route:'local',local:{...settings.local,endpoint,model:'fixture',tools:false,contextWindowTokens:8192}});if(!saved.ok)throw new Error(saved.error);return(await bridge.createConversation(null)).value.id;},`http://127.0.0.1:${server.address().port}/v1`);
    const timings=[];
    for(const text of ['First synthetic reply','Second synthetic reply']){
      const started=Date.now(); const sent=await page.evaluate(async({id,text})=>window.tinygpt.sendMessage(id,text,[]),{id,text});assert.equal(sent.ok,true,sent.error);
      const until=Date.now()+45000;let idle=false;while(Date.now()<until){idle=await page.evaluate(async()=>!(await window.tinygpt.library()).value.activeRuns[0]);if(idle)break;await new Promise(done=>setTimeout(done,50));}assert.equal(idle,true);
      const data=await page.evaluate(async id=>({chat:(await window.tinygpt.conversation(id)).value,trace:(await window.tinygpt.diagnostics()).value.runs[0]}),id);assert.equal(data.chat.messages.at(-1).status,'complete',data.chat.messages.at(-1).error);timings.push({wallMs:Date.now()-started,metrics:data.trace.metrics});
    }
    assert.ok(timings[1].metrics.tokenizerMs<500,'Second reply must reuse tokenizer');assert.ok(timings[1].wallMs<2500,'Warm local reply must start promptly');console.log(JSON.stringify({checks:['actual LibreChat worker reuse','two durable replies','cached tokenizer'],timings}));
  }finally{if(app)await app.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
