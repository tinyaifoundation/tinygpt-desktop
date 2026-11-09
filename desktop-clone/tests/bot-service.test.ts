import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { defaultSettings } from '../src/shared/config';
import { defaultBotConfiguration } from '../src/shared/bot';
import type { AssistantProfile } from '../src/main/pi-assistant';
import type { ChatWorkerInput } from '../src/shared/chat';
import { ScheduledStore } from '../src/main/scheduled-store';
import { saveBotWatch } from '../src/main/bot-watch';
const mock = vi.hoisted(() => ({ profile: undefined as AssistantProfile | undefined }));
vi.mock('../src/main/pi-assistant', () => ({ createPiAssistant: (profile: (input: ChatWorkerInput) => Promise<AssistantProfile>) => ({ run: async (input: ChatWorkerInput) => { mock.profile = await profile(input); } }) }));
import { BotService } from '../src/main/bot-service';

async function fixture(test: (service: BotService, history: HistoryStore, store: ScheduledStore, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(),'tinygpt-pi-bot-test-')), history = new HistoryStore(join(directory,'library.sqlite')), store = new ScheduledStore(':memory:');
  const service = new BotService(directory,history,() => defaultSettings,vi.fn(),async () => {}); service.schedules = store;
  try { await test(service,history,store,directory); }
  finally { await service.shutdown(); store.close(); history.close(); const target = resolve(directory); if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-pi-bot-test-')) throw Error('Unexpected fixture directory'); await rm(target,{ recursive: true,force: true }); }
}
it('preserves identity, notes and visible history across a Pi restart', async () => fixture(async (service,history,store,directory) => {
  const conversation = await service.complete({ name: 'Milo',projectId: null });
  await service.saveNote({ file: 'SOUL.md',text: 'Be curious and concise.' });
  history.appendProactiveMessage(conversation.id,'I found something useful.','run-one','local');
  const reopened = new BotService(directory,history,() => defaultSettings,vi.fn(),async () => {}); reopened.schedules = store; await reopened.load();
  expect(reopened.snapshot().configured).toBe(true); expect(reopened.snapshot().conversationId).toBe(conversation.id);
  expect((await reopened.notes()).find(note => note.file === 'SOUL.md')?.text).toBe('Be curious and concise.');
  expect(history.conversation(conversation.id).messages[0].text).toBe('I found something useful.'); await reopened.shutdown();
}));
it('creates private proactive checks and pauses them without exposing them as Scheduled tasks', async () => fixture(async (service,_history,store) => {
  await service.complete({ name: 'Milo',projectId: null,configuration: { ...defaultBotConfiguration,background: true,heartbeat: '1h' } });
  expect(store.jobs('bot')).toHaveLength(1); expect(store.jobs('user')).toHaveLength(0);
  await service.configure({ ...defaultBotConfiguration,background: false }); expect(store.jobs('bot')[0].enabled).toBe(false);
}));
it('uses assistant personality and permits only reading tools in autonomous checks', async () => fixture(async (service,_history,_store) => {
  const conversation = await service.complete({ name: 'Milo',projectId: null,configuration: { ...defaultBotConfiguration,background: true,browser: true } });
  service.setBackgroundPrompt('check','Watch the topic we discussed.');
  await service.run({ conversationId: conversation.id,runId: 'run',nativeSessionKey: 'check',route: 'local',endpoint: 'http://127.0.0.1:1/v1',model: 'fixture',protocol: 'openai-compatible',provider: 'local',instructions: '',messages: [{ role: 'user',text: 'Bot background task' }],tools: true },new AbortController().signal,() => {});
  expect(mock.profile!.instructions).toContain('Milo'); expect(mock.profile!.background).toBe(true);
  expect(mock.profile!.allow('search_web')).toBe(true); expect(mock.profile!.allow('run_command')).toBe(false); expect(mock.profile!.allow('write_file')).toBe(false); expect(mock.profile!.allow('browser_click')).toBe(false); expect(mock.profile!.allow('ext_unknown_send')).toBe(false);
  expect(mock.profile!.allow('browser_screenshot')).toBe(true);expect(mock.profile!.allow('view_image')).toBe(true);
}));
it('retains the complete foreground browser group and respects the Bot browser toggle',async()=>fixture(async(service)=>{
  const conversation=await service.complete({name:'Milo',projectId:null,configuration:{...defaultBotConfiguration,browser:true}});
  const input:ChatWorkerInput={conversationId:conversation.id,runId:'foreground',route:'local',endpoint:'http://127.0.0.1:1/v1',model:'fixture',protocol:'openai-compatible',provider:'local',instructions:'',messages:[{role:'user',text:'Use the browser.'}],tools:true};
  await service.run(input,new AbortController().signal,()=>{});
  for(const name of ['browser_tabs','browser_open','browser_navigate','browser_snapshot','browser_click','browser_type','browser_scroll','browser_hover','browser_press_key','browser_screenshot','view_image','browser_close'])expect(mock.profile!.allow(name),name).toBe(true);
  await service.configure({...defaultBotConfiguration,browser:false});await service.run(input,new AbortController().signal,()=>{});
  for(const name of ['browser_open','browser_click','browser_screenshot'])expect(mock.profile!.allow(name),name).toBe(false);
}));
it('persists memory through the assistant tool and clears conversation without forgetting notes', async () => fixture(async (service,history,_store,directory) => {
  const conversation = await service.complete({ name: 'Milo',projectId: null });
  const input: ChatWorkerInput = { conversationId: conversation.id,runId: 'run',route: 'local',endpoint: 'http://127.0.0.1:1/v1',model: 'fixture',protocol: 'openai-compatible',provider: 'local',instructions: '',messages: [{ role: 'user',text: 'Remember that I like hiking.' }],tools: true };
  await service.run(input,new AbortController().signal,() => {});
  await mock.profile!.customTools!.find(tool => tool.name === 'bot_remember')!.execute('tool',{ text: 'The user enjoys hiking.' },new AbortController().signal,undefined,{} as any);
  const remember=mock.profile!.customTools!.find(tool=>tool.name==='bot_remember')!;
  const unchanged=await remember.execute('unchanged',{text:'The user enjoys hiking.'},new AbortController().signal,undefined,{} as any);
  expect(unchanged.content).toEqual([{type:'text',text:JSON.stringify({remembered:true,unchanged:true})}]);
  const read=await remember.execute('read',{},new AbortController().signal,undefined,{} as any);
  expect(read.content).toEqual([{type:'text',text:'The user enjoys hiking.'}]);
  history.appendProactiveMessage(conversation.id,'Saved.','remember-run','local'); await service.clearConversation();
  expect(history.conversation(conversation.id).messages).toHaveLength(0);
  expect(await readFile(join(directory,'bot-runtime',conversation.id,'workspace','MEMORY.md'),'utf8')).toBe('The user enjoys hiking.');
}));
it('delivers proactive messages once, without synthetic user messages', async () => fixture(async (service,history) => {
  const conversation = await service.complete({ name: 'Milo',projectId: null,configuration: { ...defaultBotConfiguration,background: true } });
  service.deliver('There is a new development.','delivery-one'); service.deliver('There is a new development.','delivery-one');
  expect(history.conversation(conversation.id).messages.map(message => message.role)).toEqual(['assistant']);
}));
it('preserves a paused or removed check-in after resuming the application', async () => fixture(async (service,_history,store) => {
  await service.complete({ name: 'Milo',projectId: null,configuration: { ...defaultBotConfiguration,background: true,heartbeat: '1h' } });
  const id = store.jobs('bot')[0].id; await service.changeJob(id,'pause'); await service.resume(); expect(store.get(id).enabled).toBe(false);
  await service.changeJob(id,'remove'); await service.resume(); expect(store.jobs('bot')).toHaveLength(0);
}));

