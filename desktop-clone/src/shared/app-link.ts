// Opening TinyGPT is the only deep-link action. OAuth codes, tokens, file paths
// and commands must continue through their dedicated authenticated flows.
export const tinygptAppLink = 'tinygpt://open';
export function isTinyGPTAppLink(value: string): boolean {
  return value === tinygptAppLink || value === tinygptAppLink + '/';
}
