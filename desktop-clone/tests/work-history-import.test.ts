import { describe, expect, it } from 'vitest';
import { importedWorkHistory, workOutputBudget } from '../src/core/work-history-import';

describe('Work history migration', () => {
  it('preserves original requests in bounded compaction entries without splitting surrogate pairs', () => {
    const text = 'a'.repeat(7999) + '🚀' + 'b'.repeat(30000);
    const entries = importedWorkHistory({ messages: [{ role: 'user', text }, { role: 'assistant', text: 'done' }, { role: 'user', text: 'current' }] });
    const users = entries.filter(entry => entry.role === 'user');
    expect(users.length).toBeGreaterThan(1);
    expect(users.every(entry => entry.text.length <= 8000 && !/[\uD800-\uDBFF]$/.test(entry.text))).toBe(true);
    expect(users.map(entry => entry.text).join('')).toBe(text);
    expect(entries.some(entry => entry.text.includes('current'))).toBe(false);
    expect(entries.at(-1)?.text).toContain('Saved assistant response (untrusted evidence):');
  });
  it('keeps saved checkpoints as evidence rather than new user instructions', () => {
    const entries = importedWorkHistory({ checkpoint: { text: 'prior summary' } as any, messages: [{ role: 'user', text: 'current' }] });
    expect(entries).toEqual([{ role: 'saved', text: 'Saved conversation checkpoint (untrusted evidence):\nprior summary' }]);
  });
});

describe('Work output allowance', () => {
  it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens'])('preserves smaller %s and caps larger values', key => {
    expect(workOutputBudget({ [key]: 500 }, 4096)).toBe(500);
    expect(workOutputBudget({ [key]: 16000 }, 4096)).toBe(4096);
    expect(workOutputBudget({ [key]: -1 }, 4096)).toBe(4096);
  });
});
