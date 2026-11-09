import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
const script=readFileSync(new URL('../src/renderer/public/sw.js',import.meta.url),'utf8');
function setup(){
  const listeners=new Map<string,(event:any)=>void>(),notifications:any[]=[],badges:number[]=[],stored=new Map<string,Response>();
  const client={url:'https://mobile.tinygpt.org/app/',navigate:vi.fn(async()=>{}),focus:vi.fn(async()=>{}),postMessage:vi.fn()};
  const registration={getNotifications:async()=>notifications.filter(item=>!item.closed),showNotification:vi.fn(async(title,options)=>{const old=notifications.find(item=>item.tag===options.tag);if(old)old.closed=true;notifications.push({title,...options,closed:false,close(){this.closed=true;}});}),pushManager:{permissionState:vi.fn(async()=>'granted'),subscribe:vi.fn(async()=>({toJSON:()=>({endpoint:'rotated'})}))}};
  const fetcher=vi.fn(async(url:string)=>url==='/api/push/config'?Response.json({enabled:true,publicKey:'BAAA'}):Response.json({ok:true}));
  const self={location:{origin:'https://mobile.tinygpt.org'},registration,navigator:{setAppBadge:async(count:number)=>{badges.push(count);},clearAppBadge:async()=>{badges.push(0);}},clients:{matchAll:async()=>[client],openWindow:vi.fn(async()=>{})},skipWaiting:()=>{},addEventListener:(name:string,handler:(event:any)=>void)=>listeners.set(name,handler)};
  const caches={open:async()=>({put:async(key:string,value:Response)=>{stored.set(key,value);},match:async(key:string)=>stored.get(key)?.clone()})};
  runInNewContext(script,{self,caches,URL,URLSearchParams,Response,Uint8Array,atob,AbortSignal,Date,fetch:fetcher});
  const dispatch=async(name:string,event:Record<string,unknown>)=>{let pending:Promise<unknown>|undefined;listeners.get(name)!({...event,waitUntil:(value:Promise<unknown>)=>{pending=value;}});await pending;};
  return {dispatch,registration,notifications,badges,client,self,fetcher,stored};
}
function payload(){const desktop='a'.repeat(64),conversationId=randomUUID(),eventId=randomUUID(),navigate='https://mobile.tinygpt.org/app/#'+new URLSearchParams({desktop,conversation:conversationId,notification:eventId});return {notification:{title:'Approval needed',body:'Studio PC · Review a request to continue.',tag:'tinygpt:'+desktop+':'+conversationId,navigate,data:{desktop,conversationId,eventId,navigate}}};}
describe('mobile service-worker notifications',()=>{
  it('shows a visible notification while no page is open and keeps retries from duplicating its badge',async()=>{
    const f=setup(),message=payload();await f.dispatch('push',{data:{json:()=>message}});expect(f.registration.showNotification).toHaveBeenCalledTimes(1);expect(f.badges.at(-1)).toBe(1);
    await f.dispatch('push',{data:{json:()=>message}});expect(f.badges.at(-1)).toBe(1);expect(f.notifications.at(-1).renotify).toBe(false);
  });
  it('opens the exact computer and chat without accepting external navigation',async()=>{
    const f=setup(),message=payload();await f.dispatch('push',{data:{json:()=>message}});await f.dispatch('notificationclick',{notification:f.notifications[0]});expect(f.client.navigate).toHaveBeenCalledExactlyOnceWith(message.notification.navigate);expect(f.client.focus).toHaveBeenCalledTimes(1);expect(f.badges.at(-1)).toBe(0);
    await f.dispatch('notificationclick',{notification:{data:{navigate:'https://attacker.example/'},close(){}}});expect(f.client.navigate).toHaveBeenLastCalledWith('https://mobile.tinygpt.org/app/');
  });
  it('clears the viewed chat only and updates the badge',async()=>{
    const f=setup(),first=payload(),second=payload();await f.dispatch('push',{data:{json:()=>first}});await f.dispatch('push',{data:{json:()=>second}});expect(f.badges.at(-1)).toBe(2);await f.dispatch('message',{data:{type:'conversation-open',desktop:first.notification.data.desktop,conversationId:first.notification.data.conversationId}});expect(f.badges.at(-1)).toBe(1);
  });
  it('renews subscriptions for every paired computer and respects opt-out',async()=>{
    const f=setup(),desktops=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)],settings={type:'push-settings',enabled:true,clientId:randomUUID(),preferences:{completed:true,attention:true},desktops};await f.dispatch('message',{data:settings});await f.dispatch('pushsubscriptionchange',{});expect(f.fetcher.mock.calls.filter(([url])=>url.includes('/api/d/'))).toHaveLength(3);
    await f.dispatch('message',{data:{...settings,enabled:false}});f.fetcher.mockClear();await f.dispatch('pushsubscriptionchange',{});expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('still displays a safe generic notification if an old push has no payload',async()=>{const f=setup();await f.dispatch('push',{});expect(f.notifications[0].title).toBe('TinyGPT needs your attention');});
});
