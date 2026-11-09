import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import WebSocket from 'ws';

export async function checkEncryptedMobile({base, remote, chat, states, conversationId, directory, previewBytes, uploadBytes, voiceStats}) {
  const browser = await chromium.launch({channel:'chrome',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  const context = await browser.newContext({viewport:{width:390,height:844},permissions:['microphone'],isMobile:true,hasTouch:true});
  let delaySession=true;
  await context.route('**/api/d/*/session',async route=>{if(delaySession){delaySession=false;await new Promise(done=>setTimeout(done,1200));}await route.continue();});
  await context.addInitScript(()=>{
    window.__speechProbe=[];
    const Native=window.AudioContext;
    window.AudioContext=class extends Native {
      constructor(options){super(options);const context=this,create=this.createBufferSource.bind(this);this.createBufferSource=()=>{const source=create(),start=source.start.bind(source);source.start=(...args)=>{let peak=0;if(source.buffer)for(const sample of source.buffer.getChannelData(0))peak=Math.max(peak,Math.abs(sample));window.__speechProbe.push({peak,state:context.state,time:context.currentTime});return start(...args);};return source;};}
    };
  });
  const page = await context.newPage(), errors = [], frames = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url() + (request.postData() ?? '')); });
  page.on('websocket', socket => { socket.on('framesent', event => frames.push(String(event.payload))); socket.on('framereceived', event => frames.push(String(event.payload))); });
  try {
    const invitation = await remote.pair(conversationId,base), fields = new URLSearchParams(new URL(invitation.url).hash.slice(1));
    await page.goto(invitation.url.replace('/#','/app/#'));
    const pending = await waitFor(async () => { await remote.refreshDevices(); return remote.status().requests[0]; });
    await remote.approvePairing(pending.id,true);
    await page.locator('.mobile-thread').waitFor({timeout:20000});
    // Notification launches deliberately target a saved chat; ordinary cold opens start blank.
    const target=base+'/app/#'+new URLSearchParams({desktop:fields.get('desktop'),conversation:conversationId,notification:randomUUID()});
    await page.goto(target);await page.waitForFunction(id=>document.querySelector('.mobile-thread')?.getAttribute('data-conversation-id')===id,conversationId);
    const cookies = await context.cookies(), cookie = cookies.filter(value=>value.name.startsWith('tg2_')).map(value=>value.name+'='+value.value).join('; ');
    const socketURL = base.replace(/^http/,'ws')+'/api/d/'+fields.get('desktop')+'/socket';
    const oldProtocol = await new Promise((resolve,reject)=>{const socket=new WebSocket(socketURL,'tinygpt.remote.v1',{headers:{Cookie:cookie,Origin:base}});socket.on('unexpected-response',(_req,response)=>{response.resume();resolve(response.statusCode);socket.terminate();});socket.on('open',()=>{socket.close();reject(Error('Legacy plaintext protocol accepted'));});socket.on('error',()=>{});});
    assert.equal(oldProtocol,426);
    const plaintextClose = await new Promise((resolve,reject)=>{const socket=new WebSocket(socketURL,'tinygpt.remote.v2',{headers:{Cookie:cookie,Origin:base}});socket.on('open',()=>socket.send(JSON.stringify({id:randomUUID(),op:'send',text:'PLAINTEXT_MUST_BE_REJECTED'})));socket.on('close',code=>resolve(code));socket.on('error',reject);});
    assert.equal(plaintextClose,1008); assert.ok(!JSON.stringify([...states.values()]).includes('PLAINTEXT_MUST_BE_REJECTED'));
    assert.ok(!page.url().includes(fields.get('key')));
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('ENCRYPTED_CHAT_SENTINEL_8d350f');
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.getByRole('button',{name:'Stop reply',exact:true}).waitFor();
    await page.getByText('ENCRYPTED_CHAT_SENTINEL_8d350f',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Stop reply',exact:true}).click();
    await page.getByRole('button',{name:'Send message',exact:true}).waitFor();
    // Exercise Chat display parity through the real encrypted transport.
    const parity=states.get(conversationId), reply=parity.conversation.messages.at(-1);
    reply.status='streaming';reply.text='';reply.runId=randomUUID();
    parity.library.activeRuns=[{conversationId,runId:reply.runId,phase:'tools',prose:'PARITY_FIRST_PROGRESS'}];
    remote.publish(chat.update(conversationId));
    await page.locator('[data-slot="chat-progress"]').filter({hasText:'PARITY_FIRST_PROGRESS'}).waitFor();
    parity.library.activeRuns[0].prose='PARITY_REPLACED_PROGRESS';remote.publish(chat.update(conversationId));
    await page.locator('[data-slot="chat-progress"]').filter({hasText:'PARITY_REPLACED_PROGRESS'}).waitFor();
    assert.equal(await page.getByText('PARITY_FIRST_PROGRESS',{exact:true}).count(),0);
    parity.library.activeRuns[0].phase='answer';parity.library.activeRuns[0].hasVisibleAnswer=true;
    reply.text='PARITY_FINAL_ANSWER';remote.publish(chat.update(conversationId));
    await page.getByText('PARITY_FINAL_ANSWER',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-slot="chat-progress"]').count(),0);
    const visualId=randomUUID(), visual={root:'card',elements:{
      card:{type:'Card',props:{title:'ENCRYPTED_VISUAL_SENTINEL'},children:['table','chart','checklist','followup']},
      table:{type:'Table',props:{columns:[{label:'Plan'}],rows:[['Premium'],['Plus']],sortable:true},children:[]},
      chart:{type:'ChartPanel',props:{title:'Plan prices',variant:'bar',unit:'USD',data:[{label:'Plus',value:8},{label:'Premium',value:30}]},children:[]},
      checklist:{type:'Checklist',props:{title:'Next steps',items:[{text:'Review the comparison'}]},children:[]},
      followup:{type:'FollowUpGroup',props:{suggestions:[{label:'Compare plans',message:'Compare the plans in detail.'}]},children:[]},
    }};
    reply.text='';reply.presentations=[{toolId:visualId,offset:0}];
    parity.library.activeRuns[0].phase='tools';parity.library.activeRuns[0].hasVisibleAnswer=false;
    parity.conversation.tools.push({id:visualId,conversationId,runId:reply.runId,name:'present',summary:'Show comparison',status:'success',result:JSON.stringify({ui:visual}),createdAt:Date.now()});
    remote.publish(chat.update(conversationId));
    await page.getByText('ENCRYPTED_VISUAL_SENTINEL',{exact:true}).waitFor();
    assert.equal(await page.locator('.chat-generative-ui table').first().locator('tbody tr').count(),2);
    assert.equal(await page.locator('[data-slot="chat-progress"]').count(),0);
    reply.status='complete';parity.library.activeRuns=[];remote.publish(chat.update(conversationId));
    await page.getByRole('img',{name:'Plan prices (USD)',exact:true}).waitFor();
    await page.getByRole('button',{name:'Plan',exact:true}).click();
    assert.equal(await page.locator('.chat-generative-ui tbody tr').first().innerText(),'Plus');
    await page.getByRole('checkbox',{name:'Review the comparison',exact:true}).check();
    assert.equal(await page.getByRole('checkbox',{name:'Review the comparison',exact:true}).isChecked(),true);
    await page.getByRole('button',{name:'Compare plans',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'Compare the plans in detail.');
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('');
    await page.screenshot({path:join(directory,'mobile-visual-parity.png')});
    await page.getByRole('button',{name:'Dictate message',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]')?.value.includes('Voice message from phone'));
    await page.getByRole('button',{name:'Stop dictation',exact:true}).click();
    await page.getByRole('button',{name:'Dictate message',exact:true}).waitFor();
    assert.ok(voiceStats().microphoneFrames>0);
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('');
    const spoken = states.get(conversationId).conversation.messages.at(-1);
    spoken.status = 'complete'; spoken.text = 'ENCRYPTED_SPEECH_SENTINEL_933f'; remote.publish(chat.update(conversationId));
    await page.getByRole('button',{name:'Read aloud',exact:true}).last().click();
    await page.getByRole('button',{name:'Pause read aloud',exact:true}).waitFor();
    await page.waitForFunction(()=>window.__speechProbe.some(item=>item.peak>0.001&&item.state==='running'&&item.time>0));
    await page.getByRole('button',{name:'Pause read aloud',exact:true}).click();
    await page.getByRole('button',{name:'Resume read aloud',exact:true}).click();
    await page.getByRole('button',{name:'Stop read aloud',exact:true}).click();
    await waitFor(()=>voiceStats().voiceCancelled>0);
    const data = Buffer.from('ENCRYPTED_FILE_SENTINEL_fa49a8\n'.repeat(9000));
    await page.getByLabel('Choose files',{exact:true}).setInputFiles([{name:'PRIVATE_FILENAME_fa49a8.txt',mimeType:'text/plain',buffer:data},{name:'PRIVATE_IMAGE_fa49a8.png',mimeType:'image/png',buffer:previewBytes}]);
    await page.waitForFunction(()=>document.querySelectorAll('.mobile-attachment[data-upload-state="ready"]').length===2);
    const uploaded = [...states.values()].flatMap(state=>state.conversation.sources).find(source=>source.title==='PRIVATE_FILENAME_fa49a8.txt');
    assert.ok(uploaded); assert.deepEqual(uploadBytes.get(uploaded.id),data);
    await page.getByRole('button',{name:'Send message',exact:true}).click();
    await page.getByRole('button',{name:'Stop reply',exact:true}).waitFor();
    await page.getByRole('button',{name:'Stop reply',exact:true}).click();
    await page.getByRole('button',{name:'Send message',exact:true}).waitFor();
    // Trigger an actual lazy image preview over the encrypted media route.
    const state = states.get(conversationId), toolId = randomUUID();
    state.conversation.tools.push({id:toolId,conversationId,runId:state.conversation.messages.at(-1).runId,name:'browser_screenshot',summary:'PRIVATE_PREVIEW_SENTINEL',status:'success',result:JSON.stringify({imageReference:'tinygpt-image:'+randomUUID()}),createdAt:Date.now()});
    remote.publish(chat.update(conversationId));
    await page.locator('.tool-chain > summary').last().click();
    await page.locator('[data-tool-name="browser_screenshot"] [data-tool-result-toggle]').last().click();
    await page.locator('[data-slot="tool-image-preview"] img').waitFor();
    // Force a new ephemeral handshake, preserving approved local keys.
    remote.socket.terminate();
    await waitFor(async()=>remote.status().connected);
    await page.locator('.mobile-connection-status').waitFor({state:'hidden',timeout:20000});
    await page.getByRole('textbox',{name:'Message',exact:true}).fill('AFTER_REKEY_SENTINEL_3fb1');
    await page.getByRole('button',{name:'Send message',exact:true}).click({timeout:20000});
    await page.getByText('AFTER_REKEY_SENTINEL_3fb1',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Stop reply',exact:true}).click();
    // Reload checks persistence of the non-exportable browser pairing key.
    await page.reload();await page.getByRole('status').filter({hasText:'Connected'}).waitFor();
    assert.equal(await page.locator('.mobile-thread').getAttribute('data-conversation-id'),'draft');
    await page.goto(target); await page.locator('.mobile-thread').waitFor({timeout:20000});
    await page.getByText('AFTER_REKEY_SENTINEL_3fb1',{exact:true}).waitFor();
    const screenshotRoot = join(directory,'e2e'); await mkdir(screenshotRoot,{recursive:true});
    await page.screenshot({path:join(screenshotRoot,'mobile-encrypted.png')});
    const wire = frames.join('\n') + requests.join('\n');
    for (const secret of ['ENCRYPTED_VISUAL_SENTINEL','PARITY_REPLACED_PROGRESS','ENCRYPTED_CHAT_SENTINEL_8d350f','PRIVATE_FILENAME_fa49a8','PRIVATE_IMAGE_fa49a8','PRIVATE_PREVIEW_SENTINEL','AFTER_REKEY_SENTINEL_3fb1','ENCRYPTED_SPEECH_SENTINEL_933f','Voice message from phone',fields.get('key'),Buffer.from(data).toString('base64').slice(0,80),previewBytes.toString('base64').slice(0,80),'A'.repeat(80)]) assert.ok(!wire.includes(secret),'Plaintext or encryption secret reached the network');
    assert.ok(frames.some(text=>text.includes('"encrypted"'))); assert.ok(frames.filter(text=>text.includes('"handshake"')).length>=6);
    for(const frame of frames) { if (['ping','pong'].includes(frame)) continue; const value=JSON.parse(frame); assert.ok(['handshake','encrypted','presence','revoked'].includes(value.type),'No application plaintext on the wire'); }
    assert.deepEqual(errors,[]);
    // A fresh QR in an already paired browser must create a new key-bound grant.
    const nextInvitation = await remote.pair(conversationId,base);
    await page.goto(nextInvitation.url.replace('/#','/app/#'));
    const nextGrant = new URLSearchParams(new URL(nextInvitation.url).hash.slice(1)).get('invitation');
    const nextPending = await waitFor(async()=>{await remote.refreshDevices();return remote.status().requests.find(item=>item.grantId===nextGrant);});
    await remote.approvePairing(nextPending.id,true); await page.locator('.mobile-thread').waitFor({timeout:20000});
    await remote.revoke(pending.id); await remote.revoke(nextPending.id); await page.getByText(/Remote access has ended/).waitFor();
    console.log(JSON.stringify({checks:['actual mobile Noise handshake','message send and streaming','large file upload exact bytes','image upload and preview','microphone audio and transcription','streamed read aloud with pause/resume/stop','reconnect and fresh handshake','reload and browser key persistence','no content or QR encryption secret in HTTP/WebSocket capture','device revocation'],frames:frames.length,errors,screenshot:join(screenshotRoot,'mobile-encrypted.png')}));
  } catch (error) { console.error('Mobile fixture errors:',errors); console.error((await page.locator('body').innerText()).slice(0,1000)); await page.screenshot({path:join(directory,'mobile-e2e-failure.png')}); throw error; } finally { await browser.close(); }
}
async function waitFor(check) { const until=Date.now()+20000; while(Date.now()<until){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Timed out waiting for encrypted mobile connection.'); }
