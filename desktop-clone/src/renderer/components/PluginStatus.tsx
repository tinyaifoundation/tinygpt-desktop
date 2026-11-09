import { Check, LoaderCircle, Plus } from '../icons';
import type { PluginView } from '../../shared/plugins';

export function PluginStatus({ entry }: { entry?: PluginView }) {
  const external = !!(entry?.manifest.connector || entry?.manifest.server);
  const connected = external && entry?.config.enabled && entry.status === 'connected';
  const label = !entry ? 'Available' : !entry.config.enabled || entry.status === 'disabled' ? 'Disabled' : entry.status === 'connecting' ? 'Connecting' : entry.status === 'error' ? 'Needs attention' : connected ? 'Connected' : external ? 'Disconnected' : 'Enabled';
  return <span className={`plugin-connection-status${connected ? ' is-connected' : entry?.status === 'error' ? ' is-error' : ''}`} data-state={connected ? 'connected' : label.toLowerCase().replaceAll(' ', '-')}>
    {connected ? <Check aria-hidden="true" /> : !entry ? <Plus aria-hidden="true" /> : entry.status === 'connecting' && entry.config.enabled ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}{label}
  </span>;
}
