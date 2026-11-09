import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, open, rename, rm, writeFile, access } from 'node:fs/promises';
import { join,delimiter } from 'node:path';
import { createServer } from 'node:net';
import { availableParallelism, freemem } from 'node:os';
import type { ManagedLocalStatus } from '../shared/managed-local';
import { builtInModels, type BuiltInModelId } from '../shared/managed-local';
import { scanBuiltInHardware } from './built-in-hardware';
import { analyzeProImage } from './pro-vision';
import { VisionFailure, type VisionObservation } from './local-vision';
import { promptCacheMiB, proRequiredFreeBytes, managedPerformanceEnv, type ManagedPerformance } from './managed-performance';
import { nativePerformanceObserver } from '../core/native-performance';
import type { NativePerformance } from '../shared/diagnostics';

const exec = promisify(execFile);
const release = 'https://github.com/ggml-org/llama.cpp/releases/download/b11960/';
export const managedLocalPins = {
  model: { url: 'https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/2079a22f3beaa4e306449978533478fe0522f4b3/MiniCPM5-2B-Q4_K_M.gguf', sha256: 'ec2d5801640099e97d8d7e8003ad4d81f336e757811f03a26173dddf386602fd', size: 1561318368 },
  pro: { url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/94dd51cdbbec5309ed8b76a12f3268bc4fdceb93/Ternary-Bonsai-2-27B-Q2_0.gguf', sha256: '4f99aed01b8a877e153f9aa6569a4440fe17c59701cc0953e36d7f460549e70e', size: 7626008928 },
  proVision: { url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/94dd51cdbbec5309ed8b76a12f3268bc4fdceb93/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf', sha256: '6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903', size: 629246976 },
  proMtp: { url: 'https://huggingface.co/ggml-org/Qwen3.8-27B-GGUF/resolve/a316ea527fde32c12487be7574e2db5ac2ad2a7e/mtp-Qwen3.8-27B-Q4_0.gguf', sha256: 'c5be331f82fb61f5304adfa00ccd60c6743c8ce52255d66fa863446231d49ba4', size: 1680271776 },
  CUDA: [
    { name: 'llama-b11960-bin-win-cuda-12.4-x64.zip', sha256: '8d9d819261de10cc2f03921b8b79c779c5c458e21edb60c170ee30a7d462d684', size: 279763224 },
    { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6', size: 391443627 },
  ],
  Vulkan: [{ name: 'llama-b11960-bin-win-vulkan-x64.zip', sha256: 'bac6914b5e83523eb008c6789eaa12669f93fbc196c3b9e8237b6672323b33e9', size: 37345851 }],
};

export function managedServerArgs(model: string, port: number, keyFile: string, backend: string, speculative = false, modelId: BuiltInModelId = 'included', projector?: string, performance: ManagedPerformance = {}) {
  const profile = builtInModels[modelId];
  const mtp = modelId === 'pro' && speculative;
  if (mtp && !performance.mtpModel) throw new Error('Pro acceleration requires its prediction support file.');
  return ['--model', model, '--alias', profile.id, '--host', '127.0.0.1', '--port', String(port), '--api-key-file', keyFile,
    '--ctx-size', String(profile.context), '--parallel', '1', '--n-gpu-layers', backend === 'CPU' ? '0' : '99',
    '--flash-attn', 'on', '--cache-type-k', performance.cacheK ?? 'q8_0', '--cache-type-v', performance.cacheV ?? 'q8_0', '--batch-size', '1024', '--ubatch-size', String(performance.microbatch ?? 256),
    '--threads', String(Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)))), '--jinja', '--no-context-shift',
    '--reasoning-format', 'deepseek', '--cache-ram', String(performance.cacheMiB ?? (modelId === 'pro' ? promptCacheMiB() : 512)),
    '--temp', '1.0', '--top-p', '0.95', '--min-p', modelId === 'pro' ? '0.05' : '0.0', '--n-predict', String(profile.output),
    ...(modelId === 'pro' ? ['--split-mode', 'none', '--main-gpu', '0', '--top-k', '20', '--chat-template-kwargs', '{"reasoning_effort":"medium"}'] : []),
    ...(modelId === 'pro' && projector ? ['--mmproj', projector, '--no-mmproj-offload', '--image-max-tokens', '2048'] : []),
    ...(performance.backendSampling && backend === 'CUDA' ? ['--backend-sampling'] : []),
    '--spec-type', mtp ? 'draft-mtp' : speculative ? 'ngram-simple' : 'none',
    ...(mtp ? ['--spec-draft-model', performance.mtpModel!, '--spec-draft-n-max', String(performance.draftTokens ?? 1), '--spec-draft-ngl', '99', '--spec-draft-type-k', performance.cacheK ?? 'q8_0', '--spec-draft-type-v', performance.cacheV ?? 'q8_0'] : speculative ? ['--spec-ngram-simple-size-n', '12', '--spec-ngram-simple-size-m', '16'] : [])];
}

