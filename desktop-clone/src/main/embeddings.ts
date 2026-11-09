import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { SourceExcerpt } from '../shared/tools';
import type { RagScope } from './rag-index';

export interface EmbeddingRuntime {
  load(download: boolean): Promise<void>; embed(texts: string[]): Promise<number[][]>; close(): void;
  index?(): Promise<number>;
  search?(scope: RagScope, query: string, limit: number, semantic: boolean, signal?: AbortSignal): Promise<SourceExcerpt[]>;
}
/** Supervised local retrieval process. Models are bundled; no runtime downloads. */
export class LocalEmbeddings implements EmbeddingRuntime {
  private worker?: UtilityProcess;
  private ready?: Promise<void>;
  private counter = 0;
  private epoch = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup: () => void }>();
  constructor(private cacheDir: string, private libraryPath: string, private modelRoot: string) {}
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const epoch = this.epoch;
    this.ready = mkdir(this.cacheDir, { recursive: true }).then(() => new Promise<void>((resolve, reject) => {
      if (epoch !== this.epoch) { reject(new Error('Local retrieval stopped.')); return; }
      const env: Record<string, string> = {};
      for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) { const value = process.env[key]; if (typeof value === 'string') env[key] = value; }
      const worker = utilityProcess.fork(join(__dirname, 'embedding-worker.js'), [], { env, stdio: 'ignore', serviceName: 'TinyGPT local retrieval' }); this.worker = worker;
      const startup = setTimeout(() => { reject(new Error('Local retrieval unavailable.')); this.close(); }, 15000);
      worker.on('message', (event: { ready?: boolean; id?: number; ok?: boolean; value?: unknown; diagnostic?: string }) => {
        if (event.ready) { clearTimeout(startup); resolve(); return; }
        if (!event.id) return;
        const pending = this.pending.get(event.id); if (!pending) return;
        this.pending.delete(event.id); pending.cleanup();
        if (event.ok) pending.resolve(event.value); else pending.reject(new Error(event.diagnostic ?? 'Local retrieval unavailable.'));
      });
      worker.on('exit', () => { clearTimeout(startup); reject(new Error('Local retrieval stopped.')); if (this.worker === worker) this.close(); });
    })); return this.ready;
  }
  private async request<T>(type: string, data: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted(); await this.start(); signal?.throwIfAborted(); const id = ++this.counter;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { this.worker?.postMessage({ id, type: 'cancel' }); this.pending.delete(id); cleanup(); reject(signal?.reason ?? new Error('Retrieval cancelled.')); };
      const timer = setTimeout(() => {
        this.pending.delete(id); cleanup(); this.worker?.postMessage({ id, type: 'cancel' }); reject(new Error('Local retrieval timed out.'));
        if (type !== 'search') this.close();
      }, type === 'search' ? 6000 : 60000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup }); signal?.addEventListener('abort', abort, { once: true });
      this.worker!.postMessage({ id, type, ...data, cacheDir: this.cacheDir, libraryPath: this.libraryPath, modelRoot: this.modelRoot });
    });
  }
  async load(_download: boolean): Promise<void> { await this.request('load'); }
  embed(texts: string[]): Promise<number[][]> { return this.request('embed', { texts }); }
  index(): Promise<number> { return this.request('index'); }
  search(scope: RagScope, query: string, limit: number, semantic: boolean, signal?: AbortSignal): Promise<SourceExcerpt[]> { return this.request('search', { scope, query, limit, semantic, deadline: Date.now() + 4500 }, signal); }
  close(): void {
    this.epoch++;
    const worker = this.worker; this.worker = undefined; this.ready = undefined;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error('Local retrieval stopped.')); } this.pending.clear(); worker?.kill();
  }
}
