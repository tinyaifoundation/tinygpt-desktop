/** One interpretation for model results, task evidence, history and recovery. */
export function operationOutcome(result: unknown): { status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; errorCode?: string; retryable?: boolean } {
  let value = result;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return { status: value === 'Cancelled.' ? 'cancelled' : 'succeeded' }; } }
  if (!value || typeof value !== 'object') return { status: 'succeeded' };
  const r = value as Record<string, unknown>;
  if (r.running === true || r.pending === true || r.incomplete === true || r.code === 'OUTCOME_UNKNOWN') return { status: 'unknown', errorCode: 'OUTCOME_UNKNOWN' };
  if (r.cancelled === true) return { status: 'cancelled' };
  if (r.timedOut === true) return { status: 'failed', errorCode: 'TIMEOUT' };
  if (typeof r.error === 'string' || r.isError === true || typeof r.exitCode === 'number' && r.exitCode !== 0) return { status: 'failed', errorCode: typeof r.code === 'string' ? r.code : 'TOOL_FAILED', retryable: typeof r.retryable === 'boolean' ? r.retryable : undefined };
  if ('exitCode' in r && r.exitCode === null) return { status: 'unknown', errorCode: 'PROCESS_OUTCOME_UNKNOWN' };
  return { status: 'succeeded' };
}
export function operationSignature(name: string, input: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([key]) => !['status', 'permission', '__tinygpt_status', '__tinygpt_approval'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : v;
  return JSON.stringify([name, normalize(input)]);
}
