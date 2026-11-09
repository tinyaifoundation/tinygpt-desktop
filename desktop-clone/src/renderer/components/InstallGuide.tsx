import { currentMobileIcon } from '../lib/mobile-icon';
import { MobileIconPicker } from './MobileIconPicker';
import { Children, useEffect, useState, type ReactNode } from 'react';
import { ArrowUp, Check, Copy, Download, MoreHorizontal, Plus, ChevronRight, Monitor } from '../icons';
import { Button } from './ui/button';
import { currentInstallEnvironment } from '../lib/install-environment';
import { installLink } from '../lib/mobile-install';
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
export function InstallGuide({ desktop, pending, online, computerName, children, open }: { desktop?: string; pending?: boolean; online?: boolean; computerName?: string; children?: ReactNode; open?: () => void }) {
  const [environment,setEnvironment] = useState(() => currentInstallEnvironment());
  const platform = environment.platform, handoff = environment.safariHandoff;
  useEffect(() => {
    let active = true; const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    if (brave?.isBrave) void brave.isBrave().then(value => { if (active && value) setEnvironment(currentInstallEnvironment(true)); }).catch(() => {});
    return () => { active = false; };
  },[]);
  const [prompt,setPrompt] = useState<InstallPrompt | null>(null), [copied,setCopied] = useState(false), [error,setError] = useState('');
  const [manualLink,setManualLink] = useState('');
  useEffect(() => { const install = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); }; window.addEventListener('beforeinstallprompt',install); return () => window.removeEventListener('beforeinstallprompt',install); },[]);
  async function copy() {
    setError(''); setManualLink('');
    const text = Promise.resolve(installLink(location.origin,desktop)).then(value=>{const url=new URL(value);url.searchParams.set("icon",currentMobileIcon());return url.href;});
    void text.catch(() => {});
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        const content = text.then(value => new Blob([value],{ type: 'text/plain' })); void content.catch(() => {});
        // Start the clipboard operation inside the tap; Safari rejects it if
        // the network request is awaited before calling clipboard.write().
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })]);
      } else await navigator.clipboard.writeText(await text);
      setCopied(true);
    } catch { const value = await text.catch(() => ''); if (value) { setManualLink(value); setError('Touch and hold to copy.'); } else setError('Could not copy. Try again.'); }
  }
  return <main className="install-guide" data-install-platform={platform} data-install-browser={environment.browser}><div className="install-guide-inner">
    <header className="install-hero"><div className="install-device-scene"><img src="/icons/icon-192.png" alt="TinyGPT" /></div><h1>{handoff ? <>Open in Safari.</> : <>Your TinyGPT.<br />On your Home Screen.</>}</h1></header>
    {Children.toArray(children).filter(child => child !== '').length > 0 && <div className="install-connect">{children}</div>}
    {handoff ? <ol className="install-steps install-handoff-steps" aria-label="Continue in Safari">
      <li><div className="install-illustration install-handoff-copy"><Copy /><div className="install-fake-link"><img src="/icons/icon-192.png" alt="" /><i /><i /></div><span className="install-fake-copy">{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy link'}</span></div><p><b>1</b>Copy link</p></li>
      <li><div className="install-illustration install-handoff-safari"><div className="install-safari-icon"><i /></div><span>Safari</span><div className="install-tap" /></div><p><b>2</b>Open Safari</p></li>
      <li><div className="install-illustration install-handoff-paste"><div className="install-mini-content"><img src="/icons/icon-192.png" alt="" /><i /><i /></div><div className="install-paste-pill">Paste &amp; Go<ChevronRight /></div><div className="install-browser-bar"><span>Search or website</span></div></div><p><b>3</b>Paste &amp; open</p></li>
    </ol> : platform === 'desktop' ? <div className="install-desktop-note"><Monitor /><span>Open TinyGPT → Remote Control</span></div> : <ol className="install-steps" aria-label="Install TinyGPT">
      <li><div className="install-illustration install-browser"><div className="install-mini-content"><img src="/icons/icon-192.png" alt="" /><i /><i /></div><div className="install-browser-bar"><span>tinygpt…</span>{platform === 'ios' ? <span className="install-share-highlight"><ArrowUp /></span> : <span className="install-share-highlight"><MoreHorizontal /></span>}</div><div className="install-tap" /></div><p><b>1</b>{platform === 'ios' ? 'Share' : 'Menu'}</p></li>
      <li><div className="install-illustration install-share-sheet"><div className="install-sheet-handle" /><div className="install-sheet-row"><Copy /><i /></div><div className="install-sheet-row install-sheet-selected"><Plus /><span>{platform === 'ios' ? 'Add to Home Screen' : 'Install app'}</span></div><div className="install-sheet-row"><Download /><i /></div></div><p><b>2</b>{platform === 'ios' ? 'Add to Home Screen' : 'Install app'}</p></li>
      <li><div className="install-illustration install-home"><div className="install-home-grid"><i /><i /><i /><div className="install-home-app"><img src="/icons/icon-192.png" alt="" /><span>TinyGPT</span></div><i /><i /></div><div className="install-tap" /></div><p><b>3</b>Open TinyGPT</p></li>
    </ol>}
    <details className="install-icon-options"><summary>Choose an icon</summary><MobileIconPicker /></details>
    {handoff && <Button variant="pill" className="install-primary" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? 'Link copied' : 'Copy link for Safari'}</Button>}
    {prompt && !handoff && platform !== 'desktop' && <Button variant="pill" className="install-primary" onClick={() => { void prompt.prompt(); }}>Install TinyGPT<Download /></Button>}
    {platform !== 'desktop' && <p className="install-next">Open the app. Point at your computer. You’re in.</p>}
    {open && <div className="install-ready"><Button variant="ghost" className="install-continue-browser" onClick={open}>Continue in browser<ChevronRight /></Button></div>}
    {error && <p className="install-error" role="alert">{error}</p>}
    {manualLink && <input className="control install-manual-link" aria-label="Setup link to copy" readOnly value={manualLink} onFocus={event => event.currentTarget.select()} />}
  </div></main>;
}
