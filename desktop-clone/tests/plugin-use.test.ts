import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import { PluginStore } from '../src/main/plugin-store';
import { PluginService } from '../src/main/plugin-service';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { connectorManifest } from '../src/shared/connector-catalog';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.unstubAllGlobals(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-plugin-use-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: { url: string; method?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (address, options) => {
    const url = new URL(String(address)); requests.push({ url: url.href, method: options?.method });
    expect(url.hostname).toBe('gmail.googleapis.com');
    return Response.json(url.pathname.endsWith('/profile') ? { emailAddress: 'fixture@example.org' } : url.pathname.endsWith('/messages') ? { messages: [{ id: 'exact-mail' }] } : { id: 'exact-mail', payload: { headers: [{ name: 'Subject', value: 'Approval requested' }] } });
  }));
  async function open() {
    const history = new HistoryStore(join(root, 'library.sqlite'));
    const store = new PluginStore(root, { available: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() });
    let broker: ToolBroker;
    const settings = structuredClone(defaultSettings);
    const service = new PluginService(store, history, new ProjectFiles(history.sources), () => broker?.revokeUnavailableExtensions());
    await service.initialize();
    broker = new ToolBroker(history, () => settings, {} as BrowserController, new ProjectFiles(history.sources), () => {}, undefined, service);
    let closed = false; const close = async () => { if (!closed) { closed = true; await service.shutdown(); history.close(); } }; cleanup.push(close);
    return { history, store, service, broker, settings, close };
  }
  const host = await open();
  const entry = await host.store.save({ manifest: connectorManifest('gmail'), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
  await host.service.credentials(entry.id, { bearer: 'synthetic-mail-token' }); await host.service.connect(entry.id);
  const chat = host.history.createConversation(null);
  return { ...host, requests, entry, chat, open };
}
function run(f: Awaited<ReturnType<typeof fixture>>, conversationId = f.chat.id) {
  const runId = randomUUID(); const controller = new AbortController();
  const capture = f.service.prepare(conversationId, runId, null, 'chat');
  const call = (name: string, input: unknown = {}) => f.broker.execute({ conversationId, runId, signal: controller.signal }, { id: randomUUID(), name: name as `ext_${string}`, input });
  return { controller, load: () => call('load_tools', { group: 'services', query: 'Gmail' }), call, tool: (name: string) => capture.tools.find(tool => tool.originalName === name)!.name };
}
async function pending(f: Awaited<ReturnType<typeof fixture>>) { await vi.waitFor(() => expect(f.broker.approvals()).toHaveLength(1)); return f.broker.approvals()[0]; }
it('asks inline before loading a connected plugin, then allows reads across turns and restart', async () => {
  const f = await fixture(); const r = run(f); const before = f.requests.length;
  // Discovery lists names, without requiring account access or granting consent.
  const discovered = await r.call('load_tools', { group: 'services', query: '' }); expect(JSON.parse(discovered).toolNames).toEqual([]); expect(f.broker.approvals()).toEqual([]);
  const loading = r.load(); const approval = await pending(f);
  expect(approval.pluginUse).toMatchObject({ pluginId: f.entry.id, name: 'Gmail', connector: 'gmail' });
  expect(f.requests).toHaveLength(before); expect(f.history.conversation(f.chat.id).tools.some(tool => tool.id === approval.id && tool.status === 'pending' && JSON.parse(tool.result!).type === 'plugin-use-request')).toBe(true);
  f.broker.respond(approval.id, 'allow-conversation'); expect(JSON.parse(await loading).enabled).toBe('services');
  expect(JSON.parse(await r.call(r.tool('get_mail_profile'))).emailAddress).toBe('fixture@example.org');
  const next = run(f); await next.load(); await next.call(next.tool('search_mail'), { query: 'in:inbox' }); expect(f.broker.approvals()).toEqual([]);
  const scope = f.service.useAuthorization(f.chat.id, f.entry.id)!.scope; expect(f.history.hasConversationGrant(f.chat.id, scope)).toBe(true);
  await f.close(); const reopened = await f.open(); await reopened.service.connect(f.entry.id);
  const resumed = { ...f, ...reopened }; expect(resumed.service.useAuthorization(f.chat.id, f.entry.id)!.scope).toBe(scope);
  await run(resumed).load(); expect(resumed.broker.approvals()).toEqual([]);
});
it('gates direct extension calls, asks separately in another chat, and preserves action approvals', async () => {
  const f = await fixture(); const r = run(f); const first = r.call(r.tool('get_mail_profile')); const use = await pending(f);
  f.broker.respond(use.id, 'allow-conversation'); await first;
  const send = r.call(r.tool('send_mail_to_self'), { subject: 'Synthetic report', text: 'Fixture only' }); const action = await pending(f);
  expect(action.pluginUse).toBeUndefined(); expect(action.name).toBe(r.tool('send_mail_to_self'));
  f.broker.respond(action.id, 'deny'); expect(JSON.parse(await send).error).toContain('denied'); expect(f.requests.every(request => request.method === 'GET')).toBe(true);
  f.settings.toolPermissions.read = 'deny'; const before = f.requests.length;
  expect(JSON.parse(await r.call(r.tool('get_mail_profile'))).error).toContain('blocked'); expect(f.requests).toHaveLength(before);
  f.settings.toolPermissions.read = 'allow';
  const another = f.history.createConversation(null); const other = run(f, another.id); const loading = other.load();
  expect((await pending(f)).conversationId).toBe(another.id); f.broker.respond(f.broker.approvals()[0].id, 'deny'); await loading;
});
it('decline blocks retries in the current task; cancellation does not create a grant', async () => {
  const f = await fixture(); const r = run(f); const before = f.requests.length;
  const denied = r.load(); f.broker.respond((await pending(f)).id, 'deny'); expect(JSON.parse(await denied).code).toBe('PLUGIN_USE_DENIED');
  expect(JSON.parse(await r.load()).code).toBe('PLUGIN_USE_DENIED'); expect(JSON.parse(await r.call(r.tool('get_mail_profile'))).code).toBe('PLUGIN_USE_DENIED'); expect(f.broker.approvals()).toEqual([]); expect(f.requests).toHaveLength(before);
  const next = run(f); const waiting = next.load(); const rejected = expect(waiting).rejects.toThrow('Cancelled'); await pending(f); next.controller.abort(); await rejected;
  expect(f.broker.approvals()).toEqual([]); expect(f.history.hasConversationGrant(f.chat.id, f.service.useAuthorization(f.chat.id, f.entry.id)!.scope)).toBe(false);
});
it('revocation while the card is pending prevents consent and changed account credentials require it again', async () => {
  const f = await fixture(); const r = run(f); const waiting = r.load(); await pending(f); await f.service.disconnect(f.entry.id);
  expect(JSON.parse(await waiting).code).toBe('PLUGIN_USE_DENIED'); expect(f.broker.approvals()).toEqual([]);
  await f.service.connect(f.entry.id); const another = run(f); const allowed = another.load(); f.broker.respond((await pending(f)).id, 'allow-conversation'); await allowed;
  const oldScope = f.service.useAuthorization(f.chat.id, f.entry.id)!.scope;
  // Internal token refresh writes must not invalidate a conversation's consent.
  const previous = f.store.credentials(f.entry.id)!;
  await f.store.saveCredentials(f.entry.id, { bearer: 'rotated-synthetic-token' }, previous);
  expect(f.service.useAuthorization(f.chat.id, f.entry.id)!.scope).toBe(oldScope);
  await f.service.credentials(f.entry.id, { bearer: 'different-synthetic-account' }); await f.service.connect(f.entry.id);
  expect(f.service.useAuthorization(f.chat.id, f.entry.id)!.scope).not.toBe(oldScope);
  const changed = run(f).load(); f.broker.respond((await pending(f)).id, 'deny'); await changed;
});
it('keeps explicit additional-account-access requests on the connection flow', async () => {
  const f = await fixture();
  await f.service.credentials(f.entry.id, { connectorAuth: { provider: 'google', clientId: 'synthetic-client', accessToken: 'synthetic-read-only-token', scope: 'https://www.googleapis.com/auth/gmail.readonly', expiresAt: Date.now() + 3600000 } });
  await f.service.connect(f.entry.id); const r = run(f);
  const result = JSON.parse(await r.call('load_tools', { group: 'services', query: 'Gmail send_mail', connect: true }));
  expect(result).toMatchObject({ type: 'plugin-connection-request', connector: 'gmail', status: 'pending' });
  expect(f.broker.approvals()).toEqual([]);
});
it('edits access without account reads, persists it, and revokes a captured tool before dispatch', async () => {
  const f = await fixture(), before = f.requests.length;
  expect(f.service.conversationAccess(f.chat.id).plugins.find(item=>item.id===f.entry.id)?.allowed).toBe(false);
  await f.service.setConversationAccess(f.chat.id,f.entry.id,true);
  expect(f.requests).toHaveLength(before);
  const r = run(f); await r.load(); expect(f.broker.approvals()).toEqual([]);
  await r.call(r.tool('get_mail_profile'));
  const other = f.history.createConversation(null);
  expect(f.service.conversationAccess(other.id).plugins.find(item=>item.id===f.entry.id)?.allowed).toBe(false);
  await f.service.setConversationAccess(f.chat.id,f.entry.id,false);
  const revoked = f.requests.length;
  expect(JSON.parse(await r.call(r.tool('get_mail_profile'))).error).toBeTruthy(); expect(f.requests).toHaveLength(revoked);
  expect(f.store.selection(f.chat.id,null)).not.toContain(f.entry.id);
  await f.close(); const reopened = await f.open(); await reopened.service.connect(f.entry.id);
  expect(reopened.service.conversationAccess(f.chat.id).plugins.find(item=>item.id===f.entry.id)?.allowed).toBe(false);
  await reopened.service.setConversationAccess(f.chat.id,f.entry.id,true);
  const scope = reopened.service.useAuthorization(f.chat.id,f.entry.id)!.scope;
  expect(reopened.history.hasConversationGrant(f.chat.id,scope)).toBe(true);
});
it('inherits only granted plugin access into same-Project bot checks and can revoke a pending request', async () => {
  const f = await fixture();
  const child = f.history.createConversation(null,'bot'); await f.store.select(child.id,null,[f.entry.id]);
  f.service.inheritConversationAccess(f.chat.id,child.id);
  expect(f.service.conversationAccess(child.id).plugins.find(item=>item.id===f.entry.id)?.allowed).toBe(false);
  await f.service.setConversationAccess(f.chat.id,f.entry.id,true); f.service.inheritConversationAccess(f.chat.id,child.id);
  expect(f.service.conversationAccess(child.id).plugins.find(item=>item.id===f.entry.id)?.allowed).toBe(true);
  const isolated = f.history.createProject('Isolated',''); const different = f.history.createConversation(isolated.id,'bot');
  expect(()=>f.service.inheritConversationAccess(f.chat.id,different.id)).toThrow('cross Projects');
  await f.service.setConversationAccess(f.chat.id,f.entry.id,false);
  await f.service.setConversationAccess(child.id,f.entry.id,false);
  expect(f.service.conversationAccess(child.id).plugins.find(item=>item.id===f.entry.id)?.allowed).toBe(false);
  await f.store.select(f.chat.id,null,[f.entry.id]);
  const loading = run(f).load(); await pending(f);
  await f.service.setConversationAccess(f.chat.id,f.entry.id,false);
  expect(JSON.parse(await loading).code).toBe('PLUGIN_USE_DENIED'); expect(f.broker.approvals()).toEqual([]);
  await f.service.disconnect(f.entry.id);
  await expect(f.service.setConversationAccess(f.chat.id,f.entry.id,true)).rejects.toThrow('Connect this plugin');
});
