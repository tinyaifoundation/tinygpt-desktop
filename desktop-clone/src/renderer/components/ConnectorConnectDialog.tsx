import { useEffect, useState } from 'react';
import { LoaderCircle, ShieldCheck } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { PluginSnapshot, PluginView, SuggestedConnector } from '../../shared/plugins';
import { connectorCatalog, connectorMatches } from '../../shared/connector-catalog';
import { DialogRoot as Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { SettingsButton as Button } from './ui/settings-button';
import { ScrollArea } from './ui/scroll-area';
import { connectorSplashAssets } from '../lib/connector-splash-assets';

const access: Record<SuggestedConnector, string> = {
  gmail: 'Read your email. Sending is optional and follows your approval settings.',
  gdrive: 'Find files and read Google Docs. No file editing.',
  gcalendar: 'Read events and check availability. No event changes or invitations.',
  notion: 'Choose the workspace and pages TinyGPT can access. Actions follow your approval settings.',
  github: 'GitHub grants read and write repository access. Creating issues follows your approval settings.',
  slack: 'Search messages and read channels you can access. Posting follows your approval settings.',
  higgsfield: 'Uses your workspace credits. Review generation before spending. Upload reference files in Higgsfield.',
  linear: 'Read issues and projects in your selected workspace. No changes.',
};
export function ConnectorConnectDialog({ kind, bridge, initialEntry, close, connected }: { kind: SuggestedConnector; bridge: DesktopBridge; initialEntry?: PluginView; close: () => void; connected: (id: string) => void | Promise<void> }) {
  const info = connectorCatalog.find(item => item.id === kind)!;
  const [entry, setEntry] = useState(initialEntry), [error, setError] = useState(''), [busy, setBusy] = useState(false), [allowSend, setAllowSend] = useState(false);
  useEffect(() => {
    let alive = true;
    const update = (snapshot: PluginSnapshot) => { if (!alive) return; const value = initialEntry ? snapshot.entries.find(item => item.id === initialEntry.id) : snapshot.entries.find(item => connectorMatches(item.manifest, kind)); if (value) setEntry(value); };
    const unsubscribe = bridge.onPluginsUpdate(update);
    void bridge.installConnector(kind).then(result => { if (result.ok) update(result.value); else if (alive) setError(result.error); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge, kind, initialEntry?.id]);
  const isConnecting = entry?.status === 'connecting';
  const provider = ['notion', 'higgsfield', 'linear', 'github', 'slack'].includes(kind) ? info.name : 'Google';
  const cancel = () => { if (entry && (isConnecting || busy)) void bridge.disconnectPlugin(entry.id); close(); };
  async function connect() {
    if (!entry) return;
    setBusy(true); setError('');
    try {
      if (!entry.config.enabled) { const enabled = await bridge.savePlugin({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: true } }); if (!enabled.ok) throw Error(enabled.error); }
      const result = entry.status === 'connected' ? await bridge.plugins() : entry.manifest.server ? await bridge.connectPlugin(entry.id) : await bridge.signInConnector(entry.id, allowSend);
      if (!result.ok) throw Error(result.error);
      const latest = result.value.entries.find(item => item.id === entry.id);
      if (latest?.status !== 'connected') throw Error(latest?.message || 'The connection did not finish. Try again.');
      await connected(entry.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The connection did not finish.'); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) cancel(); }}><DialogContent className="connector-connect-modal">
    <img className="connector-connect-splash" src={connectorSplashAssets[kind]} alt="" />
    <DialogHeader><DialogTitle>Connect {info.name}</DialogTitle><DialogDescription>Review access on {provider} before connecting.</DialogDescription></DialogHeader>
    <ScrollArea type="auto" className="connector-connect-content" viewportClassName="connector-connect-viewport" viewportTabIndex={-1}><div className="connector-connect-fields">
      <p className="connector-access-note"><ShieldCheck />{access[kind]}</p>
      {entry?.status === 'connected' && <p>Ready to use in this conversation.</p>}
      {kind === 'gmail' && entry?.status !== 'connected' && <label className="connector-check"><input type="checkbox" checked={allowSend} disabled={busy || isConnecting} onChange={event => setAllowSend(event.target.checked)} />Also allow sending email</label>}
      {entry?.oauthReleaseStatus === 'review' && <p className="connector-review-note">Google verification is pending. You may see an unverified-app notice.</p>}
      {entry?.deviceCode && <div className="connector-device-code"><p>Enter this code in GitHub</p><strong>{entry.deviceCode}</strong></div>}
      {(isConnecting || busy) && <p role="status" className="connector-connecting"><LoaderCircle className="animate-spin" />{entry?.message || 'Finish sign-in in your browser.'}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div></ScrollArea>
    <DialogFooter><Button variant="muted" onClick={cancel}>{isConnecting || busy ? 'Cancel sign-in' : 'Cancel'}</Button><Button variant="pill" disabled={busy || isConnecting || !entry} onClick={() => void connect()}>{busy && <LoaderCircle className="animate-spin" />}{entry?.status === 'connected' ? 'Use connection' : 'Sign in with ' + provider}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
