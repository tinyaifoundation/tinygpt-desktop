// A long response is healthy while the provider continues sending data.
export const REPLY_IDLE_TIMEOUT_MS = 3 * 60 * 1000;
export const FIRST_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
// Checkpoint fetches validate a complete response before returning it to the SDK.
export const PROVIDER_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
export const REPLY_TIMEOUT_MESSAGE = 'The provider stopped responding. Your conversation is saved; retry this reply.';
export type ProviderActivity = 'request' | 'response' | 'data';
