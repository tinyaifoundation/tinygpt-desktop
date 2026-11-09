import { beforeEach,afterEach,it,expect } from 'vitest';
import { mkdtemp,realpath,writeFile,readFile,mkdir,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { nativeCodePath } from '../src/main/native-code-tools';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
let root:string,history:HistoryStore,broker:ToolBroker,conversationId:string,projectId:string;
let settings=structuredClone(defaultSettings);
beforeEach(async()=>{
  root=await realpath(await mkdtemp(join(tmpdir(),'tinygpt-native-code-')));history=new HistoryStore(':memory:');projectId=history.createProject('Code','',false,root).id;conversationId=history.createConversation(projectId,'code').id;
  settings=structuredClone(defaultSettings);settings.toolPermissions.read='allow';settings.toolPermissions.write='allow';settings.toolPermissions.execute='allow';
  broker=new ToolBroker(history,()=>settings,{shutdown(){}} as BrowserController,new ProjectFiles(history.sources),()=>{});
});
afterEach(async()=>{await broker.shutdown();history.close();});
const context=()=>({conversationId,runId:randomUUID(),signal:new AbortController().signal});
it('rejects oversized changes before approval or mutation and permits small edits to a larger file', async () => {
  const ctx = context(), path = join(root, 'large.txt'), before = 'a'.repeat(24000) + 'original'; await writeFile(path, before);
  await expect(broker.nativeCode(ctx, { phase: 'before', id: randomUUID(), name: 'code_write', args: { filePath: path, content: 'b'.repeat(17000) } })).rejects.toThrow('16 KiB');
  expect(await readFile(path, 'utf8')).toBe(before); expect(history.codeChanges(conversationId)).toHaveLength(0);
  const id = randomUUID();
  await broker.nativeCode(ctx, { phase: 'before', id, name: 'code_edit', args: { filePath: path, oldString: 'original', newString: 'updated' } });
  await writeFile(path, before.replace('original', 'updated'));
  await broker.nativeCode(ctx, { phase: 'after', id, status: 'success', output: 'Updated.' });
  expect(history.codeChanges(conversationId)[0].state).toBe('applied');
  await broker.code.undo(conversationId, history.codeChanges(conversationId)[0].id); expect(await readFile(path, 'utf8')).toBe(before);
});
it('applies current browser, interaction and file permissions to native DevTools calls', async () => {
  settings.toolPermissions.browser = 'allow'; settings.toolPermissions.interact = 'allow';
  const ctx = context();
  const event = (tool: string, input: Record<string,unknown> = {}) => ({ phase: 'before' as const, id: randomUUID(), name: 'code_devtools' as const, args: { tool, input } });
  settings.toolPermissions.browser = 'deny'; await expect(broker.nativeCode(ctx, event('list_console_messages'))).rejects.toThrow('blocked');
  settings.toolPermissions.browser = 'allow'; settings.toolPermissions.interact = 'deny';
  const read = event('list_console_messages'); await broker.nativeCode(ctx, read); await broker.nativeCode(ctx, { phase: 'after', id: read.id, status: 'success', output: "SyntaxError: Identifier 'top' has already been declared" });
  expect(history.conversation(conversationId).tools.find(tool => tool.id === read.id)?.summary).toBe('Check browser messages');
  await expect(broker.nativeCode(ctx, event('evaluate_script', { function: '() => document.title' }))).rejects.toThrow('blocked');
  settings.toolPermissions.interact = 'allow'; settings.toolPermissions.write = 'deny';
  await expect(broker.nativeCode(ctx, event('take_screenshot', { filePath: 'shot.png' }))).rejects.toThrow('blocked');
  settings.toolPermissions.write = 'allow';
  await expect(broker.nativeCode(ctx, event('take_screenshot', { filePath: '../outside.png' }))).rejects.toThrow('outside');
  settings.toolPermissions.read = 'deny'; await expect(broker.nativeCode(ctx, event('list_network_requests'))).rejects.toThrow('blocked');
});
it('records binary browser screenshots as artifacts without creating text diffs', async () => {
  settings.toolPermissions.browser = 'allow'; settings.toolPermissions.interact = 'allow';
  const ctx = context(), id = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const captureId = attempt ? randomUUID() : id;
    await broker.nativeCode(ctx, { phase: 'before', id: captureId, name: 'code_devtools', args: { tool: 'take_screenshot', input: { filePath: 'shot.png' } } });
    await writeFile(join(root, 'shot.png'), Buffer.from([137,80,78,71,255]));
    const result = await broker.nativeCode(ctx, { phase: 'after', id: captureId, status: 'success', output: 'Saved shot.png' });
    expect(result).toHaveProperty('output', 'Saved shot.png');
  }
  expect(history.codeChanges(conversationId)).toHaveLength(0);
  expect(history.conversation(conversationId).tools.find(tool => tool.id === id)?.result).toContain('shot.png');
});
it('retains review and Undo for files written by DevTools', async () => {
  settings.toolPermissions.browser = 'allow'; settings.toolPermissions.interact = 'allow';
  const ctx = context(), id = randomUUID();
  await broker.nativeCode(ctx, { phase: 'before', id, name: 'code_devtools', args: { tool: 'get_network_request', input: { responseFilePath: 'response.txt' } } });
  await writeFile(join(root, 'response.txt'), 'Captured response');
  await broker.nativeCode(ctx, { phase: 'after', id, status: 'success', output: 'Saved response.txt' });
  const change = history.codeChanges(conversationId).find(change => change.path === 'response.txt')!;
  expect(change).toMatchObject({ state: 'applied', after: 'Captured response' });
  await broker.code.undo(conversationId, change.id); await expect(readFile(join(root, 'response.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves grep context lines containing markup and still blocks protected results after a long prefix',async()=>{
  await writeFile(join(root,'page.html'),'<style>\n.bar {}\n</style>');
  const ctx=context(),id=randomUUID(); await broker.nativeCode(ctx,{phase:'before',id,name:'code_grep',args:{path:'page.html',pattern:'bar'}});
  const output='page.html-1- <style>\npage.html:2: .bar {}\npage.html-3- </style>';
  expect((await broker.nativeCode(ctx,{phase:'after',id,status:'success',output})).output).toBe(output);
  const second=randomUUID(); await broker.nativeCode(ctx,{phase:'before',id:second,name:'code_grep',args:{pattern:'.'}});
  const blocked=await broker.nativeCode(ctx,{phase:'after',id:second,status:'success',output:'page.html:2: '+ 'x'.repeat(25000)+'\n.env:1: SECRET'});
  expect(blocked.output).not.toContain('SECRET');expect(blocked.output).toContain('protected');
});
it('uses managed Work folders without a Project and preserves module previews and Undo',async()=>{
  conversationId=history.createConversation(null,'code').id;const ctx=context(),id=randomUUID();
  await broker.nativeCode(ctx,{phase:'before',id,name:'code_write',args:{filePath:'nested/result.mjs',content:'export const result = 42;'}});
  const path=join(history.generatedFilesRoot,conversationId,'nested/result.mjs');await mkdir(join(history.generatedFilesRoot,conversationId,'nested'),{recursive:true});await writeFile(path,'export const result = 42;');
  await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:'Saved.'});
  const change=history.codeChanges(conversationId)[0];expect(change.projectId).toBeNull();expect(change.state).toBe('applied');
  expect(JSON.parse(history.conversation(conversationId).tools[0].result!).artifact).toEqual({kind:'generated-file',path:'nested/result.mjs',conversationId});
  const files=new ProjectFiles(history.sources);expect((await files.read(conversationId,join(history.generatedFilesRoot,conversationId),'nested/result.mjs',ctx.signal)).text).toBe('export const result = 42;');
  await broker.code.undo(conversationId,change.id);await expect(readFile(path)).rejects.toMatchObject({code:'ENOENT'});
});
it('filters relative Pi search results for protected files',async()=>{
  const ctx=context(),id=randomUUID();await broker.nativeCode(ctx,{phase:'before',id,name:'code_grep',args:{pattern:'.'}});
  const result=await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:'.env:1: hidden credential'});expect(result.output).not.toContain('hidden credential');
});
it('allows more than forty native actions in one Code turn while retaining path checks',async()=>{
  await writeFile(join(root,'app.js'),'const answer = 42;');const ctx=context();
  for(let index=0;index<45;index++){const id=randomUUID();await broker.nativeCode(ctx,{phase:'before',id,name:'code_read',args:{filePath:'app.js'}});await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:'Read.'});}
  expect(history.conversation(conversationId).tools).toHaveLength(45);expect(history.conversation(conversationId).tools.every(tool=>tool.status==='success')).toBe(true);
  await expect(broker.nativeCode(ctx,{phase:'before',id:randomUUID(),name:'code_read',args:{filePath:'../outside.js'}})).rejects.toThrow('outside');
});
it('persists the native work plan and command failure exit code',async()=>{
  const ctx=context(),todo=randomUUID();await broker.nativeCode(ctx,{phase:'before',id:todo,name:'code_todowrite',args:{todos:[{content:'Build the app',status:'in_progress',priority:'high'}]}});await broker.nativeCode(ctx,{phase:'after',id:todo,status:'success',output:'[]'});
  expect(JSON.parse(history.conversation(conversationId).tools[0].result!).todos).toEqual([{content:'Build the app',status:'in_progress'}]);
  const command=randomUUID();await broker.nativeCode(ctx,{phase:'before',id:command,name:'code_bash',args:{command:'node --test'}});await broker.nativeCode(ctx,{phase:'after',id:command,status:'success',output:'Test failed',metadata:{exit:1}});expect(JSON.parse(history.conversation(conversationId).tools[1].result!).exitCode).toBe(1);
});
it('checks nested creation paths and rejects protected paths, traversal and junctions',async()=>{
  expect(await nativeCodePath(root,'src/components/app.tsx',true)).toBe(join(root,'src/components/app.tsx'));
  await expect(nativeCodePath(root,'../outside.ts',true)).rejects.toThrow('outside');await expect(nativeCodePath(root,'src/.env',true)).rejects.toThrow('Sensitive');
  const outside=await realpath(await mkdtemp(join(tmpdir(),'tinygpt-native-outside-')));await symlink(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir');
  await expect(nativeCodePath(root,'linked/app.ts',true)).rejects.toThrow('outside');
});
it('tracks native writes using actual saved contents and supports guarded undo',async()=>{
  const ctx=context(),id=randomUUID();await broker.nativeCode(ctx,{phase:'before',id,name:'code_write',args:{filePath:join(root,'app.js'),content:'planned'}});
  expect(history.codeChanges(conversationId)[0]).toMatchObject({state:'pending',before:null});await writeFile(join(root,'app.js'),'actual');
  await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:'Saved.'});
  const change=history.codeChanges(conversationId)[0];expect(change).toMatchObject({state:'applied',after:'actual'});
  expect(JSON.parse(history.conversation(conversationId).tools[0].result!).artifact.path).toBe('app.js');await broker.code.undo(conversationId,change.id);await expect(readFile(join(root,'app.js'))).rejects.toMatchObject({code:'ENOENT'});
});
it('denies native commands and honours conversation grants without substituting a tool',async()=>{
  const ctx=context();settings.toolPermissions.execute='deny';await expect(broker.nativeCode(ctx,{phase:'before',id:randomUUID(),name:'code_bash',args:{command:'node --test'}})).rejects.toThrow('blocked');expect(history.conversation(conversationId).tools[0].status).toBe('denied');
  settings.toolPermissions.execute='ask';const id=randomUUID();const pending=broker.nativeCode(ctx,{phase:'before',id,name:'code_bash',args:{command:'node --test'}});
  while(!broker.approvals().length)await new Promise(done=>setTimeout(done,1));broker.respond(id,'allow-conversation');await pending;await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:'passed',metadata:{exit:0}});
  const next=randomUUID();await broker.nativeCode({...ctx,runId:randomUUID()},{phase:'before',id:next,name:'code_bash',args:{command:'node --test'}});expect(broker.approvals()).toHaveLength(0);broker.endRun(ctx.runId);await broker.nativeCode(ctx,{phase:'after',id:next,status:'success',output:'passed',metadata:{exit:0}});
});
it('rejects overlapping native file writes and releases the lock after completion',async()=>{
  const ctx=context(),id=randomUUID();await broker.nativeCode(ctx,{phase:'before',id,name:'code_write',args:{filePath:'app.js',content:'a'}});
  await expect(broker.nativeCode(ctx,{phase:'before',id:randomUUID(),name:'code_write',args:{filePath:'app.js',content:'b'}})).rejects.toThrow('Another edit');
  await writeFile(join(root,'app.js'),'a');await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:'saved'});
  const next=randomUUID();await broker.nativeCode(ctx,{phase:'before',id:next,name:'code_write',args:{filePath:'app.js',content:'b'}});broker.endRun(ctx.runId);
});
it('coordinates writes across conversations and shared file tools',async()=>{
  const first=context(), id=randomUUID(); await broker.nativeCode(first,{phase:'before',id,name:'code_write',args:{filePath:'shared.md',content:'native'}});
  const other=history.createConversation(projectId,'code'); const second={...context(),conversationId:other.id};
  await expect(broker.nativeCode(second,{phase:'before',id:randomUUID(),name:'code_write',args:{filePath:'shared.md',content:'overlap'}})).rejects.toThrow('Another edit');
  // Once a native action owns a path, every shared Project write honors it.
  await expect(new ProjectFiles(history.sources).write(root,'shared.md','chat',first.signal)).rejects.toThrow('Another edit');
  const independent=randomUUID();await broker.nativeCode(second,{phase:'before',id:independent,name:'code_write',args:{filePath:'other.md',content:'independent'}});
  await writeFile(join(root,'other.md'),'independent');await broker.nativeCode(second,{phase:'after',id:independent,status:'success',output:'saved'});
  expect(history.codeChanges(conversationId)[0].state).toBe('pending');
  await writeFile(join(root,'shared.md'),'native');await broker.nativeCode(first,{phase:'after',id,status:'success',output:'saved'});
  await new ProjectFiles(history.sources).write(root,'shared.md','chat',first.signal); expect(await readFile(join(root,'shared.md'),'utf8')).toBe('chat');
  broker.endRun(first.runId);broker.endRun(second.runId);
});
it('checks approval changes and aborts waiting commands',async()=>{
  settings.toolPermissions.execute='ask';const controller=new AbortController();const ctx={...context(),signal:controller.signal};const pending=broker.nativeCode(ctx,{phase:'before',id:randomUUID(),name:'code_bash',args:{command:'node --test'}});
  while(!broker.approvals().length)await new Promise(done=>setTimeout(done,1));controller.abort();await expect(pending).rejects.toThrow();expect(broker.approvals()).toHaveLength(0);expect(history.conversation(conversationId).tools[0].status).toBe('cancelled');
});
it('filters protected search output before the model sees it',async()=>{
  const ctx=context(),id=randomUUID();await broker.nativeCode(ctx,{phase:'before',id,name:'code_grep',args:{pattern:'.'}});
  const result=await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:`Found 1 matches\n${join(root,'.env')}:\n  Line 1: secret`});expect(result.output).not.toContain('secret');
});

it('routes renamed images through view_image while preserving native directory reads', async () => {
  const ctx=context(); const image=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  await writeFile(join(root,'disguised.txt'),image);
  for (const vision of [false,true]) await expect(broker.nativeCode({...ctx,vision},{phase:'before',id:randomUUID(),name:'code_read',args:{filePath:'disguised.txt'}})).rejects.toThrow('Use view_image');
  const id=randomUUID(); await broker.nativeCode(ctx,{phase:'before',id,name:'code_read',args:{filePath:root}}); await broker.nativeCode(ctx,{phase:'after',id,status:'success',output:'Directory listing'});
  expect(history.conversation(conversationId).tools.at(-1)?.status).toBe('success');
});
