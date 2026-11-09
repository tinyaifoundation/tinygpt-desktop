import { remoteManagementStateSchema,type RemoteManagementRequest,type RemoteManagementState } from '../shared/remote-management';
export interface RemoteManagementActions {
 state():Promise<RemoteManagementState>;
 change(command:Exclude<RemoteManagementRequest,{op:'state'}>,authorized:()=>void):Promise<Partial<RemoteManagementState>>;
}
/** This channel carries only explicit, non-replayed, allowlisted requests. */
export class RemoteManagement {
 private reads=0;
 private busy=false;
 private completed=new Map<string,{fingerprint:string;expires:number}>();
 constructor(private actions:RemoteManagementActions){}
 async handle(deviceId:string,command:RemoteManagementRequest,authorized:()=>void){
  authorized();const key=deviceId+':'+command.id,fingerprint=JSON.stringify(command),old=this.completed.get(key);
  if(old&&old.fingerprint!==fingerprint)throw Error('This request ID has already been used.');
  const changing=!['state','project-open','memory-open'].includes(command.op);
  if(this.reads>=8||changing&&this.busy)throw Error('Another change is being saved. Try again.');
  if(changing)this.busy=true;else this.reads++;
  try{
   let extra:Partial<RemoteManagementState>={};
   if(command.op!=='state'){
    if(old&&changing)throw Error('This change was already handled. Refresh to check its result.');
    if(changing){for(const [id,item]of this.completed)if(item.expires<Date.now())this.completed.delete(id);if(this.completed.size>=512)this.completed.delete(this.completed.keys().next().value!);this.completed.set(key,{fingerprint,expires:Date.now()+300000});}
    extra=await this.actions.change(command,authorized);
   }
   authorized();const value=remoteManagementStateSchema.parse({...await this.actions.state(),...extra});authorized();
   if(new TextEncoder().encode(JSON.stringify(value)).length>700000)throw Error('Too much data to show. Manage the library on your computer.');
   return value;
  }finally{if(changing)this.busy=false;else this.reads--;}
 }
}
