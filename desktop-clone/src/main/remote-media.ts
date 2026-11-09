import type { RemoteMediaRequest,RemoteUpload,ToolImagePreview } from '../shared/remote-media';
import type { VoicePeer } from './remote-voice';
type Actions = { importFile(conversationId:string,name:string,bytes:Buffer):Promise<RemoteUpload>; remove(conversationId:string,sourceId:string):void; preview(conversationId:string,toolId:string):ToolImagePreview; attachmentPreview?(conversationId:string,sourceId:string,full:boolean):ToolImagePreview; presentation?(conversationId:string,toolId:string):ReturnType<typeof import('../core/remote-presentation').remotePresentation> };
type Upload = VoicePeer & { id:string; name:string; size:number; received:number; sequence:number; chunks:Buffer[]; cancelled:boolean; finishing:boolean; timer:ReturnType<typeof setTimeout> };
export class RemoteMediaBridge {
  private uploads = new Map<string,Upload>();
  private completed = new Map<string,{conversationId:string;value:RemoteUpload;expires:number}>();
  constructor(private actions:Actions) {}
  private key(auth:VoicePeer,id:string) { return auth.deviceId + ':' + id; }
  private drop(key:string) { const job=this.uploads.get(key); if(job){job.cancelled=true;job.chunks=[];clearTimeout(job.timer);this.uploads.delete(key);} }
  async handle(auth:VoicePeer,request:RemoteMediaRequest):Promise<unknown> {
    const key=this.key(auth,request.jobId);
    for(const [id,item] of this.completed) if(item.expires<Date.now())this.completed.delete(id);
    const done=this.completed.get(key);
    if(request.op==='tool-image')return this.actions.preview(auth.conversationId,request.toolId);
    if(request.op==='tool-ui'){if(!this.actions.presentation)throw Error('Interface sharing is unavailable.');return this.actions.presentation(auth.conversationId,request.toolId);}
    if(request.op==='attachment-image'){if(!this.actions.attachmentPreview)throw Error('Image preview unavailable.');return this.actions.attachmentPreview(auth.conversationId,request.sourceId,request.size==='full');}
    if(request.op==='remove-upload'){this.actions.remove(auth.conversationId,request.sourceId);return null;}
    if(request.op==='upload-cancel'){const active=this.uploads.get(key);if(active&&(active.conversationId!==auth.conversationId||active.connectionId!==auth.connectionId))throw Error('Upload unavailable.');this.drop(key);if(done&&done.conversationId===auth.conversationId){this.actions.remove(auth.conversationId,done.value.sourceId);this.completed.delete(key);}return null;}
    if(done&&done.conversationId===auth.conversationId)return done.value;
    if(request.op==='upload-start') {
      const active=this.uploads.get(key);if(active&&(active.conversationId!==auth.conversationId||active.connectionId!==auth.connectionId||active.finishing))throw Error('Upload is already in progress. Try again.');
      this.drop(key);
      const allocated=[...this.uploads.values()].reduce((sum,job)=>sum+job.size,0);
      if(this.uploads.size>=8||allocated+request.bytes>32*1024*1024)throw Error('Too many uploads. Try again shortly.');
      const timer=setTimeout(()=>this.drop(key),120000);timer.unref?.();
      this.uploads.set(key,{...auth,id:request.jobId,name:request.name,size:request.bytes,received:0,sequence:0,chunks:[],cancelled:false,finishing:false,timer});return {ready:true};
    }
    const job=this.uploads.get(key);
    if(!job||job.connectionId!==auth.connectionId||job.conversationId!==auth.conversationId||job.finishing)throw Error('Upload interrupted. Try again.');
    clearTimeout(job.timer);job.timer=setTimeout(()=>this.drop(key),120000);job.timer.unref?.();
    if(request.op==='upload-chunk'){
      const bytes=Buffer.from(request.data,'base64');
      if(request.sequence!==job.sequence||!bytes.length||bytes.length>49152||job.received+bytes.length>job.size){this.drop(key);throw Error('Upload interrupted. Try again.');}
      job.received+=bytes.length;job.sequence++;job.chunks.push(bytes);return null;
    }
    if(job.received!==job.size){this.drop(key);throw Error('Upload interrupted. Try again.');}
    job.finishing=true;
    try {
      const bytes=Buffer.concat(job.chunks);job.chunks=[];
      const value=await this.actions.importFile(auth.conversationId,job.name,bytes);
      if(job.cancelled){try{this.actions.remove(auth.conversationId,value.sourceId);}catch{}throw Error('Upload cancelled.');}
      if(this.completed.size>=128)this.completed.delete(this.completed.keys().next().value!);
      this.completed.set(key,{conversationId:auth.conversationId,value,expires:Date.now()+300000});return value;
    } finally {if(this.uploads.get(key)===job)this.drop(key);}
  }
  closePeer(connectionId:string){for(const [key,job]of this.uploads)if(job.connectionId===connectionId)this.drop(key);}
  cancelDevice(deviceId:string){for(const [key,job]of this.uploads)if(job.deviceId===deviceId)this.drop(key);for(const key of this.completed.keys())if(key.startsWith(deviceId+':'))this.completed.delete(key);}
  close(){for(const key of this.uploads.keys())this.drop(key);}
}
