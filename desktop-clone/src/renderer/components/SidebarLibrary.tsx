import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, FolderClosed, FolderOpen, Plus, PanelRight, SquarePen, MoreHorizontal, Bookmark, Archive, ArchiveRestore, Pencil, Trash2, Check, LoaderCircle, Clock } from '../icons';
import type { ConversationSummary, ConversationOrganization, LibrarySnapshot, ProjectOrganization } from '../../shared/chat';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from './ui/dropdown-menu';
import { Button } from './ui/button';
import { ControlTooltip, TooltipProvider } from './ui/tooltip';
import { ConversationPreview } from './ConversationPreview';
import type { DesktopBridge } from '../../shared/contracts';
import { matchesConversation } from '../../shared/conversation-search';
import { WindowedList } from './WindowedList';

const preferenceKey = 'tinygpt.sidebar.library';
type Preferences = { projects: boolean; recents: boolean; favorites?: boolean; expanded: string[] };
function preferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null');
    return { projects: saved?.projects !== false, recents: saved?.recents !== false, favorites: saved?.favorites !== false, expanded: Array.isArray(saved?.expanded) ? saved.expanded.filter((id: unknown) => typeof id === 'string').slice(0, 1000) : [] };
  } catch { return { projects: true, recents: true, expanded: [] }; }
}

function Section({ title, open, toggle, action, children }: { title: string; open: boolean; toggle: () => void; action: ReactNode; children: ReactNode }) {
  const id = useId();
  return <section data-sidebar-section={title} className="sidebar-library-section">
    <div className="sidebar-section-heading flex items-center gap-1">
      <Button variant="ghost" className="sidebar-entry sidebar-section-toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
        {title}<ChevronRight className={`sidebar-caret transition-transform ${open ? 'rotate-90' : ''}`} />
      </Button>
      {action}
    </div>
    <div id={id} hidden={!open}>{open && children}</div>
  </section>;
}

