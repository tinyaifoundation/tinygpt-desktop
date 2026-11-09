import assert from 'node:assert/strict';
import {createECDH,randomBytes,randomUUID} from 'node:crypto';
import {join} from 'node:path';

export async function mobilePushSmoke({browser,base,cookies,directory,computerIds,actions,states,remote}){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,storageState:{cookies,origins:[]},userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1'});
  const curve=createECDH('prime256v1');curve.generateKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/'+randomUUID(),expirationTime:null,keys:{p256dh:curve.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
  const records=new Map(),operations=[],errors=[];
  await context.grantPermissions(['notifications'],{origin:base});
  await context.addInitScript(value=>{
    Object.defineProperty(navigator,'standalone',{get:()=>true});
    window.__pushSubscribeCalls=0;
    const sub={...value,toJSON:()=>value,unsubscribe:async()=>{localStorage.removeItem('test-push-sub');return true;}};
    const manager={getSubscription:async()=>localStorage.getItem('test-push-sub')?sub:null,subscribe:async options=>{window.__pushSubscribeCalls++;window.__pushOptions={userVisibleOnly:options.userVisibleOnly,keyLength:options.applicationServerKey.length};localStorage.setItem('test-push-sub','true');return sub;}};
    Object.defineProperty(ServiceWorkerRegistration.prototype,'pushManager',{get:()=>manager});
  },subscription);
  await context.route(base+'/api/push/config',route=>route.fulfill({json:{enabled:true,publicKey:subscription.keys.p256dh}}));
  await context.route('**/api/d/*/push',async route=>{const data=route.request().postDataJSON(),desktop=new URL(route.request().url()).pathname.split('/')[3];operations.push({desktop,...data});if(data.op==='subscribe')records.set(desktop,data);if(data.op==='remove')records.delete(desktop);await route.fulfill({json:{ok:true}});});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const until=async predicate=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Push condition timed out');};
  try{
    await page.goto(base+'/app/');await page.getByRole('status').filter({hasText:'Connected'}).waitFor();assert.equal(await page.evaluate(()=>window.__pushSubscribeCalls),0,'Permission is never requested before a tap');
    await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await page.getByRole('button',{name:'Notifications',exact:true}).click();await page.getByRole('button',{name:'Enable notifications',exact:true}).click();await page.getByText('You’re all set.',{exact:true}).waitFor();await until(()=>records.size===3);
    assert.deepEqual(await page.evaluate(()=>window.__pushOptions),{userVisibleOnly:true,keyLength:65});await page.screenshot({path:join(directory,'mobile-notifications.png')});
    await page.getByRole('switch',{name:'Finished replies',exact:true}).click();await until(()=>[...records.values()].every(item=>!item.preferences.completed));await page.getByRole('button',{name:'Send a test notification',exact:true}).click();await page.getByText('Test notification sent.',{exact:true}).waitFor();assert.equal(operations.filter(item=>item.op==='test').length,1);
    await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    // A notification link must override the last computer and selected chat.
    await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();await page.getByRole('button',{name:/^Switch computer:/}).click();await page.getByRole('button').filter({hasText:'Office PC'}).click();await page.getByText('Office PC is ready.',{exact:true}).waitFor();
    const target=await actions.create('chat'),id=target.conversation.id;states.get(id).conversation.messages=[{id:randomUUID(),role:'assistant',text:'The notification opened the right chat.',status:'complete',error:null,createdAt:Date.now(),runId:null,route:'local'}];
    const navigate=base+'/app/#'+new URLSearchParams({desktop:computerIds[0],conversation:id,notification:randomUUID()});await page.goto(navigate);await page.getByText('The notification opened the right chat.',{exact:true}).waitFor();assert.equal(new URL(page.url()).hash,'');assert.equal(await page.evaluate(()=>localStorage.getItem('tinygpt-remote-desktop')),computerIds[0]);
    // Also exercise a fragment-only navigation in an already running PWA.
    await page.evaluate(url=>{location.hash=new URL(url).hash;},base+'/app/#'+new URLSearchParams({desktop:computerIds[0],conversation:[...states.keys()][0],notification:randomUUID()}));await page.waitForFunction(expected=>document.querySelector('.mobile-thread')?.getAttribute('data-conversation-id')===expected,[...states.keys()][0]);
    const monitor=await context.newPage();await monitor.goto(base+'/health');const cdp=await context.newCDPSession(monitor);let registration;
    cdp.on('ServiceWorker.workerRegistrationUpdated',event=>{registration=event.registrations.find(item=>item.scopeURL===base+'/')??registration;});await cdp.send('ServiceWorker.enable');await until(()=>!!registration);
    const notification={web_push:8030,notification:{title:'Approval needed',body:'Studio PC · Review a request to continue.',navigate,tag:'tinygpt-background-test',data:{desktop:computerIds[0],conversationId:id,eventId:randomUUID(),navigate}}};
    await page.close();
    await cdp.send('ServiceWorker.deliverPushMessage',{origin:base,registrationId:registration.registrationId,data:JSON.stringify(notification)});
    await monitor.waitForFunction(async()=>{const registration=await navigator.serviceWorker.ready;return(await registration.getNotifications()).some(item=>item.title==='Approval needed');});
    console.log('Background service-worker notification displayed with the companion page closed.');
    const reopened=await context.newPage();await reopened.goto(base+'/app/');await reopened.getByRole('status').filter({hasText:'Connected'}).waitFor();await reopened.getByRole('button',{name:'Expand sidebar',exact:true}).click();await reopened.getByRole('button',{name:'Notifications',exact:true}).click();await reopened.getByRole('button',{name:'Turn off notifications',exact:true}).click();await until(()=>records.size===0);assert.equal(await reopened.evaluate(()=>localStorage.getItem('tinygpt-push-enabled')),'false');assert.deepEqual(errors,[]);
    console.log('Push UI passed: explicit opt-in, three-computer subscription, preferences, test action, cross-computer and same-page chat links, background display and opt-out.');
  }finally{await context.close();}
}
