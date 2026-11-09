import { expect, it } from 'vitest';
import { ToolLoopGuard } from '../src/core/tool-loop';

it('ignores argument order and UI labels, and permits recovery or successful polling', () => {
  const guard = new ToolLoopGuard();
  for (let n = 0; n < 3; n++) guard.record('read', { path: 'missing', offset: 0 }, '{"error":"unavailable"}');
  expect(guard.blocked('read', { offset: 0, path: 'missing' })).toBe(true);
  expect(guard.blocked('read', { path: 'other', offset: 0 })).toBe(false);
  guard.record('read', { path: 'other' }, '{"text":"success"}');
  expect(guard.blocked('read', { path: 'missing', offset: 0 })).toBe(false);
  for (let n = 0; n < 100; n++) { expect(guard.blocked('poll', {})).toBe(false); guard.record('poll', {}, '{"status":"working"}'); }
});
