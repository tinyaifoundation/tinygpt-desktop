import type { TraceMetrics, TraceRecord, TraceReport } from '../shared/diagnostics';

export function traceMetrics(events: TraceRecord[], observedMs?: number): TraceMetrics {
  const first = (name: string) => events.find(event => event.event === name)?.elapsedMs ?? null;
  const between = (start: string, end: string) => first(start) !== null && first(end) !== null ? Math.max(0, first(end)! - first(start)!) : null;
  const terminal = [...events].reverse().find(event => ['run-complete', 'run-error', 'run-cancelled'].includes(event.event));
  const totalMs = terminal?.elapsedMs ?? Math.max(events.at(-1)?.elapsedMs ?? 0, observedMs ?? 0);
  const duration = (start: string, ends: string[], key: 'operationId' | 'requestId') => {
    const pending = new Map<string, number>(); let total = 0;
    for (const event of events) { const id = event[key] ?? 'run'; if (event.event === start) pending.set(id, event.elapsedMs); if (ends.includes(event.event) && pending.has(id)) { total += Math.max(0, event.elapsedMs - pending.get(id)!); pending.delete(id); } }
    return total + [...pending.values()].reduce((sum, began) => sum + Math.max(0, totalMs - began), 0);
  };
  const ui = events.filter(event => event.event === 'ui-frame' && event.visibility === 'foreground');
  let heldAt: number | null = null; let heldMs = 0; let preparingAt: number | null = null; let preparationMs = 0;
  for (const event of events) {
    if (event.event === 'ui-frame') { if (event.textHeld && heldAt === null) heldAt = event.elapsedMs; if (!event.textHeld && heldAt !== null) { heldMs += event.elapsedMs - heldAt; heldAt = null; } }
    if (event.event === 'preparing-tool') preparingAt ??= event.elapsedMs;
    if (event.event === 'tool-queued' && preparingAt !== null) { preparationMs += event.elapsedMs - preparingAt; preparingAt = null; }
  }
  return {
    totalMs, setupMs: first('execution-start'), workerMs: first('worker-ready') !== null && first('execution-start') !== null ? first('worker-ready')! - first('execution-start')! : null,
    harnessMs: between('worker-ready', 'runtime-ready'), tokenizerMs: between('runtime-ready', 'tokenizer-ready'),
    firstActivityMs: ui.find(event => event.thinkingVisible || event.answerVisible || event.approvalVisible || event.workVisible && !['connecting', 'waiting'].includes(event.phase ?? ''))?.elapsedMs ?? null,
    firstAnswerMs: ui.find(event => event.answerVisible)?.elapsedMs ?? null,
    firstModelMs: events.find(event => ['first-thinking', 'first-text', 'preparing-tool'].includes(event.event))?.elapsedMs ?? null,
    compactionMs: duration('optimizing', ['optimized', 'optimization-failed'], 'operationId'),
    approvalMs: duration('approval-start', ['approval-end'], 'operationId'), toolMs: duration('tool-start', ['tool-end'], 'operationId'),
    toolPreparationMs: preparationMs + (preparingAt !== null ? Math.max(0, totalMs - preparingAt) : 0),
    requestCount: events.filter(event => event.event === 'request-start').length,
    providerWaitMs: duration('request-start', ['request-first-data', 'request-error', 'request-end', 'request-closed', 'request-cancelled'], 'requestId'),
    // Later toggles and layout changes on a completed message are not delivery delays.
    maxUiLagMs: Math.max(0, ...ui.filter(event => event.cause !== 'interaction' && (!terminal || event.elapsedMs <= terminal.elapsedMs + 2000)).map(event => (event.deliveryMs ?? 0) + (event.renderMs ?? 0))),
    heldTextMs: heldMs + (heldAt !== null ? Math.max(0, totalMs - heldAt) : 0),
    inputTokens: events.filter(event => ['usage', 'delegated-usage'].includes(event.event)).reduce((sum, event) => sum + (event.inputTokens ?? 0), 0),
    outputTokens: events.filter(event => ['usage', 'delegated-usage'].includes(event.event)).reduce((sum, event) => sum + (event.outputTokens ?? 0), 0),
  };
}
export function traceObservations(report: Pick<TraceReport, 'metrics' | 'status' | 'fingerprint'>, prior: Pick<TraceReport, 'metrics' | 'status' | 'fingerprint'>[]): string[] {
  const m = report.metrics; const notes: string[] = [];
  if ((m.setupMs ?? 0) > 8000) notes.push('Local preparation exceeded 8 seconds.');
  if ((m.workerMs ?? 0) > 3000) notes.push('Conversation worker startup exceeded 3 seconds.');
  if ((m.harnessMs ?? 0) > 3000) notes.push('Conversation harness loading exceeded 3 seconds.');
  if ((m.tokenizerMs ?? 0) > 3000) notes.push('Local tokenizer initialization exceeded 3 seconds before inference.');
  if (m.compactionMs > 20000) notes.push('Conversation optimization exceeded 20 seconds.');
  if (m.providerWaitMs > 20000) notes.push('Provider requests waited over 20 seconds before receiving stream data; keepalives may precede model output.');
  if (m.toolPreparationMs > 10000) notes.push('The model spent over 10 seconds preparing complete tool arguments.');
  if (m.toolMs > 15000) notes.push('Tool execution exceeded 15 seconds in total.');
  if (m.approvalMs > 0) notes.push('User approval time is recorded separately from tool execution.');
  if (m.maxUiLagMs > 500) notes.push('A foreground UI update took over 500 ms to reach its rendered frame.');
  if (m.heldTextMs > 10000) notes.push('Provider text was held for over 10 seconds while its commentary/final-answer role was undecided.');
  const baseline = prior.filter(run => run.status === 'complete' && run.fingerprint === report.fingerprint && run.metrics.approvalMs === 0).map(run => run.metrics.totalMs).sort((a, b) => a - b);
  if (report.status === 'complete' && m.approvalMs === 0 && baseline.length >= 5) { const median = baseline[Math.floor(baseline.length / 2)]; if (m.totalMs > median * 2 && m.totalMs - median > 10000) notes.push('This reply took over twice the median of recent replies with the same connection configuration; task size may differ.'); }
  return notes;
}
