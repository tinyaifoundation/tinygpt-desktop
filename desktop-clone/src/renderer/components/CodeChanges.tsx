import { useEffect, useState } from 'react';
import { FileDiff, RotateCcw, SquareChevronRight } from '../icons';
import { FileDiffViewer } from './FileViewer';
import { WorkspaceScroll } from './WorkspaceScroll';
import type { CodeChange } from '../../shared/code';
import type { Conversation } from '../../shared/chat';
import type { DesktopBridge } from '../../shared/contracts';
import { Button } from './ui/button';
import { ControlTooltip } from './ui/tooltip';

function ChangeDiff({ change }: { change: CodeChange }) {
  return <div className="workspace-change-diff border-t"><FileDiffViewer name={change.path} before={change.before ?? ''} after={change.after} /></div>;
}

export function CodeChanges({ conversation, bridge, running, openFile }: { conversation: Conversation; bridge: DesktopBridge; running: boolean; openFile: (path: string) => void }) {
  const [changes,setChanges] = useState<CodeChange[]>([]); const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  const revision = conversation.tools.map(tool => `${tool.id}:${tool.status}`).join();
  useEffect(() => { let live = true; void bridge.codeChanges(conversation.id).then(result => { if (live) { if (result.ok) setChanges(result.value); else setError(result.error); } }); return () => { live = false; }; }, [conversation.id,revision,bridge]);
  async function undo(change: CodeChange) { setBusy(true); setError(''); const result = await bridge.undoCodeChange(conversation.id,change.id); if (result.ok) setChanges(result.value); else setError(result.error); setBusy(false); }
  const commands = conversation.tools.filter(tool => tool.name === 'run_command' || tool.name === 'run_project_command' || tool.name === 'code_bash');
  return <WorkspaceScroll viewportClassName="code-changes p-4 text-sm">
    <div className="mb-4"><h2 className="font-medium">Changes and checks</h2><p className="mt-1 text-xs text-muted-foreground">File edits and commands from this conversation, including earlier branches.</p></div>
    {error && <p role="alert" className="mb-3 text-destructive">{error}</p>}
    {!changes.length && !commands.length && <p className="text-muted-foreground">Edits and test results will appear here as your assistant works.</p>}
    {changes.map(change => <details key={change.id} className="mb-3 rounded-xl border" open={changes.length === 1}>
      <summary className="flex cursor-pointer items-center gap-2 p-3"><FileDiff className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-medium">{change.path}</span><span className="text-xs text-muted-foreground">{change.state === 'pending' || change.state === 'undo-pending' ? 'Checking…' : change.state === 'failed' ? 'Not applied' : change.state === 'conflict' ? 'Needs review' : change.reverted ? 'Undone' : change.before === null ? 'Created' : 'Edited'}</span></summary>
      <div className="flex items-center justify-between border-t px-3 py-2"><Button size="sm" variant="ghost" onClick={() => openFile(change.path)}>Open file</Button><ControlTooltip label="Undo only if the file still matches this change"><Button size="sm" variant="ghost" disabled={busy || running || change.state !== 'applied'} onClick={() => void undo(change)}><RotateCcw className="size-4" />Undo</Button></ControlTooltip></div>
      <ChangeDiff change={change} />
    </details>)}
    {commands.length > 0 && <h3 className="mb-2 mt-5 font-medium">Commands and tests</h3>}
    {commands.map(tool => { let result: { exitCode?: number | null; output?: string; timedOut?: boolean; truncated?: boolean } = {}; try { result = JSON.parse(tool.result ?? '{}'); } catch {} return <details key={tool.id} className="mb-3 rounded-xl border"><summary className="flex cursor-pointer items-center gap-2 p-3"><SquareChevronRight className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{tool.displayText || tool.summary}</span><span className="text-xs text-muted-foreground">{result.timedOut ? 'Timed out' : result.exitCode !== undefined ? `Exit ${result.exitCode ?? 'interrupted'}` : tool.status}</span></summary><pre className="max-h-80 overflow-auto border-t p-3 text-xs">{result.output || tool.result || 'Waiting for the command…'}{result.truncated ? '\n[Output limited to 24,000 characters]' : ''}</pre></details>; })}
  </WorkspaceScroll>;
}
