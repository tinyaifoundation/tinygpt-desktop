import { ChatService } from '../src/main/chat-service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { PluginStore } from '../src/main/plugin-store';
import { PluginService, compileToolSchema, extensionAlias, boundedPluginResult, modelToolSchema } from '../src/main/plugin-service';
import { McpConnection } from '../src/main/mcp-client';
import { parseSkill } from '../src/core/plugin-skills';
import { pluginManifestSchema } from '../src/shared/plugins';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';
import { ToolBroker } from '../src/main/tool-broker';
import type { BrowserController } from '../src/main/browser';
import { defaultSettings } from '../src/shared/config';
import { connectorManifest } from '../src/shared/connector-catalog';
import { ConnectorClient } from '../src/main/connector-tools';
import { executionToolNameSchema } from '../src/shared/tools';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const encryption = { available: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-plugins-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
  const project = history.createProject('One', '', false, root); const other = history.createProject('Other', '', false, null); const conversation = history.createConversation(project.id);
  const store = new PluginStore(root, encryption); const settings = structuredClone(defaultSettings); let broker: ToolBroker;
  const service = new PluginService(store, history, new ProjectFiles(history.sources), () => broker?.revokeUnavailableExtensions()); await service.initialize(); cleanup.push(() => service.shutdown());
  broker = new ToolBroker(history, () => settings, { shutdown: () => {} } as BrowserController, new ProjectFiles(history.sources), () => {}, undefined, service);
  return { root, history, project, other, conversation, store, service, broker, settings };
}
function skillManifest() { return pluginManifestSchema.parse({ format: 1, id: 'test-skill', name: 'A skill', version: '1.0.0', description: 'Guidance', kind: 'skill', skills: [{ name: 'brief', description: 'Evidence-backed briefs.', instructions: 'Read evidence before writing.', references: { 'references/example.md': 'An example brief.' } }] }); }

