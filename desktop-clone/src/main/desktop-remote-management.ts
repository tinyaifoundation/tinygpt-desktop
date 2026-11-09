import type { RemoteManagementActions } from './remote-management';
import type { HistoryStore } from './history';
import type { SettingsStore } from './store';
import type { PluginService } from './plugin-service';
import type { ChatService } from './chat-service';
import type { RemoteService } from './remote-service';
import type { MemorySnapshot } from '../shared/memory';
import type { CustomSpeechVoice } from '../shared/voice';
import { pocketConnection,pocketVoices,speechVoiceDisplay } from '../shared/voice';

export function desktopRemoteManagement({history,store,plugins,chat,remote,version,voices,memorySnapshot,memoryChanged,settingsChanged,projectCreated,moving}: {
 history:HistoryStore;store:SettingsStore;plugins:PluginService;chat:ChatService;remote:RemoteService;version:string;
 voices:()=>Promise<CustomSpeechVoice[]>;memorySnapshot:()=>MemorySnapshot;memoryChanged:()=>void;settingsChanged:()=>void;projectCreated:(id:string)=>void;moving:(id:string)=>Promise<void>;
}):RemoteManagementActions{
 const safeConversation=(id:string)=>{const value=history.conversation(id);if(value.mode==='bot')throw Error('Conversation unavailable.');return value;};
 return {
  async state(){
   const settings=store.getSettings(),mem=memorySnapshot(),library=chat.library(),chats=library.conversations.filter(item=>item.mode!=='bot').slice(0,300),custom=await voices();
   return {allowed:true,computer:requireComputerName(),version,keepAwake:remote.status().keepAwake,
    voice:{enabled:settings.voice.readAloud.enabled,local:settings.voice.readAloud.selection?.connectionId===pocketConnection,dictation:settings.voice.dictation.enabled,voice:settings.voice.readAloud.voice,voices:[...pocketVoices.map(id=>({id,name:speechVoiceDisplay(id).name})),...custom.map(item=>({id:item.id,name:item.name}))].slice(0,100)},
    plugins:plugins.snapshot().entries.slice(0,100).map(item=>({id:item.id,name:item.manifest.name,description:item.manifest.description.slice(0,400),enabled:item.config.enabled,status:item.status})),
    projects:history.projects().slice(0,200).map(project=>({id:project.id,name:project.name,chats:chats.filter(chat=>chat.projectId===project.id).length})),
    memories:mem.memories.slice(0,200).map(item=>({id:item.id,projectId:item.projectId,title:item.title,enabled:item.enabled,updatedAt:item.updatedAt})),personalMemory:mem.includePersonal,
    activity:chats.flatMap(item=>{const run=library.activeRuns.find(run=>run.conversationId===item.id),queued=history.queue.list(item.id).length,attention=library.approvals.some(approval=>approval.conversationId===item.id)||!!library.workQuestions?.some(question=>question.conversationId===item.id&&question.status==='pending');return run||queued||attention?[{conversationId:item.id,title:item.title.slice(0,120),running:!!run,phase:run?.phase??(attention?'waiting':'queued'),queued,attention}]:[];}).slice(0,300),
   };
  },
  async change(command,authorized){
   authorized();
   if(command.op==='voice'){
    const available=[...pocketVoices,...(await voices()).map(item=>item.id)];authorized();if(command.voice&&!available.includes(command.voice))throw Error('Choose an available local voice.');
    const settings=store.getSettings(),voice=settings.voice;
    await store.saveSettings({...settings,voice:{...voice,dictation:{...voice.dictation,...(command.dictation!==undefined?{enabled:command.dictation}:{})},readAloud:{...voice.readAloud,...(command.enabled!==undefined?{enabled:command.enabled}:{}),...(command.voice?{voice:command.voice,selection:{connectionId:pocketConnection,model:'pocket-tts'}}:{})}}});settingsChanged();return {};
   }
   if(command.op==='keep-awake'){await remote.configure({keepAwake:command.value});return {};}
   if(command.op==='plugin'){
    const entry=plugins.store.entry(command.pluginId);
    if(command.action==='disconnect')await plugins.track(()=>{authorized();return plugins.disconnect(entry.id,true);});
    else await plugins.track(()=>{authorized();return plugins.save({id:entry.id,manifest:entry.manifest,config:{...entry.config,enabled:command.action==='enable'}});});
    return {};
   }
   if(command.op==='project-open'){const project=history.project(command.projectId);return {project:{id:project.id,name:project.name,instructions:project.instructions,conversationIds:history.conversations().filter(item=>item.projectId===project.id&&item.mode!=='bot').slice(0,300).map(item=>item.id)}};}
   if(command.op==='project-save'){
    if(command.projectId){chat.assertProjectIdle(command.projectId);const project=history.project(command.projectId);history.updateProject(project.id,command.name,command.instructions,project.browserIsolated);}
    else {const project=history.createProject(command.name,command.instructions);projectCreated(project.id);}
    memoryChanged();return {};
   }
   if(command.op==='project-move'){
    safeConversation(command.conversationId);chat.assertIdle(command.conversationId);if(command.projectId)history.project(command.projectId);
    await moving(command.conversationId);authorized();chat.assertIdle(command.conversationId);history.organizeConversation({id:command.conversationId,action:'move',projectId:command.projectId});memoryChanged();return {};
   }
   if(command.op==='project-chat'){
    history.project(command.projectId);const conversation=history.createConversation(command.projectId,command.mode);await plugins.store.captureSelection(conversation.id,command.projectId);memoryChanged();return {conversationId:conversation.id};
   }
   if(command.op==='memory-open'){
    const item=memorySnapshot().memories.find(item=>item.id===command.memoryId);if(!item)throw Error('Memory unavailable.');return {memory:{id:item.id,projectId:item.projectId,title:item.title,text:item.text,enabled:item.enabled}};
   }
   chat.assertIdle();
   if(command.op==='memory-save'){if(command.input.projectId)history.project(command.input.projectId);if(command.input.id&&!memorySnapshot().memories.some(item=>item.id===command.input.id))throw Error('Memory unavailable.');history.memory.saveMemory(command.input);}
   else if(command.op==='memory-delete'){if(!memorySnapshot().memories.some(item=>item.id===command.memoryId))throw Error('Memory unavailable.');history.memory.remove(command.memoryId);}
   else if(command.op==='memory-sharing')history.memory.setPreference('personal',command.value);
   memoryChanged();return {};
  }
 };
}
import { hostname as requireComputerName } from 'node:os';
