import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ReplyDiagnostics } from '../src/main/reply-diagnostics';
import type { TraceMetadata, TraceEvent } from '../src/shared/diagnostics';

const stores: ReplyDiagnostics[] = []; const folders: string[] = [];
const meta = (startedAt = 1800000000000): TraceMetadata => ({ runId: randomUUID(), startedAt, route: 'byok', provider: 'openrouter', protocol: 'openai-compatible', fingerprint: '0123456789abcdef', version: '0.1.0', platform: 'win32' });
function setup(path = ':memory:') { let time = 0; let now = 1800000000000; const db = new ReplyDiagnostics(path, () => now, () => time); stores.push(db); return { db, tick: (ms: number) => { time += ms; now += ms; }, now: () => now }; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of folders.splice(0)) { if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('tinygpt-diagnostics-')) throw new Error('Invalid fixture folder.'); rmSync(path, { recursive: true, force: true }); } });
describe('bounded local reply traces', () => {
  it('rejects arbitrary payloads rather than persisting content or secrets', () => {
    const { db, tick } = setup(); const run = meta(); db.begin(run);
    db.record(run.runId, { event: 'first-text', text: 'private-message-and-secret' } as unknown as TraceEvent);
    db.record(run.runId, { event: 'tool-start', tool: 'private-plugin-or-path' } as unknown as TraceEvent);
    db.begin({ ...meta(), endpoint: 'https://private.example/key' } as TraceMetadata);
    tick(50); db.record(run.runId, { event: 'run-complete' });
    const reports = db.reports(); expect(reports).toHaveLength(1); expect(reports[0].events.map(event => event.event)).toEqual(['run-start', 'run-complete']);
    expect(JSON.stringify(reports)).not.toContain('private'); expect(reports[0].metrics.totalMs).toBe(50);
  });
  it('accepts only issued UI stamps, permits fast meaningful state changes, rejects duplicates', () => {
    const { db, tick } = setup(); const run = meta(); db.begin(run); const stamp = db.stamp(run.runId)!;
    db.acknowledge({ runId: randomUUID(), updateId: stamp.updateId, answerVisible: true });
    db.acknowledge({ runId: run.runId, updateId: 9999, answerVisible: true });
    tick(10); db.acknowledge({ ...stamp, answerVisible: true } as never); // publishedAt is forbidden
    db.acknowledge({ runId: stamp.runId, updateId: stamp.updateId, visibility: 'foreground', answerVisible: false });
    const next = db.stamp(run.runId)!; db.acknowledge({ runId: next.runId, updateId: next.updateId, visibility: 'foreground', answerVisible: true });
    db.acknowledge({ runId: next.runId, updateId: next.updateId, visibility: 'foreground', answerVisible: true });
    db.acknowledge({ runId: stamp.runId, updateId: stamp.updateId, visibility: 'foreground', answerVisible: false }); // stale snapshot
    expect(db.reports()[0].events.filter(event => event.event === 'ui-frame')).toHaveLength(2);
    expect(db.reports()[0].metrics.firstAnswerMs).toBe(10);
  });
  it('preserves completion even when a stream hits the event cap', () => {
    const { db } = setup(); const run = meta(); db.begin(run);
    for (let i = 0; i < 10200; i++) db.record(run.runId, { event: 'model-progress', textChars: i });
    db.record(run.runId, { event: 'run-complete' }); const report = db.reports()[0]; expect(report.events).toHaveLength(10000); expect(report.status).toBe('complete'); expect(report.events.at(-1)?.event).toBe('run-complete');
  });
  it('limits retained runs and expires old records without keeping live references', () => {
    const { db, tick, now } = setup(); let first = '';
    for (let index = 0; index < 205; index++) { const run = meta(now()); first ||= run.runId; db.begin(run); db.record(run.runId, { event: 'run-complete' }); tick(1); }
    expect(db.reports()).toHaveLength(200); expect(db.stamp(first)).toBeUndefined();
    tick(8 * 86400000); expect(db.reports()).toEqual([]); expect(db.snapshot().runs).toEqual([]);
  });
  it('pausing, clearing, and closing isolate late callbacks from storage', () => {
    const { db } = setup(); const run = meta(); db.begin(run); db.setEnabled(false); db.record(run.runId, { event: 'first-text' }); db.begin(meta());
    expect(db.reports()[0].status).toBe('interrupted'); expect(db.reports()).toHaveLength(1); db.setEnabled(true); expect(db.stamp(run.runId)).toBeUndefined();
    const next = meta(); db.begin(next); db.clear(); db.record(next.runId, { event: 'run-complete' }); expect(db.reports()).toEqual([]);
    db.close(); expect(() => { db.close(); db.record(next.runId, { event: 'run-error' }); db.acknowledge({ runId: next.runId, updateId: 1 }); }).not.toThrow(); expect(db.reports()).toEqual([]);
  });
  it('marks interrupted runs after restart and persists the recording preference', () => {
    const folder = mkdtempSync(join(tmpdir(), 'tinygpt-diagnostics-')); folders.push(folder); const path = join(folder, 'diagnostics.sqlite');
    const a = setup(path); const run = meta(); a.db.begin(run); a.db.close(); const b = setup(path); expect(b.db.reports()[0].status).toBe('interrupted');
    b.db.setEnabled(false); b.db.close(); const c = setup(path); expect(c.db.snapshot().enabled).toBe(false); expect(c.db.persistent).toBe(true);
  });
  it('falls back to memory for an unreadable or corrupt diagnostics database', () => {
    const folder = mkdtempSync(join(tmpdir(), 'tinygpt-diagnostics-')); folders.push(folder); const path = join(folder, 'diagnostics.sqlite'); writeFileSync(path, 'Not a SQLite database');
    const { db } = setup(path); expect(db.persistent).toBe(false); const run = meta(); db.begin(run); db.record(run.runId, { event: 'run-complete' }); expect(db.reports()[0].status).toBe('complete');
  });
});
