import { chatError } from './chat-errors';
export const PI_REQUEST_FORMAT_MESSAGE = 'The model rejected the conversation format. Your messages are saved.';
/** Pi stores an upstream error string. Classify it without exposing its body. */
export function piProviderFailure(raw = '') {
  const value=Number(/^\s*(\d{3}):/.exec(raw)?.[1]);
  const status=value>=400&&value<=599?value:undefined;
  const order=/System message must be at the beginning\.?/i.test(raw);
  return {status,errorCode:order?'message-order' as const:status?'provider-http' as const:'unknown' as const,
    message:order?PI_REQUEST_FORMAT_MESSAGE:chatError(Object.assign(new Error('Provider request failed.'),{status}))};
}
