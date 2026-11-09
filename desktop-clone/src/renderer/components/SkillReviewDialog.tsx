import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { ChatProject } from '../../shared/chat';
import type { SkillDraft, SkillHubSnapshot, PluginConfig } from '../../shared/plugins';
import { DialogRoot, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { SettingsButton as Button } from './ui/settings-button';
import { Input } from './ui/input';
import { SettingsSelect } from './ui/settings-select';
import { SkillSourcePanel } from './SkillSourcePanel';

export function SkillReviewDialog({ draft, bridge, projects, changed, close }: { draft: SkillDraft; bridge: DesktopBridge; projects: ChatProject[]; changed: (hub?: SkillHubSnapshot) => void; close: () => void }) {
  const [editing, setEditing] = useState(false); const [instructions, setInstructions] = useState(draft.skill.instructions); const [description, setDescription] = useState(draft.skill.description);
  const [scope, setScope] = useState(draft.projectId ?? 'all'); const [invocation, setInvocation] = useState<'automatic' | 'manual'>('automatic'); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [targetConfig, setTargetConfig] = useState<PluginConfig | null>(null);
  useEffect(() => { if (!draft.targetPluginId) return; let alive = true; void bridge.skills().then(result => { if (!alive) return; if (!result.ok) { setError(result.error); return; } const entry = result.value.entries.find(item => item.id === draft.targetPluginId); if (!entry) { setError('The original skill is unavailable.'); return; } setTargetConfig(entry.config); setScope('keep'); setInvocation(entry.config.skillInvocation?.[draft.skill.name] ?? 'automatic'); }); return () => { alive = false; }; }, [bridge, draft.targetPluginId, draft.skill.name]);
  async function saveEdit() {
    setBusy(true); setError('');
    try { const markdown = `---\nname: ${JSON.stringify(draft.skill.name)}\ndescription: ${JSON.stringify(description)}\n${draft.skill.license ? `license: ${JSON.stringify(draft.skill.license)}\n` : ''}${draft.skill.compatibility ? `compatibility: ${JSON.stringify(draft.skill.compatibility)}\n` : ''}---\n${instructions}`;
      const result = await bridge.draftSkill({ draftId: draft.id, markdown, references: draft.skill.references, sourceUrl: draft.skill.sourceUrl, modes: draft.modes, targetPluginId: draft.targetPluginId }); if (!result.ok) throw new Error(result.error); changed(result.value); setEditing(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The draft could not be saved.'); } finally { setBusy(false); }
  }
  async function add() { setBusy(true); setError(''); try {
    const projectIds = scope === 'keep' ? targetConfig!.projectIds : scope === 'all' ? null : [scope];
    const result = await bridge.installDraftSkill(draft.id, { ...(targetConfig ?? { enabled: true, rules: {}, resources: [] }), projectIds, skillInvocation: { ...targetConfig?.skillInvocation, [draft.skill.name]: invocation } }); if (!result.ok) throw new Error(result.error);
    const installed = (await bridge.skills()); const entry = installed.ok ? installed.value.entries.find(item => item.manifest.skills.some(skill => skill.name === draft.skill.name) && (item.id === draft.targetPluginId || item.manifest.id === `custom-${draft.id}`)) : undefined;
    if (entry?.config.enabled && invocation === 'automatic') { const selected = await bridge.pluginSelection(draft.conversationId, draft.projectId); if (selected.ok && (projectIds === null || draft.projectId && projectIds.includes(draft.projectId))) await bridge.selectPlugins(draft.conversationId, draft.projectId, [...new Set([...selected.value, entry.id])]); }
    changed(); close();
  } catch (cause) { setError(cause instanceof Error ? cause.message : 'The skill could not be added.'); } finally { setBusy(false); } }
  return <DialogRoot open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="skill-review-dialog"><DialogHeader><DialogTitle>{draft.targetPluginId ? 'Review skill update' : 'Review skill'}</DialogTitle><DialogDescription>Review the workflow before adding it. Its instructions do not grant tool or account access.</DialogDescription></DialogHeader><div className="skill-review-content"><SkillSourcePanel skill={draft.skill} bridge={bridge} /><h3>{draft.skill.name}</h3>{editing ? <><label>Description<Input aria-label="Skill draft description" value={description} onChange={event => setDescription(event.target.value)} maxLength={4000} /></label><label>Instructions<textarea aria-label="Skill draft instructions" value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={64000} /></label><Button disabled={busy || !instructions.trim() || !description.trim()} onClick={() => void saveEdit()}>Save draft changes</Button></> : <><p>{draft.skill.description}</p><pre>{draft.skill.instructions}</pre><Button variant="muted" disabled={busy || !!draft.installedPluginId} onClick={() => setEditing(true)}>Edit draft</Button></>}
    {!!Object.keys(draft.skill.references).length && <details><summary>Packaged references</summary>{Object.entries(draft.skill.references).map(([path, text]) => <details key={path}><summary>{path}</summary><pre>{text}</pre></details>)}</details>}
    <p>{draft.skill.publisher} · {draft.modes.join(', ')}{draft.skill.license ? ` · ${draft.skill.license}` : ''}</p>{draft.skill.sourceUrl && <p className="skill-source">Reference: {draft.skill.sourceUrl}</p>}{draft.skill.compatibility && <p>{draft.skill.compatibility}</p>}
    <label>Availability<SettingsSelect aria-label="Skill draft availability" value={scope} onChange={event => setScope(event.target.value)}>{targetConfig && <option value="keep">Keep current availability</option>}<option value="all">All Projects and personal chats</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</SettingsSelect></label>
    <label>Activation<SettingsSelect aria-label="Skill draft activation" value={invocation} onChange={event => setInvocation(event.target.value as 'automatic' | 'manual')}><option value="automatic">Automatically when relevant</option><option value="manual">Only when I choose it</option></SettingsSelect></label>{error && <p role="alert">{error}</p>}</div><DialogFooter><Button variant="muted" disabled={busy} onClick={close}>Close</Button><Button disabled={busy || editing || !!draft.installedPluginId || !!draft.targetPluginId && !targetConfig} onClick={() => void add()}>{draft.installedPluginId ? 'Added' : draft.targetPluginId ? 'Update skill' : 'Add skill'}</Button></DialogFooter></DialogContent></DialogRoot>;
}
