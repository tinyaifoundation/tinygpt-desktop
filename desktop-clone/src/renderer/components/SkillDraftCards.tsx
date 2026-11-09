import { useEffect, useState } from 'react';
import { BookOpen, Check } from '../icons';
import { z } from 'zod';
import type { DesktopBridge } from '../../shared/contracts';
import type { ToolActivity } from '../../shared/tools';
import type { SkillHubSnapshot } from '../../shared/plugins';
import type { ChatProject } from '../../shared/chat';
import { SkillReviewDialog } from './SkillReviewDialog';
import { Button } from './ui/button';

const resultSchema = z.object({ type: z.literal('skill-draft'), draftId: z.uuid() });
export function SkillDraftCards({ tools, bridge }: { tools: ToolActivity[]; bridge: DesktopBridge }) {
  const ids = tools.filter(tool => tool.name === 'draft_skill' && tool.status === 'success').flatMap(tool => { try { const result = resultSchema.safeParse(JSON.parse(tool.result ?? 'null')); return result.success ? [result.data.draftId] : []; } catch { return []; } });
  const key = ids.join('|'); const [hub, setHub] = useState<SkillHubSnapshot | null>(null); const [projects, setProjects] = useState<ChatProject[]>([]); const [reviewId, setReviewId] = useState<string | null>(null); const [error, setError] = useState('');
  const load = () => { void bridge.skills().then(result => { if (result.ok) setHub(result.value); else setError(result.error); }); };
  useEffect(() => { if (!key) return; let alive = true; const refresh = () => { void bridge.skills().then(result => { if (alive && result.ok) setHub(result.value); }); }; refresh(); const unsubscribe = bridge.onPluginsUpdate(refresh); return () => { alive = false; unsubscribe(); }; }, [bridge, key]);
  if (!ids.length) return null;
  const drafts = hub?.drafts.filter(draft => ids.includes(draft.id)) ?? [];
  const review = drafts.find(draft => draft.id === reviewId);
  return <div className="skill-draft-cards">{drafts.map(draft => <div className="plugin-connection-card" key={draft.id}><BookOpen /><div className="plugin-connection-card-label"><strong>{draft.skill.name}</strong><small>{draft.installedPluginId ? 'Added to your Skills library' : draft.skill.description}</small></div>{draft.installedPluginId ? <Check aria-label="Skill added" /> : <Button size="sm" variant="outline" onClick={() => { setError(''); void bridge.library().then(result => { if (result.ok) { setProjects(result.value.projects); setReviewId(draft.id); } else setError(result.error); }); }}>Review skill</Button>}</div>)}{error && <p role="alert">{error}</p>}{review && <SkillReviewDialog key={review.id} draft={review} bridge={bridge} projects={projects} close={() => setReviewId(null)} changed={value => { if (value) setHub(value); else load(); }} />}</div>;
}
