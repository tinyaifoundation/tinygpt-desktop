import { describe, expect, it } from 'vitest';
import { AuditBudget, auditCommandExit, auditFindings, auditRequest, auditSnapshotEvidence, redactAudit } from '../src/core/harness-audit';

describe('harness audit accounting', () => {
  it('requires the structured exit code, not a number appearing in exception prose', () => {
    expect(auditCommandExit(JSON.stringify({ exitCode: 1, output: 'Node exited with code 7' }), 7)).toBe(false);
    expect(auditCommandExit(JSON.stringify({ exitCode: 7, output: 'Failed' }), 7)).toBe(true);
  });
  it('accepts observed browser outcomes returned by actions without requiring redundant reads', () => {
    const result = { snapshotKind: 'accessibility', text: 'APPLIED=MAPLE', wait: { matched: true } };
    expect(auditSnapshotEvidence(JSON.stringify(result), 'APPLIED=MAPLE')).toBe(true);
    expect(auditSnapshotEvidence(JSON.stringify({ ...result, pending: true }), 'APPLIED=MAPLE')).toBe(false);
    expect(auditSnapshotEvidence(JSON.stringify({ ...result, text: 'Not applied', wait: { matched: true, evidence: 'APPLIED=MAPLE' } }), 'APPLIED=MAPLE')).toBe(false);
  });
  it('counts schemas, replayed observations and tool argument payloads separately', () => {
    const result = auditRequest({ tools: [{ type: 'function', function: { name: 'read' } }], messages: [{ role: 'assistant', tool_calls: [{ id: '1', function: { name: 'read', arguments: '{"path":"x"}' } }] }, { role: 'tool', tool_call_id: '1', content: 'result' }] });
    expect(result.tools[0].name).toBe('read'); expect(result.observations[0].callId).toBe('1'); expect(result.calls[0].name).toBe('read');
    expect(result.bytes).toBeGreaterThan(result.schemaBytes); expect(result.approximateTokens).toBeGreaterThan(0);
  });
  it('refuses the next request before overspending and never refunds failed requests', () => {
    const budget = new AuditBudget(0.02, 2, 0.000001, 0.000002);
    budget.admit(1000, 1000); budget.admit(1000, 1000);
    expect(budget.reservedUsd).toBeCloseTo(0.006); expect(() => budget.admit(1, 1)).toThrow('AUDIT_BUDGET');
    expect(() => new AuditBudget(0.001, 4, 0.001, 0.001).admit(1, 1)).toThrow('AUDIT_BUDGET');
  });
  it('redacts nested credentials and exact secrets embedded in strings', () => {
    expect(redactAudit({ authorization: 'Bearer x', nested: ['key=SENSITIVE', { api_key: 'x' }], text: 'sk-or-v1-abcdefghijklmnop' }, ['SENSITIVE'])).toEqual({ authorization: '[REDACTED]', nested: ['key=[REDACTED]', { api_key: '[REDACTED]' }], text: '[REDACTED]' });
  });
  it('flags large observations and repeated results without declaring a failure', () => {
    const requests = [auditRequest({ messages: [{ role: 'tool', content: 'x'.repeat(13000) }] })];
    expect(auditFindings(requests, Array.from({ length: 3 }, () => ({ name: 'read', status: 'success', result: 'same' }))).map(f => f.code)).toEqual(['large-observation', 'repeated-observation']);
  });
});
