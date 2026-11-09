import { expect, it } from 'vitest';
import { isTinyGPTAppLink, tinygptAppLink } from '../src/shared/app-link';
it('allows opening the app but never account data, tokens, paths or commands', () => {
  expect(isTinyGPTAppLink(tinygptAppLink)).toBe(true); expect(isTinyGPTAppLink(tinygptAppLink + '/')).toBe(true);
  for (const value of ['tinygpt://open?code=secret', 'tinygpt://open#secret', 'tinygpt://open/file', 'tinygpt://execute', 'tinygpt://user@open', 'tinygpt://open:80', 'https://open', 'tinygpt:open', ' tinygpt://open']) expect(isTinyGPTAppLink(value)).toBe(false);
});
