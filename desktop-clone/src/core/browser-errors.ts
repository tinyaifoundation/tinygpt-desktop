export class BrowserActionError extends Error {
  constructor(readonly code: 'BROWSER_TARGET_BLOCKED' | 'BROWSER_TARGET_NOT_VISIBLE', readonly blockingDialog?: string) {
    super(code === 'BROWSER_TARGET_BLOCKED' ? 'The control is covered by another element. Inspect the open dialog or overlay before acting.' : 'The control has no visible clickable area. Inspect the current page before acting.');
    this.name = 'BrowserActionError';
  }
}

export function browserPageError(status?: number) {
  return status === 401 ? 'authentication-required' as const : status === 403 ? 'forbidden' as const : status === 404 ? 'not-found' as const : status && status >= 500 ? 'server-error' as const : status && status >= 400 ? 'http-error' as const : undefined;
}
