import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { ConnectorOAuth, googleDesktopClientSchema, SLACK_REDIRECT_URI } from '../src/main/connector-oauth';
import { SLACK_LOCAL_CALLBACK } from '../src/shared/slack-oauth';
import { connectorRegistration } from '../src/main/connector-registrations';
import { PluginStore } from '../src/main/plugin-store';
import { connectorManifest, connectorMatches } from '../src/shared/connector-catalog';
import { ConnectorClient } from '../src/main/connector-tools';
import { PluginService } from '../src/main/plugin-service';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';
import { ToolBroker } from '../src/main/tool-broker';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import { connectorCallback } from '../plugin-auth/src/callback';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(kind: 'gmail' | 'gdrive' | 'gcalendar' | 'github' = 'gmail') {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-connector-auth-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new PluginStore(root, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }); await store.load();
  const entry = await store.save({ manifest: connectorManifest(kind), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
  await store.saveCredentials(entry.id, { connectorAuth: { provider: kind === 'github' ? 'github' : 'google', clientId: kind === 'github' ? 'GithubClient1234' : '1234-test.apps.googleusercontent.com', ...(kind === 'github' ? {} : { clientSecret: 'desktop-client-secret' }) } });
  return { root, store, entry };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
describe('desktop connector authorization', () => {
  it('exchanges and refreshes bundled Google grants through the publisher without a desktop secret', async () => {
    const { store, entry } = await fixture();
    await store.saveCredentials(entry.id, { connectorAuth: connectorRegistration('gmail') });
    const request = vi.fn(async (address, options) => {
      expect(address).toBe('https://plugin.tinygpt.org/oauth/google/token');
      expect(new Headers(options?.headers).get('X-TinyGPT-Connector')).toBe('google');
      expect((options!.body as URLSearchParams).has('client_secret')).toBe(false);
      return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }) as typeof fetch;
    const oauth = new ConnectorOAuth(store, entry.id, async address => { const url = new URL(address); await fetch(`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=approved`); }, () => {}, request);
    cleanup.push(() => oauth.close()); await oauth.authorize('gmail', new AbortController().signal);
    const saved = store.credentials(entry.id)!;
    await store.saveCredentials(entry.id, { connectorAuth: { ...saved.connectorAuth!, expiresAt: 1 } });
    expect(await oauth.token(new AbortController().signal)).toBe('access'); expect(request).toHaveBeenCalledTimes(2);
  });
  it('authorizes Slack with PKCE, user scopes and the registered native redirect, without a secret', async () => {
    const { store, entry } = await fixture();
    await store.saveCredentials(entry.id, { connectorAuth: { provider: 'slack', clientId: '123.456' } });
    let authorization!: URL;
    const request = vi.fn(async (address, options) => {
      expect(address).toBe('https://slack.com/api/oauth.v2.access');
      const params = options!.body as URLSearchParams;
      expect(params.has('client_secret')).toBe(false);
      expect(params.get('redirect_uri')).toBe(SLACK_REDIRECT_URI);
      expect(createHash('sha256').update(params.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
      return json({ ok: true, access_token: 'wrong-bot-token', authed_user: { access_token: 'slack-user-token', refresh_token: 'slack-refresh', expires_in: 43200, scope: 'search:read,chat:write' } });
    }) as typeof fetch;
    const oauth = new ConnectorOAuth(store, entry.id, async address => {
      authorization = new URL(address);
      expect(authorization.origin).toBe('https://slack.com');
      expect(authorization.searchParams.has('scope')).toBe(false);
      expect(authorization.searchParams.get('user_scope')).toContain('search:read');
      expect(authorization.searchParams.get('redirect_uri')).toBe(SLACK_REDIRECT_URI);
      expect((await fetch(`${SLACK_LOCAL_CALLBACK}?state=wrong&code=bad`)).status).toBe(400);
      const hop = connectorCallback(new Request(`${SLACK_REDIRECT_URI}?state=${authorization.searchParams.get('state')}&code=approved`));
      expect(hop.status).toBe(303);
      const callback = hop.headers.get('location')!;
      const response = await fetch(callback); expect(response.status).toBe(200); expect(await response.text()).toContain('TinyGPT');
      expect((await fetch(callback)).status).toBe(400);
    }, () => {}, request);
    cleanup.push(() => oauth.close());
    await oauth.authorize('slack', new AbortController().signal);
    expect(store.credentials(entry.id)?.connectorAuth).toMatchObject({ provider: 'slack', accessToken: 'slack-user-token', refreshToken: 'slack-refresh' });
  });
  it('rotates Slack refresh credentials once for concurrent callers and handles provider revocation', async () => {
    const { store, entry } = await fixture();
    await store.saveCredentials(entry.id, { connectorAuth: { provider: 'slack', clientId: '123.456', accessToken: 'expired', refreshToken: 'old-refresh', expiresAt: 1 } });
    const request = vi.fn(async (address, options) => {
      expect(address).toBe('https://plugin.tinygpt.org/oauth/slack/token');
      expect((options!.body as URLSearchParams).has('client_secret')).toBe(false);
      return json({ ok: true, access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 43200 });
    }) as typeof fetch;
    const oauth = new ConnectorOAuth(store, entry.id, async () => {}, () => {}, request);
    expect(await Promise.all([oauth.token(new AbortController().signal), oauth.token(new AbortController().signal)])).toEqual(['rotated-access', 'rotated-access']);
    expect(request).toHaveBeenCalledOnce();
    expect(store.credentials(entry.id)?.connectorAuth?.refreshToken).toBe('rotated-refresh');
    await store.saveCredentials(entry.id, { connectorAuth: { provider: 'slack', clientId: '123.456', refreshToken: 'revoked' } });
    const revoked = new ConnectorOAuth(store, entry.id, async () => {}, () => {}, vi.fn(async () => json({ ok: false, error: 'invalid_refresh_token' })) as typeof fetch);
    await expect(revoked.token(new AbortController().signal)).rejects.toThrow('Sign in again');
  });
  it('recognizes HTTP 400 Google invalid_grant as a sign-in requirement', async () => {
    const { store, entry } = await fixture();
    await store.saveCredentials(entry.id, { connectorAuth: { provider: 'google', clientId: 'test', refreshToken: 'revoked' } });
    const oauth = new ConnectorOAuth(store, entry.id, async () => {}, () => {}, vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch);
    await expect(oauth.token(new AbortController().signal)).rejects.toThrow('Sign in again');
  });
  it('validates Desktop client files and ignores untrusted endpoint fields', () => { expect(googleDesktopClientSchema.parse({ installed: { client_id: '1234-test.apps.googleusercontent.com', client_secret: 'secret', token_uri: 'https://attacker.invalid' } }).installed).not.toHaveProperty('token_uri'); expect(googleDesktopClientSchema.safeParse({ web: { client_id: '1234-test.apps.googleusercontent.com', client_secret: 'secret' } }).success).toBe(false); });
  it('requests separate read-only Calendar consent without Gmail or Drive permissions', async () => {
    const { store, entry } = await fixture('gcalendar'); const request = vi.fn(async () => json({ access_token: 'calendar-token', refresh_token: 'calendar-refresh' })) as typeof fetch;
    const oauth = new ConnectorOAuth(store, entry.id, async address => { const url = new URL(address); const scopes = url.searchParams.get('scope'); expect(scopes).toContain('calendar.readonly'); expect(scopes).not.toContain('gmail'); expect(scopes).not.toContain('drive'); await fetch(`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=approved`); }, () => {}, request); cleanup.push(() => oauth.close()); await oauth.authorize('gcalendar', new AbortController().signal, true); expect(store.credentials(entry.id)?.connectorAuth?.scope).toContain('calendar.readonly');
  });
  it('routes bounded Calendar reads with encoded calendar IDs and timezone-aware ranges', async () => {
    const calls: { url: string; options?: RequestInit }[] = []; const request = (async (url, options) => { calls.push({ url: String(url), options }); return json({ items: [{ summary: 'Fixture Calendar' }], calendars: {} }); }) as typeof fetch;
    const client = new ConnectorClient('gcalendar', () => 'fixture-token', request); expect(await client.health(new AbortController().signal)).toEqual({ name: 'Fixture Calendar' }); expect(client.tools().every(tool => tool.category === 'read')).toBe(true);
    const list = client.tools().find(tool => tool.name === 'list_events')!; const input = list.schema.parse({ calendarId: 'name+calendar@example.org', timeMin: '2026-10-12T09:00:00-04:00', timeMax: '2026-10-13T09:00:00-04:00' }) as Record<string, unknown>; await list.run(input, new AbortController().signal); const url = new URL(calls.at(-1)!.url); expect(url.pathname).toContain('name%2Bcalendar%40example.org'); expect(url.searchParams.get('singleEvents')).toBe('true'); expect(url.searchParams.get('timeMin')).toBe(input.timeMin); expect(list.schema.safeParse({ ...input, timeMax: input.timeMin }).success).toBe(false); expect(list.schema.safeParse({ ...input, timeMin: '2026-10-12T09:00:00' }).success).toBe(false);
    const free = client.tools().find(tool => tool.name === 'check_availability')!; await free.run({ ...input, calendars: ['primary'] }, new AbortController().signal); expect(JSON.parse(String(calls.at(-1)!.options?.body)).items).toEqual([{ id: 'primary' }]); expect(calls.at(-1)!.options?.method).toBe('POST'); expect(await client.resources('', new AbortController().signal)).toEqual([]);
  });
  it('uses a real loopback listener, rejects wrong state, exchanges PKCE, and refreshes credentials', async () => {
    const { store, entry } = await fixture(); let authorization: URL; const exchanges: URLSearchParams[] = [];
    const request = vi.fn(async (_url, options) => { const body = new URLSearchParams(String(options?.body)); exchanges.push(body); if (body.get('grant_type') === 'refresh_token') return json({ access_token: 'refreshed-token', expires_in: 3600 }); expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge')); return json({ access_token: 'first-token', refresh_token: 'durable-refresh', expires_in: 1 }); }) as typeof fetch;
    const oauth = new ConnectorOAuth(store, entry.id, async url => { authorization = new URL(url); expect(authorization.origin).toBe('https://accounts.google.com'); expect(authorization.searchParams.get('scope')).toContain('gmail.readonly'); expect(authorization.searchParams.get('scope')).not.toContain('gmail.send'); const redirect = authorization.searchParams.get('redirect_uri')!; expect((await fetch(`${redirect}?state=wrong&code=bad`)).status).toBe(400); expect((await fetch(`${redirect}?state=${authorization.searchParams.get('state')}&code=valid-code`)).status).toBe(200); }, () => {}, request);
    cleanup.push(() => oauth.close()); await oauth.authorize('gmail', new AbortController().signal); expect(exchanges[0].get('code')).toBe('valid-code'); expect(await oauth.token(new AbortController().signal)).toBe('refreshed-token'); expect(store.credentials(entry.id)?.connectorAuth?.refreshToken).toBe('durable-refresh'); expect(exchanges[1].get('refresh_token')).toBe('durable-refresh');
  });
  it('closes cancellation callbacks and does not save a token after credentials are revoked', async () => {
    const { store, entry } = await fixture(); const saved = store.credentials(entry.id)!; await store.saveCredentials(entry.id, { connectorAuth: { ...saved.connectorAuth!, refreshToken: 'refresh', accessToken: 'expired', expiresAt: 1 } });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const request = vi.fn(async () => { await gate; return json({ access_token: 'must-not-be-restored', expires_in: 3600 }); }) as typeof fetch;
    const oauth = new ConnectorOAuth(store, entry.id, async () => {}, () => {}, request); const pending = oauth.token(new AbortController().signal); await vi.waitFor(() => expect(request).toHaveBeenCalled()); await store.saveCredentials(entry.id, null); release(); await expect(pending).rejects.toThrow('revoked'); expect(store.hasCredentials(entry.id)).toBe(false);
    await store.saveCredentials(entry.id, saved); const controller = new AbortController(); let callback = ''; const cancelled = new ConnectorOAuth(store, entry.id, async url => { callback = new URL(url).searchParams.get('redirect_uri')!; controller.abort(); }, () => {}, request); await expect(cancelled.authorize('gmail', controller.signal)).rejects.toThrow('cancelled'); await expect(fetch(callback)).rejects.toThrow();
  });
  it('uses GitHub device authorization without a client secret', async () => {
    const { store, entry } = await fixture('github'); const calls: URLSearchParams[] = []; const progress = vi.fn(); const open = vi.fn(async () => {});
    const request = vi.fn(async (_url, options) => { const body = new URLSearchParams(String(options?.body)); calls.push(body); return body.has('device_code') ? json({ access_token: 'github-authorized-token', scope: 'repo read:user' }) : json({ device_code: 'private-device-code', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 180 }); }) as typeof fetch;
    await new ConnectorOAuth(store, entry.id, open, progress, request).authorize('github', new AbortController().signal); expect(open).toHaveBeenCalledWith('https://github.com/login/device'); expect(progress).toHaveBeenCalledWith(expect.any(String), 'ABCD-1234'); expect(calls.every(body => !body.has('client_secret'))).toBe(true); expect(store.credentials(entry.id)?.connectorAuth?.accessToken).toBe('github-authorized-token');
  });
  it('separates Gmail and Drive tools and excludes sending without the granted scope', async () => {
    const gmail = new ConnectorClient('gmail', () => 'token', fetch, () => 'https://www.googleapis.com/auth/gmail.readonly'); expect(gmail.tools().map(tool => tool.name)).toEqual(['get_mail_profile', 'search_mail', 'read_mail']); expect(new ConnectorClient('gdrive', () => 'token').tools().map(tool => tool.name)).toEqual(['search_drive', 'read_document']);
    const request = vi.fn(async () => json({ id: 'm1', threadId: 't1', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 'Action required' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Please approve the launch.').toString('base64url') } }] } })) as typeof fetch;
    const tool = new ConnectorClient('gmail', () => 'token', request).tools().find(tool => tool.name === 'read_mail')!; expect(await tool.run({ messageId: 'm1' }, new AbortController().signal)).toMatchObject({ text: 'Please approve the launch.', url: 'https://mail.google.com/mail/u/0/#all/t1' });
  });
  it('resolves self-addressed email inside the connector and refuses guessed recipients', async () => {
    const calls: { url: string; options?: RequestInit }[] = [];
    const request = vi.fn(async (url, options) => { calls.push({ url: String(url), options }); return json(String(url).endsWith('/profile') ? { emailAddress: 'connected@example.org' } : { id: 'sent-fixture' }); }) as typeof fetch;
    const tool = new ConnectorClient('gmail', () => 'fixture-token', request).tools().find(tool => tool.name === 'send_mail_to_self')!;
    expect(tool.schema.safeParse({ subject: 'Report', text: 'Evidence', to: 'invented@example.org' }).success).toBe(false);
    expect(await tool.run({ subject: 'Report', text: 'Evidence' }, new AbortController().signal)).toEqual({ id: 'sent-fixture', to: 'connected@example.org' });
    expect(calls.map(call => call.url)).toEqual(['https://gmail.googleapis.com/gmail/v1/users/me/profile', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send']);
    expect(Buffer.from(JSON.parse(String(calls[1].options!.body)).raw, 'base64url').toString()).toMatch(/^To: connected@example.org\r\n/);
    const invalid = vi.fn(async () => json({ emailAddress: 'invalid\r\nBcc: another@example.org' })) as typeof fetch;
    await expect(new ConnectorClient('gmail', () => 'fixture-token', invalid).tools().find(tool => tool.name === 'send_mail_to_self')!.run({ subject: 'Report', text: 'Evidence' }, new AbortController().signal)).rejects.toThrow();
    expect(invalid).toHaveBeenCalledTimes(1);
  });
  it('refreshes GitHub device tokens once for concurrent calls and rotates the saved pair', async () => {
    const { store, entry } = await fixture('github'); const saved = store.credentials(entry.id)!;
    await store.saveCredentials(entry.id, { connectorAuth: { ...saved.connectorAuth!, accessToken: 'expired-github-token', refreshToken: 'old-github-refresh', expiresAt: 1, scope: 'repo,read:user' } });
    const request = vi.fn(async (url, options) => {
      expect(url).toBe('https://github.com/login/oauth/access_token');
      const body = new URLSearchParams(String(options?.body)); expect(Object.fromEntries(body)).toEqual({ client_id: 'GithubClient1234', refresh_token: 'old-github-refresh', grant_type: 'refresh_token' });
      return json({ access_token: 'new-github-token', refresh_token: 'new-github-refresh', expires_in: 28800 });
    }) as typeof fetch;
    const oauth = new ConnectorOAuth(store, entry.id, async () => {}, () => {}, request);
    expect(await Promise.all([oauth.token(new AbortController().signal), oauth.token(new AbortController().signal)])).toEqual(['new-github-token', 'new-github-token']);
    expect(request).toHaveBeenCalledOnce(); expect(store.credentials(entry.id)?.connectorAuth).toMatchObject({ accessToken: 'new-github-token', refreshToken: 'new-github-refresh', scope: 'repo,read:user' });
    expect(store.credentials(entry.id)?.connectorAuth?.expiresAt).toBeGreaterThan(Date.now() + 28700000);
  });
  it('requires GitHub sign-in when the refresh token is refused and preserves the saved pair', async () => {
    const { store, entry } = await fixture('github'); const saved = { connectorAuth: { ...store.credentials(entry.id)!.connectorAuth!, accessToken: 'expired-token', refreshToken: 'invalid-refresh', expiresAt: 1 } };
    await store.saveCredentials(entry.id, saved);
    const oauth = new ConnectorOAuth(store, entry.id, async () => {}, () => {}, vi.fn(async () => json({ error: 'bad_refresh_token' })) as typeof fetch);
    await expect(oauth.token(new AbortController().signal)).rejects.toThrow('Sign in again'); expect(store.credentials(entry.id)).toEqual(saved);
  });
});
describe('complete browser sign-in', () => {
  async function browserFixture(refused = false) {
    const { store, root, entry } = await fixture(); const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
    const nativeFetch = fetch; const focus = vi.fn(); let callback = ''; let html = ''; let key = ''; let release!: () => void;
    const healthGate = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn(async (url) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'authorized-token', refresh_token: 'refresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
      expect(String(url)).toContain('/gmail/v1/users/me/profile'); await healthGate;
      return refused ? new Response('{}', { status: 403 }) : json({ emailAddress: 'fixture@example.org' });
    }) as typeof fetch; vi.stubGlobal('fetch', request);
    const service = new PluginService(store, history, new ProjectFiles(history.sources), () => {}, () => true, async url => {
      const auth = new URL(url); callback = `${auth.searchParams.get('redirect_uri')}?state=${auth.searchParams.get('state')}&code=secret-authorization-code`;
      const response = await nativeFetch(callback); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'"); html = await response.text(); key = html.match(/const key="([A-Za-z0-9_-]+)"/)![1];
      expect(html).not.toContain('Return to TinyGPT'); expect(html).not.toContain('<button'); expect(html).toContain('You can close this tab.'); expect(html).toContain('tinygpt://open'); expect(html).not.toContain('secret-authorization-code'); expect(html).not.toContain(auth.searchParams.get('state'));
    }, focus); await service.initialize(); cleanup.push(() => service.shutdown());
    const pending = service.signIn(entry.id); await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const origin = new URL(callback).origin;
    const status = async () => (await nativeFetch(`${origin}/oauth/status`, { headers: { 'X-TinyGPT-Return': key } })).json();
    return { service, store, entry, pending, nativeFetch, callback, origin, html, key, focus, release, status };
  }
  it('completes authorization and health within one session, with clean completion and a protected legacy focus endpoint', async () => {
    const f = await browserFixture(); expect(f.service.snapshot().entries.find(item => item.id === f.entry.id)?.status).toBe('connecting'); expect(await f.status()).toMatchObject({ status: 'pending' });
    expect((await f.nativeFetch(f.callback)).status).toBe(400);
    expect((await f.nativeFetch(`${f.origin}/oauth/return`, { method: 'POST' })).status).toBe(403);
    expect((await f.nativeFetch(`${f.origin}/oauth/return`, { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'X-TinyGPT-Return': f.key } })).status).toBe(403); expect(f.focus).not.toHaveBeenCalled();
    f.release(); const snapshot = await f.pending; expect(snapshot.entries.find(item => item.id === f.entry.id)).toMatchObject({ status: 'connected', account: { email: 'fixture@example.org' } });
    expect(await f.status()).toMatchObject({ status: 'connected' });
    expect((await f.nativeFetch(`${f.origin}/oauth/return`, { method: 'POST', headers: { Origin: f.origin, 'X-TinyGPT-Return': f.key } })).status).toBe(204); expect(f.focus).toHaveBeenCalledOnce();
    expect(JSON.stringify(snapshot)).not.toContain('authorized-token'); expect(f.store.credentials(f.entry.id)?.connectorAuth?.refreshToken).toBe('refresh-token');
    await f.service.disconnect(f.entry.id); await expect(f.status()).rejects.toThrow();
  });
  it('shows failure instead of claiming connection when the account health check is refused', async () => {
    const f = await browserFixture(true); f.release(); const snapshot = await f.pending;
    expect(snapshot.entries.find(item => item.id === f.entry.id)).toMatchObject({ status: 'error', message: 'The connected account does not permit this action. Check its permissions before retrying.' });
    expect(await f.status()).toMatchObject({ status: 'error', message: 'The connected account does not permit this action. Check its permissions before retrying.' });
  });
  it('does not restore a session disconnected while account health is pending', async () => {
    const f = await browserFixture(); await f.service.disconnect(f.entry.id); f.release(); await f.pending;
    expect(f.service.snapshot().entries.find(item => item.id === f.entry.id)?.status).toBe('disconnected'); await expect(f.status()).rejects.toThrow();
  });
});

describe('connection requests', () => {
  it('uses the shipped Google registration on a fresh installation without exposing it or asking for developer details', async () => {
    const { store, root, entry } = await fixture(); await store.saveCredentials(entry.id, null);
    const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
    const nativeFetch = fetch;
    vi.stubGlobal('fetch', vi.fn(async address => String(address).includes('/token') ? json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh' }) : json({ emailAddress: 'fresh@example.org' })));
    const service = new PluginService(store, history, new ProjectFiles(history.sources), () => {}, () => true, async address => {
      const url = new URL(address); expect(url.searchParams.get('client_id')).toBe(connectorRegistration('gmail')?.clientId);
      await nativeFetch(`${url.searchParams.get('redirect_uri')}?state=${url.searchParams.get('state')}&code=approved`);
    });
    await service.initialize(); cleanup.push(() => service.shutdown());
    expect(service.snapshot().entries.find(item => item.id === entry.id)?.oauthConfigured).toBe(true);
    expect((await service.signIn(entry.id)).entries.find(item => item.id === entry.id)?.status).toBe('connected');
    expect(store.credentials(entry.id)?.connectorAuth?.refreshToken).toBe('fresh-refresh');
    expect(JSON.stringify(service.snapshot())).not.toContain('fresh-refresh');
  });
  it('restores saved direct OAuth accounts after restart without browser authorization, and respects disabled entries', async () => {
    const { store, root, entry } = await fixture();
    await store.saveCredentials(entry.id, { connectorAuth: { provider: 'google', clientId: 'test', accessToken: 'saved-access', refreshToken: 'saved-refresh', expiresAt: Date.now() + 3600000 } });
    const disabled = await store.save({ manifest: connectorManifest('github'), config: { enabled: false, projectIds: null, resources: [], rules: {} } });
    await store.saveCredentials(disabled.id, { connectorAuth: { provider: 'github', clientId: 'test', accessToken: 'disabled-token' } });
    const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
    const request = vi.fn(async () => json({ emailAddress: 'restored@example.org' })); vi.stubGlobal('fetch', request);
    const open = vi.fn(); const service = new PluginService(new PluginStore(root, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }), history, new ProjectFiles(history.sources), () => {}, () => true, open);
    await service.initialize(); cleanup.push(() => service.shutdown());
    await vi.waitFor(() => expect(service.snapshot().entries.find(item => item.id === entry.id)?.status).toBe('connected'));
    expect(open).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
    expect(service.snapshot().entries.find(item => item.id === disabled.id)?.status).toBe('disabled');
  });
  it('adds the official Notion hosted server idempotently and rejects a substituted endpoint', async () => {
    const { store, root } = await fixture(); const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close()); const service = new PluginService(store, history, new ProjectFiles(history.sources)); await service.initialize(); cleanup.push(() => service.shutdown()); await service.installConnector('notion'); await service.installConnector('notion'); const entries = store.entries().filter(entry => entry.manifest.id === 'connector-notion'); expect(entries).toHaveLength(1); expect(entries[0].manifest.server).toEqual({ transport: 'http', endpoint: 'https://mcp.notion.com/mcp', auth: 'oauth' }); expect(connectorMatches(entries[0].manifest, 'notion')).toBe(true); expect(connectorMatches({ ...entries[0].manifest, server: { transport: 'http', endpoint: 'https://attacker.invalid', auth: 'oauth' } }, 'notion')).toBe(false); expect(store.hasCredentials(entries[0].id)).toBe(false);
  });
  it.each([
    ['higgsfield', 'https://mcp.higgsfield.ai/mcp'],
    ['linear', 'https://mcp.linear.app/mcp/readonly'],
  ] as const)('adds %s once and rejects substituted or unauthenticated servers', async (kind, endpoint) => {
    const { store, root } = await fixture(); const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
    const service = new PluginService(store, history, new ProjectFiles(history.sources)); await service.initialize(); cleanup.push(() => service.shutdown());
    await service.installConnector(kind); await service.installConnector(kind);
    const entries = store.entries().filter(entry => entry.manifest.id === `connector-${kind}`); expect(entries).toHaveLength(1);
    const manifest = entries[0].manifest; expect(manifest.server).toEqual({ transport: 'http', endpoint, auth: 'oauth' });
    expect(connectorMatches(manifest, kind)).toBe(true);
    expect(connectorMatches({ ...manifest, server: { transport: 'http', endpoint: endpoint + '/other', auth: 'oauth' } }, kind)).toBe(false);
    expect(connectorMatches({ ...manifest, server: { transport: 'http', endpoint, auth: 'none' } }, kind)).toBe(false);
    expect(store.hasCredentials(entries[0].id)).toBe(false);
  });
  it('reuses a Google app registration for Drive without copying Gmail account access', async () => {
    const { store, root, entry } = await fixture(); const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
    const auth = { ...store.credentials(entry.id)!.connectorAuth!, accessToken: 'gmail-private-token', refreshToken: 'gmail-private-refresh', scope: 'https://www.googleapis.com/auth/gmail.readonly', expiresAt: 1 }; await store.saveCredentials(entry.id, { connectorAuth: auth });
    const service = new PluginService(store, history, new ProjectFiles(history.sources)); await service.initialize(); cleanup.push(() => service.shutdown());
    const snapshot = await service.installConnector('gdrive'); const drive = snapshot.entries.find(item => item.manifest.connector === 'gdrive')!;
    expect(drive).toMatchObject({ status: 'disconnected', oauthConfigured: true, tools: [] });
    expect(store.credentials(drive.id)).toEqual({ connectorAuth: { provider: 'google', clientId: auth.clientId, clientSecret: auth.clientSecret } }); expect(store.credentials(entry.id)).toEqual({ connectorAuth: auth });
    expect(JSON.stringify(snapshot)).not.toContain('gmail-private'); expect(JSON.stringify(snapshot)).not.toContain(auth.clientSecret);
    await service.credentials(drive.id, { bearer: 'separate-drive-token' }); await service.installConnector('gdrive'); expect(store.credentials(drive.id)).toEqual({ bearer: 'separate-drive-token' });
  });
  it('uses the bundled registration without copying conflicting saved Google registrations', async () => {
    const { store, root } = await fixture(); const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
    const legacy = await store.save({ manifest: { ...connectorManifest('gmail'), id: 'legacy-google', connector: 'google' }, config: { enabled: true, projectIds: null, rules: {}, resources: [] } }); await store.saveCredentials(legacy.id, { connectorAuth: { provider: 'google', clientId: 'other.apps.googleusercontent.com', clientSecret: 'other-secret' } });
    const service = new PluginService(store, history, new ProjectFiles(history.sources)); await service.initialize(); cleanup.push(() => service.shutdown());
    const drive = (await service.installConnector('gdrive')).entries.find(item => item.manifest.connector === 'gdrive')!; expect(drive.oauthConfigured).toBe(true); expect(store.hasCredentials(drive.id)).toBe(false);
  });
  it('offers a persistent card without data access and requires the matching ready connector before resuming', async () => {
    const { store, root } = await fixture('github'); const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close()); const files = new ProjectFiles(history.sources); const service = new PluginService(store, history, files); await service.initialize(); cleanup.push(() => service.shutdown()); const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'deny'; const broker = new ToolBroker(history, () => settings, {} as BrowserController, files, () => {}, undefined, service);
    const conversation = history.createConversation(null); const turn = history.startTurn(conversation.id, 'Check my email.', 'local'); const id = randomUUID(); const request = vi.fn(async () => json({ login: 'fixture-account' })) as typeof fetch; vi.stubGlobal('fetch', request);
    const result = await broker.execute({ conversationId: conversation.id, runId: turn.runId, signal: new AbortController().signal }, { id, name: 'request_plugin_connection', input: { connector: 'gmail', reason: 'Read the morning action items.' } }); expect(JSON.parse(result).status).toBe('pending'); expect(request).not.toHaveBeenCalled(); history.saveReply(turn.assistantId, '', 'complete');
    const blocked = await broker.execute({ conversationId: conversation.id, runId: turn.runId, signal: new AbortController().signal }, { id: randomUUID(), name: 'search_web', input: { query: 'Bypass the account connection' } }); expect(JSON.parse(blocked).error).toContain('waiting for the user'); expect(request).not.toHaveBeenCalled(); expect(history.conversation(conversation.id).tools).toHaveLength(1);
    await expect(service.acceptConnection(conversation.id, id, store.entries().find(item => item.manifest.connector === 'github')!.id)).rejects.toThrow('match'); await service.installConnector('gmail'); const gmail = store.entries().find(item => item.manifest.connector === 'gmail')!; await expect(service.acceptConnection(conversation.id, id, gmail.id)).rejects.toThrow('Connect');
    await store.saveCredentials(gmail.id, { bearer: 'fixture-token' }); await service.connect(gmail.id); expect(JSON.stringify(service.snapshot())).not.toContain('fixture-token'); await service.acceptConnection(conversation.id, id, gmail.id); service.finishConnectionRequest(conversation.id, id, 'connected'); const resumed = history.startTurn(conversation.id, null, 'local', [], { type: 'resume-plugin', messageId: turn.assistantId }); expect(resumed.conversation.messages.filter(message => message.role === 'user')).toHaveLength(1); expect(resumed.conversation.messages.at(-1)?.parentId).toBe(turn.assistantId); expect(service.prepare(conversation.id, resumed.runId, null, 'chat').tools.some(tool => tool.originalName === 'search_mail')).toBe(true); expect(() => service.connectionRequest(conversation.id, id)).toThrow('no longer');
  });
});
