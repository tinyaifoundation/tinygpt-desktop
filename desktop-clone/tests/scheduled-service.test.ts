import { it, expect, vi } from 'vitest';
import { passwordPrivacy } from '../src/main/password-privacy';
import { ScheduledService } from '../src/main/scheduled-service';
import { ScheduledStore } from '../src/main/scheduled-store';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import type { BotService } from '../src/main/bot-service';
import type { ChatExecution, ChatWorkerInput } from '../src/shared/chat';
import { defaultSettings } from '../src/shared/config';
import { defaultBotConfiguration } from '../src/shared/bot';
import { scheduledInputSchema } from '../src/shared/scheduled';

async function fixture(test: (value: { service: ScheduledService; store: ScheduledStore; history: HistoryStore; chat: ChatService; mainId: string; prompts: Map<string,string>; delivered: ReturnType<typeof vi.fn>; setQuiet: (value: boolean) => void; setSnoozed: (value: boolean) => void; metadataRequests: ChatWorkerInput[] }) => Promise<void>, seed?: (store: ScheduledStore,history: HistoryStore) => void) {
  const store = new ScheduledStore(':memory:'), history = new HistoryStore(':memory:'), settings = structuredClone(defaultSettings); settings.local.model = 'fixture';
  const mainId = history.createConversation(null,'bot').id; let quiet = false, snoozed = false; const prompts = new Map<string,string>();
  const delivered = vi.fn((text: string,id: string) => history.appendProactiveMessage(mainId,text,id,'local'));
  const normal: ChatExecution = { run: async (_input,_signal,delta) => { delta('Scheduled result.'); } };
  const assistant: ChatExecution = { isSnoozed: () => snoozed, run: async (input,_signal,_delta,_tool,_reasoning,response) => { if (quiet) input.nativeSilent = true; else response?.({ type: 'bot-messages',messages: ['A meaningful development.'],complete: true }); } };
  const bot = { snapshot: () => ({ configured: true,snoozed,conversationId: mainId,projectId: null,configuration: { ...defaultBotConfiguration,background: true } }), isAwake: () => true, conversationContext: () => 'The user is interested in hiking.', setBackgroundPrompt: (id: string,text: string) => prompts.set(id,text), deliver: delivered,flushDeliveries: () => {} } as unknown as BotService;
  const chat = new ChatService(history,() => settings,() => undefined,normal,() => {},undefined,undefined,undefined,undefined,undefined,false,assistant);
  const connection = (): ChatWorkerInput => ({ runId: 'metadata',route: 'local',endpoint: settings.local.endpoint,provider: 'local',protocol: 'openai-compatible',model: 'fixture',instructions: '',messages: [],tools: false });
  const metadataRequests: ChatWorkerInput[] = [];
  const metadata: ChatExecution = { run: async (input,_signal,delta) => { metadataRequests.push(input); delta(JSON.stringify([{ title: 'Research roundup',description: 'A useful recurring summary.',prompt: 'Research a topic.',emoji: '🔎',repeat: 'weekly' }])); } };
  seed?.(store,history);
  const service = new ScheduledService(store,history,chat,bot,async () => {},connection,metadata,() => [{name:'Calendar',connected:true}],() => {});
  try { await test({ service,store,history,chat,mainId,prompts,delivered,setQuiet: value => { quiet = value; },setSnoozed: value => { snoozed = value; },metadataRequests }); } finally { await service.shutdown(); await chat.shutdown(); history.close(); }
}
const jobInput = () => scheduledInputSchema.parse({ title: 'Daily research',prompt: 'Research the topic.',schedule: { repeat: 'interval',minutes: 15,timezone: 'America/New_York' } });

it('defers due jobs and manual runs while private sign-in is open without claiming a run',async()=>fixture(async({service,store})=>{
  const job=store.save(jobInput(),'user',0);passwordPrivacy.enter();
  try{await service.tick(900000);expect(store.runs()).toEqual([]);expect(store.get(job.id).nextRunAt).toBe(900000);await expect(service.action(job.id,'run')).rejects.toThrow('Private sign-in');}
  finally{passwordPrivacy.leave();}
  await service.tick(900000);expect(store.runs()).toHaveLength(1);expect(store.runs()[0].status).toBe('complete');
}));

