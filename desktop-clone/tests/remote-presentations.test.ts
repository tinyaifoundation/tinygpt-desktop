import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { remoteView } from '../src/shared/remote';
import { remoteTool } from '../src/core/remote-tool';
import { remotePresentation } from '../src/core/remote-presentation';
import { generativeAnswerParts } from '../src/core/generative-parts';
import { RemoteMediaBridge } from '../src/main/remote-media';
import { remoteMediaRequestSchema } from '../src/shared/remote-media';
import type { ChatUpdate } from '../src/shared/chat';
import type { ToolActivity } from '../src/shared/tools';

const ui = {root:'table',elements:{table:{type:'Table',props:{columns:[{label:'Plan'},{label:'Price'}],rows:[['Plus',8],['Premium',30]],sortable:true},children:[]}}};
function fixture() {
  const conversationId=randomUUID(),runId=randomUUID();
  const tool:ToolActivity={id:randomUUID(),conversationId,runId,name:'present',summary:'Show a comparison',status:'success',createdAt:1,result:JSON.stringify({ui,privateDebug:'DO_NOT_SHARE_RAW_RESULT'})};
  const message={id:randomUUID(),role:'assistant' as const,text:'Before.After.',status:'complete' as const,error:null,createdAt:1,runId,route:'local' as const,presentations:[{toolId:tool.id,offset:7}]};
  const update:ChatUpdate={conversation:{id:conversationId,projectId:null,title:'Comparison',mode:'chat',createdAt:1,updatedAt:1,messages:[message],sources:[],tools:[tool]},library:{projects:[],conversations:[],lastConversationId:conversationId,activeRuns:[],approvals:[],browserHandoffs:[]}};
  return {tool,message,update,conversationId};
}
it('preserves presentation placement past the ordinary tool tail without sharing raw results',()=>{
  const f=fixture();
  for(let i=0;i<50;i++)f.update.conversation.tools.push({...f.tool,id:randomUUID(),name:'read_source',createdAt:i+2,result:'OTHER_PRIVATE_RESULT'});
  const view=remoteView(f.update),message=view.conversation.messages[0];
  const display=view.conversation.tools.find(tool=>tool.id===f.tool.id)!;
  expect(display.result).toBeNull();expect(display.remotePresentation?.available).toBe(true);
  expect(JSON.stringify(view)).not.toMatch(/DO_NOT_SHARE_RAW_RESULT|OTHER_PRIVATE_RESULT|"Price"/);
  expect(message.presentations).toEqual(f.message.presentations);
  const parts=generativeAnswerParts(message,view.conversation.tools);
  expect(parts.map(part=>part.type)).toEqual(['text','tool-call','text']);
  expect(parts[1]).toMatchObject({toolName:'present',args:{remotePresentation:{toolId:f.tool.id,conversationId:f.conversationId}},result:{presented:true}});
});
it('serves only a validated catalog UI in its authorized conversation and rejects other tools',async()=>{
  const f=fixture(),peer={deviceId:randomUUID(),connectionId:randomUUID(),conversationId:f.conversationId};
  const bridge=new RemoteMediaBridge({importFile:async()=>{throw Error('Unexpected upload');},remove:()=>{},preview:()=>{throw Error('Unexpected pixels');},presentation:(id,toolId)=>remotePresentation(toolId===f.tool.id?f.tool:undefined,id)});
  const request=remoteMediaRequestSchema.parse({id:randomUUID(),jobId:randomUUID(),conversationId:peer.conversationId,op:'tool-ui',toolId:f.tool.id});
  try {
    expect(await bridge.handle(peer,request)).toEqual({ui,partial:false});
    await expect(bridge.handle({...peer,conversationId:randomUUID()},request)).rejects.toThrow('unavailable');
    expect(()=>remotePresentation({...f.tool,name:'read_source'},f.conversationId)).toThrow('unavailable');
    expect(()=>remotePresentation({...f.tool,result:JSON.stringify({ui:{root:'x',elements:{x:{type:'Script',props:{code:'bad'}}}}})},f.conversationId)).toThrow('could not be displayed');
  } finally {bridge.close();}
});
it('updates the visual revision for same-length edits and shares only known icon keys',()=>{
  const f=fixture(),first=remoteTool(f.tool);
  const next=remoteTool({...f.tool,result:f.tool.result!.replace('Plus','Gold')});
  expect(first.remotePresentation?.version).not.toBe(next.remotePresentation?.version);
  expect(remoteTool({...f.tool,name:'ext_fixture'},'gmail/search_mail').iconKey).toBe('gmail/search_mail');
  expect(remoteTool(f.tool,'PRIVATE_ACCOUNT_METADATA').iconKey).toBeUndefined();
});
