import { app } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve, dirname, delimiter } from 'node:path';
import { createServer } from 'node:net';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import WebSocket from 'ws';
import { nativeBotConfig, syncBotIdentity } from './bot-native-config';
import type { BotConfiguration } from '../shared/bot';

export const OPENCLAW_VERSION = '2026.9.9';
export const OPENCLAW_RUNTIME_ERROR = 'The Bot runtime could not start. Try again after checking its installation.';
type Identity = { id: string; publicKey: string; privateKey: string };
export interface OpenClawRuntimeOptions {
  profileDirectory: string;
  runtimeDirectory?: string;
  startupTimeoutMs?: number;
  // The native runtime sees only a private loopback capability or proof fixture.
  fixtureEndpoint?: string;
  inference?: { endpoint: string; api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; token: string; contextWindowTokens?: number; maxOutputTokens?: number; vision?: boolean };
  toolBridge?: boolean;
  bot?: { name: string; configuration: BotConfiguration };
  diagnostic?: (event: { event: string; exitCode?: number | null; forced?: boolean; reason?: string }) => void;
}
export function openClawRuntimeDirectory(): string {
  return app.isPackaged ? join(process.resourcesPath, 'openclaw') : join(app.getAppPath(), 'runtimes', 'openclaw');
}
export function openClawEnvironment(profile: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'SYSTEMDRIVE', 'LANG', 'LC_ALL']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, HOME: profile, USERPROFILE: profile, APPDATA: join(profile, 'home', 'roaming'), LOCALAPPDATA: join(profile, 'home', 'local'), TMP: join(profile, 'tmp'), TEMP: join(profile, 'tmp'),
    OPENCLAW_HOME: profile, OPENCLAW_STATE_DIR: join(profile, 'state'), OPENCLAW_CONFIG_PATH: join(profile, 'openclaw.json'), OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', NODE_DISABLE_COMPILE_CACHE: '1' };
}
async function unusedPort(): Promise<number> {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function identity(profile: string): Promise<Identity> {
  const path = join(profile, 'device.json');
  try { return JSON.parse(await readFile(path, 'utf8')) as Identity; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = generateKeyPairSync('ed25519'); const raw = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const device = { id: createHash('sha256').update(raw).digest('hex'), publicKey: raw.toString('base64url'), privateKey: key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  await writeFile(path, JSON.stringify(device), { mode: 0o600, flag: 'wx' }); return device;
}

/** Private supervised runtime; TinyGPT owns inference credentials and action permissions. */
export class OpenClawRuntime {
  private child?: ChildProcess;
  private socket?: WebSocket;
  private exited?: Promise<void>;
  private stopping?: Promise<void>;
  private closing = false;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: string, payload: any) => void>();
  private constructor(private options: OpenClawRuntimeOptions, readonly url: string) {}
  get pid(): number | undefined { return this.child?.pid; }
  get available(): boolean { return !this.closing && this.socket?.readyState === WebSocket.OPEN && this.child?.exitCode === null; }
  onEvent(listener: (event: string, payload: any) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private trace(event: string, exitCode?: number | null, forced?: boolean, reason?: string): void { try { this.options.diagnostic?.({ event, exitCode, forced, reason }); } catch { /* Best effort. */ } }
  private disconnect(): void { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('The Bot runtime connection closed.')); } this.pending.clear(); }
  static async start(options: OpenClawRuntimeOptions): Promise<OpenClawRuntime> {
    const profile = resolve(options.profileDirectory), root = options.runtimeDirectory ?? openClawRuntimeDirectory();
    const prepared = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8'));
    if (prepared.openclaw !== OPENCLAW_VERSION || prepared.node !== '24.19.0' || prepared.target !== `${process.platform}-${process.arch}`) throw new Error(OPENCLAW_RUNTIME_ERROR);
    const executable = join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node'); await access(executable);
    const port = await unusedPort(), token = randomBytes(32).toString('base64url');
    const runtime = new OpenClawRuntime(options, `ws://127.0.0.1:${port}`);
    for (const directory of [profile, join(profile, 'tmp'), join(profile, 'home/roaming'), join(profile, 'home/local')]) await mkdir(directory, { recursive: true });
    const device = await identity(profile);
    const endpoint = options.inference?.endpoint ?? options.fixtureEndpoint;
    const contextWindow = options.inference?.contextWindowTokens ?? 64000;
    const maxTokens = options.inference?.maxOutputTokens ?? 4096;
    if (endpoint) { const url = new URL(endpoint); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('Runtime proofs require a loopback fixture endpoint.'); }
    let config: Record<string, any> = {
      gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token }, controlUi: { enabled: false } },
      discovery: { mdns: { mode: 'off' } }, browser: { enabled: false },
      plugins: options.toolBridge ? { enabled: true, allow: ['tinygpt-bridge'], load: { paths: [join(root, 'tinygpt-bridge')] }, slots: { memory: 'none' }, entries: { 'tinygpt-bridge': { enabled: true } } } : { enabled: false }, cron: { enabled: false },
      tools: options.toolBridge ? { allow: ['tinygpt_action'], toolSearch: false } : { deny: ['*'] }, update: { checkOnStart: false }, logging: { level: 'silent', consoleLevel: 'silent' },
      agents: { defaults: { workspace: join(profile, 'workspace'), skipBootstrap: true, heartbeat: { every: '0m' },
        ...(endpoint ? { model: { primary: 'tinygpt/fixture' }, modelPolicy: { allow: ['tinygpt/fixture'] }, contextTokens: contextWindow } : {}) } },
      models: { catalogRefresh: { enabled: false }, ...(endpoint ? { mode: 'replace', providers: { tinygpt: { baseUrl: endpoint, apiKey: options.inference?.token ?? 'local-fixture', api: options.inference?.api ?? 'openai-completions', models: [{ id: 'fixture', name: 'TinyGPT connection', reasoning: false, input: options.inference?.vision ? ['text', 'image'] : ['text'], contextWindow, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } } : {}) },
    };
    if (options.bot) {
      let previous = {};
      try { previous = JSON.parse(await readFile(join(profile, 'openclaw.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      config = nativeBotConfig(previous, config, profile, root, options.bot.name, options.bot.configuration);
      await syncBotIdentity(profile, options.bot.name, root);
    }
    await writeFile(join(profile, 'openclaw.json'), JSON.stringify(config), { mode: 0o600 });
    const env = openClawEnvironment(profile, port);
    if (options.bot) {
      const windows = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      env.PATH = [dirname(executable), ...(process.platform === 'win32' ? [join(windows, 'System32'), join(windows, 'System32/WindowsPowerShell/v1.0'), windows] : ['/usr/bin', '/bin'])].join(delimiter);
    }
    if (options.toolBridge && options.inference) { env.TINYGPT_BOT_BRIDGE_ENDPOINT = options.inference.endpoint; env.TINYGPT_BOT_BRIDGE_TOKEN = options.inference.token; }
    const child = fork(join(root, 'host.mjs'), ['gateway', 'run'], { execPath: executable, execArgv: [], cwd: profile, env, silent: true, windowsHide: true });
    runtime.child = child;
    // Drain both pipes; never publish raw runtime logs, paths, prompts or secrets.
    child.stdout?.resume(); child.stderr?.resume(); child.on('error', () => runtime.trace('runtime-spawn-error'));
    runtime.exited = new Promise<void>(resolve => child.once('close', code => { runtime.trace('runtime-exit', code); runtime.socket?.terminate(); runtime.disconnect(); resolve(); }));
    runtime.trace('runtime-start');
    try {
      // Cold Windows package imports can exceed a minute; readiness stays bounded.
      const until = Date.now() + (options.startupTimeoutMs ?? 120000);
      while (Date.now() < until && child.exitCode === null && child.signalCode === null) {
        try { await runtime.connect(token, device); runtime.trace('runtime-ready'); return runtime; } catch (error) {
          const failure = error as Error & { retryable?: boolean; retryAfterMs?: number }; if (failure.retryable === false) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(200, failure.retryAfterMs ?? 200))));
        }
      }
      throw new Error(OPENCLAW_RUNTIME_ERROR);
    } catch (error) { await runtime.stop(); throw error; }
  }
  private connect(token: string, device: Identity): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, { handshakeTimeout: 3000, maxPayload: 2_000_000 }); this.socket = socket;
      const timer = setTimeout(() => { socket.terminate(); reject(new Error(OPENCLAW_RUNTIME_ERROR)); }, 4000);
      const fail = () => { clearTimeout(timer); reject(new Error(OPENCLAW_RUNTIME_ERROR)); };
      socket.on('error', fail); socket.on('close', () => { fail(); this.disconnect(); });
      socket.on('message', data => {
        let frame: any; try { frame = JSON.parse(data.toString()); } catch { socket.terminate(); return; }
        if (frame.type === 'event') {
          if (frame.event === 'connect.challenge') {
            const { nonce, ts } = frame.payload ?? {}; if (typeof nonce !== 'string' || !Number.isSafeInteger(ts) || ts < 0) { socket.terminate(); return; }
            const scopes = ['operator.read', 'operator.write', 'operator.admin', 'operator.approvals']; const clientId = 'cli', mode = 'cli';
            const payload = ['v3', device.id, clientId, mode, 'operator', scopes.join(','), String(ts), token, nonce, process.platform, ''].join('|');
            const signature = sign(null, Buffer.from(payload), createPrivateKey(device.privateKey)).toString('base64url');
            socket.send(JSON.stringify({ type: 'req', id: 'connect', method: 'connect', params: { minProtocol: 4, maxProtocol: 4, client: { id: clientId, version: 'tinygpt-desktop', platform: process.platform, mode }, role: 'operator', scopes, caps: ['tool-events', 'exec-approvals'], auth: { token }, device: { id: device.id, publicKey: device.publicKey, signature, signedAt: ts, nonce } } }));
          } else for (const listener of this.listeners) listener(frame.event, frame.payload);
        } else if (frame.type === 'res') {
          if (frame.id === 'connect') {
            clearTimeout(timer);
            if (frame.ok && frame.payload?.type === 'hello-ok') resolve();
            else {
              const reason = frame.error?.details?.code ?? frame.error?.code;
              this.trace('runtime-connect-rejected', undefined, undefined, typeof reason === 'string' && /^[A-Z_]+$/.test(reason) ? reason : 'INVALID_HELLO');
              const failure = Object.assign(new Error(OPENCLAW_RUNTIME_ERROR), { retryable: reason === 'UNAVAILABLE', retryAfterMs: Number.isFinite(frame.error?.retryAfterMs) ? frame.error.retryAfterMs : 1000 });
              reject(failure); socket.terminate();
            }
            return;
          }
          const request = this.pending.get(frame.id); if (!request) return;
          clearTimeout(request.timer); this.pending.delete(frame.id);
          if (frame.ok) request.resolve(frame.payload); else request.reject(new Error(typeof frame.error?.code === 'string' ? `Bot runtime request failed (${frame.error.code}).` : 'Bot runtime request failed.'));
        }
      });
    });
  }
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
    if (this.closing || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The Bot runtime is unavailable.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The Bot runtime request timed out.')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type: 'req', id, method, params }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('The Bot runtime connection closed.')); } });
    });
  }
  stop(): Promise<void> {
    return this.stopping ??= this.finishStop();
  }
  private async finishStop(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      this.trace('runtime-stop');
      if (child.connected) child.send({ type: 'shutdown' }, () => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 15000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { this.trace('runtime-stop', undefined, true); child.kill(); await this.exited; }
    }
    this.socket?.terminate(); this.disconnect(); this.listeners.clear();
  }
}
