import { useEffect,useRef,useState } from 'react';
import { defaultPushPreferences,type PushPreferences } from '../../shared/remote-push';
import { currentInstallEnvironment } from './install-environment';
import { pairingRequest,type Computer } from './mobile-pairing';

function saved(key:string){try{return localStorage.getItem(key);}catch{return null;}}
function save(key:string,value:string){try{localStorage.setItem(key,value);}catch{}}
function preferences():PushPreferences{try{const value=JSON.parse(saved('tinygpt-push-preferences')??'null');if(typeof value?.completed==='boolean'&&typeof value?.attention==='boolean')return {completed:value.completed,attention:value.attention};}catch{}return {...defaultPushPreferences};}
function keyBytes(key:string){return Uint8Array.from(atob(key.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));}
export function consumePushTarget(){
  const hash=new URLSearchParams(location.hash.slice(1)),desktop=hash.get('desktop'),conversationId=hash.get('conversation'),eventId=hash.get('notification');
  if(!desktop||!/^[a-f0-9]{64}$/.test(desktop)||!conversationId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(conversationId)||!eventId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(eventId))return null;
  try{sessionStorage.setItem('tinygpt-selected:'+desktop,conversationId);sessionStorage.removeItem('tinygpt-navigation:'+desktop);localStorage.setItem('tinygpt-remote-desktop',desktop);}catch{}
  history.replaceState(null,'','/app/');return {desktop,conversationId};
}
export function useMobilePush(computers:Computer[],selectedDesktop?:string){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[enabled,setEnabled]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [settings,setSettings]=useState(preferences),[registration,setRegistration]=useState<ServiceWorkerRegistration|null>(null),[publicKey,setPublicKey]=useState(''),[permission,setPermission]=useState<NotificationPermission>(()=>'Notification'in window?Notification.permission:'denied');
  const ios=currentInstallEnvironment().platform==='ios',installed=matchMedia('(display-mode: standalone)').matches||!!(navigator as Navigator&{standalone?:boolean}).standalone;
  const supported='serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
  const installRequired=ios&&!installed;
  const clientId=useRef(saved('tinygpt-push-client')??crypto.randomUUID());
  const latest=useRef(computers);latest.current=computers;
  const syncing=useRef<Promise<void>|null>(null),syncAgain=useRef(false),synced=useRef(new Map<string,string>());
  const testing=useRef(false),selected=useRef(selectedDesktop);selected.current=selectedDesktop;
  const desired=useRef(saved('tinygpt-push-enabled')==='true');
  const [revision,setRevision]=useState(0),[bootstrap,setBootstrap]=useState(0);
  const computerIds=computers.filter(item=>item.status==='paired').map(item=>item.desktop).sort().join(',');
  useEffect(()=>{save('tinygpt-push-client',clientId.current);},[]);
  function workerSettings(active:boolean){registration?.active?.postMessage({type:'push-settings',enabled:active,clientId:clientId.current,preferences:settings,desktops:latest.current.filter(item=>item.status==='paired').map(item=>item.desktop).slice(0,20)});}
  async function sync(sub:PushSubscription,force=false){
    const signature=JSON.stringify(settings)+sub.endpoint;
    const targets=latest.current.filter(item=>item.status==='paired'&&(force||synced.current.get(item.desktop)!==signature));
    const results=await Promise.allSettled(targets.map(async item=>{await pairingRequest('/api/d/'+item.desktop+'/push',{op:'subscribe',clientId:clientId.current,subscription:sub.toJSON(),preferences:settings});synced.current.set(item.desktop,signature);}));
    workerSettings(true);if(results.some(result=>result.status==='rejected'))throw Error('Some computers could not be updated. We’ll retry when you reconnect.');setError('');
  }
  useEffect(()=>{
    if(!supported||installRequired)return;let active=true;
    void Promise.all([navigator.serviceWorker.ready,fetch('/api/push/config',{signal:AbortSignal.timeout(10000)}).then(response=>response.json())]).then(async([reg,config])=>{
      if(!active)return;setRegistration(reg);if(config.enabled&&typeof config.publicKey==='string'){setPublicKey(config.publicKey);setError('');}else setError('Notifications are not available yet.');
      const sub=await reg.pushManager.getSubscription();if(!active)return;
      const allowed=Notification.permission==='granted'&&!!sub&&saved('tinygpt-push-enabled')!=='false';desired.current=allowed;setEnabled(allowed);setPermission(Notification.permission);if(allowed){save('tinygpt-push-enabled','true');setRevision(value=>value+1);}
    }).catch(()=>{if(active)setError('Notifications are unavailable right now. Try again shortly.');});
    return()=>{active=false;};
  },[supported,installRequired,bootstrap]);
  useEffect(()=>{
    if(!registration||!publicKey||!enabled)return;
    if(syncing.current){syncAgain.current=true;return;}
    syncing.current=registration.pushManager.getSubscription().then(async sub=>{if(sub)await sync(sub);}).catch(cause=>setError(cause.message)).finally(()=>{syncing.current=null;if(syncAgain.current){syncAgain.current=false;setRevision(value=>value+1);}});
  },[registration,publicKey,computerIds,enabled,revision,settings]);
  useEffect(()=>{
    if(!supported)return;
    const refresh=()=>{if(document.visibilityState==='hidden')return;if(!registration||!publicKey)setBootstrap(value=>value+1);setPermission(Notification.permission);if(Notification.permission!=='granted'&&desired.current){setEnabled(false);desired.current=false;save('tinygpt-push-enabled','false');workerSettings(false);}if(desired.current)setRevision(value=>value+1);};
    const retryTimer=setInterval(refresh,30000);window.addEventListener('online',refresh);document.addEventListener('visibilitychange',refresh);navigator.serviceWorker.addEventListener('message',refresh);
    return()=>{clearInterval(retryTimer);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',refresh);navigator.serviceWorker.removeEventListener('message',refresh);};
  },[supported,registration,publicKey,settings]);
  useEffect(()=>{if(computerIds&&publicKey&&installed&&!enabled&&permission==='default'&&!saved('tinygpt-push-prompted')){save('tinygpt-push-prompted','true');setOpen(true);}},[computerIds,publicKey,installed,enabled,permission]);
  async function enable(){
    if(!registration||!publicKey||permission==='denied')return;
    // Invoke subscribe directly from the tap: iOS requires user activation.
    const subscribing=registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(publicKey)});
    setBusy(true);setError('');setNotice('');
    try{const sub=await subscribing;setPermission(Notification.permission);desired.current=true;save('tinygpt-push-enabled','true');await sync(sub,true);setEnabled(true);setNotice('You’re all set.');}
    catch(cause){setPermission(Notification.permission);setError(Notification.permission==='denied'?'Notifications are blocked. You can allow them in your phone’s settings.':cause instanceof Error?cause.message:'Notifications could not be enabled. Try again.');}
    finally{if(desired.current)setEnabled(true);setBusy(false);}
  }
  async function disable(){
    setBusy(true);setError('');setNotice('');desired.current=false;save('tinygpt-push-enabled','false');setEnabled(false);workerSettings(false);synced.current.clear();
    try{await(await registration?.pushManager.getSubscription())?.unsubscribe();await Promise.allSettled(latest.current.filter(item=>item.status==='paired').map(item=>pairingRequest('/api/d/'+item.desktop+'/push',{op:'remove',clientId:clientId.current})));}catch{setError('Check your phone’s notification settings if alerts are still enabled.');}finally{setBusy(false);}
  }
  function change(key:keyof PushPreferences,value:boolean){const next={...settings,[key]:value};synced.current.clear();setSettings(next);save('tinygpt-push-preferences',JSON.stringify(next));}
  async function test(){if(testing.current)return;const computer=latest.current.find(item=>item.status==='paired'&&item.desktop===selected.current)??latest.current.find(item=>item.status==='paired');if(!computer){setError('Connect a computer first.');return;}testing.current=true;setBusy(true);setError('');setNotice('');try{const sub=await registration?.pushManager.getSubscription();if(!sub){setEnabled(false);throw Error('Enable push notifications again.');}await pairingRequest('/api/d/'+computer.desktop+'/push',{op:'subscribe',clientId:clientId.current,subscription:sub.toJSON(),preferences:settings});await pairingRequest('/api/d/'+computer.desktop+'/push',{op:'test',clientId:clientId.current});setNotice('Test sent.');}catch(cause){setError(cause instanceof Error?cause.message:'Test could not be sent.');}finally{testing.current=false;setBusy(false);}}
  return {open,setOpen,busy,enabled,error,notice,settings,supported,installRequired,permission,retry:()=>setBootstrap(value=>value+1),ready:!!registration&&!!publicKey,enable,disable,change,test};
}
export type MobilePushState=ReturnType<typeof useMobilePush>;
