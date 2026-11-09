import { finishMobileBoot } from '../lib/mobile-boot';
import type { LibrarySnapshot } from '../../shared/chat';
import { installDesktop,isInstalledCompanion } from '../lib/mobile-install';
import {consumePushTarget,useMobilePush} from '../lib/mobile-push';
import { pairingKey } from '../lib/mobile-keys';
import {MobileNotifications} from './MobileNotifications';
import { useEffect,useRef,useState,type ReactNode } from 'react';
import { Check, ChevronRight, Monitor, Plus, Devices, RefreshCw } from '../icons';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { InstallGuide } from './InstallGuide';
import { ComputerScanner } from './ComputerScanner';
import { cachedComputers,claimPairing,entryFromURL,pairingRequest,parsePairingLink,saveComputers,selectedComputer,rememberPairingEntry,type Computer,type PairingEntry } from '../lib/mobile-pairing';
const initialPushTarget=consumePushTarget();
const initialSetup = installDesktop(location.href);
const initialEntry = entryFromURL();
export function MobileCompanion({ chat }: { chat: (desktop: string,manage: () => void,notifications:()=>void,initialConversationId?:string,activityChanged?:(items:LibrarySnapshot["notificationItems"])=>void) => ReactNode }) {
  const [computers,setComputers] = useState<Computer[]>(cachedComputers), [selected,setSelected] = useState<string | null>(() => initialPushTarget?.desktop ?? initialEntry?.desktop ?? selectedComputer());
  const [entry,setEntry] = useState<PairingEntry | null>(initialEntry), [checking,setChecking] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [scanner,setScanner] = useState(false), [picker,setPicker] = useState(false), [browser,setBrowser] = useState(false);
  const push=useMobilePush(computers,selected??undefined);
  const [notificationSettings,setNotificationSettings]=useState(false);
  useEffect(()=>{const settings=()=>{setNotificationSettings(true);push.setOpen(true);};window.addEventListener('tinygpt-notification-settings',settings);return()=>window.removeEventListener('tinygpt-notification-settings',settings);},[]);
  const [activity,setActivity]=useState<LibrarySnapshot["notificationItems"]>([]);
  const [pushTarget,setPushTarget]=useState(initialPushTarget);
  const [setupDesktop,setSetupDesktop]=useState(initialEntry?.desktop ?? initialSetup);
  const autoScanner=useRef(false);
  const installed=isInstalledCompanion();
  useEffect(()=>{const navigate=()=>{if(location.hash.includes('token=')){const next=entryFromURL();if(next){setEntry(next);setSelected(next.desktop);setSetupDesktop(next.desktop);}return;}const target=consumePushTarget();if(target){select(target.desktop);setPushTarget(target);setBrowser(true);window.dispatchEvent(new CustomEvent('tinygpt-notification-open',{detail:target}));}};window.addEventListener('hashchange',navigate);return()=>window.removeEventListener('hashchange',navigate);},[]);
  const revision = useRef(0);
  const mounted = useRef(false), known = useRef(computers), discovery = useRef<Promise<void> | null>(null);
  const companion = browser || location.pathname.startsWith('/app') || installed;
  useEffect(()=>{if(!setupDesktop || !/^[a-f0-9]{64}$/.test(setupDesktop))return;void fetch('/api/mobile/install',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({desktop:setupDesktop}),signal:AbortSignal.timeout(10000)}).catch(()=>{});},[setupDesktop]);
  const computer = selected ? computers.find(item => item.desktop === selected) : computers.find(item => item.status === 'paired') ?? computers[0];
  useEffect(()=>{if(installed && !checking && !computer && !entry && !busy && !autoScanner.current){autoScanner.current=true;setScanner(true);}},[installed,checking,!!computer,!!entry,busy]);
  function remember(list: Computer[]) { known.current = list; setComputers(list); saveComputers(list); }
  useEffect(()=>{const forgotten=(event:Event)=>{const id=(event as CustomEvent<string>).detail;revision.current++;const list=known.current.filter(item=>item.desktop!==id);remember(list);setSelected(previous=>previous===id?list[0]?.desktop??null:previous);setActivity([]);setEntry(null);setChecking(false);setPushTarget(null);};window.addEventListener('tinygpt-computer-forgotten',forgotten);return()=>window.removeEventListener('tinygpt-computer-forgotten',forgotten);},[]);
  function select(desktop: string) { if (selected !== desktop) setActivity([]); setSelected(desktop); setPicker(false); setError(''); try { localStorage.setItem('tinygpt-remote-desktop',desktop); } catch {} }
  useEffect(() => { if (!selected && computer) select(computer.desktop); },[selected,computer?.desktop]);
  async function discover() {
    if (discovery.current) return discovery.current;
    const expected = revision.current;
    const work = (async () => {
      try {
        const result = await pairingRequest('/api/mobile/session');
        let list = result.computers as Computer[];
        if(mounted.current && expected===revision.current && /^[a-f0-9]{64}$/.test(result.setupDesktop ?? ''))setSetupDesktop(result.setupDesktop);
        const usable = await Promise.all(list.map(async item => await pairingKey(item.desktop) ? item : undefined));
        list = usable.filter((item): item is Computer => !!item);
        for (const desktop of result.unavailable ?? []) if (!list.some(item => item.desktop === desktop)) list.push(...known.current.filter(item => item.desktop === desktop).map(item => ({ ...item,online: false })));
        if (mounted.current && expected === revision.current) { remember(list); setError(''); }
      } catch { if (mounted.current) { setError('Connection interrupted. Retrying…'); setComputers(previous => previous.map(item => ({ ...item,online: false }))); } }
      finally { if (mounted.current) setChecking(false); }
    })(); discovery.current = work; await work; if (discovery.current === work) discovery.current = null;
  }
  useEffect(() => {
    mounted.current = true; void discover();
    const wake = () => { if (document.visibilityState !== 'hidden') void discover(); };
    const timer = setInterval(wake,5000); window.addEventListener('online',wake); window.addEventListener('pageshow',wake); document.addEventListener('visibilitychange',wake);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener('online',wake); window.removeEventListener('pageshow',wake); document.removeEventListener('visibilitychange',wake); };
  },[]);
  useEffect(() => {
    if (!entry || !companion) return; let active = true; revision.current++; setBusy(true); setError('');
    void claimPairing(entry).then(value => {
      if (!active) return;
      remember([...known.current.filter(item => item.desktop !== value.desktop),value]); select(value.desktop); setBusy(false); setEntry(null); setChecking(false);
      rememberPairingEntry(null);
    }).catch(cause => { if (active) { setError(cause instanceof Error ? cause.message : 'Scan a new code.'); setChecking(false); } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  },[entry,companion]);
  function scan(text: string) { try { const next = parsePairingLink(text); setEntry(next); setScanner(false); setPicker(false); setSelected(next.desktop); rememberPairingEntry(next); } catch { setError('Scan the TinyGPT code on your computer.'); } }
  const add = () => { setScanner(true); setPicker(false); setError(''); };
  useEffect(()=>{if(!companion||busy||computer?.status==='pending'||!checking&&computer?.status!=='paired')finishMobileBoot();},[companion,busy,checking,computer?.status]);
  const waiting = <div className="mobile-pending-scene"><div className="mobile-pending-devices"><span><Devices /></span><i /><span><Monitor /></span></div><h1>{busy ? 'Finding your computer…' : 'One tap on your computer.'}</h1><p>{busy ? 'Just a moment.' : 'Approve this device in TinyGPT.'}</p><span className="mobile-pending-computer"><Monitor />{computer?.name || 'Your computer'}</span></div>;
  return <>
    {companion ? checking && !computer && !busy ? <main className="mobile-connect-page"><img className="mobile-connect-app" src="/icons/icon-192.png" alt="TinyGPT" /><span role="status">Opening TinyGPT…</span></main> : busy || computer?.status === 'pending' ? <main className="mobile-connect-page">{waiting}<Button variant="ghost" onClick={() => setPicker(true)}>Your computers<ChevronRight /></Button>{error && <p role="alert" className="mobile-setup-error">{error}</p>}</main> : computer?.status === 'paired' ? chat(computer.desktop,() => setPicker(true),()=>{setNotificationSettings(false);push.setOpen(true);},pushTarget?.desktop===computer.desktop?pushTarget.conversationId:undefined,setActivity) : <main className="mobile-connect-page"><img className="mobile-connect-app" src="/icons/icon-192.png" alt="" /><h1>{computers.length ? 'Your computers.' : 'Your TinyGPT. Anywhere.'}</h1><p>{computers.length ? 'Choose where to pick up.' : 'Let’s connect your computer.'}</p>{!!computers.length && <Button variant="pill" onClick={() => setPicker(true)}>Your computers<ChevronRight /></Button>}<Button variant="pill" disabled={busy} onClick={add}><Plus />Connect a computer</Button>{checking && <p role="status">Finding your computers…</p>}{error && <p role="alert" className="mobile-setup-error">{error}</p>}</main> : <InstallGuide desktop={entry?.desktop ?? setupDesktop ?? computer?.desktop} open={() => { setBrowser(true); history.replaceState(null,'','/app/'); if(!entry && !computer){autoScanner.current=true;setScanner(true);} }}>{error && <p role="alert" className="mobile-setup-error">{error}</p>}</InstallGuide>}
    {picker && <Dialog open change={setPicker} title="Your computers" className="mobile-computers-dialog"><div className="mobile-computer-cards">{computers.map(item => <button type="button" className="mobile-computer-card" key={item.desktop} onClick={() => select(item.desktop)}><span className="mobile-computer-avatar"><Monitor /></span><span><strong>{item.name}</strong><small><i className="mobile-connection-dot" data-state={item.status === 'pending' ? 'connecting' : item.online ? 'online' : 'offline'} />{item.status === 'pending' ? 'Waiting for approval' : item.online ? 'Online' : 'Offline · reconnects automatically'}</small></span>{computer?.desktop === item.desktop ? <Check /> : <ChevronRight />}</button>)}</div><Button variant="outline" className="mobile-add-computer" onClick={add}><Plus />Connect another computer</Button></Dialog>}
    <MobileNotifications initialSettings={notificationSettings} push={push} items={activity} openItem={item=>window.dispatchEvent(new CustomEvent("tinygpt-notification-open",{detail:{desktop:computer?.desktop,conversationId:item.conversationId,notificationId:item.id}}))} />
    {scanner && <ComputerScanner close={() => setScanner(false)} scan={scan} />}
  </>;
}
