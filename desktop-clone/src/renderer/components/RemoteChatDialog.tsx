import { useEffect, useRef, useState } from 'react';
import { Devices, Copy, Check, RefreshCw } from '../icons';
import type { DesktopBridge, Result } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import type { RemoteInvitation, RemoteStatus } from '../../shared/remote';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { ControlTooltip } from './ui/tooltip';
import { PairingQRCode } from './PairingQRCode';
import hero from '../assets/remote-pair-hero.png';

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error); return result.value; }

export function RemoteChatControl({ bridge, conversationId }: { bridge: DesktopBridge; conversationId: string }) {
  const [open, setOpen] = useState(false);
  return <><ControlTooltip label="Use on phone"><Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="Use on phone" onClick={() => setOpen(true)}><Devices className="size-4" /></Button></ControlTooltip>
    {open && <RemotePairingDialog bridge={bridge} conversationId={conversationId} close={() => setOpen(false)} />}
  </>;
}

export function RemotePairingDialog({ bridge, conversationId, initialConversationId, library, updateLibrary, close, changed }: {
  bridge: DesktopBridge; conversationId?: string; initialConversationId?: string; library?: LibrarySnapshot; updateLibrary?: (value: LibrarySnapshot) => void;
  close: () => void; changed?: (value: RemoteStatus) => void;
}) {
  const [status, setStatus] = useState<RemoteStatus | null>(null), [invitation, setInvitation] = useState<RemoteInvitation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false), [now, setNow] = useState(Date.now());
  const active = useRef(true), lock = useRef(false), started = useRef(false), revision = useRef(0), autoPairAt = useRef(0), anchor = useRef(conversationId || initialConversationId);
  const onChanged = useRef(changed); onChanged.current = changed;

  useEffect(() => {
    active.current = true;
    const refresh = () => {
      if (lock.current) return;
      const expected = revision.current;
      void bridge.remoteStatus().then(result => {
        if (!active.current || expected !== revision.current) return;
        if (result.ok) { setStatus(result.value); onChanged.current?.(result.value); }
        else setError(result.error);
      }).catch(() => { if (active.current) setError('Remote access is unavailable. Try again.'); });
    };
    refresh(); const timer = setInterval(refresh, 2500), countdown = setInterval(() => setNow(Date.now()), 1000);
    return () => { active.current = false; clearInterval(timer); clearInterval(countdown); };
  }, [bridge]);

  useEffect(() => {
    if (!status || started.current) return;
    started.current = true; void pair();
  }, [status]);

  async function pair() {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(true); setError(''); setCopied(false);
    try {
      if (!status?.configured) throw Error('Remote access is not configured.');
      let id = anchor.current;
      if (!id) {
        const saved = library ?? unwrap(await bridge.library());
        id = [...saved.conversations].filter(chat => chat.mode !== 'bot').sort((left,right) => right.updatedAt - left.updatedAt)[0]?.id;
        if (!id) { id = unwrap(await bridge.remoteCreateChat()).id; updateLibrary?.(unwrap(await bridge.library())); }
        anchor.current = id;
      }
      const next = unwrap(await bridge.remotePair(id, undefined, 'library'));
      if (!active.current) return;
      setInvitation(next); setNow(Date.now());
      const latest = unwrap(await bridge.remoteStatus());
      if (active.current) { setStatus(latest); onChanged.current?.(latest); }
    } catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Your code could not load. Try again.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  const paired = invitation && status?.devices.find(device => device.grantId === invitation.id);
  const request = invitation && status?.requests?.find(request => request.grantId === invitation.id);
  useEffect(() => { if (paired) setError(''); },[paired?.id]);
  const valid = invitation && invitation.expiresAt > now;
  useEffect(() => {
    if (invitation && !valid && !request && !paired && !busy && now >= autoPairAt.current && document.visibilityState !== 'hidden') { autoPairAt.current=now+15000; void pair(); }
  },[invitation?.id,valid,!!request,!!paired,busy,now]);
  useEffect(() => { if(!paired)return;const timer=setTimeout(close,1000);return()=>clearTimeout(timer); },[paired?.id,close]);
  async function approve(allow: boolean) {
    if (!request || lock.current) return; lock.current = true; revision.current++; setBusy(true); setError('');
    try { const latest = unwrap(await bridge.remoteApprovePairing(request.id,allow)); if (active.current) { setStatus(latest); onChanged.current?.(latest); if (!allow) setInvitation(null); } }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Try again.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function copy() {
    if (!invitation) return;
    try { await navigator.clipboard.writeText(invitation.url); if (active.current) setCopied(true); }
    catch { if (active.current) setError('The link could not be copied. Try again.'); }
  }
  return <Dialog open change={open => { if (!open) close(); }} title="Connect a device" titleHidden className="remote-pair-modal">
    <div className="remote-connect-hero"><img src={hero} alt="" /></div>
    <div className="remote-connect-body">
      <h2>{paired ? 'You’re connected.' : request ? 'Is this your device?' : 'Your TinyGPT, anywhere.'}</h2>
      <p className="remote-connect-caption">{paired ? paired.name : request ? request.name : 'Scan to connect. Make yourself at home.'}</p>
      {request && !paired ? <div className="remote-approve-device"><span className="remote-approve-icon"><Devices /></span><div className="remote-approve-actions"><Button variant="ghost" disabled={busy} onClick={() => void approve(false)}>Not mine</Button><Button variant="pill" disabled={busy} onClick={() => void approve(true)}>Connect device</Button></div></div> : paired ? <div className="remote-connect-success" role="status"><span><Check /></span><Button variant="pill" onClick={close}>Done</Button></div> : <>
        <div className="remote-code-stage" aria-busy={busy}>
          {valid ? <PairingQRCode value={invitation.url} /> : <div className="remote-code-placeholder" role="status">{busy || !status ? <><Devices /><span>Getting your code…</span></> : <><RefreshCw /><span>{invitation ? 'Code expired' : 'Ready to connect?'}</span><Button variant="pill" onClick={() => void pair()}>Get a new code</Button></>}</div>}
          {valid && <ControlTooltip label="Refresh QR code"><Button variant="ghost" size="icon" className="remote-code-refresh" aria-label="Refresh QR code" disabled={busy} onClick={() => void pair()}><RefreshCw className={busy ? 'animate-spin' : ''} /></Button></ControlTooltip>}
        </div>
        {valid && <div className="remote-code-footer"><Button variant="ghost" className="remote-copy-link" aria-label="Copy pairing link" disabled={busy} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy link'}</Button></div>}
      </>}
      {error && <p role="alert" className="remote-connect-error">{error}</p>}
    </div>
  </Dialog>;
}
