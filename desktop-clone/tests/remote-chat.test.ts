import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { remoteCommandSchema, remoteView, REMOTE_DRAFT_ID } from '../src/shared/remote';
import { RemoteService } from '../src/main/remote-service';
import type { ChatUpdate } from '../src/shared/chat';
const id = randomUUID(), other = randomUUID(), deviceId = randomUUID(), grantId = randomUUID();
const fixtures: string[] = [];
function update(): ChatUpdate {
  return { conversation: { id, title: 'My chat', projectId: other, createdAt: 1, updatedAt: 1, mode: 'chat', messages: [{ id: randomUUID(), role: 'assistant', text: 'Hello', status: 'streaming', error: null, createdAt: 1, runId: id, route: 'local' }], sources: [], tools: [{ id: randomUUID(), conversationId: id, runId: id, name: 'read_project_file', summary: 'Reading a file', status: 'success', result: 'PRIVATE_FILE_CONTENT', target: 'C:/private', createdAt: 1 }] }, library: { projects: [{ id: other, name: 'PRIVATE_PROJECT', instructions: 'SECRET_INSTRUCTIONS', rootPath: 'C:/private', browserIsolated: false }], conversations: [{ id: other, projectId: other, title: 'PRIVATE_CHAT', createdAt: 1, updatedAt: 1 }], lastConversationId: other, activeRuns: [{ conversationId: other, runId: other }, { conversationId: id, runId: id, phase: 'answer' }], approvals: [{ id: other, conversationId: other, runId: other, name: 'read_project_file', summary: 'PRIVATE_APPROVAL', details: 'PRIVATE_DETAILS' }], browserHandoffs: [] } };
}
afterEach(async () => { vi.restoreAllMocks(); for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('remote chat boundary', () => {
  it('projects chat-scoped plugin consent only to a device with approval access', () => {
    const full = update(); const pluginUse = { pluginId: randomUUID(), name: 'Gmail', connector: 'gmail' as const };
    full.library.approvals.push({ id: randomUUID(), conversationId: id, runId: id, name: 'load_tools', summary: 'Use Gmail in this chat', details: 'Read access for this conversation.', pluginUse });
    expect(remoteView(full, true).library.approvals[0].pluginUse).toEqual(pluginUse);
    expect(remoteView(full, false).library.approvals).toEqual([]);
    expect(JSON.stringify(remoteView(full, true))).not.toContain('PRIVATE_APPROVAL');
  });
  it('projects one chat without library metadata, file contents, or paths', () => {
    const projected = remoteView(update()), serialized = JSON.stringify(projected);
    for (const secret of ['PRIVATE_', 'SECRET_', 'C:/private']) expect(serialized).not.toContain(secret);
    expect(projected.library.conversations.map(item => item.id)).toEqual([id]);
    expect(projected.library.activeRuns.map(item => item.conversationId)).toEqual([id]);
    expect(projected.conversation.projectId).toBeNull();
    expect(projected.conversation.tools[0].result).toBeNull();
  });
  it('bounds snapshots and excludes prior message branches', () => {
    const full = update(); full.conversation.allMessages = [{ ...full.conversation.messages[0], text: 'PRIVATE_BRANCH' }];
    full.conversation.messages = Array.from({ length: 250 }, () => ({ ...full.conversation.messages[0], id: randomUUID(), text: '🙂'.repeat(100000) }));
    const projected = remoteView(full);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(700000);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_BRANCH');
  });
  it('exposes permitted Chat/Work summaries but only the selected conversation approval', () => {
    const full = update(), botId = randomUUID(), approvalId = randomUUID();
    full.conversation.mode = 'code';
    full.library.conversations.push({ id: botId, title: 'Bot', mode: 'bot', projectId: null, createdAt: 1, updatedAt: 1 });
    full.library.approvals.push({ ...full.library.approvals[0], id: approvalId, conversationId: id, details: 'Read the requested document.' });
    const projected = remoteView(full, true);
    expect(projected.conversation.mode).toBe('code');
    expect(projected.library.conversations.map(item => item.id)).toEqual([other]);
    expect(projected.library.conversations[0].projectId).toBeNull();
    expect(projected.library.approvals.map(item => item.id)).toEqual([approvalId]);
    expect(projected.library.approvals[0].details).toBe('Read the requested document.');
    expect(projected.conversation.tools[0].result).toBeNull();
  });
  it('requires desktop review rather than presenting truncated approval details', () => {
    const full = update();
    full.library.approvals = [{ ...full.library.approvals[0], conversationId: id, details: 'x'.repeat(12001) }];
    expect(remoteView(full, true).library.approvals).toEqual([]);
  });
  it('sends verified citation previews without exposing raw tool output or credential URLs', () => {
    const full = update(); full.conversation.tools[0] = { ...full.conversation.tools[0], name: 'search_web', result: JSON.stringify({ results: [{ url: 'https://example.org/report', title: 'Research report', snippet: 'Observed finding.' }, { url: 'https://secret:password@example.org/private', title: 'Credential URL' }], private: 'PRIVATE_RAW_TOOL_OUTPUT' }) };
    const projected = remoteView(full);
    expect(projected.conversation.messages[0].citations).toEqual([{ key: 'https://example.org/report', url: 'https://example.org/report', domain: 'example.org', title: 'Research report', snippet: 'Observed finding.' }]);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_RAW_TOOL_OUTPUT');
    expect(JSON.stringify(projected)).not.toContain('password');
    expect(projected.conversation.tools[0].result).toBeNull();
  });
  it('preserves recent response versions and their parents within the authorized conversation', () => {
    const full = update(), user = { ...full.conversation.messages[0], id: randomUUID(), parentId: null, role: 'user' as const, text: 'Question' }, first = { ...full.conversation.messages[0], id: randomUUID(), parentId: user.id, text: 'First version' }, second = { ...first, id: randomUUID(), text: 'Regenerated version' };
    full.conversation.messages = [user,second]; full.conversation.allMessages = [user,first,second];
    const projected = remoteView(full);
    expect(projected.conversation.allMessages?.map(message => [message.id,message.parentId])).toEqual([[user.id,null],[first.id,user.id],[second.id,user.id]]);
    expect(projected.conversation.headId).toBe(second.id);
    expect(projected.conversation.messages.map(message => message.id)).toEqual([user.id,second.id]);
  });
  it('rejects arbitrary operations and oversized messages while allowing explicit conversation targets', () => {
    expect(remoteCommandSchema.safeParse({ id, op: 'invoke', channel: 'tinygpt:settings' }).success).toBe(false);
    expect(remoteCommandSchema.safeParse({ id, op: 'send', text: 'hello', conversationId: other }).success).toBe(true);
    expect(remoteCommandSchema.safeParse({ id, op: 'send', text: 'x'.repeat(32001) }).success).toBe(false);
  });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'tinygpt-remote-test-')); fixtures.push(directory);
  const chat = { update: vi.fn((_target?: string) => update()), send: vi.fn(() => update()), cancel: vi.fn(async () => update()) };
  const service = new RemoteService(directory, { available: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() }, chat);
  const internals = service as any;
  internals.saved.enabled = true; internals.saved.e2eVersion = 2;
  internals.saved.key = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  internals.saved.grants = [{ id: grantId, psk: 'a'.repeat(64), deviceId, conversationId: id, expiresAt: Date.now() + 60000 }];
  const sent: any[] = []; internals.send = (value: unknown) => sent.push(value);
  const request = (command: unknown, extra = {}) => internals.command(JSON.stringify({ type: 'command', deviceId, grantId, conversationId: id, command, ...extra }));
  return { service, internals, chat, sent, request, directory };
}
describe('desktop remote authorization and delivery', () => {
  it('requires a separate device management grant and an active secure peer',async()=>{const f=await setup(),connectionId=randomUUID(),state=vi.fn(async()=>({allowed:true,computer:'PC',version:'1',keepAwake:false,memories:[]})),change=vi.fn(async()=>({}));f.service.setManagementActions({state,change});const envelope={deviceId,grantId,conversationId:id,connectionId};f.internals.securePeers.set(connectionId,{});f.internals.saved.grants[0].scope='library';await f.internals.managementCommand({...envelope,command:{id:randomUUID(),op:'state'}});expect(f.sent.at(-1).value.allowed).toBe(false);expect(state).not.toHaveBeenCalled();await f.internals.managementCommand({...envelope,command:{id:randomUUID(),op:'memory-sharing',value:true}});expect(change).not.toHaveBeenCalled();await f.service.setManagement(deviceId,true);await f.internals.managementCommand({...envelope,command:{id:randomUUID(),op:'memory-sharing',value:true}});expect(change).toHaveBeenCalledOnce();f.internals.securePeers.delete(connectionId);await f.internals.managementCommand({...envelope,command:{id:randomUUID(),op:'memory-sharing',value:false}});expect(change).toHaveBeenCalledOnce();});
  it('opens an empty library home without fetching or creating an old conversation', async () => {
    const f=await setup();f.internals.saved.grants[0].scope='library';f.internals.chat.library=()=>update().library;
    await f.request({id:randomUUID(),op:'get',home:true});expect(f.chat.update).not.toHaveBeenCalled();expect(f.sent.at(-1)).toMatchObject({ok:true,conversationId:REMOTE_DRAFT_ID});expect(f.chat.send).not.toHaveBeenCalled();
  });
  it('requires library permission for management and sends steering through the existing queue once', async () => {
    const f=await setup(),rename=vi.fn(),queueAction=vi.fn(()=>update());f.internals.actions={rename};f.internals.chat.queueAction=queueAction;
    await f.request({id:randomUUID(),op:'rename',conversationId:id,title:'New title'});expect(rename).not.toHaveBeenCalled();
    f.internals.saved.grants[0].scope='library';await f.request({id:randomUUID(),op:'rename',conversationId:id,title:'New title'});expect(rename).toHaveBeenCalledWith(id,'New title');
    const queuedId=randomUUID();f.chat.send.mockImplementation(()=>{const value=update();value.conversation.queuedRequests=[{id:queuedId,text:'New direction',attachmentIds:[],createdAt:1,lane:'queue'}];return value;});
    const command={id:randomUUID(),op:'send',conversationId:id,text:'New direction',delivery:'steer'};await f.request(command);await f.request(command);
    expect(f.chat.send).toHaveBeenCalledTimes(1);expect(queueAction).toHaveBeenCalledExactlyOnceWith({conversationId:id,action:'steer',id:queuedId});
    await f.request({id:randomUUID(),op:'queue',conversationId:id,change:{conversationId:other,action:'resume'}});expect(queueAction).toHaveBeenCalledTimes(1);
  });
  it('deletes once and moves deleted subscriptions to an ephemeral draft, including receipt replay',async()=>{
    const f=await setup();f.internals.saved.grants[0].scope='library';let removed=false;const remove=vi.fn(async()=>{removed=true;});f.internals.actions={delete:remove};f.internals.chat.library=()=>({...update().library,conversations:[]});f.chat.update.mockImplementation(()=>{if(removed)throw Error('Missing chat');return update();});
    const command={id:randomUUID(),op:'delete',conversationId:id};await f.request(command);await f.request(command);expect(remove).toHaveBeenCalledTimes(1);expect(f.sent.at(-1)).toMatchObject({ok:true,conversationId:REMOTE_DRAFT_ID});expect(f.internals.subscriptions.get(deviceId).conversationId).toBe(REMOTE_DRAFT_ID);
  });
  it('uses authorized desktop model catalogs and saves Chat/Work effort independently', async () => {
    const f=await setup(),connectionId=randomUUID(),peerId=randomUUID();f.internals.saved.grants[0].scope='library';
    const state={connectionId,model:'first',name:'First',effort:{chat:'medium',code:'high'},connections:[{id:connectionId,name:'Provider'}]};
    const select=vi.fn(async(_id:string,model:string,authorized:()=>void)=>{authorized();state.model=model;state.name=model;});
    const effort=vi.fn(async(mode:'chat'|'code',value:string,authorized:()=>void)=>{authorized();state.effort[mode]=value;});
    f.service.setInference({state:()=>state as any,models:async()=>({models:[{id:'second',name:'Second'}]}),select,effort:effort as any});
    const call=async(command:any)=>{await f.internals.inferenceCommand({deviceId,connectionId:peerId,grantId,conversationId:id,command:{id:randomUUID(),...command}});return f.sent.filter(item=>item.type==='inference-reply').at(-1);};
    expect(await call({op:'models',connectionId})).toMatchObject({ok:true,connectionId:peerId,value:{models:[{id:'second',name:'Second'}]}});
    expect(await call({op:'select',connectionId,model:'second'})).toMatchObject({ok:true,value:{model:'second'}});expect(select).toHaveBeenCalledTimes(1);
    expect(await call({op:'effort',mode:'chat',effort:'max'})).toMatchObject({ok:true,value:{effort:{chat:'max',code:'high'}}});
    expect(await call({op:'effort',mode:'code',effort:'instant'})).toMatchObject({ok:true,value:{effort:{chat:'max',code:'instant'}}});
    f.internals.saved.grants[0].scope='conversation';expect(await call({op:'select',connectionId,model:'first'})).toMatchObject({ok:false});expect(select).toHaveBeenCalledTimes(1);
    f.internals.saved.grants[0].scope='library';f.internals.saved.revoked.push(deviceId);expect(await call({op:'models',connectionId})).toMatchObject({ok:false});
  });
  it('blocks concurrent model changes and rechecks revocation after catalog work without blocking Stop',async()=>{
    const f=await setup(),connectionId=randomUUID(),peerId=randomUUID();f.internals.saved.grants[0].scope='library';
    let finish!:()=>void;const gate=new Promise<void>(resolve=>finish=resolve),activated=vi.fn();
    f.service.setInference({state:()=>({connectionId,model:'first',name:'First',effort:{chat:'medium',code:'high'},connections:[]}),models:async()=>({models:[]}),select:async(_id,_model,authorized)=>{await gate;authorized();activated();},effort:async()=>{}});
    const envelope=(command:any)=>({deviceId,connectionId:peerId,grantId,conversationId:id,command:{id:randomUUID(),...command}});
    const first=f.internals.inferenceCommand(envelope({op:'select',connectionId,model:'second'}));
    await f.internals.inferenceCommand(envelope({op:'effort',mode:'chat',effort:'max'}));expect(f.sent.at(-1)).toMatchObject({ok:false,error:'A model change is already in progress. Try again shortly.'});
    await f.request({id:randomUUID(),op:'stop',conversationId:id});expect(f.chat.cancel).toHaveBeenCalledWith(id);
    f.internals.saved.revoked.push(deviceId);finish();await first;expect(activated).not.toHaveBeenCalled();expect(f.sent.at(-1)).toMatchObject({ok:false,error:'Remote access has ended.'});
  });
  it('hides mobile image filenames without changing the original desktop tool',()=>{
    const full=update();const original={...full.conversation.tools[0],name:'view_image' as const,target:'C:/images/private-image.png',displayText:'Viewed private-image.png'};full.conversation.tools=[original];
    const projected=remoteView(full);expect(projected.conversation.tools[0].target).toBeUndefined();expect(projected.conversation.tools[0].displayText).toBeUndefined();expect(JSON.stringify(projected)).not.toContain('private-image.png');expect(original.target).toBe('C:/images/private-image.png');
  });
  it('persists only opaque push events, retries them on reconnect and removes acknowledged events',async()=>{
    const f=await setup(),event={id:randomUUID(),conversationId:id,sequence:1,messageId:null,createdAt:Date.now(),mode:'chat' as const,kind:'completed' as const,title:'Reply ready',detail:'PRIVATE_REPLY',read:false,resolved:false};
    f.service.notify(event);await f.internals.pushWrites;expect(f.internals.saved.pushOutbox).toHaveLength(1);expect(JSON.stringify(f.internals.saved.pushOutbox)).not.toContain('PRIVATE_REPLY');f.sent.length=0;f.internals.flushPush();expect(f.sent.some(item=>item.type==='notification'&&item.event.id===event.id)).toBe(true);
    f.internals.acknowledgePush(event.id);await f.internals.pushWrites;expect(f.internals.saved.pushOutbox).toEqual([]);
    f.service.notify({...event,id:randomUUID(),conversationId:other});await f.internals.pushWrites;expect(f.internals.saved.pushOutbox).toEqual([]);
    f.internals.saved.enabled=false;f.service.notify({...event,id:randomUUID()});await f.internals.pushWrites;expect(f.internals.saved.pushOutbox).toEqual([]);
  });

  it('checks media scope and revocation without storing file chunks in receipts',async()=>{
    const f=await setup(),handle=vi.fn(async()=>null);f.internals.media={handle};
    const envelope={deviceId,connectionId:randomUUID(),grantId,conversationId:id,command:{id:randomUUID(),conversationId:other,jobId:randomUUID(),op:'upload-start',name:'note.txt',bytes:4}};
    await f.internals.mediaCommand(envelope);expect(handle).not.toHaveBeenCalled();envelope.command.conversationId=id;await f.internals.mediaCommand(envelope);expect(handle).toHaveBeenCalledTimes(1);expect(Object.keys(f.internals.saved.receipts)).toHaveLength(0);
    f.internals.saved.revoked.push(deviceId);await f.internals.mediaCommand(envelope);expect(handle).toHaveBeenCalledTimes(1);
  });
  it('checks generated visual access against the paired conversation grant',async()=>{
    const f=await setup(),handle=vi.fn(async()=>({ui:{},partial:false}));f.internals.media={handle};
    const envelope={deviceId,connectionId:randomUUID(),grantId,conversationId:id,command:{id:randomUUID(),conversationId:other,jobId:randomUUID(),op:'tool-ui',toolId:randomUUID()}};
    await f.internals.mediaCommand(envelope);expect(handle).not.toHaveBeenCalled();
    envelope.command.conversationId=id;await f.internals.mediaCommand(envelope);expect(handle).toHaveBeenCalledTimes(1);
    f.internals.saved.revoked.push(deviceId);await f.internals.mediaCommand(envelope);expect(handle).toHaveBeenCalledTimes(1);
  });
  it('validates attachments and forwards attachment-only messages through normal chat',async()=>{
    const f=await setup(),sourceId=randomUUID(),validateAttachments=vi.fn();f.internals.actions={validateAttachments};
    const command={id:randomUUID(),op:'send',conversationId:id,text:'',attachmentIds:[sourceId]};await f.request(command);await f.request(command);
    expect(validateAttachments).toHaveBeenCalledExactlyOnceWith(id,[sourceId]);expect(f.chat.send).toHaveBeenCalledExactlyOnceWith(id,'',[sourceId],true);
    expect(remoteCommandSchema.safeParse({...command,text:'',attachmentIds:[]}).success).toBe(false);
  });

  it('authorizes voice against the desktop grant and never writes audio receipts',async () => {
    const fixture = await setup(), handle = vi.fn(async () => null); fixture.internals.voice = { handle };
    const envelope = { deviceId,connectionId: randomUUID(),grantId,conversationId: id,command: { id: randomUUID(),conversationId: other,jobId: randomUUID(),op: 'dictation-start',sampleRate: 16000 } };
    await fixture.internals.voiceCommand(envelope); expect(handle).not.toHaveBeenCalled();
    envelope.command.conversationId = id; await fixture.internals.voiceCommand(envelope); expect(handle).toHaveBeenCalledTimes(1);
    expect(Object.keys(fixture.internals.saved.receipts)).toHaveLength(0);
    fixture.internals.saved.revoked.push(deviceId); await fixture.internals.voiceCommand({ ...envelope,command: { ...envelope.command,id: randomUUID() } }); expect(handle).toHaveBeenCalledTimes(1);
  });
  it('edits and regenerates owned messages once across command retries', async () => {
    const fixture = await setup(), view = update(); view.library.activeRuns = [];
    const answer = view.conversation.messages[0], user = { ...answer, id: randomUUID(), role: 'user' as const };
    view.conversation.messages.unshift(user); fixture.chat.update.mockReturnValue(view);
    const edit = vi.fn(async () => view), regenerate = vi.fn(() => view); fixture.internals.actions = { edit,regenerate };
    const change = { id: randomUUID(), op: 'edit', conversationId: id, messageId: user.id, text: 'Edited question' }, retry = { id: randomUUID(), op: 'regenerate', conversationId: id, messageId: answer.id };
    await fixture.request(change); await fixture.request(change); await fixture.request(retry); await fixture.request(retry);
    expect(edit).toHaveBeenCalledExactlyOnceWith(id,user.id,'Edited question'); expect(regenerate).toHaveBeenCalledExactlyOnceWith(id,answer.id);
    expect(fixture.sent.at(-1).ok).toBe(true);
  });
  it('rejects other message IDs, wrong roles, and edits or regeneration during an active run', async () => {
    const fixture = await setup(), view = update(), edit = vi.fn(), regenerate = vi.fn(), branch = vi.fn();
    fixture.chat.update.mockReturnValue(view); fixture.internals.actions = { edit,regenerate,branch };
    await fixture.request({ id: randomUUID(), op: 'regenerate', conversationId: id, messageId: view.conversation.messages[0].id });
    expect(fixture.sent.at(-1).error).toContain('Stop'); view.library.activeRuns = [];
    await fixture.request({ id: randomUUID(), op: 'edit', conversationId: id, messageId: view.conversation.messages[0].id, text: 'Wrong role' });
    await fixture.request({ id: randomUUID(), op: 'regenerate', conversationId: id, messageId: other });
    await fixture.request({ id: randomUUID(), op: 'branch', conversationId: id, messageId: other });
    await fixture.request({ id: randomUUID(), op: 'edit', conversationId: other, messageId: other, text: 'Outside this chat' });
    expect(edit).not.toHaveBeenCalled(); expect(regenerate).not.toHaveBeenCalled(); expect(branch).not.toHaveBeenCalled();
  });
  it('pins the stored conversation mode rather than inheriting the desktop composer mode', async () => {
    const fixture = await setup();
    await fixture.request({ id: randomUUID(), op: 'send', text: 'Stay in Chat' });
    expect(fixture.chat.send).toHaveBeenCalledWith(id, 'Stay in Chat', [], true);
  });
  it('denies explicit cross-conversation targets and creation for a single-chat device', async () => {
    const fixture = await setup();
    await fixture.request({ id: randomUUID(), op: 'get', conversationId: other });
    await fixture.request({ id: randomUUID(), op: 'create', mode: 'code' });
    expect(fixture.chat.update).not.toHaveBeenCalled();
    expect(fixture.sent.every(reply => reply.ok === false)).toBe(true);
  });
  it('creates Work explicitly and deduplicates creation across retries', async () => {
    const fixture = await setup(), created = update();
    created.conversation = { ...created.conversation, id: other, mode: 'code', messages: [] }; created.library.approvals = [];
    fixture.internals.saved.grants[0].scope = 'library';
    fixture.chat.update.mockImplementation(target => target === other ? created : update());
    const create = vi.fn(async () => created); fixture.internals.actions = { create };
    const command = { id: randomUUID(), op: 'create', mode: 'code' };
    await fixture.request(command); await fixture.request(command);
    expect(create).toHaveBeenCalledExactlyOnceWith('code');
    expect(fixture.sent.at(-1)).toMatchObject({ ok: true, conversationId: other });
    await fixture.request({ id: randomUUID(), op: 'send', conversationId: other, text: 'Do the task' });
    expect(fixture.chat.send).toHaveBeenCalledWith(other, 'Do the task', [], true);
  });
  it('checks approval ownership even for a device with library access', async () => {
    const fixture = await setup(), approve = vi.fn();
    fixture.internals.saved.grants[0].scope = 'library'; fixture.internals.actions = { approve };
    await fixture.request({ id: randomUUID(), op: 'approve', conversationId: id, approvalId: other, decision: 'allow-once' });
    expect(approve).not.toHaveBeenCalled(); expect(fixture.sent.at(-1).ok).toBe(false);
  });
  it('pauses access without forgetting grants and preserves the paused state across restart', async () => {
    const fixture = await setup();
    await fixture.service.configure({ enabled: false, keepAwake: true });
    await fixture.request({ id: randomUUID(), op: 'send', text: 'Blocked while paused' });
    expect(fixture.chat.send).not.toHaveBeenCalled();
    expect(fixture.internals.saved.grants).toHaveLength(1);
    const restored = new RemoteService(fixture.directory, { available: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() }, fixture.chat);
    await restored.load();
    expect(restored.status()).toMatchObject({ enabled: false, connected: false, keepAwake: true, error: undefined });
    expect((restored as any).saved.grants).toHaveLength(1); restored.close();
  });
  it('keeps the computer awake only while remote connections are enabled and releases it on close', async () => {
    const fixture = await setup(), awake = vi.fn(); fixture.internals.awake = awake;
    await fixture.service.configure({ keepAwake: true }); expect(awake).toHaveBeenLastCalledWith(true);
    await fixture.service.configure({ enabled: false }); expect(awake).toHaveBeenLastCalledWith(false);
    await fixture.service.configure({ enabled: true }); expect(awake).toHaveBeenLastCalledWith(true);
    fixture.service.close(); expect(awake).toHaveBeenLastCalledWith(false);
  });
  it('does not execute an admitted send if access is paused before its durable receipt finishes', async () => {
    const fixture = await setup(); let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(fixture.internals, 'persist').mockReturnValueOnce(waiting);
    const command = fixture.request({ id: randomUUID(), op: 'send', text: 'Do not execute' });
    fixture.internals.saved.enabled = false; resume(); await command;
    expect(fixture.chat.send).not.toHaveBeenCalled(); expect(fixture.sent.at(-1).ok).toBe(false);
  });
  it('can load a disconnected profile without treating its cleared identity as corrupt', async () => {
    const fixture = await setup();
    await fixture.service.disconnect();
    const restored = new RemoteService(fixture.directory, { available: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() }, fixture.chat, 'https://relay.example');
    await restored.load();
    expect(restored.status()).toMatchObject({ configured: true, connected: false, devices: [], error: undefined });
    restored.close();
  });
  it('deduplicates sends durably and rejects a reused request ID with different text', async () => {
    const fixture = await setup(), command = { id: randomUUID(), op: 'send', text: 'Once' };
    await fixture.request(command); await fixture.request(command);
    expect(fixture.chat.send).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(JSON.parse(await readFile(join(fixture.directory, 'remote-chat.json'), 'utf8')).encrypted ? Buffer.from(JSON.parse(await readFile(join(fixture.directory, 'remote-chat.json'), 'utf8')).encrypted, 'base64').toString() : '{}');
    fixture.internals.saved = saved;
    await fixture.request(command); expect(fixture.chat.send).toHaveBeenCalledTimes(1);
    await fixture.request({ ...command, text: 'Different' }); expect(fixture.sent.at(-1).ok).toBe(false);
  });
  it('denies other conversations and locally revoked devices before calling chat', async () => {
    const fixture = await setup();
    await fixture.request({ id: randomUUID(), op: 'send', text: 'No' }, { conversationId: other });
    fixture.internals.saved.revoked.push(deviceId);
    await fixture.request({ id: randomUUID(), op: 'stop' });
    expect(fixture.chat.send).not.toHaveBeenCalled(); expect(fixture.chat.cancel).not.toHaveBeenCalled();
    expect(fixture.sent.every(item => item.ok === false)).toBe(true);
  });
  it('does not execute a receipt left uncertain by a crash', async () => {
    const fixture = await setup(), command = { id: randomUUID(), op: 'send', text: 'Once' };
    fixture.chat.send.mockImplementationOnce(() => { throw Error('Execution interrupted'); });
    await fixture.request(command); await fixture.request(command);
    expect(fixture.chat.send).toHaveBeenCalledTimes(1); expect(fixture.sent.at(-1).error).toContain('interrupted');
  });
  it('preserves tool approval boundaries but allows Stop', async () => {
    const fixture = await setup(), blocked = update(); blocked.library.approvals[0].conversationId = id;
    fixture.chat.update.mockReturnValue(blocked);
    await fixture.request({ id: randomUUID(), op: 'send', text: 'Do it' });
    expect(fixture.chat.send).not.toHaveBeenCalled(); expect(fixture.sent.at(-1).error).toContain('pending');
    await fixture.request({ id: randomUUID(), op: 'stop' }); expect(fixture.chat.cancel).toHaveBeenCalledWith(id);
  });
  it('does not navigate to an older conversation when its completed send is replayed',async()=>{
    const fixture = await setup(), connectionId = randomUUID(); fixture.internals.saved.grants[0].scope = 'library';
    fixture.chat.update.mockImplementation((target: string = id) => { const view = update(); view.conversation.id = target; return view; });
    const send = {id:randomUUID(),op:'send',conversationId:id,text:'Send once'};
    await fixture.request(send,{connectionId}); await fixture.request({id:randomUUID(),op:'get',conversationId:other},{connectionId});
    await fixture.request(send,{connectionId}); expect(fixture.chat.send).toHaveBeenCalledOnce(); expect(fixture.internals.subscriptions.get(connectionId).conversationId).toBe(other);
    expect(fixture.sent.filter(item=>item.type==='packet').at(-1).packet.id).toBe(other);
  });
  it('removes an obsolete device-wide subscription when a socket-scoped command arrives',async()=>{
    const fixture = await setup(), connectionId = randomUUID(); await fixture.request({id:randomUUID(),op:'get'});
    expect(fixture.internals.subscriptions.has(deviceId)).toBe(true); await fixture.request({id:randomUUID(),op:'get'},{connectionId});
    expect([...fixture.internals.subscriptions.keys()]).toEqual([connectionId]);
  });
  it('keeps browser and installed-app conversation selections independent for the same device', async () => {
    const fixture = await setup(); fixture.internals.saved.grants[0].scope = 'library';
    const first = randomUUID(), second = randomUUID();
    fixture.chat.update.mockImplementation((target: string = id) => { const value = update(); value.conversation.id = target; return value; });
    await fixture.request({ id: randomUUID(),op: 'get',conversationId: id },{ connectionId: first });
    await fixture.request({ id: randomUUID(),op: 'get',conversationId: other },{ connectionId: second });
    expect(fixture.internals.subscriptions.get(first).conversationId).toBe(id);
    expect(fixture.internals.subscriptions.get(second).conversationId).toBe(other);
    expect(fixture.sent.filter(item => item.type === 'packet').map(item => item.connectionId)).toEqual([first,second]);
    await fixture.request({ id: randomUUID(),op: 'get' },{ connectionId: first });
    expect(fixture.internals.subscriptions.get(first).conversationId).toBe(id);
    expect(fixture.internals.subscriptions.get(second).conversationId).toBe(other);
  });
  it('updates the built-in relay alias without clearing the desktop identity or grants',async () => {
    const fixture = await setup(); fixture.internals.saved.relayUrl = 'https://tinygpt-remote.taylor-d-jack.workers.dev'; await fixture.internals.persist();
    const restored = new RemoteService(fixture.directory,{ available:()=>true,encrypt:text=>Buffer.from(text),decrypt:bytes=>bytes.toString() },fixture.chat,'https://mobile.tinygpt.org');
    vi.spyOn(restored as any,'connect').mockImplementation(() => {}); await restored.load();
    expect(restored.status().relayUrl).toBe('https://mobile.tinygpt.org'); expect((restored as any).saved.key).toBe(fixture.internals.saved.key); expect((restored as any).saved.grants[0].id).toBe(grantId); restored.close();
  });
  it('invalidates pre-encryption grants without replacing the desktop identity',async()=>{
    const fixture=await setup(); delete fixture.internals.saved.e2eVersion; await fixture.internals.persist();
    const restored=new RemoteService(fixture.directory,{available:()=>true,encrypt:text=>Buffer.from(text),decrypt:bytes=>bytes.toString()},fixture.chat);
    vi.spyOn(restored as any,'connect').mockImplementation(()=>{}); await restored.load();
    expect((restored as any).saved.grants).toEqual([]); expect((restored as any).saved.e2eVersion).toBe(2); expect((restored as any).saved.key).toBe(fixture.internals.saved.key); restored.close();
  });
  it('can replace and shut down a connecting socket without an unhandled handshake error or losing grants', async () => {
    const fixture = await setup(); fixture.internals.saved.relayUrl = 'http://127.0.0.1:1';
    fixture.internals.connect(); fixture.internals.connect(); fixture.service.close();
    await new Promise(resolve => setTimeout(resolve,30));
    expect(fixture.service.status().connected).toBe(false); expect(fixture.internals.saved.grants[0].id).toBe(grantId);
    expect(fixture.internals.closed).toBe(true);
  });
  it('only admits pairing approvals belonging to a live local grant', async () => {
    const fixture = await setup(); fixture.internals.saved.relayUrl = 'https://relay.example';
    const request = vi.spyOn(fixture.internals,'request').mockResolvedValue({ devices: [],requests: [{ id: deviceId,name: 'Phone',grantId: other,expiresAt: Date.now() + 60000 }] });
    await expect(fixture.service.approvePairing(deviceId,true)).rejects.toThrow('expired');
    expect(request).not.toHaveBeenCalledWith('approve','POST',expect.anything());
    request.mockResolvedValue({ devices: [],requests: [{ id: deviceId,name: 'Phone',grantId,expiresAt: Date.now() + 60000 }] });
    await fixture.service.approvePairing(deviceId,true); expect(request).toHaveBeenCalledWith('approve','POST',{ id: deviceId,allow: true });
    fixture.internals.saved.enabled = false; await expect(fixture.service.approvePairing(deviceId,true)).rejects.toThrow('paused');
  });

});
