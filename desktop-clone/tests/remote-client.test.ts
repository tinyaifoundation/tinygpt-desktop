import { RemoteCipher } from '../src/shared/remote-crypto';
vi.mock('../src/renderer/lib/mobile-keys', () => ({ loadPrivateRecovery: async () => [], savePrivateRecovery: async () => {}, pairingKey: async () => ({deviceId:'11111111-1111-4111-8111-111111111111',grantId:'22222222-2222-4222-8222-222222222222',psk:'a'.repeat(64)}) }));
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { REMOTE_DRAFT_ID } from '../src/shared/remote';
import { RemoteClient } from '../src/renderer/lib/remote-client';
import { ChatUpdateEncoder } from '../src/core/chat-updates';
import type { ChatUpdate } from '../src/shared/chat';
const desktop = '1'.repeat(64), a = randomUUID(), b = randomUUID(), c = randomUUID();
class StorageMock { values = new Map<string,string>(); getItem(key: string) { return this.values.get(key) ?? null; } setItem(key: string,value: string) { this.values.set(key,value); } removeItem(key: string) { this.values.delete(key); } }
class Socket {
  static OPEN = 1; readyState = 1; sent: any[] = [];
  onopen?: () => void; onmessage?: (event: {data:string}) => void; onclose?: (event: {code:number}) => void;
  route = { desktopId: desktop, deviceId:'11111111-1111-4111-8111-111111111111', grantId:'22222222-2222-4222-8222-222222222222', connectionId:randomUUID() };
  cipher?: RemoteCipher; wire: string[] = [];
  send(text: string) {
    this.wire.push(text); const value = JSON.parse(text);
    if (value.type === 'handshake') { this.cipher?.destroy(); this.cipher = new RemoteCipher(false,'a'.repeat(64),this.route); this.raw({type:'handshake',data:this.cipher.handshakeMessage(value.data)}); return; }
    if (value.type !== 'encrypted') throw Error('Plaintext application send');
    const payload = this.cipher!.open(value.data); if (payload !== undefined) this.sent.push(payload);
  }
  raw(value: unknown) { this.onmessage?.({data:JSON.stringify(value)}); }
  close() { this.readyState = 3; this.onclose?.({code:1000}); }
  message(value: any) {
    if (['presence','revoked'].includes(value.type)) { this.raw({...value,...this.route}); return; }
    for (const data of this.cipher!.seal({...value,deviceId:this.route.deviceId,connectionId:this.route.connectionId})) this.raw({type:'encrypted',data});
  }
}
let storage: StorageMock; const clients: RemoteClient[] = [];
beforeEach(() => {
  vi.useFakeTimers(); storage = new StorageMock();
  const variables = new Map<string,string>();
  vi.stubGlobal('sessionStorage',storage); vi.stubGlobal('localStorage',new StorageMock()); vi.stubGlobal('location',{origin:'https://mobile.example'});
  vi.stubGlobal('document',{documentElement:{dataset:{theme:'light'},style:{colorScheme:'light',getPropertyValue:(key:string)=>variables.get(key) ?? '',setProperty:(key:string,value:string)=>variables.set(key,value)}},querySelector:()=>null});
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({ok:true}))); vi.stubGlobal('WebSocket',Socket);
});
afterEach(() => { for (const client of clients.splice(0)) client.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function value(id: string): ChatUpdate { return {conversation:{id,title:id,mode:'chat',projectId:null,createdAt:1,updatedAt:1,messages:[],tools:[],sources:[]},library:{projects:[],conversations:[],lastConversationId:id,activeRuns:[],approvals:[],browserHandoffs:[]}}; }
async function setup(selected?: string,restore = false) {
  if (selected) storage.setItem('tinygpt-selected:' + desktop,selected);
  const updates: string[] = [], client = new RemoteClient(desktop,()=>{},view=>updates.push(view.conversation.id),()=>{}); clients.push(client);
  if (restore) client.restore(); await client.connect(); const socket: Socket = (client as any).socket; socket.onopen?.(); socket.message({type:'presence',online:true});
  const packet = (id: string) => socket.message({type:'packet',scope:'library',packet:new ChatUpdateEncoder().encode(value(id))});
  const reply = (id:string,conversationId:string,ok=true) => socket.message({type:'reply',requestId:id,conversationId,ok,error:ok?undefined:'Not available'});
  return {client,socket,packet,reply,updates};
}
describe('remote conversation selection',()=>{
  it('rejects a plaintext snapshot even after an authenticated connection',async()=>{
    const f=await setup(); f.socket.raw({type:'packet',scope:'library',packet:new ChatUpdateEncoder().encode(value(a))});
    expect(f.updates).toEqual([]); expect(f.socket.readyState).toBe(3);
  });
  it('routes inference replies separately and never replays settings after reconnect',async()=>{
    const f=await setup(),id=randomUUID(),connectionId=randomUUID();f.packet(a);
    const pending=f.client.inference({id,op:'models',connectionId});expect(f.socket.sent.at(-1)).toEqual({type:'inference',command:{id,op:'models',connectionId}});
    f.socket.message({type:'inference-reply',requestId:id,ok:true,value:{models:[{id:'second',name:'Second'}]}});await expect(pending).resolves.toEqual({models:[{id:'second',name:'Second'}]});
    const changing=f.client.inference({id:randomUUID(),op:'select',connectionId,model:'second'});const rejected=expect(changing).rejects.toThrow('Connection interrupted');f.socket.close();await rejected;
    await f.client.connect();const socket:Socket=(f.client as any).socket;socket.onopen?.();socket.message({type:'presence',online:true});expect(socket.sent.some(item=>item.type==='inference')).toBe(false);expect(f.updates).toEqual([a]);
  });
  it('recovers from a notification whose chat was deleted before the app opened',async()=>{const f=await setup(b);f.packet(a);const request=f.socket.sent.at(-1);expect(request.conversationId).toBe(b);f.reply(request.id,b,false);expect(f.socket.sent.at(-1)).toMatchObject({op:'get'});expect(f.socket.sent.at(-1)).toMatchObject({home:true});f.packet(REMOTE_DRAFT_ID);expect(f.updates).toEqual([REMOTE_DRAFT_ID]);});

  it('ignores the pairing chat snapshot when resuming a selected chat',async()=>{
    const f = await setup(b); f.packet(a); expect(f.updates).toEqual([]); f.packet(b); expect(f.updates).toEqual([b]);
    expect(storage.getItem('tinygpt-selected:' + desktop)).toBe(b); expect(f.socket.sent.at(-1)).toMatchObject({op:'get',conversationId:b});
  });
  it('pins explicit navigation before the first selected snapshot arrives',async()=>{
    const f = await setup(); f.packet(a); const id = randomUUID(), pending = f.client.command({id,op:'get',conversationId:b});
    f.packet(a); f.packet(b); f.reply(id,b); await pending; f.packet(a); expect(f.updates).toEqual([a,b]);
    expect(storage.getItem('tinygpt-selected:' + desktop)).toBe(b);
  });
  it('does not let an acknowledged old send navigate away from a newer selection',async()=>{
    const f = await setup(); f.packet(a); const sendId = randomUUID(), send = f.client.command({id:sendId,op:'send',conversationId:a,text:'Hello'});
    const id = randomUUID(), get = f.client.command({id,op:'get',conversationId:b}); f.packet(b); f.reply(id,b); await get;
    f.packet(a); f.reply(sendId,a); await send; expect(f.updates.at(-1)).toBe(b); expect(f.updates.filter(id=>id===a)).toHaveLength(1);
  });
  it('decodes late packets without losing the selected conversation delta base',async()=>{
    const f = await setup(b), encoder = new ChatUpdateEncoder(); f.packet(b); f.packet(a);
    f.socket.message({type:'packet',scope:'library',packet:encoder.encode(value(b))}); f.socket.message({type:'packet',scope:'library',packet:encoder.encode(value(b))});
    expect(f.updates).toEqual([b,b,b]);
  });
  it('repairs a bad delta by requesting the selected chat explicitly',async()=>{
    const f = await setup(b); f.packet(b); f.socket.sent = [];
    f.socket.message({type:'packet',scope:'library',packet:{id:b,sequence:99,base:98,patch:{}}});
    expect(f.socket.sent.at(-1)).toMatchObject({op:'get',conversationId:b});
  });
  it('waits for the acknowledged new conversation before resolving creation',async()=>{
    const f = await setup(); f.packet(a); const id = randomUUID(), pending = f.client.command({id,op:'create',mode:'chat'});
    f.packet(a); f.packet(c); expect(f.updates).toEqual([a]); f.reply(id,c); await pending; expect(f.updates.at(-1)).toBe(c);
  });
  it('handles a creation reply before its snapshot without reusing the previous chat',async()=>{
    const f = await setup(); f.packet(a); const id = randomUUID(), done = vi.fn(), pending = f.client.command({id,op:'create',mode:'chat'}).then(done);
    f.reply(id,c); await Promise.resolve(); expect(done).not.toHaveBeenCalled(); f.packet(a); f.packet(c); await pending;
    expect(f.updates.at(-1)).toBe(c); expect(done).toHaveBeenCalledOnce();
  });
  it('does not let an older creation override a later explicit selection',async()=>{
    const f = await setup(); f.packet(a); const old = randomUUID(), create = f.client.command({id:old,op:'create',mode:'chat'});
    const id = randomUUID(), get = f.client.command({id,op:'get',conversationId:b}); f.packet(b); f.reply(id,b); await get;
    f.packet(c); f.reply(old,c); await create; expect(f.updates.at(-1)).toBe(b);
  });
  it('does not persist or replay stale read requests and restores selection after mutations',async()=>{
    const old = {id:randomUUID(),op:'get',conversationId:a}, send = {id:randomUUID(),op:'send',conversationId:a,text:'Hello'};
    storage.setItem('tinygpt-pending:' + desktop,JSON.stringify([old,send])); const f = await setup(b,true);
    expect(f.socket.sent.map(item=>item.op)).toEqual(['send','get']); expect(f.socket.sent.at(-1)).toMatchObject({conversationId:b});
  });
  it('restores a failed selection without overriding a newer successful choice',async()=>{
    const f = await setup(); f.packet(a); const id = randomUUID(), pending = f.client.command({id,op:'get',conversationId:b});
    const rejection = expect(pending).rejects.toThrow('Not available'); f.reply(id,b,false); await rejection; expect(storage.getItem('tinygpt-selected:' + desktop)).toBe(a);
  });
});

describe('companion media requests',()=>{
  it('validates a management reply and never persists or replays settings after interruption',async()=>{const f=await setup(),id=randomUUID(),pending=f.client.manage({id,op:'keep-awake',value:true});expect(f.socket.sent.at(-1)).toMatchObject({type:'management',command:{id,op:'keep-awake'}});const rejected=expect(pending).rejects.toThrow('interrupted');f.socket.message({type:'presence',online:false});await rejected;expect(storage.getItem('tinygpt-pending:'+desktop)).toBeNull();f.socket.sent=[];f.socket.message({type:'presence',online:true});expect(f.socket.sent.some(value=>value.type==='management')).toBe(false);const next=randomUUID(),state=f.client.manage({id:next,op:'state'});f.socket.message({type:'management-reply',requestId:next,ok:true,value:{allowed:true,computer:'PC',version:'1',keepAwake:true}});expect(await state).toMatchObject({allowed:true,keepAwake:true});});
  it('routes a file reply only to its matching request',async()=>{const f=await setup(),id=randomUUID(),pending=f.client.media({id,op:'tool-image',conversationId:a,jobId:randomUUID(),toolId:randomUUID()});expect(f.socket.sent.at(-1)).toMatchObject({type:'media',command:{id,op:'tool-image'}});f.socket.message({type:'media-reply',requestId:randomUUID(),ok:true,value:'wrong'});f.socket.message({type:'media-reply',requestId:id,ok:true,value:{image:'preview'}});expect(await pending).toEqual({image:'preview'});});
  it('rejects interrupted file requests and never replays their bytes',async()=>{const f=await setup(),pending=f.client.media({id:randomUUID(),op:'upload-chunk',conversationId:a,jobId:randomUUID(),sequence:0,data:'dGVzdA=='});const rejected=expect(pending).rejects.toThrow('interrupted');f.socket.message({type:'presence',online:false});await rejected;expect(storage.getItem('tinygpt-pending:'+desktop)).toBeNull();f.socket.sent=[];f.socket.message({type:'presence',online:true});expect(f.socket.sent.some(value=>value.type==='media')).toBe(false);});
});
