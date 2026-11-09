import { createECDH,randomBytes,randomUUID,hkdfSync,createDecipheriv,createPublicKey,verify } from 'node:crypto';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { PushDelivery } from '../remote-relay/src/push';
import { pushEndpoint,pushRegistrationSchema,remotePushEvent,type RemotePushEvent } from '../src/shared/remote-push';

class Store {
  values=new Map<string,any>();alarm=0;
  async get<T>(key:string):Promise<T|undefined>{return structuredClone(this.values.get(key));}
  async put(key:string,value:unknown){this.values.set(key,structuredClone(value));}
  async transaction<T>(callback:(store:Store)=>Promise<T>){return callback(this);}
  async setAlarm(time:number){this.alarm=time;}
}
function curve(){const key=createECDH('prime256v1');key.generateKeys();return key;}
function event(extra:Partial<RemotePushEvent>={}):RemotePushEvent{return {id:randomUUID(),conversationId:randomUUID(),sequence:1,createdAt:Date.now(),kind:'completed',mode:'chat',...extra};}
async function setup(scope:'library'|'conversation'='library'){
  const vapid=curve(),phone=curve(),auth=randomBytes(16),store=new Store(),desktop='a'.repeat(64),clientId=randomUUID();
  const device={id:randomUUID(),grantId:randomUUID(),conversationId:randomUUID(),expiresAt:Date.now()+86400000};let devices=[device];
  const env={VAPID_PUBLIC_KEY:vapid.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:vapid.getPrivateKey().toString('base64url'),VAPID_SUBJECT:'https://tinygpt.org'};
  const delivery=new PushDelivery(store,env,async()=>devices),fetcher=vi.fn(async()=>new Response(null,{status:201}));vi.stubGlobal('fetch',fetcher);
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/'+randomUUID(),expirationTime:null,keys:{p256dh:phone.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}};
  await store.put('computer-name','Studio PC');await delivery.policy({enabled:true,grants:[{id:device.grantId,conversationId:device.conversationId,scope}]});
  const register=async(preferences={completed:true,attention:true})=>delivery.register(device,desktop,'https://mobile.tinygpt.org',{op:'subscribe',clientId,subscription,preferences});
  await register();return {delivery,env,phone,auth,store,desktop,clientId,device,subscription,fetcher,register,revoke:()=>{devices=[];}};
}
afterEach(()=>vi.unstubAllGlobals());
function decrypt(body:Uint8Array,phone:ReturnType<typeof curve>,auth:Buffer){
  const bytes=Buffer.from(body),salt=bytes.subarray(0,16),size=bytes[20],server=bytes.subarray(21,21+size),ciphertext=bytes.subarray(21+size),shared=phone.computeSecret(server);
  const ikm=hkdfSync('sha256',shared,auth,Buffer.concat([Buffer.from('WebPush: info\0'),phone.getPublicKey(),server]),32);
  const key=hkdfSync('sha256',Buffer.from(ikm),salt,Buffer.from('Content-Encoding: aes128gcm\0'),16),iv=hkdfSync('sha256',Buffer.from(ikm),salt,Buffer.from('Content-Encoding: nonce\0'),12);
  const decipher=createDecipheriv('aes-128-gcm',Buffer.from(key),Buffer.from(iv));decipher.setAuthTag(ciphertext.subarray(-16));
  const plain=Buffer.concat([decipher.update(ciphertext.subarray(0,-16)),decipher.final()]);let end=plain.length-1;while(plain[end]===0)end--;expect(plain[end]).toBe(2);return JSON.parse(plain.subarray(0,end).toString());
}
describe('background Web Push delivery',()=>{
  it('sends interoperable encrypted notifications and valid VAPID signatures without chat text',async()=>{
    const f=await setup(),item=event();await f.delivery.enqueue(item);await f.delivery.alarm();expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [endpoint,request]=f.fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(endpoint).toBe(f.subscription.endpoint);expect(request.redirect).toBe('error');
    const headers=new Headers(request.headers);expect(headers.get('content-encoding')).toBe('aes128gcm');expect(headers.get('ttl')).toBe('1800');
    const payload=decrypt(request.body as Uint8Array,f.phone,f.auth);expect(payload).toMatchObject({web_push:8030,notification:{title:'Reply ready',body:'Studio PC · Your reply is ready.',app_badge:'1'}});expect(payload.notification.navigate).toContain('desktop='+f.desktop);expect(payload.notification.navigate).toContain('conversation='+item.conversationId);
    const jwt=/vapid t=([^,]+),/.exec(headers.get('authorization')!)![1],parts=jwt.split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());expect(claims.aud).toBe('https://fcm.googleapis.com');expect(claims.sub).toBe('https://tinygpt.org');
    const publicBytes=Buffer.from(f.env.VAPID_PUBLIC_KEY,'base64url'),key=createPublicKey({key:{kty:'EC',crv:'P-256',x:publicBytes.subarray(1,33).toString('base64url'),y:publicBytes.subarray(33,65).toString('base64url')},format:'jwk'});expect(verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url'))).toBe(true);
    expect(f.store.values.get('push-jobs')).toEqual([]);
  });
  it('deduplicates desktop retries and replaces stale pending alerts for the same chat',async()=>{
    const f=await setup(),approval=event({kind:'approval'});await f.delivery.enqueue(approval);await f.delivery.enqueue(approval);expect(f.store.values.get('push-jobs')).toHaveLength(1);
    const completed=event({conversationId:approval.conversationId,createdAt:approval.createdAt+1,sequence:2});await f.delivery.enqueue(completed);await f.delivery.enqueue({...approval,id:randomUUID()});await f.delivery.alarm();expect(f.fetcher).toHaveBeenCalledTimes(1);const request=(f.fetcher.mock.calls[0] as any)[1];expect(decrypt(request.body,f.phone,f.auth).notification.title).toBe('Reply ready');
  });
  it('honors conversation scope and checks scope changes before delivery',async()=>{
    const f=await setup('conversation');await f.delivery.enqueue(event());expect(f.store.values.get('push-jobs')).toEqual([]);
    await f.delivery.enqueue(event({conversationId:f.device.conversationId}));await f.delivery.policy({enabled:false,grants:[]});await f.delivery.alarm();expect(f.fetcher).not.toHaveBeenCalled();
    const other=await setup();await other.delivery.enqueue(event());await other.delivery.policy({enabled:true,grants:[{id:other.device.grantId,conversationId:other.device.conversationId,scope:'conversation'}]});await other.delivery.alarm();expect(other.fetcher).not.toHaveBeenCalled();
  });
  it('does not deliver to a revoked device and removes its subscriptions and queued work',async()=>{
    const f=await setup();await f.delivery.enqueue(event());f.revoke();await f.delivery.alarm();expect(f.fetcher).not.toHaveBeenCalled();await f.delivery.remove(f.device.id);expect(f.store.values.get('push-subscriptions')).toEqual([]);expect(f.store.values.get('push-jobs')).toEqual([]);
  });
  it('removes expired push endpoints after the provider returns Gone',async()=>{
    const f=await setup();f.fetcher.mockResolvedValue(new Response(null,{status:410}));await f.delivery.enqueue(event());await f.delivery.alarm();expect(f.store.values.get('push-subscriptions')).toEqual([]);expect(f.store.values.get('push-jobs')).toEqual([]);
  });
  it('stops the remaining deliveries when a device is revoked during a push batch',async()=>{
    const f=await setup();await f.delivery.register(f.device,f.desktop,'https://mobile.tinygpt.org',{op:'subscribe',clientId:randomUUID(),subscription:{...f.subscription,endpoint:'https://fcm.googleapis.com/fcm/send/'+randomUUID()},preferences:{completed:true,attention:true}});
    let finish!:(response:Response)=>void;f.fetcher.mockImplementation(()=>new Promise(resolve=>finish=resolve));await f.delivery.enqueue(event());const running=f.delivery.alarm();await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledTimes(1));await f.delivery.remove(f.device.id);finish(new Response(null,{status:201}));await running;expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('retries provider failures with backoff and drops messages after expiry',async()=>{
    const f=await setup();f.fetcher.mockResolvedValue(new Response(null,{status:429,headers:{'Retry-After':'60'}}));await f.delivery.enqueue(event());await f.delivery.alarm();const job=f.store.values.get('push-jobs')[0];expect(job.attempt).toBe(1);expect(job.nextAt).toBeGreaterThan(Date.now()+59000);expect(f.store.alarm).toBeGreaterThan(Date.now());
    job.nextAt=Date.now()-1;job.expiresAt=Date.now()-1;f.store.values.set('push-jobs',[job]);await f.delivery.alarm();expect(f.fetcher).toHaveBeenCalledTimes(1);expect(f.store.values.get('push-jobs')).toEqual([]);
  });
  it('keeps attention alerts when completed replies are switched off',async()=>{
    const f=await setup();await f.register({completed:false,attention:true});await f.delivery.enqueue(event());expect(f.store.values.get('push-jobs')).toEqual([]);await f.delivery.enqueue(event({kind:'question'}));await f.delivery.alarm();expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('replaces a rotated subscription for the same installation and clears it on opt-out',async()=>{
    const f=await setup();f.subscription.endpoint='https://web.push.apple.com/'+randomUUID();await f.register();expect(f.store.values.get('push-subscriptions')).toHaveLength(1);await f.delivery.enqueue(event());await f.delivery.register(f.device,f.desktop,'https://mobile.tinygpt.org',{op:'remove',clientId:f.clientId});await f.delivery.alarm();expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('only accepts real push-provider URLs, valid curve keys and explicit operations',async()=>{
    // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- Synthetic credential-bearing URL rejection fixture; no real credentials.
    for(const endpoint of ['http://fcm.googleapis.com/send','https://127.0.0.1/admin','https://example.org','https://fcm.googleapis.com.evil.test/send','https://user:secret@web.push.apple.com/a','https://web.push.apple.com:8443/a'])expect(pushEndpoint(endpoint)).toBe(false);
    const f=await setup();await expect(f.delivery.register(f.device,f.desktop,'https://mobile.tinygpt.org',{op:'subscribe',clientId:f.clientId,subscription:{...f.subscription,keys:{...f.subscription.keys,p256dh:'B'+'A'.repeat(86)}},preferences:{completed:true,attention:true}})).rejects.toThrow();
    expect(pushRegistrationSchema.safeParse({op:'send',endpoint:f.subscription.endpoint}).success).toBe(false);
  });
  it('strips message and approval text before a desktop event reaches the relay',()=>{
    const value=remotePushEvent({id:randomUUID(),conversationId:randomUUID(),sequence:1,messageId:randomUUID(),createdAt:Date.now(),mode:'code',kind:'attention',title:'Approval needed',detail:'PRIVATE_APPROVAL_BODY',read:false,resolved:false});expect(value?.kind).toBe('approval');expect(JSON.stringify(value)).not.toContain('PRIVATE');expect(value).not.toHaveProperty('messageId');
  });
});
