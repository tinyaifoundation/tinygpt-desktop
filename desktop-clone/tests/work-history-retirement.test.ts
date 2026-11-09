import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { workContextExtension, repairWorkArgumentHistory } from '../src/main/work-context';
import { ObservationStore } from '../src/main/observations';

const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'work-history-retirement-'));directories.push(directory);return {directory,manager:SessionManager.create(directory,join(directory,'sessions')),store:new ObservationStore(join(directory,'library.sqlite')),conversationId:randomUUID(),runId:randomUUID()};}
function assistant(content:any[],extra:Record<string,unknown>={}){return {role:'assistant',content,api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:1,...extra} as any;}
const result=(id:string,name:string,isError=false)=>({role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text:isError?'Permission denied.':'Applied the requested change.'}],isError,timestamp:2}) as any;

it.each(['success','failed','pending','recent','healthy','cloud','unfinished'])('retires only complete successful old pairs as metadata, preserving exact raw arguments: %s',async kind=>{
 const f=await fixture(),call={type:'toolCall',id:'change',name:'edit',arguments:{path:'app.js',edits:[{oldText:'old-'+ 'x'.repeat(5000),newText:'new-'+ 'y'.repeat(5000)}]}};
 const original=assistant([{type:'thinking',thinking:'r'.repeat(60000)},call,{type:'toolCall',id:'keep',name:'read',arguments:{path:'app.js'}},{type:'text',text:'The change was verified.'}],kind==='unfinished'?{stopReason:'length'}:{});
 const source=f.manager.appendMessage(original);
 if(kind!=='pending')f.manager.appendMessage(result('change','edit',kind==='failed'));
 f.manager.appendMessage(result('keep','read'));
 if(kind!=='recent')for(let i=0;i<8;i++)f.manager.appendMessage({role:'user',content:'Preserve this request '+i,timestamp:10+i});
 const before=f.manager.getBranch().find(entry=>entry.id===source),handlers:Record<string,any>={};
 await workContextExtension(f.store,{conversationId:f.conversationId,runId:f.runId,provider:kind==='cloud'?'openrouter':'local',protocol:'openai-compatible',route:'local',reasoning:{kind:'llamacpp'},contextWindowTokens:65536,maxOutputTokens:16384} as any,f.directory,async()=>({} as any))({on:(name:string,handler:any)=>{handlers[name]=handler;}} as any);
 const projection=f.manager.buildSessionProjection();
 const boundary=await handlers.turn_end({context:{contextEntries:projection.entries,contextMessages:projection.messages}},{getContextUsage:()=>({tokens:kind==='healthy'?20000:40000})});
 for(const entry of boundary?.entries??[])if(entry.type==='context_edit')f.manager.appendContextEdit(entry.targetId,entry.replacement);
 const messages=f.manager.buildSessionProjection().messages,projected=messages.find(message=>message.role==='assistant') as any;
 if(kind==='success'){
  expect(projected.content.filter((part:any)=>part.type==='toolCall').map((part:any)=>part.id)).toEqual(['keep']);
  expect(messages.some(message=>message.role==='toolResult'&&message.toolCallId==='change')).toBe(false);
  expect(messages.some(message=>message.role==='toolResult'&&message.toolCallId==='keep')).toBe(true);
  const note=projected.content.find((part:any)=>part.type==='text'&&part.text.startsWith('Completed edit action'));
  expect(note.text).toContain('historical execution metadata, not file contents');
  const id=note.text.match(/read_observation id=([a-f0-9-]{36})/)[1],record=await f.store.get(f.conversationId,id),action=JSON.parse(record.text);
  expect(action.arguments).toEqual(call.arguments);expect(action.result.content[0].text).toBe('Applied the requested change.');
  const reopened=SessionManager.open(f.manager.getSessionFile()!),fork=SessionManager.forkFrom(reopened.getSessionFile()!,f.directory,join(f.directory,'fork'));
  expect(fork.buildSessionProjection().messages).toEqual(messages);
 }else expect(projected.content.find((part:any)=>part.type==='toolCall'&&part.id==='change')).toEqual(call);
 expect(f.manager.getBranch().find(entry=>entry.id===source)).toEqual(before);
});

it('repairs legacy write/edit argument placeholders on a selected fork without modifying source history',async()=>{
 const f=await fixture();
 const write={type:'toolCall' as const,id:'write',name:'write',arguments:{path:'app.js',content:'EXACT_ORIGINAL_CODE '+ 'x'.repeat(5000)}};
 const edit={type:'toolCall' as const,id:'edit',name:'edit',arguments:{path:'app.js',edits:[{oldText:'original',newText:'repaired'}]}};
 const source=f.manager.appendMessage(assistant([write,edit]));f.manager.appendMessage(result('write','write'));f.manager.appendMessage(result('edit','edit'));
 const archive=randomUUID();f.manager.appendContextEdit(source,{content:[{...write,arguments:{...write.arguments,content:`[Completed write; exact arguments: read_observation id=${archive}]`}},{...edit,arguments:{...edit.arguments,edits:[{oldText:`[Completed edit; exact arguments: read_observation id=${archive}]`,newText:'[See archived arguments.]'}]}}]});
 const file=f.manager.getSessionFile()!,originalFile=await readFile(file,'utf8'),fork=SessionManager.forkFrom(file,f.directory,join(f.directory,'fork'));
 expect(repairWorkArgumentHistory(fork)).toBe(1);
 expect(fork.buildSessionProjection().messages.find(message=>message.role==='assistant')?.content).toEqual([write,edit]);
 expect(repairWorkArgumentHistory(fork)).toBe(0);expect(await readFile(file,'utf8')).toBe(originalFile);
 expect(f.manager.buildSessionProjection().messages.find(message=>message.role==='assistant')?.content).not.toEqual([write,edit]);
});
