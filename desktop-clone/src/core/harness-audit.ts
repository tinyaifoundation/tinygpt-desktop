import { createHash } from 'node:crypto';

export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '');
export function auditCommandExit(result: string | null, expected: number): boolean {
  try { return JSON.parse(result ?? 'null')?.exitCode === expected; } catch { return false; }
}
export function auditSnapshotEvidence(result: string | null, expected: string): boolean {
  try {
    const value = JSON.parse(result ?? 'null');
    return value?.snapshotKind === 'accessibility' && typeof value.text === 'string' && value.text.includes(expected) && value.pending !== true && (!value.wait || value.wait.matched === true && value.wait.timedOut !== true);
  } catch { return false; }
}
export function redactAudit(value: unknown, secrets: string[] = []): any {
  if (typeof value === 'string') {
    let text = value.replace(/\bsk-(?:or-v1-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]');
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map(item => redactAudit(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)$/i.test(key) ? '[REDACTED]' : redactAudit(item, secrets)]));
  return value;
}

export function auditRequest(body: any) {
  const tools = (body.tools ?? []).map((tool: any) => ({ name: tool.function?.name ?? tool.name, bytes: jsonBytes(tool) }));
  const messages = body.messages ?? body.input ?? [];
  const observations = Array.isArray(messages) ? messages.filter((m: any) => m.role === 'tool' || m.type === 'function_call_output').map((m: any) => ({ name: m.name, callId: m.tool_call_id ?? m.call_id, bytes: jsonBytes(m.content ?? m.output) })) : [];
  const calls = Array.isArray(messages) ? messages.flatMap((m: any) => (m.tool_calls ?? []).map((call: any) => ({ id: call.id, name: call.function?.name, argumentsBytes: jsonBytes(call.function?.arguments) }))) : [];
  const roleBytes = Object.fromEntries(['system', 'developer', 'user', 'assistant', 'tool'].map(role => [role, Array.isArray(messages) ? messages.filter((m: any) => m.role === role).reduce((sum: number, m: any) => sum + jsonBytes(m), 0) : 0]));
  return { bytes: jsonBytes(body), schemaBytes: jsonBytes(body.tools ?? []), messageBytes: jsonBytes(messages), roleBytes, tools, observations, calls,
    schemaFingerprint: createHash('sha256').update(JSON.stringify(body.tools ?? [])).digest('hex'),
    approximateTokens: Math.ceil(jsonBytes(body) / 4), tokenEstimateMethod: 'UTF-8 bytes / 4; diagnostic estimate, not provider tokenization' };
}

export class AuditBudget {
  reservedUsd = 0; requests = 0;
  readonly maxUsd: number; readonly maxRequests: number; readonly inputPrice: number; readonly outputPrice: number;
  constructor(maxUsd: number, maxRequests: number, inputPrice: number, outputPrice: number) {
    if (![maxUsd, maxRequests, inputPrice, outputPrice].every(Number.isFinite) || maxUsd <= 0 || maxRequests < 1 || inputPrice < 0 || outputPrice < 0) throw Error('Invalid audit budget or model pricing.');
    this.maxUsd = maxUsd; this.maxRequests = maxRequests; this.inputPrice = inputPrice; this.outputPrice = outputPrice;
  }
  admit(bytes: number, outputTokens: number) {
    // Reserve full UTF-8 bytes as input tokens, including schemas, and all possible output.
    // No cache discounts, no refunds for failures. Routing is pinned to these price ceilings.
    const reserve = bytes * this.inputPrice + outputTokens * this.outputPrice;
    if (this.requests >= this.maxRequests || this.reservedUsd + reserve > this.maxUsd) throw Error('AUDIT_BUDGET_EXHAUSTED');
    this.requests++; this.reservedUsd += reserve; return reserve;
  }
}

export function auditFindings(requests: ReturnType<typeof auditRequest>[], operations: { name: string; status: string; result: string | null; target?: string | null }[]) {
  const findings: { severity: string; code: string; detail: string }[] = [];
  const add = (code: string, detail: string, severity = 'review') => findings.push({ severity, code, detail });
  if (requests.some(r => r.schemaBytes > 24000)) add('schema-overhead', 'At least one request advertises more than 24 KB of schemas. Review lazy discovery and overlapping tools.');
  if (requests.some(r => r.schemaBytes > r.messageBytes && r.schemaBytes > 8000)) add('schema-dominates', 'Tool schemas exceed message bytes on at least one request.');
  if (requests.some(r => r.observations.some(o => o.bytes > 12000))) add('large-observation', 'A tool observation exceeds 12 KB at the provider boundary. Review excerpts and read_observation paging.');
  if (requests.length > 1 && requests.at(-1)!.bytes > Math.max(32000, requests[0].bytes * 3)) add('context-growth', 'Final request is over 3× the first request and exceeds 32 KB.');
  const signatures = new Map<string, number>();
  for (const operation of operations) {
    const key = JSON.stringify([operation.name, operation.target, operation.result]);
    signatures.set(key, (signatures.get(key) ?? 0) + 1);
  }
  if ([...signatures.values()].some(count => count >= 3)) add('repeated-observation', 'Three or more operations have identical tool, target and result; inspect whether polling or wasted work.');
  if (operations.some(o => ['error', 'interrupted'].includes(o.status))) add('tool-failure', 'One or more tools failed; inspect the case oracle to distinguish deliberate negative checks.');
  if (requests.length > 12) add('excessive-roundtrips', `${requests.length} inference requests for one case.`);
  return findings;
}
