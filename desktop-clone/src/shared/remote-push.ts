import { z } from 'zod';
import type { ActivityNotification } from './notifications';

export const pushEventSchema=z.object({id:z.uuid(),conversationId:z.uuid(),sequence:z.number().int().nonnegative(),createdAt:z.number().int().positive(),kind:z.enum(['completed','failed','approval','question','attention']),mode:z.enum(['chat','code','bot'])}).strict();
export type RemotePushEvent=z.infer<typeof pushEventSchema>;
export const pushPreferencesSchema=z.object({completed:z.boolean(),attention:z.boolean()}).strict();
export type PushPreferences=z.infer<typeof pushPreferencesSchema>;
export const defaultPushPreferences:PushPreferences={completed:true,attention:true};
export function pushEndpoint(value:string):boolean{
  try{const url=new URL(value);const host=['web.push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com'].includes(url.hostname)||url.hostname.endsWith('.notify.windows.com');return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443')&&host;}catch{return false;}
}
export const pushSubscriptionSchema=z.object({endpoint:z.string().max(2048).refine(pushEndpoint),expirationTime:z.number().nullable().optional(),keys:z.object({p256dh:z.string().regex(/^B[A-Za-z0-9_-]{86}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{22}$/)}).strict()}).strict();
export const pushRegistrationSchema=z.discriminatedUnion('op',[
  z.object({op:z.literal('subscribe'),clientId:z.uuid(),subscription:pushSubscriptionSchema,preferences:pushPreferencesSchema}).strict(),
  z.object({op:z.literal('remove'),clientId:z.uuid()}).strict(),
  z.object({op:z.literal('test'),clientId:z.uuid()}).strict(),
]);
export const pushPolicySchema=z.object({enabled:z.boolean(),grants:z.array(z.object({id:z.uuid(),conversationId:z.uuid(),scope:z.enum(['conversation','library'])}).strict()).max(200)}).strict();
export function remotePushEvent(entry:ActivityNotification):RemotePushEvent|null{
  return pushEventSchema.parse({id:entry.id,conversationId:entry.conversationId,sequence:entry.sequence,createdAt:entry.createdAt,mode:entry.mode,kind:entry.kind==='attention'?(entry.title==='Approval needed'?'approval':entry.title==='Work has a question'?'question':'attention'):entry.kind});
}
export function pushTarget(origin:string,desktop:string,event:Pick<RemotePushEvent,'id'|'conversationId'>){return origin+'/app/#'+new URLSearchParams({desktop,conversation:event.conversationId,notification:event.id});}
export function pushDescription(event:RemotePushEvent,computer:string){
  const title=event.kind==='completed'?(event.mode==='bot'?'Bot message':event.mode==='code'?'Work finished':'Reply ready'):event.kind==='approval'?'Approval needed':event.kind==='question'?'TinyGPT has a question':'TinyGPT needs your attention';
  const body=event.kind==='completed'?'Your reply is ready.':event.kind==='approval'?'Review a request to continue.':event.kind==='question'?'Answer a question to continue.':event.kind==='failed'?'Open the chat to review what happened.':'Open the chat to continue.';
  return {title,body:computer+' · '+body};
}
