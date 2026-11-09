import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { PluginServer, PluginCredentials, PluginResource } from '../shared/plugins';

export interface DiscoveredTool { name: string; description: string; schema: Record<string, unknown> }
export interface McpCatalog { tools: DiscoveredTool[]; resources: PluginResource[]; prompts: { name: string; description?: string; arguments?: { name: string; required?: boolean }[] }[] }
export class McpConnection {
  private client = new Client({ name: 'TinyGPT', version: '0.1.0' }, { capabilities: {} });
  private transport?: StdioClientTransport | StreamableHTTPClientTransport;
  private closed = false;
  constructor(private server: PluginServer, private credentials: PluginCredentials = {}, private changed: () => void = () => {}, private lost: () => void = () => {}, private oauth?: OAuthClientProvider) {}
  async connect(signal: AbortSignal): Promise<void> {
    const config = this.server;
    this.transport = config.transport === 'stdio' ? new StdioClientTransport({ command: config.command, args: config.args, env: { ...getDefaultEnvironment(), ...Object.fromEntries(config.environment.flatMap(name => this.credentials.environment?.[name] === undefined ? [] : [[name, this.credentials.environment[name]]])) }, stderr: 'ignore', maxBufferSize: 1024 * 1024 }) : new StreamableHTTPClientTransport(new URL(config.endpoint), {
      authProvider: config.auth === 'oauth' ? this.oauth : undefined,
      requestInit: { redirect: 'error', ...(config.auth === 'bearer' && this.credentials.bearer ? { headers: { Authorization: `Bearer ${this.credentials.bearer}` } } : {}) },
      fetch: async (url, options) => {
        const target = new URL(url);
        // MCP requests use the configured origin; auth discovery/token requests are
        // allowed only through the SDK's issuer-bound OAuth provider over HTTPS.
        if (target.origin !== new URL(config.endpoint).origin && (config.auth !== 'oauth' || target.protocol !== 'https:')) throw new Error('Unexpected MCP destination.');
        const response = await fetch(url, { ...options, redirect: 'error', signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal });
        let catalogRequest = false; try { catalogRequest = JSON.parse(String(options?.body)).method === 'tools/list'; } catch {}
        // Creative catalogs can contain large model/parameter descriptions.
        // Keep content responses at 1 MB and allow bounded tool discovery at 4 MB.
        const limit = (catalogRequest ? 4 : 1) * 1024 * 1024;
        if (Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new Error('MCP response exceeds its size limit.'); }
        if (!response.body) return response;
        let size = 0;
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { size += chunk.byteLength; if (size > limit) { controller.error(new Error('MCP response exceeds its size limit.')); return; } controller.enqueue(chunk); } }));
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
      reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 5000, reconnectionDelayGrowFactor: 1.5, maxRetries: 2 },
    });
    this.client.onclose = () => { if (!this.closed) this.lost(); };
    this.client.onerror = () => { /* Connection errors are surfaced without server-provided secret text. */ };
    await this.client.connect(this.transport, { signal, timeout: 20000 });
    for (const schema of [ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema, PromptListChangedNotificationSchema]) this.client.setNotificationHandler(schema, this.changed);
  }
  async finishAuth(code: string): Promise<void> { if (!(this.transport instanceof StreamableHTTPClientTransport)) throw new Error('OAuth requires an HTTP server.'); await this.transport.finishAuth(code); }
  async catalog(signal: AbortSignal): Promise<McpCatalog> {
    const capabilities = this.client.getServerCapabilities();
    const options = { signal, timeout: 60000 };
    const tools: DiscoveredTool[] = []; const resources: PluginResource[] = []; const prompts: McpCatalog['prompts'] = [];
    if (capabilities?.tools) {
      let cursor: string | undefined;
      do { const result = await this.client.listTools({ cursor }, options); for (const tool of result.tools) tools.push({ name: tool.name, description: tool.description ?? '', schema: tool.inputSchema }); cursor = result.nextCursor; if (tools.length > 200) throw new Error('Server offers more than 200 tools.'); } while (cursor);
    }
    if (capabilities?.resources) {
      let cursor: string | undefined;
      do { const result = await this.client.listResources({ cursor }, options); resources.push(...result.resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }))); cursor = result.nextCursor; if (resources.length >= 100) break; } while (cursor); resources.splice(100);
    }
    if (capabilities?.prompts) { const result = await this.client.listPrompts({}, options); prompts.push(...result.prompts.slice(0, 100)); }
    return { tools, resources, prompts };
  }
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> { return this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 45000, maxTotalTimeout: 45000 }); }
  read(uri: string, signal: AbortSignal): Promise<unknown> { return this.client.readResource({ uri }, { signal, timeout: 30000 }); }
  prompt(name: string, args: Record<string, string>, signal: AbortSignal): Promise<unknown> { return this.client.getPrompt({ name, arguments: args }, { signal, timeout: 30000 }); }
  async close(): Promise<void> { this.closed = true; await this.client.close().catch(() => {}); await this.transport?.close().catch(() => {}); }
}
