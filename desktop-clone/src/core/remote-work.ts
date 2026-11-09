import type { ChatMessage, WorkActivity } from '../shared/chat';
import type { ToolActivity } from '../shared/tools';

/** A bounded mobile display must keep the owner of every retained child. A
 * simple tail slice drops long-running Coding agent headings and flattens tools. */
export function remoteWork(tools: readonly ToolActivity[], messages: readonly ChatMessage[]) {
  const owners=new Map<string,string>();
  for(const message of messages)for(const part of message.workActivity??[])if(part.toolId&&part.agentId)owners.set(part.toolId,part.agentId);
  const byId=new Map(tools.map(tool=>[tool.id,tool]));
  const retained=new Set(tools.slice(-40).map(tool=>tool.id));
  const keepOwner=(id:string,seen=new Set<string>())=>{
    if(seen.has(id)||seen.size>=8)return;seen.add(id);
    const owner=owners.get(id);if(owner&&byId.get(owner)?.name==='code_delegate'){retained.add(owner);keepOwner(owner,seen);}
  };
  for(const id of [...retained])keepOwner(id);
  // Older visible turns may retain coding notes after all their child tools
  // fall outside the recent-tool window. Keep a bounded set of their headings.
  const noteOwners=new Set<string>();
  for(const message of [...messages].reverse())for(const part of [...(message.workActivity??[])].reverse()){
    if(!part.agentId||!['prose','reasoning'].includes(part.kind)||byId.get(part.agentId)?.name!=='code_delegate')continue;
    if(noteOwners.size>=40&&!noteOwners.has(part.agentId))continue;
    noteOwners.add(part.agentId);retained.add(part.agentId);keepOwner(part.agentId);
  }
  const visibleRuns = new Set(messages.slice(-200).filter(message => message.role === 'assistant').map(message => message.runId));
  // Preserve recent visual answers even when later tools push them past the
  // ordinary tool tail. Pixels/specs are fetched through scoped read-only RPC.
  for (const tool of tools.filter(tool => tool.name === 'present' && visibleRuns.has(tool.runId)).slice(-96)) retained.add(tool.id);
  const selected=tools.filter(tool=>retained.has(tool.id));
  return {
    tools:selected,
    activity(message: ChatMessage): WorkActivity[] | undefined {
      if(!message.workActivity)return undefined;
      const parts=message.workActivity;
      const texts=new Set(parts.filter(part=>part.kind==='prose'||part.kind==='reasoning').slice(-20).map(part=>part.id));
      const steers=new Set(parts.filter(part=>part.kind==='steering').slice(-10).map(part=>part.id));
      const chosen=parts.filter(part=>(!part.agentId||retained.has(part.agentId))&&(part.kind==='tool'?!!part.toolId&&retained.has(part.toolId):texts.has(part.id)||steers.has(part.id)));
      let budget=24000;
      const projected=chosen.map(part=>({...part}));
      for(let i=projected.length-1;i>=0;i--){
        const part=projected[i],size=Math.min(2000,budget,part.text.length);
        const retainedText=size?part.text.slice(-size):'';budget-=retainedText.length;
        const omitted=part.text.length-retainedText.length;
        part.text=retainedText;if(omitted)part.omittedCharacters=(part.omittedCharacters??0)+omitted;
      }
      return projected;
    },
  };
}
