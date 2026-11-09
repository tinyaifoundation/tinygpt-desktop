import { app, safeStorage } from 'electron';
import { resolve, sep } from 'node:path';
import { PluginStore } from '../src/main/plugin-store';
import { ConnectorOAuth } from '../src/main/connector-oauth';
import { ConnectorClient } from '../src/main/connector-tools';
import { connectorRegistration } from '../src/main/connector-registrations';
import { connectorManifest, connectorMatches } from '../src/shared/connector-catalog';
import { suggestedConnectorSchema } from '../src/shared/plugins';
import { PluginService, boundedPluginResult } from '../src/main/plugin-service';
import { McpConnection } from '../src/main/mcp-client';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';

const kind = suggestedConnectorSchema.parse(process.argv.at(-1));
const resume = process.env.TINYGPT_LIVE_REFRESH_PROFILE;
const profile = resume ? resolve(resume) : resolve('.test-profile', `live-${kind}-${Date.now()}`);
if (!profile.startsWith(resolve('.test-profile') + sep)) throw Error('Use a dedicated live-check profile.');
app.setPath('userData', profile);
void app.whenReady().then(async () => {
  const store = new PluginStore(profile, { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
  await store.load(); const entry = resume ? store.entries().find(entry => connectorMatches(entry.manifest, kind)) : await store.save({ manifest: connectorManifest(kind), config: { enabled: true, projectIds: null, rules: {}, resources: [] } });
  if (!entry) throw Error('Live-check profile does not match the connector.');
  if (process.env.TINYGPT_LIVE_TRACE === '1') {
    const request = globalThis.fetch;
    globalThis.fetch = async (address, options) => {
      let method: string | undefined; try { method = JSON.parse(String(options?.body)).method; } catch {}
      const response = await request(address, options);
      if (!method) return response;
      console.log(JSON.stringify({ rpc: method, http: response.status, type: response.headers.get('content-type') }));
      if (!response.body) return response;
      let chunks = 0; let total = 0; let events = 0; const decoder = new TextDecoder(); let pending = '';
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(value, controller) {
        total += value.byteLength; if (++chunks % 100 === 0) console.log(JSON.stringify({ rpc: method, bytes: total, chunks }));
        if (total <= 4 * 1024 * 1024) {
          pending += decoder.decode(value, { stream: true }); const lines = pending.split('\n'); pending = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('event:') && ++events <= 5) console.log(JSON.stringify({ rpc: method, event: line.slice(6).trim().slice(0, 60) }));
            if (line.startsWith('data:')) { try { const data = JSON.parse(line.slice(5)); console.log(JSON.stringify({ rpc: method, id: data.id, notification: data.method, fields: Object.keys(data), resultFields: data.result && Object.keys(data.result), toolCount: data.result?.tools?.length, catalogBytes: data.result?.tools && JSON.stringify(data.result.tools).length, largestSchema: data.result?.tools && Math.max(...data.result.tools.map((tool: any) => JSON.stringify(tool.inputSchema).length)), errorCode: data.error?.code })); } catch { console.log(JSON.stringify({ rpc: method, nonJsonData: true })); } }
          }
        }
        controller.enqueue(value);
      } }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  }
  for (const method of ['connect', 'catalog', 'finishAuth'] as const) {
    const original = McpConnection.prototype[method] as (...args: any[]) => Promise<any>;
    (McpConnection.prototype[method] as any) = async function (...args: any[]) {
      if (method === 'catalog') {
        const client = (this as any).client;
        console.log(JSON.stringify({ capabilities: client.getServerCapabilities() }));
        for (const action of ['listTools', 'listResources', 'listPrompts']) {
          const invoke = client[action].bind(client);
          client[action] = async (...input: any[]) => { console.log(JSON.stringify({ discovery: action, status: 'started' })); const result = await invoke(...input); console.log(JSON.stringify({ discovery: action, status: 'complete', count: (result.tools ?? result.resources ?? result.prompts ?? []).length })); return result; };
        }
      }
      try { return await original.apply(this, args); } catch (error) { if (!(error instanceof Error) || error.message !== 'Unauthorized') console.log(boundedPluginResult({ phase: method, error: error instanceof Error ? { name: error.name, message: error.message.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500) } : 'unknown' }, store.credentials(entry.id))); throw error; }
    };
  }
  if (entry.manifest.server) {
    const history = new HistoryStore(resolve(profile, 'live-check.sqlite'));
    const service = new PluginService(store, history, new ProjectFiles(history.sources), () => {}, () => true, async url => { console.log(JSON.stringify({ authorizationUrl: url })); });
    try {
      const connected = (await service.connect(entry.id)).entries.find(item => item.id === entry.id)!;
      if (connected.status !== 'connected') { console.log(JSON.stringify({ status: 'not-ready', message: connected.message })); throw Error(`${kind} connection did not complete.`); }
      console.log(JSON.stringify({ status: 'authorized', kind, profile, tools: connected.tools.map(tool => tool.originalName) }));
      await service.disconnect(entry.id);
      const restored = (await service.connect(entry.id, false)).entries.find(item => item.id === entry.id)!;
      if (restored.status !== 'connected') throw Error(`${kind} reconnect did not complete.`);
      console.log(JSON.stringify({ status: 'reconnect-verified', kind }));
    } finally { await service.shutdown(); history.close(); app.quit(); }
    return;
  }
  if (!resume) { const registration = connectorRegistration(kind); if (!registration) throw Error('Publisher registration is missing.'); await store.saveCredentials(entry.id, { connectorAuth: registration }); }
  const controller = new AbortController();
  const request: typeof fetch = async (address, options) => { const response = await fetch(address, options); if (!response.ok || String(address).includes('oauth.v2.access')) { const result = await response.clone().json().catch(() => ({})) as { error?: string; diagnostic?: string }; if (result.error && /^[a-z_]{1,80}$/.test(result.error)) console.log(JSON.stringify({ providerError: result.error, ...(String(address).startsWith('https://plugin.tinygpt.org/') && result.diagnostic ? { diagnostic: result.diagnostic } : {}) })); } return response; };
  const oauth = new ConnectorOAuth(store, entry.id, async url => { console.log(JSON.stringify({ authorizationUrl: url })); }, (message, code) => console.log(JSON.stringify({ progress: message, ...(code ? { userCode: code } : {}) })), request);
  try {
    if (!resume) await oauth.authorize(kind, controller.signal);
    const client = new ConnectorClient(kind, () => oauth.token(controller.signal)); await client.health(controller.signal); oauth.complete(true);
    console.log(JSON.stringify({ status: 'authorized', profile, tools: client.tools().map(tool => tool.name) }));
    const credentials = store.credentials(entry.id)!;
    if (credentials.connectorAuth?.refreshToken) {
      await store.saveCredentials(entry.id, { connectorAuth: { ...credentials.connectorAuth, expiresAt: 1 } });
      await oauth.token(controller.signal); await client.health(controller.signal);
      console.log(JSON.stringify({ status: 'refresh-verified', kind }));
    }
    await new Promise(done => setTimeout(done, 3000));
  } finally { oauth.close(); await store.flush(); app.quit(); }
}).catch(error => { console.error(JSON.stringify({ status: 'failed', message: error instanceof Error && ['Authorization failed. Check the app registration and try again.', 'Authorization timed out. Try signing in again.', 'Sign in again to reconnect this account.'].includes(error.message) ? error.message : 'Live authorization or account check did not complete.' })); app.exit(1); });
