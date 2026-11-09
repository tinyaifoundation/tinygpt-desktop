import assert from 'node:assert/strict';
import { randomUUID, hkdfSync } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import WebSocket from 'ws';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryRoot = join(root, '.tmp'); await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(join(temporaryRoot, 'remote-smoke-'));
const bundle = await build({ absWorkingDir: root, entryPoints: ['remote-relay/src/worker.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
await build({ absWorkingDir: root, entryPoints: ['src/main/remote-service.ts', 'src/main/remote-voice.ts','src/main/remote-media.ts', 'src/core/chat-updates.ts', 'src/shared/remote.ts','src/shared/remote-crypto.ts'], outdir: directory, outExtension: { '.js': '.mjs' }, entryNames: '[name]', bundle: true, format: 'esm', platform: 'node', external: ['ws', 'qrcode', 'noise-handshake', 'noise-handshake/cipher', 'b4a'] });
const { RemoteCipher, keyContext } = await import(pathToFileURL(join(directory, 'remote-crypto.mjs')));
const secureInvites = new Map(), wireFrames = [];
const { RemoteService } = await import(pathToFileURL(join(directory, 'remote-service.mjs')));
const { RemoteMediaBridge } = await import(pathToFileURL(join(directory, 'remote-media.mjs')));
const { RemoteVoiceBridge } = await import(pathToFileURL(join(directory, 'remote-voice.mjs')));
const { REMOTE_APPEARANCE_KEYS } = await import(pathToFileURL(join(directory, 'remote.mjs')));
const { ChatUpdateDecoder } = await import(pathToFileURL(join(directory, 'chat-updates.mjs')));
const mfOptions = convertV4MiniflareOptions({ name: 'tinygpt-remote-smoke', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-02', host: '127.0.0.1', port: 0, log: new Log(LogLevel.ERROR), durableObjects: { DESKTOPS: { className: 'DesktopRelay', useSQLite: true } }, ratelimits: { REQUEST_LIMITER: { namespace_id: '1001', simple: { limit: 1000, period: 60 } } }, assets: { directory: join(root, 'remote-relay/public'), binding: 'ASSETS', run_worker_first: true } });
mfOptions.workers[0].config.assets.hasUserWorker = true;
mfOptions.workers[0].config.assets.htmlHandling = 'none';
const relayOption = process.argv.indexOf('--relay');
const deployedRelay = relayOption >= 0 ? process.argv[relayOption + 1] : '';
if (relayOption >= 0 && (!deployedRelay || new URL(deployedRelay).protocol !== 'https:')) throw Error('--relay requires an HTTPS address');
const mf = deployedRelay ? null : new Miniflare(mfOptions);
const base = deployedRelay ? new URL(deployedRelay).origin : (await mf.ready).origin;
const conversationId = randomUUID(), runId = randomUUID();
let sent = 0, stops = 0, ticker, approved = 0, answered = 0, edited = 0, regenerated = 0;
function makeState(id, mode = 'chat', title = 'Remote smoke conversation') {
 return { conversation: { id, projectId: null, mode, title, createdAt: Date.now(), updatedAt: Date.now(), messages: [], sources: [], tools: [] }, library: { projects: [], conversations: [], lastConversationId: id, activeRuns: [], approvals: [], browserHandoffs: [], workQuestions: [] } };
}
const state = makeState(conversationId), states = new Map([[conversationId, state]]);
let remote;
const uploadBytes=new Map();
const previewPNG=new PNG({width:120,height:72});for(let i=0;i<previewPNG.data.length;i+=4){previewPNG.data[i]=95;previewPNG.data[i+1]=135;previewPNG.data[i+2]=245;previewPNG.data[i+3]=255;}
const previewBytes=PNG.sync.write(previewPNG),previewURL='data:image/png;base64,'+previewBytes.toString('base64');
function append(current, message) { current.conversation.allMessages ??= [...current.conversation.messages]; current.conversation.messages.push(message); current.conversation.allMessages.push(message); }
function beginReply(id) {
  const current = states.get(id), reply = { id: randomUUID(), parentId: current.conversation.messages.at(-1)?.id ?? null, role: 'assistant', text: '', status: 'streaming', error: null, createdAt: Date.now(), runId, route: 'local' };
  append(current, reply); current.library.activeRuns = [{ conversationId: id, runId, phase: 'answer' }];
  clearInterval(ticker); ticker = setInterval(() => { reply.text += reply.text ? 'Streaming… ' : '**Hello from TinyGPT.**\n\nYou’re using the same chat on your phone.\n\n- Live replies\n- Stop and reconnect\n\n'; remote.publish(chat.update(id)); }, 60);
  remote.publish(chat.update(id)); return chat.update(id);
}
const chat = {
 library(){const first=states.keys().next().value;return first?chat.update(first).library:{projects:[],conversations:[],lastConversationId:null,activeRuns:[],approvals:[],browserHandoffs:[]};},
 queueAction(change){const current=states.get(change.conversationId),items=current.conversation.queuedRequests??=[];const item=items.find(item=>item.id===change.id);if(change.action==='resume')current.conversation.queuePaused=false;else if(change.action==='reorder'){assert.deepEqual(new Set(change.ids),new Set(items.map(item=>item.id)));current.conversation.queuedRequests=change.ids.map(id=>items.find(item=>item.id===id));}else{assert.ok(item);if(change.action==='edit'&&change.replacement)Object.assign(item,change.replacement);if(change.action==='remove'||change.action==='steer')current.conversation.queuedRequests=items.filter(value=>value.id!==item.id);if(change.action==='steer')current.conversation.lastSteer=item.text;}remote.publish(chat.update(change.conversationId));return chat.update(change.conversationId);},
 update(id) { const current = states.get(id); assert.ok(current, 'Known conversation'); return structuredClone({ conversation: current.conversation, library: { ...current.library, conversations: [...states.values()].map(item => ({ ...item.conversation, messages: undefined, tools: undefined, sources: undefined })).reverse(), activeRuns: [...states.values()].flatMap(item => item.library.activeRuns), approvals: [...states.values()].flatMap(item => item.library.approvals), workQuestions: [...states.values()].flatMap(item => item.library.workQuestions) } }); },
 send(id, text, attachments, pinMode) {
  assert.equal(pinMode, true, 'Remote sends must pin the explicit conversation mode'); sent++;
  const current = states.get(id); assert.ok(current);
  if((process.argv.includes('--phase1')||process.argv.includes('--phase2'))&&current.library.activeRuns.length){(current.conversation.queuedRequests??=[]).push({id:randomUUID(),text,attachmentIds:attachments,createdAt:Date.now(),lane:'queue'});remote.publish(chat.update(id));return chat.update(id);}
  append(current, { id: randomUUID(), parentId: current.conversation.messages.at(-1)?.id ?? null, role: 'user', text, attachmentIds:attachments, status: 'complete', error: null, createdAt: Date.now(), runId: null, route: 'local' });
  for(const source of current.conversation.sources)if(attachments.includes(source.id))source.messageId=current.conversation.messages.at(-1).id;
  return beginReply(id);
 },
 async cancel(id) { const current = states.get(id); assert.ok(current); stops++; clearInterval(ticker); const reply = current.conversation.messages.at(-1); if (reply?.role === 'assistant') reply.status = 'cancelled'; current.library.activeRuns = []; remote.publish(chat.update(id)); return chat.update(id); },
 async answerWorkQuestion(input) { const current = [...states.values()].find(item => item.library.workQuestions.some(question => question.id === input.questionId)); assert.ok(current); answered++; current.library.workQuestions = []; remote.publish(chat.update(current.conversation.id)); return chat.update(current.conversation.id); },
};
const actions = {
 toolIconKeys(){return {'ext_fixture_mail':'gmail/search_mail'};},
 rename(id,title){states.get(id).conversation.title=title;},
 organize(id,action,value){states.get(id).conversation[action==='pin'?'pinned':'archived']=value;},
 async delete(id){assert.equal(states.get(id).library.activeRuns.length,0);states.delete(id);},
 notifications(){return [...states.values()].flatMap(item=>item.conversation.messages.filter(message=>message.role==='assistant'&&message.status==='complete').slice(-1).map(message=>({id:message.id,conversationId:item.conversation.id,title:'Reply ready',conversationTitle:item.conversation.title,createdAt:Date.now(),read:false})));},readNotification(){},
 validateAttachments(id,ids){for(const sourceId of ids)assert.ok(states.get(id).conversation.sources.some(source=>source.id===sourceId&&!source.messageId));},
 async create(mode) { const id = randomUUID(); states.set(id, makeState(id, mode, mode === 'code' ? 'New Work' : 'New Chat')); return chat.update(id); },
 async approve(id, decision) { const current = [...states.values()].find(item => item.library.approvals.some(approval => approval.id === id)); assert.ok(current); assert.equal(decision, 'allow-once'); approved++; current.library.approvals = []; remote.publish(chat.update(current.conversation.id)); },
 async edit(id, messageId, text) { const current = states.get(id), index = current.conversation.messages.findIndex(message => message.id === messageId && message.role === 'user'); assert.ok(index >= 0); edited++; current.conversation.messages = current.conversation.messages.slice(0,index); return chat.send(id,text,[],true); },
 async regenerate(id, messageId) { const current = states.get(id), index = current.conversation.messages.findIndex(message => message.id === messageId && message.role === 'assistant'); assert.ok(index >= 0); regenerated++; current.conversation.messages = current.conversation.messages.slice(0,index); return beginReply(id); },
 async branch(id, messageId) { const current = states.get(id), byId = new Map(current.conversation.allMessages.map(message => [message.id,message])), path = []; let message = byId.get(messageId); assert.ok(message); while (message) { path.unshift(message); message = byId.get(message.parentId); } current.conversation.messages = path; remote.publish(chat.update(id)); return chat.update(id); },
};
const encryption = { available: () => true, encrypt: value => Buffer.from(value), decrypt: bytes => bytes.toString() };
let microphoneOwner, microphoneId, microphoneFrames = 0, voiceCancelled = 0;
const speechOwners = new Map();
function audiblePCM(length){const bytes=new Uint8Array(length),view=new DataView(bytes.buffer);for(let i=0;i<length/2;i++)view.setInt16(i*2,Math.round(Math.sin(i*2*Math.PI*440/24000)*6000),true);return bytes;}
const fixtureVoice = new RemoteVoiceBridge({
 async start(id,_rate,owner) { microphoneOwner = owner; microphoneId = id; owner.send('tinygpt:dictation-event',{ id,phase: 'listening' }); },
 audio(id,owner,bytes) { assert.equal(owner,microphoneOwner); assert.equal(id,microphoneId); assert.ok(bytes.length > 0); microphoneFrames++; owner.send('tinygpt:dictation-event',{ id,phase: 'listening',text: 'Voice message from phone' }); },
 async stop(id,owner,cancel) { assert.equal(owner,microphoneOwner); if (!cancel) owner.send('tinygpt:dictation-event',{ id,phase: 'finishing',text: 'Voice message from phone.' }); owner.send('tinygpt:dictation-event',{ id,phase: 'stopped' }); },
},{
 async preview(jobId,owner){speechOwners.set(owner,jobId);return {audio:audiblePCM(24000),mime:'audio/wav',chunks:1,stream:{sampleRate:24000,done:false}};},
 async read(request,owner) { assert.ok(states.get(request.conversationId).conversation.messages.some(message => message.id === request.messageId && message.role === 'assistant' && message.status === 'complete')); speechOwners.set(owner,request.jobId); return { audio: audiblePCM(24000),mime: 'audio/wav',chunks: 1,stream: { sampleRate: 24000,done: false } }; },
 async nextStream(jobId,owner,sequence) { assert.equal(speechOwners.get(owner),jobId); await new Promise(resolve => setTimeout(resolve,30)); return { audio: audiblePCM(sequence < 20 ? 24000 : 0),mime: 'audio/wav',chunks: 1,stream: { sampleRate: 24000,done: sequence >= 20 } }; },
 cancel(_jobId,owner) { voiceCancelled++; speechOwners.delete(owner); }, cancelOwner(owner) { speechOwners.delete(owner); },
},() => ({ dictation: { enabled: true },readAloud: { enabled: true,speed: 1,selection: { connectionId: '00000000-0000-4000-8000-000000000083',model: 'pocket-tts' } } }));
const fixtureMedia=new RemoteMediaBridge({
 presentation(id,toolId){const tool=states.get(id)?.conversation.tools.find(tool=>tool.id===toolId&&tool.name==='present');assert.ok(tool);return {ui:JSON.parse(tool.result).ui,partial:false};},
 async importFile(id,name,bytes){if(name==='retry-note.txt')await new Promise(resolve=>setTimeout(resolve,700));const source={id:randomUUID(),conversationId:id,projectId:null,kind:name.endsWith('.png')?'image':'attachment',title:name,url:null,mime:name.endsWith('.png')?'image/png':'text/plain',size:bytes.length,createdAt:Date.now(),messageId:null};states.get(id).conversation.sources.push(source);uploadBytes.set(source.id,bytes);return {sourceId:source.id,title:name,mime:source.mime,size:source.size};},
 remove(id,sourceId){const current=states.get(id);assert.ok(current.conversation.sources.some(source=>source.id===sourceId&&!source.messageId));current.conversation.sources=current.conversation.sources.filter(source=>source.id!==sourceId);uploadBytes.delete(sourceId);},
 preview(id,toolId){assert.ok(states.get(id).conversation.tools.some(tool=>tool.id===toolId&&['browser_screenshot','view_image'].includes(tool.name)));return {image:previewURL,title:'Saved screenshot',width:120,height:72};},
 attachmentPreview(id,sourceId,full){const current=states.get(id),source=current.conversation.sources.find(source=>source.id===sourceId);assert.ok(source?.mime.startsWith('image/')&&current.conversation.messages.some(message=>message.attachmentIds?.includes(sourceId)));return {image:previewURL,title:source.title,width:120,height:72};}
});
remote = new RemoteService(join(directory, 'profile'), encryption, chat, '', () => {}, actions, fixtureVoice,undefined,fixtureMedia);
const inferenceConnection=randomUUID(),includedConnection=randomUUID(),proConnection=randomUUID(),inferenceState={connectionId:inferenceConnection,model:'fixture-first',name:'First model',effort:{chat:'medium',code:'high'},connections:[{id:inferenceConnection,name:'Test provider',provider:'custom'},{id:proConnection,name:'TinyGPT Pro',provider:'local',builtIn:'pro'},{id:includedConnection,name:'Mini CPM 5 2B 64K',provider:'local',builtIn:'included'}]};
let inferenceChanges=0,effortChanges=0;
const installInference=()=>{if(process.argv.includes('--inference')||process.argv.includes('--phase2'))remote.setInference({state:()=>structuredClone(inferenceState),models:async id=>({models:id===includedConnection?[{id:'tinygpt-included',name:'Mini CPM 5 2B 64K'}]:id===proConnection?[{id:'tinygpt-pro',name:'TinyGPT Pro'}]:[{id:'fixture-first',name:'First model'},{id:'fixture-second',name:'Second model'},{id:'fixture-unavailable',name:'Unavailable model'}]}),select:async(_id,model,authorized)=>{await new Promise(resolve=>setTimeout(resolve,350));authorized();if(model==='fixture-unavailable')throw Error('This model is unavailable. Choose another model.');inferenceState.model=model;inferenceState.name=model==='fixture-second'?'Second model':'First model';inferenceChanges++;},effort:async(mode,effort,authorized)=>{authorized();inferenceState.effort[mode]=effort;effortChanges++;}});};installInference();

let phase2Fixture=process.argv.includes('--phase2')?(await import('./mobile-phase2-fixture.mjs')).installMobilePhase2Fixture({remote,chat,states,actions,makeState}):null;
const peers = [], extraRemotes = [];
function peer(url, headers) {
  const socket = new WebSocket(url, 'tinygpt.remote.v2', { headers }); const inbox = [], waiting = [];
  let cipher, pendingPresence;
  socket.on('message', raw => {
    if (raw.toString() === 'pong') return;
    wireFrames.push(raw.toString()); let value = JSON.parse(raw.toString());
    if (value.type === 'presence' && value.online) {
      cipher?.destroy(); const keys = secureInvites.get(value.grantId); assert.ok(keys, 'Known QR-only key');
      cipher = new RemoteCipher(true, keys.psk, { desktopId: keys.desktop, deviceId: value.deviceId, grantId: value.grantId, connectionId: value.connectionId });
      socket.send(JSON.stringify({type:'handshake',data:cipher.start()})); pendingPresence = value; return;
    } else if (value.type === 'handshake') {
      cipher.handshakeMessage(value.data); result.send({id:randomUUID(),op:'get'}); value = pendingPresence;
    } else if (value.type === 'encrypted') { value = cipher.open(value.data); if (value === undefined) return; }
    inbox.push(value); for (const wake of [...waiting]) wake();
  });
  const opened = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const next = async (predicate, timeoutMs = 10000) => {
    const find = () => inbox.findIndex(predicate); let index = find(); if (index >= 0) return inbox.splice(index, 1)[0];
    return new Promise((resolve, reject) => { const timeout = setTimeout(() => { waiting.splice(waiting.indexOf(check), 1); reject(Error('Timed out: '+predicate.toString()+'; inbox='+JSON.stringify(inbox.map(item=>({type:item.type,ok:item.ok,error:item.error}))))); }, timeoutMs); const check = () => { index = find(); if (index >= 0) { clearTimeout(timeout); waiting.splice(waiting.indexOf(check), 1); resolve(inbox.splice(index, 1)[0]); } }; waiting.push(check); });
  };
  const result = { socket, opened, next, send: value => { for (const data of cipher.seal(value)) { const frame = JSON.stringify({type:'encrypted',data}); wireFrames.push(frame); socket.send(frame); } } }; peers.push(result); return result;
}
function invitationFields(invitation) { return Object.fromEntries(new URLSearchParams(new URL(invitation.url).hash.slice(1))); }
async function pair(invitation, override = {}, origin = new URL(invitation.url).origin) {
  const fields = invitationFields(invitation);
  secureInvites.set(fields.invitation, { desktop: fields.desktop, psk: Buffer.from(hkdfSync('sha256',Buffer.from(fields.key,'hex'),Buffer.from('tinygpt-remote-v2'),Buffer.from(keyContext(fields.desktop,fields.invitation)),32)).toString('hex') });
  return fetch(`${new URL(invitation.url).origin}/api/d/${fields.desktop}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ id: fields.invitation, token: fields.token, name: 'Smoke phone', ...override }) });
}
try {
  const page = await fetch(base); if (page.status !== 200) console.error('Page failure:', await page.clone().text()); assert.equal(page.status, 200); assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/); assert.match(await page.text(), /mobile/);
  const invitation = await remote.pair(conversationId, base), fields = invitationFields(invitation);
  assert.match(invitation.qr, /^data:image\/png;base64,/);
  assert.equal((await fetch(`${base}/api/d/${fields.desktop}/devices`)).status, 401);
  assert.equal((await fetch(base+'/api/d/'+fields.desktop+'/push',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({op:'remove',clientId:randomUUID()})})).status,401);
  assert.equal((await fetch(base+'/api/d/'+fields.desktop+'/push',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://attacker.example'},body:'{}'})).status,403);
  assert.equal((await pair(invitation, {}, 'https://attacker.example')).status, 403);
  assert.equal((await pair(invitation, { token: '0'.repeat(64) })).status, 403);
  const paired = await pair(invitation); assert.equal(paired.status, 202);
  const cookie = paired.headers.get('Set-Cookie').split(';')[0], device = await paired.json();
  const unauthorized = await new Promise((resolve,reject) => { const socket = new WebSocket(`${base.replace(/^http/,'ws')}/api/d/${fields.desktop}/socket`,'tinygpt.remote.v2',{ headers: { Cookie: cookie,Origin: base } }); socket.once('unexpected-response',(_request,response) => { response.resume(); socket.terminate(); resolve(response.statusCode); }); socket.once('error',reject); socket.once('open',()=>{socket.close();reject(Error('Pending device was authorized'))}); }); assert.equal(unauthorized,401,'Pending devices cannot control the desktop');
  assert.equal((await fetch(`${base}/api/d/${fields.desktop}/session`,{ headers: { Cookie: cookie } }).then(r=>r.json())).status,'pending');
  await remote.approvePairing(device.deviceId,true);
  assert.match(paired.headers.get('Set-Cookie'), /HttpOnly/); assert.match(paired.headers.get('Set-Cookie'), /SameSite=Strict/);
  assert.equal((await pair(invitation)).status, 403);
  const socketUrl = `${base.replace(/^http/, 'ws')}/api/d/${fields.desktop}/socket`;
  let phone = peer(socketUrl, { Cookie: cookie, Origin: base }); await phone.opened;
  await phone.next(value => value.type === 'presence' && value.online);
  const decoder = new ChatUpdateDecoder();
  let frame = await phone.next(value => value.type === 'packet'); assert.equal(decoder.decode(frame.packet).conversation.id, conversationId);
  const command = { id: randomUUID(), op: 'send', text: 'Hello from the phone' }; phone.send(command);
  const routedReply = await phone.next(value => value.type === 'reply' && value.requestId === command.id && value.ok);
  assert.equal(routedReply.connectionId,frame.connectionId,'Normal commands and reconnect snapshots must use the same socket subscription');
  assert.equal(remote.subscriptions.size,1,'One phone socket must have exactly one desktop subscription');
  phone.send(command); await phone.next(value => value.type === 'reply' && value.requestId === command.id && value.ok); assert.equal(sent, 1);
  let streamed = false;
  for (let i = 0; i < 12; i++) { frame = await phone.next(value => value.type === 'packet'); const update = decoder.decode(frame.packet); if (update.conversation.messages.at(-1)?.text.includes('Hello from TinyGPT')) { streamed = true; break; } }
  assert.ok(streamed, 'reply should stream through the real Worker');
  const stop = { id: randomUUID(), op: 'stop' }; phone.send(stop); await phone.next(value => value.type === 'reply' && value.requestId === stop.id && value.ok); assert.equal(stops, 1);
  phone.socket.close(); phone = peer(socketUrl, { Cookie: cookie, Origin: base }); await phone.opened;
  await phone.next(value => value.type === 'presence' && value.online);
  frame = await phone.next(value => value.type === 'packet'); assert.equal(new ChatUpdateDecoder().decode(frame.packet).conversation.messages.at(-1).status, 'cancelled');
  remote.close(); await phone.next(value => value.type === 'presence' && !value.online);
  remote = new RemoteService(join(directory, 'profile'), encryption, chat, '', () => {}, actions, fixtureVoice,undefined,fixtureMedia); installInference(); if(process.argv.includes('--phase2'))phase2Fixture=(await import('./mobile-phase2-fixture.mjs')).installMobilePhase2Fixture({remote,chat,states,actions,makeState}); await remote.load();
  await phone.next(value => value.type === 'presence' && value.online);
  phone.send(command); await phone.next(value => value.type === 'reply' && value.requestId === command.id && value.ok); assert.equal(sent, 1, 'deduplication must survive desktop restart');
  if (process.argv.includes('--reconnect')) {
    remote.socket.pause();
    await phone.next(value => value.type === 'presence' && !value.online,40000);
    await phone.next(value => value.type === 'presence' && value.online,15000);
    phone.send(command); await phone.next(value => value.type === 'reply' && value.requestId === command.id && value.ok);
    assert.equal(sent,1); assert.equal(remote.status().connected,true);
    console.log('Silent network-drop recovery passed: heartbeat detected a stalled socket, reconnected automatically, preserved pairing and deduplicated the retried send.');
  }
  const path = `/api/d/${fields.desktop}/devices`, headers = remote.headers('GET', path);
  assert.equal((await fetch(base + path, { headers })).status, 200); assert.equal((await fetch(base + path, { headers })).status, 401, 'signed HTTP replay must fail');
  await remote.revoke(device.deviceId); await phone.next(value => value.type === 'revoked');
  assert.equal((await fetch(`${base}/api/d/${fields.desktop}/session`, { headers: { Cookie: cookie } })).status, 401);
  if(process.argv.includes('--bot')){const {checkMobileBot}=await import('./mobile-bot-browser.mjs');await checkMobileBot({base,remote,chat,states,actions,makeState,conversationId});}
  if (process.argv.includes('--onboarding')) { const {checkMobileOnboarding}=await import('./remote-onboarding-browser.mjs');await checkMobileOnboarding({base,remote,conversationId,directory}); }
  if(process.argv.includes('--phase2')){const {checkMobilePhase2}=await import('./mobile-phase2-browser.mjs');await checkMobilePhase2({base,remote,chat,states,conversationId,fixture:phase2Fixture});}
  if (process.argv.includes('--phase1')) { const {checkMobilePhase1}=await import('./mobile-phase1-browser.mjs'); await checkMobilePhase1({base,remote,chat,states,conversationId,directory}); }
  if (process.argv.includes('--e2e')) { const {checkEncryptedMobile} = await import('./remote-e2e-browser.mjs'); await checkEncryptedMobile({base,remote,chat,states,conversationId,directory,previewBytes,uploadBytes,voiceStats:()=>({microphoneFrames,voiceCancelled})}); }
  if (process.argv.includes('--ui')) {
    if (process.argv.includes('--stream-stability')) remote.setAppearance({theme:'light',variables:{'--background':'#ffffff','--foreground':'#1a1c1f'}});
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'], ...(process.env.TINYGPT_BROWSER_EXECUTABLE ? { executablePath: process.env.TINYGPT_BROWSER_EXECUTABLE } : {}) });
    try {
      const safariUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,userAgent: safariUA });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const invitation = await remote.pair(conversationId, base);
      await page.goto(invitation.url);
      await page.getByRole('status').filter({ hasText: 'Approve on' }).waitFor();
      await page.screenshot({ path: join(directory,'mobile-approval.png') });
      const pending = (await remote.refreshDevices()).requests.find(item=>item.grantId === invitation.id); assert.ok(pending);
      const installed = await browser.newContext({ viewport: { width: 390,height: 844 },isMobile: true,hasTouch: true,storageState: { cookies: await context.cookies(),origins: [] } }), installedPage = await installed.newPage();
      await installedPage.goto(base + '/app/'); await installedPage.getByRole('heading',{ name: 'One tap on your computer.',exact: true }).waitFor();
      await remote.approvePairing(pending.id,true);
      await installedPage.getByRole('status').filter({ hasText: 'Connected' }).waitFor(); await installed.close();
      assert.ok(!page.url().includes(invitationFields(invitation).token), 'QR secret must be removed from address bar');
      await page.getByRole('status').filter({ hasText: 'Connected to' }).waitFor();
      await page.evaluate(() => Promise.race([navigator.serviceWorker.ready,new Promise((_,reject) => setTimeout(() => reject(Error('PWA service worker did not activate')),8000))]));
      assert.equal(await page.locator('.install-connect').count(),0,'Paired guide should not leave an empty connection card');
      await page.screenshot({ path: join(directory,'install-guide.png') });
      const guideDesktop = invitationFields(invitation).desktop;
      const manifest = await (await context.request.get(`${base}/manifest.webmanifest?desktop=${guideDesktop}`)).json();
      assert.equal(manifest.display,'standalone'); assert.equal(manifest.start_url,'/app/');
      await context.grantPermissions(['clipboard-read','clipboard-write','microphone'],{ origin: base });
      assert.equal(await page.getByRole('tablist',{name:'Your phone'}).count(),0,'Phone platform is detected automatically');
      assert.equal(await page.locator('.install-browser-help').count(),0);
      const braveContext = await browser.newContext({ viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:safariUA + ' Brave/1',storageState:{cookies:await context.cookies(),origins:[]} });
      await braveContext.grantPermissions(['clipboard-read','clipboard-write'],{origin:base}); const bravePage = await braveContext.newPage();
      await bravePage.goto(base); await bravePage.getByRole('heading',{name:'Open in Safari.',exact:true}).waitFor();
      await bravePage.getByRole('status').filter({hasText:'Connected to'}).waitFor();
      await bravePage.screenshot({path:join(directory,'mobile-brave-handoff.png')});
      await bravePage.getByRole('button',{name:'Copy link for Safari',exact:true}).click(); await bravePage.getByRole('button',{name:'Link copied',exact:true}).waitFor();
      const setupURL = await bravePage.evaluate(() => navigator.clipboard.readText()), setupToken = new URLSearchParams(new URL(setupURL).hash.slice(1)).get('handoff'); assert.ok(setupToken);
      await braveContext.close();
      const android = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'}), androidPage = await android.newPage();
      await androidPage.goto(base); await androidPage.locator('.install-steps li > p').filter({hasText:'Menu'}).waitFor(); assert.equal(await androidPage.locator('.install-steps li > p').filter({hasText:'Menu'}).count(),1); assert.equal(await androidPage.getByRole('tablist',{name:'Your phone'}).count(),0); await androidPage.screenshot({path:join(directory,'mobile-android-guide.png')}); await android.close();
      const cold = await browser.newContext({ viewport: { width: 390,height: 844 },isMobile: true,hasTouch: true }), coldPage = await cold.newPage();
      await coldPage.goto(`${base}/app/#desktop=${guideDesktop}&handoff=${setupToken}`);
      await coldPage.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
      assert.ok(!coldPage.url().includes(setupToken),'Install token must be scrubbed from the address bar');
      assert.equal((await cold.request.post(`${base}/api/d/${guideDesktop}/resume`,{ headers: { Origin: base },data: { token: setupToken } })).status(),403,'Setup links must be single use');
      await coldPage.evaluate(() => navigator.serviceWorker.ready);
      await coldPage.waitForFunction(() => !!navigator.serviceWorker.controller);
      await cold.setOffline(true); await coldPage.reload(); await coldPage.getByText('You’re offline.',{ exact: true }).waitFor();
      await cold.setOffline(false);
      await cold.close();
      await page.getByRole('button', { name: 'Continue in browser', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor({ timeout: 10000 }).catch(async error => { console.error('Companion load:',page.url(),await page.locator('body').innerText(),errors); await page.screenshot({ path: join(directory,'failed-companion.png') }); throw error; });
      await page.locator('.thread-message').first().waitFor();
      assert.ok(!await page.evaluate(() => document.cookie.includes('tg_')), 'session cookie must be HttpOnly');
      if (process.argv.includes('--stream-stability')) {
        const appearance = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key,getComputedStyle(document.documentElement).getPropertyValue(key).trim() || 'initial'])),REMOTE_APPEARANCE_KEYS);
        remote.setAppearance({theme:'light',variables:appearance});
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--user-ui-font') !== '');
      }
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Send from mobile UI');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      await page.locator('.thread-message').last().locator('.chat-prose').filter({ hasText: 'Hello from TinyGPT' }).waitFor();
      if (process.argv.includes('--stream-stability')) {
        const metrics = await page.evaluate(async () => {
          const row = [...document.querySelectorAll('[data-message-id]')].at(-1), id = row.dataset.messageId, firstParagraph = row.querySelector('.chat-prose p');
          let frames = 0, blankFrames = 0, replacedRows = 0, replacedParagraphs = 0, shortened = 0, rootMutations = 0, previous = row.querySelector('.chat-prose')?.textContent ?? '', previousLength = previous.length;
          const observer = new MutationObserver(records => { rootMutations += records.length; }); observer.observe(document.documentElement,{ attributes: true,attributeFilter: ['style','data-theme'] }); const themeMeta = document.querySelector('meta[name="theme-color"]'); if (themeMeta) observer.observe(themeMeta,{attributes:true,attributeFilter:['content']});
          await new Promise(resolve => { const deadline = performance.now() + 1600; const frame = () => {
            frames++; const current = document.querySelector('[data-message-id="' + id + '"]'), text = current?.querySelector('.chat-prose')?.textContent ?? '';
            if (!text) blankFrames++; if (current !== row) replacedRows++; if (firstParagraph && current?.querySelector('.chat-prose p') !== firstParagraph) replacedParagraphs++;
            if (text.length < previousLength) shortened++; previousLength = text.length;
            if (performance.now() < deadline) requestAnimationFrame(frame); else resolve();
          }; requestAnimationFrame(frame); }); observer.disconnect(); return { frames,blankFrames,replacedRows,replacedParagraphs,shortened,rootMutations,grewBy:previousLength - previous.length };
        });
        console.log('Stream stability:',JSON.stringify(metrics));
        assert.ok(metrics.grewBy > 0,'The probe must observe actual incoming text');
        assert.equal(metrics.blankFrames,0,'Streaming answer must never disappear'); assert.equal(metrics.replacedRows,0,'Streaming message must retain its DOM'); assert.equal(metrics.replacedParagraphs,0,'Completed Markdown blocks must not remount'); assert.equal(metrics.shortened,0,'Streaming text must not rewind'); assert.equal(metrics.rootMutations,0,'Stream packets must not rewrite the page theme');
      }
      if (process.argv.includes('--selection-stability')) {
        const pinned = await actions.create('chat'), pinnedId = pinned.conversation.id;
        const pinnedState = states.get(pinnedId); pinnedState.conversation.title = 'Pinned mobile chat';
        pinnedState.conversation.messages = [{id:randomUUID(),role:'assistant',text:'Stay in this conversation.',status:'complete',error:null,createdAt:Date.now(),runId:null,route:'local'}];
        remote.publish(chat.update(conversationId));
        await page.getByRole('button',{name:'Expand sidebar',exact:true}).click(); await page.getByRole('button',{name:/^Pinned mobile chat/}).click();
        await page.getByText('Stay in this conversation.',{exact:true}).waitFor();
        const changed = await page.evaluate(async id => {
          let wrong = 0; const deadline = performance.now() + 1500;
          await new Promise(resolve=>{const frame=()=>{if(document.querySelector('.mobile-thread')?.getAttribute('data-conversation-id')!==id)wrong++;if(performance.now()<deadline)requestAnimationFrame(frame);else resolve();};requestAnimationFrame(frame)});return wrong;
        },pinnedId); assert.equal(changed,0,'Another streaming conversation must not replace the selected chat');
        assert.deepEqual([...remote.subscriptions.values()].map(item=>item.conversationId),[pinnedId]);
        await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow'))); await page.getByText('Stay in this conversation.',{exact:true}).waitFor();
        remote.socket.terminate(); await page.getByRole('status').filter({hasText:'Disconnected'}).waitFor(); await page.getByRole('status').filter({hasText:'Connected'}).waitFor();
        await page.waitForFunction(id=>document.querySelector('.mobile-thread')?.getAttribute('data-conversation-id')===id,pinnedId);
        const second = await context.newPage(); await second.goto(base + '/app/'); await second.getByRole('status').filter({hasText:'Connected'}).waitFor();
        await second.getByRole('button',{name:'Expand sidebar',exact:true}).click(); await second.getByRole('button',{name:/^Remote smoke conversation/}).click();
        await second.getByRole('button',{name:'Stop reply',exact:true}).waitFor();
        assert.equal(await page.locator('.mobile-thread').getAttribute('data-conversation-id'),pinnedId,'A second tab must not change the first tab selection');
        await second.close();
        await page.getByRole('button',{name:'Expand sidebar',exact:true}).click(); await page.getByRole('button',{name:/^Remote smoke conversation/}).click();
        await page.getByRole('button',{name:'Stop reply',exact:true}).waitFor();
        console.log('Selection stability passed: background streaming, foreground wake, desktop socket reconnect, and independent same-device tabs.');
      }
      await page.screenshot({ path: join(directory, 'mobile-light.png') });
      await page.getByRole('button', { name: 'Stop reply', exact: true }).click();
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      assert.equal(sent, 2); assert.equal(stops, 2);
      if(process.argv.includes('--inference')){
        await page.getByRole('button',{name:'Model and effort',exact:true}).click();
        const slider=page.getByRole('slider',{name:'Level of effort',exact:true});
        for(const [width,height] of [[320,568],[390,844],[768,1024]]){
          await page.setViewportSize({width,height});await page.waitForTimeout(80);
          const composer=await page.locator('.mobile-composer').boundingBox(),popover=await page.locator('.mobile-inference-popover').boundingBox();assert.ok(Math.abs(composer.x+composer.width/2-popover.x-popover.width/2)<1,'Popover must be centered over the composer at '+width+'px');
        }
        await page.setViewportSize({width:390,height:844});
        const box=await slider.boundingBox(),thumb=34,start=box.x+box.width/2,point=fraction=>box.x+thumb/2+(box.width-thumb)*fraction;
        await page.mouse.move(start,box.y+box.height/2);await page.mouse.down();await page.mouse.move(point(.64),box.y+box.height/2,{steps:14});
        const moving=Number(await slider.inputValue());assert.ok(moving>55&&moving<70&&moving%25!==0,'Thumb should move continuously between effort stops');assert.equal(effortChanges,0,'Do not save while dragging');
        await page.screenshot({path:join(directory,'mobile-effort-drag.png')});await page.mouse.up();await page.waitForFunction(()=>document.querySelector('.mobile-inference-trigger')?.getAttribute('title')?.endsWith('High'));assert.equal(inferenceState.effort.chat,'high');assert.equal(effortChanges,1);
        await slider.focus();await slider.press('End');
        await page.waitForFunction(()=>document.querySelector('[aria-label="Model and effort"].mobile-inference-trigger')?.getAttribute('title')?.endsWith('Max'));assert.equal(inferenceState.effort.chat,'max');assert.equal(inferenceState.effort.code,'high');assert.equal(effortChanges,2);
        assert.equal(await page.locator('.effort-max-star').count(),14);assert.equal(await page.locator('.effort-max-star').first().evaluate(el=>getComputedStyle(el).animationName),'effort-star-flight');assert.equal(await slider.evaluate(el=>el.getBoundingClientRect().height),34);
        const level=await page.locator('.effort-popover-value').boundingBox(),model=await page.locator('.mobile-inference-popover .composer-model-trigger').boundingBox();assert.ok(model.y-level.y-level.height<=3,'Effort and model labels should sit close together');
        await page.screenshot({path:join(directory,'mobile-effort.png')});
        await page.getByRole('button',{name:'Choose model: First model',exact:true}).click();
        const builtIns=page.getByRole('group',{name:'TinyGPT',exact:true});await builtIns.getByRole('option',{name:'TinyGPT',exact:true}).waitFor();await builtIns.getByRole('option',{name:'TinyGPT Pro',exact:true}).waitFor();assert.equal(await builtIns.count(),1);assert.deepEqual(await builtIns.getByRole('option').allTextContents(),['TinyGPT','TinyGPT Pro']);assert.equal(await page.getByRole('group',{name:'TinyGPT Pro',exact:true}).count(),0);assert.equal(await builtIns.locator('h3 svg').count(),1);assert.ok(!(await page.locator('.mobile-model-list').innerText()).includes('Mini CPM'));await page.screenshot({path:join(directory,'mobile-models-grouped.png')});
        await page.getByRole('option',{name:'Unavailable model',exact:true}).click();await page.getByRole('alert').filter({hasText:'This model is unavailable'}).waitFor();assert.equal(inferenceState.model,'fixture-first');
        await page.getByRole('textbox',{name:'Search models',exact:true}).fill('second');await page.screenshot({path:join(directory,'mobile-models.png')});
        await page.getByRole('option',{name:'Second model',exact:true}).click();await page.getByRole('button',{name:'Choose model: Second model',exact:true}).waitFor();assert.equal(inferenceChanges,1);assert.equal(inferenceState.model,'fixture-second');
        await page.keyboard.press('Escape');await page.reload();await page.getByRole('status').filter({hasText:'Connected'}).waitFor();await page.getByRole('button',{name:'Model and effort',exact:true}).click();await page.getByRole('button',{name:'Choose model: Second model',exact:true}).waitFor();assert.equal(await page.getByRole('slider',{name:'Level of effort',exact:true}).getAttribute('aria-valuetext'),'Max');await page.keyboard.press('Escape');
        console.log('Mobile inference passed: authenticated catalogs, failed switch feedback, model activation, effort persistence and reconnect.');
      }
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected'), 'true');
      assert.equal(await page.locator('.mobile-toolbar [role="tablist"]').count(), 1);
      assert.equal(await page.locator('.mobile-composer-note').count(), 0);
      for (const [width, height] of [[320,568], [390,844], [768,1024], [390,400]]) {
        await page.setViewportSize({ width, height });
        const greeting = await page.locator('.conversation-greeting').boundingBox(), composer = await page.locator('.mobile-composer').boundingBox(), viewport = await page.locator('.thread-viewport').boundingBox();
        assert.ok(greeting && composer && viewport);
        assert.ok(composer.y >= greeting.y + greeting.height - 1 && composer.y - greeting.y - greeting.height < 8, 'Composer follows the greeting directly');
        assert.ok(Math.abs((greeting.y + composer.y + composer.height) / 2 - viewport.y - viewport.height / 2) < 5, `New conversation group is centered at ${width}×${height}`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const icon = await page.getByRole('button', { name: 'Expand sidebar', exact: true }).locator('svg').boundingBox(); assert.ok(icon.width >= 22 && icon.height >= 22);
      await page.screenshot({ path: join(directory, 'mobile-new-chat.png') });
      await page.getByRole('button', { name: 'Dictate message', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value.includes('Voice message from phone'));
      await page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
      await page.getByRole('button', { name: 'Dictate message', exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),'Voice message from phone.'); assert.ok(microphoneFrames > 0);
      await page.getByRole('button', { name: 'Dictate message',exact: true }).click();
      await page.getByRole('button', { name: 'Stop dictation',exact: true }).waitFor();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await page.getByRole('button', { name: 'Dictate message',exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Work', exact: true }).click();
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Work from phone');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      const workState = [...states.values()].at(-1); assert.equal(workState.conversation.mode, 'code');
      workState.library.approvals = [{ id: randomUUID(), conversationId: workState.conversation.id, runId, name: 'read_project_file', summary: 'Read the fixture file', details: 'Read only the fixture document.' }]; remote.publish(chat.update(workState.conversation.id));
      await page.getByRole('button', { name: 'Allow once', exact: true }).click(); await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ state: 'hidden' }); assert.equal(approved, 1);
      workState.library.workQuestions = [{ id: randomUUID(), taskId: randomUUID(), conversationId: workState.conversation.id, messageId: workState.conversation.messages.at(-1).id, operationId: randomUUID(), question: 'Which report format?', options: [{ id: 'short', label: 'Short report' }], status: 'pending', createdAt: Date.now() }]; remote.publish(chat.update(workState.conversation.id));
      await page.getByText('Which report format?', { exact: true }).waitFor();
      await page.getByRole('radio').filter({ hasText: 'Short report' }).click();
      await page.getByRole('button', { name: 'Submit answer', exact: true }).click();
      await page.locator('[data-slot="work-question"]').waitFor({ state: 'hidden' }); assert.equal(answered, 1);
      await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      await page.locator('.mobile-sidebar-brand').getByText('TinyGPT', { exact: true }).waitFor();
      await page.locator('.mobile-computer').getByText(hostname().slice(0,120), { exact: true }).waitFor();
      await page.locator('.mobile-connection-dot[data-state="online"]').waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Search conversations', exact: true }).count(),0);
      await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.screenshot({ path: join(directory, 'mobile-sidebar-dark.png'), animations: 'disabled' });
      await page.getByRole('button', { name: 'Light theme', exact: true }).click();
      await page.screenshot({ path: join(directory, 'mobile-sidebar.png'), animations: 'disabled' });
      await page.getByRole('button', { name: 'Search conversations', exact: true }).click();
      await page.getByRole('combobox', { name: 'Search saved chats', exact: true }).fill('Remote smoke');
      await page.screenshot({ path: join(directory,'mobile-search.png') });
      await page.getByRole('option').filter({ hasText: 'Remote smoke conversation' }).click();
      await page.getByText('Hello from the phone', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      assert.equal(await page.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected'), 'true');
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Chat from phone');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor(); assert.equal([...states.values()].at(-1).conversation.mode, 'chat');
      await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();

      const editState = [...states.values()].at(-1), originalUser = editState.conversation.messages.find(message => message.role === 'user');
      await page.getByRole('button', { name: 'Edit message', exact: true }).last().click();
      await page.getByRole('textbox', { name: 'Edit message', exact: true }).fill('Edited from phone');
      await page.screenshot({ path: join(directory, 'mobile-edit.png') });
      await page.locator('[data-slot="edit-message"]').getByRole('button', { name: 'Send', exact: true }).click();
      await page.getByRole('button', { name: 'Undo and send', exact: true }).click();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      await page.getByText('Edited from phone', { exact: true }).waitFor();
      assert.equal(edited, 1); assert.ok(editState.conversation.allMessages.some(message => message.id === originalUser.id && message.text === 'Chat from phone'), 'Edit preserves the previous message version');
      await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      const previousAnswer = editState.conversation.messages.at(-1).id;
      await page.getByRole('button', { name: 'Retry reply', exact: true }).last().click();
      await page.getByRole('button', { name: 'Stop reply', exact: true }).waitFor();
      assert.equal(regenerated, 1);
      await page.getByRole('button', { name: 'Stop reply', exact: true }).click(); await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Show previous response', exact: true }).last().click();
      await page.locator(`[data-message-id="${previousAnswer}"]`).waitFor();
      assert.equal(editState.conversation.messages.at(-1).id, previousAnswer, 'Response version selection is stored on desktop');
      const sourceId = randomUUID();
      editState.conversation.sources.push({ id: sourceId, conversationId: editState.conversation.id, projectId: null, kind: 'attachment', title: 'Saved research note', url: null, mime: 'text/plain', size: 20, createdAt: Date.now(), messageId: null });
      editState.conversation.tools.push({ id: randomUUID(), conversationId: editState.conversation.id, runId, name: 'search_sources', summary: 'Read cited sources', status: 'success', createdAt: Date.now(), result: JSON.stringify({ passages: [{ url: 'https://example.org/research', title: 'Synthetic research source', snippet: 'Public citation preview.' }, { sourceId, text: 'Cited note excerpt.' }], privateInternal: 'MUST_NOT_BE_SENT' }) });
      remote.publish(chat.update(editState.conversation.id));
      await page.getByRole('button', { name: '2 sources', exact: true }).click();
      await page.getByText('Synthetic research source', { exact: true }).waitFor();
      await page.screenshot({ path: join(directory, 'mobile-sources.png') });
      await page.setViewportSize({ width: 320, height: 568 });
      const sourcePopover = await page.getByLabel('Answer sources', { exact: true }).boundingBox();
      assert.ok(sourcePopover.x >= 0 && sourcePopover.x + sourcePopover.width <= 320, 'Source popover fits a narrow phone');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Next source', exact: true }).click();
      await page.getByRole('button', { name: 'Open source: Saved research note', exact: true }).click();
      await page.getByRole('dialog', { name: 'Saved research note', exact: true }).getByText('Cited note excerpt.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
      editState.conversation.messages.at(-1).status = 'complete'; editState.conversation.messages.at(-1).text = 'You can hear this answer on your phone.'; remote.publish(chat.update(editState.conversation.id));
      await page.getByRole('button', { name: 'Read aloud', exact: true }).last().click();
      await page.getByRole('button', { name: 'Pause read aloud', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Pause read aloud', exact: true }).click();
      await page.getByRole('button', { name: 'Resume read aloud', exact: true }).click();
      await page.getByRole('button', { name: 'Stop read aloud', exact: true }).click();
      for (let attempt = 0; !voiceCancelled && attempt < 40; attempt++) await new Promise(resolve => setTimeout(resolve,25)); assert.ok(voiceCancelled > 0);
      await page.getByRole('button', { name: 'Read aloud',exact: true }).last().click(); await page.getByRole('button', { name: 'Pause read aloud',exact: true }).waitFor();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      await page.getByRole('button', { name: 'Read aloud',exact: true }).last().waitFor();
      await page.reload(); await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
      await page.getByText('Edited from phone', { exact: true }).waitFor();
      assert.equal(editState.conversation.messages.at(-1).id, previousAnswer);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 });
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(layout.scrollWidth <= layout.width, `No page overflow at ${width}px`);
        const composer = await page.getByRole('textbox', { name: 'Message', exact: true }).boundingBox();
        assert.ok(composer && composer.y >= 0 && composer.y + composer.height <= 844, `Composer must remain visible at ${width}px`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const variables = await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])), REMOTE_APPEARANCE_KEYS);
      remote.setAppearance({ theme: 'dark', variables: { ...variables, '--background': '#171717', '--foreground': '#ededef' }, palettes: { light: { ...variables, '--background': '#fffaf5', '--foreground': '#222222' }, dark: { ...variables, '--background': '#171717', '--foreground': '#ededef' } } });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--background') === '#fffaf5');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'Desktop updates must preserve the phone theme choice');
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await page.reload(); await page.getByRole('status').filter({ hasText: 'Connected' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      await page.screenshot({ path: join(directory, 'mobile-dark.png') });
      if(process.argv.includes('--media')){
        await page.getByRole('button',{name:'New conversation',exact:true}).click();
        const [cancelledPicker]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Add photos or files',exact:true}).click()]);assert.equal(cancelledPicker.isMultiple(),true);assert.equal(await page.getByRole('menuitem',{name:'Photo library',exact:true}).count(),0,'Plus should open the native picker directly');await cancelledPicker.setFiles([]);
        const [photoPicker]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Add photos or files',exact:true}).click()]);await photoPicker.setFiles({name:'phone-photo.png',mimeType:'image/png',buffer:previewBytes});
        await page.locator('.mobile-attachment[data-upload-state="ready"]').waitFor();
        await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'phone-note.txt',mimeType:'text/plain',buffer:Buffer.from('A document uploaded from the phone.')});
        await page.waitForFunction(()=>document.querySelectorAll('.mobile-attachment[data-upload-state="ready"]').length===2);
        await page.getByLabel('Choose files',{exact:true}).setInputFiles({name:'retry-note.txt',mimeType:'text/plain',buffer:Buffer.from('Retry a retained upload.')});await page.locator('.mobile-attachment[data-upload-state="uploading"]').waitFor();remote.socket.terminate();await page.getByRole('button',{name:'Retry upload: retry-note.txt',exact:true}).waitFor();await page.getByRole('status').filter({hasText:'Connected'}).waitFor();await page.getByRole('button',{name:'Retry upload: retry-note.txt',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.mobile-attachment[data-upload-state="ready"]').length===3);assert.equal([...states.values()].at(-1).conversation.sources.filter(source=>source.title==='retry-note.txt').length,1,'Interrupted completion leaves no duplicate or orphan source');await page.getByRole('button',{name:'Remove attachment: retry-note.txt',exact:true}).click();
        await page.waitForFunction(()=>{const image=document.querySelector('.mobile-attachment > img');return image?.complete&&image.naturalWidth>0;});await page.screenshot({path:join(directory,'mobile-attachments.png')});
        await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByRole('button',{name:'Stop reply',exact:true}).waitFor();
        const uploaded=[...states.values()].at(-1),message=uploaded.conversation.messages.find(message=>message.role==='user');assert.equal(message.text,'');assert.equal(message.attachmentIds.length,2);assert.equal(uploadBytes.get(message.attachmentIds[1]).toString(),'A document uploaded from the phone.');
        await page.getByRole('button',{name:'Stop reply',exact:true}).click();await page.getByRole('button',{name:'Send message',exact:true}).waitFor();assert.equal(await page.locator('.mobile-attachment').count(),0);
        const imageMessage=page.locator('[data-message-id="'+message.id+'"]'),thumbnail=imageMessage.getByRole('button',{name:'Preview image: phone-photo.png',exact:true});
        await thumbnail.locator('img').waitFor();await thumbnail.locator('img').evaluate(image=>image.decode());assert.equal(await imageMessage.getByText('phone-photo.png',{exact:true}).count(),0,'Photos should have an image instead of a filename chip');await imageMessage.getByRole('button',{name:'phone-note.txt',exact:false}).waitFor();await page.screenshot({path:join(directory,'mobile-message-image.png')});
        await thumbnail.click();await page.locator('.message-image-dialog img').evaluate(image=>image.decode());await page.screenshot({path:join(directory,'mobile-message-image-open.png')});await page.getByRole('button',{name:'Close dialog',exact:true}).click();
        await page.reload();await page.getByRole('status').filter({hasText:'Connected'}).waitFor();await page.getByRole('button',{name:'Preview image: phone-photo.png',exact:true}).locator('img').waitFor();
        for(const name of ['browser_screenshot','view_image'])uploaded.conversation.tools.push({id:randomUUID(),conversationId:uploaded.conversation.id,runId,name,summary:'Saved image',status:'success',createdAt:Date.now(),target:name==='view_image'?'C:/private/phone-photo.png':'https://example.org/page',result:JSON.stringify({imageReference:'tinygpt-image:'+randomUUID(),url:'https://example.org/page'})});
        uploaded.conversation.tools.push({id:randomUUID(),conversationId:uploaded.conversation.id,runId,name:'search_web',summary:'Searched reports',status:'success',createdAt:Date.now(),target:'phone research',result:JSON.stringify({results:[{url:'https://example.org/reports',title:'Research'}]})});remote.publish(chat.update(uploaded.conversation.id));
        await page.locator('.tool-chain > summary').last().click();
        await page.getByText('phone research',{exact:true}).waitFor();await page.locator('[data-tool-name="browser_screenshot"] [data-tool-result-toggle]').click();
        await page.locator('[data-slot="tool-image-preview"] img').waitFor();await page.screenshot({path:join(directory,'mobile-tool-preview.png')});
        await page.locator('[data-tool-name="view_image"] [data-tool-result-toggle]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-slot="tool-image-preview"] img').length===2);assert.equal(await page.locator('[data-tool-name="view_image"] .tool-target:visible').count(),0,'Image tools should show a caret without a filename badge');
        const running=beginReply(conversationId);await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await page.locator('.sidebar-run-spinner').waitFor();assert.equal(await page.locator('.mobile-running-dot').count(),0);assert.equal(await page.locator('.mobile-sidebar').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(0, 0, 0)');await page.getByText('Switch or add a computer',{exact:true}).waitFor();await page.screenshot({path:join(directory,'mobile-sidebar-polished.png')});await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();await chat.cancel(conversationId);
        remote.socket.terminate();await page.locator('.mobile-connection-status').waitFor();await page.screenshot({path:join(directory,'mobile-reconnecting.png')});await page.locator('.mobile-connection-status').waitFor({state:'hidden'});assert.equal(await page.getByRole('alert').count(),0);
        console.log('Mobile media passed: actual relay file bytes, attachment-only send, saved chips, screenshot/view_image previews, tool targets, black sidebar, desktop spinners and polished reconnect.');
      }
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      remote.close();
      await page.locator('.mobile-connection-dot[data-state="offline"]').waitFor();
      await page.screenshot({ path: join(directory, 'mobile-sidebar-offline.png') });
      remote = new RemoteService(join(directory, 'profile'), encryption, chat, '', () => {}, actions, fixtureVoice,undefined,fixtureMedia); installInference(); await remote.load();
      await page.locator('.mobile-connection-dot[data-state="online"]').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Dark theme', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Start a new conversation', exact: true }).click();
      await page.screenshot({ path: join(directory, 'mobile-new-chat-dark.png') });
      // Add two more actual desktop relay identities using the in-app camera.
      await page.getByRole('button',{ name: 'Expand sidebar',exact: true }).click();
      const computerIds = [guideDesktop];
      for (const [number,name] of [[2,'Studio Mac'],[3,'Office PC']]) {
        const id = randomUUID(), value = makeState(id,'chat',name + ' conversation');
        value.conversation.messages = [{ id: randomUUID(),role: 'assistant',text: name + ' is ready.',status: 'complete',error: null,createdAt: Date.now(),runId: null,route: 'local' }];
        value.library.conversations = [{ id,projectId: null,title: name + ' conversation',mode: 'chat',createdAt: Date.now(),updatedAt: Date.now() }];
        const other = new RemoteService(join(directory,'computer-' + number),encryption,{ update: () => structuredClone(value),send: () => { throw Error('Unexpected cross-computer send'); },cancel: async()=>structuredClone(value) },'',()=>{},undefined,undefined,name);
        extraRemotes.push(other); const next = await other.pair(id,base), nextFields = invitationFields(next); computerIds.push(nextFields.desktop);
        await page.getByRole('button',{ name: /^Switch computer:/ }).click();
        await page.getByRole('button',{ name: 'Connect another computer',exact: true }).click();
        await page.evaluate(async qr => {
          const image = new Image(); image.src = qr; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 768;
          const context = canvas.getContext('2d'); context.imageSmoothingEnabled = false; const draw = () => context.drawImage(image,0,0,768,768); draw();
          const stream = canvas.captureStream(10), original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), timer = setInterval(draw,100);
          navigator.mediaDevices.getUserMedia = async constraints => constraints.video ? stream : original(constraints);
          window.__qrCamera = { stream,timer,original };
        },next.qr);
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        await page.getByRole('button',{ name: 'Start camera',exact: true }).click();
        await page.getByRole('heading',{ name: 'One tap on your computer.',exact: true }).waitFor();
        await page.evaluate(() => { clearInterval(window.__qrCamera.timer); if (!window.__qrCamera.stream.getTracks().every(track=>track.readyState === 'ended')) throw Error('Scanner camera leaked after pairing'); navigator.mediaDevices.getUserMedia = window.__qrCamera.original; });
        const request = (await other.refreshDevices()).requests[0]; assert.ok(request); await other.approvePairing(request.id,true);
        await page.getByText(name + ' is ready.',{exact:true}).waitFor();
        await page.getByRole('button',{ name: 'Expand sidebar',exact: true }).click();
      }
      await page.getByRole('button',{ name: /^Switch computer:/ }).click();
      assert.equal(await page.locator('.mobile-computer-card').count(),3);
      await page.screenshot({ path: join(directory,'mobile-computers.png') });
      await page.locator('.mobile-computer-card').first().click();
      assert.equal(await page.evaluate(()=>localStorage.getItem('tinygpt-remote-desktop')),guideDesktop);
      await page.getByRole('status').filter({hasText:'Connected'}).waitFor();
      const installedMulti = await browser.newContext({ viewport: {width:390,height:844},isMobile:true,hasTouch:true,storageState:{cookies:await context.cookies(),origins:[]} }), multiPage = await installedMulti.newPage();
      await multiPage.goto(base + '/app/'); await multiPage.getByRole('status').filter({hasText:'Connected'}).waitFor();
      await multiPage.getByRole('button',{name:'Expand sidebar',exact:true}).click(); await multiPage.getByRole('button',{name:/^Switch computer:/}).click();
      assert.equal(await multiPage.locator('.mobile-computer-card').count(),3,'All computers must be discoverable from copied cookies, without localStorage');
      await installedMulti.close();
      const discoveryResult = await context.request.get(base + '/api/mobile/session'); assert.deepEqual((await discoveryResult.json()).computers.map(item=>item.desktop).sort(),computerIds.sort());
      console.log('Three-computer pairing passed: in-app camera QR decode, explicit consent, switching, camera cleanup and cookie-only PWA discovery.');
      if(process.argv.includes('--push')){const {mobilePushSmoke}=await import('./mobile-push-browser-smoke.mjs');await mobilePushSmoke({browser,base,cookies:await context.cookies(),directory,computerIds:[guideDesktop,...computerIds.filter(id=>id!==guideDesktop)],actions,states,remote});}
      const status = await remote.refreshDevices(), browserDevice = status.devices.find(item => item.name === 'iPhone'); assert.ok(browserDevice);
      await remote.revoke(browserDevice.id);
      await page.getByText('Remote access has ended.', { exact: false }).waitFor().catch(async()=>{ await page.getByRole('button',{name:'Connect a computer',exact:true}).waitFor(); });
      assert.deepEqual(errors, [], 'mobile UI should have no uncaught errors');
      console.log(`Mobile UI passed: microphone PCM and returned dictation, streamed read aloud with pause/resume/Stop, background audio cleanup, modal search, visual PWA guide, fresh-storage install handoff and offline screen, message editing, regeneration, source chips, Chat/Work, reconnect and revocation. Screenshots: ${directory}`);
    } finally { await browser.close(); }
  }
  if (process.argv.includes('--desktop')) {
    const { _electron } = await import('playwright');
    let nativeVoiceSeed;
    if (process.argv.includes('--voice-native')||process.argv.includes('--media')) {
      await build({ absWorkingDir: root,entryPoints: ['src/main/history.ts'],outfile: join(directory,'history.mjs'),bundle: true,format: 'esm',platform: 'node',packages: 'external' });
      const { HistoryStore } = await import(pathToFileURL(join(directory,'history.mjs')));
      await mkdir(join(directory,'desktop-profile'),{ recursive: true });
      const history = new HistoryStore(join(directory,'desktop-profile/library.sqlite'));
      const conversation = history.createConversation(null,'chat');
      const sentPhoto=process.argv.includes('--media')?history.sources.add(conversation.id,{kind:'image',title:'phone.png',text:'',mime:'image/png',size:previewBytes.length,image:previewURL}):null;
      const turn = history.startTurn(conversation.id,'Read this test answer.','local',sentPhoto?[sentPhoto.id]:[]);
      history.saveReply(turn.assistantId,'Hello from your computer.','complete'); nativeVoiceSeed = { conversationId: conversation.id,messageId: turn.assistantId,imageSourceId:sentPhoto?.id };
      if(process.argv.includes('--media')){const source=history.sources.add(conversation.id,{kind:'project-file',title:'Native saved screenshot',text:'',mime:'image/png',size:previewBytes.length,image:previewURL,originalImage:previewBytes,privateImage:true});nativeVoiceSeed.tools=[];for(const name of ['computer_screenshot','view_image']){const toolId=randomUUID();history.addTool(toolId,conversation.id,turn.runId,name,'Saved image');history.finishTool(toolId,'success',JSON.stringify({imageReference:'tinygpt-image:'+source.id,...(name==='view_image'?{crop:{x:2,y:2,width:24,height:20}}:{})}));nativeVoiceSeed.tools.push(toolId);}nativeVoiceSeed.title=history.conversation(conversation.id).title;}
      history.close();
    }
    const launcher = join(directory, 'desktop-main.cjs');
    await writeFile(launcher, `const {app}=require('electron');\napp.setPath('userData',${JSON.stringify(join(directory, 'desktop-profile'))});\napp.setAppPath(${JSON.stringify(root)});\napp.on('browser-window-created',(_event,window)=>{window.hide();window.show=()=>{};window.focus=()=>{};});\nrequire(${JSON.stringify(join(root, 'out/main/index.js'))});`);
    const env = { ...process.env, TINYGPT_VOICE_PROFILE: join(directory, 'desktop-profile') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
    const desktop = await _electron.launch({ executablePath: process.env.TINYGPT_ELECTRON_EXECUTABLE || join(root, 'node_modules/electron/dist/electron.exe'), args: [launcher], env, timeout: 30000 });
    try {
      const page = await desktop.firstWindow(), errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.getByRole('button', { name: 'Settings', exact: true }).waitFor();
      const created = await page.evaluate(() => window.tinygpt.createConversation(null)); assert.ok(created.ok);
      const initialized = await page.evaluate(async ({ id,base }) => window.tinygpt.remotePair(id,base,'library'),{ id: created.value.id,base }); assert.ok(initialized.ok);
      await page.reload(); await page.getByRole('button', { name: 'Use on phone', exact: true }).click();
      async function readPairing() {
        await page.getByRole('img', { name: 'Scan to pair TinyGPT', exact: true }).waitFor();
        await page.locator('.remote-code-stage[aria-busy="false"]').waitFor();
        const png = PNG.sync.read(await page.locator('.remote-qr').screenshot({ animations: 'disabled' }));
        const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height, { inversionAttempts: 'attemptBoth' });
        if (!decoded?.data) await writeFile(join(directory,'failed-qr.png'),PNG.sync.write(png));
        assert.ok(decoded?.data, 'Dotted QR with center logo must decode from the actual rendered image');
        assert.equal(await page.locator('.remote-pin').count(),0);
        return { url: decoded.data };
      }
      let originalInvitation = await readPairing();
      if (process.argv.includes('--qr-stress')) for (let sample = 0; sample < 20; sample++) { await page.getByRole('button', { name: 'Refresh QR code',exact: true }).click(); originalInvitation = await readPairing(); }
      assert.equal(await page.getByRole('button', { name: 'Device access', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Chat to share', exact: true }).count(), 0);
      await page.locator('.remote-pair-modal').screenshot({ path: join(directory, 'desktop-pairing.png'), animations: 'disabled' });
      await page.getByRole('button', { name: 'Copy pairing link', exact: true }).click();
      await page.getByText('Copied',{exact:true}).waitFor();
      assert.equal(await desktop.evaluate(({ clipboard }) => clipboard.readText()), originalInvitation.url);
      await page.getByRole('button', { name: 'Refresh QR code', exact: true }).click();
      const invitation = await readPairing(); assert.notEqual(invitation.url, originalInvitation.url);
      await page.evaluate(() => { const appearance = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); appearance.theme = 'dark'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(appearance)); window.dispatchEvent(new StorageEvent('storage', { key: 'tinygpt-appearance-v4', newValue: JSON.stringify(appearance) })); });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.locator('.remote-pair-modal').screenshot({ path: join(directory, 'desktop-pairing-dark.png'), animations: 'disabled' });
      const response = await pair(invitation, { name: 'Native phone' }); assert.equal(response.status, 202);
      await page.getByRole('button',{ name: 'Connect device',exact: true }).click();
      await page.getByText('You’re connected.',{exact:true}).waitFor();
      if(process.argv.includes('--inference-native')){
        const {createServer}=await import('node:http');
        const provider=createServer((request,response)=>{response.setHeader('Content-Type','application/json');if(request.url==='/v1/models'){assert.equal(request.headers.authorization,'Bearer test-only');response.end(JSON.stringify({data:[{id:'fixture-native-a',name:'Native A'},{id:'fixture-native-b',name:'Native B'}]}));}else{response.statusCode=404;response.end('{}');}});
        await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
        try{
          const endpoint='http://127.0.0.1:'+provider.address().port+'/v1';const connected=await page.evaluate(endpoint=>window.tinygpt.connectWithKey({provider:'custom',protocol:'openai-compatible',endpoint,key:'test-only'}),endpoint);assert.ok(connected.ok,JSON.stringify(connected));const connectionId=connected.value.activeConnectionId;
          const fields=invitationFields(invitation),nativeCookie=response.headers.get('Set-Cookie').split(';')[0],origin=new URL(invitation.url).origin;
          const phone=peer(origin.replace(/^http/,'ws')+'/api/d/'+fields.desktop+'/socket',{Cookie:nativeCookie,Origin:origin});await phone.opened;await phone.next(value=>value.type==='presence'&&value.online);
          async function call(command){const id=randomUUID();phone.send({type:'inference',command:{id,...command}});const result=await phone.next(value=>value.type==='inference-reply'&&value.requestId===id);assert.ok(result.ok,JSON.stringify(result));return result.value;}
          const catalog=await call({op:'models',connectionId});assert.deepEqual(catalog.models.map(model=>model.id),['fixture-native-a','fixture-native-b']);assert.ok(!JSON.stringify(catalog).includes(endpoint));
          await call({op:'select',connectionId,model:'fixture-native-b'});await call({op:'effort',mode:'chat',effort:'max'});await call({op:'effort',mode:'code',effort:'instant'});
          const snapshot=await page.evaluate(()=>window.tinygpt.snapshot());assert.ok(snapshot.ok);assert.equal(snapshot.value.activeConnectionId,connectionId);assert.equal(snapshot.value.settings.byok.model,'fixture-native-b');assert.deepEqual(snapshot.value.settings.effort,{chat:'max',code:'instant'});
          const changed=await page.evaluate(async id=>(await window.tinygpt.chooseConnectionModel(id,'fixture-native-a')),connectionId);assert.ok(changed.ok);phone.send({id:randomUUID(),op:'get'});const packet=await phone.next(value=>value.type==='packet'&&value.inference?.model==='fixture-native-a');assert.equal(packet.inference.name,'Native A');assert.equal(packet.inference.connections.find(item=>item.id===connectionId).provider,'custom');assert.ok(!JSON.stringify(packet.inference).includes('test-only'));assert.ok(!JSON.stringify(packet.inference).includes(endpoint));phone.socket.close();
          console.log('Native inference passed: authenticated phone selects real desktop registry model, updates both effort modes, persists settings and receives desktop changes.');
        }finally{await new Promise(resolve=>provider.close(resolve));}
      }
      if (nativeVoiceSeed && process.argv.includes('--voice-native')) {
        const nativeCookie = response.headers.get('Set-Cookie').split(';')[0], fields = invitationFields(invitation), origin = new URL(invitation.url).origin;
        const voicePhone = peer(`${origin.replace(/^http/,'ws')}/api/d/${fields.desktop}/socket`,{ Cookie: nativeCookie,Origin: origin }); await voicePhone.opened;
        await voicePhone.next(value => value.type === 'presence' && value.online);
        async function voiceCall(op,jobId,extra = {}) {
          const id = randomUUID(); voicePhone.send({ type: 'voice',command: { id,op,jobId,conversationId: nativeVoiceSeed.conversationId,...extra } });
          const reply = await voicePhone.next(value => value.type === 'voice-reply' && value.requestId === id,120000); assert.equal(reply.ok,true,reply.error); return reply.value;
        }
        const speechJob = randomUUID(), chunks = [];
        let spoken = await voiceCall('speech-read',speechJob,{ messageId: nativeVoiceSeed.messageId,chunk: 0 }), sequence = 1;
        while (true) { if (spoken.audio) chunks.push(Buffer.from(spoken.audio,'base64')); if (spoken.stream?.done) break; spoken = await voiceCall('speech-next',speechJob,{ sequence: sequence++ }); }
        const pcm = Buffer.concat(chunks); assert.ok(pcm.length > 4800,'Real Pocket TTS must produce streamed PCM');
        const dictationJob = randomUUID(); await voiceCall('dictation-start',dictationJob,{ sampleRate: 24000 });
        for (let offset = 0,sequence = 0; offset < pcm.length; offset += 3840) await voiceCall('dictation-audio',dictationJob,{ sequence: sequence++,audio: pcm.subarray(offset,offset + 3840).toString('base64') });
        await voiceCall('dictation-stop',dictationJob,{ cancel: false });
        const transcript = await voicePhone.next(value => value.type === 'voice-event' && value.event.phase === 'finishing' && value.event.text?.trim(),15000);
        assert.match(transcript.event.text,/hello|computer/i,'Real Moonshine must recognize the relayed speech');
        voicePhone.socket.close(); console.log(`Real desktop audio bridge passed: ${chunks.length} Pocket TTS chunks, ${(pcm.length / 48000).toFixed(1)}s audio relayed into Moonshine, transcript returned.`);
      }
      await page.getByText('Native phone', { exact: true }).waitFor();
      await page.getByText('You’re connected.', { exact: true }).waitFor();
      const nativeStatus = await page.evaluate(async () => (await window.tinygpt.remoteStatus()).value); assert.equal(nativeStatus.devices.find(device => device.name === 'Native phone').scope, 'library');
      await page.locator('.remote-pair-modal').screenshot({ path: join(directory, 'desktop-pairing-success.png'), animations: 'disabled' });
      await page.locator('.remote-pair-modal').waitFor({state:'hidden'});
      if(process.argv.includes('--media')){
        const nativeCookie=response.headers.get('Set-Cookie').split(';')[0],fields=invitationFields(invitation),origin=new URL(invitation.url).origin;
        const mediaPhone=peer(origin.replace(/^http/,'ws')+'/api/d/'+fields.desktop+'/socket',{Cookie:nativeCookie,Origin:origin});await mediaPhone.opened;await mediaPhone.next(value=>value.type==='presence'&&value.online);
        async function mediaCall(op,jobId,extra={},ok=true){const id=randomUUID();mediaPhone.send({type:'media',command:{id,op,jobId,conversationId:nativeVoiceSeed.conversationId,...extra}});const reply=await mediaPhone.next(value=>value.type==='media-reply'&&value.requestId===id);assert.equal(reply.ok,ok,JSON.stringify(reply));return reply.value;}
        const preview=await mediaCall('tool-image',randomUUID(),{toolId:nativeVoiceSeed.tools[0]});assert.match(preview.image,/^data:image\/jpeg;base64,/);assert.equal(preview.width,120);const cropped=await mediaCall('tool-image',randomUUID(),{toolId:nativeVoiceSeed.tools[1]});assert.equal(cropped.width,24);assert.equal(cropped.height,20);
        const denied=await page.evaluate(async({id,toolId})=>window.tinygpt.toolPreview(id,toolId),{id:created.value.id,toolId:nativeVoiceSeed.tools[0]});assert.equal(denied.ok,false,'An unrelated conversation cannot load this screenshot');
        const saved=[];for(const [name,bytes] of [['phone.png',previewBytes],['phone.txt',Buffer.from('Real native phone document.')]]){const jobId=randomUUID();await mediaCall('upload-start',jobId,{name,bytes:bytes.length});await mediaCall('upload-chunk',jobId,{sequence:0,data:bytes.toString('base64')});const uploaded=await mediaCall('upload-finish',jobId);saved.push(uploaded);const detail=await page.evaluate(async({id,sourceId})=>window.tinygpt.source(id,sourceId),{id:nativeVoiceSeed.conversationId,sourceId:uploaded.sourceId});assert.ok(detail.ok);if(name.endsWith('.png'))assert.match(detail.value.image,/^data:image\//);else assert.match(detail.value.text,/Real native phone document/);}
        const attached=await mediaCall('attachment-image',randomUUID(),{sourceId:nativeVoiceSeed.imageSourceId});assert.match(attached.image,/^data:image\/jpeg;base64,/);assert.ok(Buffer.from(attached.image.split(',')[1],'base64').length<=64000);const fullAttachment=await mediaCall('attachment-image',randomUUID(),{sourceId:nativeVoiceSeed.imageSourceId,size:'full'});assert.equal(fullAttachment.width,120);
        await mediaCall('attachment-image',randomUUID(),{sourceId:saved[0].sourceId},false);await mediaCall('attachment-image',randomUUID(),{sourceId:saved[1].sourceId},false);await mediaCall('attachment-image',randomUUID(),{sourceId:randomUUID()},false);
        await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
        if(!await page.locator('.sidebar-chat-row').filter({hasText:nativeVoiceSeed.title}).isVisible())await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await page.locator('.sidebar-chat-row').filter({hasText:nativeVoiceSeed.title}).click();const nativeImage=page.getByRole('button',{name:'Preview image: phone.png',exact:true});await nativeImage.locator('img').waitFor();await nativeImage.locator('img').evaluate(image=>image.decode());await page.screenshot({path:join(directory,'desktop-message-image.png')});await nativeImage.click();await page.locator('.message-image-dialog img').evaluate(image=>image.decode());await page.getByRole('button',{name:'Close dialog',exact:true}).click();
        await mediaCall('remove-upload',randomUUID(),{sourceId:saved[0].sourceId});await mediaCall('remove-upload',randomUUID(),{sourceId:saved[1].sourceId});const removed=await page.evaluate(async({id,sourceId})=>window.tinygpt.source(id,sourceId),{id:nativeVoiceSeed.conversationId,sourceId:saved[0].sourceId});assert.equal(removed.ok,false);mediaPhone.socket.close();
        if(!await page.locator('.sidebar-chat-row').filter({hasText:nativeVoiceSeed.title}).isVisible())await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await page.locator('.sidebar-chat-row').filter({hasText:nativeVoiceSeed.title}).click();await page.getByText('Hello from your computer.',{exact:true}).waitFor();await page.locator('.tool-chain > summary').click();await page.locator('[data-tool-name="computer_screenshot"] [data-tool-result-toggle]').click();await page.locator('[data-slot="tool-image-preview"] img').waitFor();await page.screenshot({path:join(directory,'desktop-native-preview.png')});await page.locator('[data-tool-name="computer_screenshot"] [data-tool-result-toggle]').click();await page.locator('[data-tool-name="view_image"] [data-tool-result-toggle]').click();await page.locator('[data-tool-name="view_image"] [data-slot="tool-image-preview"] img').waitFor();
        console.log('Native media passed: real desktop file extraction and saved image bytes, scoped JPEG previews, cropped view_image, attachment removal and expandable desktop UI.');
      }
      await page.evaluate(() => { const appearance = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); appearance.theme = 'light'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(appearance)); window.dispatchEvent(new StorageEvent('storage', { key: 'tinygpt-appearance-v4', newValue: JSON.stringify(appearance) })); });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Remote Control', exact: true }).click();
      await page.getByRole('heading', { name: 'Remote Control', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Revoke access for Native phone', exact: true }).click();
      await page.evaluate(() => window.tinygpt.remoteDisconnect());
      await page.getByRole('button', { name: 'Refresh remote devices', exact: true }).click();
      await page.getByText('No devices paired', { exact: true }).waitFor();
      assert.equal(await page.getByRole('switch', { name: 'Allow remote connections', exact: true }).getAttribute('aria-checked'), 'false');
      await page.screenshot({ path: join(directory, 'remote-settings-empty.png') });
      await page.evaluate(async ({ id,base }) => window.tinygpt.remotePair(id,base,'library'),{ id: created.value.id,base });
      await page.getByRole('button', { name: 'Refresh remote devices', exact: true }).click();
      await page.getByRole('button', { name: 'Add device', exact: true }).click();
      const settingsInvitation = await readPairing();
      const settingsResponse = await pair(settingsInvitation, { name: 'Settings phone' }); assert.equal(settingsResponse.status, 202);
      await page.getByRole('button',{ name: 'Connect device',exact: true }).click();
      await page.locator('.remote-pair-modal').waitFor({state:'hidden'});
      await page.getByRole('button', { name: 'Refresh remote devices', exact: true }).click();
      await page.getByText('Settings phone', { exact: true }).waitFor();
      await page.screenshot({ path: join(directory, 'remote-settings-light.png') });
      await page.getByRole('switch', { name: 'Keep this computer awake', exact: true }).click();
      await page.getByRole('switch', { name: 'Allow remote connections', exact: true }).click();
      const paused = await page.evaluate(async () => (await window.tinygpt.remoteStatus()).value);
      assert.equal(paused.enabled, false); assert.equal(paused.keepAwake, true); assert.equal(paused.devices.length, 1);
      await page.reload();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Remote Control', exact: true }).click();
      await page.getByText('Settings phone', { exact: true }).waitFor();
      assert.equal(await page.getByRole('switch', { name: 'Allow remote connections', exact: true }).getAttribute('aria-checked'), 'false');
      assert.equal(await page.getByRole('switch', { name: 'Keep this computer awake', exact: true }).getAttribute('aria-checked'), 'true');
      await page.evaluate(() => { const appearance = JSON.parse(localStorage.getItem('tinygpt-appearance-v4')); appearance.theme = 'dark'; localStorage.setItem('tinygpt-appearance-v4', JSON.stringify(appearance)); window.dispatchEvent(new StorageEvent('storage', { key: 'tinygpt-appearance-v4', newValue: JSON.stringify(appearance) })); });
      await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      await page.screenshot({ path: join(directory, 'remote-settings-dark.png') });
      await page.getByRole('button', { name: 'Revoke access for Settings phone', exact: true }).click();
      await page.getByText('No devices paired', { exact: true }).waitFor();
      await page.evaluate(() => window.tinygpt.remoteDisconnect());
      assert.deepEqual(errors, []);
      console.log('Remote Control settings passed: navigation, Add device, QR/approval, paired devices, pause/resume preferences, keep-awake and revocation.');
      console.log('Native desktop UI passed: generated-art modal, styled QR screenshot decoding, automatic all-chat pairing, copy link, refresh, light/dark and connected states, device management and revocation.');
    } finally { await desktop.close(); }
  }
  const deniedInvitation = await remote.pair(conversationId,base), denied = await pair(deniedInvitation); assert.equal(denied.status,202);
  const deniedDevice = await denied.json(), deniedCookie = denied.headers.get('Set-Cookie').split(';')[0]; await remote.approvePairing(deniedDevice.deviceId,false);
  assert.equal((await fetch(base + '/api/d/' + invitationFields(deniedInvitation).desktop + '/session',{ headers: { Cookie: deniedCookie } })).status,401);
  assert.equal((await pair(deniedInvitation)).status,403,'Denied tickets cannot be replayed');
  await writeFile(join(directory, 'result.json'), JSON.stringify({ passed: true, checks: ['QR generation', 'origin protection', 'desktop approval', 'single-use invitation', 'denied pairing rejection', 'signed desktop authentication', 'HTTP replay rejection', 'streaming', 'Stop', 'phone reconnect', 'desktop reconnect', 'durable send deduplication', 'revocation'] }, null, 2));
  console.log('Remote chat smoke passed: pairing, auth, streaming, Stop, reconnect, durable deduplication and revocation.');
} catch (error) { console.error('Fixture status:', remote.status(), 'sends:', sent, 'stops:', stops); throw error; } finally { clearInterval(ticker); remote.close(); for (const item of peers) item.socket.terminate(); for (const item of extraRemotes) { await item.disconnect().catch(()=>{}); item.close(); } await mf?.dispose(); }
