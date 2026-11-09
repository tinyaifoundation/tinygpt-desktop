const cacheName = 'tinygpt-static-v1';
self.addEventListener('install',event => { event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(['/offline.html','/icons/icon-192.png','/icons/icon-512.png']))); self.skipWaiting(); });
self.addEventListener('activate',event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch',event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/manifest.webmanifest') return;
  if (request.mode === 'navigate') { event.respondWith(fetch(request).catch(() => caches.match('/offline.html'))); return; }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) event.respondWith(caches.open(cacheName).then(async cache => {
    const saved = await cache.match(request); if (saved) return saved;
    const response = await fetch(request); if (response.ok) { try { await cache.put(request,response.clone()); const keys = await cache.keys(); if (keys.length > 160) await cache.delete(keys[0]); } catch {} } return response;
  }));
});

const pushCache='tinygpt-push-settings-v1',pushSettingsURL=new URL('/__push-settings',self.location.origin).href;
const desktopId=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
async function pushSettings(){try{return await(await caches.open(pushCache)).match(pushSettingsURL).then(value=>value?.json());}catch{return null;}}
async function badge(){try{const notifications=await self.registration.getNotifications();if(notifications.length)await self.navigator.setAppBadge?.(notifications.length);else await self.navigator.clearAppBadge?.();}catch{}}
function notificationURL(value){
  try{const url=new URL(value,self.location.origin),hash=new URLSearchParams(url.hash.slice(1));if(url.origin===self.location.origin&&url.pathname==='/app/'&&desktopId.test(hash.get('desktop')??'')&&uuid.test(hash.get('conversation')??'')&&uuid.test(hash.get('notification')??''))return url.href;}catch{}
  return self.location.origin+'/app/';
}
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let payload;try{payload=event.data?.json();}catch{}
    const item=payload?.notification??{},navigate=notificationURL(item.navigate),data=item.data??{};
    const existing=await self.registration.getNotifications().catch(()=>[]);
    const duplicate=existing.some(notification=>notification.data?.eventId===data.eventId&&data.eventId);
    // Always show a visible notification, including while the app is open.
    // Safari requires this; the declarative payload is a fallback if this fails.
    await self.registration.showNotification(typeof item.title==='string'?item.title.slice(0,100):'TinyGPT needs your attention',{
      body:typeof item.body==='string'?item.body.slice(0,300):'Open TinyGPT to continue.',icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',
      tag:typeof item.tag==='string'?item.tag.slice(0,150):'tinygpt',renotify:!duplicate,silent:false,
      data:{desktop:data.desktop,conversationId:data.conversationId,eventId:data.eventId,navigate},timestamp:Number.isFinite(item.timestamp)?item.timestamp:Date.now(),
    });
    await badge();
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();const navigate=notificationURL(event.notification.data?.navigate);
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true}),client=windows.find(item=>item.url.startsWith(self.location.origin+'/app/'));
    if(client)try{await client.navigate(navigate);await client.focus();await badge();return;}catch{}
    await self.clients.openWindow(navigate);await badge();
  })());
});
self.addEventListener('notificationclose',event=>event.waitUntil(badge()));
self.addEventListener('message',event=>{
  const data=event.data;
  if(data?.type==='push-settings'&&uuid.test(data.clientId??'')&&typeof data.enabled==='boolean'&&typeof data.preferences?.completed==='boolean'&&typeof data.preferences?.attention==='boolean'&&Array.isArray(data.desktops)){
    event.waitUntil((async()=>{const cache=await caches.open(pushCache);await cache.put(pushSettingsURL,Response.json({enabled:data.enabled,clientId:data.clientId,preferences:data.preferences,desktops:data.desktops.filter(id=>typeof id==='string'&&desktopId.test(id)).slice(0,20)}));if(!data.enabled){for(const notification of await self.registration.getNotifications())notification.close();await badge();}})());
  }
  if(data?.type==='conversation-open'&&desktopId.test(data.desktop??'')&&uuid.test(data.conversationId??''))event.waitUntil((async()=>{for(const notification of await self.registration.getNotifications())if(notification.data?.desktop===data.desktop&&notification.data?.conversationId===data.conversationId)notification.close();await badge();})());
});
self.addEventListener('pushsubscriptionchange',event=>{
  event.waitUntil((async()=>{
    const settings=await pushSettings();if(!settings?.enabled)return;
    const response=await fetch('/api/push/config',{signal:AbortSignal.timeout(10000)}),config=await response.json();if(!config.enabled)return;
    const key=Uint8Array.from(atob(config.publicKey.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
    const permission=await self.registration.pushManager.permissionState({userVisibleOnly:true,applicationServerKey:key});if(permission!=='granted')return;
    const subscription=event.newSubscription??await self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    await Promise.allSettled(settings.desktops.map(desktop=>fetch('/api/d/'+desktop+'/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'subscribe',clientId:settings.clientId,subscription:subscription.toJSON(),preferences:settings.preferences}),signal:AbortSignal.timeout(10000)})));
    for(const client of await self.clients.matchAll({type:'window'}))client.postMessage({type:'push-subscription-changed'});
  })());
});
