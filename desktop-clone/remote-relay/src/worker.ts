import { PushDelivery,pushConfigured,type PushEnv } from './push';
import { pushEventSchema } from '../../src/shared/remote-push';
interface Env extends PushEnv { DESKTOPS: DurableObjectNamespace; ASSETS: Fetcher; REQUEST_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> } }
type Device = { id: string; name: string; conversationId: string; grantId: string; createdAt: number; expiresAt: number; sessionHash: string; sessionHashes?: string[] };
type InstallLink = { hash: string; deviceId: string; expiresAt: number };
type Invitation = { id: string; conversationId: string; tokenHash: string; pinHash?: string; expiresAt: number; attempts: number };
type Attachment = { role: 'desktop'; scopedChat?: boolean } | { role: 'phone'; deviceId: string; grantId: string; conversationId: string; connectionId: string; expiresAt: number; window: number; count: number; voiceCount?: number; voiceBytes?: number; mediaCount?:number; mediaBytes?:number };
const DAY = 86400000;
const json = (value: unknown, status = 200, headers: Record<string,string> = {}) => {
  const output = new Headers({ 'Cache-Control': 'no-store',...headers }), migrated = headers['Set-Cookie']?.match(/^tg2_([a-f0-9]{64})=/);
  if (migrated) output.append('Set-Cookie',cookieName(migrated[1]) + '=; HttpOnly; ' + (headers['Set-Cookie'].includes('Secure;') ? 'Secure; ' : '') + 'SameSite=Strict; Path=/api/d/' + migrated[1] + '/; Max-Age=0');
  return Response.json(value,{ status,headers: output });
};
export const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
export const hash = async (value: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const randomSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
const idPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9-]{36}$/;
const cookieName = (id: string) => `tg2_${id}`;
function cookie(request: Request, id: string) { return request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName(id)}=`))?.slice(cookieName(id).length + 1); }
function canonicalKey(key: JsonWebKey) { return JSON.stringify({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y }); }
export async function verifyDesktop(request: Request, desktopId: string): Promise<boolean> {
  try {
    const timestamp = request.headers.get('X-TinyGPT-Time') ?? '', nonce = request.headers.get('X-TinyGPT-Nonce') ?? '';
    if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 30000 || !uuidPattern.test(nonce)) return false;
    const key: JsonWebKey = JSON.parse(atob(request.headers.get('X-TinyGPT-Key') ?? ''));
    if (key.kty !== 'EC' || key.crv !== 'P-256' || key.d || !key.x || !key.y || await hash(canonicalKey(key)) !== desktopId) return false;
    const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const bodyHash = await hash(request.method === 'GET' ? '' : await request.clone().text());
    const payload = `${request.method}\n${new URL(request.url).pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = Uint8Array.from(atob(request.headers.get('X-TinyGPT-Signature') ?? ''), character => character.charCodeAt(0));
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, new TextEncoder().encode(payload));
  } catch { return false; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const selectedIcon = ['ios-default', 'dark', 'tinted-light', 'clear-light', 'clear-dark'].includes(url.searchParams.get('icon') ?? '') ? url.searchParams.get('icon')! : undefined;
      if (url.pathname === '/health') return json({ ok: true, protocol: 2, encryption: 'Noise_NNpsk0_25519_ChaChaPoly_BLAKE2b' });
      if (url.pathname === '/manifest.webmanifest') {
        
        return new Response(JSON.stringify({ id: '/app/', name: 'TinyGPT', short_name: 'TinyGPT', description: 'Your TinyGPT, on your phone.', start_url: '/app/' + (selectedIcon ? '?icon=' + selectedIcon : ''), scope: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff', icons: selectedIcon ? [{ src: '/icons/app-' + selectedIcon + '.png', sizes: '1024x1024', type: 'image/png' }] : [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] }),{ headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
      }
      if (!url.pathname.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
        const assetUrl = new URL(request.url); if (['/','/app','/app/'].includes(assetUrl.pathname)) assetUrl.pathname = '/mobile.html';
        const response = await env.ASSETS.fetch(new Request(assetUrl, request));
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        if (url.pathname === '/sw.js') headers.set('Service-Worker-Allowed','/');
        headers.set('Permissions-Policy', 'microphone=(self), camera=(self)');
        headers.set('Referrer-Policy', 'no-referrer'); headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Cache-Control', url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
        const body = selectedIcon && request.method !== 'HEAD' && response.headers.get('Content-Type')?.includes('text/html') ? (await response.text()).replaceAll('/icons/icon-192.png', '/icons/app-' + selectedIcon + '.png').replace('href="/manifest.webmanifest"', 'href="/manifest.webmanifest?icon=' + selectedIcon + '"') : response.body;
        return new Response(body, { status: response.status, headers });
      }
      if (!(await env.REQUEST_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success) return json({ error: 'Too many requests. Try again shortly.' }, 429);
      if(url.pathname==='/api/push/config'&&request.method==='GET')return json({enabled:pushConfigured(env),publicKey:pushConfigured(env)?env.VAPID_PUBLIC_KEY:null});
      // A copied installation hint remembers a computer, never credentials or
      // encryption keys. It grants no access and is not used to authenticate.
      if (url.pathname === '/api/mobile/install' && request.method === 'POST') {
        if(request.headers.get('Origin') !== url.origin) return json({error:'Origin not allowed.'},403);
        const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let length=0;
        if(reader) while(true) {const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>128){await reader.cancel();return json({error:'Invalid setup.'},400);}chunks.push(next.value);}
        const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}const text=new TextDecoder().decode(bytes);
        const value = new URLSearchParams(text).get('desktop'); if(!value || !idPattern.test(value)) return json({error:'Invalid setup.'},400);
        return json({ok:true},200,{'Set-Cookie':`tg_setup=${value}; HttpOnly; ${url.protocol==='https:'?'Secure; ':''}SameSite=Lax; Path=/api/; Max-Age=86400`});
      }
      if (url.pathname === '/api/mobile/session' && request.method === 'GET') {
        const ids = [...new Set([...request.headers.get('Cookie')?.matchAll(/(?:^|;\s*)tg2_([a-f0-9]{64})=/g) ?? []].map(match => match[1]))].slice(0,20);
        const results = await Promise.allSettled(ids.map(async id => {
          const target = new URL('/api/d/' + id + '/session',url);
          const response = await env.DESKTOPS.get(env.DESKTOPS.idFromName('e2e-v2:' + id)).fetch(new Request(target,{ headers: { Cookie: request.headers.get('Cookie') ?? '' } }));
          if (response.status === 401) return { computer: null };
          if (!response.ok) return { unavailable: id };
          return { computer: await response.json() };
        }));
        const setup = request.headers.get('Cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith('tg_setup='))?.slice(9);
        return json({ setupDesktop: setup && idPattern.test(setup) ? setup : undefined, computers: results.flatMap(result => result.status === 'fulfilled' && result.value.computer ? [result.value.computer] : []), unavailable: results.flatMap((result,index) => result.status === 'rejected' ? [ids[index]] : result.value.unavailable ? [result.value.unavailable] : []) });
      }
      const match = /^\/api\/d\/([a-f0-9]{64})\/(connect|pairings|devices|revoke|pair|socket|session|install|resume|approve|forget|push|push-control)$/.exec(url.pathname);
      if (!match || url.search) return json({ error: 'Not found.' }, 404);
      if (Number(request.headers.get('Content-Length') ?? 0) > 4096) return json({ error: 'Request too large.' }, 413);
      const [, id, action] = match;
      if (request.method === 'POST') {
        // Bound the actual stream, including requests without Content-Length.
        const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let length = 0;
        if (reader) while (true) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.byteLength;
          if (length > 4096) { await reader.cancel(); return json({ error: 'Request too large.' }, 413); }
          chunks.push(next.value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        request = new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
      }
      if (['pair','socket','install','resume','forget','push'].includes(action)) {
        if (request.headers.get('Origin') !== url.origin) return json({ error: 'Origin not allowed.' }, 403);
      } else if (action !== 'session' && !await verifyDesktop(request, id)) return json({ error: 'Desktop authentication failed.' }, 401);
      return await env.DESKTOPS.get(env.DESKTOPS.idFromName('e2e-v2:' + id)).fetch(request);
    } catch { return json({ error: 'Remote service unavailable.' }, 503); }
  },
};

export class DesktopRelay {
  private pushes:PushDelivery;
  constructor(private state: DurableObjectState, private env: Env) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.pushes=new PushDelivery(state.storage,env,()=>this.devices());
  }
  private desktop() { return this.state.getWebSockets('desktop').find(socket => socket.readyState === WebSocket.OPEN); }
  private send(socket: WebSocket, value: unknown) { try { socket.send(JSON.stringify(value)); } catch { try { socket.close(1011, 'Reconnect'); } catch {} } }
  private async devices() { return (await this.state.storage.get<Device[]>('devices') ?? []).filter(device => device.expiresAt > Date.now()); }
  private async phone(request: Request, desktopId: string) {
    const secret = cookie(request, desktopId);
    if (!secret || !idPattern.test(secret)) return;
    const digest = await hash(secret);
    return (await this.devices()).find(device => device.sessionHash === digest || device.sessionHashes?.includes(digest));
  }
  private async pending() { return (await this.state.storage.get<Device[]>('pending') ?? []).filter(device => device.expiresAt > Date.now()); }
  private async pendingPhone(request: Request,desktopId: string) {
    const secret = cookie(request,desktopId); if (!secret || !idPattern.test(secret)) return;
    const digest = await hash(secret); return (await this.pending()).find(device => device.sessionHash === digest || device.sessionHashes?.includes(digest));
  }
  private sessionCookie(request: Request,id: string,secret: string,age = 2592000) { return cookieName(id) + '=' + secret + '; HttpOnly; ' + (new URL(request.url).protocol === 'https:' ? 'Secure; ' : '') + 'SameSite=Strict; Path=/api/; Max-Age=' + age; }
  private async body(request: Request) {
    const text = await request.text(); if (text.length > 4096) throw Error('Too large');
    return JSON.parse(text) as Record<string, unknown>;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), parts = url.pathname.split('/'), desktopId = parts[3], action = parts[4];
    if (!['pair', 'socket', 'session','install','resume','forget','push'].includes(action)) {
      const nonce = request.headers.get('X-TinyGPT-Nonce')!;
      if (!nonce || !uuidPattern.test(nonce)) return json({ error: 'A signed desktop request is required.' }, 401);
      const accepted = await this.state.storage.transaction(async transaction => {
        const nonces = await transaction.get<Record<string, number>>('nonces') ?? {};
        if (nonces[nonce]) return false;
        for (const [key, expires] of Object.entries(nonces)) if (expires < Date.now()) delete nonces[key];
        nonces[nonce] = Date.now() + 60000; await transaction.put('nonces', nonces); return true;
      });
      if (!accepted) return json({ error: 'Request already used.' }, 401);
    }
    if(action==='push-control'&&request.method==='POST'){await this.pushes.policy(await this.body(request));return json({ok:true});}
    if(action==='push'&&request.method==='POST'){
      const device=await this.phone(request,desktopId);if(!device)return json({error:'Pair this phone before enabling notifications.'},401);
      try{const result=await this.pushes.register(device,desktopId,url.origin,await this.body(request));return json({ok:true,...result});}catch(error){const message=error instanceof Error?error.message:'';return json({error:/^(?:Invalid notification|Notifications are not|Enable notifications|This phone|This notification|Too many notification)/.test(message)?message:'Notifications could not be saved. Try again.'},400);}
    }
    if (action === 'session' && request.method === 'GET') {
      const device = await this.phone(request,desktopId), pending = device ? undefined : await this.pendingPhone(request,desktopId);
      if (!device && !pending) return json({ error: 'Pair this browser again.' },401);
      return json({ desktop: desktopId, deviceId: (device ?? pending)!.id, grantId: (device ?? pending)!.grantId, name: await this.state.storage.get<string>('computer-name') ?? 'Computer', status: device ? 'paired' : 'pending', online: !!this.desktop(), expiresAt: (device ?? pending)!.expiresAt },200,{ 'Set-Cookie': this.sessionCookie(request,desktopId,cookie(request,desktopId)!) });
    }
    if (action === 'devices' && request.method === 'GET') return json({ devices: (await this.devices()).map(({ sessionHash, sessionHashes, ...device }) => device), requests: (await this.pending()).map(({ id,name,grantId,expiresAt }) => ({ id,name,grantId,expiresAt })) });
    if (action === 'approve' && request.method === 'POST') {
      const body = await this.body(request); if (typeof body.id !== 'string' || typeof body.allow !== 'boolean') return json({ error: 'Invalid request.' },400);
      const accepted = await this.state.storage.transaction(async transaction => {
        const pending = await transaction.get<Device[]>('pending') ?? [], device = pending.find(item => item.id === body.id && item.expiresAt > Date.now());
        if (body.allow && (await transaction.get<Device[]>('devices') ?? []).some(item => item.id === body.id && item.expiresAt > Date.now())) return true;
        if (!device) return false;
        if (body.allow) { const devices = (await transaction.get<Device[]>('devices') ?? []).filter(item => item.expiresAt > Date.now()); if (devices.length >= 20) return false; device.expiresAt = Date.now() + 30 * DAY; await transaction.put('devices',[...devices,device]); }
        await transaction.put('pending',pending.filter(item => item.id !== body.id && item.expiresAt > Date.now())); return true;
      });
      return accepted ? json({ ok: true }) : json({ error: 'Request expired.' },409);
    }
    if (action === 'forget' && request.method === 'POST') {
      const device = await this.phone(request,desktopId); if (!device) return json({ error: 'Not connected.' },401);
      await this.state.storage.transaction(async transaction => { const devices = await transaction.get<Device[]>('devices') ?? []; await transaction.put('devices',devices.filter(item => item.id !== device.id)); });
      await this.pushes.remove(device.id);
      for (const socket of this.state.getWebSockets('phone:' + device.id)) { this.send(socket,{ type: 'revoked' }); socket.close(4003,'Forgotten'); }
      return json({ ok: true },200,{ 'Set-Cookie': this.sessionCookie(request,desktopId,'',0) });
    }
    if (action === 'install' || action === 'resume') return json({ error: 'Open the installed app and scan a new encrypted connection code.' },410);
    if (action === 'pairings' && request.method === 'POST') {
      if (!this.desktop()) return json({ error: 'Desktop offline.' }, 409);
      const body = await this.body(request);
      if (typeof body.id !== 'string' || !uuidPattern.test(body.id) || typeof body.conversationId !== 'string' || !uuidPattern.test(body.conversationId) || typeof body.tokenHash !== 'string' || !idPattern.test(body.tokenHash) || body.pinHash !== undefined && (typeof body.pinHash !== 'string' || !idPattern.test(body.pinHash))) return json({ error: 'Invalid invitation.' }, 400);
      const invitation: Invitation = { id: body.id, conversationId: body.conversationId, tokenHash: body.tokenHash, pinHash: body.pinHash as string | undefined, expiresAt: Date.now() + 120000, attempts: 0 };
      await this.state.storage.transaction(async transaction => {
        const invitations = (await transaction.get<Invitation[]>('invitations') ?? []).filter(item => item.expiresAt > Date.now() && item.id !== invitation.id).slice(-4);
        await transaction.put('invitations', [...invitations, invitation]);
      });
      if (typeof body.computerName === 'string') await this.state.storage.put('computer-name',body.computerName.slice(0,120));
      return json({ expiresAt: invitation.expiresAt });
    }
    if (action === 'revoke' && request.method === 'POST') {
      const body = await this.body(request);
      if (typeof body.id !== 'string' || !uuidPattern.test(body.id)) return json({ error: 'Invalid device.' }, 400);
      await this.state.storage.transaction(async transaction => { const devices = await transaction.get<Device[]>('devices') ?? []; await transaction.put('devices', devices.filter(device => device.id !== body.id)); });
      await this.pushes.remove(body.id);
      for (const socket of this.state.getWebSockets(`phone:${body.id}`)) { this.send(socket, { type: 'revoked' }); socket.close(4003, 'Access revoked'); }
      return json({ ok: true });
    }
    if (action === 'pair' && request.method === 'POST') {
      if (!this.desktop()) return json({ error: 'Desktop offline. Open TinyGPT and try again.' }, 409);
      const body = await this.body(request);
      if (typeof body.id !== 'string' || !uuidPattern.test(body.id) || typeof body.token !== 'string' || !idPattern.test(body.token)) return json({ error: 'Invalid pairing link.' },400);
      const existing = await this.pendingPhone(request,desktopId);
      if (existing?.grantId === body.id) return json({ status: 'pending',deviceId: existing.id },202);
      const tokenHash = await hash(body.token), pinHash = typeof body.pin === 'string' ? await hash(body.token + ':' + body.pin) : undefined, session = randomSecret();
      const device: Device = { id: crypto.randomUUID(), name: typeof body.name === 'string' ? body.name.trim().slice(0,60) || 'Phone' : 'Phone', conversationId: '', grantId: body.id, createdAt: Date.now(), expiresAt: Date.now() + 600000, sessionHash: await hash(session) };
      let legacy = false;
      const accepted = await this.state.storage.transaction(async transaction => {
        const invitations = await transaction.get<Invitation[]>('invitations') ?? [], invitation = invitations.find(item => item.id === body.id && item.tokenHash === tokenHash && item.expiresAt > Date.now() && item.attempts < 5);
        if (!invitation) return false;
        invitation.attempts++;
        if (invitation.pinHash && invitation.pinHash !== pinHash) { await transaction.put('invitations',invitations); return false; }
        legacy = false;
        const key = legacy ? 'devices' : 'pending', devices = (await transaction.get<Device[]>(key) ?? []).filter(item => item.expiresAt > Date.now());
        if (devices.length >= 20) return false;
        device.conversationId = invitation.conversationId;
        if (legacy) device.expiresAt = Date.now() + 30 * DAY;
        await transaction.put(key,[...devices,device]); await transaction.put('invitations',invitations.filter(item => item.id !== invitation.id)); return true;
      });
      if (!accepted) return json({ error: 'This code has expired. Scan a new code on your computer.' },403);
      return json({ status: legacy ? 'paired' : 'pending', deviceId: device.id },legacy ? 200 : 202,{ 'Set-Cookie': this.sessionCookie(request,desktopId,session) });
    }
    if ((action === 'connect' || action === 'socket') && request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (request.headers.get('Sec-WebSocket-Protocol') !== 'tinygpt.remote.v2') return json({ error: 'Update TinyGPT to use remote chat.' }, 426);
      let attachment: Attachment;
      if (action === 'connect') attachment = { role: 'desktop' };
      else {
        const device = await this.phone(request, desktopId); if (!device) return json({ error: 'Pair this browser again.' }, 401);
        if (this.state.getWebSockets(`phone:${device.id}`).length >= 3) return json({ error: 'Close another chat tab.' }, 429);
        attachment = { role: 'phone', deviceId: device.id, grantId: device.grantId, conversationId: device.conversationId, connectionId: crypto.randomUUID(), expiresAt: device.expiresAt, window: Date.now(), count: 0 };
      }
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      if (attachment.role === 'desktop') for (const previous of this.state.getWebSockets('desktop')) previous.close(4001, 'Replaced');
      this.state.acceptWebSocket(server, attachment.role === 'desktop' ? ['desktop'] : [`phone:${attachment.deviceId}`, 'phone']); server.serializeAttachment(attachment);
      if (attachment.role === 'desktop') {
        for (const socket of this.state.getWebSockets('phone')) { this.presence(socket, true); }
      } else { this.presence(server, !!this.desktop()); }
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'tinygpt.remote.v2' } });
    }
    return json({ error: 'Not found.' }, 404);
  }
  private presence(socket: WebSocket, online: boolean) {
    const peer = socket.deserializeAttachment() as Attachment;
    if (peer.role === 'phone') this.send(socket, { type: 'presence', online, deviceId: peer.deviceId, grantId: peer.grantId, connectionId: peer.connectionId });
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string' || message.length > 100000) { socket.close(1009, 'Frame too large'); return; }
    try {
      const attachment = socket.deserializeAttachment() as Attachment;
      const data = JSON.parse(message);
      if (attachment.role === 'desktop') {
        if (socket !== this.desktop()) return;
        // Only generic push status/identifiers remain a server-readable control plane.
        if (data.type === 'push-policy') { await this.pushes.policy({ enabled: data.enabled, grants: data.grants }); return; }
        if (data.type === 'notification') { const event = pushEventSchema.safeParse(data.event); if (event.success) { await this.pushes.enqueue(event.data); this.send(socket, { type: 'push-ack', id: event.data.id }); } return; }
        if (!this.envelope(data, true)) { socket.close(1008, 'Encrypted protocol required'); return; }
        for (const phone of this.state.getWebSockets('phone:' + data.deviceId)) {
          const peer = phone.deserializeAttachment() as Attachment;
          if (peer.role === 'phone' && peer.expiresAt > Date.now() && peer.connectionId === data.connectionId && peer.grantId === data.grantId) this.send(phone, { type: data.type, data: data.data });
        }
        return;
      }
      if (attachment.expiresAt <= Date.now() || !(await this.devices()).some(device => device.id === attachment.deviceId)) { socket.close(4003, 'Pair again'); return; }
      if (!this.envelope(data, false)) { socket.close(1008, 'Encrypted protocol required'); return; }
      if (Date.now() - attachment.window > 60000) { attachment.window = Date.now(); attachment.count = 0; attachment.mediaBytes = 0; }
      attachment.count++; attachment.mediaBytes = (attachment.mediaBytes ?? 0) + message.length; socket.serializeAttachment(attachment);
      if (attachment.count > 4000 || attachment.mediaBytes > 128 * 1024 * 1024) { socket.close(1008, 'Transfer limit'); return; }
      const desktop = this.desktop();
      if (!desktop) { this.presence(socket, false); return; }
      this.send(desktop, { type: data.type, data: data.data, deviceId: attachment.deviceId, connectionId: attachment.connectionId, grantId: attachment.grantId });
    } catch { socket.close(1008, 'Invalid encrypted frame'); }
  }
  private envelope(value: any, routed: boolean): boolean {
    const keys = routed ? ['type', 'data', 'desktopId', 'deviceId', 'connectionId', 'grantId'] : ['type', 'data'];
    return value && Object.keys(value).every(key => keys.includes(key)) && ['handshake', 'encrypted'].includes(value.type)
      && typeof value.data === 'string' && value.data.length > 0 && value.data.length <= (value.type === 'handshake' ? 1024 : 80000)
      && value.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
      && (!routed || [value.deviceId, value.connectionId, value.grantId].every(id => typeof id === 'string' && uuidPattern.test(id)));
  }
  async alarm(){await this.pushes.alarm();}
  webSocketClose(socket: WebSocket) {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (attachment?.role === 'phone' && this.desktop()) this.send(this.desktop()!,{ type: 'peer-close', deviceId: attachment.deviceId, connectionId: attachment.connectionId });
    if (attachment?.role === 'desktop' && !this.desktop()) for (const phone of this.state.getWebSockets('phone')) this.presence(phone, false);
    try { socket.close(); } catch {}
  }
  webSocketError(socket: WebSocket) { this.webSocketClose(socket); }
}
