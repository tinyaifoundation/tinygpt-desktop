import { randomUUID } from 'node:crypto';

type Result = { exitCode: number | null; output: string; truncated: boolean; timedOut: boolean };
interface Job { id: string; conversationId: string; runId: string; controller: AbortController; running: boolean; output: string; result?: Result; error?: string; done: Promise<void> }
/** Managed children belong to a conversation/run, and never survive its cancellation. */
export class WorkCommandJobs {
  private jobs = new Map<string, Job>();
  start(conversationId: string, runId: string, signal: AbortSignal, execute: (signal: AbortSignal, output: (text: string) => void) => Promise<Result>) {
    signal.throwIfAborted();
    if ([...this.jobs.values()].filter(j => j.running && j.conversationId === conversationId).length >= 4) throw Error('Four commands are already running. Check or stop one before starting another.');
    // Completed jobs are bounded but remain available for subsequent observations.
    for (const job of this.jobs.values()) { if (this.jobs.size < 100) break; if (!job.running) this.jobs.delete(job.id); }
    const controller = new AbortController(); const id = randomUUID();
    const job: Job = { id, conversationId, runId, controller, running: true, output: '', done: Promise.resolve() }; this.jobs.set(id, job);
    job.done = execute(AbortSignal.any([signal, controller.signal]), text => { job.output = text.slice(0, 24000); }).then(result => { job.result = result; }, () => { job.error = 'The command stopped before a result was confirmed. Inspect its effects before retrying.'; }).finally(() => { job.running = false; });
    return this.status(conversationId, id);
  }
  private owned(conversationId: string, id: string) { const job = this.jobs.get(id); if (!job || job.conversationId !== conversationId) throw Error('This command job is not available to this conversation. It may have ended when the app closed. Check its outcome before retrying.'); return job; }
  status(conversationId: string, id: string) {
    const job = this.owned(conversationId, id);
    return { jobId: id, running: job.running, output: job.output, ...(job.result ?? {}), ...(job.error ? { error: job.error, code: 'OUTCOME_UNKNOWN' } : {}) };
  }
  async observe(conversationId: string, id: string, waitSeconds: number, signal: AbortSignal) {
    const job = this.owned(conversationId, id); signal.throwIfAborted();
    if (job.running && waitSeconds) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, waitSeconds * 1000); signal.addEventListener('abort', finish, { once: true }); void job.done.then(finish);
    });
    signal.throwIfAborted(); return this.status(conversationId, id);
  }
  async stop(conversationId: string, id: string) { const job = this.owned(conversationId, id); job.controller.abort(); await job.done; return this.status(conversationId, id); }
  async endRun(runId: string) { const jobs = [...this.jobs.values()].filter(job => job.runId === runId && job.running); jobs.forEach(job => job.controller.abort()); await Promise.all(jobs.map(job => job.done)); }
  async shutdown() { this.jobs.forEach(job => job.controller.abort()); await Promise.all([...this.jobs.values()].map(job => job.done)); this.jobs.clear(); }
}
