import {it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {HistoryStore} from '../src/main/history';
import {desktopRemoteManagement} from '../src/main/desktop-remote-management';
import {defaultSettings} from '../src/shared/config';
it('uses real history operations while projecting no paths, instructions or memory bodies until opened',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tinygpt-phase2-')),history=new HistoryStore(join(directory,'history.sqlite'));let settings=structuredClone(defaultSettings);const settingsChanged=vi.fn(),memoryChanged=vi.fn(),moving=vi.fn(async()=>{});
 try{
  const project=history.createProject('Private project','PRIVATE_INSTRUCTIONS',true,'C:/PRIVATE_FOLDER'),conversation=history.createConversation(null,'chat');history.memory.saveMemory({projectId:null,title:'Preference',text:'PRIVATE_MEMORY_BODY',enabled:true});
  const dependency={history,store:{getSettings:()=>settings,saveSettings:async(value:typeof settings)=>{settings=value;}},plugins:{snapshot:()=>({entries:[]}),store:{captureSelection:async()=>{}},track:async(operation:()=>unknown)=>operation()},chat:{library:()=>({conversations:history.conversations(),activeRuns:[],approvals:[],workQuestions:[]}),assertIdle:()=>{},assertProjectIdle:()=>{}},remote:{status:()=>({keepAwake:false})},version:'test',voices:async()=>[],memorySnapshot:()=>({memories:history.memory.memories(),includePersonal:false}),settingsChanged,memoryChanged,moving,projectCreated:vi.fn()};
  const adapter=desktopRemoteManagement(dependency as unknown as Parameters<typeof desktopRemoteManagement>[0]),snapshot=await adapter.state();expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_/);expect(snapshot.projects?.[0].id).toBe(project.id);
  const opened=await adapter.change({id:crypto.randomUUID(),op:'project-open',projectId:project.id},()=>{});expect(opened.project?.instructions).toBe('PRIVATE_INSTRUCTIONS');expect(JSON.stringify(opened)).not.toContain('PRIVATE_FOLDER');
  await adapter.change({id:crypto.randomUUID(),op:'project-save',projectId:project.id,name:'Renamed',instructions:'Updated'},()=>{});expect(history.project(project.id)).toMatchObject({name:'Renamed',rootPath:'C:/PRIVATE_FOLDER',browserIsolated:true});
  await adapter.change({id:crypto.randomUUID(),op:'project-move',conversationId:conversation.id,projectId:project.id},()=>{});expect(history.conversation(conversation.id).projectId).toBe(project.id);expect(moving).toHaveBeenCalledWith(conversation.id);
  await adapter.change({id:crypto.randomUUID(),op:'memory-save',input:{projectId:project.id,title:'Mobile memory',text:'Saved privately',enabled:false}},()=>{});const item=history.memory.memories().find(item=>item.title==='Mobile memory')!;expect(item).toMatchObject({projectId:project.id,enabled:false,text:'Saved privately'});
  await adapter.change({id:crypto.randomUUID(),op:'memory-delete',memoryId:item.id},()=>{});expect(history.memory.memories().some(memory=>memory.id===item.id)).toBe(false);
  await adapter.change({id:crypto.randomUUID(),op:'voice',voice:'marius'},()=>{});expect(settings.voice.readAloud).toMatchObject({voice:'marius',selection:{model:'pocket-tts'}});expect(settingsChanged).toHaveBeenCalledOnce();expect(memoryChanged).toHaveBeenCalled();
 }finally{history.close();const absolute=resolve(directory);if(!absolute.startsWith(resolve(tmpdir())+'\\')||!absolute.includes('tinygpt-phase2-'))throw Error('Unexpected fixture path');await rm(absolute,{recursive:true,force:true});}
});
