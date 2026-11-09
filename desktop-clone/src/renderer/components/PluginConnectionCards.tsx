import { useState } from 'react';
import { Check } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { ChatUpdate } from '../../shared/chat';
import type { ToolActivity } from '../../shared/tools';
import { connectionRequestSchema, pluginUseRequestSchema, type PluginUse, type SuggestedConnector } from '../../shared/plugins';
import { connectorCatalog } from '../../shared/connector-catalog';
import { ConnectorIcon } from './ConnectorIcon';
import { ConnectorConnectDialog } from './ConnectorConnectDialog';
import { Button } from './ui/button';
import {ApprovalCard} from './ApprovalCard';
export function pluginConnectionRequests(tools: ToolActivity[]) {
  return tools.filter(tool => tool.name === 'request_plugin_connection' && tool.status === 'success').flatMap(tool => { try { const result = connectionRequestSchema.safeParse(JSON.parse(tool.result ?? 'null')); return result.success ? [{ ...result.data, id: tool.id, conversationId: tool.conversationId }] : []; } catch { return []; } });
}
export function pluginUseRequests(tools: ToolActivity[]) {
  return tools.filter(tool => tool.name === 'load_tools').flatMap(tool => { try { const parsed = pluginUseRequestSchema.safeParse(JSON.parse(tool.result ?? 'null')); return parsed.success ? [{ ...parsed.data, status: parsed.data.status === 'pending' && !['pending', 'running'].includes(tool.status) ? 'cancelled' as const : parsed.data.status, id: tool.id, conversationId: tool.conversationId }] : []; } catch { return []; } });
}
export function PluginUseCard({ plugin, status, busy, allow, deny }: { plugin: PluginUse; status: 'pending' | 'approved' | 'denied' | 'cancelled'; busy?: boolean; allow: () => void; deny: () => void }) {
  if(status==='pending')return <ApprovalCard data-slot="permission-grant" data-plugin-use="true" data-plugin-id={plugin.pluginId} aria-label={`Use ${plugin.name}`} descriptionId={`plugin-use-${plugin.pluginId}`} heading="Ask permission" icon={<ConnectorIcon kind={plugin.connector}/>} title={`Use ${plugin.name} in this chat?`} description={<p className="permission-grant-action">You only need to allow this once per chat. Actions still follow your approval settings.</p>} actions={<><Button size="sm" variant="outline" disabled={busy} onClick={deny}>Not now</Button><Button size="sm" aria-label={`Allow ${plugin.name} in this chat`} disabled={busy} onClick={allow}>Allow for this chat</Button></>}/>;
  return <div className="plugin-connection-card" data-slot="plugin-use-card" data-plugin-id={plugin.pluginId} data-status={status} aria-label={`Use ${plugin.name}`}><span className="connector-catalog-logo"><ConnectorIcon kind={plugin.connector} /></span><div className="plugin-connection-card-label"><strong>{plugin.name}</strong><small>{status === 'approved' ? 'Allowed in this chat' : status === 'denied' ? 'Not allowed' : status === 'cancelled' ? 'Request cancelled' : 'Read access for this chat'}</small></div>{status === 'approved' && <Check aria-label="Allowed in this chat" />}</div>;
}
export function PluginConnectionCards({ tools, bridge, update, disabled, usageDisabled = false }: { tools: ToolActivity[]; bridge: DesktopBridge; update: (value: ChatUpdate) => void; disabled: boolean; usageDisabled?: boolean }) {
  const [connecting, setConnecting] = useState<{ kind: SuggestedConnector; id: string } | null>(null); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const usage = pluginUseRequests(tools).filter(request=>request.status!=='pending');
  async function decide(request: typeof usage[number], allow: boolean) {
    setBusy(true); setError('');
    try { const result = await bridge.approveTool(request.id, allow ? 'allow-conversation' : 'deny'); if (!result.ok) throw new Error(result.error); const chat = await bridge.conversation(request.conversationId); if (!chat.ok) throw new Error(chat.error); update({ conversation: chat.value, library: result.value }); }
    catch (error) { setError(error instanceof Error ? error.message : 'The permission could not be updated.'); }
    finally { setBusy(false); }
  }
  const requests = pluginConnectionRequests(tools);
  if (!requests.length && !usage.length) return null;
  return <div className="plugin-connection-cards">{usage.map(request => <PluginUseCard key={request.id} plugin={request} status={request.status} busy={busy || usageDisabled} allow={() => { void decide(request, true); }} deny={() => { void decide(request, false); }} />)}{requests.map(request => { const info = connectorCatalog.find(item => item.id === request.connector)!; return <div className="plugin-connection-card" key={request.id}><span className="connector-catalog-logo"><ConnectorIcon kind={request.connector} /></span><div className="plugin-connection-card-label"><strong>{info.name}</strong><small>{request.status === 'connected' ? 'Connected' : request.status === 'dismissed' ? 'Connection declined' : info.description}</small></div>{request.status === 'connected' && <Check aria-label="Connected" />}{request.status === 'pending' && <div className="plugin-connection-card-actions"><Button size="sm" variant="outline" disabled={disabled} onClick={() => { void bridge.dismissPluginConnection(request.conversationId, request.id).then(result => { if (result.ok) update(result.value); else setError(result.error); }); }}>Not now</Button><Button size="sm" aria-label={`Connect ${info.name}`} disabled={disabled} onClick={() => { setError(''); setConnecting({ kind: request.connector, id: request.id }); }}>Connect</Button></div>}</div>; })}{error && <p role="alert" className="text-destructive text-sm">{error}</p>}{connecting && <ConnectorConnectDialog kind={connecting.kind} bridge={bridge} close={() => setConnecting(null)} connected={async pluginId => { const request = requests.find(item => item.id === connecting.id)!; const result = await bridge.resumePluginConnection(request.conversationId, request.id, pluginId); if (!result.ok) throw new Error(result.error); update(result.value); setConnecting(null); }} />}</div>;
}
