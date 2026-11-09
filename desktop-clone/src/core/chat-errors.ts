// Only fixed messages cross into the UI; provider error bodies can echo secrets.
export function chatError(error: unknown): string {
  if (chatFailure(error).failure === 'context') return 'The conversation cannot fit its current context capacity. Reduce tool context or increase the configured capacity, then retry.';
  if (error instanceof Error && ['APIConnectionTimeoutError', 'APITimeoutError', 'TimeoutError'].includes(error.name)) return REPLY_TIMEOUT_MESSAGE;
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
  if (status === 401 || status === 403) return 'Your provider did not accept the API key. Check it in Settings.';
  if (status === 429) return 'Your provider is busy or its usage limit was reached. Try again shortly.';
  if (status === 400 || status === 404 || status === 422) return 'The provider rejected this request. Check the model and API format in Settings; the conversation may also exceed its context limit.';
  if (status >= 500) return 'Your provider is temporarily unavailable. You can retry this reply.';
  return 'The reply could not finish. Check your connection and provider settings, then retry.';
}
/** Fixed diagnostic codes only. Never persist arbitrary upstream error text. */
export function chatFailure(error: unknown): { failure: 'context' | 'provider' | 'runtime'; errorCode: 'context-empty' | 'context-overflow' | 'provider-http' | 'runtime' | 'unknown' } {
  let type: unknown;
  if (error instanceof Error) { try { type = JSON.parse(error.message)?.type; } catch { /* Not a structured harness error. */ } }
  if (type === 'empty_messages') return { failure: 'context', errorCode: 'context-empty' };
  if (type === 'context_overflow') return { failure: 'context', errorCode: 'context-overflow' };
  if (error && typeof error === 'object' && 'status' in error && Number(error.status) >= 400) return { failure: 'provider', errorCode: 'provider-http' };
  if (error && typeof error === 'object' && 'pregelTaskId' in error) return { failure: 'runtime', errorCode: 'runtime' };
  return { failure: 'provider', errorCode: 'unknown' };
}
import { REPLY_TIMEOUT_MESSAGE } from '../shared/chat-timeouts';

