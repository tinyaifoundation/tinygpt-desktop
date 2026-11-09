import { ImageModelApproval } from './ImageModelPicker';
import { useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import { Button } from './ui/button';
import { PermissionGrant } from './ConversationElements';
import { ApprovalCard } from './ApprovalCard';
export function ToolApprovals({ library, bridge, update, conversationId }: { library: LibrarySnapshot; bridge: DesktopBridge; update: (value: LibrarySnapshot) => void; conversationId?: string }) {
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function act(operation: () => Promise<void>) { setBusy(true); setError(''); try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : 'The action could not finish.'); } finally { setBusy(false); } }
  return <div className="shrink-0 space-y-2 empty:hidden tool-approvals">
    {library.approvals.filter(approval => approval.conversationId === conversationId).map(approval => approval.imageModels ? <ImageModelApproval key={approval.id} approval={approval} bridge={bridge} update={update} /> : <PermissionGrant key={approval.id} approval={approval} busy={busy} onGrant={decision => void act(async () => { const result = await bridge.approveTool(approval.id, decision); if (!result.ok) throw new Error(result.error); update(result.value); })} />)}
    {library.browserHandoffs.filter(handoff => handoff.conversationId === conversationId).map(handoff => <ApprovalCard key={handoff.tabId} data-slot="browser-handoff" aria-label="Browser handoff" descriptionId={`handoff-${handoff.tabId}`} heading="Action required" title="Continue in the browser" description={<><p className="permission-grant-action">{handoff.reason}</p><p className="permission-grant-action">{handoff.url}</p></>} actions={<>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => { const result = await bridge.revealBrowser(handoff.conversationId, handoff.tabId); if (!result.ok) throw new Error(result.error); })}>Show browser</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => { await bridge.cancelBrowserTasks(handoff.conversationId); if (library.activeRuns.some(run => run.conversationId === handoff.conversationId)) await bridge.cancelMessage(handoff.conversationId); })}>Stop task</Button>
      <Button size="sm" disabled={busy} onClick={() => void act(async () => { const result = await bridge.resumeBrowser(handoff.tabId); if (!result.ok) throw new Error(result.error); })}>Resume task</Button>
    </>} />)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