describe('plugin registry and skills', () => {
  it('retains conversation approvals across extension captures and invalidates changed credentials or tool rules', async () => {
    const { service, store, project, conversation, broker } = await setup(); const entry = store.entries()[0]; await service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: true } });
    const name = extensionAlias(entry.id, 'create_report');
    const execute = () => { const runId = randomUUID(); service.prepare(conversation.id, runId, project.id, 'chat'); return broker.execute({ conversationId: conversation.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name, input: { path: 'brief.md', content: 'Checked evidence' } }); };
    const first = execute(); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'allow-conversation'); expect(JSON.parse(await first).error).toBeUndefined();
    expect(JSON.parse(await execute()).error).toBeUndefined(); expect(broker.approvals()).toEqual([]);
    await store.saveCredentials(entry.id, { bearer: 'changed-fixture-identity' }); const changed = execute(); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'deny'); expect(JSON.parse(await changed).error).toContain('denied');
    await service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: true, rules: { create_report: 'deny' } } }); expect(JSON.parse(await execute()).error).toBeDefined(); expect(broker.approvals()).toEqual([]);
  });
  it('parses portable skill metadata and rejects aliases, escaping references, and missing metadata', () => {
    expect(parseSkill('---\nname: briefs\ndescription: Write a brief\n---\nUse checked sources.').instructions).toBe('Use checked sources.');
    expect(() => parseSkill('no metadata')).toThrow('frontmatter');
    expect(() => parseSkill('---\nname: briefs\ndescription: Write a brief\n---\nWork', { '../secret': 'bad' })).toThrow('inside');
    expect(() => parseSkill('---\nname: &n brief\ndescription: *n\n---\nWork')).toThrow();
  });
  it('persists selection, project visibility and credentials without exposing secret values in snapshots', async () => {
    const { service, store, project, other, conversation, root } = await setup();
    await service.save({ manifest: skillManifest(), config: { enabled: true, projectIds: [project.id], rules: {}, resources: [] } }); const entry = store.entries().find(item => item.manifest.id === 'test-skill')!;
    await store.saveCredentials(entry.id, { bearer: 'credential-secret' });
    expect(JSON.stringify(service.snapshot())).not.toContain('credential-secret'); expect(store.selection(conversation.id, project.id)).toContain(entry.id); expect(store.selection(null, other.id)).not.toContain(entry.id); expect(store.selection(null, null)).not.toContain(entry.id);
    await store.select(conversation.id, project.id, []); const reloaded = new PluginStore(root, encryption); await reloaded.load(); expect(reloaded.selection(conversation.id, project.id)).toEqual([]); expect(reloaded.credentials(entry.id)).toEqual({ bearer: 'credential-secret' });
    await expect(store.save({ manifest: skillManifest(), config: entry.config })).rejects.toThrow('already installed');
  });
  it('loads skill guidance progressively and blocks references outside declared contents', async () => {
    const { service, store, project, conversation } = await setup(); await service.save({ manifest: skillManifest(), config: { enabled: true, projectIds: [project.id], rules: {}, resources: [] } });
    const entry = store.entries().find(item => item.manifest.id === 'test-skill')!; const runId = randomUUID(); const catalog = service.prepare(conversation.id, runId, project.id, 'chat');
    expect(catalog.instructions).toContain('Evidence-backed briefs'); expect(catalog.instructions).not.toContain('Read evidence before writing');
    const skillId = `${entry.id}/brief`;
    expect(service.loadSkill(runId, conversation.id, skillId).instructions).toContain('Read evidence');
    expect(() => service.readSkillReference(runId, conversation.id, skillId, '../secret')).toThrow('not found');
    expect(service.prepare(conversation.id, randomUUID(), null, 'chat').tools).toEqual([]);
  });
  it('bounds schemas, disallows external references and redacts credentials/binary payloads', () => {
    expect(() => compileToolSchema({ type: 'object', properties: { x: { $ref: 'https://example.com/schema' } } })).toThrow('External');
    expect(() => compileToolSchema({ type: 'string' })).toThrow('object');
    expect(boundedPluginResult({ text: 'secret123', data: 'x'.repeat(3000) }, { bearer: 'secret123' })).toContain('[credential redacted]');
    const oauthCredentials = { environment: { CUSTOM_VALUE: 'env-secret-123' }, oauth: { client: { client_id: 'public-client', client_name: 'TinyGPT Desktop', response_types: ['code'], token_endpoint_auth_method: 'none', client_secret: 'client-secret-123' }, tokens: { access_token: 'access-secret-123', refresh_token: 'refresh-secret-123', id_token: 'identity-secret-123', scope: 'default', token_type: 'Bearer' }, verifier: 'pkce-secret-123' } };
    const publicText = 'TinyGPT Desktop code none default Bearer public-client';
    expect(JSON.parse(boundedPluginResult({ text: publicText }, oauthCredentials)).text).toBe(publicText);
    const privateText = ['env-secret-123','client-secret-123','access-secret-123','refresh-secret-123','identity-secret-123','pkce-secret-123'].join(' ');
    expect(JSON.parse(boundedPluginResult({ text: privateText }, oauthCredentials)).text).toBe(Array(6).fill('[credential redacted]').join(' '));
    expect(boundedPluginResult({ text: 'x'.repeat(30000) }).length).toBeLessThan(24000);
  });
  it('compacts catalog annotations without changing property names, literals or host validation', () => {
    const schema = { type: 'object', properties: { description: { type: 'string', minLength: 4, description: 'detail '.repeat(100) }, examples: { type: 'integer', minimum: 2 }, literal: { const: { description: 'exact literal', examples: ['keep'] } } }, required: ['description', 'examples', 'literal'], additionalProperties: false };
    const compact = modelToolSchema(schema); const validate = compileToolSchema(schema);
    expect((compact.properties as any).description.description.length).toBeLessThan(200);
    expect((compact.properties as any).description.minLength).toBe(4); expect((compact.properties as any).examples.minimum).toBe(2);
    expect((compact.properties as any).literal.const).toEqual(schema.properties.literal.const);
    expect(validate({ description: 'long enough', examples: 2, literal: schema.properties.literal.const })).toBe(true);
    expect(validate({ description: 'bad', examples: 1, literal: schema.properties.literal.const })).toBe(false);
  });
  it('invalidates startup consent when local environment values change', async () => {
    const { store } = await setup(); const manifest = pluginManifestSchema.parse({ format: 1, id: 'environment-fixture', name: 'Environment fixture', description: 'Test', version: '1.0.0', kind: 'mcp', server: { transport: 'stdio', command: process.execPath, args: [], environment: ['SERVICE_TOKEN'] } });
    const entry = await store.save({ manifest, config: { enabled: true, projectIds: null, rules: {}, resources: [] } }); await store.saveCredentials(entry.id, { environment: { SERVICE_TOKEN: 'first-token' } }); await store.trust(entry.id); expect(store.trusted(entry.id)).toBe(true);
    await store.saveCredentials(entry.id, { environment: { SERVICE_TOKEN: 'changed-token' } }); expect(store.trusted(entry.id)).toBe(false);
  });
  it('revokes only affected conversation checkpoints and preserves unrelated summaries', async () => {
    const { history, conversation, other, store } = await setup(); const unrelated = history.createConversation(other.id);
    for (const chat of [conversation, unrelated]) { const turn = history.startTurn(chat.id, 'User question', 'local'); history.saveReply(turn.assistantId, 'Answer', 'complete'); const user = history.conversation(chat.id).messages.find(message => message.role === 'user')!; history.saveContextCheckpoint(chat.id, { throughMessageId: user.id, text: 'A durable checkpoint' }); }
    const pluginId = store.entries()[0].id; history.memory.recordPluginAccess(pluginId, conversation.id); history.memory.revokePlugin(pluginId);
    expect(history.contextCheckpoint(conversation.id, history.conversation(conversation.id).messages)).toBeUndefined(); expect(history.contextCheckpoint(unrelated.id, history.conversation(unrelated.id).messages)?.text).toBe('A durable checkpoint');
  });
  it('drains tracked database work before shutdown can close the library', async () => {
    const { service, history } = await setup(); let finish!: () => void; let closed = false;
    const work = service.track(() => new Promise<void>(resolve => { finish = () => { history.projects(); resolve(); }; })); await Promise.resolve();
    const shuttingDown = service.shutdown().then(() => { closed = true; }); await new Promise(done => setTimeout(done, 10)); expect(closed).toBe(false); finish(); await work; await shuttingDown; expect(closed).toBe(true);
    await expect(service.track(async () => history.projects())).rejects.toThrow('shutting down');
  });
  it('creates a scoped report through the built-in plugin and enforces revocation mid-reply', async () => {
    const { service, store, project, conversation, root, broker, settings } = await setup(); const entry = store.entries()[0]; await service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: true, rules: { create_report: 'allow' } } }); settings.toolPermissions.write = 'allow';
    const runId = randomUUID(); service.prepare(conversation.id, runId, project.id, 'chat'); const name = extensionAlias(entry.id, 'create_report');
    const result = JSON.parse(await broker.execute({ conversationId: conversation.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name, input: { path: 'report.md', content: '# Checked report' } }));
    expect(result.citation).toContain('tinygpt-source:'); expect(await readFile(join(root, 'report.md'), 'utf8')).toBe('# Checked report');
    await service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: false } });
    await expect(service.execute(runId, conversation.id, name, { path: 'other.md', content: 'no' }, new AbortController().signal)).rejects.toThrow('revoked');
  });
});

