import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { nextOccurrence } from '../core/scheduled';
import { scheduledInputSchema, type ScheduledInput, type ScheduledJob, type ScheduledRun } from '../shared/scheduled';

export class ScheduledStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,due_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(job_id,due_at));
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    for (const run of this.runs()) if (run.status === 'running') this.finish(run.id, 'interrupted', 'TinyGPT closed during this run. Review its results before running again.');
  }
  jobs(owner?: ScheduledJob['owner']): ScheduledJob[] { return this.db.prepare('SELECT data FROM jobs').all().map(row => JSON.parse(String(row.data)) as ScheduledJob).filter(job => !owner || job.owner === owner).sort((a,b) => a.createdAt - b.createdAt); }
  get(id: string): ScheduledJob { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); if (!row) throw Error('This scheduled task no longer exists.'); return JSON.parse(String(row.data)); }
  save(raw: ScheduledInput, owner: ScheduledJob['owner'] = 'user', now = Date.now()): ScheduledJob {
    const input = scheduledInputSchema.parse(raw), old = input.id ? this.get(input.id) : undefined;
    if (old && (old.owner !== owner || input.revision !== old.revision)) throw Error('This task changed. Reopen it before saving.');
    if (!old && this.jobs(owner).length >= 100) throw Error('Keep up to 100 tasks. Remove an unused task first.');
    const nextRunAt = input.enabled ? nextOccurrence(input.schedule, now) : null;
    if (input.enabled && nextRunAt === null) throw Error('Choose a future time.');
    const job: ScheduledJob = { ...input, id: old?.id ?? randomUUID(), revision: (old?.revision ?? -1) + 1, owner, conversationId: old?.conversationId ?? null, nextRunAt, createdAt: old?.createdAt ?? now, updatedAt: now };
    this.put(job); return job;
  }
  private put(job: ScheduledJob) { this.db.prepare('INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(job)); }
  remove(id: string) { this.get(id); this.db.prepare('DELETE FROM jobs WHERE id=?').run(id); }
  enabled(id: string, enabled: boolean, now = Date.now()) { const job = this.get(id); return this.save({ ...this.input(job), enabled }, job.owner, now); }
  input(job: ScheduledJob): ScheduledInput { const { id, revision, title, prompt, schedule, enabled, newChat, mode } = job; return { id, revision, title, prompt, schedule, enabled, newChat, mode }; }
  runs(): ScheduledRun[] { return this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC LIMIT 300').all().map(row => JSON.parse(String(row.data))); }
  conversationIds(): string[] { return this.db.prepare("SELECT json_extract(data,'$.conversationId') AS id FROM jobs UNION SELECT json_extract(data,'$.conversationId') AS id FROM runs").all().flatMap(row => typeof row.id === 'string' ? [row.id] : []); }
  claim(id: string, now = Date.now(), manual = false): ScheduledRun | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.get(id), dueAt = manual ? now : job.nextRunAt;
      if (!manual && (!job.enabled || dueAt === null || dueAt > now)) { this.db.exec('COMMIT'); return; }
      if (this.runs().some(run => run.jobId === id && run.status === 'running')) { this.db.exec('COMMIT'); return; }
      const run: ScheduledRun = { id: randomUUID(), jobId: id, dueAt: dueAt!, startedAt: now, finishedAt: null, status: 'running', conversationId: null, error: null, summary: '' };
      const inserted = this.db.prepare('INSERT OR IGNORE INTO runs VALUES(?,?,?,?)').run(run.id, id, dueAt!, JSON.stringify(run));
      if (!manual && inserted.changes) {
        job.nextRunAt = nextOccurrence(job.schedule, now); job.enabled = job.nextRunAt !== null; job.revision++; this.put(job);
      }
      this.db.exec('COMMIT'); return inserted.changes ? run : undefined;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  attach(run: ScheduledRun, conversationId: string) {
    run.conversationId = conversationId; this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id);
    try { const job = this.get(run.jobId); job.conversationId = conversationId; this.put(job); } catch { /* A removed task does not own future runs. */ }
  }
  finish(id: string, status: ScheduledRun['status'], error: string | null = null, summary = '') {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id); if (!row) return;
    const run: ScheduledRun = JSON.parse(String(row.data)); Object.assign(run, { status, error, summary: summary.slice(0,2000), finishedAt: Date.now() });
    this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), id);
    this.db.prepare("DELETE FROM runs WHERE id IN (SELECT id FROM runs ORDER BY rowid DESC LIMIT -1 OFFSET 1000)").run();
  }
  complete(id: string, text: string, queueBotDelivery: boolean) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.finish(id,'complete',null,text);
      let queued = false;
      if (queueBotDelivery && text.trim()) {
        const run = this.db.prepare('SELECT job_id FROM runs WHERE id=?').get(id)!;
        const fingerprint = createHash('sha256').update(text.trim().replace(/\s+/g,' ')).digest('hex'), key = `last-message:${run.job_id}`;
        if (this.metadata(key) !== fingerprint) {
          const queue = JSON.parse(this.metadata('bot-deliveries') ?? '[]') as { runId: string; text: string }[];
          if (!queue.some(item => item.runId === id)) queue.push({ runId: id,text });
          this.setMetadata('bot-deliveries',JSON.stringify(queue)); this.setMetadata(key,fingerprint); queued = true;
        }
      }
      this.db.exec('COMMIT'); return queued;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  metadata(key: string): string | undefined { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value as string | undefined; }
  setMetadata(key: string, value: string) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value); }
  close() { this.db.close(); }
}
