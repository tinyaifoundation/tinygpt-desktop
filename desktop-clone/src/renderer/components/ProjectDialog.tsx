import { useState } from 'react';
import { ChevronDown, FolderClosed, FolderPlus, Lightbulb, X } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { ChatProject, LibrarySnapshot } from '../../shared/chat';
import { Dialog } from './ui/dialog';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ControlTooltip } from './ui/tooltip';

export function ProjectDialog({ bridge, project, close, saved, remove }: { bridge: DesktopBridge; project?: ChatProject; close: () => void; saved: (library: LibrarySnapshot, id: string) => Promise<void> | void; remove?: () => Promise<void> }) {
  const [name, setName] = useState(project?.name ?? '');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [isolated, setIsolated] = useState(project?.browserIsolated ?? false);
  const [folder, setFolder] = useState<{ id?: string; path: string } | null>(project?.rootPath ? { path: project.rootPath } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const folderName = folder?.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder?.path;
  async function chooseFolder() {
    setBusy(true); setError('');
    try { const result = await bridge.chooseNewProjectFolder(); if (!result.ok) throw Error(result.error); if (result.value) setFolder(result.value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The folder could not be selected.'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setError('');
    try {
      let library: LibrarySnapshot; let id: string;
      if (project) {
        const result = await bridge.updateProject(project.id, name, instructions, isolated, folder ? folder.id : null);
        if (!result.ok) throw Error(result.error); library = result.value; id = project.id;
      } else {
        const result = await bridge.createProject(name, instructions, isolated, folder?.id);
        if (!result.ok) throw Error(result.error); id = result.value.id;
        const refreshed = await bridge.library(); if (!refreshed.ok) throw Error(refreshed.error); library = refreshed.value;
      }
      await saved(library, id); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The project could not be saved.'); }
    finally { setBusy(false); }
  }
  const options = <Popover><PopoverTrigger asChild><Button type="button" variant="ghost" disabled={busy} className="project-dialog-options-trigger">Project options<ChevronDown /></Button></PopoverTrigger><PopoverContent side="top" align="start" className="project-dialog-options"><label>Instructions<textarea aria-label="Project instructions" rows={4} maxLength={12000} value={instructions} onChange={event => setInstructions(event.target.value)} disabled={busy} /></label><label className="project-dialog-isolation"><input type="checkbox" checked={isolated} onChange={event => setIsolated(event.target.checked)} disabled={busy} />Use a separate browser profile</label></PopoverContent></Popover>;
  return <Dialog open change={open => { if (!open && !busy) close(); }} title={project ? 'Edit project' : 'Create project'} className={`project-dialog ${project ? 'is-editing' : ''}`}>
    <ScrollArea viewportClassName="project-dialog-body-viewport"><form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="project-dialog-name">{!project && <span>Project name</span>}<div className="project-dialog-name-field"><FolderClosed aria-hidden="true" /><Input autoFocus aria-label="Project name" placeholder="Name your project" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></div></label>
      <section className="project-dialog-folders" aria-labelledby="project-source-folders"><div className="project-dialog-folders-heading"><h2 id="project-source-folders">Source folders</h2>{project && options}</div>
        <div className="project-dialog-folder-box">{folder ? <><ScrollArea viewportClassName="project-dialog-folder-viewport"><div className="project-dialog-folder-row"><FolderClosed aria-hidden="true" /><span title={folder.path}>{folderName}</span><ControlTooltip label="Remove folder"><button type="button" aria-label="Remove source folder" disabled={busy} onClick={() => setFolder(null)}><X /></button></ControlTooltip></div></ScrollArea><button type="button" className="project-dialog-folder-add" disabled={busy} onClick={() => void chooseFolder()}><FolderPlus />Change folder</button></> : <div className="project-dialog-folder-empty"><p>Add a folder on this computer</p><Button type="button" variant="ghost" disabled={busy} onClick={() => void chooseFolder()} aria-label="Add source folder"><FolderPlus />Add</Button></div>}</div>
      </section>
      {folder && <p className="settings-notice">This folder becomes searchable automatically. Manage or pause indexing in Settings → Personalization.</p>}
      {!project && <div className="project-dialog-tip"><Lightbulb aria-hidden="true" /><p>Projects keep chats, files, and custom instructions in one place. Use them for ongoing work, or just to keep things tidy.</p></div>}
      {error && <p role="alert" className="project-dialog-error">{error}</p>}
      <div className="project-dialog-actions">
        {project && remove ? <Button type="button" variant="ghost" className="project-dialog-remove" disabled={busy} onClick={() => { setBusy(true); void remove().then(close).catch(cause => { setError(cause instanceof Error ? cause.message : 'The project could not be removed.'); }).finally(() => setBusy(false)); }}>Remove local project</Button> : options}
        <div>{project && <Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button>}<Button type="submit" variant="pill" disabled={busy || !name.trim()}>{busy ? 'Saving…' : project ? 'Save' : 'Create project'}</Button></div>
      </div>
    </form></ScrollArea>
  </Dialog>;
}
