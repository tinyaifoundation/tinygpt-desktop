import { browserAddressLabel } from '../../core/browser-privacy';
import { subscribeChatUpdates } from '../lib/chat-updates';
import { fileSessions, type FileTab, type WorkspaceSelection as Selection } from '../lib/workspace-sessions';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, ChevronDown, ChevronRight, FileText, Files, FolderClosed, FolderOpen, Globe, Maximize2, Minimize2, MoreHorizontal, LockKeyhole, SquareChevronRight, PanelRightClose, Plus, RotateCw, Save, Search, X } from '../icons';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { ChatUpdate, Conversation, LibrarySnapshot } from '../../shared/chat';
import type { BrowserRequest, BrowserState, FilePreview, WorkspaceEntry, WorkspaceFileRequest } from '../../shared/workspace';
import { workspaceAddress } from '../../core/workspace-address';
import { ImageWorkspace } from './ImageWorkspace';
import type { SourceDetail } from '../../shared/tools';
import { Images } from '../icons';
import { FileViewer } from './FileViewer';
import { SourcePanel } from './SourcePanel';
import { ProjectFileTree } from './ProjectFileTree';
import type { WorkspaceEntryAction } from './WorkspaceFileMenu';
import { GitChanges } from './GitChanges';
import { WorkspaceFileIcon } from './WorkspaceFileIcon';
import { WorkspaceTabs, type WorkspaceTab } from './WorkspaceTabs';
import { TerminalView } from './TerminalView';
import { QuickOpen } from './QuickOpen';
import { ScrollArea } from './ui/scroll-area';
import { BrowserPageScrollbar } from './BrowserPageScrollbar';

import type { TerminalState, TerminalRequest } from '../../shared/terminal';
import { ControlTooltip } from './ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Dialog } from './ui/dialog';
import { Button } from './ui/button';
import type { CreatedFile } from '../../core/created-files';

function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) { return <ControlTooltip label={label}><button type="button" className="workspace-icon" aria-label={label} {...props}>{children}</button></ControlTooltip>; }
function TabIcon({ url }: { url: string }) { const [failed, setFailed] = useState(false); useEffect(() => setFailed(false), [url]); return url && !failed ? <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Globe />; }