it('lets a foreground Bot remove its own interest watches even with initiative off', async () => fixture(async (service,_history,store) => {
  const conversation = await service.complete({ name: 'Milo', projectId: null, configuration: { ...defaultBotConfiguration, background: false } });
  const watch = saveBotWatch(store, { title: 'Verification', prompt: 'Check the finished task.', minutes: 30 });
  await service.run({ conversationId: conversation.id, runId: 'cleanup', route: 'local', endpoint: 'http://127.0.0.1:1/v1', model: 'fixture', protocol: 'openai-compatible', provider: 'local', instructions: '', messages: [{ role: 'user', text: 'The task is done. Stop watching it.' }], tools: true }, new AbortController().signal, () => {});
  const tool = mock.profile!.customTools!.find(tool => tool.name === 'bot_watch_remove');
  expect(tool).toBeDefined(); expect(mock.profile!.customTools!.some(tool => tool.name === 'bot_watch')).toBe(false);
  expect(mock.profile!.instructions).toContain(watch.id); expect(mock.profile!.instructions).toContain('do not expire automatically');
  const result = await tool!.execute('remove', { id: watch.id }, new AbortController().signal, undefined, {} as any);
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ id: watch.id, title: 'Verification', removed: true, watching: false }) }]);
  expect(store.jobs('bot')).toHaveLength(0); await service.resume(); expect(store.jobs('bot')).toHaveLength(0);
}));

it('limits proactive watch removal to the current interest watch and excludes the general check-in', async () => fixture(async (service,_history,store) => {
  const conversation = await service.complete({ name: 'Milo', projectId: null, configuration: { ...defaultBotConfiguration, background: true, heartbeat: '1h' } });
  const first = saveBotWatch(store, { title: 'My check', prompt: 'Verify a completed task.', minutes: 30 });
  const other = saveBotWatch(store, { title: 'Other check', prompt: 'Keep watching the separate interest.', minutes: 60 });
  const run = store.claim(first.id, Date.now(), true)!;
  const input: ChatWorkerInput = { conversationId: conversation.id, runId: 'background', nativeSessionKey: run.id, route: 'local', endpoint: 'http://127.0.0.1:1/v1', model: 'fixture', protocol: 'openai-compatible', provider: 'local', instructions: '', messages: [{ role: 'user', text: 'Check it.' }], tools: true };
  await service.run(input, new AbortController().signal, () => {});
  const tool = mock.profile!.customTools!.find(tool => tool.name === 'bot_watch_remove')!;
  await expect(tool.execute('wrong', { id: other.id }, new AbortController().signal, undefined, {} as any)).rejects.toThrow('own watch');
  await tool.execute('right', { id: first.id }, new AbortController().signal, undefined, {} as any);
  expect(store.get(other.id).enabled).toBe(true);
  const checkIn = store.jobs('bot').find(job => job.title === 'Personal check-in')!, heartbeat = store.claim(checkIn.id, Date.now(), true)!;
  await service.run({ ...input, nativeSessionKey: heartbeat.id }, new AbortController().signal, () => {});
  expect(mock.profile!.customTools!.some(tool => tool.name === 'bot_watch_remove')).toBe(false);
}));