it('backfills existing scheduled chats even for removed tasks while excluding private bot runs', async () => fixture(async ({history})=>{
  const chats=history.conversations();
  expect(chats.find(chat=>chat.title==='Legacy scheduled reply')?.scheduled).toBe(true);
  expect(chats.find(chat=>chat.title==='Ordinary chat')?.scheduled).toBe(false);
  expect(chats.filter(chat=>chat.mode==='bot').every(chat=>!chat.scheduled)).toBe(true);
},(store,history)=>{
  const chat=history.createConversation(null,'chat');history.renameConversation(chat.id,'Legacy scheduled reply');
  const ordinary=history.createConversation(null,'chat');history.renameConversation(ordinary.id,'Ordinary chat');
  const job=store.save(jobInput(),'user',0), run=store.claim(job.id,900000)!;
  store.attach(run,chat.id);store.finish(run.id,'complete');store.remove(job.id);
  const bot=history.createConversation(null,'bot'), watch=store.save(jobInput(),'bot',0), check=store.claim(watch.id,900000)!;
  store.attach(check,bot.id);store.finish(check.id,'complete');
}));

it('runs a saved prompt through ChatService and keeps subsequent runs in its chat', async () => fixture(async ({ service,store,history }) => {
  const job = store.save(jobInput(),'user',0); await service.tick(900000);
  expect(store.runs()[0].status).toBe('complete'); const id = store.get(job.id).conversationId!;
  expect(history.conversation(id).scheduled).toBe(true);expect(history.conversations().find(chat=>chat.id===id)?.scheduled).toBe(true);
  expect(history.conversation(id).messages.map(message => message.text)).toEqual(['Research the topic.','Scheduled result.']);
  await service.tick(1800000); expect(store.get(job.id).conversationId).toBe(id); expect(history.conversation(id).messages).toHaveLength(4);
}));
it('creates new chats when requested and leaves paused jobs idle', async () => fixture(async ({ service,store }) => {
  const job = store.save({ ...jobInput(),newChat: true },'user',0); await service.tick(900000); const first = store.get(job.id).conversationId;
  await service.tick(1800000); expect(store.get(job.id).conversationId).not.toBe(first);
  store.enabled(job.id,false); await service.tick(2700000); expect(store.runs()).toHaveLength(2);
}));
it('runs private bot checks, delivers real messages, and never republishes the prior result after NO_REPLY', async () => fixture(async ({ service,store,history,mainId,prompts,delivered,setQuiet }) => {
  const job = store.save(jobInput(),'bot',0); await service.tick(900000);
  expect(delivered).toHaveBeenCalledTimes(1); expect(history.conversation(mainId).messages.map(message => message.role)).toEqual(['assistant']);
  expect([...prompts.values()][0]).toContain('hiking'); expect(service.snapshot().jobs).toHaveLength(0); expect(service.snapshot().runs).toHaveLength(0);expect(history.conversation(store.get(job.id).conversationId!).scheduled).toBe(false);
  setQuiet(true); await service.tick(1800000); expect(delivered).toHaveBeenCalledTimes(1);
  expect(store.runs()[0].summary).toBe(''); expect(history.conversation(store.get(job.id).conversationId!).messages.at(-1)?.text).toBe('');
  setQuiet(false); await service.tick(2700000); expect(delivered).toHaveBeenCalledTimes(1);
}));
it('refuses user APIs on a bot-owned watch', async () => fixture(async ({ service,store }) => {
  const job = store.save(jobInput(),'bot',0); await expect(service.action(job.id,'remove')).rejects.toThrow('Bot settings');
}));
it('generates cached suggestions using matching-route history and plugin names, without running a task', async () => fixture(async ({ service,history,metadataRequests }) => {
  const local = history.createConversation(null,'chat'), remote = history.createConversation(null,'chat');
  const localTurn = history.startTurn(local.id,'LOCAL_MATCHING_TOPIC','local'); history.saveReply(localTurn.assistantId,'A local discussion.','complete');
  const remoteTurn = history.startTurn(remote.id,'REMOTE_PRIVATE_TOPIC','byok'); history.saveReply(remoteTurn.assistantId,'A remote discussion.','complete');
  history.renameConversation(local.id,'LOCAL_METADATA_TITLE');
  const readConversation = vi.spyOn(history,'conversation').mockImplementation(() => { throw Error('Suggestions must not open conversations'); });
  const suggestions = await service.suggestions(); expect(suggestions.suggestions[0].title).toBe('Research roundup');
  expect(metadataRequests[0].tools).toBe(false); expect(metadataRequests[0].messages[0].text).toContain('LOCAL_METADATA_TITLE'); expect(metadataRequests[0].messages[0].text).not.toContain('LOCAL_MATCHING_TOPIC'); expect(metadataRequests[0].messages[0].text).not.toContain('REMOTE_PRIVATE_TOPIC'); expect(metadataRequests[0].messages[0].text).toContain('Calendar');
  await service.suggestions(); expect(metadataRequests).toHaveLength(1); expect(service.snapshot().jobs).toHaveLength(0); expect(readConversation).not.toHaveBeenCalled(); readConversation.mockRestore();
}));
it('queues ideas behind an active reply and generates them when idle', async () => fixture(async ({service,history,chat,metadataRequests})=>{
  const conversation=history.createConversation(null,'chat');chat.start(conversation.id,'A foreground request.');
  const waiting=await service.suggestions();expect(waiting.generating).toBe(true);expect(metadataRequests).toHaveLength(0);
  await chat.waitForIdle(conversation.id);await service.tick();expect(metadataRequests).toHaveLength(1);expect(service.snapshot().generating).toBe(false);expect(service.snapshot().suggestions).toHaveLength(1);
}));

