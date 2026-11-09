import { describe, expect, it } from 'vitest';
import { connectorCallback } from '../plugin-auth/src/callback';
import { SLACK_LOCAL_CALLBACK, SLACK_REDIRECT_URI } from '../src/shared/slack-oauth';
import { connectorSplashIds } from '../src/shared/connector-splashes';

describe('hosted native OAuth return', () => {
  const state = 's'.repeat(43);
  it.each(connectorSplashIds)('uses the clean branded template for %s', async id => {
    const response = connectorCallback(new Request(`https://plugin.tinygpt.org/connect/${id}`)); const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain(`/connector-assets/${id}-v1.webp`); expect(html).toContain('font-family:Figtree');
    expect(html).toContain('href="https://tinygpt.org"'); expect(html).not.toContain('Return to TinyGPT'); expect(html).not.toContain('A secure connection to your desktop'); expect(html).not.toContain('<button');
  });
  it('automatically forwards Slack to the fixed native callback without a manual button', async () => {
    const response = connectorCallback(new Request(`${SLACK_REDIRECT_URI}?state=${state}&code=one-time-code&redirect_uri=https://attacker.invalid`));
    const html = await response.text();
    expect(response.status).toBe(303); expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.has('set-cookie')).toBe(false);
    const target = new URL(response.headers.get('location')!); expect(target.origin + target.pathname).toBe(SLACK_LOCAL_CALLBACK); expect(target.searchParams.get('code')).toBe('one-time-code'); expect(target.searchParams.get('state')).toBe(state); expect(target.searchParams.has('redirect_uri')).toBe(false);
    expect(html).not.toContain('attacker.invalid'); expect(html).not.toContain('fetch(');
  });
  it('refuses incomplete, duplicate, oversized and non-GET callbacks', () => {
    for (const query of ['', '?code=a', `?state=${state}&code=a&code=b`, `?state=${state}&code=a&error=denied`, `?state=${state}&code=${'c'.repeat(4001)}`]) expect(connectorCallback(new Request(SLACK_REDIRECT_URI + query)).status).toBe(400);
    expect(connectorCallback(new Request(`${SLACK_REDIRECT_URI}?state=${state}&code=a`, { method: 'POST' })).status).toBe(400);
  });
  it('does not interpolate authorization text as HTML or executable JavaScript', async () => {
    const code = '</script><script>alert(1)</script>';
    const response = connectorCallback(new Request(`${SLACK_REDIRECT_URI}?state=${state}&code=${encodeURIComponent(code)}`));
    const html = await response.text(); expect(response.status).toBe(303); expect(html).not.toContain(code);
    expect(new URL(response.headers.get('location')!).searchParams.get('code')).toBe(code);
  });
});
