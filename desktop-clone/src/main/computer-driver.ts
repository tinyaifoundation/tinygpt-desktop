import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openHiddenComputerDriver } from './computer-stdio';
import type { ComputerSnapshot } from '../shared/computer';

export const CUA_VERSION = '0.38.0';
export type NativeComputerTool = 'list_apps' | 'list_windows' | 'get_window_state' | 'launch_app' | 'click' | 'set_value' | 'press_key' | 'scroll';
export interface ComputerDriver { call(name: NativeComputerTool, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>; close(): Promise<void> }
export type ComputerResource = { executable?: string; bundleId?: string; launchOnly?: boolean };
export interface ComputerDriverFactory { available(): Promise<boolean>; open(resource?: ComputerResource): Promise<ComputerDriver> }
export class ComputerFailure extends Error {
  recovery?: { kind: 'activate-window' | 'choose-app'; windowId?: string; candidates?: { appId: string; label: string }[] };
  snapshot?: ComputerSnapshot;
  manualDraft?: string;
  constructor(readonly code: string, message: string) { super(message); }
}
// The SDK is bundled in its own dependency tree, avoiding changes to the original
// desktop's shared node_modules. This is the small pinned SDK boundary we use.
interface NativeClient {
  callTool(name: string, json: string, options: { signal: AbortSignal }): Promise<{ text: string; images?: { mimeType: string; dataBase64: string }[]; structuredJson?: string; isError: boolean; errorCode?: string; degraded: boolean }>;
  shutdown(): Promise<void>;
  uniffiDestroy(): void;
}
interface NativeHost { start(): Promise<{ socketPath: string }>; stop(): Promise<void>; uniffiDestroy(): void }
interface CuaSdk {
  CuaDriver: { connect(path: string): NativeClient };
  EmbeddedCuaDriverHost: { withOptions(options: unknown): NativeHost };
}
const nativeInputTools = ['get_window_state', 'click', 'set_value', 'press_key', 'scroll'];
export class CuaDriverFactory implements ComputerDriverFactory {
  constructor(private runtime: string, private manifests: string, private platform = process.platform, private bundleId = 'com.tinygpt.voice.clone') {}
  async available(): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(join(this.runtime, 'prepared.json'), 'utf8'));
      return value.version === CUA_VERSION && value.target === `${this.platform}-${process.arch}` && (await stat(join(this.runtime, this.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'))).size > 0 && (await stat(join(this.runtime, 'sdk/node_modules/@trycua/cua-driver/dist/index.js'))).size > 0;
    } catch { return false; }
  }
  async open(resource?: ComputerResource): Promise<ComputerDriver> {
    if (!await this.available()) throw new ComputerFailure('COMPUTER_RUNTIME_UNAVAILABLE', 'The bundled computer-use runtime is unavailable. Rebuild or reinstall TinyGPT Voice.');
    await mkdir(this.manifests, { recursive: true });
    const manifest = join(this.manifests, `${randomUUID()}.json`);
    const tools = resource ? resource.launchOnly ? ['launch_app'] : nativeInputTools : ['list_apps', 'list_windows'];
    await writeFile(manifest, JSON.stringify({ version: 3, expires_after: '15m', idle_timeout: '5m', allow: { tools }, resources: {
      apps: resource ? [{ ...(resource.bundleId ? { bundle_id: resource.bundleId } : { executable: resource.executable }), launch: resource.launchOnly === true, windows: 'all', terminate: 'deny' }] : [],
      // Discovery needs display observation authority, but its immutable tool
      // ceiling permits metadata only: no screenshots, document reads or input.
      desktop: { display: !resource },
    } }), { mode: 0o600 });
    let native: NativeClient | undefined;
    let host: NativeHost | undefined;
    try {
      const binaryPath = join(this.runtime, this.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
      if (this.platform === 'darwin') {
        const sdk: CuaSdk = await import(/* @vite-ignore */ pathToFileURL(join(this.runtime, 'sdk/node_modules/@trycua/cua-driver/dist/index.js')).href);
        // Must be called directly by the permission-owning Electron main process.
        host = sdk.EmbeddedCuaDriverHost.withOptions({ binaryPath, hostBundleId: this.bundleId, permissionMode: 1, capabilityManifestPath: manifest, approveCapabilityManifest: true, approveSessionPolicy: false, dangerouslyBypassApprovals: false, environment: [], inheritStderr: false, noOverlay: false, startupTimeoutMs: 10000n, shutdownTimeoutMs: 2000n });
        native = sdk.CuaDriver.connect((await host.start()).socketPath);
      } else {
        native = await openHiddenComputerDriver(binaryPath, manifest, this.bundleId);
      }
      const client = native;
      let closed = false;
      return {
        call: async (name, args, signal) => {
          signal.throwIfAborted();
          if (closed || !tools.includes(name)) throw new ComputerFailure('COMPUTER_SESSION_CLOSED', 'This computer-use session is closed or the operation is outside its scope.');
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
          let result;
          try { result = await client.callTool(name, JSON.stringify(args), { signal: deadline }); }
          catch { throw new ComputerFailure('COMPUTER_ACTION_UNCERTAIN', 'The computer operation was interrupted. Its outcome is unknown. Read a fresh window state before deciding whether to retry.'); }
          signal.throwIfAborted();
          if (result.isError) {
            if (result.errorCode === 'window_minimized') throw new ComputerFailure('COMPUTER_WINDOW_MINIMIZED', 'The target window is minimized. This action was not delivered. Use computer_activate_window with this windowId to restore the existing window through the foreground approval flow, then act on its fresh snapshot. Repeating reads or the same background click cannot restore it.');
            if (name === 'set_value' && result.errorCode === 'tool_invocation_failed') throw new ComputerFailure('COMPUTER_TEXT_WRITE_UNSUPPORTED', 'This editor could not confirm a direct text replacement. Read it once to check the contents, then offer the user a draft to paste manually. Do not retry this write or switch input tools.');
            throw new ComputerFailure(result.errorCode ?? 'COMPUTER_DRIVER_REFUSED', 'The app could not complete this action. Read its current state or use manual interaction; do not repeat the action or bypass a permission decision.');
          }
          if (!result.structuredJson) throw new ComputerFailure('COMPUTER_STATE_UNAVAILABLE', 'The application did not return structured state. Use manual interaction.');
          const value: unknown = JSON.parse(result.structuredJson);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputerFailure('COMPUTER_STATE_UNAVAILABLE', 'The application did not return structured state.');
          return { ...value as Record<string, unknown>, ...(args.include_screenshot === true ? { captureImages: result.images ?? [] } : {}), ...(result.degraded ? { degraded: true } : {}) };
        },
        close: async () => {
          if (closed) return;
          closed = true;
          try { await client.shutdown(); } finally { client.uniffiDestroy(); try { await host?.stop(); } finally { host?.uniffiDestroy(); await rm(manifest, { force: true }); } }
        },
      };
    } catch (error) {
      try { await native?.shutdown(); } finally { native?.uniffiDestroy(); try { await host?.stop(); } finally { host?.uniffiDestroy(); await rm(manifest, { force: true }); } }
      throw error;
    }
  }
}