describe('real MCP transports and approval enforcement', () => {
  it('completes issuer-bound MCP OAuth with a state-checked loopback callback and PKCE', async () => {
    const fixture = await setup(); let port = 0; let registration: Record<string, unknown> = {}; let verifierSeen = false; let stateSeen = false; let expireToken = false; let refreshed = false; let leakCredential = false;
    const server = createServer(async (request, response) => {
      const base = `http://127.0.0.1:${port}`; const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      if (request.url?.startsWith('/.well-known/oauth-protected-resource')) { json({ resource: `${base}/mcp`, authorization_servers: [base] }); return; }
      if (request.url?.startsWith('/.well-known/oauth-authorization-server')) { json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      if (request.url === '/register') { registration = JSON.parse(body); json({ ...registration, client_id: 'fixture-client' }, 201); return; }
      if (request.url === '/token') { const params = new URLSearchParams(body); verifierSeen ||= !!params.get('code_verifier') && params.get('code') === 'fixture-code'; refreshed ||= params.get('grant_type') === 'refresh_token'; json({ access_token: refreshed ? 'oauth-refreshed-token' : 'oauth-fixture-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'fixture-refresh' }); return; }
      if (request.url !== '/mcp' || request.method !== 'POST') { response.writeHead(404).end(); return; }
      if (request.headers.authorization !== (expireToken ? 'Bearer oauth-refreshed-token' : 'Bearer oauth-fixture-token')) { response.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end(); return; }
      const message = JSON.parse(body); if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', serverInfo: { name: 'OAuth fixture', version: '1.0.0' }, capabilities: { tools: {} } } : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'Still connected after refresh' }] } : { tools: [{ name: 'echo', description: leakCredential ? 'Leaked oauth-refreshed-token' : 'Read code; none of the public TinyGPT Desktop client metadata is secret.', inputSchema: { type: 'object', properties: {} } }] }; json({ jsonrpc: '2.0', id: message.id, result });
    }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); port = (server.address() as { port: number }).port; cleanup.push(() => new Promise<void>(done => server.close(() => done())));
    const oauthService = new PluginService(fixture.store, fixture.history, new ProjectFiles(fixture.history.sources), () => {}, () => true, async address => {
      const url = new URL(address); stateSeen = !!url.searchParams.get('state') && url.searchParams.get('code_challenge_method') === 'S256'; const redirect = new URL(url.searchParams.get('redirect_uri')!);
      const invalid = new URL(redirect); invalid.searchParams.set('state', 'wrong'); invalid.searchParams.set('code', 'bad'); expect((await fetch(invalid)).status).toBe(400);
      redirect.searchParams.set('state', url.searchParams.get('state')!); redirect.searchParams.set('code', 'fixture-code'); expect((await fetch(redirect)).status).toBe(200);
    }); cleanup.push(() => oauthService.shutdown());
    await oauthService.save({ manifest: pluginManifestSchema.parse({ format: 1, id: 'oauth-fixture', name: 'OAuth fixture', version: '1.0.0', description: 'OAuth', kind: 'mcp', server: { transport: 'http', endpoint: `http://127.0.0.1:${port}/mcp`, auth: 'oauth' } }), config: { enabled: true, projectIds: null, rules: {}, resources: [] } }); const entry = fixture.store.entries().find(item => item.manifest.id === 'oauth-fixture')!;
    const snapshot = await oauthService.connect(entry.id); expect(snapshot.entries.find(item => item.id === entry.id)).toMatchObject({ status: 'connected' }); expect(stateSeen).toBe(true); expect(verifierSeen).toBe(true); expect(registration.redirect_uris).toHaveLength(1); expect(JSON.stringify(snapshot)).not.toContain('oauth-fixture-token');
    const vault = fixture.store.credentials<{ oauth: { tokens: { issuer: string } } }>(entry.id)!; expect(vault.oauth.tokens.issuer).toBe(`http://127.0.0.1:${port}`);
    expireToken = true; const runId = randomUUID(); const capture = oauthService.prepare(fixture.conversation.id, runId, fixture.project.id, 'chat');
    const tool = capture.tools.find(tool => tool.originalName === 'echo')!;
    const result = await oauthService.execute(runId, fixture.conversation.id, tool.name, {}, new AbortController().signal);
    expect(JSON.stringify(result)).toContain('Still connected after refresh'); expect(refreshed).toBe(true);
    expect(fixture.store.credentials<{ oauth: { tokens: { access_token: string } } }>(entry.id)!.oauth.tokens.access_token).toBe('oauth-refreshed-token');
    leakCredential = true; const refused = await oauthService.connect(entry.id);
    expect(refused.entries.find(item => item.id === entry.id)).toMatchObject({ status: 'error', message: 'Tool metadata contains credential values.' });
  });
  it('requires startup consent, discovers real stdio tools/resources and cannot execute denied calls', async () => {
    const { root, service, store, conversation, project, other, history, broker } = await setup(); const marker = join(root, 'marker');
    await service.save({ manifest: pluginManifestSchema.parse({ format: 1, id: 'stdio-fixture', name: 'Stdio fixture', version: '1.0.0', description: 'Test', kind: 'mcp', server: { transport: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/plugin-mcp.cjs'), marker], environment: [] } }), config: { enabled: true, projectIds: [project.id], rules: {}, resources: [] } }); const entry = store.entries().find(item => item.manifest.id === 'stdio-fixture')!;
    await expect(service.connect(entry.id)).rejects.toThrow('Authorize'); await store.trust(entry.id); const connected = await service.connect(entry.id); expect(connected.entries.find(item => item.id === entry.id)?.status).toBe('connected');
    const runId = randomUUID(); const catalog = service.prepare(conversation.id, runId, project.id, 'chat'); expect(catalog.tools.length).toBe(4); const context = { conversationId: conversation.id, runId, signal: new AbortController().signal };
    const usage = broker.execute(context, { id: randomUUID(), name: 'load_tools', input: { group: 'services', query: 'Stdio fixture' } }); await vi.waitFor(() => expect(broker.approvals()[0]?.pluginUse?.name).toBe('Stdio fixture')); broker.respond(broker.approvals()[0].id, 'allow-conversation'); await usage;
    const denied = broker.execute(context, { id: randomUUID(), name: extensionAlias(entry.id, 'mutate'), input: {} }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'deny'); expect(JSON.parse(await denied).error).toContain('denied'); await expect(access(marker)).rejects.toThrow();
    const allowed = broker.execute(context, { id: randomUUID(), name: extensionAlias(entry.id, 'echo'), input: { text: 'Hello', status: 'a real field' }, displayText: 'A fabricated safe description' }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); expect(broker.approvals()[0].details).toContain('a real field'); expect(broker.approvals()[0].summary).not.toContain('fabricated'); broker.respond(broker.approvals()[0].id, 'allow-run'); expect(JSON.parse(await allowed).content[0].text).toContain('a real field');
    const otherTool = broker.execute(context, { id: randomUUID(), name: extensionAlias(entry.id, 'mutate'), input: {} }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'allow-once'); await otherTool; expect(await readFile(marker, 'utf8')).toBe('approved');
    await service.importResource(entry.id, 'fixture://release', project.id); expect(history.memory.lexical(project.id, 'maintainer signatures')).toHaveLength(1); expect(history.memory.lexical(other.id, 'maintainer signatures')).toEqual([]);
    const pending = broker.execute(context, { id: randomUUID(), name: extensionAlias(entry.id, 'mutate'), input: {} }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); await service.disconnect(entry.id); await pending; expect(broker.approvals()).toEqual([]); expect(history.memory.lexical(project.id, 'maintainer signatures')).toEqual([]);
    expect(store.entry(entry.id).config.resources).toHaveLength(1); await service.connect(entry.id); await service.refreshResources(entry.id); expect(history.memory.lexical(project.id, 'maintainer signatures')).toHaveLength(1);
  });
  it('executes Streamable HTTP with a bearer token and closes cleanly', async () => {
    let sawToken = false; const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      sawToken ||= request.headers.authorization === 'Bearer fixture-token'; let body = ''; for await (const chunk of request) body += chunk; const message = JSON.parse(body);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', serverInfo: { name: 'HTTP fixture', version: '1.0.0' }, capabilities: { tools: {} } } : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } : { content: [{ type: 'text', text: 'HTTP works' }] };
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    }); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); cleanup.push(() => new Promise<void>(done => server.close(() => done())));
    const address = server.address() as { port: number }; const client = new McpConnection({ transport: 'http', endpoint: `http://127.0.0.1:${address.port}/mcp`, auth: 'bearer' }, { bearer: 'fixture-token' }); cleanup.push(() => client.close()); const signal = new AbortController().signal;
    await client.connect(signal); expect((await client.catalog(signal)).tools[0].name).toBe('echo'); expect(await client.call('echo', {}, signal)).toMatchObject({ content: [{ text: 'HTTP works' }] }); expect(sawToken).toBe(true);
  });
});

describe('connector clients', () => {
  it('keeps plugin tools readable, bounded, unique and valid across captures', () => {
    const name = extensionAlias('one', 'send_mail');
    expect(name).toMatch(/^ext_send_mail_/); expect(executionToolNameSchema.parse(name)).toBe(name);
    expect(extensionAlias('two', 'send_mail')).not.toBe(name);
    expect(extensionAlias('one', 'send/mail')).not.toBe(extensionAlias('one', 'send_mail'));
    expect(extensionAlias('one', 'tool.'.repeat(100)).length).toBeLessThanOrEqual(64);
    expect(executionToolNameSchema.safeParse('ext_' + 'a'.repeat(24)).success).toBe(true);
    expect(executionToolNameSchema.safeParse('ext_send_mail_forged').success).toBe(false);
  });
  it('declares connected Gmail actions and resolves self-addressing through a real profile read', async () => {
    const fixture = await setup(); const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async url => { calls.push(String(url)); return new Response(JSON.stringify({ emailAddress: 'self@example.test', messagesTotal: 3 }), { headers: { 'content-type': 'application/json' } }); })); cleanup.push(() => { vi.unstubAllGlobals(); });
    const entry = await fixture.store.save({ manifest: pluginManifestSchema.parse({ format: 1, id: 'test-gmail', name: 'Gmail', description: 'Mail', version: '1.0.0', kind: 'connector', connector: 'gmail' }), config: { enabled: true, projectIds: null, rules: { get_mail_profile: 'allow' }, resources: [] } });
    await fixture.service.credentials(entry.id, { bearer: 'private-profile-token' }); await fixture.service.connect(entry.id);
    const runId = randomUUID(); const capture = fixture.service.prepare(fixture.conversation.id, runId, fixture.project.id, 'chat');
    expect(capture.instructions).toContain('available on demand'); expect(capture.instructions).not.toContain('get_mail_profile');
    const loaded = fixture.service.loadTools(runId, fixture.conversation.id, 'Gmail get_mail_profile'); expect(loaded.status).toBe('loaded'); expect(loaded.toolNames).toHaveLength(1);
    expect(loaded.availableActionsComplete).toBe(true);
    expect(loaded.availableActions?.map(action => action.action)).toEqual(expect.arrayContaining(['search_mail', 'read_mail', 'get_mail_profile']));
    expect(loaded.availableActions?.some(action => 'schema' in action)).toBe(false);
    const searched = fixture.service.loadTools(runId, fixture.conversation.id, 'Gmail email search inbox');
    expect(searched.toolNames).toEqual([extensionAlias(entry.id, 'search_mail')]);
    expect(searched.availableActions?.map(action => action.action)).toContain('read_mail');
    expect(searched.availableActions?.map(action => action.action)).not.toContain('create_filter');
    expect(searched.availableActionCount).toBe(searched.availableActions?.length);
    expect(searched.nextAction).toContain('Only toolNames are loaded');
    expect(calls).toHaveLength(1); // Connection health only; discovery executes no mail action.
    fixture.history.grantConversationTool(fixture.conversation.id, fixture.service.useAuthorization(fixture.conversation.id, entry.id)!.scope);
    const already = await fixture.broker.execute({ conversationId: fixture.conversation.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name: 'request_plugin_connection', input: { connector: 'gmail', reason: 'Approve my email' } });
    expect(JSON.parse(already).status).toBe('connected'); expect(JSON.parse(already).type).toBeUndefined();
    const profile = capture.tools.find(tool => tool.originalName === 'get_mail_profile')!;
    const result = await fixture.broker.execute({ conversationId: fixture.conversation.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name: profile.name, input: {} });
    expect(JSON.parse(result).emailAddress).toBe('self@example.test'); expect(calls.at(-1)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(JSON.stringify(capture)).not.toContain('private-profile-token');
    const self = capture.tools.find(tool => tool.originalName === 'send_mail_to_self')!;
    const before = calls.length;
    const pending = fixture.broker.execute({ conversationId: fixture.conversation.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name: self.name, input: { subject: 'Report', text: 'Evidence' } });
    await vi.waitFor(() => expect(fixture.broker.approvals()).toHaveLength(1)); expect(calls.length).toBe(before);
    fixture.broker.respond(fixture.broker.approvals()[0].id, 'deny'); expect(JSON.parse(await pending).error).toContain('denied'); expect(calls.length).toBe(before);
    await expect(fixture.service.execute(runId, fixture.conversation.id, extensionAlias(entry.id, 'not_declared'), {}, new AbortController().signal)).rejects.toThrow('not selected');
  });
  it('connects all three connector families and routes reads and mutations through the broker', async () => {
    const fixture = await setup(); const calls: { url: string; method: string }[] = [];
    const request = vi.fn(async (url: unknown, options?: RequestInit) => { calls.push({ url: String(url), method: options?.method ?? 'GET' }); return new Response(JSON.stringify({ ok: true, text: 'A connector fixture result' }), { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
    vi.stubGlobal('fetch', request); cleanup.push(() => { vi.unstubAllGlobals(); });
    for (const kind of ['github', 'google', 'slack'] as const) {
      await fixture.service.save({ manifest: pluginManifestSchema.parse({ format: 1, id: `test-${kind}`, name: kind, description: 'Connector', version: '1.0.0', kind: 'connector', connector: kind }), config: { enabled: true, projectIds: [fixture.project.id], rules: {}, resources: [] } });
      const entry = fixture.store.entries().find(item => item.manifest.id === `test-${kind}`)!; await fixture.service.credentials(entry.id, { bearer: 'private-fixture-token' }); expect((await fixture.service.connect(entry.id)).entries.find(item => item.id === entry.id)?.status).toBe('connected');
      const runId = randomUUID(); const tools = fixture.service.prepare(fixture.conversation.id, runId, fixture.project.id, 'chat').tools.filter(tool => tool.pluginId === entry.id); const readName = kind === 'github' ? 'list_repositories' : kind === 'google' ? 'search_drive' : 'search_messages';
      const read = tools.find(tool => tool.originalName === readName)!; const context = { conversationId: fixture.conversation.id, runId, signal: new AbortController().signal };
      const pending = fixture.broker.execute(context, { id: randomUUID(), name: read.name, input: kind === 'github' ? {} : { query: 'evidence' } }); await vi.waitFor(() => expect(fixture.broker.approvals()).toHaveLength(1)); fixture.broker.respond(fixture.broker.approvals()[0].id, 'allow-once'); expect(JSON.parse(await pending).text).toContain('connector');
      const writeName = kind === 'github' ? 'create_issue' : kind === 'google' ? 'send_mail' : 'send_message'; const write = tools.find(tool => tool.originalName === writeName)!; const input = kind === 'github' ? { repository: 'owner/repo', title: 'A title', body: 'A body' } : kind === 'google' ? { to: 'test@example.org', subject: 'A subject', text: 'A body' } : { channel: 'C123', text: 'A body' };
      const before = calls.length; const denied = fixture.broker.execute(context, { id: randomUUID(), name: write.name, input }); await vi.waitFor(() => expect(fixture.broker.approvals()).toHaveLength(1)); fixture.broker.respond(fixture.broker.approvals()[0].id, 'deny'); await denied; expect(calls.length).toBe(before);
      const approved = fixture.broker.execute(context, { id: randomUUID(), name: write.name, input }); await vi.waitFor(() => expect(fixture.broker.approvals()).toHaveLength(1)); fixture.broker.respond(fixture.broker.approvals()[0].id, 'allow-once'); await approved; expect(calls.at(-1)?.method).toBe('POST'); expect(JSON.stringify(fixture.service.snapshot())).not.toContain('private-fixture-token');
      fixture.broker.endRun(runId); await fixture.service.disconnect(entry.id, true);
    }
  });
  it('uses fixed service destinations, token headers and typed mutation bodies', async () => {
    const calls: { url: string; options?: RequestInit }[] = []; const request = vi.fn(async (url: unknown, options?: RequestInit) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch;
    const github = new ConnectorClient('github', () => 'token', request); const issue = github.tools().find(tool => tool.name === 'create_issue')!; expect(issue.schema.safeParse({ repository: '../bad', title: 'A', body: '' }).success).toBe(false);
    await issue.run({ repository: 'owner/repo', title: 'A', body: 'B' }, new AbortController().signal); expect(calls[0].url).toBe('https://api.github.com/repos/owner/repo/issues'); expect(calls[0].options?.method).toBe('POST'); expect(new Headers(calls[0].options?.headers).get('authorization')).toBe('Bearer token');
    const google = new ConnectorClient('google', () => 'token', request); await google.tools().find(tool => tool.name === 'send_mail')!.run({ to: 'test@example.org', subject: 'Café', text: 'A body' }, new AbortController().signal); expect(calls[1].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); expect(JSON.parse(String(calls[1].options?.body)).raw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('does not expose provider errors containing tokens', async () => {
    const request = vi.fn(async () => new Response('secret-token', { status: 401 })) as typeof fetch; const client = new ConnectorClient('github', () => 'secret-token', request); await expect(client.health(new AbortController().signal)).rejects.toThrow('Sign in again');
  });
});


describe('on-demand plugin loading', () => {
  it('connects a large creative catalog, loads one action and preserves validation and review', async () => {
    const f = await setup(); let count = 180;
    const choices = Array.from({ length: 1800 }, (_, i) => `choice-${String(i).padStart(4, '0')}-content`);
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      let text = ''; for await (const chunk of request) text += chunk;
      const message = JSON.parse(text); if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Creative fixture', version: '1.0.0' } } : message.method === 'tools/list' ? { tools: Array.from({ length: count }, (_, i) => ({ name: i ? `action_${i}` : 'generate_image', description: 'Creative action. '.repeat(110), inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'Parameter help. '.repeat(350), ...(i === 0 ? { enum: choices } : {}) } }, required: ['prompt'], additionalProperties: false } })) } : {};
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
    const port = (server.address() as { port: number }).port;
    const entry = await f.store.save({ manifest: pluginManifestSchema.parse({ format: 1, id: 'creative-catalog-fixture', name: 'Creative fixture', version: '1.0.0', description: 'Large hosted catalog', kind: 'mcp', server: { transport: 'http', endpoint: `http://127.0.0.1:${port}/mcp`, auth: 'none' } }), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
    const connected = (await f.service.connect(entry.id)).entries.find(item => item.id === entry.id)!;
    expect(connected.status).toBe('connected'); expect(connected.tools).toHaveLength(180);
    const run = randomUUID(); f.service.prepare(f.conversation.id, run, f.project.id, 'chat');
    const broad = f.service.loadTools(run, f.conversation.id, 'Creative fixture'); expect(broad.toolNames).toEqual([]);
    const name = extensionAlias(entry.id, 'generate_image'); expect(f.service.loadTools(run, f.conversation.id, name).toolNames).toEqual([name]);
    expect(f.service.authorizedTool(run, f.conversation.id, name, { prompt: choices[0] }).rule).toBe('ask');
    expect(() => f.service.authorizedTool(run, f.conversation.id, name, { prompt: 'not-in-the-provider-enum' })).toThrow('invalid');
    expect(connected.tools[0].schema).toMatchObject({ properties: { prompt: { enum: choices } } });
    await f.service.disconnect(entry.id); count = 201;
    expect((await f.service.connect(entry.id)).entries.find(item => item.id === entry.id)?.message).toBe('Server offers more than 200 tools.');
  });
  it('keeps a combined catalog above the old startup limit dormant and loads only a focused action', async () => {
    const f = await setup(); const calls = vi.fn();
    for (const [kind, count, size] of [['notion', 77, 2300], ['gmail', 5, 14000]] as const) {
      const entry = await f.store.save({ manifest: connectorManifest(kind), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
      const tools = Array.from({ length: count }, (_, i) => {
        const originalName = i === 0 ? 'search_pages' : `read_item_${i}`;
        return { definition: { name: extensionAlias(entry.id, originalName), originalName, pluginId: entry.id, label: originalName, description: i === 0 ? 'Search pages' : 'Read an item', schema: { type: 'object', properties: { value: { type: 'string', description: 'DORMANT_SCHEMA_' + 'x'.repeat(size) } } }, category: 'read' }, validate: () => true, execute: calls, fingerprint: 'fixture' };
      });
      expect(JSON.stringify(tools.map(tool => tool.definition)).length).toBeLessThan(256000);
      (f.service as any).sessions.set(entry.id, { controller: new AbortController(), catalog: { tools: [], resources: [], prompts: [] }, tools, status: 'connected', message: '' });
    }
    const run = randomUUID(), captured = f.service.prepare(f.conversation.id, run, f.project.id, 'code');
    expect(JSON.stringify(captured.tools).length).toBeGreaterThan(256000);
    expect(captured.instructions).not.toContain('search_pages');
    const discovery = f.service.loadTools(run, f.conversation.id);
    expect(discovery.toolNames).toEqual([]); expect(discovery.plugins.map(plugin => plugin.name)).toContain('Notion');
    const broad = f.service.loadTools(run, f.conversation.id, 'Notion');
    expect(broad.toolNames).toEqual([]); expect(broad.tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(broad)).not.toContain('DORMANT_SCHEMA_');
    const narrow = f.service.loadTools(run, f.conversation.id, 'Notion search_pages');
    expect(narrow.toolNames).toHaveLength(1); expect(narrow.tools[0].plugin).toBe('Notion');
    expect(f.service.loadTools(run, f.conversation.id, narrow.toolNames[0]).toolNames).toEqual(narrow.toolNames);
    expect(calls).not.toHaveBeenCalled();
  });
  it('uses the existing connection card when discovery requests a disconnected account', async () => {
    const f = await setup();
    const entry = await f.store.save({ manifest: connectorManifest('notion'), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
    const run = randomUUID(); f.service.prepare(f.conversation.id, run, f.project.id, 'chat');
    // A connection finishing mid-turn must offer Continue to refresh the native registry.
    (f.service as any).sessions.set(entry.id, { controller: new AbortController(), catalog: { tools: [], resources: [], prompts: [] }, status: 'connected', message: '', tools: [{ definition: { name: extensionAlias(entry.id, 'search'), originalName: 'search' } }] });
    const result = JSON.parse(await f.broker.execute({ conversationId: f.conversation.id, runId: run, signal: new AbortController().signal }, { id: randomUUID(), name: 'load_tools', input: { group: 'services', query: 'Notion search' } }));
    expect(result).toMatchObject({ type: 'plugin-connection-request', connector: 'notion', status: 'pending' });
    expect(f.history.conversation(f.conversation.id).tools.at(-1)?.name).toBe('request_plugin_connection');
  });
});

it('reports plugin preparation failures as setup errors without blaming the provider or leaking details', async () => {
  const f = await setup(); Object.assign(f.broker.browser, { handoffs: () => [], tasks: () => [], partition: () => 'fixture', endRun() {} }); f.settings.route = 'local'; f.settings.local.model = 'fixture';
  vi.spyOn(f.service, 'prepare').mockImplementation(() => { throw Error('Internal setup failure private-token'); });
  const run = vi.fn();
  const chat = new ChatService(f.history, () => f.settings, () => undefined, { run }, () => {}, f.broker, undefined, f.service);
  try {
    chat.start(f.conversation.id, 'Hello');
    await vi.waitFor(() => expect(chat.library().activeRuns).toHaveLength(0));
    expect(f.history.conversation(f.conversation.id).messages.at(-1)?.error).toBe('Plugin setup could not finish. Check the Plugins library, then retry.');
    expect(run).not.toHaveBeenCalled();
  } finally { await chat.shutdown(); }
});
