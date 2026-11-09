import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FilePlus2, FolderPlus, RotateCw } from '../icons';
import { WorkspaceFileIcon } from './WorkspaceFileIcon';
import { ControlTooltip } from './ui/tooltip';
import type { DesktopBridge } from '../../shared/contracts';
import type { WorkspaceEntry } from '../../shared/workspace';
import { WorkspaceFileMenu, type WorkspaceEntryAction } from './WorkspaceFileMenu';

export function ProjectFileTree({ conversationId, bridge, rootName, selected, open, error, revision, reveal, create, refresh, action }: { conversationId: string; bridge: DesktopBridge; rootName: string; selected?: string; open: (path: string) => void; error: (value: string) => void; revision: string; reveal?: string; create?: (kind: 'file' | 'folder', parent: string) => void; refresh?: () => void; action: (action: WorkspaceEntryAction, entry: WorkspaceEntry) => void }) {
  const [entries, setEntries] = useState<Record<string, WorkspaceEntry[]>>({});
  const [folders, setFolders] = useState(new Set(['.'])); const foldersRef = useRef(folders); foldersRef.current = folders;
  const [loading, setLoading] = useState(new Set<string>()); const [truncated, setTruncated] = useState(new Set<string>());
  const generation = useRef(0); const treeRef = useRef<HTMLDivElement>(null);
  async function read(path: string, current = generation.current) {
    setLoading(previous => new Set(previous).add(path));
    try {
      const result = await bridge.workspaceFiles({ action: 'list', conversationId, path });
      if (current !== generation.current) return;
      if (result.ok) {
        const rows = [...(result.value.entries ?? [])].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }));
        setEntries(previous => ({ ...previous, [path]: rows }));
        setTruncated(previous => { const next = new Set(previous); result.value.truncated ? next.add(path) : next.delete(path); return next; });
      } else if (path !== '.' && /ENOENT|no such file/i.test(result.error)) {
        // Expanded folders can disappear after a move or deletion. Drop their
        // cached branches instead of showing an error for an obsolete path.
        const belongs = (value: string) => value === path || value.startsWith(path + '/');
        setFolders(previous => new Set([...previous].filter(value => !belongs(value))));
        setEntries(previous => Object.fromEntries(Object.entries(previous).filter(([value]) => !belongs(value))));
      } else error(result.error);
    } catch { if (current === generation.current) error('The folder could not be loaded.'); }
    finally { if (current === generation.current) setLoading(previous => { const next = new Set(previous); next.delete(path); return next; }); }
  }
  useEffect(() => {
    const current = ++generation.current; setLoading(new Set());
    for (const path of foldersRef.current) void read(path, current);
    return () => { generation.current++; };
  }, [conversationId, bridge, revision]);
  useEffect(()=>{
    const target=(reveal||selected||'').replaceAll('\\','/');if(!target||/^(?:[A-Za-z]:|\/)/.test(target))return;
    const parts=target.split('/');const parents=Array.from({length:reveal?parts.length:parts.length-1},(_,index)=>parts.slice(0,index+1).join('/'));
    setFolders(previous=>new Set([...previous,...parents]));for(const path of parents)if(!entries[path])void read(path);
  },[selected,reveal]);
  function toggle(path: string) {
    if (!folders.has(path) && !entries[path]) void read(path);
    setFolders(previous => { const next = new Set(previous); next.has(path) ? next.delete(path) : next.add(path); return next; });
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, entry: WorkspaceEntry) {
    const rows = [...(treeRef.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [])]; const index = rows.indexOf(event.currentTarget);
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowRight' && entry.kind === 'directory' && !folders.has(entry.path)) { toggle(entry.path); return; }
    if (event.key === 'ArrowLeft' && entry.kind === 'directory' && folders.has(entry.path)) { toggle(entry.path); return; }
    if (event.key === 'ArrowLeft') {
      const depth = Number(event.currentTarget.getAttribute('aria-level'));
      rows.slice(0, index).reverse().find(row => Number(row.getAttribute('aria-level')) < depth)?.focus(); return;
    }
    rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'ArrowUp' ? Math.max(0, index - 1) : Math.min(rows.length - 1, index + 1)]?.focus();
  }
  function tree(path: string, depth = 0): ReactNode {
    return <div role="group">{(entries[path] ?? []).map(entry => {
      return <div key={entry.path}><WorkspaceFileMenu entry={entry} conversationId={conversationId} bridge={bridge} action={action} create={create}><div className="workspace-tree-item"><button role="treeitem" aria-level={depth + 1} aria-selected={selected?.replaceAll('\\', '/') === entry.path.replaceAll('\\', '/')} className="workspace-tree-row" style={{ paddingLeft: 12 + depth * 14 }} aria-expanded={entry.kind === 'directory' ? folders.has(entry.path) : undefined} onKeyDown={event => keyboard(event, entry)} onClick={() => entry.kind === 'directory' ? toggle(entry.path) : open(entry.path)}>
        {entry.kind === 'directory' ? folders.has(entry.path) ? <ChevronDown /> : <ChevronRight /> : <><span className="workspace-tree-spacer" /><WorkspaceFileIcon name={entry.name} /></>}<span>{entry.name}</span>
      </button>{entry.kind === 'directory' && actions(entry.path)}</div></WorkspaceFileMenu>{entry.kind === 'directory' && folders.has(entry.path) && tree(entry.path, depth + 1)}</div>;
    })}{loading.has(path) && <p className="workspace-note" role="status">Loading…</p>}{!loading.has(path) && entries[path]?.length === 0 && <p className="workspace-note">Empty folder</p>}{truncated.has(path) && <p className="workspace-note">First 200 items shown. Open a subfolder to continue.</p>}</div>;
  }
  function actions(parent: string) { return <div className="workspace-tree-actions">{create && <><ControlTooltip label="New file"><button className="workspace-icon" aria-label={`New file in ${parent === '.' ? rootName : parent}`} onClick={() => create('file', parent)}><FilePlus2 /></button></ControlTooltip><ControlTooltip label="New folder"><button className="workspace-icon" aria-label={`New folder in ${parent === '.' ? rootName : parent}`} onClick={() => create('folder', parent)}><FolderPlus /></button></ControlTooltip></>}{parent === '.' && refresh && <ControlTooltip label="Refresh file tree"><button className="workspace-icon" aria-label="Refresh file tree" onClick={refresh}><RotateCw /></button></ControlTooltip>}</div>; }
  return <div className="workspace-tree" ref={treeRef}><WorkspaceFileMenu entry={{name:rootName,path:".",kind:"directory",size:null}} conversationId={conversationId} bridge={bridge} action={action} create={create}><div className="workspace-tree-title"><span>{rootName}</span>{actions('.')}</div></WorkspaceFileMenu><div role="tree" aria-label="Project files">{tree('.')}</div></div>;
}
