import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { BotPluginAccess } from '../../shared/bot';
import { Switch } from './AppearanceSettings';
import { ConnectorIcon } from './ConnectorIcon';

export function BotPluginPermissions({ bridge }: { bridge: DesktopBridge }) {
  const [access,setAccess] = useState<BotPluginAccess>();
  const [pending,setPending] = useState<string>();
  const [error,setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => { void bridge.botPluginAccess().then(result => { if (alive) { if (result.ok) setAccess(result.value); else setError(result.error); } }, () => { if (alive) setError('Plugin access could not be loaded.'); }); };
    refresh(); const off = bridge.onPluginsUpdate(refresh);
    return () => { alive = false; off(); };
  },[bridge]);
  async function toggle(id: string, allowed: boolean) {
    setPending(id); setError('');
    try { const result = await bridge.setBotPluginAccess(id,allowed); if (!result.ok) throw Error(result.error); setAccess(result.value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Plugin access could not be changed.'); }
    finally { setPending(undefined); }
  }
  return <section className="bot-plugin-permissions" aria-label="Bot plugin access">
    <h2>Plugins</h2>
    <p className="bot-settings-hint">Revoking access takes effect immediately. New plugins are available on your next message.</p>
    {!access ? <div className="bot-permissions-loading" role="status"><span className="sr-only">Loading plugin access</span>{[0,1,2].map(index => <i key={index} className="animate-pulse" />)}</div> : !access.plugins.length ? <p className="bot-settings-hint">Connect a plugin in the Plugins library to give your bot access.</p> : access.plugins.map(plugin => <div className="bot-plugin-access-row" key={plugin.id}>
      <ConnectorIcon kind={plugin.connector} /><div><strong>{plugin.name}</strong><small>{!plugin.connected ? 'Connect in Plugins' : plugin.account ?? (plugin.allowed ? 'Allowed' : 'Ask first')}</small></div>
      <Switch label={`${plugin.name} access`} value={plugin.allowed} disabled={!!pending || !plugin.connected || access.readBlocked && !plugin.allowed} change={allowed => void toggle(plugin.id,allowed)} />
    </div>)}
    {access?.readBlocked && <p className="bot-settings-hint">Enable reading in General settings to grant plugin access.</p>}
    {error && <p className="bot-setup-error" role="alert">{error}</p>}
  </section>;
}
