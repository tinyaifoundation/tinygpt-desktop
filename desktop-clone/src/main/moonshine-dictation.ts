import {Speech} from './moonshine-speech';
import type {DictationPreferences} from '../shared/voice';
import type {DictationEvent} from '../shared/dictation';
export interface DictationOwner {
  isDestroyed(): boolean;
  send(channel: string, event: DictationEvent): void;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

/** Keeps the existing composer's PCM16 protocol and UI; only its local ASR engine changes. */
export class MoonshineDictation {
  private speech:Speech;
  private idle?:ReturnType<typeof setTimeout>;
  private session?:{id:string;owner:DictationOwner;rate:number;destroy?:()=>void;stop?:()=>void;timer?:ReturnType<typeof setTimeout>};
  constructor(root:string,private preferences:()=>DictationPreferences,private keepLoaded:()=>boolean=()=>false){this.speech=new Speech(root,e=>{
    const s=this.session;if(!s||e.id&&e.id!==s.id)return;
    if(e.type==='text')this.emit('listening',e.text);
    if(e.type==='final'){this.emit('finishing',e.text);this.emit('stopped');s.stop?.();this.release();}
    if(e.type==='error'){this.emit('error',undefined,e.message);s.stop?.();this.release();}
  });}
  private emit(phase:DictationEvent['phase'],text?:string,error?:string){const s=this.session;if(s&&!s.owner.isDestroyed())s.owner.send('tinygpt:dictation-event',{id:s.id,phase,text,error});}
  isActive(){return !!this.session;}
  async start(id:string,rate:number,owner:DictationOwner){
    if(!this.preferences().enabled)throw Error('Enable transcription in Voice settings first.');if(this.session)throw Error('Dictation is already active in another composer.');
    clearTimeout(this.idle);
    this.session={id,owner,rate};const s=this.session;s.destroy=()=>{if(this.session===s)this.release();};owner.once('destroyed',s.destroy);this.emit('loading');
    try{await this.speech.warm();if(this.session!==s)return;await this.speech.start(id);if(this.session===s)this.emit('listening');}catch(e){if(this.session===s){this.emit('error',undefined,'Speech to text could not load. Check the bundled voice runtime.');this.release();}throw e;}
  }
  audio(id:string,owner:DictationOwner,bytes:Uint8Array){const s=this.owned(id,owner);const buffer=Buffer.from(bytes);const values=new Float32Array(buffer.length/2);for(let i=0;i<values.length;i++)values[i]=buffer.readInt16LE(i*2)/32768;this.speech.audio(id,values,s.rate);}
  private owned(id:string,owner:DictationOwner){if(!this.session||this.session.id!==id||this.session.owner!==owner)throw Error('Dictation session is no longer active.');return this.session;}
  async stop(id:string,owner:DictationOwner,cancel:boolean){const s=this.owned(id,owner);if(cancel){this.release();return;}this.emit('finishing');await new Promise<void>(resolve=>{s.stop=resolve;s.timer=setTimeout(()=>{if(this.session===s){this.emit('error',undefined,'Dictation took too long to finish. Your current text is kept.');this.release();}resolve();},15000);this.speech.stop(id);});}
  private release(){const s=this.session;this.session=undefined;if(s){if(s.destroy)s.owner.removeListener('destroyed',s.destroy);clearTimeout(s.timer);s.stop?.();this.speech.cancel();this.scheduleIdle();}}
  private scheduleIdle(){clearTimeout(this.idle);this.idle=setTimeout(()=>{if(this.keepLoaded())this.scheduleIdle();else this.speech.close();},180000);this.idle.unref();}
  close(){this.release();clearTimeout(this.idle);this.speech.close();}
}