export function SidebarLibrary({ bridge, library, conversationId, projectId, query, busy, selectConversation, newChat, newProject, projectSettings, openProject, organizeProject, organize, edit }: {
  bridge: DesktopBridge;
  library: LibrarySnapshot; conversationId?: string; projectId: string | null; query: string | null; busy: boolean;
  selectConversation: (id: string) => void; newChat: (projectId: string | null) => void;
  newProject: (conversationId?: string) => void; projectSettings: (projectId: string) => void;
  openProject: (projectId: string) => void; organizeProject: (action: ProjectOrganization) => void;
  organize: (action: ConversationOrganization) => void; edit: (chat: ConversationSummary, action: 'rename' | 'delete') => void;
}) {
  const [saved, setSaved] = useState(preferences);
  const [menuConversationId, setMenuConversationId] = useState<string | null>(null);
  const previousProject = useRef(projectId);
  const search = query?.trim().toLocaleLowerCase() ?? '';
  useEffect(() => { try { localStorage.setItem(preferenceKey, JSON.stringify(saved)); } catch { /* UI still works when storage is unavailable. */ } }, [saved]);
  useEffect(() => {
    if (previousProject.current === projectId) return;
    previousProject.current = projectId;
    if (projectId) setSaved(previous => previous.expanded.includes(projectId) ? previous : { ...previous, expanded: [...previous.expanded, projectId] });
  }, [projectId]);
  const matches = (chat: ConversationSummary) => matchesConversation(chat, search);
  const personal = library.conversations.filter(chat => chat.projectId === null && !chat.pinned && !chat.archived && matches(chat));
  const favorites = library.conversations.filter(chat => chat.pinned && !chat.archived);
  function chatRow(chat: ConversationSummary, nested = false) {
    const running = library.activeRuns.some(run => run.conversationId === chat.id);
    const awaiting = library.approvals.some(item => item.conversationId === chat.id) || library.browserHandoffs.some(item => item.conversationId === chat.id) || chat.connectionPending;
    const locked = busy || running;
    return <ConversationPreview key={chat.id} disabled={menuConversationId !== null} chat={chat} projectName={library.projects.find(project => project.id === chat.projectId)?.name} bridge={bridge}><div className={`sidebar-chat-container ${nested ? 'is-nested' : ''} ${chat.id === conversationId ? 'is-active' : ''}`}><Button variant="ghost" className="sidebar-entry sidebar-chat-row" aria-description={chat.scheduled ? 'Scheduled task conversation' : undefined} aria-current={chat.id === conversationId ? 'page' : undefined} disabled={busy} onClick={() => selectConversation(chat.id)}><span className="min-w-0 flex-1 truncate">{chat.title}</span><span className="sidebar-chat-state">{awaiting && <span className="sidebar-awaiting" aria-label="Awaiting approval">Awaiting</span>}{running && <LoaderCircle className="sidebar-run-spinner animate-spin" aria-label="Reply running" />}{!running && !awaiting && chat.unread && <span className="sidebar-unread" aria-label="Unread reply" />}{chat.scheduled && <Clock className="sidebar-scheduled-clock" aria-hidden="true" />}</span></Button><div className="sidebar-chat-controls"><ControlTooltip label={chat.pinned ? 'Unfavorite' : 'Favorite'}><button type="button" aria-label={`${chat.pinned ? 'Unfavorite' : 'Favorite'} ${chat.title}`} disabled={locked} onClick={() => organize({ id: chat.id, action: 'pin', value: !chat.pinned })}><Bookmark fill={chat.pinned ? 'currentColor' : 'none'} /></button></ControlTooltip><DropdownMenu modal={false} onOpenChange={open => setMenuConversationId(previous => open ? chat.id : previous === chat.id ? null : previous)}><DropdownMenuTrigger asChild><button type="button" aria-label={`More for ${chat.title}`} disabled={locked}><MoreHorizontal /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="conversation-menu"><DropdownMenuItem onSelect={() => edit(chat, 'rename')}><Pencil />Rename</DropdownMenuItem><DropdownMenuItem onSelect={() => organize({ id: chat.id, action: 'pin', value: !chat.pinned })}><Bookmark />{chat.pinned ? 'Unfavorite' : 'Favorite'}</DropdownMenuItem><DropdownMenuItem onSelect={() => organize({ id: chat.id, action: 'archive', value: !chat.archived })}>{chat.archived ? <ArchiveRestore /> : <Archive />}{chat.archived ? 'Unarchive' : 'Archive'}</DropdownMenuItem><DropdownMenuSub><DropdownMenuSubTrigger><FolderOpen />Move to Project<ChevronRight className="ml-auto" /></DropdownMenuSubTrigger><DropdownMenuSubContent>{chat.projectId && <DropdownMenuItem onSelect={() => organize({ id: chat.id, action: 'move', projectId: null })}>Remove from Project</DropdownMenuItem>}{library.projects.map(project => <DropdownMenuItem key={project.id} onSelect={() => organize({ id: chat.id, action: 'move', projectId: project.id })}><FolderClosed />{project.name}{project.id === chat.projectId && <Check className="ml-auto" />}</DropdownMenuItem>)}<DropdownMenuSeparator className="menu-separator" /><DropdownMenuItem onSelect={() => newProject(chat.id)}><Plus />New Project</DropdownMenuItem></DropdownMenuSubContent></DropdownMenuSub><DropdownMenuSeparator className="menu-separator" /><DropdownMenuItem className="text-destructive" onSelect={() => edit(chat, 'delete')}><Trash2 />Delete</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></div></ConversationPreview>;
  }
  return <TooltipProvider><div className="sidebar-library-scroll">
    <Section title="Projects" open={!!search || saved.projects} toggle={() => setSaved(previous => ({ ...previous, projects: !previous.projects }))} action={
      <ControlTooltip label="New project"><Button variant="ghost" size="icon" className="sidebar-hover-action size-7 shrink-0 text-muted-foreground" aria-label="New Project" disabled={busy} onClick={() => { setSaved(previous => ({ ...previous, projects: true })); newProject(); }}><Plus /></Button></ControlTooltip>
    }>
      {library.projects.filter(project => !search || project.name.toLocaleLowerCase().includes(search) || library.conversations.some(chat => chat.projectId === project.id && matches(chat))).map(project => {
        const open = !!search || saved.expanded.includes(project.id);
        const chats = library.conversations.filter(chat => chat.projectId === project.id && !chat.archived && matches(chat));
        const Folder = open ? FolderOpen : FolderClosed;
        const locked = busy || library.activeRuns.some(run => library.conversations.some(chat => chat.id === run.conversationId && chat.projectId === project.id));
        return <div key={project.id} data-sidebar-project={project.id}>
          <div className={`sidebar-project-row flex items-center ${projectId === project.id && !conversationId ? 'is-active' : ''}`}>
            <Button variant="ghost" className="sidebar-entry sidebar-project-toggle" aria-label={project.name} aria-expanded={open} aria-controls={`project-chats-${project.id}`} disabled={busy} onClick={() => setSaved(previous => ({ ...previous, expanded: previous.expanded.includes(project.id) ? previous.expanded.filter(id => id !== project.id) : [...previous.expanded, project.id] }))}>
              <Folder /><span className="truncate">{project.name}</span>{project.favorite && <Bookmark className="sidebar-project-favorite" fill="currentColor" aria-label="Favorite project" />}
            </Button>
            <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="sidebar-hover-action size-6 shrink-0 text-muted-foreground" aria-label={`More for project ${project.name}`} disabled={busy}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="conversation-menu" aria-label={`Options for ${project.name}`}><DropdownMenuItem onSelect={() => organizeProject({ id: project.id, action: 'favorite', value: !project.favorite })}><Bookmark />{project.favorite ? 'Unfavorite' : 'Favorite'}</DropdownMenuItem><DropdownMenuItem disabled={locked} onSelect={() => projectSettings(project.id)}><Pencil />Edit project</DropdownMenuItem><DropdownMenuItem onSelect={() => openProject(project.id)}><PanelRight />Open in workspace</DropdownMenuItem><DropdownMenuSeparator className="menu-separator" /><DropdownMenuItem disabled={locked || !chats.length} onSelect={() => organizeProject({ id: project.id, action: 'archive-chats' })}><Archive />Archive all chats</DropdownMenuItem><DropdownMenuItem disabled={locked} className="text-destructive" onSelect={() => organizeProject({ id: project.id, action: 'remove' })}><Trash2 />Remove project</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            <ControlTooltip label={`New chat in ${project.name}`}><Button variant="ghost" size="icon" className="sidebar-hover-action size-6 shrink-0 text-muted-foreground" aria-label={`New chat in ${project.name}`} disabled={busy} onClick={() => newChat(project.id)}><SquarePen /></Button></ControlTooltip>
          </div>
          <nav id={`project-chats-${project.id}`} aria-label={`Chats in ${project.name}`} hidden={!open} className="space-y-0.5">
            {open && <WindowedList items={chats} render={chat => chatRow(chat, true)} pinned={[conversationId, menuConversationId]} />}
            {!chats.length && <p className="sidebar-empty is-nested">{search ? 'No matching chats' : 'No chats yet'}</p>}
          </nav>
        </div>;
      })}
      {!library.projects.length && <p className="sidebar-empty">No projects yet</p>}
    </Section>
    {favorites.length > 0 && <Section title="Favorites" open={saved.favorites !== false} toggle={() => setSaved(previous => ({ ...previous, favorites: previous.favorites === false }))} action={null}><nav aria-label="Favorite conversations"><WindowedList items={favorites} render={chat => chatRow(chat)} pinned={[conversationId, menuConversationId]} /></nav></Section>}
    <Section title="Recents" open={!!search || saved.recents} toggle={() => setSaved(previous => ({ ...previous, recents: !previous.recents }))} action={
      <ControlTooltip label="New chat"><Button variant="ghost" size="icon" className="sidebar-hover-action size-7 shrink-0 text-muted-foreground" aria-label="New recent chat" disabled={busy} onClick={() => { setSaved(previous => ({ ...previous, recents: true })); newChat(null); }}><SquarePen /></Button></ControlTooltip>
    }>
      <nav aria-label="Saved conversations" className="space-y-0.5"><WindowedList items={personal} render={chat => chatRow(chat)} pinned={[conversationId, menuConversationId]} /></nav>
      {!personal.length && <p className="sidebar-empty">{search ? 'No matching chats' : 'No chats yet'}</p>}
    </Section>
  </div></TooltipProvider>;
}

