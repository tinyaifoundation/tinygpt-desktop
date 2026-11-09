import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Windows uses the public direct stdio host. The pinned MCP transport launches
 * with windowsHide:true and shell:false, preventing a console at process creation.
 * Each host retains the same immutable, app-scoped bounded capability manifest. */
export async function openHiddenComputerDriver(binaryPath: string, manifest: string, bundleId: string) {
  const transport = new StdioClientTransport({
    command: binaryPath,
    args: ['mcp', '--direct', '--embedded', '--host-bundle-id', bundleId],
    env: { CUA_DRIVER_PERMISSION_MODE: 'bounded', CUA_DRIVER_CAPABILITY_MANIFEST_FILE: manifest, CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED: '1', CUA_DRIVER_DISABLE_UNRESTRICTED: '1' },
    stderr: 'ignore', maxBufferSize: 24 * 1024 * 1024,
    // The transport inherits only its safe OS environment, never ambient Cua
    // grants, bypass flags, provider credentials or a different capability file.
  });
  const client = new Client({ name: 'TinyGPT Voice desktop', version: '0.1.0' }, { capabilities: {} });
  let closed = false;
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closed = true;
    return closing ??= client.close().finally(() => transport.close());
  };
  client.onclose = () => { closed = true; };
  try { await client.connect(transport, { signal: AbortSignal.timeout(10000) }); }
  catch (error) { await shutdown(); throw error; }
  return {
    async callTool(name: string, json: string, { signal }: { signal: AbortSignal }) {
      signal.throwIfAborted();
      if (closed) throw new Error('The desktop helper is closed.');
      const abort = () => {
        // Terminate only our owned helper before draining IPC. An interrupted
        // write has an uncertain outcome and must never continue or be replayed.
        if (transport.pid) { try { process.kill(transport.pid); } catch { /* Already exited. */ } }
        void shutdown().catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await client.callTool({ name, arguments: JSON.parse(json) }, undefined, { signal, timeout: 15000 });
        const data = result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent) ? result.structuredContent as Record<string, unknown> : undefined;
        const refusal = data?.refusal;
        const errorCode = typeof data?.code === 'string' ? data.code : refusal && typeof refusal === 'object' && 'code' in refusal && typeof refusal.code === 'string' ? refusal.code : undefined;
        const images = Array.isArray(result.content) ? result.content.flatMap(part => part.type === 'image' ? [{ mimeType: part.mimeType, dataBase64: part.data }] : []) : [];
        return { text: '', images, structuredJson: data ? JSON.stringify(data) : undefined, isError: result.isError === true, errorCode, degraded: data?.degraded === true };
      } finally { signal.removeEventListener('abort', abort); }
    },
    shutdown,
    uniffiDestroy() { /* The native handle belongs to the child, not Electron. */ },
  };
}
