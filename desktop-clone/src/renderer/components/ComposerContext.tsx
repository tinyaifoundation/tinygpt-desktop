import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, File, FileText, Files, FolderOpen, Globe, MessageCircle, Paperclip, Search, X } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { ConversationSummary } from '../../shared/chat';
import type { SourceSummary } from '../../shared/tools';
import type { PluginView } from '../../shared/plugins';
import { PluginIcon } from './ConnectorIcon';
import { PopoverContent } from './ui/popover';
import { ScrollArea } from './ui/scroll-area';

function savedPluginReferences(key: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(value) ? value.filter(id => typeof id === 'string') : []; }
  catch { return []; }
}

export function useComposerPlugins(bridge: DesktopBridge, conversationId: string | null, projectId: string | null, mode: 'chat' | 'code' | 'bot', reportError: (message: string) => void) {
  const key = `tinygpt-composer-plugins:${conversationId ?? `draft:${projectId ?? 'personal'}`}`;
  const [entries, setEntries] = useState<PluginView[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [referenceState, setReferenceState] = useState(() => ({ key, ids: savedPluginReferences(key) }));
  const references = referenceState.key === key ? referenceState.ids : [];
  const [busy, setBusy] = useState(false);
  const previous = useRef<{ conversationId: string | null; projectId: string | null } | undefined>(undefined);
  const currentReferences = useRef(references);
  if (referenceState.key === key) currentReferences.current = references;
  const available = entries.filter(entry => entry.config.enabled && entry.manifest.modes.includes(mode) && (entry.config.projectIds === null || projectId !== null && entry.config.projectIds.includes(projectId)));
  useEffect(() => {
    let alive = true;
    const old = previous.current;
    previous.current = { conversationId, projectId };
    let restored = savedPluginReferences(key);
    if (old && old.conversationId === null && conversationId && old.projectId === projectId) restored = currentReferences.current;
    setReferenceState({ key, ids: restored }); currentReferences.current = restored;
    const load = () => { void Promise.all([bridge.plugins(), bridge.pluginSelection(conversationId, projectId)]).then(([catalog, selected]) => {
      if (!alive) return;
      if (catalog.ok) setEntries(catalog.value.entries);
      if (selected.ok) { setSelection(selected.value); setReferenceState(state => state.key === key ? { key, ids: state.ids.filter(id => selected.value.includes(id)) } : state); }
    }, () => { if (alive) reportError('Plugins could not be loaded.'); }); };
    load(); const unsubscribe = bridge.onPluginsUpdate(load);
    return () => { alive = false; unsubscribe(); };
  }, [bridge, conversationId, projectId, key]);
  useEffect(() => { if (referenceState.key === key) try { localStorage.setItem(key, JSON.stringify(referenceState.ids)); } catch { /* Optional draft persistence. */ } }, [key, referenceState]);
  async function toggle(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const removing = references.includes(id);
      const ids = removing ? selection.filter(value => value !== id) : [...new Set([...selection, id])];
      const result = await bridge.selectPlugins(conversationId, projectId, ids);
      if (!result.ok) throw Error(result.error);
      setSelection(result.value); setReferenceState(state => state.key === key ? { key, ids: removing ? state.ids.filter(value => value !== id) : [...new Set([...state.ids, id])] } : state);
    } catch (error) { reportError(error instanceof Error ? error.message : 'The plugin could not be selected.'); }
    finally { setBusy(false); }
  }
  return { available, references: available.filter(entry => references.includes(entry.id)), busy, toggle };
}

function AddRow({ icon, label, description, selected, disabled, action }: { icon: ReactNode; label: string; description?: string; selected?: boolean; disabled?: boolean; action: () => void }) {
  return <button type="button" className="composer-add-row" disabled={disabled} onClick={action} aria-pressed={selected}>
    <span className="composer-add-icon">{icon}</span><span className="composer-add-label">{label}</span>{description && <span className="composer-add-description">{description}</span>}{selected && <Check className="composer-add-check" aria-hidden="true" />}
  </button>;
}

