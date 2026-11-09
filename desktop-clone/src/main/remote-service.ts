import { RemoteCipher, REMOTE_TRANSPORT, keyContext, type SecureRoute } from '../shared/remote-crypto';
import { remotePushEvent,pushEventSchema,type RemotePushEvent } from '../shared/remote-push';
import {defaultBotDesign,type RemoteBotState} from '../shared/bot-design';
import {BOT_SLEEPING_MESSAGE} from '../shared/bot';
import type { ActivityNotification } from '../shared/notifications';
import { remoteMediaRequestSchema } from '../shared/remote-media';
import type { RemoteMediaBridge } from './remote-media';
import { remoteInferenceRequestSchema, type RemoteInferenceState, type RemoteModelCatalog } from '../shared/remote-inference';
import type { Effort } from '../shared/effort';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, randomInt, randomUUID, sign } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import WebSocket from 'ws';
import QRCode from 'qrcode';
import { ChatUpdateEncoder } from '../core/chat-updates';
import type { LibrarySnapshot, ChatUpdate } from '../shared/chat';
import { remoteCommandSchema, remoteView, type RemoteDevice, type RemoteInvitation, type RemoteStatus, type RemoteScope, type RemotePairingRequest } from '../shared/remote';
import type { Encryption } from './store';
import type { RemotePreferences, RemoteAppearance } from '../shared/remote';
import { remoteVoiceRequestSchema } from '../shared/remote-voice';
import { REMOTE_DRAFT_ID } from '../shared/remote';
import type { QueueAction } from '../shared/chat';
import type { RemoteVoiceBridge } from './remote-voice';
import { DEFAULT_REMOTE_RELAY_URL, LEGACY_REMOTE_RELAY_URL } from '../shared/remote-config';
import { remoteManagementRequestSchema } from '../shared/remote-management';
import { RemoteManagement,type RemoteManagementActions } from './remote-management';

