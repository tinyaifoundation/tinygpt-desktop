import { useEffect, useRef } from 'react';
import { ArrowLeft, BookOpen, Check, LoaderCircle, Plus } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { LibrarySnapshot } from '../../shared/chat';
import type { CatalogSkill, PluginSkill, PluginView } from '../../shared/plugins';
import { SkillMakerAvatar } from './SkillCatalog';
import { SkillSourcePanel } from './SkillSourcePanel';
import { SettingsButton as Button } from './ui/settings-button';
import { SettingsSelect } from './ui/settings-select';

export function SkillDetail({ title, skill, catalog, entry, bridge, library, pending, error, canUse, unavailableReason, back, add, use, configure, repair, edit }: {
  title: string; skill: PluginSkill; catalog?: CatalogSkill; entry?: PluginView; bridge: DesktopBridge; library: LibrarySnapshot; pending: boolean; error: string; canUse: boolean; unavailableReason?: string;
  back: () => void; add: () => void; use: () => void; configure: (config: PluginView['config']) => void; repair: () => void; edit: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [skill.name]);
  const modes = entry?.manifest.modes ?? catalog?.modes ?? [], license = skill.upstream?.source.license ?? skill.license;
  return <div className="connector-detail skill-detail" aria-label={`${title} skill details`}>
    <Button className="connector-detail-back" variant="ghost" onClick={back} aria-label="Back to skills"><ArrowLeft />Back to skills</Button>
    <span className="connector-detail-logo skill-detail-logo">{skill.upstream ? <SkillMakerAvatar maker={skill.upstream.maker} /> : <BookOpen />}</span>
    <header className="connector-detail-title skill-detail-title"><div><h1 ref={heading} tabIndex={-1}>{title}</h1><p>{skill.description}</p></div><div className="connector-detail-actions">
      {entry ? <Button disabled={pending || !canUse} title={unavailableReason} onClick={use}>Use skill</Button> : catalog && <Button disabled={pending} onClick={add}>{pending ? <LoaderCircle className="animate-spin" /> : <Plus />}{pending ? 'Adding…' : 'Add skill'}</Button>}
    </div></header>
    {error && <p role="alert" className="plugin-library-error">{error}</p>}
    <div className="skill-detail-badges">{catalog && <span>{catalog.category}</span>}{modes.map(mode => <span key={mode}>{mode === 'chat' ? 'Chat' : mode === 'code' ? 'Code' : 'Bot'}</span>)}{entry && <span><Check />{entry.config.enabled ? 'Installed' : 'Disabled'}</span>}</div>
    <section className="connector-detail-section"><h2>Information</h2><dl><dt>Maker</dt><dd>{skill.publisher ?? (entry?.manifest.kind === 'builtin' ? 'TinyGPT' : 'Imported skill')}</dd><dt>Skill</dt><dd>{skill.name}</dd><dt>Version</dt><dd>{entry?.manifest.version ?? catalog?.version ?? '1.0.0'}</dd><dt>License</dt><dd>{license ?? 'No license supplied'}</dd>{catalog && <><dt>Repository stars</dt><dd>{catalog.popularity.repositoryStars.toLocaleString()} · checked {new Date(catalog.popularity.checkedAt).toLocaleDateString()}</dd></>}{skill.compatibility && <><dt>Compatibility</dt><dd>{skill.compatibility}</dd></>}</dl></section>
    {!!skill.requirements?.length && <section className="connector-detail-section"><h2>Requirements</h2><ul className="skill-detail-requirements">{skill.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul></section>}
    {skill.upstream ? <section className="connector-detail-section"><h2>Source and package</h2><SkillSourcePanel skill={skill} bridge={bridge} /></section> : skill.sourceUrl && <section className="connector-detail-section"><h2>Source</h2><Button variant="muted" onClick={() => void bridge.openBrowserLink(skill.sourceUrl!)}>View original skill</Button></section>}
    {entry && <section className="connector-detail-section"><h2>Settings</h2><div className="skill-detail-settings">
      <label>Activation<SettingsSelect aria-label={`Activation for ${skill.name}`} value={entry.config.skillInvocation?.[skill.name] ?? 'automatic'} disabled={pending} onChange={event => configure({ ...entry.config, skillInvocation: { ...entry.config.skillInvocation, [skill.name]: event.target.value as 'automatic' | 'manual' } })}><option value="automatic">Automatic</option><option value="manual">Only when chosen</option></SettingsSelect></label>
      <label>Availability<SettingsSelect aria-label="Installed skill availability" disabled={pending} value={entry.config.projectIds === null ? 'all' : entry.config.projectIds[0] ?? ''} onChange={event => configure({ ...entry.config, projectIds: event.target.value === 'all' ? null : [event.target.value] })}><option value="all">All Projects and personal chats</option>{entry.config.projectIds?.length === 0 && <option value="" disabled>No Projects selected</option>}{library.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</SettingsSelect></label>
    </div><div className="skill-detail-manage"><Button variant="muted" disabled={pending} onClick={() => configure({ ...entry.config, enabled: !entry.config.enabled })}>{entry.config.enabled ? 'Disable' : 'Enable'}</Button>{entry.manifest.kind === 'skill' && <><Button variant="muted" disabled={pending} onClick={edit}>Edit a draft</Button>{skill.upstream && <Button variant="muted" disabled={pending} onClick={repair}>Repair package</Button>}</>}</div>{unavailableReason && <p>{unavailableReason}</p>}</section>}
    <section className="connector-detail-section skill-detail-instructions"><h2>Instructions</h2><pre>{skill.instructions}</pre></section>
    {!!Object.keys(skill.references).length && <section className="connector-detail-section skill-detail-instructions"><h2>References</h2>{Object.entries(skill.references).map(([path, text]) => <details key={path}><summary>{path}</summary><pre>{text}</pre></details>)}</section>}
  </div>;
}
