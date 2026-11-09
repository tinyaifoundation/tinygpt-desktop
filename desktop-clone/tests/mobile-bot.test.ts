import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteService } from '../src/main/remote-service';
import { remoteView, REMOTE_DRAFT_ID, remoteAppearanceSchema } from '../src/shared/remote';
import { defaultBotDesign, type RemoteBotState } from '../src/shared/bot-design';
import { ChatUpdateDecoder, ChatUpdateEncoder } from '../src/core/chat-updates';
import { remotePushEvent } from '../src/shared/remote-push';
import type { ChatUpdate } from '../src/shared/chat';

const personal=randomUUID(), normal=randomUUID(), privateWatch=randomUUID(), device=randomUUID(), grant=randomUUID(), message=randomUUID();
const bot:RemoteBotState={conversationId:personal,name:'Blobby',design:{...defaultBotDesign,name:'Blobby',color:'#b1ff00',shape:'cloud'},snoozed:false,phase:'ready',browser:true,watches:[{id:randomUUID(),title:'My project updates',enabled:true,nextRunAt:100}]};
function update(id:string=personal):ChatUpdate{return {conversation:{id,title:'Blobby',mode:id===normal?'chat':'bot',projectId:null,createdAt:1,updatedAt:2,messages:[{id:message,role:'assistant',text:'Hello from your Bot',status:'complete',error:null,createdAt:2,runId:null,route:'local',reactions:[{actor:'user',emoji:'❤️',createdAt:2}]}],tools:[],sources:[]},library:{projects:[],conversations:[{id:personal,title:'Blobby',mode:'bot',projectId:null,createdAt:1,updatedAt:2},{id:normal,title:'Ordinary chat',projectId:null,createdAt:1,updatedAt:2},{id:privateWatch,title:'PRIVATE_WATCH_PROMPT',mode:'bot',projectId:null,createdAt:1,updatedAt:2}],lastConversationId:id,activeRuns:[{conversationId:privateWatch,runId:randomUUID()},{conversationId:personal,runId:randomUUID()}],approvals:[],browserHandoffs:[],notificationItems:[{id:randomUUID(),conversationId:privateWatch,title:'PRIVATE_WATCH_RESULT',conversationTitle:'Private',createdAt:2,read:false},{id:randomUUID(),conversationId:personal,title:'New message',conversationTitle:'Blobby',createdAt:2,read:false}]}};}
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(scope:'conversation'|'library'='library',scopeId=normal){
 const dir=await mkdtemp(join(tmpdir(),'mobile-bot-test-'));dirs.push(dir);
 const chat={update:vi.fn((id:string)=>update(id)),library:()=>update(normal).library,send:vi.fn(()=>update(personal)),cancel:vi.fn(async()=>update(personal))};
 const actions={create:vi.fn(async()=>update(normal)),approve:vi.fn(async()=>{}),bot:()=>({...bot,design:undefined}),botSnooze:vi.fn(async(value:boolean)=>{bot.snoozed=value;}),botReact:vi.fn()};
 const service=new RemoteService(dir,{available:()=>true,encrypt:text=>Buffer.from(text),decrypt:bytes=>bytes.toString()},chat,'',()=>{},actions);
 const internal=service as any,sent:any[]=[];internal.saved.enabled=true;internal.saved.grants=[{id:grant,deviceId:device,psk:'a'.repeat(64),scope,conversationId:scopeId,expiresAt:Date.now()+60000}];internal.send=(value:unknown)=>sent.push(value);
 const request=(command:unknown)=>internal.command(JSON.stringify({type:'command',deviceId:device,grantId:grant,conversationId:scopeId,command}));
 return {service,internal,sent,request,chat,actions};
}
describe('personal Bot on mobile',()=>{
 it('exposes the main Bot and avatar while excluding private watches, their notifications and active runs',()=>{
  const result=remoteView(update(normal),true,{},bot);
  expect(result.library.bot).toEqual(bot);expect(result.library.conversations.map(chat=>chat.id)).toEqual([personal,normal]);
  expect(result.library.activeRuns.map(run=>run.conversationId)).toEqual([personal]);expect(result.library.notificationItems).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_');expect(()=>remoteView(update(privateWatch),true,{},bot)).toThrow('unavailable');
  const main=remoteView(update(),true,{},bot);expect(main.conversation.mode).toBe('bot');expect(main.conversation.messages[0].reactions?.[0].emoji).toBe('❤️');
 });
 it('keeps Bot metadata out of ordinary conversation-scoped grants and supports pairing directly to the main Bot',()=>{
  expect(remoteView(update(normal),false,{},bot).library.bot).toBeNull();
  expect(remoteView(update(),false,{},bot).library.bot).toEqual(bot);
  expect(remoteAppearanceSchema.parse({theme:'dark',variables:Object.fromEntries(['--background','--foreground','--user-accent','--ring','--user-ui-font','--user-content-font','--user-code-font','--user-ui-weight','--user-content-weight','--user-code-weight','--user-ui-size','--user-code-size','--user-ui-scale','--user-contrast'].map(key=>[key,'1'])),bot:bot.design}).bot).toEqual(bot.design);
 });
 it('streams avatar, sleep and unread changes over JSON patches and clears Bot metadata when access changes',()=>{
  const encoder=new ChatUpdateEncoder(),decoder=new ChatUpdateDecoder();
  const encode=(value:ChatUpdate)=>decoder.decode(JSON.parse(JSON.stringify(encoder.encode(value))));
  encode(remoteView(update(normal),true,{},bot));
  const next=remoteView(update(normal),true,{}, {...bot,snoozed:true,design:{...bot.design,color:'#ff4477'}});next.library.notificationItems=[];
  expect(encode(next).library).toEqual(next.library);
  const scoped=remoteView(update(normal),false,{},bot);expect(encode(scoped).library.bot).toBeNull();
 });
 it('allows shared Bot sends, sleep/wake and reactions once, and denies private conversation commands',async()=>{
  const f=await fixture();
  await f.request({id:randomUUID(),op:'get',conversationId:personal});expect(f.sent.at(-1).ok).toBe(true);
  await f.request({id:randomUUID(),op:'send',conversationId:personal,text:'Hi Blobby'});expect(f.chat.send).toHaveBeenCalledWith(personal,'Hi Blobby',[],true);
  const sleep={id:randomUUID(),op:'bot-snooze',conversationId:personal,snoozed:true};await f.request(sleep);await f.request(sleep);expect(f.actions.botSnooze).toHaveBeenCalledExactlyOnceWith(true);
  await f.request({id:randomUUID(),op:'bot-snooze',conversationId:personal,snoozed:false});
  await f.request({id:randomUUID(),op:'bot-react',conversationId:personal,messageId:message,emoji:'👍'});expect(f.actions.botReact).toHaveBeenCalledExactlyOnceWith(personal,message,'👍');
  for(const command of [{op:'get'},{op:'send',text:'no'},{op:'bot-snooze',snoozed:true},{op:'delete'}]){await f.request({id:randomUUID(),...command,conversationId:privateWatch});expect(f.sent.at(-1).ok).toBe(false);}
  expect(f.chat.send).toHaveBeenCalledOnce();
 });
 it('does not allow a conversation-scoped phone to read, snooze, or react to another Bot',async()=>{
  const f=await fixture('conversation');for(const command of [{op:'get'},{op:'bot-snooze',snoozed:true},{op:'bot-react',messageId:message,emoji:'👍'}]){await f.request({id:randomUUID(),...command,conversationId:personal});expect(f.sent.at(-1).ok).toBe(false);}expect(f.actions.botSnooze).not.toHaveBeenCalled();expect(f.actions.botReact).not.toHaveBeenCalled();
  f.internal.saved.revoked.push(device);await f.request({id:randomUUID(),op:'send',conversationId:personal,text:'No'});expect(f.chat.send).not.toHaveBeenCalled();
 });
 it('permits a device explicitly paired to the personal Bot while denying desktop-only edits',async()=>{
  const f=await fixture('conversation',personal);
  await f.request({id:randomUUID(),op:'get',conversationId:personal});expect(f.sent.at(-1).ok).toBe(true);
  await f.request({id:randomUUID(),op:'send',conversationId:personal,text:'Hello'});expect(f.chat.send).toHaveBeenCalledOnce();
  await f.request({id:randomUUID(),op:'bot-snooze',conversationId:personal,snoozed:true});expect(f.actions.botSnooze).toHaveBeenCalledWith(true);
  await f.request({id:randomUUID(),op:'edit',conversationId:personal,messageId:message,text:'Changed'});expect(f.sent.at(-1).ok).toBe(false);
  bot.snoozed=false;
 });
 it('rejects private-watch media and voice before dispatch, even for library access',async()=>{
  const f=await fixture(),handle=vi.fn(async()=>({}));f.internal.media={handle};f.internal.voice={handle};const connectionId=randomUUID();
  const envelope={deviceId:device,connectionId,grantId:grant,conversationId:normal};
  await f.internal.mediaCommand({...envelope,command:{id:randomUUID(),jobId:randomUUID(),op:'tool-image',conversationId:privateWatch,toolId:randomUUID()}});
  await f.internal.voiceCommand({...envelope,command:{id:randomUUID(),op:'speech-read',conversationId:privateWatch,messageId:message,chunk:0,jobId:randomUUID()}});
  expect(handle).not.toHaveBeenCalled();
  await f.internal.mediaCommand({...envelope,command:{id:randomUUID(),jobId:randomUUID(),op:'tool-image',conversationId:personal,toolId:randomUUID()}});
  await f.internal.voiceCommand({...envelope,command:{id:randomUUID(),op:'speech-read',conversationId:personal,messageId:message,chunk:0,jobId:randomUUID()}});
  expect(handle).toHaveBeenCalledTimes(2);
 });
 it('pushes main Bot notification metadata without chat text and drops private-watch events',async()=>{
  const f=await fixture();const event={id:randomUUID(),conversationId:personal,sequence:1,createdAt:Date.now(),kind:'completed' as const,mode:'bot' as const,title:'PRIVATE_MESSAGE',detail:'PRIVATE_MESSAGE',read:false,resolved:false,messageId:message};
  expect(remotePushEvent(event)?.mode).toBe('bot');f.service.notify(event);f.service.notify({...event,id:randomUUID(),conversationId:privateWatch});await f.internal.pushWrites;
  expect(f.internal.saved.pushOutbox).toHaveLength(1);expect(JSON.stringify(f.internal.saved.pushOutbox)).not.toContain('PRIVATE_MESSAGE');
 });
});
