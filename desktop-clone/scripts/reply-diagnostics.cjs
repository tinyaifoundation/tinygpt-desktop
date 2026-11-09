// Read only the dedicated, content-free diagnostic store. Never open settings,
// credentials, or the conversation database. Requires Node 24 (type stripping).
const { DatabaseSync } = require('node:sqlite');
const { existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { traceMetadataSchema, traceEventSchema } = require('../src/shared/diagnostics.ts');
const { traceMetrics, traceObservations } = require('../src/core/trace-metrics.ts');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const base = process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const profile = resolve(option('--profile') || join(base, 'tinygpt-desktop'));
const runId = option('--run');
if (runId && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(runId)) throw new Error('Choose a valid run ID.');
const path = join(profile, 'diagnostics.sqlite');
if (!existsSync(path)) { console.log('No local diagnostic records yet. Launch TinyGPT and send a reply with recording enabled.'); process.exit(0); }
const db = new DatabaseSync(path, { readOnly: true });
try {
  const reports = [];
  for (const row of db.prepare('SELECT run_id,metadata,status FROM reply_traces ORDER BY started_at DESC,rowid DESC LIMIT 200').all()) {
    const metadata = traceMetadataSchema.safeParse(JSON.parse(String(row.metadata))); if (!metadata.success) continue;
    const events = [];
    for (const value of db.prepare('SELECT data FROM reply_trace_events WHERE run_id=? ORDER BY sequence LIMIT 1000').all(row.run_id)) {
      const { elapsedMs, sequence, ...fields } = JSON.parse(String(value.data)); const safe = traceEventSchema.safeParse(fields);
      if (safe.success && Number.isFinite(elapsedMs) && elapsedMs >= 0 && Number.isSafeInteger(sequence) && sequence > 0) events.push({ ...safe.data, elapsedMs, sequence });
    }
    if (!['running', 'complete', 'error', 'cancelled', 'interrupted'].includes(row.status)) continue;
    reports.push({ ...metadata.data, status: row.status, events, metrics: traceMetrics(events, row.status === 'running' ? Math.max(0, Date.now() - metadata.data.startedAt) : undefined), observations: [] });
  }
  reports.forEach((run, index) => { run.observations = traceObservations(run, reports.slice(index + 1)); });
  const selected = runId ? reports.filter(run => run.runId === runId) : reports.slice(0, 10);
  console.log(JSON.stringify(selected.map(run => runId ? run : (({ events, ...summary }) => summary)(run)), null, 2));
} finally { db.close(); }
