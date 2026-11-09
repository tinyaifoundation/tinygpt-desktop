import { useState, type ReactNode } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { WorkspaceEntry } from '../../shared/workspace';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';

export type WorkspaceEntryAction = 'add-source' | 'reveal-entry' | 'copy-path' | 'copy-relative-path' | 'cut' | 'copy' | 'paste' | 'rename' | 'delete';
export function WorkspaceFileMenu({ entry, conversationId, bridge, action, create, children }: {
  entry: WorkspaceEntry; conversationId: string; bridge: DesktopBridge;
  action: (action: WorkspaceEntryAction, entry: WorkspaceEntry) => void;
  create?: (kind: 'file' | 'folder', parent: string) => void; children: ReactNode;
}) {
  const [canPaste, setCanPaste] = useState(false);
  const parent = entry.kind === 'directory' ? entry.path : entry.path.replaceAll('\\', '/').split('/').slice(0, -1).join('/') || '.';
  const root = entry.path === '.';
  const item = (label: string, name: WorkspaceEntryAction, disabled = false) => <ContextMenuItem disabled={disabled} onSelect={() => action(name, entry)}>{label}</ContextMenuItem>;
  return <ContextMenu modal={false} onOpenChange={open => {
    if (open) { setCanPaste(false); void bridge.workspaceFiles({ action: 'clipboard-state', conversationId }).then(result => { if (result.ok) setCanPaste(!!result.value.canPaste); }).catch(() => {}); }
  }}><ContextMenuTrigger asChild onKeyDown={event => {
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + 24, clientY: rect.top + rect.height / 2 }));
    }
  }}>{children}</ContextMenuTrigger><ContextMenuContent>
    {item('Add to Chat', 'add-source', entry.kind !== 'file')}
    <ContextMenuSeparator />
    {item('Reveal in File Explorer', 'reveal-entry')}
    <ContextMenuSeparator />
    <ContextMenuItem disabled={!create} onSelect={() => create?.('file', parent)}>New File</ContextMenuItem>
    <ContextMenuItem disabled={!create} onSelect={() => create?.('folder', parent)}>New Folder</ContextMenuItem>
    <ContextMenuSeparator />
    {item('Copy Path', 'copy-path')}{item('Copy Relative Path', 'copy-relative-path')}
    <ContextMenuSeparator />
    {item('Cut', 'cut', root)}{item('Copy', 'copy', root)}
    {canPaste && item('Paste', 'paste')}
    <ContextMenuSeparator />
    {item('Rename', 'rename', root)}{item('Delete', 'delete', root)}
  </ContextMenuContent></ContextMenu>;
}
