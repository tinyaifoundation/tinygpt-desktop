import { describe, expect, it } from 'vitest';
import { traceMetrics, traceObservations } from '../src/core/trace-metrics';
import type { TraceRecord } from '../src/shared/diagnostics';
const event = (event: TraceRecord['event'], elapsedMs: number, fields: Partial<TraceRecord> = {}): TraceRecord => ({ event, elapsedMs, sequence: elapsedMs, ...fields });
describe('reply UX timing attribution', () => {
  it('does not report later completed-message content toggles as UI delivery delays', () => {
    const events = [event('run-complete',1000),event('ui-frame',1050,{cause:'snapshot',visibility:'foreground',deliveryMs:30,renderMs:5,answerVisible:true}),event('ui-frame',140000,{cause:'content',visibility:'foreground',deliveryMs:139000,renderMs:10})];
    expect(traceMetrics(events).maxUiLagMs).toBe(35);
  });
  it('includes ongoing stages and requests that time out without any stream data', () => {
    const events = [event('run-start', 0), event('optimizing', 100), event('request-start', 200)];
    expect(traceMetrics(events, 5000)).toMatchObject({ totalMs: 5000, compactionMs: 4900, providerWaitMs: 4800 });
    expect(traceMetrics([...events, event('request-error', 1000), event('optimization-failed', 1100), event('run-error', 1200)], 5000)).toMatchObject({ totalMs: 1200, compactionMs: 1000, providerWaitMs: 800 });
    const interaction = traceMetrics([event('ui-frame', 3000, { visibility: 'foreground', cause: 'interaction', deliveryMs: 2000 })]); expect(interaction.maxUiLagMs).toBe(0);
  });
  it('separates preparation, model waits, compaction, approvals, and actual tool execution', () => {
    const metrics = traceMetrics([
      event('run-start', 0), event('execution-start', 100), event('worker-ready', 200),
      event('optimizing', 250), event('request-start', 300, { requestId: 'summary' }), event('request-first-data', 600, { requestId: 'summary' }), event('optimized', 1000),
      event('request-start', 1100, { requestId: 'reply' }), event('request-first-data', 1200, { requestId: 'reply' }), event('first-thinking', 2000), event('preparing-tool', 2200), event('tool-queued', 3200),
      event('approval-start', 3200, { operationId: 'tool' }), event('approval-end', 5000, { operationId: 'tool' }), event('tool-start', 5000, { operationId: 'tool' }), event('tool-end', 5100, { operationId: 'tool' }),
      event('usage', 5200, { inputTokens: 200, outputTokens: 20 }), event('run-complete', 5500),
    ]);
    expect(metrics).toMatchObject({ totalMs: 5500, setupMs: 100, workerMs: 100, compactionMs: 750, providerWaitMs: 400, firstModelMs: 2000, requestCount: 2, toolPreparationMs: 1000, approvalMs: 1800, toolMs: 100, inputTokens: 200, outputTokens: 20 });
  });
  it('distinguishes actual visible work from a waiting placeholder and background updates', () => {
    const metrics = traceMetrics([event('ui-frame', 10, { visibility: 'foreground', workVisible: true, phase: 'connecting' }), event('ui-frame', 50, { visibility: 'background', answerVisible: true, deliveryMs: 10000 }), event('ui-frame', 100, { visibility: 'foreground', thinkingVisible: true, deliveryMs: 5, renderMs: 30 }), event('ui-frame', 200, { visibility: 'foreground', textHeld: true }), event('run-complete', 1000), event('ui-frame', 1020, { visibility: 'foreground', answerVisible: true, textHeld: false })]);
    expect(metrics).toMatchObject({ totalMs: 1000, firstActivityMs: 100, firstAnswerMs: 1020, maxUiLagMs: 35, heldTextMs: 820 });
  });
  it('flags possible degradation only with enough comparable completed runs', () => {
    const metrics = traceMetrics([event('run-complete', 50000)]); const run = { metrics, status: 'complete' as const, fingerprint: 'configuration' };
    const baseline = Array.from({ length: 5 }, () => ({ ...run, metrics: { ...metrics, totalMs: 10000 } }));
    expect(traceObservations(run, baseline)).toEqual([expect.stringContaining('twice the median')]);
    expect(traceObservations(run, baseline.slice(0, 4))).toEqual([]); expect(traceObservations(run, baseline.map(value => ({ ...value, fingerprint: 'different' })))).toEqual([]);
    expect(traceObservations({ ...run, metrics: { ...metrics, approvalMs: 100 } }, baseline).join(' ')).not.toContain('twice');
  });
});