export function Workspace({ conversation, library, bridge, snapshot, update, open, route, sourceId, initialUrl, requestedFile, close, expanded, setExpanded }: { conversation: Conversation; library: LibrarySnapshot; bridge: DesktopBridge; snapshot: AppSnapshot; update: (value: ChatUpdate) => void; open: boolean; route: 'sources' | 'web' | 'files' | null; sourceId: string | null; initialUrl: string | null; requestedFile?: (CreatedFile & { requestId: number; conversationId: string }) | null; close: () => void; expanded: boolean; setExpanded: (value: boolean) => void }) {
  const id = conversation.id; const sessionKey = `${id}:${conversation.projectId ?? ''}`; const restore = fileSessions.peek(sessionKey);
  const [sessionLoaded, setSessionLoaded] = useState(!!restore);
  // Persist tab metadata only; decode and load image bytes only for the selected tab.
  const [imageTabs, setImageTabs] = useState<SourceDetail[]>(restore?.images ?? []);
  const [files, setFiles] = useState<FileTab[]>(restore?.files ?? []);
  const [selected, setSelected] = useState<Selection>(restore?.selected ?? { kind: 'home' });
  const sourceRequest = useRef(0);
  const select = useCallback((value: Selection) => { sourceRequest.current++; setSelected(value); }, []);
  useEffect(() => {
    if (!open || selected.kind !== 'image') return;
    const tab = imageTabs.find(item => item.id === selected.id);
    if (!tab || tab.image) return;
    let live = true;
    void bridge.source(id, tab.id).then(result => {
      if (!live) return;
      if (!result.ok) { setError(result.error); return; }
      setImageTabs(previous => previous.map(item => item.id === tab.id ? result.value : item));
    }, () => { if (live) setError('The image could not be loaded.'); });
    return () => { live = false; };
  }, [open, bridge, id, selected.kind, selected.kind === 'image' ? selected.id : null]);
  const activeImage=selected.kind==='image'?imageTabs.find(item=>item.id===selected.id):undefined;
  async function openImage(source:SourceDetail){setImageTabs(previous=>previous.some(item=>item.id===source.id)?previous.map(item=>item.id===source.id?source:item):[...previous,source]);select({kind:'image',id:source.id});}
  const [state, setState] = useState<BrowserState>({ conversationId: id, tabs: [], activeId: null }); const [ready, setReady] = useState(false); const [showSources, setShowSources] = useState(restore?.selected.kind === 'sources'); const [showFiles, setShowFiles] = useState(files.length > 0 || restore?.selected.kind === 'files');
  const [width, setWidth] = useState(() => { const value = Number(localStorage.getItem('tinygpt.workspace.width')); return value >= 280 && value <= 900 ? value : 440; });
  const [resizing,setResizing] = useState(false);
  const [error, setError] = useState(''); const [draft, setDraft] = useState(''); const [addressFocused, setAddressFocused] = useState(false); const [find, setFind] = useState<string | null>(null); const [blocked, setBlocked] = useState(false); const [preview, setPreview] = useState<{ id: string; src: string } | null>(null); const [pendingClose, setPendingClose] = useState<FileTab | null>(null); const [reloadPending, setReloadPending] = useState(false); const [treeRevision, setTreeRevision] = useState(0); const [busy, setBusy] = useState(false); const [treeOpen, setTreeOpen] = useState(true);
  useEffect(() => { if (sessionLoaded) return; let live = true; void fileSessions.get(sessionKey).then(saved => { if (!live) return; if (saved) { lastRoute.current = saved.route ?? ''; setFiles(saved.files); setImageTabs(saved.images ?? []); setSelected(saved.selected); setShowFiles(saved.files.length > 0 || saved.selected.kind === 'files'); setShowSources(saved.selected.kind === 'sources'); } setSessionLoaded(true); }).catch(cause => { if (live) { setError(cause.message); setSessionLoaded(true); } }); return () => { live = false; }; }, [sessionKey]);
  const viewport = useRef<HTMLDivElement>(null); const pane = useRef<HTMLElement>(null); const address = useRef<HTMLInputElement>(null); const drag = useRef<{ x: number; width: number } | null>(null); const commandRef = useRef<BrowserState>(state); commandRef.current = state;
  const project = library.projects.find(item => item.id === conversation.projectId); const active = selected.kind === 'browser' ? state.tabs.find(tab => tab.id === selected.id) : null; const fileTab = selected.kind === 'file' ? files.find(tab => tab.file.id === selected.id) : null;
  const [terminalState,setTerminalState]=useState<TerminalState>({conversationId:id,terminals:[]});
  const [explorerWidth,setExplorerWidth]=useState(()=>Math.max(120,Math.min(320,Number(localStorage.getItem('tinygpt.explorer.width'))||190)));
  const [quickOpen,setQuickOpen]=useState(false);
  const [fileSearch,setFileSearch]=useState({fileId:'',request:0});
  const [creation,setCreation]=useState<{kind:'file'|'folder';parent:string}|null>(null); const [newName,setNewName]=useState('');
  function create(kind:'file'|'folder',parent:string){setError('');setNewName('');setCreation({kind,parent});}
  async function createEntry(){if(!creation||!newName.trim())return;setBusy(true);setError('');try{const path=(creation.parent==='.'?'':creation.parent+'/')+newName.trim();const result=await bridge.workspaceFiles({action:creation.kind==='file'?'create-file':'create-folder',conversationId:id,path});if(!result.ok)throw new Error(result.error);setCreation(null);setTreeRevision(value=>value+1);setRevealFolder(creation.kind==='folder'?path:creation.parent);if(result.value.file)await fileAction({action:'read',conversationId:id,path});}catch(cause){setError(cause instanceof Error?cause.message:'Could not create this item.');}finally{setBusy(false);}}
  function searchFile(){if(fileTab?.file.kind==='text'){setFiles(previous=>previous.map(item=>item.file.id===fileTab.file.id?{...item,raw:true}:item));setFileSearch(value=>({fileId:fileTab.file.id,request:value.request+1}));}else setQuickOpen(true);}
  const [entryDialog, setEntryDialog] = useState<{ action: 'rename' | 'delete'; entry: WorkspaceEntry } | null>(null);
  const [entryName, setEntryName] = useState('');
  const affects = (path: string, target: string) => path === target || path.startsWith(target + '/');
  async function entryAction(action: WorkspaceEntryAction, entry: WorkspaceEntry, confirmed = false) {
    if ((action === 'rename' || action === 'delete') && !confirmed) {
      setError(''); setEntryName(entry.name); setEntryDialog({ action, entry }); return;
    }
    setBusy(true); setError('');
    try {
      if (action === 'add-source') {
        const opened = files.find(tab => tab.file.path === entry.path);
        if (opened && opened.draft !== (opened.file.text ?? '')) throw new Error('Save this file before adding it to chat.');
        const read = await bridge.workspaceFiles({ action: 'read', conversationId: id, path: entry.path });
        if (!read.ok) throw new Error(read.error);
        const added = await bridge.workspaceFiles({ action: 'add-source', conversationId: id, id: read.value.file!.id });
        if (!added.ok) throw new Error(added.error);
        return;
      }
      const parent = entry.kind === 'directory' ? entry.path : entry.path.split('/').slice(0, -1).join('/') || '.';
      const result = await bridge.workspaceFiles(action === 'rename'
        ? { action, conversationId: id, path: entry.path, name: entryName.trim() }
        : { action, conversationId: id, path: action === 'paste' ? parent : entry.path });
      if (!result.ok) throw new Error(result.error);
      if (result.value.moved) {
        const { from, to } = result.value.moved;
        setFiles(previous => previous.map(tab => {
          if (!affects(tab.file.path, from)) return tab;
          const path = to + tab.file.path.slice(from.length);
          return { ...tab, file: { ...tab.file, path, name: path.split('/').at(-1)! } };
        }));
        setRevealFolder(to.split('/').slice(0, -1).join('/'));
      }
      if (result.value.removedPath) {
        const removed = result.value.removedPath;
        setFiles(previous => previous.filter(tab => !affects(tab.file.path, removed)));
        if (fileTab && affects(fileTab.file.path, removed)) select({ kind: 'files' });
      }
      if (result.value.createdPath) setRevealFolder(parent);
      if (['rename', 'delete', 'paste'].includes(action)) { setTreeRevision(value => value + 1); setEntryDialog(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The file action could not be completed.'); }
    finally { setBusy(false); }
  }
  const [revealFolder,setRevealFolder]=useState(''); const explorerDrag=useRef<{x:number;width:number}|null>(null);
  useEffect(()=>{localStorage.setItem('tinygpt.explorer.width',String(explorerWidth));},[explorerWidth]);
  useEffect(()=>{let live=true;const accept=(state:TerminalState)=>{if(live&&state.conversationId===id)setTerminalState(state);};const unsubscribe=bridge.onWorkspaceTerminalState(accept);void bridge.workspaceTerminal({action:'state',conversationId:id}).then(result=>{if(result.ok)accept(result.value);});return()=>{live=false;unsubscribe();};},[id,bridge]);
  async function terminalAction(input:TerminalRequest){const result=await bridge.workspaceTerminal(input);if(!result.ok){setError(result.error);return;}setTerminalState(result.value);if(input.action==='create'){const last=result.value.terminals.at(-1);if(last)select({kind:'terminal',id:last.id});}if(input.action==='close'&&selected.kind==='terminal'&&selected.id===input.id)select({kind:'home'});}
  const terminal=selected.kind==='terminal'?terminalState.terminals.find(item=>item.id===selected.id):null;
  const fileRevision = conversation.tools.filter(tool => ['success', 'error'].includes(tool.status) && /write|edit|patch|bash|command/.test(tool.name)).map(tool => tool.id + tool.status).join();
  useEffect(() => subscribeChatUpdates(bridge, value => { if (value.conversation.id === id && !value.library.activeRuns.some(run => run.conversationId === id)) setTreeRevision(previous => previous + 1); }), [id, bridge]);
  useEffect(() => {
    let live = true;
    if (!open || !fileTab || fileTab.draft !== (fileTab.file.text ?? '')) return;
    void bridge.workspaceFiles({ action: 'refresh', conversationId: id, id: fileTab.file.id }).then(async result => {
      if (!live) return;
      if (!result.ok && fileTab.file.kind === 'text' && fileTab.file.text === undefined) result = await bridge.workspaceFiles({ action: 'read', conversationId: id, path: fileTab.file.path });
      if (!live) return;
      if (!result.ok || !result.value.file) { if (fileTab.file.text === undefined) setError('Reopen this file to continue.'); return; }
      const file = result.value.file;
      setFiles(previous => previous.map(tab => tab.file.id === file.id && tab.draft === (tab.file.text ?? '') ? { ...tab, file, draft: file.text ?? '' } : tab));
    }).catch(() => { /* Explicit Reload remains available when a file disappears. */ });
    return () => { live = false; };
  }, [open, id, bridge, fileTab?.file.id, fileRevision, treeRevision]);
  useEffect(() => { if (open) pane.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selected, open]);
  const acceptState = useCallback((value: BrowserState) => { if (value.conversationId !== id) return; setState(value); setReady(true); if (value.activeId && value.activeId !== commandRef.current.activeId) select({ kind: 'browser', id: value.activeId }); }, [id]);
  useEffect(() => { const unsubscribe = bridge.onWorkspaceBrowserState(acceptState); void bridge.workspaceBrowser({ action: 'state', conversationId: id }).then(result => { if (result.ok) acceptState(result.value); else setError(result.error); }); return unsubscribe; }, [id, bridge, acceptState]);
  useEffect(() => bridge.onWorkspaceBrowserFocus(value => { if (value.conversationId === id) select({ kind: 'browser', id: value.tabId }); }), [id, bridge]);
  useEffect(() => { if (!sessionLoaded) return; const savedFiles = files.filter(tab => tab.file.kind === 'text').map(tab => tab.draft === (tab.file.text ?? '') ? { ...tab, file: { ...tab.file, text: undefined, bytesBase64: undefined }, draft: '' } : tab); const savedSelection = selected.kind === 'file' && !savedFiles.some(tab => tab.file.id === selected.id) ? { kind: 'files' as const } : selected; void fileSessions.set(sessionKey, { files: savedFiles, selected: savedSelection, images:imageTabs.map(item=>({...item,text:'',image:null})), route:lastRoute.current }).catch(cause => setError(cause.message)); }, [sessionKey, files, selected, imageTabs, sessionLoaded]);
  useEffect(() => { localStorage.setItem('tinygpt.workspace.width', String(width)); }, [width]);
  useEffect(() => { setDraft(active?.url ?? ''); }, [active?.id, active?.url]);
  useEffect(() => { if (ready && selected.kind === 'browser' && !active) select({ kind: 'home' }); }, [state.tabs, selected, ready]);
  const browser = useCallback(async (request: BrowserRequest) => { const result = await bridge.workspaceBrowser(request); if (!result.ok) { setError(result.error); return null; } acceptState(result.value); return result.value; }, [bridge, acceptState]);
  async function newBrowser(url?: string) { setError(''); const existing = url ? state.tabs.find(tab => tab.url === url) : undefined; const value = await browser(existing ? { action: 'activate', conversationId: id, tabId: existing.id } : { action: 'new', conversationId: id, ...(url ? { url } : {}) }); if (value?.activeId) select({ kind: 'browser', id: value.activeId }); if (!url) requestAnimationFrame(() => address.current?.focus()); }
  async function openLink(url: string) { try { const destination = await bridge.openBrowserLink(url); if (!destination.ok) setError(destination.error); else if (destination.value === 'workspace') await newBrowser(url); } catch { setError('The link could not be opened.'); } }
  const lastRoute = useRef(restore?.route??'');
  useEffect(() => {
    if (!open || !ready) return; const key = `${route}:${sourceId}:${initialUrl}`; if (key === lastRoute.current) return; lastRoute.current = key;
    if (initialUrl) { void newBrowser(initialUrl); return; }
    if (route === 'files') { setShowFiles(true); select({ kind: 'files' }); }
    if (route === 'sources') {
      setShowSources(true);
      if (!sourceId) { select({ kind: 'sources' }); return; }
      const request = ++sourceRequest.current;
      let disposed = false;
      void bridge.source(id, sourceId).then(result => {
        if (disposed || request !== sourceRequest.current) return;
        if (!result.ok) { setError(result.error); return; }
        if (result.value.image) void openImage(result.value);
        else if (result.value.kind === 'page' && result.value.url) void newBrowser(result.value.url);
        else select({ kind: 'sources' });
      }, () => { if (!disposed && request === sourceRequest.current) setError('The source could not be opened.'); });
      return () => { disposed = true; };
    }
  }, [open, ready, route, sourceId, initialUrl]);
  const restoredBrowser = useRef(false);
  useEffect(() => {
    if (!open || !ready || restoredBrowser.current) return; restoredBrowser.current = true;
    if (!state.tabs.length && !initialUrl && !sourceId) { try { const saved: unknown = JSON.parse(localStorage.getItem(`tinygpt.workspace.tabs.${sessionKey}`) ?? '[]'); if (Array.isArray(saved)) void (async () => { for (const url of saved.slice(0, 12)) if (typeof url === 'string' && /^https?:\/\//.test(url) && workspaceAddress(url, snapshot.settings.browser.engine)) await newBrowser(url); })(); } catch { /* Corrupt optional session data starts at Home. */ } }
  }, [open, ready]);
  useEffect(() => { if (ready && (state.tabs.length || restoredBrowser.current)) localStorage.setItem(`tinygpt.workspace.tabs.${sessionKey}`, JSON.stringify(state.tabs.filter(tab => tab.url).map(tab => tab.url))); }, [state.tabs, ready, sessionKey]);
  useEffect(() => {
    const observe = () => setBlocked([...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"], [role="dialog"]:not([data-state="closed"]), [role="listbox"][data-state="open"], [data-slot="hover-card-content"][data-state="open"]')].some(element => element.getClientRects().length > 0 && !element.hidden && element.getAttribute('aria-hidden') !== 'true' && getComputedStyle(element).visibility !== 'hidden'));
    const observer = new MutationObserver(observe); observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state','hidden','aria-hidden','style','class'] }); observe(); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    let disposed = false; const updateLayout = () => {
      if (disposed) return;
      const element = viewport.current; const rect = element?.getBoundingClientRect(); const body = element?.closest('.workspace-browser-body');
      const visible = open && active?.url && !active.error && !blocked && !resizing && rect;
      void bridge.workspaceBrowserLayout({ conversationId: id, tabId: visible ? active.id : null, bounds: visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        ...(body && rect ? { cornerRadius: parseFloat(getComputedStyle(body).borderBottomLeftRadius) || 0, rightInset: Math.max(0, body.getBoundingClientRect().right - rect.right) } : {}) });
    };
    if ((blocked || resizing) && active?.url) void bridge.workspaceBrowserCapture(id, active.id).then(result => { if (!disposed && result.ok) setPreview({ id: active.id, src: result.value }); }); else setPreview(null);
    updateLayout(); const observer = new ResizeObserver(updateLayout); if (pane.current) observer.observe(pane.current); if (viewport.current) observer.observe(viewport.current); window.addEventListener('resize', updateLayout);
    return () => { disposed = true; observer.disconnect(); window.removeEventListener('resize', updateLayout); };
  }, [open, active?.id, active?.url, active?.error, blocked, resizing, expanded, width, find !== null]);
  useLayoutEffect(() => () => { void bridge.workspaceBrowserLayout({ conversationId:id,tabId:null,bounds:null }); },[bridge,id]);
  async function fileAction(request: WorkspaceFileRequest) { setError(''); setBusy(true); try { if (!sessionLoaded) await fileSessions.get(sessionKey); const result = await bridge.workspaceFiles(request); if (!result.ok) throw new Error(result.error); const values = result.value.files ?? (result.value.file ? [result.value.file] : []); if (files.length + values.filter(file => !files.some(tab => tab.file.id === file.id || tab.file.path === file.path)).length > 32) throw Error('Close a file tab before opening more files (32 maximum).'); for (const file of values) { setFiles(previous => { const index = previous.findIndex(item => item.file.id === file.id || item.file.path === file.path); const tab = { file, draft: file.text ?? '', raw: !/\.(md|mdx)$/i.test(file.name) }; return index < 0 ? [...previous, tab] : previous.map((item, position) => { if (position !== index) return item; if (['choose', 'read'].includes(request.action) && item.draft !== (item.file.text ?? '')) return { ...item, file: { ...file, text: item.file.text, sha256: item.file.sha256 } }; return { ...tab, raw: item.raw }; }); }); select({ kind: 'file', id: file.id }); } if (values.length) setShowFiles(true); } catch (cause) { setError(cause instanceof Error ? cause.message : 'The file could not be opened.'); } finally { setBusy(false); } }
  const openedRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !ready || route !== 'files' || !requestedFile || requestedFile.conversationId !== id || requestedFile.requestId === openedRequest.current) return;
    openedRequest.current = requestedFile.requestId;
    void fileAction({ action: 'read', conversationId: id, path: requestedFile.path, generated: requestedFile.generated, ...(requestedFile.projectId ? { projectId: requestedFile.projectId } : {}) });
  }, [open, ready, route, requestedFile, id]);
  function removeFile(tab: FileTab) { setFiles(previous => previous.filter(item => item.file.id !== tab.file.id)); if (selected.kind === 'file' && selected.id === tab.file.id) select({ kind: 'files' }); }
  function closeFile(tab: FileTab) { if (tab.draft !== (tab.file.text ?? '')) { setReloadPending(false); setPendingClose(tab); } else removeFile(tab); }
  async function saveFile() { if (fileTab?.file.kind === 'text' && fileTab.file.text === undefined) return; if (fileTab) await fileAction({ action: 'save', conversationId: id, id: fileTab.file.id, text: fileTab.draft, sha256: fileTab.file.sha256 }); }
  useEffect(() => { function keyboard(event: KeyboardEvent) { if (!open || !(event.ctrlKey || event.metaKey)) return; if(pane.current?.contains(document.activeElement)){ if(event.key.toLowerCase()==='p'){event.preventDefault();event.stopPropagation();setQuickOpen(true);return;} if(event.key==='`'&&project?.rootPath){event.preventDefault();event.stopPropagation();void terminalAction({action:'create',conversationId:id});return;} if(event.key.toLowerCase()==='w'&&fileTab){event.preventDefault();event.stopPropagation();closeFile(fileTab);return;} } if (event.key.toLowerCase() === 's' && fileTab?.file.writable) { event.preventDefault(); event.stopPropagation(); void saveFile(); } if (event.key.toLowerCase() === 'l' && active) { event.preventDefault(); address.current?.focus(); address.current?.select(); } if (event.key.toLowerCase() === 'f' && active && (pane.current?.contains(document.activeElement) || document.activeElement === document.body)) { event.preventDefault(); event.stopPropagation(); setFind(''); } } document.addEventListener('keydown', keyboard, true); return () => document.removeEventListener('keydown', keyboard, true); }, [open, active, fileTab, project?.rootPath]);
  async function bindProject(projectId: string) { setError(''); const key = `${id}:${projectId}`; await fileSessions.set(key, { files: (await fileSessions.get(key))?.files ?? [], selected: { kind: 'files' } }).catch(cause => setError(cause.message)); const result = await bridge.organizeConversation({ id, action: 'move', projectId }); if (!result.ok) { setError(result.error); return; } const chat = await bridge.conversation(id); if (chat.ok) update({ conversation: chat.value, library: result.value }); }
  async function chooseFolder() { if (!project) return; const result = await bridge.chooseProjectFolder(project.id); if (!result.ok) { setError(result.error); return; } const saved = await bridge.library(); if (saved.ok) update({ conversation, library: saved.value }); setTreeRevision(value => value + 1); }
  const filePicker = <DropdownMenu modal={false}><DropdownMenuTrigger asChild><button className="workspace-project-select" aria-label="Select workspace Project"><FolderClosed /><span>{project?.name ?? 'Choose Project'}</span><ChevronDown /></button></DropdownMenuTrigger><DropdownMenuContent align="end">{library.projects.map(item => <DropdownMenuItem key={item.id} onSelect={() => void bindProject(item.id)}><FolderClosed />{item.name}</DropdownMenuItem>)}{!library.projects.length && <DropdownMenuItem disabled>Create a Project in the sidebar</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>;
  const fileTree = treeOpen && <aside className="workspace-file-tree" style={{width:explorerWidth}}><ScrollArea className="workspace-tree-scroll">{!project?.rootPath && <>{filePicker}{project && <button className="workspace-project-select" onClick={() => void chooseFolder()}><FolderOpen /><span>Choose Project folder</span></button>}</>}{<ProjectFileTree key={sessionKey+':'+(project?.rootPath ?? 'generated')} conversationId={id} bridge={bridge} rootName={project?.rootPath ? project.name : 'Generated files'} selected={fileTab?.file.path} open={path => void fileAction({ action: 'read', conversationId: id, path })} error={setError} revision={treeRevision+':'+fileRevision} reveal={revealFolder} create={create} refresh={()=>setTreeRevision(value=>value+1)} action={(action,entry)=>{if(!busy)void entryAction(action,entry);}} />}</ScrollArea><div className="workspace-explorer-resizer" role="separator" aria-label="Resize explorer" aria-orientation="vertical" tabIndex={0} onPointerDown={event=>{explorerDrag.current={x:event.clientX,width:explorerWidth};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(explorerDrag.current)setExplorerWidth(Math.max(120,Math.min(320,explorerDrag.current.width+explorerDrag.current.x-event.clientX)));}} onPointerUp={()=>{explorerDrag.current=null;}} onLostPointerCapture={()=>{explorerDrag.current=null;}} onKeyDown={event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setExplorerWidth(value=>Math.max(120,Math.min(320,value+(event.key==='ArrowLeft'?15:-15))));}}}/></aside>;
  const tab = (key: string, title: string, icon: ReactNode, current: boolean, activate: () => void, remove: () => void, locked = false, agent = false): WorkspaceTab => ({ id: key, title, icon, active: current, activate, close: remove, locked, agent });
  const workspaceTabs = [
    ...(showFiles ? [tab('files', 'Files', <Files />, selected.kind === 'files', () => select({ kind: 'files' }), () => { setShowFiles(false); select({ kind: 'home' }); })] : []),
    ...(conversation.mode === 'code' ? [tab('changes', 'Changes', <Files />, selected.kind === 'changes', () => select({ kind: 'changes' }), () => select({ kind: 'home' }))] : []),
    ...state.tabs.map(item => tab(item.id, item.title, <TabIcon url={item.favicon} />, selected.kind === 'browser' && selected.id === item.id, () => { select({ kind: 'browser', id: item.id }); void browser({ action: 'activate', conversationId: id, tabId: item.id }); }, () => void browser({ action: 'close', conversationId: id, tabId: item.id }), false, !!library.browserTasks?.some(task => task.conversationId === id && task.tabId === item.id))),
    ...files.map(item => tab(item.file.id, `${item.file.name}${item.draft !== (item.file.text ?? '') ? ' •' : ''}`, <WorkspaceFileIcon name={item.file.name} />, selected.kind === 'file' && selected.id === item.file.id, () => select({ kind: 'file', id: item.file.id }), () => closeFile(item))),
    ...imageTabs.map(item=>tab(item.id,item.title,<Images/>,selected.kind==='image'&&selected.id===item.id,()=>select({kind:'image',id:item.id}),()=>{setImageTabs(previous=>previous.filter(source=>source.id!==item.id));if(selected.kind==='image'&&selected.id===item.id)select({kind:'home'});})),
    ...terminalState.terminals.map(item => tab(item.id, item.title, item.locked ? <LockKeyhole /> : <SquareChevronRight />, selected.kind === 'terminal' && selected.id === item.id, () => select({ kind: 'terminal', id: item.id }), () => void terminalAction({ action: 'close', conversationId: id, id: item.id }), item.locked)),
    ...(showSources ? [tab('sources', 'Sources', <BookOpen />, selected.kind === 'sources', () => select({ kind: 'sources' }), () => { setShowSources(false); select({ kind: 'home' }); })] : []),
  ];
  return <aside ref={pane} className={`tiny-workspace ${expanded ? 'is-expanded' : ''}`} hidden={!open} style={{ width: expanded ? undefined : width, flexBasis: expanded ? undefined : width }} aria-label="Workspace">
    {!expanded && <div className="workspace-resizer" role="separator" aria-label="Resize workspace" aria-orientation="vertical" tabIndex={0} onPointerDown={event => { if (event.button !== 0) return; setResizing(true); drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (drag.current) { const mainWidth = pane.current?.parentElement?.clientWidth ?? 1000; setWidth(Math.max(280, Math.min(900, mainWidth - 280, drag.current.width + drag.current.x - event.clientX))); } }} onPointerUp={() => { drag.current = null; setResizing(false); }} onPointerCancel={() => { drag.current = null; setResizing(false); }} onLostPointerCapture={() => { drag.current = null; setResizing(false); }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); setWidth(value => Math.max(280, Math.min(900, (pane.current?.parentElement?.clientWidth ?? 1000) - 280, value + (event.key === 'ArrowLeft' ? 20 : -20)))); } }} />}
    <header className="workspace-topbar"><WorkspaceTabs tabs={workspaceTabs} /><DropdownMenu modal={false}><DropdownMenuTrigger asChild><button className="workspace-icon" aria-label="Add workspace tab"><Plus /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={!project?.rootPath} onSelect={()=>void terminalAction({action:'create',conversationId:id})}><SquareChevronRight/>Terminal</DropdownMenuItem><DropdownMenuItem onSelect={() => void newBrowser()}><Globe />Browser</DropdownMenuItem><DropdownMenuItem onSelect={() => { setShowFiles(true); select({ kind: 'files' }); }}><Files />Files</DropdownMenuItem><DropdownMenuItem onSelect={() => void fileAction({ action: 'choose', conversationId: id })}><FolderOpen />Open files…</DropdownMenuItem><DropdownMenuItem onSelect={() => { setShowSources(true); select({ kind: 'sources' }); }}><BookOpen />Sources</DropdownMenuItem></DropdownMenuContent></DropdownMenu><IconButton label={expanded ? 'Restore workspace' : 'Expand workspace'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 /> : <Maximize2 />}</IconButton><IconButton label="Close workspace" onClick={close}><PanelRightClose /></IconButton></header>
    {error && <div className="workspace-error" role="alert">{error}<button aria-label="Dismiss workspace error" onClick={() => setError('')}><X /></button></div>}
    {terminal&&<TerminalView key={terminal.id} terminal={terminal} conversationId={id} bridge={bridge} error={setError}/>}
    {selected.kind === 'changes' && <GitChanges conversationId={id} bridge={bridge} revision={treeRevision+":"+fileRevision} running={library.activeRuns.some(run => library.conversations.find(chat=>chat.id===run.conversationId)?.projectId === conversation.projectId)} openFile={path => void fileAction({ action: 'read', conversationId: id, path })} />}
    {selected.kind === 'home' && <div className="workspace-home"><div><button onClick={() => { setShowFiles(true); select({ kind: 'files' }); }}><Files /><span>Files</span></button><button disabled={!project?.rootPath} onClick={()=>void terminalAction({action:'create',conversationId:id})}><SquareChevronRight/><span>Terminal</span></button><button onClick={() => void newBrowser()}><Globe /><span>Browser</span></button><button onClick={() => { setShowSources(true); select({ kind: 'sources' }); }}><BookOpen /><span>Sources</span></button></div></div>}
    {active && <><form className="workspace-browser-toolbar" onSubmit={event => { event.preventDefault(); const url = workspaceAddress(draft, snapshot.settings.browser.engine); if (!url) { setError('Enter a valid web address or search.'); return; } setError(''); void browser({ action: 'navigate', conversationId: id, tabId: active.id, url }); }}><IconButton label="Browser back" disabled={!active.canGoBack} onClick={() => void browser({ action: 'back', conversationId: id, tabId: active.id })}><ArrowLeft /></IconButton><IconButton label="Browser forward" disabled={!active.canGoForward} onClick={() => void browser({ action: 'forward', conversationId: id, tabId: active.id })}><ArrowRight /></IconButton><IconButton label={active.loading ? 'Stop loading' : 'Reload page'} disabled={!active.url} onClick={() => void browser({ action: active.loading ? 'stop' : 'reload', conversationId: id, tabId: active.id })}>{active.loading ? <X /> : <RotateCw />}</IconButton><div className="workspace-address-wrap"><input ref={address} aria-label="Search or enter a URL" placeholder="Search or enter a URL" maxLength={2048} spellCheck={false} value={addressFocused || draft !== (active?.url ?? "") ? draft : browserAddressLabel(active.url, snapshot.settings.browser.showFullUrl)} onChange={event => setDraft(event.target.value)} onFocus={event => { const input = event.currentTarget; setAddressFocused(true); requestAnimationFrame(() => { if (document.activeElement === input) input.select(); }); }} onBlur={() => setAddressFocused(false)} /><button type="submit" aria-label="Open address"><ArrowUpRight /></button></div><IconButton label="Passwords" disabled={!active.url.startsWith('https://') || active.loading} onClick={() => { setError(''); void bridge.openBrowserPasswords(id,active.id).then(result => { if(!result.ok)setError(result.error); }); }}><LockKeyhole /></IconButton><DropdownMenu modal={false}><DropdownMenuTrigger asChild><button className="workspace-icon" aria-label="Browser menu"><MoreHorizontal /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void newBrowser()}><Plus />New tab</DropdownMenuItem><DropdownMenuItem onSelect={() => void browser({ action: 'duplicate', conversationId: id, tabId: active.id })}>Duplicate tab</DropdownMenuItem><DropdownMenuItem disabled={!active.url || !!active.error} onSelect={() => setFind('')}><Search />Find in page</DropdownMenuItem><DropdownMenuItem disabled={!active.url || !!active.error} onSelect={() => void browser({ action: 'save-source', conversationId: id, tabId: active.id })}><BookOpen />Save as source</DropdownMenuItem><DropdownMenuItem disabled={active.zoom >= 300} onSelect={() => void browser({ action: 'zoom', conversationId: id, tabId: active.id, value: Math.min(300, active.zoom + 10) })}>Zoom in · {active.zoom}%</DropdownMenuItem><DropdownMenuItem disabled={active.zoom <= 50} onSelect={() => void browser({ action: 'zoom', conversationId: id, tabId: active.id, value: Math.max(50, active.zoom - 10) })}>Zoom out</DropdownMenuItem><DropdownMenuItem onSelect={() => void browser({ action: 'zoom', conversationId: id, tabId: active.id, value: 100 })}>Reset zoom</DropdownMenuItem><DropdownMenuItem disabled={!active.url || !!active.error} onSelect={() => void browser({ action: 'print', conversationId: id, tabId: active.id })}>Print…</DropdownMenuItem><DropdownMenuItem disabled={!active.url || !!active.error} onSelect={() => void browser({ action: 'screenshot', conversationId: id, tabId: active.id })}>Save screenshot…</DropdownMenuItem><DropdownMenuItem onSelect={() => void browser({ action: 'downloads', conversationId: id, tabId: active.id })}>Downloads</DropdownMenuItem></DropdownMenuContent></DropdownMenu></form>
      {find !== null && <form className="workspace-find" onSubmit={event => { event.preventDefault(); void browser({ action: 'find', conversationId: id, tabId: active.id, query: find, forward: true }); }}><input aria-label="Find in page" autoFocus value={find} onChange={event => setFind(event.target.value)} /><button type="submit">Find</button><IconButton label="Previous browser match" onClick={() => void browser({ action: 'find', conversationId: id, tabId: active.id, query: find, forward: false })}><ChevronRight className="rotate-180" /></IconButton><IconButton label="Close find in page" onClick={() => { setFind(null); void browser({ action: 'find', conversationId: id, tabId: active.id, query: '', forward: true }); }}><X /></IconButton></form>}
      <div className="workspace-browser-body"><div className="workspace-browser-viewport" ref={viewport}>{active.error ? <p className="workspace-note">{active.error}</p> : !active.url ? <div className="workspace-empty"><Globe /><strong>Start browsing</strong><span>Search or enter a web address above.</span></div> : (blocked || resizing) && preview?.id === active.id ? <img className="workspace-page-preview" src={preview.src} alt="" /> : (blocked || resizing) ? <div className="workspace-empty">{active.title}</div> : null}</div><BrowserPageScrollbar key={active.id} bridge={bridge} conversationId={id} tabId={active.id} enabled={open && !!active.url && !active.error && !blocked && !resizing} /></div></>}
    {(selected.kind === 'files' || fileTab) && <><div className="workspace-file-toolbar"><nav className="workspace-file-name workspace-breadcrumbs" aria-label="File path">{fileTab?fileTab.file.path.replaceAll('\\','/').split('/').filter(Boolean).map((part,index,parts)=><span key={index}><button onClick={()=>{if(index<parts.length-1){setTreeOpen(true);setRevealFolder(parts.slice(0,index+1).join('/'));}}} disabled={index===parts.length-1}>{part}</button>{index<parts.length-1&&<ChevronRight/>}</span>):<span>Files</span>}</nav>{fileTab?.file.kind === 'text' && /\.(md|mdx)$/i.test(fileTab.file.name) && <div className="workspace-preview-switch" aria-label="File view">{['Preview','Source'].map((label,index)=><button key={label} aria-pressed={fileTab.raw===(index===1)} onClick={()=>setFiles(previous=>previous.map(item=>item.file.id===fileTab.file.id?{...item,raw:index===1}:item))}>{label}</button>)}</div>}{fileTab?.file.writable && <IconButton label="Save file" disabled={busy || fileTab.file.text === undefined || fileTab.draft === fileTab.file.text} onClick={() => void saveFile()}><Save /></IconButton>}<IconButton label="Open files" disabled={busy} onClick={() => void fileAction({ action: 'choose', conversationId: id })}><FolderOpen /></IconButton><IconButton label={fileTab?.file.kind==='text'?'Find in file':'Search files'} onClick={searchFile}><Search /></IconButton><IconButton label={treeOpen ? 'Hide file tree' : 'Show file tree'} onClick={() => setTreeOpen(!treeOpen)}><SquareChevronRight /></IconButton><DropdownMenu modal={false}><DropdownMenuTrigger asChild><button className="workspace-icon" aria-label="File menu"><MoreHorizontal /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={()=>setQuickOpen(true)}><Search/>Quick Open…</DropdownMenuItem><DropdownMenuItem onSelect={() => { setTreeRevision(value => value + 1); }}>Refresh file tree</DropdownMenuItem>{fileTab && <><DropdownMenuItem disabled={busy} onSelect={() => { if (fileTab.draft !== (fileTab.file.text ?? '')) { setReloadPending(true); setPendingClose(fileTab); } else void fileAction({ action: 'refresh', conversationId: id, id: fileTab.file.id }); }}>Reload from disk</DropdownMenuItem><DropdownMenuItem onSelect={() => void fileAction({ action: 'reveal', conversationId: id, id: fileTab.file.id })}>Reveal in folder</DropdownMenuItem><DropdownMenuItem onSelect={() => void fileAction({ action: 'export', conversationId: id, id: fileTab.file.id })}>Save a copy…</DropdownMenuItem><DropdownMenuItem disabled={busy || !['text', 'pdf', 'image'].includes(fileTab.file.kind) || fileTab.draft !== (fileTab.file.text ?? '')} onSelect={() => void fileAction({ action: 'add-source', conversationId: id, id: fileTab.file.id })}><Plus />Add to chat</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></div><div className="workspace-file-body"><div className="workspace-file-viewer">{fileTab ? fileTab.file.kind === 'text' && fileTab.file.text === undefined ? <div className="workspace-empty" role="status">Opening file…</div> : <FileViewer key={fileTab.file.id} file={fileTab.file} text={fileTab.draft} raw={fileTab.raw} findRequest={fileSearch.fileId===fileTab.file.id?fileSearch.request:0} change={draft => setFiles(previous => previous.map(item => item.file.id === fileTab.file.id ? { ...item, draft } : item))} openWeb={url => void openLink(url)} /> : <div className="workspace-empty"><Files /><strong>Browse your files</strong><span>Select a file from the tree or open files from your computer.</span><Button variant="outline" size="sm" onClick={() => void fileAction({ action: 'choose', conversationId: id })}>Open files</Button></div>}</div>{fileTree}</div></>}
    {activeImage?.image && <ImageWorkspace source={activeImage} bridge={bridge} versions={conversation.sources.filter(item=>item.kind==='generated-image'&&item.url===activeImage.url)} saved={source=>{setImageTabs(previous=>previous.map(item=>item.id===activeImage.id?source:item).filter((item,index,items)=>items.findIndex(other=>other.id===item.id)===index));select({kind:'image',id:source.id});}} />}
    {selected.kind === 'sources' && <SourcePanel conversation={conversation} bridge={bridge} update={update} previewId={sourceId} openImage={source=>void openImage(source)} close={close} openWeb={url => void openLink(url)} />}
    {quickOpen&&<QuickOpen conversationId={id} bridge={bridge} close={()=>setQuickOpen(false)} open={path=>void fileAction({action:'read',conversationId:id,path})}/>}
    {entryDialog && <Dialog open change={value => { if (!value && !busy) setEntryDialog(null); }} title={entryDialog.action === 'rename' ? 'Rename ' + (entryDialog.entry.kind === 'directory' ? 'folder' : 'file') : 'Delete ' + entryDialog.entry.name + '?'} description={entryDialog.action === 'delete' ? 'This item will be moved to the Recycle Bin.' + (files.some(tab => affects(tab.file.path, entryDialog.entry.path) && tab.draft !== (tab.file.text ?? '')) ? ' Unsaved edits in its open tabs will be discarded.' : '') : undefined}>
      <form onSubmit={event => { event.preventDefault(); void entryAction(entryDialog.action, entryDialog.entry, true); }}>
        {entryDialog.action === 'rename' && <><label className="workspace-dialog-label" htmlFor="workspace-rename-name">Name</label><input id="workspace-rename-name" className="workspace-dialog-input" autoFocus value={entryName} onChange={event => setEntryName(event.target.value)} maxLength={200} required /></>}
        {error && <p role="alert" className="workspace-note">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => setEntryDialog(null)}>Cancel</Button><Button variant="pill" disabled={busy || entryDialog.action === 'rename' && !entryName.trim()}>{entryDialog.action === 'rename' ? 'Save' : 'Delete'}</Button></div>
      </form>
    </Dialog>}
    {creation && <Dialog open change={value=>{if(!value&&!busy)setCreation(null);}} title={creation.kind==='file'?'New file':'New folder'} description={'Create in '+(creation.parent==='.'?project?.name:creation.parent)}><form onSubmit={event=>{event.preventDefault();void createEntry();}}><label className="workspace-dialog-label" htmlFor="workspace-new-name">Name</label><input id="workspace-new-name" className="workspace-dialog-input" autoFocus placeholder={creation.kind==='file'?'untitled.ts':'New folder'} value={newName} onChange={event=>setNewName(event.target.value)} maxLength={200} required />{error&&<p role="alert" className="workspace-note">{error}</p>}<div className="mt-5 flex justify-end gap-2"><Button type="button" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={()=>setCreation(null)}>Cancel</Button><Button variant="pill" disabled={busy||!newName.trim()}>Create {creation.kind}</Button></div></form></Dialog>}
    {pendingClose && <Dialog open change={value => { if (!value) setPendingClose(null); }} title="Discard unsaved changes?" description={`Your changes to ${pendingClose.file.name} have not been saved.`}><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setPendingClose(null)}>Keep editing</Button><Button onClick={() => { if (reloadPending) void fileAction({ action: 'refresh', conversationId: id, id: pendingClose.file.id }); else removeFile(pendingClose); setPendingClose(null); }}>Discard changes</Button></div></Dialog>}
  </aside>;
}
