import { useEffect, useState } from 'react';
import { Plus, RefreshCw, ChevronDown, MoreHorizontal, MessageCircle } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { ScheduledInput, ScheduledJob, ScheduledSnapshot, ScheduleSuggestion } from '../../shared/scheduled';
import { scheduleSuggestionCount } from '../../shared/scheduled';
import { scheduleLabel } from '../../core/scheduled';
import { Dialog } from './ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from './ui/dropdown-menu';
import { Button } from './ui/button';
import { SettingsSelect } from './ui/settings-select';
import { Switch } from './AppearanceSettings';
import { ScrollArea } from './ui/scroll-area';
import '../scheduled.css';

const initial: ScheduledSnapshot = { jobs: [], runs: [], suggestions: [], generating: false };
export function Scheduled({ bridge, openConversation, focusJobId, jobFocused }: { bridge: DesktopBridge; openConversation: (id: string) => void; focusJobId?: string | null; jobFocused?: () => void }) {
  const [snapshot,setSnapshot] = useState(initial), [loaded,setLoaded] = useState(false), [error,setError] = useState(''), [ideasLoading,setIdeasLoading] = useState(true);
  const [editor,setEditor] = useState<{ job?: ScheduledJob; suggestion?: ScheduleSuggestion } | null>(null), [pending,setPending] = useState<string | null>(null);
  const [historyJobId,setHistoryJobId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const unsubscribe = bridge.onScheduledUpdate(value => { if (alive) setSnapshot(value); });
    void bridge.scheduledSnapshot().then(result => { if (!alive) return; setLoaded(true); if (result.ok) setSnapshot(result.value); else setError(result.error); });
    void bridge.scheduleSuggestions().then(result => { if (alive && result.ok) setSnapshot(result.value); }).finally(() => { if (alive) setIdeasLoading(false); });
    return () => { alive = false; unsubscribe(); };
  },[bridge]);
  useEffect(() => {
    if (!focusJobId || !loaded) return;
    const card = document.getElementById(`scheduled-job-${focusJobId}`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest' });
    card.querySelector<HTMLButtonElement>('.scheduled-job-title')?.focus({ preventScroll: true });
    jobFocused?.();
  },[focusJobId,loaded,snapshot.jobs,jobFocused]);
  async function action(id: string, action: 'pause' | 'resume' | 'remove' | 'run' | 'stop') { setError(''); setPending(id); try { const result = await bridge.scheduledAction({ id,action }); if (!result.ok) throw Error(result.error); setSnapshot(result.value); } catch (error) { setError(error instanceof Error ? error.message : 'This task could not be updated.'); } finally { setPending(null); } }
  async function refresh() { setSnapshot(value => ({ ...value, generating: true })); const result = await bridge.scheduleSuggestions(true); if (result.ok) setSnapshot(result.value); else { setSnapshot(value => ({ ...value,generating: false })); setError(result.error); } }
  const empty = !snapshot.jobs.length;
  return <section className="conversation-pane scheduled-page" aria-label="Scheduled">
    <header className="scheduled-header"><h1>Scheduled</h1><Button variant="pill" onClick={() => setEditor({})}><Plus size={16} />New task</Button></header>
    <ScrollArea className="scheduled-scroll" viewportClassName="scheduled-viewport"><div className={`scheduled-inner ${empty ? 'is-empty' : ''}`}>
      {error && <p role="alert" className="scheduled-error">{error}</p>}
      {!loaded ? <SuggestionSkeleton /> : <>
        {!empty && <div className="scheduled-jobs">{[true,false].map(enabled => {
          const jobs = snapshot.jobs.filter(job => job.enabled === enabled);
          return !!jobs.length && <section className="scheduled-job-group" key={String(enabled)} aria-label={enabled ? 'Active tasks' : 'Paused tasks'}><h2>{enabled ? 'Active' : 'Paused'}</h2>{jobs.map(job => {
            const runs = snapshot.runs.filter(run => run.jobId === job.id), last = runs[0], running = last?.status === 'running';
            return <article className="scheduled-job" id={`scheduled-job-${job.id}`} key={job.id}>
              <div className="scheduled-job-copy"><button className="scheduled-job-title" onClick={() => setEditor({ job })}>{job.title}</button><p className="scheduled-job-time" title={scheduleLabel(job.schedule)}>{taskTime(job)}{running ? ' · Running' : ''}</p></div>
              <DropdownMenu modal={false}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="scheduled-job-menu" aria-label={`Options for ${job.title}`} disabled={pending === job.id}><MoreHorizontal size={18} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" aria-label={`Task actions for ${job.title}`}>
                <DropdownMenuItem onSelect={() => void action(job.id,running ? 'stop' : 'run')}>{running ? 'Stop' : 'Run now'}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void action(job.id,job.enabled ? 'pause' : 'resume')}>{job.enabled ? 'Pause' : 'Resume'}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEditor({ job })}>Edit</DropdownMenuItem>
                <DropdownMenuItem disabled={!last?.conversationId} onSelect={() => last?.conversationId && openConversation(last.conversationId)}>Open latest chat</DropdownMenuItem>
                <DropdownMenuItem disabled={!runs.length} onSelect={() => setHistoryJobId(job.id)}>Run history</DropdownMenuItem>
                <DropdownMenuSeparator className="menu-separator" /><DropdownMenuItem className="text-destructive" disabled={running} onSelect={() => { if (window.confirm(`Remove “${job.title}”? Saved conversations will be kept.`)) void action(job.id,'remove'); }}>Remove</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>
            </article>;
          })}</section>;
        })}</div>}
        <div className="scheduled-ideas"><div className="scheduled-introduction">{empty && <span className="scheduled-clock" aria-hidden="true">🕘</span>}<h2>{empty ? 'Schedule a task' : 'A little inspiration'}</h2><p>{empty ? 'Give TinyGPT something to take care of regularly.' : 'Ideas based on your conversations and available plugins.'}</p></div>
          {snapshot.generating || ideasLoading ? <SuggestionSkeleton /> : <div className="scheduled-suggestion-grid">{snapshot.suggestions.map((suggestion,index) => <button key={index} className="scheduled-suggestion" onClick={() => setEditor({ suggestion })}><span className="scheduled-suggestion-emoji" aria-hidden="true">{suggestion.emoji}</span><span><strong>{suggestion.title}</strong><small>{suggestion.description}</small></span></button>)}</div>}
          {snapshot.suggestionError && <p className="scheduled-suggestions-status">{snapshot.suggestionError}</p>}
          <div className="scheduled-ideas-actions">{empty && <Button variant="pill" onClick={() => setEditor({})}><Plus size={15} />Create your own</Button>}<button disabled={snapshot.generating} onClick={() => void refresh()}><RefreshCw size={14} />{snapshot.suggestions.length ? 'Refresh ideas' : 'Suggest tasks'}</button></div>
        </div>
      </>}
    </div></ScrollArea>
    {historyJobId && <Dialog open change={open => { if (!open) setHistoryJobId(null); }} title={`Run history · ${snapshot.jobs.find(job => job.id === historyJobId)?.title ?? 'Task'}`} className="schedule-dialog"><div className="scheduled-history">{snapshot.runs.filter(run => run.jobId === historyJobId).map(run => <div className="scheduled-run" key={run.id}><div><span>{new Date(run.startedAt).toLocaleString()}</span><small>{run.status === 'complete' ? run.summary.slice(0,180) || 'Completed' : run.error ?? (run.status === 'running' ? 'Working…' : 'Stopped')}</small></div>{run.conversationId && <button onClick={() => openConversation(run.conversationId!)} aria-label="Open run results"><MessageCircle size={15} />Open chat</button>}</div>)}</div></Dialog>}
    {editor && <ScheduleEditor bridge={bridge} job={editor.job} suggestion={editor.suggestion} close={() => setEditor(null)} saved={() => { setEditor(null); void bridge.scheduledSnapshot().then(result => { if (result.ok) setSnapshot(result.value); }); }} />}
  </section>;
}

