import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createPiAssistant} from '../src/main/pi-assistant';
import {ScheduledStore} from '../src/main/scheduled-store';
import {saveBotWatch} from '../src/main/bot-watch';
import {BotService} from '../src/main/bot-service';
import {HistoryStore} from '../src/main/history';
import {defaultSettings} from '../src/shared/config';
import {defaultBotConfiguration} from '../src/shared/bot';
import type {ChatWorkerInput} from '../src/shared/chat';

it('resumes browser tools and escapes alternating successful watch no-ops through the real Pi SDK',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tinygpt-assistant-state-')),store=new ScheduledStore(':memory:');
  const bodies:any[]=[],host:string[]=[],tabId='7b5f8786-b24a-4179-9cb3-574d4c5af413';
  let mode='setup',step=0,watchCalls=0,browser=true,clicked=false;
  const server=createServer(async(request,response)=>{
    let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw);bodies.push(body);step++;
    let tool:{name:string;arguments:string}|undefined;
    if(mode==='setup'&&step===1)tool={name:'load_tools',arguments:JSON.stringify({group:'browser'})};
    if(mode==='setup'&&step===2)tool={name:'browser_snapshot',arguments:JSON.stringify({tabId})};
    if(mode==='loop'){
      if(body.tools.some((tool:any)=>tool.function.name==='bot_watch')&&step<=6)tool={name:'bot_watch',arguments:JSON.stringify({title:step%2?'Release news':'Watch releases',prompt:'Check official release announcements.',minutes:60})};
      else if(!clicked){clicked=true;tool={name:'browser_click',arguments:JSON.stringify({tabId,elementId:'t1'})};}
    }
    const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'state-'+bodies.length,type:'function',function:tool}]}:{role:'assistant',content:'The requested browser action is verified.'};
    const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:150,completion_tokens:25,total_tokens:175}};
    response.writeHead(200,{'content-type':'text/event-stream'}).end('data: '+JSON.stringify(chunk)+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const input:ChatWorkerInput={runId:'setup',conversationId:'fixture',replyMessageId:'first',route:'local',provider:'local',protocol:'openai-compatible',endpoint:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture',tools:true,instructions:'Use the browser for requested browser actions.',messages:[{role:'user',text:'Inspect the browser page.'}],contextWindowTokens:32000,maxOutputTokens:1024};
  const execution=()=>createPiAssistant(async()=>({root:directory,instructions:'You are a personal assistant.',allow:name=>name==='load_tools'||browser&&['browser_snapshot','browser_click'].includes(name),stateTools:['bot_watch'],customTools:[{name:'bot_watch',label:'Watch',description:'Save a recurring interest check.',parameters:{type:'object',properties:{title:{type:'string'},prompt:{type:'string'},minutes:{type:'integer'}},required:['title','prompt','minutes']} as any,execute:async(_id,args)=>{watchCalls++;return{content:[{type:'text',text:JSON.stringify(saveBotWatch(store,args))}],details:undefined};}}]}));
  const hostTool=async(request:any)=>{host.push(request.name);return JSON.stringify({ok:true,targets:[{id:'t1',role:'button',label:'Requested action'}]});};
  try{
    await execution().run(input,AbortSignal.timeout(40000),()=>{},hostTool);
    mode='loop';step=0;const start=bodies.length;
    const next={...input,runId:'loop',replyMessageId:'second',messages:[...input.messages,{id:'first',role:'assistant' as const,text:'The page is ready.'},{role:'user' as const,text:'Perform that action.'}]};
    await execution().run(next,AbortSignal.timeout(40000),()=>{},hostTool);
    expect(bodies[start].tools.some((tool:any)=>tool.function.name==='browser_click')).toBe(true);
    expect(watchCalls).toBe(3);expect(store.jobs('bot')).toHaveLength(1);
    const resumed=bodies.find((body,index)=>index>=start&&!body.tools.some((tool:any)=>tool.function.name==='bot_watch'));
    expect(resumed).toBeDefined();expect(JSON.stringify(resumed.messages)).toContain('Saving a watch does not perform the action');
    expect(host).toEqual(['browser_snapshot','browser_click']);expect(bodies.length-start).toBe(5);
    mode='final';step=0;browser=false;
    await execution().run({...next,runId:'next',replyMessageId:'third',messages:[...next.messages,{id:'second',role:'assistant',text:'Done.'},{role:'user',text:'Thanks.'}]},AbortSignal.timeout(40000),()=>{},hostTool);
    expect(bodies.at(-1).tools.some((tool:any)=>tool.function.name==='bot_watch')).toBe(true);
    expect(bodies.at(-1).tools.some((tool:any)=>tool.function.name==='browser_click')).toBe(false);
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();
    const target=resolve(directory);if(dirname(target).toLowerCase()!==resolve(tmpdir()).toLowerCase()||!basename(target).startsWith('tinygpt-assistant-state-'))throw Error('Unexpected fixture path');await rm(target,{recursive:true,force:true});
  }
},90000);