type Grant = { management?:boolean; psk?: string; deviceId?: string; scope?: RemoteScope; id: string; conversationId: string; expiresAt: number };
type Saved = { e2eVersion?: number; pushOutbox?:RemotePushEvent[]; enabled: boolean; keepAwake: boolean; relayUrl: string; key: string; grants: Grant[]; revoked: string[]; pendingRevocations: string[]; receipts: Record<string, { deviceId: string; expiresAt: number; state: 'accepted' | 'complete'; conversationId?: string; fingerprint: string }> };
interface Chat { update(id: string): ChatUpdate; send(id: string, text: string, attachments?: string[], pinMode?: boolean): ChatUpdate; queueAction?(action: QueueAction): ChatUpdate; library?(): LibrarySnapshot; answerWorkQuestion?(value: unknown): Promise<ChatUpdate>; cancel(id: string): Promise<ChatUpdate> }
export interface RemoteActions {
  bot?():Omit<RemoteBotState,'design'>|undefined;
  botSnooze?(value:boolean):Promise<unknown>;
  botReact?(conversationId:string,messageId:string,emoji:import('../shared/bot-reactions').MessageReaction['emoji']|null):void;
  toolIconKeys?(): Readonly<Record<string,string>>;
  validateAttachments?(conversationId:string,ids:string[]):void;
  create(mode: 'chat' | 'code'): Promise<ChatUpdate>;
  approve(id: string, decision: 'allow-once' | 'deny'): Promise<void>;
  edit?(conversationId: string, messageId: string, text: string): Promise<ChatUpdate>;
  regenerate?(conversationId: string, messageId: string): ChatUpdate | Promise<ChatUpdate>;
  branch?(conversationId: string, messageId: string): ChatUpdate | Promise<ChatUpdate>;
  rename?(conversationId: string, title: string): void;
  organize?(conversationId: string, action: 'pin' | 'archive', value: boolean): void;
  delete?(conversationId: string): Promise<void>;
  notifications?(): NonNullable<LibrarySnapshot['notificationItems']>;
  readNotification?(id: string): void;
}
export interface RemoteInferenceActions {
  state(): RemoteInferenceState;
  models(connectionId: string): Promise<RemoteModelCatalog>;
  select(connectionId: string, model: string, authorized: () => void): Promise<unknown>;
  effort(mode: 'chat' | 'code', effort: Effort, authorized: () => void): Promise<unknown>;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const offline = 'Remote chat could not connect. Check your internet connection and relay address.';
export class RemoteService {
  private warmModel?: () => Promise<void>;
  setWarmModel(warm: () => Promise<void>) { this.warmModel = warm; }
  private saved: Saved = { enabled: false, keepAwake: false, relayUrl: '', key: '', grants: [], revoked: [], pendingRevocations: [], receipts: {} };
  private socket?: WebSocket;
  private securePeers = new Map<string, { cipher: RemoteCipher; route: SecureRoute }>();
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private closed = false;
  private error?: string;
  private appearance?: RemoteAppearance;
  private devices: RemoteDevice[] = [];
  private requests: RemotePairingRequest[] = [];
  private refreshing?: Promise<RemoteStatus>;
  private subscriptions = new Map<string, { deviceId: string; connectionId?: string; grantId: string; conversationId: string; encoder: ChatUpdateEncoder }>();
  private pending = new Map<string, ChatUpdate>();
  private queue: Promise<unknown> = Promise.resolve();
  private pushWrites:Promise<unknown>=Promise.resolve();
  private commands: Promise<unknown> = Promise.resolve();
  private inference?: RemoteInferenceActions;
  private management?:RemoteManagement;
  setManagementActions(actions:RemoteManagementActions){this.management=new RemoteManagement(actions);}
  async setManagement(deviceId:string,value:boolean){const grant=this.saved.grants.find(item=>item.deviceId===deviceId&&item.expiresAt>Date.now());if(!grant||grant.scope!=='library')throw Error('Enable conversation access before settings management.');grant.management=value;await this.persist();return this.status();}
  private async managementCommand(data:any){
    const parsed=remoteManagementRequestSchema.safeParse(data.command);if(!parsed.success)return;
    const command=parsed.data,reply=(ok:boolean,value?:unknown,error?:string)=>this.send({type:'management-reply',deviceId:data.deviceId,connectionId:data.connectionId,requestId:command.id,ok,value,error});
    const authorized=()=>{if(!this.saved.enabled||!this.securePeers.has(data.connectionId)||this.saved.revoked.includes(data.deviceId)||!this.saved.grants.some(grant=>grant.id===data.grantId&&grant.deviceId===data.deviceId&&grant.scope==='library'&&grant.management&&grant.expiresAt>Date.now()))throw Error('Allow settings management for this device on your computer.');};
    try{
      try{authorized();}catch(error){if(command.op==='state'){reply(true,{allowed:false,computer:this.computerName.slice(0,120),version:'',keepAwake:this.saved.keepAwake});return;}throw error;}
      if(!this.management)throw Error('Restart TinyGPT on your computer to use these settings.');
      reply(true,await this.management.handle(data.deviceId,command,authorized));if(!['state','project-open','memory-open'].includes(command.op))this.refreshLibraries();
    }catch(error){const message=error instanceof Error?error.message:'';const safe=['Allow settings management for this device on your computer.','Restart TinyGPT on your computer to use these settings.','Another change is being saved. Try again.','This request ID has already been used.','This change was already handled. Refresh to check its result.','Stop the current reply before making this change.','Choose an available local voice.','Too much data to show. Manage the library on your computer.'];reply(false,undefined,safe.includes(message)?message:'This request could not be completed. Refresh and try again, or check TinyGPT on your computer.');}
  }
  private inferenceReads = 0;
  private inferenceBusy = false;
  private botState():RemoteBotState|undefined { const state=this.actions?.bot?.();return state?{...state,design:{...(this.appearance?.bot??defaultBotDesign),name:state.name}}:undefined; }
  private accessible(id:string) { if(this.chat.update(id).conversation.mode==='bot'&&id!==this.actions?.bot?.()?.conversationId)throw Error('This Bot conversation is unavailable.'); }
  private view(id: string, home = false): ChatUpdate {
    if (id !== REMOTE_DRAFT_ID) { this.accessible(id);return this.chat.update(id); }
    if (!home || !this.chat.library) throw Error('Conversation unavailable');
    return { conversation: { id: REMOTE_DRAFT_ID, projectId: null, mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [], tools: [], sources: [], queuedRequests: [] }, library: this.chat.library() };
  }
  refreshLibraries() {
    for (const [key, subscription] of this.subscriptions) {
      const full = this.saved.grants.find(grant => grant.id === subscription.grantId)?.scope === 'library';
      try { this.publishTo(key, this.view(subscription.conversationId, full)); }
      catch { if (full) { subscription.conversationId = REMOTE_DRAFT_ID; subscription.encoder = new ChatUpdateEncoder(); this.publishTo(key, this.view(REMOTE_DRAFT_ID, true)); } }
    }
  }
  constructor(private directory: string, private encryption: Encryption, private chat: Chat, private configuredUrl = '', private awake: (value: boolean) => void = () => {}, private actions?: RemoteActions, private voice?: RemoteVoiceBridge, private computerName = hostname(), private media?: RemoteMediaBridge) { voice?.setSender(value => this.send(value)); }
  async load() {
    try {
      const contents = JSON.parse(await readFile(join(this.directory, 'remote-chat.json'), 'utf8'));
      const value: Saved = JSON.parse(this.encryption.decrypt(Buffer.from(contents.encrypted, 'base64')));
      if (!value || typeof value.relayUrl !== 'string' || typeof value.key !== 'string' || !Array.isArray(value.grants) || !Array.isArray(value.revoked) || !value.receipts) throw Error('Invalid remote settings');
      this.saved = { ...value, enabled: value.enabled ?? !!value.relayUrl, keepAwake: value.keepAwake ?? false, pendingRevocations: value.pendingRevocations ?? [] };
      // Validate the encrypted key before using any saved remote settings.
      if (this.saved.key) createPrivateKey(this.saved.key);
      else if (this.saved.relayUrl || this.saved.grants.length) throw Error('Missing remote identity');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.error = 'Saved remote access could not be read. Your remote settings have been preserved.'; return; } }
    if (this.configuredUrl === DEFAULT_REMOTE_RELAY_URL && this.saved.relayUrl === LEGACY_REMOTE_RELAY_URL) { this.saved.relayUrl = DEFAULT_REMOTE_RELAY_URL; await this.persist(); }
    if (this.saved.e2eVersion !== 2) { this.saved.grants = []; this.saved.receipts = {}; this.saved.pushOutbox = []; this.saved.e2eVersion = 2; await this.persist(); }
    this.saved.pushOutbox=(Array.isArray(this.saved.pushOutbox)?this.saved.pushOutbox:[]).flatMap(value=>{const parsed=pushEventSchema.safeParse(value);return parsed.success&&parsed.data.createdAt>Date.now()-1800000?[parsed.data]:[];}).slice(-100);
    this.awake(this.saved.enabled && this.saved.keepAwake);
    if (this.saved.relayUrl && this.saved.enabled) this.connect();
  }
  notify(entry:ActivityNotification){
    const event=remotePushEvent(entry);if(!event||entry.mode==='bot'&&entry.conversationId!==this.actions?.bot?.()?.conversationId||!this.saved.enabled||!this.saved.grants.some(grant=>grant.expiresAt>Date.now()&&(grant.scope==='library'||grant.conversationId===event.conversationId)))return;
    this.pushWrites=this.pushWrites.then(async()=>{this.saved.pushOutbox=[...(this.saved.pushOutbox??[]).filter(item=>item.id!==event.id&&item.createdAt>Date.now()-1800000),event].slice(-100);await this.persist();this.flushPush();}).catch(()=>{});
  }
  private pushPolicy(){return {enabled:this.saved.enabled,grants:this.saved.grants.filter(grant=>grant.expiresAt>Date.now()).slice(-200).map(grant=>({id:grant.id,conversationId:grant.conversationId,scope:grant.scope??'conversation'}))};}
  private flushPush(){if(!this.saved.enabled)return;this.send({type:'push-policy',...this.pushPolicy()});for(const event of this.saved.pushOutbox??[])if(event.createdAt>Date.now()-1800000)this.send({type:'notification',event});}
  private acknowledgePush(id:string){this.pushWrites=this.pushWrites.then(async()=>{this.saved.pushOutbox=(this.saved.pushOutbox??[]).filter(event=>event.id!==id);await this.persist();}).catch(()=>{});}
  status(): RemoteStatus { return { configured: !!(this.saved.relayUrl || this.configuredUrl), enabled: this.saved.enabled, keepAwake: this.saved.keepAwake, connected: this.socket?.readyState === WebSocket.OPEN, relayUrl: this.saved.relayUrl || this.configuredUrl, requests: this.requests.filter(request => request.expiresAt > Date.now()), devices: this.devices.filter(device => !this.saved.revoked.includes(device.id)).map(device => ({ ...device, management:!!this.saved.grants.find(grant=>grant.id===device.grantId)?.management, scope: this.saved.grants.find(grant => grant.id === device.grantId)?.scope ?? 'conversation' })), error: this.error }; }
  setAppearance(value: RemoteAppearance) {
    this.appearance = value;
    this.refreshLibraries();
  }
  refreshDisplay() {
    for (const subscription of this.subscriptions.values()) { try { this.publish(this.chat.update(subscription.conversationId)); } catch {} }
  }
  refreshVoice() { this.refreshLibraries(); }
  setInference(actions: RemoteInferenceActions) { this.inference = actions; this.refreshVoice(); }
  private async inferenceCommand(data: any) {
    const parsed = remoteInferenceRequestSchema.safeParse(data.command);
    if (!parsed.success || typeof data.deviceId !== 'string' || typeof data.connectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.connectionId)) return;
    const command = parsed.data, actions = this.inference;
    const reply = (ok: boolean, value?: unknown, error?: string) => this.send({ type: 'inference-reply', deviceId: data.deviceId, connectionId: data.connectionId, requestId: command.id, ok, value, error });
    const authorized = () => {
      if (!this.saved.enabled || this.saved.revoked.includes(data.deviceId) || !this.saved.grants.some(grant => grant.id === data.grantId && grant.conversationId === data.conversationId && grant.scope === 'library' && grant.expiresAt > Date.now())) throw Error('Remote access has ended.');
    };
    const changing = command.op !== 'models';
    let admitted = false;
    try {
      authorized();
      if (!actions) throw Error('Restart TinyGPT on your computer to use model controls.');
      if (this.inferenceReads >= 8 || changing && this.inferenceBusy) throw Error('A model change is already in progress. Try again shortly.');
      admitted = true; if (changing) this.inferenceBusy = true; else this.inferenceReads++;
      let value: unknown;
      if (command.op === 'models') value = await actions.models(command.connectionId);
      else if (command.op === 'select') { await actions.select(command.connectionId, command.model, authorized); value = actions.state(); }
      else { await actions.effort(command.mode, command.effort, authorized); value = actions.state(); }
      authorized(); reply(true, value);
      if (changing) this.refreshVoice();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      const safe = ['Remote access has ended.', 'Restart TinyGPT on your computer to use model controls.', 'A model change is already in progress. Try again shortly.', 'Stop the current reply before making this change.', 'This model is unavailable. Choose another model.', 'Your connection changed. Choose the model again.', 'This built-in model is unavailable.', 'Pro compatibility could not be confirmed on this device.', 'Finish the current built-in setup first.'];
      reply(false, undefined, safe.includes(message) ? message : command.op === 'models' ? 'Models could not be loaded. Check the provider on your computer and try again.' : 'The change could not be saved. Check TinyGPT on your computer and try again.');
    } finally { if (admitted) { if (changing) this.inferenceBusy = false; else this.inferenceReads--; } }
  }
  async configure(preferences: RemotePreferences): Promise<RemoteStatus> {
    if (this.error?.startsWith('Saved remote')) throw Error(this.error);
    if (!this.encryption.available()) throw Error('Secure credential storage is unavailable.');
    const enabled = preferences.enabled ?? this.saved.enabled;
    if (enabled && !this.saved.key) {
      this.saved.relayUrl = this.normalizeUrl(this.saved.relayUrl || this.configuredUrl);
      this.saved.key = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    }
    this.saved.enabled = enabled;
    this.saved.keepAwake = preferences.keepAwake ?? this.saved.keepAwake;
    await this.persist();
    if (!enabled) { this.saved.pushOutbox=[]; await this.persist(); this.send({type:'push-policy',enabled:false,grants:[]}); this.close(); this.closed = false; this.error = undefined; void this.request('push-control','POST',{enabled:false,grants:[]}).catch(()=>{}); }
    else if (!this.socket || this.socket.readyState > WebSocket.OPEN) { this.closed = false; this.connect(); }
    this.awake(enabled && this.saved.keepAwake);
    return this.status();
  }
  private desktopId() { const key = createPublicKey(this.saved.key).export({ format: 'jwk' }); return sha(JSON.stringify({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y })); }
  private persist() {
    const content = JSON.stringify({ encrypted: this.encryption.encrypt(JSON.stringify(this.saved)).toString('base64') });
    const write = this.queue.then(async () => { await mkdir(this.directory, { recursive: true }); const file = join(this.directory, 'remote-chat.json'); const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); });
    this.queue = write.catch(() => {}); return write;
  }
  private headers(method: string, path: string, body = '') {
    const timestamp = String(Date.now()), nonce = randomUUID();
    const publicKey = createPublicKey(this.saved.key).export({ format: 'jwk' });
    const payload = `${method}\n${path}\n${timestamp}\n${nonce}\n${sha(body)}`;
    return { 'Content-Type': 'application/json', 'X-TinyGPT-Time': timestamp, 'X-TinyGPT-Nonce': nonce,
      'X-TinyGPT-Key': Buffer.from(JSON.stringify(publicKey)).toString('base64'),
      'X-TinyGPT-Signature': sign('sha256', Buffer.from(payload), { key: this.saved.key, dsaEncoding: 'ieee-p1363' }).toString('base64') };
  }
  private async request(action: string, method = 'GET', value?: unknown) {
    const path = `/api/d/${this.desktopId()}/${action}`, body = value === undefined ? '' : JSON.stringify(value);
    const response = await fetch(`${this.saved.relayUrl}${path}`, { method, headers: this.headers(method, path, body), body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(offline);
    return response.json();
  }
  private normalizeUrl(input: string) {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw Error('Use an HTTPS relay address.');
    return url.origin;
  }
  async pair(conversationId: string, relayUrl?: string, scope: RemoteScope = 'library'): Promise<RemoteInvitation> {
    if (this.error?.startsWith('Saved remote')) throw Error(this.error);
    const conversation = this.chat.update(conversationId).conversation;
    this.accessible(conversationId);
    if (!this.encryption.available()) throw Error('Secure credential storage is unavailable.');
    const url = this.normalizeUrl(relayUrl || this.saved.relayUrl || this.configuredUrl);
    if (this.saved.relayUrl && this.saved.relayUrl !== url) throw Error('Disconnect remote access before changing the relay address.');
    if (!this.saved.key) this.saved.key = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    this.saved.relayUrl = url; this.saved.enabled = true; this.closed = false; this.awake(this.saved.keepAwake); await this.persist();
    if (!this.socket || this.socket.readyState > WebSocket.OPEN) this.connect();
    await this.waitForConnection();
    const id = randomUUID(), token = randomBytes(32).toString('hex'), secret = randomBytes(32).toString('hex');
    const psk = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.from('tinygpt-remote-v2'), Buffer.from(keyContext(this.desktopId(), id)), 32)).toString('hex');
    this.saved.grants = this.saved.grants.filter(grant => grant.expiresAt > Date.now());
    if (this.saved.grants.length >= 200) throw Error('Too many connection codes. Try again shortly.');
    this.saved.e2eVersion = 2; this.saved.grants.push({ id, scope, conversationId, psk, expiresAt: Date.now() + 12 * 60000 }); await this.persist();
    const result = await this.request('pairings', 'POST', { id, conversationId, tokenHash: sha(token), computerName: this.computerName.slice(0,120) }) as { expiresAt: number };
    const link = `${url}/#${new URLSearchParams({ desktop: this.desktopId(), invitation: id, token, key: secret, v: '2' })}`;
    return { id, url: link, expiresAt: result.expiresAt, qr: await QRCode.toDataURL(link, { width: 256, margin: 2, errorCorrectionLevel: 'M' }) };
  }
  private async waitForConnection() {
    const socket = this.socket; if (socket?.readyState === WebSocket.OPEN) return;
    if (!socket) throw Error(offline);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); socket.off('open', opened); socket.off('close', failed); socket.off('error', failed); };
      const opened = () => { cleanup(); resolve(); }, failed = () => { cleanup(); reject(Error(offline)); };
      const timer = setTimeout(failed, 15000); socket.once('open', opened); socket.once('close', failed); socket.once('error', failed);
    });
  }
  private connect() {
    if (this.closed || !this.saved.enabled || !this.saved.relayUrl || !this.saved.key) return;
    clearTimeout(this.retry); this.disposeSocket(); clearInterval(this.heartbeat);
    this.voice?.close(); this.media?.close(); this.subscriptions.clear(); this.pending.clear();
    const path = `/api/d/${this.desktopId()}/connect`, url = this.saved.relayUrl.replace(/^http/, 'ws') + path;
    const socket = new WebSocket(url, REMOTE_TRANSPORT, { headers: this.headers('GET', path), maxPayload: 1000000, handshakeTimeout: 15000 }); this.socket = socket;
    let lastPong = Date.now();
    socket.on('open', () => {
      if (this.socket !== socket || this.closed) return;
      this.attempt = 0; this.error = undefined; lastPong = Date.now(); this.flushPush(); void this.refreshDevices().catch(() => {});
      this.heartbeat = setInterval(() => { if (Date.now() - lastPong > 25000) socket.terminate(); else if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 10000);
    });
    socket.on('message', data => {
      if (this.socket !== socket || this.closed) return;
      if (data.toString() === 'pong') { lastPong = Date.now(); return; }
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'push-ack' && typeof message.id === 'string') { this.acknowledgePush(message.id); return; }
        if (message.type === 'peer-close') { this.dropPeer(message.connectionId); return; }
        if (!['handshake', 'encrypted'].includes(message.type) || typeof message.connectionId !== 'string' || typeof message.data !== 'string') return;
        const grant = this.saved.grants.find(value => value.id === message.grantId && value.deviceId === message.deviceId && value.expiresAt > Date.now() && value.psk);
        if (!this.saved.enabled || !grant || this.saved.revoked.includes(message.deviceId)) return;
        if (message.type === 'handshake') {
          this.dropPeer(message.connectionId);
          if (this.securePeers.size >= 60) return;
          const route = { desktopId: this.desktopId(), grantId: grant.id, deviceId: message.deviceId, connectionId: message.connectionId };
          const cipher = new RemoteCipher(false, grant.psk!, route);
          try {
            const reply = cipher.handshakeMessage(message.data);
            this.securePeers.set(route.connectionId, { cipher, route });
            this.sendWire({ type: 'handshake', ...route, data: reply });
          } catch { cipher.destroy(); }
          return;
        }
        const peer = this.securePeers.get(message.connectionId);
        if (!peer || peer.route.deviceId !== message.deviceId || peer.route.grantId !== grant.id) return;
        const payload = peer.cipher.open(message.data) as any;
        if (payload === undefined) return;
        const envelope = { deviceId: peer.route.deviceId, connectionId: peer.route.connectionId, grantId: grant.id, conversationId: grant.conversationId };
        if (payload?.type === 'management') { void this.managementCommand({ ...envelope, command: payload.command }); return; }
        if (payload?.type === 'media') { void this.mediaCommand({ ...envelope, command: payload.command }); return; }
        if (payload?.type === 'inference') { void this.inferenceCommand({ ...envelope, command: payload.command }); return; }
        if (payload?.type === 'voice') { void this.voiceCommand({ ...envelope, command: payload.command }); return; }
        this.commands = this.commands.then(() => this.command(JSON.stringify({ ...envelope, type: 'command', command: payload }))).catch(() => { this.error = 'A remote request could not be completed.'; });
      } catch { try { const value = JSON.parse(data.toString()); this.dropPeer(value.connectionId); } catch {} }
    });
    socket.on('error', () => { if (this.socket === socket) this.error = offline; });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.voice?.close(); this.media?.close();
      clearInterval(this.heartbeat); this.subscriptions.clear(); this.error = offline;
      if (!this.closed) this.retry = setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** Math.min(this.attempt++, 5)) + randomInt(0, 500));
    });
  }
  private dropPeer(connectionId: string) {
    this.securePeers.get(connectionId)?.cipher.destroy(); this.securePeers.delete(connectionId);
    this.voice?.closePeer(connectionId); this.media?.closePeer(connectionId); this.subscriptions.delete(connectionId);
  }
  private send(value: any) {
    if (['push-policy', 'notification'].includes(value?.type)) { this.sendWire(value); return; }
    const peer = this.securePeers.get(value?.connectionId);
    if (!peer || peer.route.deviceId !== value.deviceId || this.saved.revoked.includes(value.deviceId) || !this.saved.enabled || !this.saved.grants.some(grant => grant.id === peer.route.grantId && grant.deviceId === peer.route.deviceId && grant.expiresAt > Date.now())) return;
    try { for (const data of peer.cipher.seal(value)) this.sendWire({ type: 'encrypted', ...peer.route, data }); }
    catch { this.dropPeer(peer.route.connectionId); }
  }
  private sendWire(value: unknown) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 2000000) { this.socket.terminate(); return; }
    this.socket.send(JSON.stringify(value));
  }
  async setScope(deviceId: string, scope: RemoteScope) {
    this.voice?.cancelDevice(deviceId); this.media?.cancelDevice(deviceId);
    await this.refreshDevices();
    const device = this.devices.find(device => device.id === deviceId && !this.saved.revoked.includes(deviceId));
    const grant = device && this.saved.grants.find(grant => grant.id === device.grantId);
    if (!grant) throw Error('Remote device is unavailable.');
    grant.scope = scope; if(scope!=='library')grant.management=false; await this.persist(); this.send({type:'push-policy',...this.pushPolicy()});
    for (const [key,subscription] of this.subscriptions) if (subscription.deviceId === deviceId) { subscription.conversationId = grant.conversationId; subscription.encoder = new ChatUpdateEncoder(); this.publishTo(key,this.chat.update(grant.conversationId)); }
    return this.status();
  }
  private async mediaCommand(data:{deviceId:string;connectionId:string;grantId:string;conversationId:string;command:unknown}) {
    const parsed=remoteMediaRequestSchema.safeParse(data.command);if(!parsed.success||!/^[a-f0-9-]{36}$/.test(data.connectionId)||!/^[a-f0-9-]{36}$/.test(data.deviceId))return;
    const request=parsed.data;
    try {
      const grant=this.saved.grants.find(grant=>grant.id===data.grantId&&grant.conversationId===data.conversationId&&grant.expiresAt>Date.now());
      if(!this.media||!this.saved.enabled||!grant||this.saved.revoked.includes(data.deviceId)||grant.scope!=='library'&&request.conversationId!==grant.conversationId)throw Error('Media access is unavailable.');
      this.accessible(request.conversationId);
      const value=await this.media.handle({deviceId:data.deviceId,connectionId:data.connectionId,conversationId:request.conversationId},request);
      this.send({type:'media-reply',deviceId:data.deviceId,connectionId:data.connectionId,requestId:request.id,ok:true,value});
    } catch(error) {
      const message=error instanceof Error?error.message:'';
      const safe=/^(?:Files must|Choose |Too many uploads|Upload |This attachment|Image preview|Saved image|This step|Media access)/.test(message)?message:'This file or preview could not be opened. Try again.';
      this.send({type:'media-reply',deviceId:data.deviceId,connectionId:data.connectionId,requestId:request.id,ok:false,error:safe});
    }
  }
  private async voiceCommand(data: { deviceId: string; connectionId: string; grantId: string; conversationId: string; command: unknown }) {
    const parsed = remoteVoiceRequestSchema.safeParse(data.command);
    if (!parsed.success || !/^[a-f0-9-]{36}$/.test(data.connectionId) || !/^[a-f0-9-]{36}$/.test(data.deviceId)) return;
    const request = parsed.data;
    const reply = (ok: boolean, value?: unknown) => this.send({ type: 'voice-reply', deviceId: data.deviceId, connectionId: data.connectionId, requestId: request.id, jobId: request.jobId, op: request.op, ok, value, error: ok ? undefined : 'Voice connection stopped. Check Voice settings on your computer and try again.' });
    try {
      const grant = this.saved.grants.find(grant => grant.id === data.grantId && grant.conversationId === data.conversationId && grant.expiresAt > Date.now());
      if (!this.voice || !this.saved.enabled || !grant || this.saved.revoked.includes(data.deviceId) || grant.scope !== 'library' && request.conversationId !== grant.conversationId ) throw Error('Unauthorized');
      if(request.conversationId!==REMOTE_DRAFT_ID)this.accessible(request.conversationId);
      const value = await this.voice.handle({ deviceId: data.deviceId, connectionId: data.connectionId, conversationId: request.conversationId },request);
      reply(true,value);
    } catch { reply(false); }
  }
  private async command(text: string) {
    if (text.length > 200000) return;
    let data: { type: string; deviceId: string; connectionId?: string; grantId: string; conversationId: string; command: unknown };
    try { data = JSON.parse(text); } catch { return; }
    if (data.type !== 'command' || typeof data.deviceId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.deviceId)) return;
    const parsed = remoteCommandSchema.safeParse(data.command); if (!parsed.success) return;
    if (data.connectionId !== undefined && !/^[a-f0-9-]{36}$/.test(data.connectionId)) return;
    const subscriptionKey = data.connectionId ?? data.deviceId;
    if (data.connectionId) this.subscriptions.delete(data.deviceId);
    const command = parsed.data;
    const reply = (ok: boolean, error?: string, conversationId?: string) => this.send({ type: 'reply', deviceId: data.deviceId, connectionId: data.connectionId, requestId: command.id, ok, error, conversationId });
    const grant = this.saved.grants.find(grant => grant.id === data.grantId && grant.conversationId === data.conversationId && grant.expiresAt > Date.now());
    if (!this.saved.enabled || !grant || this.saved.revoked.includes(data.deviceId)) { reply(false, 'Remote access has been revoked. Pair again.'); return; }
    const fullAccess = grant.scope === 'library';
    let target = 'conversationId' in command && command.conversationId ? command.conversationId : this.subscriptions.get(subscriptionKey)?.conversationId ?? grant.conversationId;
    if (command.op === 'get' && command.home && fullAccess) target = REMOTE_DRAFT_ID;
    if (!fullAccess && ['rename', 'organize', 'delete', 'queue'].includes(command.op)) { reply(false, 'Allow conversation access for this device in desktop Remote Control settings.'); return; }
    if (!fullAccess && (target !== grant.conversationId || ['create','approve','answer'].includes(command.op))) { reply(false, 'Allow conversation access for this device in desktop Remote Control settings.'); return; }
    try {
      const key = data.deviceId + ':' + command.id, fingerprint = sha(JSON.stringify(command)), receipt = this.saved.receipts[key];
      if (command.op === 'warm') { await this.warmModel?.(); reply(true); return; }
      if (receipt && receipt.fingerprint !== fingerprint) { reply(false, 'This request ID has already been used.'); return; }
      if (receipt?.conversationId) target = receipt.conversationId;
      let view = this.view(target, fullAccess && (command.op === 'get' || command.op === 'create' || !!receipt));
      if(view.conversation.mode==='bot'&&['rename','organize','delete','edit','regenerate','branch'].includes(command.op))throw Error('Manage your Bot on your computer.');
      if((command.op==='bot-snooze'||command.op==='bot-react')&&view.conversation.mode!=='bot')throw Error('This Bot conversation is unavailable.');
      const blocked = view.library.approvals.some(item => item.conversationId === target) || view.library.browserHandoffs.some(item => item.conversationId === target) || view.library.workQuestions?.some(item => item.conversationId === target && item.status === 'pending');
      if (!receipt && ['send','edit','regenerate','branch'].includes(command.op) && blocked && !(command.op === 'send' && command.delivery && view.library.activeRuns.some(run => run.conversationId === target))) { reply(false, 'Answer the pending question or approval before changing this conversation.'); return; }
      if (!receipt && ['edit','regenerate','branch'].includes(command.op) && view.library.activeRuns.some(run => run.conversationId === target)) { reply(false, 'Stop the current reply before making this change.'); return; }
      if (!receipt && (command.op === 'edit' || command.op === 'regenerate') && !view.conversation.messages.some(message => message.id === command.messageId && message.role === (command.op === 'edit' ? 'user' : 'assistant'))) throw Error('Message unavailable');
      if (!receipt && command.op === 'branch' && !(view.conversation.allMessages ?? view.conversation.messages).some(message => message.id === command.messageId)) throw Error('Message unavailable');
      if (!receipt && command.op === 'approve' && !view.library.approvals.some(item => item.id === command.approvalId && item.conversationId === target)) throw Error('Approval unavailable');
      if (!receipt && command.op === 'answer' && !view.library.workQuestions?.some(item => item.id === command.questionId && item.conversationId === target && item.status === 'pending')) throw Error('Question unavailable');
      if (!receipt && command.op === 'notification-read' && !this.actions?.notifications?.().some(item => item.id === command.notificationId && item.conversationId === target)) throw Error('Notification unavailable');
      if (command.op !== 'get' && !receipt) {
        for (const [id, item] of Object.entries(this.saved.receipts)) if (item.expiresAt < Date.now()) delete this.saved.receipts[id];
        if (Object.keys(this.saved.receipts).length >= 10000) { reply(false, 'Remote request limit reached. Try later.'); return; }
        this.saved.receipts[key] = { deviceId: data.deviceId, expiresAt: Date.now() + 31 * 86400000, state: 'accepted', fingerprint }; await this.persist();
        if (!this.saved.enabled || this.saved.revoked.includes(data.deviceId)) { reply(false, 'Remote access has been paused or revoked.'); return; }
        if (command.op === 'send') {
          if(command.attachmentIds?.length){if(!this.actions?.validateAttachments)throw Error('Attachments are unavailable.');this.actions.validateAttachments(target,command.attachmentIds);}
          const before = new Set(view.conversation.queuedRequests?.map(item => item.id)); const sent = this.chat.send(target,command.text,command.attachmentIds ?? [],true);
          if (command.delivery === 'steer') { const item = sent.conversation.queuedRequests?.find(item => !before.has(item.id)); if (item) { if (!this.chat.queueAction) throw Error('Steering unavailable'); this.chat.queueAction({ conversationId: target, action: 'steer', id: item.id }); } }
        }
        else if(command.op==='bot-snooze'){if(!this.actions?.botSnooze)throw Error('Bot controls are unavailable.');await this.actions.botSnooze(command.snoozed);this.refreshLibraries();}
        else if(command.op==='bot-react'){if(!this.actions?.botReact||!view.conversation.messages.some(message=>message.id===command.messageId))throw Error('Message unavailable');this.actions.botReact(target,command.messageId,command.emoji);}
        else if (command.op === 'stop') await this.chat.cancel(target);
        else if (command.op === 'create') { if (!this.actions) throw Error('Creation unavailable'); view = await this.actions.create(command.mode); target = view.conversation.id; }
        else if (command.op === 'edit') { if (!this.actions?.edit) throw Error('Editing unavailable'); await this.actions.edit(target, command.messageId, command.text); }
        else if (command.op === 'regenerate') { if (!this.actions?.regenerate) throw Error('Regeneration unavailable'); await this.actions.regenerate(target, command.messageId); }
        else if (command.op === 'branch') { if (!this.actions?.branch) throw Error('Branch unavailable'); await this.actions.branch(target, command.messageId); }
        else if (command.op === 'approve') { if (!this.actions) throw Error('Approvals unavailable'); await this.actions.approve(command.approvalId, command.decision); }
        else if (command.op === 'answer') { if (!this.chat.answerWorkQuestion) throw Error('Questions unavailable'); await this.chat.answerWorkQuestion({ questionId: command.questionId, ...(command.optionId ? { optionId: command.optionId } : { text: command.text }) }); }
        else if (command.op === 'queue') { if (!this.chat.queueAction) throw Error('Queue unavailable'); this.chat.queueAction(command.change); }
        else if (command.op === 'rename') { if (!this.actions?.rename) throw Error('Rename unavailable'); this.actions.rename(target, command.title); this.refreshLibraries(); }
        else if (command.op === 'organize') { if (!this.actions?.organize) throw Error('Organization unavailable'); this.actions.organize(target, command.action, command.value); this.refreshLibraries(); }
        else if (command.op === 'delete') { if (!this.actions?.delete) throw Error('Delete unavailable'); await this.actions.delete(target); this.refreshLibraries(); target = REMOTE_DRAFT_ID; }
        else if (command.op === 'notification-read') { if (!this.actions?.readNotification) throw Error('Notifications unavailable'); this.actions.readNotification(command.notificationId); this.refreshLibraries(); }
        this.saved.receipts[key].state = 'complete'; this.saved.receipts[key].conversationId = target; await this.persist();
      } else if (receipt?.state === 'accepted') { reply(false, 'Delivery was interrupted. Check the conversation before sending again.'); return; }
      // An older send/Stop/approval can be retried while another chat is open.
      // Only navigation and creation choose the subscribed conversation.
      const current = this.subscriptions.get(subscriptionKey);
      if (!current || command.op === 'get' || command.op === 'create' && !receipt) this.subscriptions.set(subscriptionKey, { deviceId: data.deviceId, connectionId: data.connectionId, grantId: grant.id, conversationId: target, encoder: new ChatUpdateEncoder() });
      const selected = this.subscriptions.get(subscriptionKey)!;
      this.publishTo(subscriptionKey,this.view(selected.conversationId, fullAccess)); reply(true, undefined, target);
    } catch (error) { const message = error instanceof Error ? error.message : ''; reply(false, [BOT_SLEEPING_MESSAGE,'Manage your Bot on your computer.','This Bot conversation is unavailable.','This chat includes images. Enable image input for a compatible model in Settings, or start a chat without images.','This Chat release supports up to four images in one conversation. Start a new chat for more images.','This attachment is unavailable for the current message.','Choose up to eight distinct attachments.', 'Enable tools in Settings before using Work.', 'Choose a model in Settings.', 'Add your provider API key in Settings.', 'Stop the current reply before making this change.', 'Message not found in this conversation.', 'File changes cannot be restored right now. Your edit was not sent.'].includes(message) ? message : 'The request could not be completed. Check TinyGPT on your computer before trying again.'); }
  }

  publish(update: ChatUpdate) {
    if (!this.subscriptions.size) return;
    this.pending.set(update.conversation.id, update);
    this.flushTimer ??= setTimeout(() => { this.flushTimer = undefined; const pending = [...this.pending.values()]; this.pending.clear(); for (const update of pending) for (const [id, subscription] of this.subscriptions) { if (subscription.conversationId === update.conversation.id) this.publishTo(id, update); else if (this.saved.grants.find(grant => grant.id === subscription.grantId)?.scope === 'library') { try { this.publishTo(id, this.view(subscription.conversationId, true)); } catch {} } } }, 80);
  }
  private publishTo(key: string, update: ChatUpdate) {
    update = { ...update, library: { ...update.library, notificationItems: this.actions?.notifications?.() } };
    const subscription = this.subscriptions.get(key);
    const deviceId = subscription?.deviceId;
    if (!this.saved.enabled || !subscription || !deviceId || this.saved.revoked.includes(deviceId) || !this.saved.grants.some(grant => grant.id === subscription.grantId && grant.expiresAt > Date.now())) return;
    this.send({ type: 'packet', deviceId, connectionId: subscription.connectionId, computerName: this.computerName.slice(0, 120), voice: this.voice?.capabilities(), media: !!this.media, inference: this.saved.grants.find(grant => grant.id === subscription.grantId)?.scope === 'library' ? this.inference?.state() : undefined, appearance: this.saved.grants.find(grant=>grant.id===subscription.grantId)?.scope==='library'||update.conversation.id===this.actions?.bot?.()?.conversationId?this.appearance:this.appearance?{...this.appearance,bot:undefined}:undefined, scope: this.saved.grants.find(grant => grant.id === subscription.grantId)?.scope ?? 'conversation', packet: subscription.encoder.encode(remoteView(update, this.saved.grants.find(grant => grant.id === subscription.grantId)?.scope === 'library', this.actions?.toolIconKeys?.(),this.botState())), attention: update.library.approvals.some(item => item.conversationId === update.conversation.id) || update.library.browserHandoffs.some(item => item.conversationId === update.conversation.id) });
  }
  async refreshDevices(): Promise<RemoteStatus> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshDevicesNow().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refreshDevicesNow(): Promise<RemoteStatus> {
    if (this.saved.key && this.saved.relayUrl) {
      try {
        for (const id of [...this.saved.pendingRevocations]) { await this.request('revoke', 'POST', { id }); this.saved.pendingRevocations = this.saved.pendingRevocations.filter(item => item !== id); await this.persist(); }
        const result = await this.request('devices') as { devices: RemoteDevice[]; requests?: RemotePairingRequest[] };
        this.devices = result.devices; this.requests = (result.requests ?? []).filter(request => this.saved.grants.some(grant => grant.id === request.grantId && grant.expiresAt > Date.now()));
        if (this.socket?.readyState === WebSocket.OPEN) this.error = undefined;
      } catch { this.error = offline; }
    }
    return this.status();
  }
  async approvePairing(id: string, allow: boolean) {
    await this.refreshDevices();
    if (!this.saved.enabled) throw Error('Remote connections are paused.');
    if (allow && this.devices.some(device => device.id === id && !this.saved.revoked.includes(id))) return this.status();
    if (!this.requests.some(request => request.id === id && request.expiresAt > Date.now())) throw Error('This connection request has expired. Scan a new code.');
    const request = this.requests.find(request => request.id === id)!;
    if (allow) { const grant = this.saved.grants.find(grant => grant.id === request.grantId)!; if (!grant.psk || grant.deviceId && grant.deviceId !== id) throw Error('Scan a fresh encrypted connection code.'); grant.deviceId = id; grant.expiresAt = Date.now() + 31 * 86400000; await this.persist(); }
    await this.request('approve', 'POST', { id, allow });
    return this.refreshDevices();
  }
  private disposeSocket() {
    for (const id of [...this.securePeers.keys()]) this.dropPeer(id);
    const socket = this.socket; this.socket = undefined;
    if (socket) { socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate(); }
  }
  async revoke(id: string) {
    for (const [connectionId, peer] of this.securePeers) if (peer.route.deviceId === id) this.dropPeer(connectionId);
    this.saved.grants = this.saved.grants.filter(grant => grant.deviceId !== id);
    this.voice?.cancelDevice(id); this.media?.cancelDevice(id);
    if (!this.saved.revoked.includes(id)) this.saved.revoked.push(id);
    if (!this.saved.pendingRevocations.includes(id)) this.saved.pendingRevocations.push(id);
    for (const [key,subscription] of this.subscriptions) if (subscription.deviceId === id) this.subscriptions.delete(key); await this.persist();
    try { await this.request('revoke', 'POST', { id }); this.saved.pendingRevocations = this.saved.pendingRevocations.filter(item => item !== id); await this.persist(); this.devices = this.devices.filter(device => device.id !== id); }
    catch { this.error = 'Access is blocked on this computer. Relay revocation will retry when the connection returns.'; }
    return this.status();
  }
  async disconnect() {
    // Removing grants denies existing phone credentials immediately, including after restart.
    this.saved.enabled = false; this.saved.pushOutbox=[]; this.awake(false); this.saved.grants = []; await this.persist();
    for (const device of this.devices) await this.revoke(device.id);
    this.close(); this.saved.relayUrl = ''; this.saved.key = ''; this.saved.receipts = {}; this.saved.revoked = []; await this.persist();
    this.devices = []; this.closed = false; this.error = undefined; return this.status();
  }
  close() { this.voice?.close(); this.media?.close(); this.awake(false); this.closed = true; clearTimeout(this.retry); clearTimeout(this.flushTimer); clearInterval(this.heartbeat); this.disposeSocket(); this.subscriptions.clear(); }
}
