import { buildPushPayload } from '@block65/webcrypto-web-push';
import { pushDescription,pushTarget,pushRegistrationSchema,pushPolicySchema,pushSubscriptionSchema,type RemotePushEvent,type PushPreferences } from '../../src/shared/remote-push';
import type { z } from 'zod';

export interface PushEnv { VAPID_PUBLIC_KEY?:string;VAPID_PRIVATE_KEY?:string;VAPID_SUBJECT?:string }
export interface PushDevice {id:string;grantId:string;conversationId:string;expiresAt:number}
interface KV {get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>}
interface Storage extends KV {transaction<T>(callback:(tx:KV)=>Promise<T>):Promise<T>;setAlarm(when:number):Promise<void>}
type Registration={id:string;deviceId:string;clientId:string;origin:string;desktop:string;subscription:z.infer<typeof pushSubscriptionSchema>;preferences:PushPreferences};
type Job={id:string;registrationId:string;deviceId:string;event:RemotePushEvent;attempt:number;nextAt:number;expiresAt:number};
type Policy=z.infer<typeof pushPolicySchema>;
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
export const pushConfigured=(env:PushEnv)=>!!env.VAPID_PRIVATE_KEY&&/^B[A-Za-z0-9_-]{86}$/.test(env.VAPID_PUBLIC_KEY??'')&&/^(?:https:\/\/|mailto:)/.test(env.VAPID_SUBJECT??'');

