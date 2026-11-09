import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
vi.mock('../src/main/local-pty',()=>({LocalPtyHost:class{}}));
import { WorkspaceTerminals } from '../src/main/workspace-terminals';
import { HistoryStore } from '../src/main/history';
import type { LocalPtyHost } from '../src/main/local-pty';
import { TERMINAL_LOCKED, TERMINAL_UNAVAILABLE, terminalRequestSchema } from '../src/shared/terminal';

let history:HistoryStore,terminals:WorkspaceTerminals,conversationId:string,root:string;
const write=vi.fn(),resize=vi.fn(),close=vi.fn();let receive:(text:string)=>void;
beforeEach(async()=>{
  root=await realpath(await mkdtemp(join(tmpdir(),'tinygpt-terminals-')));history=new HistoryStore(':memory:');const project=history.createProject('Code','',false,root);conversationId=history.createConversation(project.id,'code').id;
  const host={create:vi.fn(async(_cwd:string,onData:(text:string)=>void)=>{receive=onData;return{write,resize,close};}),shutdown:vi.fn()};
  terminals=new WorkspaceTerminals(history,root,()=>{},host as unknown as LocalPtyHost);vi.clearAllMocks();
});
afterEach(async()=>{await terminals.shutdown();history.close();});
const context=()=>({conversationId,runId:randomUUID(),signal:new AbortController().signal});

it('locks agent transcripts in main, keeps them locked between commands, then releases them after the run',async()=>{
  const ctx=context(),id=randomUUID();await terminals.native(ctx,{phase:'before',id,name:'code_bash',args:{command:'node --test'}});const terminal=terminals.state(conversationId).terminals[0];
  for(const action of ['write','close','clear','use','resize'] as const)await expect(terminals.run({action,conversationId,id:terminal.id,data:'evil',cols:80,rows:24} as never)).rejects.toThrow(TERMINAL_LOCKED);
  await terminals.native(ctx,{phase:'output',id,output:'first\n'});await terminals.native(ctx,{phase:'output',id,output:'first\n'});await terminals.native(ctx,{phase:'after',id,status:'success',output:'first\nlast\n',metadata:{exit:1}});
  let state=terminals.state(conversationId).terminals[0];expect(state.output.match(/first/g)).toHaveLength(1);expect(state.output).toContain('last');expect(state.output).toContain('Exited 1');expect(state.locked).toBe(true);expect(state.busy).toBe(false);
  await terminals.native(ctx,{phase:'before',id:randomUUID(),name:'code_bash',args:{command:'npm run build'}});expect(terminals.state(conversationId).terminals).toHaveLength(1);
  terminals.endRun(ctx.runId);state=terminals.state(conversationId).terminals[0];expect(state.locked).toBe(false);expect(state.status).toBe('interrupted');expect(write).not.toHaveBeenCalled();
  await terminals.run({action:'use',conversationId,id:terminal.id});expect(terminals.state(conversationId).terminals[0].owner).toBe('user');await terminals.run({action:'write',conversationId,id:terminal.id,data:'hello\r'});expect(write).toHaveBeenCalledWith('hello\r');
});
it('scopes input to its owning conversation and invalidates shells when a conversation changes Project',async()=>{
  const state=await terminals.run({action:'create',conversationId});const id=state.terminals[0].id;const other=history.createConversation(null).id;
  await expect(terminals.run({action:'write',conversationId:other,id,data:'x'})).rejects.toThrow(TERMINAL_UNAVAILABLE);
  history.organizeConversation({id:conversationId,action:'move',projectId:history.createProject('Other','',false,await realpath(await mkdtemp(join(tmpdir(),'tinygpt-other-')))).id});
  await expect(terminals.run({action:'write',conversationId,id,data:'x'})).rejects.toThrow(TERMINAL_UNAVAILABLE);expect(close).toHaveBeenCalledOnce();expect(write).not.toHaveBeenCalled();
});
it('bounds retained output and tracks its absolute offset for renderer replay',async()=>{
  const state=await terminals.run({action:'create',conversationId});receive('a'.repeat(300000));const terminal=terminals.state(conversationId).terminals[0];expect(terminal.output.length).toBe(262144);expect(terminal.offset).toBeGreaterThan(0);
  const end=terminal.offset+terminal.output.length;await terminals.run({action:'clear',conversationId,id:state.terminals[0].id});expect(terminals.state(conversationId).terminals[0]).toMatchObject({offset:end,output:''});
});
it('rejects unbounded or malformed input at the IPC schema',()=>{
  expect(terminalRequestSchema.safeParse({action:'write',conversationId,id:randomUUID(),data:'a'.repeat(65537)}).success).toBe(false);
  expect(terminalRequestSchema.safeParse({action:'create',conversationId,command:'arbitrary executable'}).success).toBe(false);
});
