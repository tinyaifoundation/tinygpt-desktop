import { RemoteCipher, REMOTE_TRANSPORT, type SecureRoute } from '../../shared/remote-crypto';
import { pairingKey, loadPrivateRecovery, savePrivateRecovery } from './mobile-keys';
import { remoteInferenceStateSchema, type RemoteInferenceState, type RemoteInferenceRequest } from '../../shared/remote-inference';
import {remoteManagementStateSchema,type RemoteManagementRequest,type RemoteManagementState} from '../../shared/remote-management';
import type { RemoteMediaRequest } from '../../shared/remote-media';
import { ChatUpdateDecoder, type ChatPacket } from '../../core/chat-updates';
import type { ChatUpdate } from '../../shared/chat';
import type { RemoteCommand, RemoteAppearance } from '../../shared/remote';
import { remoteCommandSchema, remoteAppearanceSchema, REMOTE_DRAFT_ID } from '../../shared/remote';
import { applyMobileAppearance, readMobileTheme, saveMobileTheme, type MobileTheme } from './mobile-appearance';
import { noRemoteVoice, remoteVoiceCapabilitiesSchema, type RemoteVoiceCapabilities, type RemoteVoiceRequest } from '../../shared/remote-voice';
import type { DictationEvent } from '../../shared/dictation';
type Pending = { command: RemoteCommand; resolve: () => void; reject: (error: Error) => void; acknowledged?: string };
const recoveryLoads = new Map<string, Promise<unknown[]>>();
function restoredCommands(desktop: string): Promise<unknown[]> {
  const current = recoveryLoads.get(desktop); if (current) return current;
  const promise = (async () => {
    let saved = await loadPrivateRecovery(desktop);
    const legacy = sessionStorage.getItem('tinygpt-pending:' + desktop); sessionStorage.removeItem('tinygpt-pending:' + desktop);
    if (legacy) { const value: unknown = JSON.parse(legacy); if (!saved.length && Array.isArray(value)) saved = value; const validated = saved.slice(0, 8).flatMap(item => { const value = remoteCommandSchema.safeParse(item); return value.success && value.data.op !== 'get' ? [value.data] : []; }); await savePrivateRecovery(desktop, validated); }
    return saved;
  })(); recoveryLoads.set(desktop, promise);
  void promise.finally(() => { if (recoveryLoads.get(desktop) === promise) recoveryLoads.delete(desktop); }).catch(() => {}); return promise;
}
type View = { value: ChatUpdate; attention: boolean; scope: 'conversation' | 'library'; computerName?: string; voice: RemoteVoiceCapabilities; media:boolean; inference?:RemoteInferenceState };
export type RemoteConnection = 'connecting' | 'online' | 'offline' | 'revoked';
export class RemoteClient {
  private socket?: WebSocket;
  private cipher?: RemoteCipher;
  private secureRoute?: SecureRoute;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private attempt = 0;
  private heardAt = 0;
  private closed = false;
  private decoder = new ChatUpdateDecoder();
  private pending = new Map<string,Pending>();
  private navigation?: { id: string; previous?: string };
  private views = new Map<string,View>();
  private displayed?: View;
  private selectionRequest?:{id:string;target?:string};
  private repairedAt = -Infinity;
  private online = false;
  private selected?: string;
  private restoration?: Promise<void>;
  private recoveryWrites: Promise<void> = Promise.resolve();
  private generation = 0;
  private appearance?: RemoteAppearance;
  private appearanceSignature?: string;
  private theme = readMobileTheme();
  private voicePending = new Map<string,{ resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private inferencePending = new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private managementPending=new Map<string,{resolve:(value:RemoteManagementState)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private mediaPending = new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private voiceListeners = new Set<(event: DictationEvent) => void>();
  constructor(private desktopId: string, private changed: (value: RemoteConnection) => void, private update: (value: ChatUpdate, attention: boolean, scope: 'conversation' | 'library', computerName?: string, voice?: RemoteVoiceCapabilities,media?:boolean,inference?:RemoteInferenceState) => void, private notice: (message: string) => void, fresh = false) { try { this.selected = fresh ? REMOTE_DRAFT_ID : sessionStorage.getItem('tinygpt-selected:' + desktopId) || undefined; } catch {} applyMobileAppearance(undefined, this.theme); }
  setTheme(theme: MobileTheme) { this.theme = theme; saveMobileTheme(theme); applyMobileAppearance(this.appearance, theme); }
  async connect() {
    await this.restore();
    if (this.closed) return;
    const generation = ++this.generation;
    clearTimeout(this.timer); clearInterval(this.heartbeat); clearTimeout(this.handshakeTimer); this.cipher?.destroy(); this.cipher = undefined;
    const previous = this.socket; this.socket = undefined; previous?.close(); this.interruptVoice(); this.online = false; this.changed('connecting'); this.decoder = new ChatUpdateDecoder(); this.views.clear();
    let keys: Awaited<ReturnType<typeof pairingKey>>;
    try { keys = await pairingKey(this.desktopId); if (!keys) { this.notice('Scan a new encrypted connection code on your computer.'); this.revoke(); return; } } catch { this.notice('Secure pairing storage is unavailable. Pair this device again.'); this.revoke(); return; }
    try {
      const response = await fetch(`/api/d/${this.desktopId}/session`, { signal: AbortSignal.timeout(10000) });
      if (this.closed || generation !== this.generation) return;
      if (response.status === 401) { this.revoke(); return; }
      if (!response.ok) throw Error('Unavailable');
    } catch { if (!this.closed && generation === this.generation) { this.changed('offline'); this.timer = setTimeout(() => void this.connect(), 5000); } return; }
    const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/d/${this.desktopId}/socket`, REMOTE_TRANSPORT); this.socket = socket;
    let lastPong = Date.now();
    const connecting = setTimeout(() => { if (socket.readyState !== WebSocket.OPEN) socket.close(); },15000);
    socket.onopen = () => {
      clearTimeout(connecting); if (this.socket !== socket || this.closed) { socket.close(); return; }
      this.attempt = 0;
      this.heartbeat = setInterval(() => { if (Date.now() - lastPong > 25000) socket.close(); else if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 10000);
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.closed) return;
      this.heardAt = Date.now();
      if (event.data === 'pong') { lastPong = Date.now(); return; }
      try {
        let message = JSON.parse(event.data);
        if (message.type === 'presence') {
          this.cipher?.destroy(); this.cipher = undefined; this.online = false; this.interruptVoice(); clearTimeout(this.handshakeTimer);
          if (!message.online) { this.changed('offline'); return; }
          if (message.deviceId !== keys!.deviceId || message.grantId !== keys!.grantId) throw Error('Pairing changed.');
          this.secureRoute = { desktopId: this.desktopId, deviceId: keys!.deviceId, grantId: keys!.grantId, connectionId: message.connectionId };
          this.cipher = new RemoteCipher(true, keys!.psk, this.secureRoute);
          this.changed('connecting'); socket.send(JSON.stringify({ type: 'handshake', data: this.cipher.start() }));
          this.handshakeTimer = setTimeout(() => socket.close(), 10000); return;
        }
        if (message.type === 'revoked') { this.revoke(); return; }
        if (message.type === 'handshake') {
          this.cipher?.handshakeMessage(message.data);
          if (!this.cipher?.ready) throw Error('Secure handshake failed.');
          clearTimeout(this.handshakeTimer); this.online = true; this.changed('online'); this.resend(); return;
        }
        if (message.type !== 'encrypted' || !this.cipher?.ready) throw Error('Unencrypted application content rejected.');
        message = this.cipher.open(message.data); if (message === undefined) return;
        if (!this.secureRoute || !message || message.deviceId !== this.secureRoute.deviceId || message.connectionId !== this.secureRoute.connectionId) throw Error('Wrong encrypted recipient.');
        if(message.type==='management-reply'){const pending=this.managementPending.get(message.requestId);if(pending){clearTimeout(pending.timer);this.managementPending.delete(message.requestId);if(!message.ok)pending.reject(Error(message.error||'Settings could not be loaded.'));else{const value=remoteManagementStateSchema.safeParse(message.value);value.success?pending.resolve(value.data):pending.reject(Error('Update TinyGPT on your computer to use these settings.'));}}return;}
        if (message.type === 'inference-reply') { const pending=this.inferencePending.get(message.requestId);if(pending){clearTimeout(pending.timer);this.inferencePending.delete(message.requestId);message.ok?pending.resolve(message.value):pending.reject(Error(message.error||'The model settings could not be updated.'));}return; }
        if(message.type==='media-reply'){const pending=this.mediaPending.get(message.requestId);if(pending){clearTimeout(pending.timer);this.mediaPending.delete(message.requestId);message.ok?pending.resolve(message.value):pending.reject(Error(message.error||'File request interrupted. Try again.'));}return;}
        if (message.type === 'voice-event') { for (const listener of this.voiceListeners) listener(message.event); return; }
        if (message.type === 'voice-reply') {
          const pending = this.voicePending.get(message.requestId);
          if (pending) { clearTimeout(pending.timer); this.voicePending.delete(message.requestId); if (message.ok) pending.resolve(message.value); else pending.reject(Error(message.error || 'Voice connection stopped.')); }
          else if (!message.ok && message.op === 'dictation-audio') for (const listener of this.voiceListeners) listener({ id: message.jobId, phase: 'error', error: message.error || 'Voice connection stopped.' });
          return;
        }
        if (message.type === 'revoked') { this.revoke(); return; }
        if (message.type === 'packet') {
          const appearance = remoteAppearanceSchema.safeParse(message.appearance);
          if (appearance.success) {
            const signature = JSON.stringify(appearance.data);
            if (signature !== this.appearanceSignature) { this.appearanceSignature = signature; this.appearance = appearance.data; applyMobileAppearance(appearance.data,this.theme); }
          }
          try {
            const value = this.decoder.decode(message.packet as ChatPacket);
            this.receive({ value,attention: !!message.attention,scope: message.scope === 'library' ? 'library' : 'conversation',computerName: typeof message.computerName === 'string' ? message.computerName.slice(0,120) : undefined,voice: remoteVoiceCapabilitiesSchema.safeParse(message.voice).data ?? noRemoteVoice,media:message.media===true,inference:remoteInferenceStateSchema.safeParse(message.inference).data });
          } catch { this.repairSelection(); }
        }
        if (message.type === 'reply') {
          if(this.selectionRequest&&this.selectionRequest.id===message.requestId){const request=this.selectionRequest;this.selectionRequest=undefined;if(!message.ok&&!this.navigation&&request.target===this.selected){this.select(REMOTE_DRAFT_ID);this.requestSelection();this.notice('That conversation is no longer available.');}return;}
          const pending = this.pending.get(message.requestId); if (!pending) return;
          if (!message.ok) {
            if (this.navigation && this.navigation.id === message.requestId) { const previous = this.navigation.previous; this.navigation = undefined; this.select(previous); if (previous && this.views.has(previous)) this.deliver(this.views.get(previous)!); this.repairSelection(); }
            this.pending.delete(message.requestId); this.save(); pending.reject(Error(message.error || 'The request could not be completed.')); return;
          }
          if (this.navigation && this.navigation.id === message.requestId) {
            const target = pending.command.op === 'get' ? pending.command.home ? REMOTE_DRAFT_ID : pending.command.conversationId : message.conversationId;
            if (typeof target !== 'string' || !/^[a-f0-9-]{36}$/.test(target)) { this.navigation = undefined; this.pending.delete(message.requestId); this.save(); pending.reject(Error('This conversation could not be opened.')); return; }
            pending.acknowledged = target; this.select(target);
            const view = this.views.get(target);
            if (view) { this.deliver(view); this.finish(message.requestId); } else this.requestSelection();
          } else this.finish(message.requestId);
        }
      } catch { socket.close(); }
    };
    socket.onclose = event => {
      clearTimeout(connecting);
      if (this.socket !== socket || this.closed) return;
      clearInterval(this.heartbeat); clearTimeout(this.handshakeTimer); this.cipher?.destroy(); this.cipher = undefined; this.online = false;
      this.interruptVoice();
      if (event.code === 4003) { this.revoke(); return; }
      this.changed('offline');
      if (!this.closed) this.timer = setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** Math.min(this.attempt++,5)) + Math.random() * 500);
    };
    socket.onerror = () => { if(this.socket===socket&&!this.closed){this.online=false;this.changed('offline');socket.close();} };
  }
  private sendApp(value: unknown) {
    if (!this.cipher?.ready || this.socket?.readyState !== WebSocket.OPEN) throw Error('Secure connection is unavailable.');
    try { for (const data of this.cipher.seal(value)) this.socket.send(JSON.stringify({ type: 'encrypted', data })); }
    catch (error) { this.socket.close(); throw error; }
  }
  private save() {
    const commands = [...this.pending.values()].filter(item => item.command.op !== 'get').map(item => item.command);
    const write = this.recoveryWrites.catch(() => {}).then(() => savePrivateRecovery(this.desktopId, commands)); this.recoveryWrites = write;
    void write.catch(() => this.notice('Private recovery could not be saved. Keep TinyGPT open until this request finishes.'));
    return write;
  }
  private select(id?: string) {
    if (this.selected === id) return; this.selected = id;
    try { if (id) sessionStorage.setItem('tinygpt-selected:' + this.desktopId,id); else sessionStorage.removeItem('tinygpt-selected:' + this.desktopId); } catch {}
  }
  private deliver(view: View) { if (this.displayed === view) return; this.displayed = view; this.update(view.value,view.attention,view.scope,view.computerName,view.voice,view.media,view.inference); }
  private receive(view: View) {
    const id = view.value.conversation.id; this.views.delete(id); this.views.set(id,view);
    if (this.views.size > 16) { const oldest = [...this.views.keys()].find(key => key !== this.selected); if (oldest) this.views.delete(oldest); }
    const navigation = this.navigation && this.pending.get(this.navigation.id);
    if (navigation?.command.op === 'create' && !navigation.acknowledged) return;
    // Decode other conversations to maintain delta bases, but never let a
    // reconnect snapshot or an old command change what the user selected.
    if (this.selected && id !== this.selected && view.scope === 'library') { if (id === REMOTE_DRAFT_ID && this.displayed && !view.value.library.conversations.some(chat => chat.id === this.selected)) this.select(REMOTE_DRAFT_ID); else { this.repairSelection(); return; } }
    this.select(id); this.deliver(view);
    if (this.navigation && navigation?.acknowledged === id) this.finish(this.navigation.id);
  }
  private finish(id: string) { const pending = this.pending.get(id); if (!pending) return; this.pending.delete(id); if (this.navigation?.id === id) this.navigation = undefined; this.save(); pending.resolve(); }
  private requestSelection() {
    if (this.online && this.socket?.readyState === WebSocket.OPEN) {const id=crypto.randomUUID();this.selectionRequest={id,target:this.selected};this.sendApp({id,op:'get',...(this.selected === REMOTE_DRAFT_ID ? {home:true} : this.selected ? {conversationId:this.selected} : {})});}
  }
  private repairSelection() { if (Date.now() - this.repairedAt < 1000) return; this.repairedAt = Date.now(); this.requestSelection(); }
  private resend() {
    // Finish deliveries first, then restore the explicitly selected chat.
    for (const pending of this.pending.values()) if (pending.command.op !== 'get') this.sendApp(pending.command);
    const navigation = this.navigation && this.pending.get(this.navigation.id);
    if (navigation?.command.op === 'get') this.sendApp(navigation.command);
    else if (navigation?.command.op !== 'create' || navigation.acknowledged) this.requestSelection();
  }
  onVoiceEvent(listener: (event: DictationEvent) => void) { this.voiceListeners.add(listener); return () => { this.voiceListeners.delete(listener); }; }
  manage(command:RemoteManagementRequest):Promise<RemoteManagementState>{
    if(!this.online||this.socket?.readyState!==WebSocket.OPEN||this.managementPending.size>=8)return Promise.reject(Error('Your computer is offline. Reconnect before making changes.'));
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.managementPending.delete(command.id);reject(Error('The request timed out. Refresh to check its result.'));},30000);this.managementPending.set(command.id,{resolve,reject,timer});try{this.sendApp({type:'management',command});}catch(error){clearTimeout(timer);this.managementPending.delete(command.id);reject(error);}});
  }
  media(command:RemoteMediaRequest):Promise<any>{
    if(!this.online||this.socket?.readyState!==WebSocket.OPEN||this.mediaPending.size>=8)return Promise.reject(Error('Your computer is offline. Try again when it reconnects.'));
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.mediaPending.delete(command.id);reject(Error('File request timed out. Try again.'));},60000);this.mediaPending.set(command.id,{resolve,reject,timer});try{this.sendApp({type:'media',command});}catch(error){clearTimeout(timer);this.mediaPending.delete(command.id);reject(error);}});
  }
  inference(command:RemoteInferenceRequest):Promise<unknown>{
    if(!this.online||this.socket?.readyState!==WebSocket.OPEN||this.inferencePending.size>=8)return Promise.reject(Error('Your computer is offline. Try again when it reconnects.'));
    // Settings requests never replay after a reconnect: an old model choice
    // must not silently override a more recent selection on another device.
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.inferencePending.delete(command.id);reject(Error('Your computer is still preparing the model. Reopen the picker to check its status.'));},180000);this.inferencePending.set(command.id,{resolve,reject,timer});try{this.sendApp({type:'inference',command});}catch(error){clearTimeout(timer);this.inferencePending.delete(command.id);reject(error);}});
  }
  interruptVoice() {
    for(const pending of this.managementPending.values()){clearTimeout(pending.timer);pending.reject(Error('Connection interrupted. Refresh to check whether your change was saved.'));}this.managementPending.clear();
    for(const pending of this.inferencePending.values()){clearTimeout(pending.timer);pending.reject(Error('Connection interrupted. Reopen the picker once your computer reconnects.'));}this.inferencePending.clear();
    for(const pending of this.mediaPending.values()){clearTimeout(pending.timer);pending.reject(Error('Connection interrupted. Your file is kept; try again.'));}this.mediaPending.clear();
    for (const pending of this.voicePending.values()) { clearTimeout(pending.timer); pending.reject(Error('Voice connection ended. Try again.')); } this.voicePending.clear();
    for (const listener of this.voiceListeners) listener({ id: '', phase: 'error', error: 'Voice connection ended. Your text is kept.' });
  }
  voiceAudio(command: RemoteVoiceRequest) {
    if (!this.online || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 262144) throw Error('Voice connection cannot keep up.');
    this.sendApp({ type: 'voice', command });
  }
  voice(command: RemoteVoiceRequest): Promise<any> {
    if (!this.online || this.socket?.readyState !== WebSocket.OPEN || this.voicePending.size >= 8) return Promise.reject(Error('Voice connection unavailable.'));
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.voicePending.delete(command.id); reject(Error('Voice request timed out.')); },180000);
      this.voicePending.set(command.id,{ resolve,reject,timer });
      try { this.voiceAudio(command); } catch (error) { clearTimeout(timer); this.voicePending.delete(command.id); reject(error); }
    });
  }
  restore(): Promise<void> {
    return this.restoration ??= (async () => { try {
      const saved = await restoredCommands(this.desktopId);
      const intent = sessionStorage.getItem('tinygpt-navigation:' + this.desktopId);
      for (const value of saved.slice(0,8)) {
        const parsed = remoteCommandSchema.safeParse(value); if (!parsed.success || parsed.data.op === 'get') continue;
        const command = parsed.data; this.pending.set(command.id,{command,resolve:()=>{},reject:error=>this.notice(error.message)});
        if (command.op === 'create' && command.id === intent && this.selected !== REMOTE_DRAFT_ID) this.navigation = {id:command.id,previous:this.selected};
      }
    } catch { try { sessionStorage.removeItem('tinygpt-pending:' + this.desktopId); } catch {} this.notice('Private request recovery is unavailable. Check the conversation before sending again.'); } })();
  }
  command(command: RemoteCommand): Promise<void> {
    if (!this.online || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(Error('Desktop offline. Reconnect before sending.'));
    if (command.op !== 'get' && [...this.pending.values()].filter(item => item.command.op !== 'get').length >= 8) return Promise.reject(Error('Wait for your pending requests before sending more.'));
    return new Promise((resolve,reject) => {
      this.pending.set(command.id,{command,resolve,reject});
      if (command.op === 'create' || command.op === 'get' && (command.conversationId || command.home)) {
        this.navigation = {id:command.id,previous:this.selected};
        try { sessionStorage.setItem('tinygpt-navigation:' + this.desktopId,command.id); } catch {}
        if (command.op === 'get') this.select(command.home ? REMOTE_DRAFT_ID : command.conversationId);
      }
      void this.save().catch(() => {}).then(() => { if (this.pending.has(command.id) && this.online) this.sendApp(command); });
    });
  }
  wake() { if (!this.closed) { if (this.socket?.readyState !== WebSocket.OPEN || Date.now() - this.heardAt > 15000) void this.connect(); else if (this.online) this.resend(); } }
  private revoke() { this.closed = true; this.online = false; this.changed('revoked'); for (const item of this.pending.values()) item.reject(Error('Remote access was revoked. Pair again from your computer.')); this.pending.clear(); this.save(); this.close(); }
  close() {
    clearTimeout(this.handshakeTimer); this.cipher?.destroy(); this.cipher = undefined; this.interruptVoice(); for (const item of this.pending.values()) item.reject(Error('Connection closed. Pending requests will resume on this computer.')); this.pending.clear(); this.closed = true; clearTimeout(this.timer); clearInterval(this.heartbeat); this.socket?.close(); }
}
