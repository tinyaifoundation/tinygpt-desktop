import { expect, it } from 'vitest';
import { remoteView } from '../src/shared/remote';
import { remoteWork } from '../src/core/remote-work';
import { workBlocks } from '../src/core/work-activity';
import { ChatUpdateDecoder, ChatUpdateEncoder } from '../src/core/chat-updates';
import type { ChatMessage, ChatUpdate, WorkActivity } from '../src/shared/chat';
import type { ToolActivity } from '../src/shared/tools';

function fixture(){
  const tool=(id:string,name:ToolActivity['name'],time:number):ToolActivity=>({id,name,conversationId:'chat',runId:'run',summary:name==='code_delegate'?'Internal coding runtime':name,status:'running',result:'PRIVATE_TOOL_OUTPUT',createdAt:time});
  const tools=[tool('delegate','code_delegate',1)];
  const activity:WorkActivity[]=[{id:'parent',runId:'run',kind:'tool',toolId:'delegate',text:'',startedAt:1}];
  for(let i=0;i<65;i++){tools.push(tool('child-'+i,'code_read',i*2+3));activity.push({id:'prose-'+i,runId:'run',kind:'prose',text:'Note '+i,agentId:'delegate',startedAt:i*2+2},{id:'tool-'+i,runId:'run',kind:'tool',toolId:'child-'+i,text:'',agentId:'delegate',startedAt:i*2+3});}
  const message:ChatMessage={id:'assistant',role:'assistant',text:'',status:'streaming',error:null,createdAt:0,runId:'run',route:'local',workActivity:activity};
  const update:ChatUpdate={conversation:{id:'chat',projectId:null,title:'Long Work run',mode:'code',createdAt:0,updatedAt:0,messages:[message],tools,sources:[]},library:{projects:[],conversations:[],lastConversationId:'chat',activeRuns:[],approvals:[],browserHandoffs:[]}};
  return {tools,activity,message,update};
}
it('preserves a Coding agent older than the tool/activity tail and keeps its children nested',()=>{
  const f=fixture(),view=remoteView(f.update),message=view.conversation.messages[0];
  expect(view.conversation.tools).toHaveLength(41);expect(view.conversation.tools[0].id).toBe('delegate');
  const blocks=workBlocks(message.workActivity!,view.conversation.tools);
  expect(blocks).toHaveLength(1);expect(blocks[0].kind).toBe('agent');
  if(blocks[0].kind!=='agent')throw Error('Missing Coding agent');
  expect(blocks[0].blocks.filter(part=>part.kind==='tools').flatMap(part=>part.tools)).toHaveLength(40);
  expect(JSON.stringify(view)).not.toContain('PRIVATE_TOOL_OUTPUT');
  expect(f.tools[0].result).toBe('PRIVATE_TOOL_OUTPUT');
});
it('bounds mobile prose and accounts for truncated text without changing native history',()=>{
  const f=fixture();for(const part of f.activity)if(part.kind==='prose')part.text='X'.repeat(6000);
  const parts=remoteWork(f.tools,[f.message]).activity(f.message)!;
  expect(parts.reduce((size,part)=>size+part.text.length,0)).toBeLessThanOrEqual(24000);
  expect(parts.every(part=>part.text.length<=2000)).toBe(true);
  expect(parts.some(part=>part.omittedCharacters)).toBe(true);expect(f.activity[1].text.length).toBe(6000);
  expect(parts.filter(part=>part.kind==='tool')).toHaveLength(41);
});
it('keeps the Coding agent heading for retained older notes and never flattens orphaned agent prose',()=>{
  const f=fixture();for(let i=0;i<45;i++)f.tools.push({...f.tools[1],id:'newer-'+i,runId:'later'});
  const view=remoteView(f.update),blocks=workBlocks(view.conversation.messages[0].workActivity!,view.conversation.tools);
  expect(blocks[0]).toMatchObject({kind:'agent',tool:{id:'delegate'}});
  const missing=remoteWork(f.tools.filter(tool=>tool.id!=='delegate'),[f.message]).activity(f.message)!;
  expect(missing.filter(part=>part.kind==='prose'&&part.agentId)).toEqual([]);
});
it('retains ownership and native part identity through mobile streaming patches and completion',()=>{
  const f=fixture(),encoder=new ChatUpdateEncoder(),decoder=new ChatUpdateDecoder();
  expect(decoder.decode(encoder.encode(remoteView(f.update)))!.conversation.tools[0].id).toBe('delegate');
  f.activity.at(-2)!.text+=' streamed';f.tools[0].status='success';
  const decoded=decoder.decode(encoder.encode(remoteView(f.update)))!;
  expect(decoded.conversation.messages[0].workActivity!.find(part=>part.id==='prose-64')).toMatchObject({agentId:'delegate',text:'Note 64 streamed'});
  expect(workBlocks(decoded.conversation.messages[0].workActivity!,decoded.conversation.tools)[0]).toMatchObject({kind:'agent',tool:{id:'delegate',status:'success'}});
});
