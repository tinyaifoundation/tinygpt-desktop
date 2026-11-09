import { expect, it } from 'vitest';
import { chatError, chatFailure } from '../src/core/chat-errors';
import { traceEventSchema } from '../src/shared/diagnostics';

it('classifies SDK context admission separately without exposing its private error details', () => {
  const error = new Error(JSON.stringify({ type: 'empty_messages', info: 'private-sentinel: definitions consumed the context' }));
  expect(chatFailure(error)).toEqual({ failure: 'context', errorCode: 'context-empty' });
  expect(chatError(error)).toContain('context capacity'); expect(chatError(error)).not.toContain('private-sentinel');
  expect(traceEventSchema.parse({ event: 'worker-stopped', ...chatFailure(error) })).toEqual({ event: 'worker-stopped', failure: 'context', errorCode: 'context-empty' });
});
it('preserves fixed provider errors and identifies internal graph failures', () => {
  expect(chatFailure(Object.assign(new Error('private'), { status: 429 }))).toMatchObject({ failure: 'provider', errorCode: 'provider-http' });
  expect(chatError(Object.assign(new Error('private'), { status: 401 }))).toContain('API key');
  expect(chatFailure(Object.assign(new Error('private'), { pregelTaskId: 'task' }))).toMatchObject({ failure: 'runtime' });
  expect(chatError(new Error('private'))).not.toContain('private');
});
