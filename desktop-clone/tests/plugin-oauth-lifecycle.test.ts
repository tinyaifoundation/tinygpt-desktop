import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginStore } from '../src/main/plugin-store';
import { PluginOAuth } from '../src/main/plugin-oauth';
import { connectorManifest } from '../src/shared/connector-catalog';

it('keeps refresh usable after the callback page expires, and denies stale writes after disconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-oauth-lifecycle-'));
  const store = new PluginStore(root, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() });
  await store.load(); const entry = await store.save({ manifest: connectorManifest('notion'), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
  const oauth = new PluginOAuth(store, entry.id, async () => {});
  try {
    await oauth.initialize(); vi.useFakeTimers(); oauth.complete(true); await vi.advanceTimersByTimeAsync(120001);
    await oauth.saveTokens({ access_token: 'refreshed', token_type: 'Bearer', refresh_token: 'next-refresh' });
    expect(oauth.tokens()?.access_token).toBe('refreshed');
    oauth.close(); await store.saveCredentials(entry.id, null);
    await expect(oauth.saveTokens({ access_token: 'stale', token_type: 'Bearer' })).rejects.toThrow('revoked');
    await expect(oauth.invalidateCredentials('all')).rejects.toThrow('revoked'); expect(store.hasCredentials(entry.id)).toBe(false);
  } finally { vi.useRealTimers(); oauth.close(); await store.flush(); await rm(root, { recursive: true, force: true }); }
});

it('requests only read access for Linear and refuses a broader returned grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-linear-scope-'));
  const store = new PluginStore(root, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() });
  await store.load(); const entry = await store.save({ manifest: connectorManifest('linear'), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
  const open = vi.fn(); const oauth = new PluginOAuth(store, entry.id, open);
  try {
    await oauth.initialize(); expect(oauth.clientMetadata.scope).toBe('read');
    const url = new URL('https://mcp.linear.app/authorize'); url.searchParams.set('state', oauth.state()); url.searchParams.set('scope', 'read write');
    await oauth.redirectToAuthorization(url); expect(new URL(open.mock.calls[0][0]).searchParams.get('scope')).toBe('read');
    await oauth.saveTokens({ access_token: 'read-fixture', token_type: 'Bearer', scope: 'read' });
    expect(() => oauth.saveTokens({ access_token: 'broad-fixture', token_type: 'Bearer', scope: 'read write' })).toThrow('read-only');
    expect(oauth.tokens()?.access_token).toBe('read-fixture');
    url.searchParams.set('state', 'wrong'); await expect(oauth.redirectToAuthorization(url)).rejects.toThrow('Invalid authorization');
    expect(open).toHaveBeenCalledOnce();
  } finally { oauth.close(); await store.flush(); await rm(root, { recursive: true, force: true }); }
});
