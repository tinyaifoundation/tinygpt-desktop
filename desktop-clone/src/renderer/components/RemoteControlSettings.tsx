import { useEffect, useRef, useState } from 'react';
import { Devices, RefreshCw, Plus } from '../icons';
import type { DesktopBridge, Result } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import type { RemotePreferences, RemoteStatus } from '../../shared/remote';
import { SettingRow, Switch } from './AppearanceSettings';
import { SettingsButton as Button } from './ui/settings-button';
import { RemotePairingDialog } from './RemoteChatDialog';

function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error); return result.value; }
export function RemoteControlSettings({ bridge, library, updateLibrary, conversationId }: {
  bridge: DesktopBridge; library: LibrarySnapshot; updateLibrary: (value: LibrarySnapshot) => void; conversationId?: string | null;
}) {
  const [status, setStatus] = useState<RemoteStatus | null>(null), [pairing, setPairing] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), active = useRef(true), revision = useRef(0);
  useEffect(() => {
    active.current = true;
    const refresh = () => {
      if (lock.current || document.visibilityState === 'hidden') return;
      const expected = revision.current;
      void bridge.remoteStatus().then(result => {
        if (!active.current || expected !== revision.current) return;
        if (result.ok) setStatus(result.value); else setError(result.error);
      }).catch(() => { if (active.current) setError('Remote access could not be checked.'); });
    };
    refresh(); const timer = setInterval(refresh, 5000); document.addEventListener('visibilitychange', refresh);
    return () => { active.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [bridge]);
  async function act(operation: () => Promise<RemoteStatus>) {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(true); setError('');
    try { const value = await operation(); if (active.current) setStatus(value); }
    catch (cause) { if (active.current) setError(cause instanceof Error ? cause.message : 'Remote access could not be updated.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  const configure = (value: RemotePreferences) => act(async () => unwrap(await bridge.remoteConfigure(value)));
  const currentChat = library.conversations.find(chat => chat.id === conversationId && (!chat.mode || chat.mode === 'chat'));
  const connection = !status ? 'Checking…' : !status.enabled ? 'Off' : status.connected ? 'Connected' : 'Reconnecting…';
  return <div className="remote-settings-page">
    <p className="remote-settings-intro">Continue your TinyGPT chats from a phone or another browser. Your computer runs the models and tools.</p>
    <section className="settings-content-group"><h2>Remote access</h2><div className="settings-card">
      <SettingRow title="Allow remote connections" description="Paired devices can access their shared chats while TinyGPT is open. Turning this off keeps your paired devices saved."><Switch label="Allow remote connections" disabled={busy || !status} value={!!status?.enabled} change={enabled => void configure({ enabled })} /></SettingRow>
      <SettingRow title="Connection status" description={status?.enabled ? 'Keep TinyGPT open and your computer connected to the internet.' : 'Add a device or turn on remote connections to get started.'}><span className="remote-status-badge" data-connected={status?.connected || undefined}>{connection}</span></SettingRow>
    </div></section>
    <section className="settings-content-group">
      <div className="remote-section-heading"><h2>Paired devices</h2><div><Button size="icon" variant="ghost" aria-label="Refresh remote devices" disabled={busy} onClick={() => void act(async () => unwrap(await bridge.remoteStatus()))}><RefreshCw /></Button><Button disabled={busy || !status} onClick={() => setPairing(true)}><Plus />Add device</Button></div></div>
      {!!status?.requests?.length && <div className="settings-card remote-devices-card">{status.requests.map(request => <div className="remote-settings-device" key={request.id}><Devices className="remote-device-icon" /><div className="remote-device-copy"><p>{request.name}</p><span>Wants to connect</span></div><Button variant="ghost" disabled={busy} onClick={() => void act(async () => unwrap(await bridge.remoteApprovePairing(request.id,false)))}>Not mine</Button><Button disabled={busy} onClick={() => void act(async () => unwrap(await bridge.remoteApprovePairing(request.id,true)))}>Connect device</Button></div>)}</div>}
      <p className="settings-notice">Settings management also grants access to plugins, Projects, and saved memories on this computer.</p><div className="settings-card remote-devices-card">
        {status?.devices.length ? status.devices.map(device => {
          const chat = library.conversations.find(chat => chat.id === device.conversationId);
          return <div className="remote-settings-device" key={device.id}><Devices aria-hidden="true" className="remote-device-icon" /><div className="remote-device-copy"><p>{device.name}</p><span>{device.scope === 'library' ? 'All Chat and Work conversations' : chat?.title ?? 'Shared chat'}</span><small>Paired {new Date(device.createdAt).toLocaleDateString()} · Access expires {new Date(device.expiresAt).toLocaleDateString()}</small></div><Button variant="ghost" disabled={busy} aria-label={`Change conversation access for ${device.name}`} onClick={() => void act(async () => unwrap(await bridge.remoteSetScope(device.id, device.scope === 'library' ? 'conversation' : 'library')))}>{device.scope === 'library' ? 'Limit to this chat' : 'Enable conversations'}</Button>{device.scope==='library'&&<Button variant="ghost" disabled={busy} aria-label={`Settings management for ${device.name}`} onClick={()=>void act(async()=>unwrap(await bridge.remoteSetManagement(device.id,!device.management)))}>{device.management?'Disable settings management':'Allow settings management'}</Button>}<Button variant="muted" disabled={busy} aria-label={`Revoke access for ${device.name}`} onClick={() => void act(async () => unwrap(await bridge.remoteRevoke(device.id)))}>Revoke access</Button></div>;
        }) : <div className="remote-devices-empty"><Devices aria-hidden="true" /><div><p>{status ? 'No devices paired' : 'Checking your devices…'}</p><span>Add a device to get a QR code.</span></div></div>}
      </div>
    </section>
    <section className="settings-content-group"><h2>Other settings</h2><div className="settings-card">
      <SettingRow title="Keep this computer awake" description="Prevent automatic system sleep while remote connections are allowed. Your display can still turn off."><Switch label="Keep this computer awake" disabled={busy || !status} value={!!status?.keepAwake} change={keepAwake => void configure({ keepAwake })} /></SettingRow>
      {!!status?.devices.length && <SettingRow title="Remove all remote access" description="Forget every paired device. Each device will need a new QR code."><Button variant="muted" disabled={busy} onClick={() => void act(async () => unwrap(await bridge.remoteDisconnect()))}>Disconnect all devices</Button></SettingRow>}
    </div></section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {status?.error && <p role="status" className="text-sm text-muted-foreground">{status.error}</p>}
    {pairing && <RemotePairingDialog bridge={bridge} library={library} updateLibrary={updateLibrary} initialConversationId={currentChat?.id} close={() => setPairing(false)} changed={value => { revision.current++; setStatus(value); }} />}
  </div>;
}
