import { browserActionLabel } from '../shared/browser-tool-labels';
import { open, stat } from 'node:fs/promises';
import { relative, resolve, dirname, extname } from 'node:path';
import type { HistoryStore } from './history';
import { scopedPath, readLimited } from './files';
import type { NativeCodeEvent } from '../shared/code';
import type { ToolContext } from './tool-broker';
import type { Settings } from '../shared/config';
import { parseCodeTodos } from '../core/code-progress';
import { acquireFileWrites } from './file-write-locks';
import { prepareFileDestination, fileDestination } from './file-destination';
import { assertWorkEditSize } from '../core/work-limits';

export async function nativeCodePath(root: string, requested: string, creating = false): Promise<string> {
  const path = relative(root,resolve(root,requested)) || '.';
  try { return await scopedPath(root,path,creating); }
  catch(error) {
    if (!creating || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // scopedPath validates the full syntax/protected components before its
    // missing-parent error. Find the closest existing, checked ancestor.
    let parent = dirname(path);
    while(true){ try { const checked = await scopedPath(root,parent); return resolve(checked,relative(parent,path)); } catch(e){ if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e; const next=dirname(parent);if(next===parent)throw e;parent=next; } }
  }
}
type Action = {context:ToolContext;name:string;root:string;projectId:string|null;searchRoot?:string;todos?:unknown;captures?:string[];paths:{path:string;before:string|null;changeId?:string}[]};
export class NativeCodeTools {
  terminals?: Pick<import('./workspace-terminals').WorkspaceTerminals,'native'|'endRun'>;
  private actions = new Map<string,Action>();
  private writes = new Map<string, () => void>();
  constructor(private history: HistoryStore, private authorize: (context:ToolContext,event:Extract<NativeCodeEvent,{phase:'before'}>,category:keyof Settings['toolPermissions'],summary:string,details:string)=>Promise<void>,private changed:(conversationId:string)=>void) {}
  async handle(context:ToolContext,event:NativeCodeEvent):Promise<{output?:string}> {
    if(event.phase==='output'){await this.terminals?.native(context,event).catch(()=>{});return{};}
    if(event.phase==='after'){const result=await this.finish(context,event);await this.terminals?.native(context,event).catch(()=>{});return result;}
    try { const result=await this.prepare(context,event);await this.terminals?.native(context,event).catch(()=>{});return result; }
    catch (error) {
      const action = this.actions.get(event.id);
      for (const snapshot of action?.paths ?? []) if (snapshot.changeId) this.history.setCodeChangeState(snapshot.changeId,'failed');
      this.actions.delete(event.id); this.release(event.id); throw error;
    }
  }
  private release(id:string) { this.writes.get(id)?.(); this.writes.delete(id); }
  private async prepare(context:ToolContext,event:Extract<NativeCodeEvent,{phase:'before'}>):Promise<{output?:string}> {
    assertWorkEditSize(event.name, event.args);
    context.signal.throwIfAborted();const conversation=this.history.conversation(context.conversationId);if(conversation.mode!=='code')throw new Error('Native coding tools require Work mode.');
    const destination=await prepareFileDestination(this.history,context.conversationId,context.signal);const root=destination.root;
    const project=destination.projectId?this.history.project(destination.projectId):null;
    const args=event.args;const browserFiles=event.name==='code_devtools'&&args.tool!=='upload_file'?['filePath','requestFilePath','responseFilePath','traceFilePath'].flatMap(key=>typeof (args.input as Record<string,unknown>)?.[key]==='string'?[(args.input as Record<string,string>)[key]]:[]):[];
    const capture=event.name==='code_devtools'&&args.tool==='take_screenshot';
    const write=['code_write','code_edit','code_apply_patch'].includes(event.name)||browserFiles.length>0;let paths:string[]=[...browserFiles];
    if(['code_read','code_write','code_edit'].includes(event.name)){if(typeof args.filePath!=='string')throw new Error('Invalid file path.');paths=[args.filePath];}
    else if(['code_glob','code_grep'].includes(event.name))paths=[typeof args.path==='string'?args.path:root];
    else if(event.name==='code_bash'){if(typeof args.command!=='string'||args.command.length>12000)throw new Error('Invalid command.');paths=[typeof args.workdir==='string'?args.workdir:root];}
    else if(event.name==='code_apply_patch'){
      if(typeof args.patchText!=='string'||args.patchText.length>200000)throw new Error('Invalid patch.');
      paths=[...args.patchText.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match=>match[1].trim());
      if(!paths.length)throw new Error('Invalid patch.');
      if(/^\*\*\* (?:Delete File|Move to):/m.test(args.patchText))throw new Error('Native patch deletion and moves are unavailable in this increment. Do not bypass this restriction.');
    }
    paths=[...new Set(paths)];if(paths.length>20)throw new Error('Use smaller file changes.');for(const path of paths)await nativeCodePath(root,path,write);
    if(event.name==='code_devtools') {
      if(typeof args.tool!=='string' || !args.input || typeof args.input!=='object')throw new Error('This browser action is unavailable.');
      for(const key of ['filePath','requestFilePath','responseFilePath','traceFilePath']) {
        const path=(args.input as Record<string,unknown>)[key];
        if(typeof path==='string') await nativeCodePath(root,path,true);
      }
    }
    const category=event.name==='code_devtools'?'browser':write?'write':['code_bash','code_delegate'].includes(event.name)?'execute':'read';
    const summary=event.name==='code_delegate'?'Work on code':event.name==='code_bash'?`Run ${String(args.description||'Project command').slice(0,100)}`:event.name==='code_todowrite'?'Update the work plan':`${write?'Edit':event.name==='code_grep'?'Search':event.name==='code_glob'?'Find':'Read'} ${paths.map(path=>relative(root,resolve(root,path))||'.').join(', ')}`;
    await this.authorize(context,event,category,event.name==='code_devtools'?browserActionLabel(args.tool):summary,`Project: ${project?.name??'Generated files'}\n${event.name==='code_devtools'?JSON.stringify(args.input):event.name==='code_delegate'?String(args.task??''):event.name==='code_bash'?`Command: ${args.command}\nWorking directory: ${paths[0]}\nThis shell command uses your OS permissions; it is not an OS sandbox.`:`Paths: ${paths.join(', ')}`}`);
    context.signal.throwIfAborted();if(fileDestination(this.history,context.conversationId).root!==root)throw new Error('The Project folder changed. Select it again.');
    // OpenCode's native reader also detects images by bytes, so extension-only
    // checks would let a renamed image bypass the selected model's capability.
    if (event.name === 'code_read' && (await stat(await nativeCodePath(root, paths[0]))).isFile()) {
      if (['.png','.jpg','.jpeg','.webp','.gif','.bmp','.ico'].includes(extname(paths[0]).toLowerCase())) throw new Error('Use view_image with a relative Project path to inspect images.');
      const file = await open(await nativeCodePath(root, paths[0]), 'r');
      try { const header = Buffer.alloc(12); await file.read(header, 0, 12, 0);
        if (header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || header[0] === 255 && header[1] === 216 || header.toString('ascii', 0, 3) === 'GIF' || header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') throw new Error('Use view_image with a relative Project path to inspect images.');
      } finally { await file.close(); }
    }
    const snapshots:Action['paths']=[];
    let searchRoot:string|undefined;
    if(['code_grep','code_glob'].includes(event.name)){const search=await nativeCodePath(root,paths[0]);searchRoot=(await stat(search)).isDirectory()?search:dirname(search);}
    this.actions.set(event.id,{context,name:event.name,root,projectId:destination.projectId,searchRoot,paths:snapshots,...(capture?{captures:paths.map(path=>relative(root,resolve(root,path)).replaceAll('\\','/'))}:{}),...(event.name==='code_todowrite'?{todos:parseCodeTodos(args.todos).map(todo=>({content:todo.text,status:({active:'in_progress',done:'completed'} as Record<string,string>)[todo.status]??todo.status}))}:{})});
    if(write) { const checked = []; for(const requested of paths) checked.push(await nativeCodePath(root,requested,true)); this.writes.set(event.id, acquireFileWrites(checked)); }
    if(write&&!capture)for(const requested of paths){const path=await nativeCodePath(root,requested,true);let before:string|null=null;try{before=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(await readLimited(path));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if((before?.length??0)>500000)throw new Error('Use smaller files (maximum 500,000 characters).');
      let after=before??'';if(event.name==='code_write'){if(typeof args.content!=='string'||args.content.length>500000)throw new Error('Use smaller files (maximum 500,000 characters).');after=args.content;}
      if(event.name==='code_edit'&&typeof args.oldString==='string'&&typeof args.newString==='string')after=args.replaceAll?after.replaceAll(args.oldString,args.newString):after.replace(args.oldString,args.newString);
      const relativePath=relative(root,resolve(root,requested)).replaceAll('\\','/');const changeId=this.history.saveCodeChange(context.conversationId,context.runId,destination.projectId,root,relativePath,before,after);snapshots.push({path:relativePath,before,changeId});}
    return{};
  }
  private async finish(context:ToolContext,event:Extract<NativeCodeEvent,{phase:'after'}>):Promise<{output?:string}> {
    const action=this.actions.get(event.id);if(!action)return{};this.actions.delete(event.id);let artifacts:Record<string,unknown>[]=[];
    try {
    if(event.status==='success')for(const requested of action.captures??[]){const path=await nativeCodePath(action.root,requested);if((await stat(path)).isFile())artifacts.push(action.projectId?{kind:'project-file',path:requested,projectId:action.projectId}:{kind:'generated-file',path:requested,conversationId:context.conversationId});}
    for(const snapshot of action.paths){try{const path=await nativeCodePath(action.root,snapshot.path);const after=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(await readLimited(path));if(after.length>500000)throw new Error('File too large.');if(after!==snapshot.before){this.history.updateCodeChangeAfter(snapshot.changeId!,after);this.history.setCodeChangeState(snapshot.changeId!,'applied');artifacts.push(action.projectId?{kind:'project-file',path:snapshot.path,projectId:action.projectId}:{kind:'generated-file',path:snapshot.path,conversationId:context.conversationId});}else this.history.setCodeChangeState(snapshot.changeId!,'failed');}catch{this.history.setCodeChangeState(snapshot.changeId!,'conflict');}}
    // Search tools must not return protected or escaping paths through a route
    // that bypasses the read tool's canonical path checks.
    let output=event.output;
    if(['code_grep','code_glob'].includes(action.name)){for(const line of output.split('\n')){const candidate=line.trim().replace(/(?::\d+(?::|\s)|-\d+-\s)[\s\S]*$/,'').replace(/:$/,'');const match=/^(?:[A-Za-z]:[\\/]|\/)/.test(candidate)||/[\\/]/.test(candidate)||/\.[A-Za-z0-9_-]+$/.test(candidate)?candidate:null;if(!match)continue;try{await nativeCodePath(action.root,resolve(action.searchRoot??action.root,match));}catch{output='Some protected or unavailable paths were omitted. Narrow the search to an accessible source directory.';break;}}}
    if(action.name==='code_bash' && typeof event.metadata?.exit==='number')output+=`\n[Command exit code: ${event.metadata.exit}]`;
    const result=JSON.stringify({output:output.slice(0,24000),...(action.todos?{todos:action.todos}:{}),...(typeof event.metadata?.exit==='number'?{exitCode:event.metadata.exit}:{}),...(artifacts.length?{artifact:artifacts[0],artifacts}:{}),truncated:output.length>24000});
    this.history.finishTool(event.id,context.signal.aborted?'cancelled':event.status==='success'&&(!event.metadata?.exit||event.metadata.exit===0)?'success':'error',result);
    if(action.paths.length || action.captures?.length || action.name==='code_bash'){
      if(action.projectId)this.history.sources.removeProjectFiles(action.projectId);else this.history.sources.removeConversationFiles(context.conversationId);
      for (const artifact of artifacts) if (typeof artifact.path === 'string') {
        try { const path = await nativeCodePath(action.root, artifact.path), bytes = await readLimited(path); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.length <= 500000 && !text.includes('\0')) this.history.sources.recordWrittenFile(context.conversationId, artifact.path, text); } catch { /* The saved artifact remains available when its format cannot be indexed as text. */ }
      }
    }
    this.changed(context.conversationId);return{output};
    } finally { this.release(event.id); }
  }
  endRun(runId:string){this.terminals?.endRun(runId);for(const[id,action]of this.actions)if(action.context.runId===runId){this.history.finishTool(id,'interrupted','The coding action was interrupted. Inspect saved changes before continuing.');this.actions.delete(id);this.release(id);}}
}
