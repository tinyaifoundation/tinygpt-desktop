import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { defaultBotConfiguration, type BotConfiguration, type BotNote, type BotJob } from '../../shared/bot';
import type { DesktopBridge } from '../../shared/contracts';
import { BotAccessSettings } from './BotAccessSettings';
import { SettingsButton as Button } from './ui/settings-button';
import { SettingsSelect } from './ui/settings-select';
import { ScrollArea } from './ui/scroll-area';

function BotNoteEditor(props: ComponentProps<'textarea'>) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = textarea.current; if (!field) return;
    const fit = () => { field.style.height = 'auto'; field.style.height = `${Math.max(256, field.scrollHeight)}px`; };
    fit(); let width = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => { const next = field.getBoundingClientRect().width; if (next !== width) { width = next; fit(); } });
    observer.observe(field); return () => observer.disconnect();
  }, [props.value]);
  return <ScrollArea className="bot-note-scroll" viewportClassName="settings-scroll-viewport"><textarea {...props} ref={textarea} className="bot-note-editor" /></ScrollArea>;
}

export function BotSettings({ bridge }: { bridge: DesktopBridge }) {
  const [draft, setDraft] = useState<BotConfiguration>({ ...defaultBotConfiguration });
  const [notes, setNotes] = useState<BotNote[]>([]); const [file, setFile] = useState<BotNote['file']>('SOUL.md'); const [text, setText] = useState('');
  const [jobs, setJobs] = useState<BotJob[]>([]); const [backgroundEnabled, setBackgroundEnabled] = useState(false);
  const [busy, setBusy] = useState(true); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  useEffect(() => { let alive = true; void bridge.botSnapshot().then(result => { if (!alive) return; if (result.ok) { setDraft(result.value.configuration ?? defaultBotConfiguration); setBackgroundEnabled(!!result.value.configuration?.background); } else setError(result.error); setBusy(false); }, () => { if (alive) { setError('Bot settings could not be loaded.'); setBusy(false); } }); return () => { alive = false; }; }, [bridge]);
  useEffect(() => { if (!backgroundEnabled) return; let alive = true; void bridge.botJobs().then(result => { if (!alive) return; if (result.ok) setJobs(result.value); else setError(result.error); }, () => { if (alive) setError('Background tasks could not be loaded.'); }); return () => { alive = false; }; }, [bridge, backgroundEnabled]);
  useEffect(() => { let alive = true; void bridge.botNotes().then(result => { if (!alive) return; if (result.ok) { setNotes(result.value); setText(result.value.find(note => note.file === 'SOUL.md')?.text ?? ''); } else setError(result.error); }, () => { if (alive) setError('Bot notes could not be loaded.'); }); return () => { alive = false; }; }, [bridge]);
  async function save() { setBusy(true); setError(''); setSaved(false); try { const result = await bridge.configureBot(draft); if (!result.ok) throw Error(result.error); setDraft(result.value.configuration ?? draft); setBackgroundEnabled(!!result.value.configuration?.background); setSaved(true); } catch (error) { setError(error instanceof Error ? error.message : 'Bot settings could not be saved.'); } finally { setBusy(false); } }
  async function changeJob(id?: string, action?: 'pause' | 'resume' | 'remove') { setBusy(true); setError(''); try { const result = id && action ? await bridge.changeBotJob({ id, action }) : await bridge.botJobs(); if (!result.ok) throw Error(result.error); setJobs(result.value); } catch (error) { setError(error instanceof Error ? error.message : 'This task could not be updated.'); } finally { setBusy(false); } }
  async function saveNote() { setBusy(true); setError(''); setSaved(false); try { const result = await bridge.saveBotNote({ file, text }); if (!result.ok) throw Error(result.error); setNotes(result.value); setSaved(true); } catch (error) { setError(error instanceof Error ? error.message : 'This note could not be saved.'); } finally { setBusy(false); } }
  const note = notes.find(note => note.file === file);
  return <><section className="settings-content-group"><h2>Access and memory</h2><BotAccessSettings value={draft} change={value => { setDraft(value); setSaved(false); }} busy={busy} /><div className="mt-5 flex items-center gap-3"><Button disabled={busy} onClick={() => void save()}>{busy ? 'Getting ready…' : 'Save changes'}</Button>{saved && <span role="status" className="text-sm text-muted-foreground">Saved</span>}</div></section>
    {!!notes.length && <section className="settings-content-group"><div className="mb-4 flex items-center justify-between gap-4"><h2>Personalization</h2><SettingsSelect aria-label="Bot personalization" value={file} disabled={busy} onChange={event => { const next = event.target.value as BotNote['file']; setFile(next); setText(notes.find(note => note.file === next)?.text ?? ''); setSaved(false); }}>{([['SOUL.md', 'Personality'], ['USER.md', 'About you'], ['AGENTS.md', 'Instructions'], ['MEMORY.md', 'Notes']] as const).map(([file, label]) => <option value={file} key={file}>{label}</option>)}</SettingsSelect></div><BotNoteEditor aria-label="Bot personalization text" maxLength={32000} value={text} disabled={busy || !note?.editable} onChange={event => { setText(event.target.value); setSaved(false); }} /><div className="mt-4"><Button disabled={busy || !note?.editable || text === note.text} onClick={() => void saveNote()}>Save personalization</Button></div>{!note?.editable && <p className="mt-3 text-sm text-muted-foreground">This note is too large to edit here.</p>}</section>}
    {backgroundEnabled && <section className="settings-content-group"><div className="mb-4 flex items-center justify-between gap-4"><h2>Things your bot is keeping an eye on</h2><Button disabled={busy} onClick={() => void changeJob()}>Refresh</Button></div><ScrollArea className="settings-card bot-jobs-scroll" viewportClassName="bot-jobs-viewport settings-scroll-viewport">{jobs.length ? jobs.map(job => <div key={job.id} className="settings-row"><div><div className="settings-row-title">{job.name}</div><p>{!job.enabled ? 'Paused' : job.nextRunAt ? `Next: ${new Date(job.nextRunAt).toLocaleString()}` : 'Waiting for its next run'}</p></div><div className="flex shrink-0 gap-2"><Button disabled={busy} onClick={() => void changeJob(job.id, job.enabled ? 'pause' : 'resume')}>{job.enabled ? 'Pause' : 'Resume'}</Button><Button disabled={busy} onClick={() => void changeJob(job.id, 'remove')}>Remove</Button></div></div>) : <p className="p-4 text-sm text-muted-foreground">Your bot can keep an eye on interests and commitments from your conversation.</p>}</ScrollArea></section>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}</>;
}