function taskTime(job: ScheduledJob) {
  const at = job.nextRunAt ?? job.schedule.at;
  if (!at) return scheduleLabel(job.schedule);
  const when = new Intl.DateTimeFormat([], { timeZone:job.schedule.timezone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit' }).format(at);
  const repeat = { once:'Once',hourly:'Hourly',daily:'Daily',weekdays:'Weekdays',weekly:'Weekly',interval:`Every ${job.schedule.minutes} minutes` }[job.schedule.repeat];
  return `${when} · ${repeat}`;
}

function SuggestionSkeleton() {
  return <div className="scheduled-suggestion-grid scheduled-skeleton-grid" role="status" aria-label="Loading task ideas">{Array.from({ length:scheduleSuggestionCount },(_,index) => <div className="scheduled-suggestion scheduled-suggestion-skeleton" aria-hidden="true" key={index}><span className="scheduled-skeleton-shape" /><span className="scheduled-skeleton-copy"><i /><i /><i /></span></div>)}</div>;
}

function ScheduleEditor({ bridge, job, suggestion, close, saved }: { bridge: DesktopBridge; job?: ScheduledJob; suggestion?: ScheduleSuggestion; close: () => void; saved: () => void }) {
  const [prompt,setPrompt] = useState(job?.prompt ?? suggestion?.prompt ?? ''), [title,setTitle] = useState(job?.title ?? suggestion?.title ?? '');
  const [repeat,setRepeat] = useState<ScheduledInput['schedule']['repeat']>(job?.schedule.repeat ?? suggestion?.repeat ?? 'daily'), [time,setTime] = useState(job?.schedule.time ?? '09:00'), [weekday,setWeekday] = useState(job?.schedule.weekday ?? 1);
  const localDate = (value: number) => { const date = new Date(value); return new Date(value - date.getTimezoneOffset() * 60000).toISOString().slice(0,16); };
  const [at,setAt] = useState(localDate(job?.schedule.at ?? Date.now() + 86400000)), [advanced,setAdvanced] = useState(false), [newChat,setNewChat] = useState(job?.newChat ?? false), [mode,setMode] = useState<'chat' | 'code'>(job?.mode ?? 'chat');
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(''); try {
    const result = await bridge.saveScheduled({ id: job?.id, revision: job?.revision, title: title.trim() || prompt.trim().split('\n')[0].slice(0,80), prompt, schedule: { repeat, time, weekday, timezone: job?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, minutes: job?.schedule.minutes ?? 60, ...(repeat === 'once' ? { at: new Date(at).getTime() } : {}) }, enabled: job?.enabled ?? true, newChat, mode });
    if (!result.ok) throw Error(result.error); saved();
  } catch (error) { setError(error instanceof Error ? error.message : 'Your task could not be saved.'); } finally { setBusy(false); } }
  return <Dialog open change={open => { if (!open && !busy) close(); }} title={job ? 'Edit task' : 'Schedule a task'} className="schedule-dialog" closeDisabled={busy}>
    <form onSubmit={event => void submit(event)}><textarea autoFocus className="schedule-instructions" aria-label="Task instructions" placeholder="Instructions…" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={32000} required disabled={busy} />
      <div className="schedule-fields"><label><span>Repeat</span><SettingsSelect aria-label="Repeat" value={repeat} disabled={busy} onChange={event => setRepeat(event.target.value as typeof repeat)}>{[['once','Once'],['hourly','Hourly'],['daily','Daily'],['weekdays','Weekdays'],['weekly','Weekly']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</SettingsSelect></label>
      {repeat === 'once' ? <label><span>Date and time</span><input aria-label="Date and time" type="datetime-local" value={at} onChange={event => setAt(event.target.value)} required /></label> : repeat !== 'hourly' && <label><span>Time</span><input aria-label="Time" type="time" value={time} onChange={event => setTime(event.target.value)} required /></label>}
      {repeat === 'weekly' && <label><span>Day</span><SettingsSelect aria-label="Day" value={weekday} onChange={event => setWeekday(Number(event.target.value))}>{['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index) => <option value={index} key={day}>{day}</option>)}</SettingsSelect></label>}</div>
      <button className="schedule-advanced-toggle" type="button" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>Advanced<ChevronDown size={15} className={advanced ? 'is-open' : ''} /></button>
      {advanced && <div className="schedule-fields schedule-advanced"><label><span>Name</span><input aria-label="Task name" value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="Optional" /></label><label><span>Start each run in a new chat</span><Switch label="Start each run in a new chat" value={newChat} change={setNewChat} /></label><label><span>Mode</span><SettingsSelect aria-label="Task mode" value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="chat">Chat</option><option value="code">Work</option></SettingsSelect></label></div>}
      <p className="schedule-footnote">Keep TinyGPT open for tasks to run on this computer. Tasks use your current model and selected plugins. Times use {job?.schedule.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}. Notifications follow your settings.</p>
      {error && <p className="scheduled-error" role="alert">{error}</p>}<div className="dialog-actions"><Button type="button" variant="ghost" onClick={close} disabled={busy}>Cancel</Button><Button type="submit" variant="pill" disabled={busy || !prompt.trim()}>{busy ? 'Saving…' : job ? 'Save' : 'Create'}</Button></div>
    </form>
  </Dialog>;
}
