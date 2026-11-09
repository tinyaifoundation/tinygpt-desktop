import type { Conversation, ChatMessage } from '../shared/chat';
import type { ToolActivity } from '../shared/tools';

export interface BotActivity { id:string; title:string; detail:string; messageId?:string; tool?:ToolActivity; browser:boolean; createdAt:number }
const line = (text:string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*#`_]/g,'').split('\n').map(value=>value.trim()).find(Boolean)?.slice(0,120) ?? '';
/** One row per actual reply/check, using its request rather than inventing a summary. */
export function botActivity(conversation: Pick<Conversation,'messages'|'tools'>):BotActivity[] {
  const groups=new Map<string,{messages:ChatMessage[];tools:ToolActivity[]}>();
  for(const message of conversation.messages)if(message.role==='assistant'&&message.runId){const group=groups.get(message.runId)??{messages:[],tools:[]};group.messages.push(message);groups.set(message.runId,group);}
  for(const tool of conversation.tools)if(tool.runId&&tool.name!=='load_tools'){const group=groups.get(tool.runId)??{messages:[],tools:[]};group.tools.push(tool);groups.set(tool.runId,group);}
  const byId=new Map(conversation.messages.map(message=>[message.id,message]));
  return [...groups].flatMap(([id,group])=>{
    const reply=group.messages.at(-1);if(!group.tools.length&&!reply?.text.trim())return [];
    let request=group.messages[0],seen=new Set<string>();
    while(request?.parentId&&!seen.has(request.parentId)){seen.add(request.parentId);const parent=byId.get(request.parentId);if(!parent||parent.role==='assistant'&&parent.runId!==id)break;request=parent;if(parent.role==='user')break;}
    const tools=[...group.tools].sort((a,b)=>a.createdAt-b.createdAt),tool=tools.at(-1);
    const title=(request?.role==='user'?line(request.text):line(reply?.text??''))||(request?.attachmentIds?.length?'Review an attachment':'Bot activity');
    const state=reply?.status==='error'?'Needs attention':reply?.status==='cancelled'||reply?.status==='interrupted'?'Stopped':reply?.status==='streaming'||tools.some(tool=>['pending','running'].includes(tool.status))?'Working':reply?'Reply ready':'Activity recorded';
    return [{id,title,detail:state+(tools.length?' · '+tools.length+' tool '+(tools.length===1?'step':'steps'):''),messageId:reply?.id,tool,browser:tools.some(tool=>tool.name.startsWith('browser_')),createdAt:Math.max(reply?.createdAt??0,tool?.createdAt??0)}];
  }).sort((a,b)=>b.createdAt-a.createdAt).slice(0,5);
}
