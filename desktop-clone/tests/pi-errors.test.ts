import {it,expect} from 'vitest';
import {piProviderFailure,PI_REQUEST_FORMAT_MESSAGE} from '../src/core/pi-errors';
it('classifies local template errors without leaking raw provider content',()=>{
  const result=piProviderFailure('500: {"message":"System message must be at the beginning.","request":"PRIVATE_SENTINEL"}');
  expect(result).toEqual({status:500,errorCode:'message-order',message:PI_REQUEST_FORMAT_MESSAGE});
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
});
it('preserves safe HTTP failure categories and handles unknown errors',()=>{
  expect(piProviderFailure('401: PRIVATE_SENTINEL').message).toContain('API key');
  expect(piProviderFailure('429: PRIVATE_SENTINEL').message).toContain('usage limit');
  expect(piProviderFailure('500: PRIVATE_SENTINEL').message).toContain('temporarily unavailable');
  expect(piProviderFailure('PRIVATE_SENTINEL')).toMatchObject({errorCode:'unknown'});
  expect(JSON.stringify(piProviderFailure('PRIVATE_SENTINEL'))).not.toContain('PRIVATE_SENTINEL');
});
