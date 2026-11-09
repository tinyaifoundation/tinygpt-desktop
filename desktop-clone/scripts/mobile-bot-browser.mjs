import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';

export async function checkMobileBot({base,remote,chat,states,actions,makeState,conversationId}){
 const id=randomUUID(),privateId=randomUUID(),state=makeState(id,'bot','Blobby');states.set(id,state);states.set(privateId,makeState(privateId,'bot','PRIVATE_WATCH_CONVERSATION'));
 const bot={conversationId:id,name:'Blobby',phase:'ready',browser:true,snoozed:false,watches:[{id:randomUUID(),title:'Project updates',enabled:true,nextRunAt:Date.now()+3600000}]};
 actions.bot=()=>bot;
 actions.botSnooze=async value=>{bot.snoozed=value;if(value)await chat.cancel(id);remote.refreshLibraries();};
 actions.botReact=(conversationId,messageId,emoji)=>{assert.equal(conversationId,id);state.conversation.messages.find(message=>message.id===messageId).reactions=emoji?[{actor:'user',emoji,createdAt:Date.now()}]:[];remote.publish(chat.update(id));};
 const variables=Object.fromEntries(['--background','--foreground','--user-accent','--ring','--user-ui-font','--user-content-font','--user-code-font','--user-ui-weight','--user-content-weight','--user-code-weight','--user-ui-size','--user-code-size','--user-ui-scale','--user-contrast'].map(key=>[key,'1']));
 Object.assign(variables,{'--background':'#171717','--foreground':'#ededef','--user-ui-font':'Inter','--user-content-font':'Inter','--user-code-font':'monospace','--user-ui-weight':'400','--user-content-weight':'400','--user-code-weight':'400','--user-ui-size':'14px','--user-code-size':'13px','--user-ui-scale':'1','--user-contrast':'1','--user-accent':'#b1ff00','--ring':'#b1ff00'});
 const design={name:'Blobby',color:'#b1ff00',shape:'cloud',expression:'happy'};remote.setAppearance({theme:'dark',variables,bot:design});
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage(),errors=[],wire=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>{socket.on('framesent',event=>wire.push(String(event.payload)));socket.on('framereceived',event=>wire.push(String(event.payload)));});
 const folder=join(process.cwd(),'artifacts/mobile-bot');await mkdir(folder,{recursive:true});
 const wait=async predicate=>{for(let i=0;i<300;i++){if(await predicate())return;await new Promise(done=>setTimeout(done,50));}throw Error('Mobile Bot condition timed out');};
 try{
  await chat.cancel(conversationId);const invitation=await remote.pair(conversationId,base,'library');await page.goto(base+'/app/'+new URL(invitation.url).hash);
  let device;await wait(async()=>{await remote.refreshDevices();device=remote.status().requests[0];return !!device;});await remote.approvePairing(device.id,true);
  await page.getByRole('status').filter({hasText:'Connected'}).waitFor();await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
  await page.getByRole('button',{name:'Chat with Blobby',exact:true}).waitFor();assert.equal(await page.getByText('PRIVATE_WATCH_CONVERSATION',{exact:true}).count(),0);
  const alignment=await page.evaluate(()=>{
   const row=document.querySelector('.mobile-bot-entry'),label=row.querySelector('.mobile-bot-name'),newChat=document.querySelector('[aria-label="Start a new conversation"]');
   const name=label.getBoundingClientRect(),reference=newChat.querySelector('span').getBoundingClientRect(),slot=row.querySelector('.mobile-bot-icon').getBoundingClientRect(),icon=newChat.querySelector('svg').getBoundingClientRect(),avatar=row.querySelector('.robot-avatar>svg').getBoundingClientRect();
   return {nameLeft:name.left,referenceLeft:reference.left,slotWidth:slot.width,iconWidth:icon.width,avatarWidth:avatar.width};
  });
  assert.ok(Math.abs(alignment.nameLeft-alignment.referenceLeft)<1,'Bot name aligns with New chat');assert.equal(alignment.slotWidth,alignment.iconWidth);assert.ok(alignment.avatarWidth>=24,'Avatar escapes the button generic 16px SVG rule');
  await page.screenshot({path:join(folder,'sidebar.png')});await page.getByRole('button',{name:'Chat with Blobby',exact:true}).click();await page.locator('.mobile-bot-thread').waitFor();
  await page.getByRole('button',{name:'About Blobby',exact:true}).waitFor();assert.equal(await page.locator('.conversation-greeting').count(),0);
  const avatar=page.locator('.mobile-bot-identity [data-avatar-engine="blob-avatar"]');assert.equal(await avatar.getAttribute('data-color'),'#b1ff00');assert.equal(await avatar.getAttribute('data-shape'),'cloud');
  const initial=await avatar.innerHTML();await wait(async()=>await avatar.innerHTML()!==initial);await page.screenshot({path:join(folder,'blank.png')});
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Hello from my phone');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.locator('.bot-message-outgoing').getByText('Hello from my phone',{exact:true}).waitFor();await wait(()=>state.conversation.messages.at(-1)?.text.includes('Hello from TinyGPT'));
  await chat.cancel(id);state.conversation.messages.at(-1).status='complete';remote.publish(chat.update(id));await page.locator('.bot-message-incoming [data-slot="answer-text"]').waitFor();
  await page.locator('.bot-message-incoming').getByRole('button',{name:'React to message',exact:true}).click();await page.getByRole('button',{name:'React 👍',exact:true}).click();await page.getByRole('button',{name:'Your reaction 👍',exact:true}).waitFor();
  await page.screenshot({path:join(folder,'conversation.png')});
  await page.getByRole('button',{name:'About Blobby',exact:true}).click();await page.getByText('Project updates',{exact:true}).waitFor();await page.screenshot({path:join(folder,'info.png')});
  await page.getByRole('button',{name:'Snooze',exact:true}).click();await wait(()=>bot.snoozed);await page.getByRole('button',{name:'Wake up',exact:true}).first().waitFor();await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByText('Blobby is sleeping',{exact:true}).waitFor();assert.equal(await avatar.getAttribute('data-action'),'snooze');assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).count(),0);await page.screenshot({path:join(folder,'sleeping.png')});
  await page.getByRole('button',{name:'Wake up',exact:true}).click();await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();assert.equal(bot.snoozed,false);
  remote.setAppearance({theme:'dark',variables,bot:{...design,color:'#ff4477'}});await wait(async()=>await avatar.getAttribute('data-color')==='#ff4477');
  await page.reload();await page.getByRole('status').filter({hasText:'Connected'}).waitFor();await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await page.getByRole('button',{name:'Chat with Blobby',exact:true}).click();await page.locator('.mobile-bot-thread').waitFor();await page.locator('.bot-message-outgoing').getByText('Hello from my phone',{exact:true}).waitFor();
  assert.equal(await page.locator('.mobile-thread').getAttribute('data-conversation-id'),id);assert.ok(!wire.join('\n').includes('Hello from my phone'));assert.ok(!wire.join('\n').includes('PRIVATE_WATCH_CONVERSATION'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow');
  await remote.setScope(device.id,'conversation');await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await wait(async()=>await page.getByRole('button',{name:'Chat with Blobby',exact:true}).count()===0);
  await remote.revoke(device.id);await page.getByText(/Remote access has ended/).waitFor();assert.deepEqual(errors,[]);
  const result={passed:true,checks:['animated custom avatar','main Bot discovery and blank identity','shared conversation send and response','reactions','watch info','sleep and wake','live avatar sync','reconnect','encrypted transport','scope downgrade and revocation','no private watch leakage','390px layout'],screenshots:folder};await writeFile(join(folder,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(error){console.error((await page.locator('body').innerText()).slice(-2200));await page.screenshot({path:join(folder,'failure.png')});throw error;}
 finally{await context.close();await browser.close();states.delete(privateId);}
}