/** Owns only TinyGPT's private server; existing local servers are never killed. */
export class ManagedLocalModel {
  private state: ManagedLocalStatus = { phase: 'idle', message: 'Download once, then run locally.' };
  private controller?: AbortController;
  private task?: Promise<{ endpoint: string; key: string }>;
  private child?: ChildProcess;
  private key = '';
  private logs = '';
  private imageCache = new Map<string, VisionObservation>();
  private logFile?: Awaited<ReturnType<typeof open>>;
  constructor(private root: string, private bundledRoot?: string, readonly modelId: BuiltInModelId = 'included', private runtimeRoot = root, private performanceSink?: (metric: NativePerformance) => void) {}
  status(): ManagedLocalStatus { return { ...this.state, modelId: this.modelId }; }
  processId(): number | undefined { return this.child?.exitCode === null && this.child?.signalCode === null ? this.child.pid : undefined; }
  imageAvailable() { return this.modelId === 'pro' && this.state.phase === 'running'; }
  async analyze(image: string, question: string, signal: AbortSignal): Promise<VisionObservation> {
    signal.throwIfAborted();
    if (!this.imageAvailable() || !this.state.endpoint || !this.controller) throw new VisionFailure('VISION_UNAVAILABLE', 'Start Pro in Configuration to use its image analysis.');
    const cacheKey = createHash('sha256').update(image).update(question).digest('hex'), cached = this.imageCache.get(cacheKey);
    if (cached) return { ...cached };
    const requestSignal = AbortSignal.any([signal, this.controller.signal]);
    const result = await analyzeProImage(this.state.endpoint, this.key, image, question, requestSignal);
    requestSignal.throwIfAborted();
    if (!result.incomplete) { this.imageCache.set(cacheKey, result); while (this.imageCache.size > 8) this.imageCache.delete(this.imageCache.keys().next().value!); }
    return { ...result };
  }
  private get profile() { return builtInModels[this.modelId]; }
  private get pin() { return this.modelId === 'pro' ? managedLocalPins.pro : managedLocalPins.model; }
  async installedStatus(prediction = false): Promise<ManagedLocalStatus> {
    const sized = async (path: string, size?: number) => { const file = await stat(path).catch(() => null); return !!file?.isFile() && (size === undefined ? file.size > 0 : file.size === size); };
    const installed = await sized(this.modelPath, this.pin.size);
    const bundled = this.bundledRoot && this.modelId === 'included';
    const runtimeReady = async (backend: 'CUDA' | 'Vulkan' | 'Metal') => {
      const runtime = bundled ? join(this.bundledRoot!, 'llama') : join(this.runtimeRoot, `llama-b11960-${backend}`);
      const files = process.platform === 'win32' ? ['llama-server.exe', 'llama-server-impl.dll', 'llama.dll', 'ggml.dll', 'ggml-base.dll', backend === 'CUDA' ? 'ggml-cuda.dll' : 'ggml-vulkan.dll'] : ['llama-server'];
      const checks = files.map(file => sized(join(runtime, file)));
      if (!bundled && backend !== 'Metal') checks.push(...managedLocalPins[backend].map(asset => sized(join(this.runtimeRoot, asset.name), asset.size)));
      return (await Promise.all(checks)).every(Boolean);
    };
    const runtimes = bundled ? [await runtimeReady(process.platform === 'darwin' ? 'Metal' : 'Vulkan')] : await Promise.all((this.modelId === 'pro' ? ['CUDA'] as const : ['CUDA', 'Vulkan'] as const).map(runtimeReady));
    const vision = this.modelId !== 'pro' || await sized(join(this.root, new URL(managedLocalPins.proVision.url).pathname.split('/').at(-1)!), managedLocalPins.proVision.size);
    const mtp = this.modelId !== 'pro' || !prediction || await sized(join(this.root, new URL(managedLocalPins.proMtp.url).pathname.split('/').at(-1)!), managedLocalPins.proMtp.size);
    return { ...this.status(), installed, ready: installed && vision && mtp && runtimes.some(Boolean) };
  }
  private get modelPath() { return this.bundledRoot && this.modelId === 'included' ? join(this.bundledRoot, 'models', 'MiniCPM5-2B-Q4_K_M.gguf') : join(this.root, new URL(this.pin.url).pathname.split('/').at(-1)!); }
  private set(phase: ManagedLocalStatus['phase'], message: string, extra: Partial<ManagedLocalStatus> = {}) {
    this.state = { backend: this.state.backend, speculative: this.state.speculative, phase, message, ...extra };
  }
  start(speculative = false): Promise<{ endpoint: string; key: string }> {
    if (this.task) return this.task;
    if (this.state.phase === 'running' && this.child && this.state.endpoint) {
      if (this.state.speculative !== speculative) return Promise.reject(new Error('Stop the built-in model before changing its acceleration settings.'));
      return Promise.resolve({ endpoint: this.state.endpoint, key: this.key });
    }
    this.state.speculative = speculative;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.task = this.prepare(signal).catch(async error => {
      await this.kill();
      const message = error instanceof Error ? error.message.replaceAll(this.root, 'local storage').replace(/MiniCPM[^\s/\\]*|Ternary-Bonsai[^\s/\\]*/gi, this.profile.name) : 'Local setup failed.';
      this.set(signal.aborted ? 'idle' : 'error', signal.aborted ? 'Stopped. Downloaded files are kept for next time.' : message);
      throw new Error(signal.aborted ? 'Setup canceled. Downloaded files are kept.' : message);
    }).finally(() => { this.task = undefined; });
    return this.task;
  }
  async stop() {
    this.imageCache.clear();
    this.controller?.abort(); this.set('stopping', 'Stopping the built-in model…');
    await this.kill(); await this.task?.catch(() => {});
    this.set('idle', 'Stopped. Downloaded files are kept for next time.');
  }
  private async kill() {
    const child = this.child; this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child.once('exit', () => done()));
      child.kill(); await Promise.race([exited, new Promise<void>(done => setTimeout(done, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await this.logFile?.close().catch(() => {}); this.logFile = undefined;
  }
  private async digest(file: string, signal: AbortSignal) {
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) { signal.throwIfAborted(); hash.update(chunk); } return hash.digest('hex');
  }
  private async download(url: string, destination: string, size: number, hash: string, signal: AbortSignal, label: string) {
    // Verify existing assets as well as freshly downloaded bytes. Never execute an unchecked archive.
    if ((await stat(destination).catch(() => null))?.size === size) {
      this.set('verifying', `Checking ${label}…`);
      if (await this.digest(destination, signal) === hash) return;
    }
    const partial = destination + '.partial'; let offset = (await stat(partial).catch(() => null))?.size ?? 0;
    if (offset >= size) { await rm(partial, { force: true }); offset = 0; }
    this.set('downloading', `Downloading ${label}…`, { downloaded: offset, total: size });
    const response = await fetch(url, { signal, headers: offset ? { Range: `bytes=${offset}-` } : {} });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}). Click Start to retry.`);
    if (offset && response.status !== 206) offset = 0;
    if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('Invalid resumed download.');
    const file = await open(partial, offset ? 'a' : 'w');
    const reader = response.body.getReader();
    try { while (true) {
      const { done, value: chunk } = await reader.read(); if (done) break;
      signal.throwIfAborted(); offset += chunk.length; if (offset > size) throw new Error('Download exceeded its pinned size.');
      await file.writeFile(chunk); this.set('downloading', `Downloading ${label}…`, { downloaded: offset, total: size });
    } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); await file.close(); }
    this.set('verifying', `Verifying ${label}…`);
    if (offset !== size || await this.digest(partial, signal) !== hash) { await rm(partial, { force: true }); throw new Error('Download checksum failed. Click Start to download again.'); }
    await rename(partial, destination);
  }
  private async prepare(signal: AbortSignal) {
    let device: string | undefined, gpuIndex: number | undefined;
    if (this.modelId === 'pro') {
      const hardware = await scanBuiltInHardware();
      if (!hardware.proCompatible || !hardware.device) throw new Error('Pro compatibility could not be confirmed on this device.');
      if (hardware.device.freeBytes < proRequiredFreeBytes(!!this.state.speculative) || freemem() < 4 * 2 ** 30) throw new Error(this.state.speculative ? 'Free some device memory or turn off Response acceleration before setting up Pro.' : 'Free some device memory before setting up Pro. Close other model apps and try again.');
      device = hardware.device.uuid;
      gpuIndex = hardware.device.index;
    }
    await mkdir(this.root, { recursive: true });
    let model: string, runtime: string, backend: 'CUDA' | 'Vulkan' | 'Metal';
    if (this.bundledRoot && this.modelId === 'included') {
      model = this.modelPath; runtime = join(this.bundledRoot, 'llama'); backend = process.platform === 'darwin' ? 'Metal' : 'Vulkan';
      if ((await stat(model)).size !== this.pin.size) throw new Error('The included model is incomplete. Reinstall TinyGPT to restore it.');
    } else {
      if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Built-in setup is not available on this device yet. You can connect an existing local server.');
      await mkdir(this.runtimeRoot, { recursive: true });
      backend = 'Vulkan';
      try { const { stdout } = await exec('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 5000, signal }); if (stdout.trim()) backend = 'CUDA'; } catch { signal.throwIfAborted(); }
      if (this.modelId === 'pro') backend = 'CUDA';
      const pin = this.pin; model = this.modelPath;
      await this.download(pin.url, model, pin.size, pin.sha256, signal, this.profile.name);
      if (this.modelId === 'pro') {
        const imagePin = managedLocalPins.proVision;
        await this.download(imagePin.url, join(this.root, new URL(imagePin.url).pathname.split('/').at(-1)!), imagePin.size, imagePin.sha256, signal, 'Pro image support');
        if (this.state.speculative) {
          const mtp = managedLocalPins.proMtp;
          await this.download(mtp.url, join(this.root, new URL(mtp.url).pathname.split('/').at(-1)!), mtp.size, mtp.sha256, signal, 'Pro prediction support');
        }
      }
      runtime = join(this.runtimeRoot, `llama-b11960-${backend}`);
      // Fresh extraction from hash-verified archives prevents stale or partially extracted DLLs.
      const staging = join(this.runtimeRoot, `extract-${randomUUID()}`); await mkdir(staging);
      try {
        for (const asset of managedLocalPins[backend]) {
          const archive = join(this.runtimeRoot, asset.name);
          await this.download(release + asset.name, archive, asset.size, asset.sha256, signal, 'local support files');
          this.set('extracting', 'Preparing local acceleration…');
          const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
          await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(staging)} -Force`], { windowsHide: true, signal, timeout: 180000 });
        }
        await access(join(staging, 'llama-server.exe')); signal.throwIfAborted();
        await rm(runtime, { recursive: true, force: true }); await rename(staging, runtime);
      } finally { await rm(staging, { recursive: true, force: true }); }
      signal.throwIfAborted();
    }
    this.state.backend = backend;
    if (this.modelId === 'pro') {
      const hardware = await scanBuiltInHardware();
      if (!hardware.proCompatible || !hardware.device || hardware.device.uuid !== device || hardware.device.freeBytes < proRequiredFreeBytes(!!this.state.speculative) || freemem() < 4 * 2 ** 30) throw new Error('Device memory changed during setup. Free device memory or turn off Response acceleration and try again; the download is saved.');
    }
    const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); const p = typeof address === 'object' && address ? address.port : 0; server.close(() => p ? resolve(p) : reject(new Error('No local port available.'))); }); });
    this.key = randomBytes(32).toString('hex'); const keyFile = join(this.root, 'server.key'); await writeFile(keyFile, this.key, { mode: 0o600 });
    const endpoint = `http://127.0.0.1:${port}/v1`;
    // If GPU initialization fails, offer the real error instead of silently shrinking context or falling back to a slow CPU run.
    this.set('starting', 'Starting your built-in model…'); this.logs = '';
    this.logFile = await open(join(this.root, 'server.log'), 'w');
    const projector = this.modelId === 'pro' ? join(this.root, new URL(managedLocalPins.proVision.url).pathname.split('/').at(-1)!) : undefined;
    const performance: ManagedPerformance = { cacheMiB: this.modelId === 'pro' ? promptCacheMiB() : 512, ...(this.modelId === 'pro' && this.state.speculative ? { mtpModel: join(this.root, new URL(managedLocalPins.proMtp.url).pathname.split('/').at(-1)!) } : {}) };
    const observe = nativePerformanceObserver(this.modelId, metric => { try { this.performanceSink?.(metric); } catch { /* Numeric diagnostics are optional. */ } });
    try { this.performanceSink?.({ model: this.modelId, stage: 'configuration', cacheBudgetMiB: performance.cacheMiB, contextTokens: this.profile.context, backend, speculative: !!this.state.speculative, gpuIndex }); } catch { /* Diagnostics cannot prevent model startup. */ }
    const child = spawn(join(runtime, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), managedServerArgs(model, port, keyFile, backend, this.state.speculative, this.modelId, projector, performance), { cwd: runtime, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...managedPerformanceEnv(performance), ...(device ? { CUDA_VISIBLE_DEVICES: device } : {}), PATH: runtime + delimiter + (process.env.PATH ?? '') } });
    this.child = child;
    let launchError = '';
    child.on('error', error => { launchError = error.message; });
    const log = (bytes: Buffer) => { this.logs = (this.logs + bytes.toString()).slice(-12000); observe(bytes.toString()); void this.logFile?.write(bytes).catch(() => {}); };
    child.stdout?.on('data', log); child.stderr?.on('data', log);
    child.once('exit', code => { if (this.child === child && this.state.phase === 'running') { this.child = undefined; this.set('error', `The built-in model stopped (${code}). Start it again.`); } });
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error('The built-in model could not start. Close other model apps and try again. Details are saved in the local runtime log.');
      try { const response = await fetch(endpoint.replace('/v1', '/health'), { headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) }); if (response.ok) {
        const props = await (await fetch(endpoint.replace('/v1', '/props'), { headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) })).json() as any;
        if (props.default_generation_settings?.n_ctx !== this.profile.context) throw new Error('The runtime did not allocate the requested context.');
        signal.throwIfAborted(); this.set('running', 'Ready to use.', { endpoint }); return { endpoint, key: this.key };
      } } catch (error) { if (error instanceof Error && error.message.includes('allocate')) throw error; signal.throwIfAborted(); }
      await new Promise<void>(done => setTimeout(done, 500));
    }
    throw new Error('The built-in model took too long to start. Close other model apps and try again.');
  }
}
