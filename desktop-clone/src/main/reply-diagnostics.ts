import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { traceEventSchema, traceMetadataSchema, uiTraceSchema, type DiagnosticsSnapshot, type TraceEvent, type TraceMetadata, type TraceRecord, type TraceReport, type TraceStamp, type UiTrace } from '../shared/diagnostics';
import { traceMetrics, traceObservations } from '../core/trace-metrics';
import { GpuTelemetry } from './gpu-telemetry';
import type { NativePerformance } from '../shared/diagnostics';

const RETENTION_DAYS = 7; const MAX_RUNS = 200; const MAX_EVENTS = 10000;
type Live = { origin: number; sequence: number; stamps: Map<number, number>; stampId: number; uiAt: number; uiKey: string; uiVersion: number; local: boolean; running: boolean; requests: Map<string, { phase: 'connecting' | 'thinking'; purpose?: TraceEvent['purpose'] }> };
/** Separate, bounded, local-only diagnostics. Failure never stops a reply. */
export class ReplyDiagnostics {
  private db!: DatabaseSync; private closed = false; private enabled = true; readonly persistent: boolean;
  private live = new Map<string, Live>(); private pending: { runId: string; event: TraceRecord }[] = []; private timer?: ReturnType<typeof setTimeout>;
  private gpuTimer?: ReturnType<typeof setTimeout>; private gpuAbort?: AbortController; private gpuPending = false; private gpuEpoch = 0;
  private configurations = new Map<string, NativePerformance>();
  constructor(path: string, private now = () => Date.now(), private clock = () => performance.now(), private gpuTelemetry?: Pick<GpuTelemetry, 'sample'>) {
    try { this.db = new DatabaseSync(path); this.initialize(); this.persistent = path !== ':memory:'; }
    catch { try { this.db!.close(); } catch { /* Failed file connection. */ } this.db = new DatabaseSync(':memory:'); this.initialize(); this.persistent = false; }
  }
  private initialize(): void {
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS diagnostics_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reply_traces(run_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,metadata TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reply_trace_events(run_id TEXT NOT NULL REFERENCES reply_traces(run_id) ON DELETE CASCADE,sequence INTEGER NOT NULL,elapsed_ms REAL NOT NULL,data TEXT NOT NULL,PRIMARY KEY(run_id,sequence));`);
    this.enabled = this.db.prepare("SELECT value FROM diagnostics_meta WHERE key='enabled'").get()?.value !== 'false';
    this.db.prepare("UPDATE reply_traces SET status='interrupted' WHERE status='running'").run(); this.prune();
  }
  private prune() {
    this.db.prepare('DELETE FROM reply_traces WHERE started_at<?').run(this.now() - RETENTION_DAYS * 86400000);
    this.db.exec(`DELETE FROM reply_traces WHERE run_id IN (SELECT run_id FROM reply_traces ORDER BY started_at DESC,rowid DESC LIMIT -1 OFFSET ${MAX_RUNS})`);
    const retained = new Set(this.db.prepare('SELECT run_id FROM reply_traces').all().map(row => String(row.run_id)));
    for (const id of this.live.keys()) if (!retained.has(id)) this.live.delete(id);
  }
  begin(input: TraceMetadata): void {
    if (this.closed || !this.enabled) return; const meta = traceMetadataSchema.safeParse(input); if (!meta.success) return;
    try {
      this.flush(); const inserted = this.db.prepare("INSERT OR IGNORE INTO reply_traces VALUES(?,?,?,'running')").run(meta.data.runId, meta.data.startedAt, JSON.stringify(meta.data));
      if (!inserted.changes) return;
      this.live.set(meta.data.runId, { origin: this.clock() - Math.max(0, this.now() - meta.data.startedAt), sequence: 0, stamps: new Map(), stampId: 0, uiAt: -Infinity, uiKey: '', uiVersion: 0, local: meta.data.provider === 'local', running: true, requests: new Map() }); this.prune(); this.record(meta.data.runId, { event: 'run-start' });
      if (meta.data.provider === 'local') for (const metric of this.configurations.values()) this.record(meta.data.runId, { event: 'runtime-metric', nativePerformance: metric });
      this.ensureGpu();
    } catch { /* Observability cannot prevent inference. */ }
  }
  record(runId: string, input: TraceEvent): void {
    const run = this.live.get(runId); if (this.closed || !this.enabled || !run) return;
    const parsed = traceEventSchema.safeParse(input); if (!parsed.success) return;
    const terminal = ['run-complete', 'run-error', 'run-cancelled'].includes(parsed.data.event);
    // Reserve one slot for the terminal event, even on very noisy replies.
    if (run.sequence >= MAX_EVENTS || !terminal && run.sequence >= MAX_EVENTS - 1) return;
    if (parsed.data.requestId) {
      if (parsed.data.event === 'request-start') run.requests.set(parsed.data.requestId, { phase: 'connecting', purpose: parsed.data.purpose });
      if (parsed.data.event === 'prompt-progress' && parsed.data.inputTokens !== undefined && (parsed.data.cacheReadTokens ?? 0) + (parsed.data.promptProcessedTokens ?? 0) >= parsed.data.inputTokens) {
        const request = run.requests.get(parsed.data.requestId); if (request) request.phase = 'thinking';
      }
      if (['request-end', 'request-closed', 'request-cancelled', 'request-error'].includes(parsed.data.event)) run.requests.delete(parsed.data.requestId);
    }
    const elapsedMs = Math.max(0, this.clock() - run.origin); const event = { ...parsed.data, sequence: ++run.sequence, elapsedMs };
    this.pending.push({ runId, event });
    if (terminal) {
      run.running = false; run.requests.clear(); if (!this.hasLocalRun()) this.stopGpu();
      this.flush(); try { this.db.prepare('UPDATE reply_traces SET status=? WHERE run_id=?').run({ 'run-complete': 'complete', 'run-error': 'error', 'run-cancelled': 'cancelled' }[event.event as 'run-complete'], runId); } catch { /* Best effort. */ }
    } else if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 250); this.timer.unref(); }
    // Retain recent completed runs for UI acknowledgements, but bound memory.
    if (this.live.size > MAX_RUNS) this.live.delete(this.live.keys().next().value!);
  }
  recordRuntime(metric: NativePerformance): void {
    if (this.closed || !this.enabled) return;
    // Reuse the strict event validator before retaining even configuration data.
    const parsed = traceEventSchema.safeParse({ event: 'runtime-metric', nativePerformance: metric });
    if (!parsed.success) return;
    if (metric.stage === 'configuration') this.configurations.set(metric.model, parsed.data.nativePerformance!);
    for (const [id, run] of this.live) if (run.local && run.running) this.record(id, parsed.data);
  }
  private hasLocalRun() { return [...this.live.values()].some(run => run.local && run.running); }
  private stopGpu() { clearTimeout(this.gpuTimer); this.gpuTimer = undefined; this.gpuEpoch++; this.gpuAbort?.abort(); }
  private ensureGpu() {
    if (this.closed || !this.enabled || !this.gpuTelemetry || !this.hasLocalRun() || this.gpuPending || this.gpuTimer) return;
    void this.pollGpu();
  }
  private async pollGpu() {
    this.gpuPending = true; const epoch = this.gpuEpoch, abort = new AbortController(); this.gpuAbort = abort;
    let period = 60000;
    try {
      const sample = await this.gpuTelemetry!.sample(abort.signal);
      if (epoch !== this.gpuEpoch || abort.signal.aborted || this.closed || !this.enabled) return;
      period = sample.status === 'nvidia' ? 10000 : 60000;
      for (const [id, run] of this.live) if (run.local && run.running) {
        const active = [...run.requests].slice(0, 8);
        if (!active.length) this.record(id, { event: 'gpu-sample', phase: 'waiting', gpu: sample });
        else for (const [requestId, request] of active) this.record(id, { event: 'gpu-sample', requestId, purpose: request.purpose, phase: request.phase, gpu: sample });
      }
    } catch { /* A missing driver or failed sample never affects inference. */ }
    finally {
      this.gpuPending = false; if (this.gpuAbort === abort) this.gpuAbort = undefined;
      if (!this.closed && this.enabled && this.hasLocalRun()) { this.gpuTimer = setTimeout(() => { this.gpuTimer = undefined; this.ensureGpu(); }, epoch === this.gpuEpoch ? period : 1000); this.gpuTimer.unref(); }
    }
  }
  stamp(runId: string): TraceStamp | undefined {
    const run = this.live.get(runId); if (this.closed || !this.enabled || !run) return;
    const updateId = ++run.stampId; const publishedAt = this.now(); run.stamps.set(updateId, publishedAt);
    if (run.stamps.size > 100) run.stamps.delete(run.stamps.keys().next().value!);
    return { runId, updateId, publishedAt };
  }
  acknowledge(input: UiTrace): void {
    const parsed = uiTraceSchema.safeParse(input); if (!parsed.success) return; const { runId, ...fields } = parsed.data; const run = this.live.get(runId);
    const key = JSON.stringify([fields.visibility, fields.answerVisible, fields.workVisible, fields.thinkingVisible, fields.approvalVisible, fields.errorVisible, fields.textHeld]);
    if (!run || !run.stamps.has(fields.updateId) || fields.updateId < run.uiVersion || key === run.uiKey && this.clock() - run.uiAt < 100) return;
    // Assistant-UI can commit child content after a snapshot's first frame.
    run.uiAt = this.clock(); run.uiKey = key; run.uiVersion = fields.updateId; this.record(runId, { event: 'ui-frame', ...fields });
  }
  flush(): void {
    if (this.closed || !this.pending.length) return; const pending = this.pending.splice(0);
    try { this.db.exec('BEGIN'); const insert = this.db.prepare('INSERT OR IGNORE INTO reply_trace_events VALUES(?,?,?,?)'); for (const { runId, event } of pending) insert.run(runId, event.sequence, event.elapsedMs, JSON.stringify(event)); this.db.exec('COMMIT'); } catch { try { this.db.exec('ROLLBACK'); } catch { /* Failed diagnostic storage is isolated. */ } }
  }
  reports(limit = MAX_RUNS): TraceReport[] {
    if (this.closed) return []; this.flush(); this.prune();
    const reports = this.db.prepare('SELECT run_id,metadata,status FROM reply_traces ORDER BY started_at DESC,rowid DESC LIMIT ?').all(Math.max(1, Math.min(MAX_RUNS, limit))).map(row => {
      const events = this.db.prepare('SELECT data FROM reply_trace_events WHERE run_id=? ORDER BY sequence').all(row.run_id).map(value => JSON.parse(String(value.data)) as TraceRecord);
      const live = row.status === 'running' ? this.live.get(String(row.run_id)) : undefined;
      return { ...JSON.parse(String(row.metadata)) as TraceMetadata, status: row.status as TraceReport['status'], events, metrics: traceMetrics(events, live ? this.clock() - live.origin : undefined), observations: [] as string[] };
    });
    for (let index = 0; index < reports.length; index++) reports[index].observations = traceObservations(reports[index], reports.slice(index + 1)); return reports;
  }
  snapshot(): DiagnosticsSnapshot { return { enabled: this.enabled, persistent: this.persistent, retentionDays: RETENTION_DAYS, maxRuns: MAX_RUNS, runs: this.reports().slice(0, 20).map(({ events: _events, ...summary }) => summary) }; }
  setEnabled(enabled: boolean): DiagnosticsSnapshot {
    if (!enabled) { this.stopGpu(); this.flush(); this.live.clear(); this.db.prepare("UPDATE reply_traces SET status='interrupted' WHERE status='running'").run(); }
    this.enabled = enabled; this.db.prepare("INSERT INTO diagnostics_meta VALUES('enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(enabled)); return this.snapshot();
  }
  clear(): DiagnosticsSnapshot { this.stopGpu(); clearTimeout(this.timer); this.timer = undefined; this.pending = []; this.live.clear(); this.db.exec('DELETE FROM reply_traces; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;'); return this.snapshot(); }
  close(): void { if (this.closed) return; this.stopGpu(); clearTimeout(this.timer); this.flush(); this.closed = true; this.live.clear(); try { this.db.close(); } catch { /* Cannot disrupt application shutdown. */ } }
}