/** Only subscriptions, opaque chat IDs and short-lived event metadata are stored. */
export class PushDelivery {
  constructor(private storage:Storage,private env:PushEnv,private devices:()=>Promise<PushDevice[]>){ }
  async policy(value:unknown){const parsed=pushPolicySchema.safeParse(value);if(!parsed.success)return;await this.storage.transaction(async tx=>{await tx.put('push-policy',parsed.data);if(!parsed.data.enabled)await tx.put('push-jobs',[]);});}
  async register(device:PushDevice,desktop:string,origin:string,value:unknown){
    const parsed=pushRegistrationSchema.safeParse(value);if(!parsed.success)throw Error('Invalid notification request.');const request=parsed.data;
    if(request.op==='remove'){await this.remove(device.id,request.clientId);return;}
    if(!pushConfigured(this.env))throw Error('Notifications are not available yet.');
    if(request.op==='test'){
      const registration=(await this.storage.get<Registration[]>('push-subscriptions')??[]).find(item=>item.deviceId===device.id&&item.clientId===request.clientId);
      if(!registration)throw Error('Enable notifications on this phone first.');
      const event:RemotePushEvent={id:crypto.randomUUID(),conversationId:device.conversationId,sequence:0,createdAt:Date.now(),mode:'chat',kind:'completed'};
      const result=await this.send(registration,event,true);await result.body?.cancel();if(result.status===404||result.status===410)await this.remove(device.id,request.clientId);if(!result.ok)throw Error('This phone could not be reached. Try enabling notifications again.');return {eventId:event.id};
    }
    const key=Uint8Array.from(atob(request.subscription.keys.p256dh.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
    await crypto.subtle.importKey('raw',key,{name:'ECDH',namedCurve:'P-256'},false,[]);
    if(request.subscription.expirationTime&&request.subscription.expirationTime<Date.now())throw Error('This notification subscription expired. Enable it again.');
    const id=await digest(request.subscription.endpoint),live=new Set((await this.devices()).filter(item=>item.expiresAt>Date.now()).map(item=>item.id));
    await this.storage.transaction(async tx=>{
      const records=(await tx.get<Registration[]>('push-subscriptions')??[]).filter(item=>live.has(item.deviceId)&&item.id!==id&&!(item.deviceId===device.id&&item.clientId===request.clientId));
      if(records.length>=60||records.filter(item=>item.deviceId===device.id).length>=3)throw Error('Too many notification installations for this device.');
      await tx.put('push-subscriptions',[...records,{id,deviceId:device.id,clientId:request.clientId,desktop,origin,subscription:request.subscription,preferences:request.preferences}]);
    });
  }
  async remove(deviceId:string,clientId?:string){await this.storage.transaction(async tx=>{
    const records=await tx.get<Registration[]>('push-subscriptions')??[],removed=new Set(records.filter(item=>item.deviceId===deviceId&&(!clientId||item.clientId===clientId)).map(item=>item.id));
    await tx.put('push-subscriptions',records.filter(item=>!removed.has(item.id)));
    await tx.put('push-jobs',(await tx.get<Job[]>('push-jobs')??[]).filter(job=>!removed.has(job.registrationId)));
  });}
  private allowed(policy:Policy|undefined,device:PushDevice|undefined,event:RemotePushEvent){const grant=policy?.grants.find(item=>item.id===device?.grantId);return !!policy?.enabled&&!!device&&device.expiresAt>Date.now()&&!!grant&&(grant.scope==='library'||grant.conversationId===event.conversationId);}
  async enqueue(event:RemotePushEvent){
    if(event.createdAt<Date.now()-1800000||event.createdAt>Date.now()+60000)return;
    const devices=await this.devices();
    await this.storage.transaction(async tx=>{
      const seen=await tx.get<Record<string,number>>('push-seen')??{};if(seen[event.id])return;
      for(const [id,time]of Object.entries(seen))if(time<Date.now()-86400000)delete seen[id];
      while(Object.keys(seen).length>=1000)delete seen[Object.keys(seen)[0]];seen[event.id]=Date.now();
      const policy=await tx.get<Policy>('push-policy'),records=await tx.get<Registration[]>('push-subscriptions')??[];
      const latest=await tx.get<Record<string,{at:number;sequence:number}>>('push-latest')??{},prior=latest[event.conversationId];
      if(prior&&(prior.at>event.createdAt||prior.at===event.createdAt&&prior.sequence>=event.sequence))return;
      if(Object.keys(latest).length>=300)delete latest[Object.keys(latest)[0]];latest[event.conversationId]={at:event.createdAt,sequence:event.sequence};
      const jobs=(await tx.get<Job[]>('push-jobs')??[]).filter(job=>job.expiresAt>Date.now()&&job.event.conversationId!==event.conversationId);
      for(const record of records){if(!this.allowed(policy,devices.find(device=>device.id===record.deviceId),event)||!record.preferences[event.kind==='completed'?'completed':'attention'])continue;jobs.push({id:event.id+':'+record.id,registrationId:record.id,deviceId:record.deviceId,event,attempt:0,nextAt:Date.now(),expiresAt:event.createdAt+1800000});}
      await tx.put('push-seen',seen);await tx.put('push-latest',latest);await tx.put('push-jobs',jobs.slice(-200));
    });
    await this.schedule();
  }
  private async schedule(){const jobs=await this.storage.get<Job[]>('push-jobs')??[];if(jobs.length)await this.storage.setAlarm(Math.max(Date.now()+100,Math.min(...jobs.map(job=>job.nextAt))));}
  private async send(record:Registration,event:RemotePushEvent,test=false){
    const computer=await this.storage.get<string>('computer-name')??'Your computer',description=test?{title:'Notifications are on',body:computer+' · You’re all set.'}:pushDescription(event,computer);
    const navigate=pushTarget(record.origin,record.desktop,event),tag='tinygpt:'+record.desktop+':'+event.conversationId;
    const data={web_push:8030,notification:{...description,navigate,tag,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',timestamp:event.createdAt,app_badge:'1',data:{desktop:record.desktop,conversationId:event.conversationId,eventId:event.id,navigate}}};
    const payload=await buildPushPayload({data:JSON.stringify(data),options:{ttl:1800,urgency:event.kind==='completed'?'normal':'high',topic:(await digest(tag)).slice(0,32)}},{...record.subscription,expirationTime:record.subscription.expirationTime??null},{publicKey:this.env.VAPID_PUBLIC_KEY!,privateKey:this.env.VAPID_PRIVATE_KEY!,subject:this.env.VAPID_SUBJECT!});
    return fetch(record.subscription.endpoint,{...payload,body:payload.body as Uint8Array<ArrayBuffer>,redirect:'error',signal:AbortSignal.timeout(10000)});
  }
  async alarm(){
    const jobs=await this.storage.get<Job[]>('push-jobs')??[];
    const due=jobs.filter(job=>job.nextAt<=Date.now()).slice(0,8);
    for(const job of due){
      const [currentJobs,currentRecords,currentPolicy,currentDevices]=await Promise.all([this.storage.get<Job[]>('push-jobs'),this.storage.get<Registration[]>('push-subscriptions'),this.storage.get<Policy>('push-policy'),this.devices()]);
      if(!currentJobs?.some(item=>item.id===job.id))continue;
      const record=currentRecords?.find(item=>item.id===job.registrationId);let remove=!record||!record.preferences[job.event.kind==='completed'?'completed':'attention']||job.expiresAt<=Date.now()||!this.allowed(currentPolicy,currentDevices.find(device=>device.id===job.deviceId),job.event),gone=false,retryAfter=0;
      if(!remove)try{const response=await this.send(record!,job.event);gone=[404,410].includes(response.status);remove=response.ok||gone;retryAfter=Math.min(300000,Math.max(0,Number(response.headers.get('Retry-After'))*1000||0));await response.body?.cancel();}catch{}
      await this.storage.transaction(async tx=>{
        let pending=await tx.get<Job[]>('push-jobs')??[];const current=pending.find(item=>item.id===job.id);if(!current)return;
        if(remove||current.attempt>=4)pending=pending.filter(item=>item.id!==job.id);else{current.attempt++;current.nextAt=Date.now()+Math.max(retryAfter,[30000,120000,300000,600000][Math.min(current.attempt-1,3)]);}
        if(gone){await tx.put('push-subscriptions',(await tx.get<Registration[]>('push-subscriptions')??[]).filter(item=>item.id!==job.registrationId));pending=pending.filter(item=>item.registrationId!==job.registrationId);}
        await tx.put('push-jobs',pending);
      });
    }
    await this.schedule();
  }
}
