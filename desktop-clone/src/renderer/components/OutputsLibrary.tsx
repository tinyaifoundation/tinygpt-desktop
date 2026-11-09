import { useEffect, useState } from 'react';
import { ArrowUpRight, File, FileText, Globe, Image, LayoutGrid, Library, List, Search, SlidersHorizontal } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import type { LibraryOutput, OutputCategory } from '../../shared/outputs';
import { CatalogTopbar } from './CatalogTopbar';
import { Dialog } from './ui/dialog';
import { SettingsButton as Button } from './ui/settings-button';
import { SettingsSelect } from './ui/settings-select';
import { ControlTooltip } from './ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from './ui/dropdown-menu';

const sections = [{ id: 'all', label: 'All' }, { id: 'upload', label: 'Uploads' }, { id: 'created', label: 'Created' }, { id: 'project', label: 'Project files' }, { id: 'source', label: 'Sources' }, { id: 'pages', label: 'Pages' }, { id: 'sites', label: 'Sites' }, { id: 'images', label: 'Images' }] as const;
function OutputIcon({ category }: { category: OutputCategory }) {
  const Icon = category === 'images' ? Image : category === 'sites' ? Globe : category === 'pages' ? FileText : File;
  return <span className={`output-icon catalog-card-icon is-${category}`}><Icon /></span>;
}
function activityLabel(timestamp: number) {
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  return days < 1 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? `${days}d` : days < 30 ? `${Math.floor(days / 7)}w` : new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
export function OutputsLibrary({ bridge, library, open, close }: { close: () => void; bridge: DesktopBridge; library: LibrarySnapshot; open: (output: LibraryOutput) => void }) {
  const [outputs, setOutputs] = useState<LibraryOutput[]>([]);
  const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [section, setSection] = useState<typeof sections[number]['id']>('all'); const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<(Awaited<ReturnType<NonNullable<DesktopBridge['librarySource']>>> & { ok: true })['value']>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!preview || preview.processing?.status !== 'preparing') return;
    let alive = true; const id = preview.id;
    const timer = setInterval(() => { void bridge.librarySource?.(id).then(result => { if (alive && result.ok) setPreview(result.value); }); }, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [bridge, preview?.id, preview?.processing?.status]);
  const [projectFilter, setProjectFilter] = useState('all'), [chatFilter, setChatFilter] = useState('all');
  const [destination, setDestination] = useState(library.lastConversationId ?? '');
  const [contentMatches, setContentMatches] = useState<string[]>([]);
  useEffect(() => { let alive = true; setContentMatches([]); if (!query.trim()) return; const timer = setTimeout(() => { void bridge.searchLibrary?.(query.slice(0,500)).then(result => { if (alive && result.ok) setContentMatches(result.value); }); }, 200); return () => { alive = false; clearTimeout(timer); }; }, [bridge, query, revision, library.outputsRevision]);
  const inspect = async (output: LibraryOutput) => {
    if (!output.sourceId || !output.origin || output.origin === 'created') { open(output); return; }
    const result = await bridge.librarySource?.(output.sourceId); if (result?.ok) setPreview(result.value); else setError(result && !result.ok ? result.error : 'File preview is unavailable.');
  };
  const openItem = (output: LibraryOutput) => { void inspect(output); };
  const [view, setView] = useState<'list' | 'grid'>(() => localStorage.getItem('tinygpt.outputs.view') === 'grid' ? 'grid' : 'list');
  const [sort, setSort] = useState('recent');
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => void bridge.outputs().then(result => { if (!alive) return; if (result.ok) { setOutputs(result.value); setError(''); } else setError(result.error); setLoading(false); }).catch(() => { if (alive) { setError('Your outputs could not be loaded.'); setLoading(false); } }), 100);
    return () => { alive = false; clearTimeout(timer); };
  }, [bridge, library.outputsRevision, revision]);
  const normalized = query.trim().toLowerCase();
  const filtered = outputs.filter(output => (section === 'all' || output.category === section || output.origin === section) && (projectFilter === 'all' || output.projectId === projectFilter || projectFilter === 'personal' && !output.projectId) && (chatFilter === 'all' || output.conversationId === chatFilter) && (!normalized || contentMatches.includes(output.sourceId ?? '') || [output.name, output.path, output.projectName, output.conversationTitle, output.origin, output.processing?.status].join(' ').toLowerCase().includes(normalized)));
  const rows = [...filtered].sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'oldest' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt);
  const recent = filtered.slice(0, 4);
  function changeView(value: 'list' | 'grid') { setView(value); localStorage.setItem('tinygpt.outputs.view', value); }
  return <section className="conversation-pane outputs-library" aria-label="Library">
    <CatalogTopbar close={close}><div className="outputs-tabs catalog-tabs" role="tablist" aria-label="Output categories">{sections.map(item => <button key={item.id} type="button" role="tab" id={`output-tab-${item.id}`} aria-controls="output-results" aria-selected={section === item.id} onClick={() => setSection(item.id)} onKeyDown={event => { const index = sections.findIndex(tab => tab.id === section); const next = event.key === 'ArrowRight' ? (index + 1) % sections.length : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : null; if (next !== null) { event.preventDefault(); setSection(sections[next].id); document.getElementById(`output-tab-${sections[next].id}`)?.focus(); } }} tabIndex={section === item.id ? 0 : -1}>{item.label}</button>)}</div></CatalogTopbar>
    <div className="outputs-content catalog-content" id="output-results" role="tabpanel" aria-labelledby={`output-tab-${section}`}>
      <div className="catalog-header"><header className="catalog-heading"><h1>{sections.find(item => item.id === section)?.label}</h1></header><div className="outputs-toolbar catalog-toolbar"><label className="catalog-search"><Search /><input aria-label="Search Library" placeholder="Search Library" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="Filter by Project" value={projectFilter} onChange={event => { setProjectFilter(event.target.value); setChatFilter('all'); }}><option value="all">All Projects</option><option value="personal">Personal chats</option>{library.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <select aria-label="Filter by chat" value={chatFilter} onChange={event => setChatFilter(event.target.value)}><option value="all">All chats</option>{library.conversations.filter(chat => projectFilter === 'all' || chat.projectId === projectFilter || projectFilter === 'personal' && !chat.projectId).map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select>
        <DropdownMenu><ControlTooltip label="Sort outputs"><DropdownMenuTrigger asChild><button type="button" aria-label="Sort outputs"><SlidersHorizontal /></button></DropdownMenuTrigger></ControlTooltip><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={sort} onValueChange={setSort}><DropdownMenuRadioItem value="recent">Most recent</DropdownMenuRadioItem><DropdownMenuRadioItem value="oldest">Oldest first</DropdownMenuRadioItem><DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
        <ControlTooltip label="Grid view"><button type="button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => changeView('grid')}><LayoutGrid /></button></ControlTooltip>
        <ControlTooltip label="List view"><button type="button" aria-label="List view" aria-pressed={view === 'list'} onClick={() => changeView('list')}><List /></button></ControlTooltip>
      </div><p className="outputs-description">Find uploaded files, created outputs, Project files, and saved sources</p></div>
      {error && <p role="alert" className="outputs-error">{error}</p>}
      {loading ? <p className="outputs-empty" role="status">Loading outputs…</p> : !rows.length ? <div className="outputs-empty"><Library /><h2>{normalized ? 'No matching outputs' : section === 'all' ? 'Your files live here' : `No ${section} yet`}</h2><p>{normalized ? 'Try another search.' : 'Uploaded files, created outputs, Project files, and saved sources appear here.'}</p></div> : <>
        {view === 'list' && !normalized && <section className="outputs-recent catalog-section"><div className="catalog-section-heading"><h2>Recent files</h2></div><div className="catalog-grid">{recent.map(output => <button type="button" key={output.id} onClick={() => openItem(output)} className="catalog-card" aria-label={`Open recent ${output.name}`}><OutputIcon category={output.category} /><span className="catalog-card-copy"><strong>{output.name}</strong><small>{output.projectName ?? output.conversationTitle}</small></span><ArrowUpRight className="output-open" /></button>)}</div></section>}
        <section className="catalog-section"><div className="catalog-section-heading"><h2>Your Library</h2><span>{filtered.length} file{filtered.length === 1 ? '' : 's'}</span></div>{view === 'list' ? <table className="outputs-table"><thead><tr><th>Name</th><th>Source</th><th>Last activity</th></tr></thead><tbody>{rows.map(output => <tr key={output.id}><td><button type="button" onClick={() => openItem(output)} className="catalog-card" aria-label={`Open ${output.name}`} title={output.path}><OutputIcon category={output.category} /><span>{output.name}</span></button></td><td><span title={output.conversationTitle}>{output.projectName ?? output.conversationTitle} · {output.origin ?? 'created'}{output.excluded ? ' · excluded from retrieval' : output.processing ? ' · ' + output.processing.status : ''}</span></td><td><time dateTime={new Date(output.updatedAt).toISOString()} title={new Date(output.updatedAt).toLocaleString()}>{activityLabel(output.updatedAt)}</time></td></tr>)}</tbody></table> : <div className="outputs-grid catalog-grid">{rows.map(output => <button type="button" key={output.id} onClick={() => openItem(output)} className="catalog-card" aria-label={`Open ${output.name}`} title={output.path}><OutputIcon category={output.category} /><span className="catalog-card-copy"><strong>{output.name}</strong><small>{output.projectName ?? output.conversationTitle}</small></span><time dateTime={new Date(output.updatedAt).toISOString()}>{activityLabel(output.updatedAt)}</time></button>)}</div>}</section>
      </>}
      {preview && <Dialog open change={value => { if (!value) setPreview(undefined); }} title={preview.title} description={preview.processing?.notice ?? (preview.processing?.status === 'preparing' ? 'Preparing this document in the background.' : 'Saved file and extracted evidence')}>
        {error && <p role="alert" className="outputs-error">{error}</p>}
        {preview.image ? <img src={preview.image} alt={preview.title} style={{ maxWidth: '100%', maxHeight: '45vh', objectFit: 'contain' }} /> : <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '45vh', overflow: 'auto' }}>{preview.text.slice(0, 20000)}{preview.text.length > 20000 ? '\n[Preview limited; download the file for complete contents.]' : ''}</pre>}
        <div className="library-file-destination"><label htmlFor="library-destination">Attach to chat</label><SettingsSelect id="library-destination" aria-label="Destination chat" value={destination} onChange={event => setDestination(event.target.value)}><option value="">Choose a chat</option>{library.conversations.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</SettingsSelect>
          <Button type="button" disabled={!destination || preview.processing?.status === 'preparing'} onClick={() => void bridge.reuseSource?.(preview.id, destination).then(result => { if (result.ok) setPreview(undefined); else setError(result.error); })}>Attach file</Button>
        </div>
        <div className="library-file-actions"><Button variant="muted" type="button" onClick={() => void bridge.downloadSource?.(preview.id).then(result => { if (!result.ok) setError(result.error); })}>{preview.linkedFile ? 'Download current file' : preview.originalAvailable ? 'Download original' : 'Download text'}</Button>
          {preview.processing && ['failed', 'partial'].includes(preview.processing.status) && <Button variant="muted" type="button" onClick={() => void bridge.retrySource?.(preview.id).then(result => { if (result.ok) { setPreview(undefined); setRevision(value => value + 1); } else setError(result.error); })}>Retry preparation</Button>}
          <Button variant="muted" type="button" onClick={() => void bridge.excludeSource?.(preview.id, !preview.excluded).then(result => { if (result.ok) { setPreview({ ...preview, excluded: !preview.excluded }); setRevision(value => value + 1); } else setError(result.error); })}>{preview.excluded ? 'Include in retrieval' : 'Exclude from retrieval'}</Button>
          <Button variant="muted" type="button" onClick={() => { if (window.confirm('Remove this saved file from the Library and retrieval? Existing conversation messages remain.')) void bridge.removeLibrarySource?.(preview.id).then(result => { if (result.ok) { setPreview(undefined); setRevision(value => value + 1); } else setError(result.error); }); }}>Remove</Button>
        </div>
      </Dialog>}
    </div>
  </section>;
}
