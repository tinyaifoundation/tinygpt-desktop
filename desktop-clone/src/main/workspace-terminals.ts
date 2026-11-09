import { randomUUID } from 'node:crypto';
import type { HistoryStore } from './history';
import { scopedPath } from './files';
import { nativeCodePath } from './native-code-tools';
import type { ToolContext } from './tool-broker';
import type { NativeCodeEvent } from '../shared/code';
import { TERMINAL_LOCKED, TERMINAL_UNAVAILABLE, TERMINAL_START_ERROR, type TerminalRequest, type TerminalState, type WorkspaceTerminal } from '../shared/terminal';
import { LocalPtyHost, type LocalPty } from './local-pty';

type Record = { view: WorkspaceTerminal; conversationId: string; projectId: string; root: string; runId?: string; actionId?: string; streamed: number; attaching?: boolean; pty?: LocalPty };
export class WorkspaceTerminals {
  private records = new Map<string,Record>();
  private timer?: ReturnType<typeof setTimeout>;
  private pending = new Set<string>();
  private closing = false;
  private creating = 0;
  hasActiveTerminals() { return this.creating > 0 || [...this.records.values()].some(record => record.view.status !== 'exited' && record.view.status !== 'interrupted'); }
  private host: LocalPtyHost;
  constructor(private history:HistoryStore,root:string,private changed:(state:TerminalState)=>void,host?:LocalPtyHost){this.host=host??new LocalPtyHost(root);}
  state(conversationId:string):TerminalState {return{conversationId,terminals:[...this.records.values()].filter(record=>record.conversationId===conversationId).map(record=>({...record.view}))};}
  private publish(id:string) {if(this.closing)return;this.pending.add(id);this.timer??=setTimeout(()=>{this.timer=undefined;for(const id of this.pending)this.changed(this.state(id));this.pending.clear();},40);}
  private append(record:Record,text:string){record.view.output+=text;if(record.view.output.length>262144){const removed=record.view.output.length-262144;record.view.output=record.view.output.slice(removed);record.view.offset+=removed;}record.view.revision++;this.publish(record.conversationId);}
  private async scope(id:string){const chat=this.history.conversation(id);const project=chat.projectId?this.history.project(chat.projectId):null;const root=await scopedPath(project?.rootPath??null,'.');return{projectId:project!.id,root};}
  private async owned(input:{conversationId:string;id:string},checkScope=true){const record=this.records.get(input.id);if(!record||record.conversationId!==input.conversationId)throw new Error(TERMINAL_UNAVAILABLE);if(checkScope){const scope=await this.scope(input.conversationId);if(scope.projectId!==record.projectId||scope.root!==record.root){await this.remove(record);throw new Error(TERMINAL_UNAVAILABLE);}}return record;}
  private async remove(record:Record){this.records.delete(record.view.id);await record.pty?.close();this.publish(record.conversationId);}
  private fresh(conversationId:string,projectId:string,root:string,owner:'user'|'agent',cwd=root):Record{
    // Retain a bounded set of completed transcripts, without limiting commands.
    const old=[...this.records.values()].filter(record=>!record.view.locked&&!record.pty);while(old.length>20){const record=old.shift()!;this.records.delete(record.view.id);this.publish(record.conversationId);}
    if(this.closing)throw new Error(TERMINAL_UNAVAILABLE);const count=[...this.records.values()].filter(record=>record.conversationId===conversationId&&record.view.owner===owner).length;
    const view:WorkspaceTerminal={id:randomUUID(),title:(owner==='agent'?'Agent terminal':'Terminal')+(count?` ${count+1}`:''),cwd,owner,locked:owner==='agent',busy:false,status:'idle',output:'',offset:0,revision:0};const record={view,conversationId,projectId,root,streamed:0};this.records.set(view.id,record);return record;
  }
  async native(context:ToolContext,event:NativeCodeEvent){
    if(this.closing)return;
    if(event.phase==='before'&&event.name==='code_bash'){
      const scope=await this.scope(context.conversationId);const cwd=await nativeCodePath(scope.root,typeof event.args.workdir==='string'?event.args.workdir:scope.root);
      let record=[...this.records.values()].find(record=>record.runId===context.runId&&!record.actionId&&record.view.cwd===cwd);
      record??=this.fresh(context.conversationId,scope.projectId,scope.root,'agent',cwd);record.runId=context.runId;record.actionId=event.id;record.streamed=0;record.view.locked=true;record.view.busy=true;record.view.status='running';this.append(record,`\r\n❯ ${String(event.args.command)}\r\n`);
    }else if(event.phase!=='before'){
      const record=[...this.records.values()].find(record=>record.actionId===event.id&&record.runId===context.runId);if(!record)return;
      // Native running metadata is cumulative, and may arrive after the final
      // hook. Only append new bytes belonging to this exact command.
      if(event.output.length>record.streamed){this.append(record,event.output.slice(record.streamed).replace(/(?<!\r)\n/g,'\r\n'));record.streamed=event.output.length;}
      if(event.phase==='after'){record.actionId=undefined;record.view.busy=false;record.view.status='idle';this.append(record,`\r\n${event.status==='error'?'Command interrupted or failed':typeof event.metadata?.exit==='number'?`Exited ${event.metadata.exit}`:'Command finished'}\r\n`);}
    }
  }
  endRun(runId:string){for(const record of this.records.values())if(record.runId===runId){record.view.locked=false;record.view.busy=false;if(record.actionId){record.view.status='interrupted';this.append(record,'\r\nAgent reply stopped.\r\n');}record.actionId=undefined;record.runId=undefined;this.publish(record.conversationId);}}
  async run(input:TerminalRequest):Promise<TerminalState>{
    if(this.closing)throw new Error(TERMINAL_UNAVAILABLE);this.history.conversation(input.conversationId);
    if(input.action==='state')return this.state(input.conversationId);
    if(input.action==='create'){
      if([...this.records.values()].filter(r=>r.pty).length+this.creating>=12)throw new Error('Close a terminal before opening another.');
      this.creating++;let record:Record|undefined;
      try{const scope=await this.scope(input.conversationId);record=this.fresh(input.conversationId,scope.projectId,scope.root,'user');await this.attach(record);}catch{if(record)await this.remove(record);throw new Error(TERMINAL_START_ERROR);}finally{this.creating--;}
    }else{
      const record=await this.owned(input,input.action!=='close');if(record.view.locked)throw new Error(TERMINAL_LOCKED);
      if(input.action==='close')await this.remove(record);
      if(input.action==='clear'){record.view.offset+=record.view.output.length;record.view.output='';record.view.revision++;this.publish(input.conversationId);}
      if(input.action==='use'){if(record.pty||record.attaching)throw new Error(TERMINAL_UNAVAILABLE);if([...this.records.values()].filter(r=>r.pty).length+this.creating>=12)throw new Error('Close a terminal before opening another.');this.creating++;try{await this.attach(record);}finally{this.creating--;}}
      if(input.action==='write'){if(!record.pty)throw new Error(TERMINAL_UNAVAILABLE);record.pty.write(input.data);}
      if(input.action==='resize'&&record.pty)await record.pty.resize(input.cols,input.rows);
    }
    return this.state(input.conversationId);
  }
  private async attach(record:Record){
    if(record.attaching||record.pty)throw new Error(TERMINAL_UNAVAILABLE);
    record.attaching=true;record.view.owner='user';record.view.title=record.view.title.replace('Agent terminal','Terminal');record.view.status='starting';this.append(record,'\r\nStarting a new interactive shell…\r\n');
    try{
      record.pty=await this.host.create(record.view.cwd,text=>this.append(record,text),()=>{record.pty=undefined;record.view.status='exited';this.append(record,'\r\nTerminal closed. Start a new shell to continue.\r\n');});
      if(this.closing||!this.records.has(record.view.id)){await record.pty.close();throw new Error(TERMINAL_UNAVAILABLE);}
      const scope=await this.scope(record.conversationId);if(scope.root!==record.root||scope.projectId!==record.projectId){await this.remove(record);throw new Error(TERMINAL_UNAVAILABLE);}
      record.view.status='running';this.publish(record.conversationId);
    }catch{record.view.status='exited';this.append(record,'\r\nThe interactive shell could not start.\r\n');throw new Error(TERMINAL_START_ERROR);}
    finally{record.attaching=false;}
  }
  async closeConversation(id:string){await Promise.allSettled([...this.records.values()].filter(r=>r.conversationId===id&&!r.view.locked).map(r=>this.remove(r)));}
  async shutdown(){this.closing=true;clearTimeout(this.timer);await this.host.shutdown();this.records.clear();}
}