it('removes completed watches through the actual Bot profile and Pi tool execution with initiative off',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tinygpt-assistant-state-')),history=new HistoryStore(join(directory,'library.sqlite')),store=new ScheduledStore(join(directory,'scheduled.sqlite'));
  const bot=new BotService(directory,history,()=>defaultSettings,()=>{},async()=>{});bot.schedules=store;
  const watches=[saveBotWatch(store,{title:'Verify workflow',prompt:'Verify the completed workflow change.',minutes:30}),saveBotWatch(store,{title:'Verify email gap',prompt:'Verify no new alerts after the fix.',minutes:30})],bodies:any[]=[];
  const server=createServer(async(request,response)=>{
    let raw='';for await(const part of request)raw+=part;const body=JSON.parse(raw),step=bodies.length;bodies.push(body);
    const tool=step<watches.length?{name:'bot_watch_remove',arguments:JSON.stringify({id:watches[step].id})}:undefined;
    const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'remove-'+step,type:'function',function:tool}]}:{role:'assistant',content:'Both verification watches have been removed.'};
    response.writeHead(200,{'content-type':'text/event-stream'}).end('data: '+JSON.stringify({id:'remove-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:150,completion_tokens:25,total_tokens:175}})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const conversation=await bot.complete({name:'Milo',projectId:null,configuration:{...defaultBotConfiguration,background:false,memory:false,browser:false}});
    let output='';await bot.run({conversationId:conversation.id,runId:'cleanup',replyMessageId:'cleanup-reply',route:'local',provider:'local',protocol:'openai-compatible',endpoint:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture',tools:true,instructions:'The user confirmed the monitored task is done.',messages:[{role:'user',text:'You handled it. Remove both verification watches and stop watching.'}],contextWindowTokens:32000,maxOutputTokens:1024},AbortSignal.timeout(40000),()=>{},async()=>{throw Error('No external tools should be called.');},undefined,event=>{if(event.type==='bot-messages')output=event.messages.join('\n');});
    expect(bodies).toHaveLength(3);expect(bodies[0].tools.some((tool:any)=>tool.function.name==='bot_watch_remove')).toBe(true);
    expect(bodies[0].tools.some((tool:any)=>tool.function.name==='bot_watch')).toBe(false);
    expect(bodies.at(-1).messages.filter((message:any)=>message.role==='tool').map((message:any)=>JSON.parse(message.content).removed)).toEqual([true,true]);expect(store.jobs('bot')).toHaveLength(0);expect(output).toContain('removed');
  }finally{
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await bot.shutdown();store.close();history.close();
    const target=resolve(directory);if(dirname(target).toLowerCase()!==resolve(tmpdir()).toLowerCase()||!basename(target).startsWith('tinygpt-assistant-state-'))throw Error('Unexpected fixture path');await rm(target,{recursive:true,force:true});
  }
},60000);
