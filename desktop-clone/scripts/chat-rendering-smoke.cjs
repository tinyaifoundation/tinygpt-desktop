const { _electron } = require(process.env.TINYGPT_PLAYWRIGHT_PACKAGE || 'playwright');
const { build } = require('esbuild');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { existsSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const tree = { root: 'card', elements: {
  card: { type: 'Card', props: { title: 'Generated comparison' }, children: ['table', 'followup'] },
  table: { type: 'Table', props: { columns: [{ label: 'Option' }], rows: [['Grayscale'], ['Default']], sortable: true }, children: [] },
  followup: { type: 'FollowUpGroup', props: { suggestions: [{ label: 'Compare rendering', message: 'Compare rendering modes.' }] }, children: [] },
} };
async function main() {
  let app; let calls=0;
  const server=createServer(async(request,response)=>{
    let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw);
    const metadata=JSON.stringify(body.messages).includes('Describe a saved conversation');
    const event=(delta,finish_reason=null)=>({id:'chatcmpl-render-'+calls,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]});
    const send=(delta,finish)=>response.write(`data: ${JSON.stringify(event(delta,finish))}\n\n`);
    response.writeHead(200,{'Content-Type':'text/event-stream'});
    if(metadata){send({role:'assistant',content:JSON.stringify({title:'Rendering fixture',summary:'Checking tool progress and generated interfaces.',topicChanged:false})},'stop');response.end('data: [DONE]\n\n');return;}
    const step=calls++;
    if(step<3){
      send({role:'assistant',content:step<2?'FLEETING_PRELUDE_'+step:'Here is the comparison.'}); await new Promise(done=>setTimeout(done,30));
      const name=step===2?'present':'search_sources'; const input=step===2?tree:{query:'Rendering '+step};
      send({tool_calls:[{index:0,id:'tool_'+step,type:'function',function:{name,arguments:JSON.stringify(input)}}]});send({},'tool_calls');
    }else{await new Promise(done=>setTimeout(done,300));send({role:'assistant',content:'Final rendering answer.'},'stop');}
    response.end('data: [DONE]\n\n');
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const mainPath=resolve('artifacts/chat-rendering-main.cjs');
  await build({entryPoints:[resolve('scripts/chat-rendering-smoke-main.ts')],outfile:mainPath,bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron','../out/main/index.js']});
  const savedFixture=process.env.TINYGPT_SAVED_UI_FIXTURE||resolve('artifacts/saved-font-interface.json');
  if(!existsSync(savedFixture)) {
    const table={$type:'Table',columns:[{label:'Option'}],rows:Array.from({length:8},(_,index)=>['Rendering option '+index])};
    const list={$type:'ListView',children:[{$type:'ListViewItem',label:'Add --disable-lcd-text before app.whenReady()'}]};
    const follows=Array.from({length:3},(_,index)=>({$type:'FollowUp',label:'Next step '+index,message:'Compare option '+index}));
    writeFileSync(savedFixture,JSON.stringify({$type:'Card',title:'Saved font comparison',children:'['+JSON.stringify(table)+','+JSON.stringify(list)+',"$key":"bad"},'+follows.map(node=>JSON.stringify(node)).join(',')+'],"$key":"extra"}'}));
  }
  const env={...process.env,TINYGPT_TOOLS_PROFILE:resolve('.tools-smoke-profile',`rendering-${Date.now()}`),TINYGPT_SAVED_UI_FIXTURE:savedFixture};env.TINYGPT_VOICE_PROFILE=env.TINYGPT_TOOLS_PROFILE;delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
  try{
    app=await _electron.launch({executablePath:resolve('node_modules/electron/dist/electron.exe'),args:[mainPath],env});
    const page=await app.firstWindow();page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.getByText('Saved research summary.',{exact:true}).waitFor();
    assert.equal(await page.locator('.chat-generative-ui table tbody tr').count(),8);
    assert.equal(await page.locator('.chat-generative-ui .chat-ui-follow-up').count(),3);
    assert.match(await page.locator('.chat-generative-ui').innerText(),/Add --disable-lcd-text/);
    assert.equal((await page.locator('.chat-generative-ui').innerText()).includes('[{"$type"'),false);
    await page.screenshot({path:resolve('artifacts/saved-font-interface-restored.png')});
    if(process.argv.includes('--saved-only')) { assert.deepEqual(errors,[]); console.log('Legacy restoration passed: saved table, recovered list and follow-up controls render through json-render.'); return; }
    await page.evaluate(async endpoint=>{const settings=(await window.tinygpt.snapshot()).value.settings;const result=await window.tinygpt.saveSettings({...settings,route:'local',mode:'chat',local:{...settings.local,endpoint,model:'fixture',tools:true,contextWindowTokens:32768},toolPermissions:{...settings.toolPermissions,read:'allow'}});if(!result.ok)throw Error(result.error);},`http://127.0.0.1:${server.address().port}/v1`);
    await page.reload();await page.locator('.sidebar-nav-action[aria-label="New chat"]').click();
    await page.evaluate(()=>{
      window.preludeFlashes=[];window.sawInterfaceWhileRunning=false;window.proseAfterAnswer=[];
      const inspect=()=>{for(const element of document.querySelectorAll('[data-slot="answer-text"]'))if(element.textContent.includes('FLEETING_PRELUDE'))window.preludeFlashes.push(element.textContent);if(document.querySelector('.chat-generative-ui')&&document.querySelector('[aria-label="Stop reply"]'))window.sawInterfaceWhileRunning=true;if(document.querySelector('.chat-generative-ui')&&document.querySelector('[data-slot="chat-progress"]'))window.proseAfterAnswer.push(document.querySelector('[data-slot="chat-progress"]').textContent);};
      window.renderObserver=new MutationObserver(inspect);window.renderObserver.observe(document.body,{subtree:true,childList:true,characterData:true});
    });
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('Research and compare rendering modes.');await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.getByText('Final rendering answer.',{exact:true}).waitFor();
    assert.equal(await page.locator('.chat-generative-ui table tbody tr').count(),2);
    assert.deepEqual(await page.evaluate(()=>window.preludeFlashes),[]);
    assert.deepEqual(await page.evaluate(()=>window.proseAfterAnswer),[]);
    assert.equal(await page.evaluate(()=>window.sawInterfaceWhileRunning),true);
    await page.getByRole('button',{name:'Compare rendering',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'Compare rendering modes.');
    await page.reload();await page.getByText('Generated comparison',{exact:true}).waitFor();assert.equal(await page.locator('.chat-generative-ui table tbody tr').count(),2);
    assert.deepEqual(errors,[]);console.log('Rendering verified: actual legacy font table/checklist/three follow-ups restored, no research-prelude answer flashes and preserved comparison explanation, native json-render output, final answer and follow-up draft preserved after reload.');
  }catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:resolve('artifacts/chat-rendering-failure.png')});console.error('FIXTURE',await page.evaluate(async()=>{const library=(await window.tinygpt.library()).value;const chat=(await window.tinygpt.conversation(library.lastConversationId)).value;return{active:library.activeRuns,messages:chat.messages.map(message=>({text:message.text,status:message.status,error:message.error})),tools:chat.tools.map(tool=>({name:tool.name,status:tool.status,result:tool.result})),flashes:window.preludeFlashes};}), 'CALLS',calls);}throw error;}finally{if(app)await app.close();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
