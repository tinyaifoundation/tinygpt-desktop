import { EventEmitter } from 'node:events';
import type { DictationOwner, MoonshineDictation } from './moonshine-dictation';
import type { SpeechService } from './speech-service';
import type { DictationEvent } from '../shared/dictation';
import { pocketConnection, type SpeechSelection, type SpeechAudio } from '../shared/voice';
import type { RemoteVoiceRequest, RemoteVoiceCapabilities } from '../shared/remote-voice';

type Preferences = { dictation: { enabled: boolean }; readAloud: { enabled: boolean; speed: number; selection?: SpeechSelection } };
export type VoicePeer = { deviceId: string; connectionId: string; conversationId: string };
class RemoteOwner extends EventEmitter implements DictationOwner {
  destroyed = false;
  constructor(readonly id: number, private emitEvent: (event: DictationEvent) => void) { super(); }
  isDestroyed() { return this.destroyed; }
  send(_channel: string, event: DictationEvent) { if (!this.destroyed) this.emitEvent(event); }
  destroy() { this.destroyed = true; this.emit('destroyed'); this.removeAllListeners(); }
}
type Session = VoicePeer & { owner: RemoteOwner; timer?: ReturnType<typeof setTimeout>; dictation?: { id: string; next: number; bytes: number; rate: number }; speechId?: string; speechBusy?: boolean };

/** Ephemeral device-owned sessions; audio and transcripts never enter receipts or storage. */
export class RemoteVoiceBridge {
  private peers = new Map<string,Session>();
  private nextOwner = -1;
  private send: (value: unknown) => void = () => {};
  constructor(private dictation: Pick<MoonshineDictation,'start'|'audio'|'stop'>, private speech: Pick<SpeechService,'read'|'nextStream'|'cancel'|'cancelOwner'> & Partial<Pick<SpeechService,'preview'>>, private preferences: () => Preferences) {}
  setSender(send: (value: unknown) => void) { this.send = send; }
  capabilities(): RemoteVoiceCapabilities {
    const preferences = this.preferences();
    return { dictation: preferences.dictation.enabled, readAloud: preferences.readAloud.enabled && preferences.readAloud.selection?.connectionId === pocketConnection, speed: preferences.readAloud.speed };
  }
  private session(auth: VoicePeer) {
    let peer = this.peers.get(auth.connectionId);
    if (peer && (peer.deviceId !== auth.deviceId || peer.conversationId !== auth.conversationId)) { this.closePeer(auth.connectionId); peer = undefined; }
    if (!peer) {
      if (this.peers.size >= 60) throw Error('Voice session limit reached.');
      const owner = new RemoteOwner(this.nextOwner--, event => { this.send({ type: 'voice-event', deviceId: auth.deviceId, connectionId: auth.connectionId, event }); if (event.phase === 'error' || event.phase === 'stopped') { const current = this.peers.get(auth.connectionId); if (current?.dictation?.id === event.id) current.dictation = undefined; } });
      peer = { ...auth, owner }; this.peers.set(auth.connectionId,peer);
    }
    clearTimeout(peer.timer); peer.timer = setTimeout(() => this.closePeer(auth.connectionId),120000); peer.timer.unref?.();
    return peer;
  }
  async handle(auth: VoicePeer, request: RemoteVoiceRequest): Promise<unknown> {
    const peer = this.session(auth), capabilities = this.capabilities();
    if (request.op === 'dictation-start') {
      if (!capabilities.dictation) throw Error('Enable dictation on your computer.');
      if (peer.dictation) throw Error('Dictation is already active.');
      peer.dictation = { id: request.jobId, next: 0, bytes: 0, rate: request.sampleRate };
      try { await this.dictation.start(request.jobId,request.sampleRate,peer.owner); }
      catch (error) { peer.dictation = undefined; throw error; }
    } else if (request.op === 'dictation-audio') {
      const session = peer.dictation, audio = Buffer.from(request.audio,'base64');
      if (!capabilities.dictation || !session || session.id !== request.jobId || session.next !== request.sequence || !audio.length || audio.length % 2 || audio.length > 32768 || (session.bytes += audio.length) > session.rate * 2 * 600) throw Error('Dictation session expired.');
      session.next++; this.dictation.audio(request.jobId,peer.owner,audio);
    } else if (request.op === 'dictation-stop') {
      if (peer.dictation?.id !== request.jobId) throw Error('Dictation session expired.');
      try { await this.dictation.stop(request.jobId,peer.owner,request.cancel); } finally { peer.dictation = undefined; }
    } else if (request.op === 'speech-cancel') {
      this.speech.cancel(request.jobId,peer.owner.id); if (peer.speechId === request.jobId) peer.speechId = undefined;
    } else {
      if (!capabilities.readAloud || peer.speechBusy) throw Error('Local read aloud is unavailable.');
      if (request.op === 'speech-next' && peer.speechId !== request.jobId) throw Error('Read aloud session expired.');
      peer.speechBusy = true;
      try {
        if (request.op === 'speech-read'||request.op==='speech-preview') peer.speechId = request.jobId;
        if(request.op==='speech-preview'&&!this.speech.preview)throw Error('Voice preview unavailable.');
        const audio: SpeechAudio = request.op === 'speech-preview'?await this.speech.preview!(request.jobId,peer.owner.id):request.op === 'speech-read' ? await this.speech.read({ conversationId: auth.conversationId, messageId: request.messageId, jobId: request.jobId, chunk: request.chunk },peer.owner.id) : await this.speech.nextStream(request.jobId,peer.owner.id,request.sequence);
        if (peer.owner.destroyed || peer.speechId !== request.jobId || audio.audio.byteLength > 262144) throw Error('Read aloud stopped.');
        return { ...audio, audio: Buffer.from(audio.audio).toString('base64') };
      } catch (error) { this.speech.cancel(request.jobId,peer.owner.id); throw error; }
      finally { peer.speechBusy = false; }
    }
    if (peer.owner.destroyed) throw Error('Voice session ended.');
    return null;
  }
  closePeer(connectionId: string) {
    const peer = this.peers.get(connectionId); if (!peer) return;
    this.peers.delete(connectionId); clearTimeout(peer.timer);
    this.send({ type: 'voice-event', deviceId: peer.deviceId, connectionId, event: { id: peer.dictation?.id ?? '', phase: 'error', error: 'Voice connection ended. Your text is kept.' } });
    peer.owner.destroy(); this.speech.cancelOwner(peer.owner.id);
  }
  cancelDevice(deviceId: string) { for (const [id,peer] of this.peers) if (peer.deviceId === deviceId) this.closePeer(id); }
  close() { for (const id of [...this.peers.keys()]) this.closePeer(id); }
}
