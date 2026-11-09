import { useEffect, useState } from 'react';
import { Plus, Search, FileText, RefreshCw } from '../icons';
import type { DesktopBridge, Result } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import type { MemoryInput, MemorySnapshot, SavedMemory } from '../../shared/memory';
import type { SourceExcerpt } from '../../shared/tools';
import { SettingRow, Switch } from './AppearanceSettings';
import { SettingsSelect } from './ui/settings-select';
import { SettingsButton as Button } from './ui/settings-button';
import { Input } from './ui/input';
import { Dialog } from './ui/dialog';

export function MemorySettings({ bridge, library }: { bridge: DesktopBridge; library: LibrarySnapshot }) {
  const [data, setData] = useState<MemorySnapshot | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState('personal'); const [query, setQuery] = useState(''); const [hits, setHits] = useState<SourceExcerpt[] | null>(null);
  const [draft, setDraft] = useState<MemoryInput | null>(null);
  const [forget, setForget] = useState<{ id: string; title: string; folder?: boolean } | null>(null);
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null);
  useEffect(() => {
    let mounted = true;
    void bridge.memorySnapshot().then(result => { if (mounted) { if (result.ok) setData(result.value); else setError(result.error); } }).catch(() => { if (mounted) setError('Memory could not be loaded.'); });
    const unsubscribe = bridge.onMemoryUpdate(snapshot => { if (mounted) setData(snapshot); });
    return () => { mounted = false; unsubscribe(); };
  }, [bridge]);
  async function action(operation: () => Promise<Result<MemorySnapshot>>) {
    setBusy(true); setError(''); setHits(null);
    try { const result = await operation(); if (!result.ok) throw new Error(result.error); setData(result.value); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Memory could not be updated.'); return false; }
    finally { setBusy(false); }
  }
  async function search() {
    setBusy(true); setError('');
    try { const result = await bridge.previewMemory(scope === 'personal' ? null : scope, query); if (!result.ok) throw new Error(result.error); setHits(result.value); }
    catch { setError('Memory search could not finish. Check file-read permissions.'); }
    finally { setBusy(false); }
  }
  async function inspect(id: string) { const result = await bridge.memoryEvidence(id); if (result.ok) setPreview(result.value); else setError(result.error); }
  const scopedMemories = data?.memories.filter(memory => memory.projectId === (scope === 'personal' ? null : scope)) ?? [];
  function scopeSelect(value: string, change: (value: string) => void, label: string) { return <SettingsSelect aria-label={label} value={value} onChange={event => change(event.target.value)}><option value="personal">Personal</option>{library.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</SettingsSelect>; }
  if (!data) return <p role={error ? 'alert' : 'status'} className="settings-notice">{error || 'Loading memory…'}</p>;
  return <div className="memory-settings-page">
    <p className="settings-notice">TinyGPT automatically uses the memories you save and indexes folders you add to Projects. Manage sharing, pause indexing, or forget evidence below. Memories and indexed evidence stay on this computer; relevant excerpts go to the inference connection you choose. Project evidence stays within that Project.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <fieldset disabled={busy} className="memory-settings-fields">
      <section className="settings-content-group"><h2>Memory sharing</h2><div className="settings-card">
        <SettingRow title="Use personal memories" description="Make the personal memories you save available across your conversations and Projects. Unrelated personal chats are never indexed automatically."><Switch label="Use personal memories" value={data.includePersonal} change={enabled => void action(() => bridge.personalMemory(enabled))} /></SettingRow>
      </div></section>
      <section className="settings-content-group"><div className="memory-heading"><h2>Saved memories</h2>{scopeSelect(scope, value => { setScope(value); setHits(null); }, 'Memory scope')}<Button onClick={() => setDraft({ projectId: scope === 'personal' ? null : scope, title: '', text: '', enabled: true })}><Plus />Add memory</Button></div>
        <div className="settings-card">{!scopedMemories.length && <p className="memory-empty">Save preferences, facts, and context you want TinyGPT to remember.</p>}{scopedMemories.map(memory => <div key={memory.id} className="memory-entry"><div className="memory-entry-text"><strong>{memory.title}</strong><p>{memory.text}</p><span>{memory.enabled ? 'Available for retrieval' : 'Paused'} · Updated {new Date(memory.updatedAt).toLocaleDateString()}</span></div><div className="memory-entry-actions"><Button onClick={() => setDraft({ id: memory.id, projectId: memory.projectId, title: memory.title, text: memory.text, enabled: memory.enabled })}>Edit</Button><Button onClick={() => void action(() => bridge.saveMemory({ id: memory.id, projectId: memory.projectId, title: memory.title, text: memory.text, enabled: !memory.enabled }))}>{memory.enabled ? 'Pause' : 'Enable'}</Button><Button onClick={() => setForget({ id: memory.id, title: memory.title })}>Forget</Button></div></div>)}</div>
      </section>
      <section className="settings-content-group"><h2>Project folders</h2><div className="settings-card">{!data.indexes.length && <p className="memory-empty">Create a Project and choose a folder to build its knowledge.</p>}{data.indexes.map(index => <div className="memory-entry" key={index.projectId}><div className="memory-entry-text"><strong>{library.projects.find(project => project.id === index.projectId)?.name ?? 'Project'}</strong><p className="memory-path">{index.rootPath ?? 'Choose a folder in Project settings.'}</p><span>{index.enabled ? `${index.files} files · ${index.status}` : 'Indexing off'}{index.skipped ? ` · ${index.skipped} skipped` : ''}{index.lastScan ? ` · Checked ${new Date(index.lastScan).toLocaleTimeString()}` : ''}</span>{index.message && <p className="memory-index-message">{index.message}</p>}</div><div className="memory-entry-actions">{index.enabled ? <><Button onClick={() => void action(() => bridge.projectIndex(index.projectId, 'refresh'))}><RefreshCw />Refresh</Button><Button onClick={() => void action(() => bridge.projectIndex(index.projectId, 'disable'))}>Pause</Button></> : <Button disabled={!index.rootPath} onClick={() => void action(() => bridge.projectIndex(index.projectId, 'enable'))}>Enable indexing</Button>}{index.files > 0 && <Button onClick={() => setForget({ id: index.projectId, title: library.projects.find(project => project.id === index.projectId)?.name ?? 'Project', folder: true })}>Forget index</Button>}</div></div>)}</div></section>
      <section className="settings-content-group"><h2>Inspect retrieval</h2><form className="memory-search" onSubmit={event => { event.preventDefault(); void search(); }}>{scopeSelect(scope, setScope, 'Retrieval scope')}<Input aria-label="Search memory" placeholder="Search memories and indexed files" value={query} maxLength={500} onChange={event => setQuery(event.target.value)} /><Button type="submit" disabled={!query.trim()}><Search />Search</Button></form>{hits && <div className="memory-search-results">{!hits.length && <p className="memory-empty">No eligible passages matched. Check your scope, personal-memory setting, and file-read permissions.</p>}{hits.map(hit => <button type="button" key={`${hit.sourceId}:${hit.position}`} className="memory-search-result" onClick={() => setPreview({ title: hit.title, text: hit.text })}><strong>{hit.title}</strong><p>{hit.text}</p></button>)}</div>}
        {scope !== 'personal' && <div className="memory-file-list">{data.documents.filter(document => document.projectId === scope).map(document => <div key={document.id}><FileText /><button type="button" className="memory-file-title" onClick={() => void inspect(document.id)}>{document.title}</button><Button onClick={() => setForget({ id: document.id, title: document.title })}>Forget</Button></div>)}</div>}
      </section>
    </fieldset>
    {draft && <Dialog open change={open => { if (!open) setDraft(null); }} title={draft.id ? 'Edit memory' : 'Add memory'} description="Save a fact or preference with an explicit personal or Project scope."><form className="memory-editor" onSubmit={event => { event.preventDefault(); void action(() => bridge.saveMemory(draft)).then(ok => { if (ok) setDraft(null); }); }}><label>Scope{scopeSelect(draft.projectId ?? 'personal', value => setDraft({ ...draft, projectId: value === 'personal' ? null : value }), 'Saved memory scope')}</label><label>Title<Input aria-label="Memory title" value={draft.title} maxLength={200} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label><label>Memory<textarea aria-label="Memory text" className="control" value={draft.text} maxLength={12000} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={busy || !draft.title.trim() || !draft.text.trim()}>Save memory</Button></form></Dialog>}
    {forget && <Dialog open change={open => { if (!open) setForget(null); }} title={`Forget ${forget.title}?`} description={forget.folder ? 'Remove indexed text and vectors, clear derived conversation checkpoints, and turn off folder indexing. Original files and conversation messages remain.' : 'Remove this memory or indexed file, its passages and vectors, and derived conversation checkpoints. Forgotten files stay excluded from future scans until the folder index is reset. Original files and conversation messages remain.'}><div className="memory-confirm"><Button disabled={busy} onClick={() => setForget(null)}>Cancel</Button><Button disabled={busy} onClick={() => void action(() => forget.folder ? bridge.projectIndex(forget.id, 'forget') : bridge.forgetMemory(forget.id)).then(ok => { if (ok) setForget(null); })}>Forget</Button></div></Dialog>}
    {preview && <Dialog open change={open => { if (!open) setPreview(null); }} title={preview.title} description="Current retrieved evidence"><pre className="memory-evidence">{preview.text}</pre></Dialog>}
  </div>;
}
