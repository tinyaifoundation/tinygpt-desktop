export type ConnectorFailureCode = 'NOT_FOUND' | 'AUTHENTICATION_REQUIRED' | 'PERMISSION_DENIED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' | 'INVALID_RESPONSE';
const messages: Record<ConnectorFailureCode, string> = {
  NOT_FOUND: 'The requested item was not found. Use the exact identifier from search results; refresh the search before retrying.',
  AUTHENTICATION_REQUIRED: 'Sign in again to reconnect this account.',
  PERMISSION_DENIED: 'The connected account does not permit this action. Check its permissions before retrying.',
  RATE_LIMITED: 'The provider is rate limiting requests. Wait before trying again.',
  PROVIDER_UNAVAILABLE: 'The provider could not complete this request. Check its status before retrying.',
  INVALID_RESPONSE: 'The provider returned an incomplete or mismatched response. Refresh the search before using this item.',
};
/** Only host-defined messages/status categories cross the tool boundary. */
export class ConnectorRequestError extends Error {
  constructor(readonly code: ConnectorFailureCode, readonly status?: number, readonly retryAfterSeconds?: number) { super(messages[code]); }
}
export function connectorFailure(error: unknown): { error: string; code: string; retryAfterSeconds?: number } {
  if (error instanceof ConnectorRequestError) return { error: error.message, code: error.code, ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) };
  if (error instanceof Error && error.message === messages.AUTHENTICATION_REQUIRED) return { error: messages.AUTHENTICATION_REQUIRED, code: 'AUTHENTICATION_REQUIRED' };
  if (error instanceof Error && error.message === 'Plugin tool arguments are invalid. Use the declared schema.') return { error: error.message, code: 'INVALID_ARGUMENTS' };
  if (error instanceof Error && ['Plugin access was revoked.', 'Plugin tools changed. Start a new reply.'].includes(error.message)) return { error: 'Plugin access changed. Reconnect or start a new reply before using this tool.', code: 'ACCESS_CHANGED' };
  return { error: 'Plugin tool failed. Check its connection and permissions. Do not retry an external mutation without checking whether it completed.', code: 'PLUGIN_TOOL_FAILED' };
}
