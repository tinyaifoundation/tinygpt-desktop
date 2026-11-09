import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { calculate } from '../src/main/calculator';
import { ToolBroker } from '../src/main/tool-broker';
import { HistoryStore } from '../src/main/history';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import type { ProjectFiles } from '../src/main/files';

describe('built-in calculator', () => {
  it.each([['0.1 + 0.2', '0.3'], ['1250 * 0.18', '225'], ['(1250 - 225) / 5', '205'], ['2^10', '1024'], ['round(10 / 3, 2)', '3.33'], ['sqrt(81) + abs(-2)', '11'], ['max(3, 7, 2)', '7'], ['10 mod 3', '1'], ['9007199254740993 + 1', '9007199254740994']])('computes %s using decimal precision', (expression, expected) => {
    expect(calculate(expression)).toEqual({ expression, result: expected });
  });
  it('supports documented scientific functions and constants', () => {
    expect(Number(calculate('sin(pi / 2)').result)).toBeCloseTo(1, 12);
    expect(Number(calculate('log(e)').result)).toBeCloseTo(1, 12);
    expect(calculate('log10(1000)').result).toBe('3');
  });
  it.each(['a = 1', 'a + 1', 'import("fs")', 'evaluate("1+1")', '2; 3', '[1,2]', 'sqrt.constructor', 'ones(1000000000)', '100000!', '1 / 0', 'sqrt(-1)', '2^1000000', 'exp(1000000)', '1e1001', 'round(2, 1000000)', 'true', '"hello"', 'pow(2,2,2)', 'sin(1000001)'])('rejects unsupported or unbounded input: %s', expression => {
    expect(() => calculate(expression)).toThrow();
  });
  it('limits input length, depth and operations', () => {
    expect(() => calculate('1'.repeat(1001))).toThrow('1,000');
    expect(() => calculate('('.repeat(20) + '1' + ')'.repeat(20))).toThrow('16 levels');
    expect(() => calculate(Array.from({ length: 60 }, () => '1').join('+'))).toThrow();
  });
  it('runs locally in Chat and Work without approval and saves readable results and errors', async () => {
    const history = new HistoryStore(':memory:');
    try {
      const settings = { ...defaultSettings, toolPermissions: Object.fromEntries(Object.keys(defaultSettings.toolPermissions).map(key => [key, 'deny'])) } as typeof defaultSettings;
      const broker = new ToolBroker(history, () => settings, {} as BrowserController, {} as ProjectFiles, () => {});
      for (const mode of ['chat', 'code'] as const) {
        const conversation = history.createConversation(null, mode); const turn = history.startTurn(conversation.id, '18% of 1250', 'local');
        const context = { conversationId: conversation.id, runId: turn.runId, signal: new AbortController().signal };
        expect(JSON.parse(await broker.execute(context, { id: randomUUID(), name: 'calculate', input: { expression: '1250 * 0.18' } }))).toEqual({ expression: '1250 * 0.18', result: '225' });
        expect(JSON.parse(await broker.execute(context, { id: randomUUID(), name: 'calculate', input: { expression: '1 / 0' } })).error).toContain('Division by zero');
        const tools = history.conversation(conversation.id).tools;
        expect(tools.map(tool => tool.status)).toEqual(['success', 'error']);
      }
      expect(broker.approvals()).toEqual([]);
    } finally { history.close(); }
  });
});