it('snoozes Bot replies and watches without claiming them or blocking user Scheduled tasks', async () => fixture(async ({ service, store, chat, mainId, history, setSnoozed, delivered }) => {
  const watch = store.save(jobInput(), 'bot', 0);
  const userTask = store.save(jobInput(), 'user', 0);
  setSnoozed(true);
  const before = history.conversation(mainId).messages.length;
  expect(() => chat.start(mainId, 'A reply while sleeping')).toThrow('sleeping');
  expect(history.conversation(mainId).messages.length).toBe(before);
  await service.tick(900000);
  expect(store.runs()).toHaveLength(1);
  expect(store.runs()[0].jobId).toBe(userTask.id);
  expect(store.get(watch.id).nextRunAt).toBe(900000);
  expect(delivered).not.toHaveBeenCalled();
  setSnoozed(false);
  await service.tick(900000);
  expect(store.runs().some(run => run.jobId === watch.id && run.status === 'complete')).toBe(true);
  expect(delivered).toHaveBeenCalledTimes(1);
}));

it('checks a paused Bot watch immediately without resuming it or changing its next schedule', async () => fixture(async ({ service, store, delivered }) => {
  const watch = store.save(jobInput(), 'bot');
  store.enabled(watch.id, false);
  const before = store.get(watch.id);
  service.checkBotJob(watch.id);
  await vi.waitFor(() => expect(store.runs().find(run => run.jobId === watch.id)?.status).toBe('complete'));
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(store.get(watch.id).enabled).toBe(false);
  expect(store.get(watch.id).nextRunAt).toBe(before.nextRunAt);
}));

it('does not claim manual Bot checks while sleeping, during private sign-in, or while busy', async () => fixture(async ({ service, store, chat, history, setSnoozed }) => {
  const watch = store.save(jobInput(), 'bot'), user = store.save(jobInput(), 'user');
  expect(() => service.checkBotJob(user.id)).toThrow('Watch not found');
  setSnoozed(true);
  expect(() => service.checkBotJob(watch.id)).toThrow('sleeping');
  setSnoozed(false); passwordPrivacy.enter();
  try { expect(() => service.checkBotJob(watch.id)).toThrow('Private sign-in'); }
  finally { passwordPrivacy.leave(); }
  const conversation = history.createConversation(null, 'chat');
  chat.start(conversation.id, 'An active foreground reply');
  expect(() => service.checkBotJob(watch.id)).toThrow('Wait for the current task');
  expect(store.runs()).toHaveLength(0);
  await chat.waitForIdle(conversation.id);
}));