export function ComposerAddMenu({ empty, disabled, plugins, conversations, conversationId, drafts, attach, folder, link, sources, files, browser, managePlugins }: {
  empty: boolean; disabled: boolean; plugins: ReturnType<typeof useComposerPlugins>; conversations: ConversationSummary[]; conversationId: string | null; drafts: SourceSummary[];
  attach: () => void; folder: () => void; link: (id: string) => void; sources: () => void; files: () => void; browser: () => void; managePlugins: () => void;
}) {
  const [query, setQuery] = useState(''); const term = query.trim().toLocaleLowerCase();
  const listedPlugins = plugins.available.filter(entry => `${entry.manifest.name} ${entry.manifest.description}`.toLocaleLowerCase().includes(term));
  const chats = conversations.filter(item => item.id !== conversationId && !item.archived && `${item.title} ${item.summary ?? ''}`.toLocaleLowerCase().includes(term)).sort((a, b) => b.updatedAt - a.updatedAt);
  return <PopoverContent className="composer-add-menu" side={empty ? 'bottom' : 'top'} align="start" sideOffset={8} avoidCollisions={false} aria-label="Add context" onOpenAutoFocus={event => event.preventDefault()}>
    <ScrollArea className="composer-add-scroll" viewportClassName="composer-add-viewport" type="always">
      <div className="composer-add-menu-header"><span>Add</span><label><Search aria-hidden="true" /><input aria-label="Search files, plugins, and conversations" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      {!term && <section aria-label="Files and folders"><h3>Files and folders</h3>
        <AddRow icon={<Paperclip />} label="Attach files or images" action={attach} disabled={disabled} />
        <AddRow icon={<FolderOpen />} label="Attach a folder" action={folder} disabled={disabled} />
        <AddRow icon={<Files />} label="Workspace files" action={files} disabled={disabled} />
        <AddRow icon={<FileText />} label="Sources" action={sources} />
        <AddRow icon={<Globe />} label="Browser" action={browser} />
      </section>}
      <section aria-label="Plugins"><h3>Plugins</h3>
        {listedPlugins.map(entry => <AddRow key={entry.id} icon={<PluginIcon entry={entry} />} label={entry.manifest.name} description={entry.status === 'connected' ? entry.manifest.description : 'Connect in Plugins'} selected={plugins.references.some(item => item.id === entry.id)} disabled={disabled || plugins.busy || entry.status !== 'connected'} action={() => void plugins.toggle(entry.id)} />)}
        {!listedPlugins.length && <p className="composer-add-empty">{term ? 'No matching plugins.' : 'No plugins available for this chat.'}</p>}
        <button type="button" className="composer-add-manage" onClick={managePlugins}>Manage plugins</button>
      </section>
      <section aria-label="Conversations"><h3>Conversations</h3>
        {chats.map(item => <AddRow key={item.id} icon={<MessageCircle />} label={item.title} description={item.summary ?? undefined} selected={drafts.some(source => source.kind === 'conversation' && source.url === `tinygpt-conversation:${item.id}`)} disabled={disabled} action={() => link(item.id)} />)}
        {!chats.length && <p className="composer-add-empty">{term ? 'No matching conversations.' : 'Your other conversations will appear here.'}</p>}
      </section>
    </ScrollArea>
  </PopoverContent>;
}

