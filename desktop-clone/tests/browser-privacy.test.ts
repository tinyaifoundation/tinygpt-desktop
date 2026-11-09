import { describe, expect, it } from 'vitest';
import { blockedBrowserRequest, browserAddressLabel, browserHeaders, browserLinkDestination, browserUserAgent } from '../src/core/browser-privacy';
import { browserPreferencesSchema, defaultSettings, settingsSchema } from '../src/shared/config';

describe('browser privacy and preferences', () => {
  it('upgrades existing engine-only settings to the v2 browser defaults', () => {
    const parsed = settingsSchema.parse({ ...defaultSettings, browser: { engine: 'brave' } });
    expect(parsed.browser).toEqual({ engine: 'brave', adBlock: true, showFullUrl: false, webLinkDestination: 'workspace', localLinkDestination: 'workspace' });
  });
  it('blocks tracker subresources and subdomains without blocking their main pages or lookalike hosts', () => {
    expect(blockedBrowserRequest('https://pixel.google-analytics.com/collect', 'script', true)).toBe(true);
    expect(blockedBrowserRequest('https://google-analytics.com./collect', 'image', true)).toBe(true);
    expect(blockedBrowserRequest('https://google-analytics.com/', 'mainFrame', true)).toBe(false);
    expect(blockedBrowserRequest('https://google-analytics.com.evil.test/collect', 'script', true)).toBe(false);
    expect(blockedBrowserRequest('https://notgoogle-analytics.com/collect', 'script', true)).toBe(false);
    expect(blockedBrowserRequest('https://google-analytics.com/collect', 'script', false)).toBe(false);
    expect(blockedBrowserRequest('data:text/plain,hello', 'script', true)).toBe(false);
  });
  it('keeps verification, logins, and ordinary content available', () => {
    for (const host of ['challenges.cloudflare.com', 'www.google.com', 'www.gstatic.com', 'accounts.google.com', 'github.com']) expect(blockedBrowserRequest(`https://${host}/`, 'script', true)).toBe(false);
  });
  it('uses the installed Chromium version and correct desktop platform', () => {
    expect(browserUserAgent('150.0.1.2', 'win32')).toContain('Windows NT 10.0; Win64; x64');
    expect(browserUserAgent('150.0.1.2', 'darwin')).toContain('Macintosh');
    expect(browserUserAgent('150.0.1.2', 'linux')).toContain('Chrome/150.0.1.2');
    expect(browserUserAgent('150.0.1.2', 'win32')).not.toMatch(/TinyGPT|Electron/);
  });
  it('normalizes browser identification without removing cookies, auth, or the chosen language', () => {
    const headers = browserHeaders({ 'user-agent': 'TinyGPT Electron/44', 'Sec-CH-UA': '"Chromium";v="150", "Electron";v="44", "Not A Brand";v="99"', Cookie: 'signed-in=yes', Authorization: 'Bearer fixture', 'accept-language': 'fr-FR' }, 'Chrome fixture', 'en-US');
    expect(headers['User-Agent']).toBe('Chrome fixture'); expect(headers['user-agent']).toBeUndefined();
    expect(headers['Sec-CH-UA']).toBe('"Chromium";v="150", "Not A Brand";v="99"');
    expect(headers.Cookie).toBe('signed-in=yes'); expect(headers.Authorization).toBe('Bearer fixture'); expect(headers['accept-language']).toBe('fr-FR');
    expect(browserHeaders({}, 'Chrome fixture', 'en-US')['Accept-Language']).toBe('en-US,en;q=0.9');
  });
  it('routes loopback and public links independently', () => {
    const preferences = browserPreferencesSchema.parse({ localLinkDestination: 'system' });
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) expect(browserLinkDestination(url, preferences)).toBe('system');
    expect(browserLinkDestination('https://localhost.example.com', preferences)).toBe('workspace');
    expect(browserPreferencesSchema.safeParse({ webLinkDestination: 'shell' }).success).toBe(false);
  });
  it('shows the full editable address or a compact host without losing local ports', () => {
    const url = 'http://localhost:3000/work?draft=yes#preview';
    expect(browserAddressLabel(url, false)).toBe('localhost:3000'); expect(browserAddressLabel(url, true)).toBe(url);
  });
});