export function ComposerAttachments({ drafts, conversationId, bridge, disabled, open, remove }: { drafts: SourceSummary[]; conversationId: string | null; bridge: DesktopBridge; disabled: boolean; open: (id: string) => void; remove: (id: string) => void }) {
  const [images, setImages] = useState<Record<string, string>>({});
  const imageIds = drafts.filter(source => source.kind === 'image').map(source => source.id).join(',');
  useEffect(() => {
    let alive = true; setImages({});
    if (conversationId) for (const id of imageIds.split(',').filter(Boolean)) void bridge.source(conversationId, id).then(result => { if (alive && result.ok && result.value.image) setImages(previous => ({ ...previous, [id]: result.value.image! })); }, () => { /* Keep the file preview if its image could not be loaded. */ });
    return () => { alive = false; };
  }, [bridge, conversationId, imageIds]);
  const files = drafts.filter(source => source.kind !== 'conversation').sort((a, b) => Number(b.kind === 'image') - Number(a.kind === 'image') || a.createdAt - b.createdAt);
  return files.length ? <div className="composer-attachments">{files.map(source => <div key={source.id} className={`composer-attachment ${source.kind === 'image' ? 'is-image' : ''}`}>
    <button type="button" className="composer-attachment-preview" aria-label={`Preview ${source.title}`} onClick={() => open(source.id)}>
      {source.kind === 'image' && images[source.id] ? <img src={images[source.id]} alt={source.title} /> : <>
        <span className="composer-attachment-center">{source.processing?.status === 'preparing' ? 'Preparing…' : source.processing?.status === 'partial' ? 'Partial' : source.processing?.status === 'failed' ? 'Could not read' : source.kind === 'folder' ? <FolderOpen /> : <File />}</span>
        <span className="composer-attachment-footer"><span className="composer-file-type" data-pdf={source.mime === 'application/pdf' || undefined}>{source.kind === 'folder' ? <FolderOpen /> : <FileText />}{source.mime === 'application/pdf' && <small>PDF</small>}</span><span>{source.title}</span></span>
      </>}
    </button><button type="button" className="composer-context-remove" disabled={disabled} aria-label={`Remove attachment ${source.title}`} onClick={() => remove(source.id)}><X /></button>
  </div>)}</div> : null;
}

export function ComposerReferences({ drafts, plugins, disabled, open, remove }: { drafts: SourceSummary[]; plugins: ReturnType<typeof useComposerPlugins>; disabled: boolean; open: (id: string) => void; remove: (id: string) => void }) {
  function referenceKey(event: KeyboardEvent<HTMLSpanElement>, action: () => void, blocked = disabled) {
    if (event.nativeEvent.isComposing || event.shiftKey) return;
    const field = event.currentTarget.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea');
    if (event.key === 'Backspace' || event.key === 'Delete') {
      if (blocked) return;
      event.preventDefault(); event.stopPropagation(); action();
      field?.focus(); field?.setSelectionRange(0, 0);
    } else if (event.key === 'ArrowRight') { event.preventDefault(); field?.focus(); field?.setSelectionRange(0, 0); }
    else if (event.key === 'ArrowLeft') {
      const references = [...(event.currentTarget.closest('.composer')?.querySelectorAll<HTMLElement>('[data-composer-reference]') ?? [])];
      const previous = references[references.indexOf(event.currentTarget) - 1];
      if (previous) { event.preventDefault(); previous.focus(); }
    }
  }
  return <>{drafts.filter(source => source.kind === 'conversation').map(source => <span key={source.id} data-composer-reference={source.id} tabIndex={-1} role="group" aria-label={`Conversation attachment ${source.title}`} className="composer-reference is-conversation" onKeyDown={event => referenceKey(event, () => remove(source.id))}><button type="button" className="composer-reference-label" aria-label={`Open conversation ${source.title}`} onClick={() => open(source.id)}><MessageCircle /><span>{source.title}</span></button></span>)}
    {plugins.references.map(entry => <span key={entry.id} data-composer-reference={entry.id} tabIndex={-1} role="group" aria-label={`Plugin reference ${entry.manifest.name}`} className="composer-reference is-plugin" onKeyDown={event => referenceKey(event, () => void plugins.toggle(entry.id), disabled || plugins.busy)}><span className="composer-reference-label"><PluginIcon entry={entry} /><span>{entry.manifest.name}</span></span><button type="button" className="composer-reference-remove" disabled={disabled || plugins.busy} aria-label={`Remove plugin ${entry.manifest.name}`} onClick={() => void plugins.toggle(entry.id)}><X /></button></span>)}</>;
}
