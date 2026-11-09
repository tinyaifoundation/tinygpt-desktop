import { utilityProcess, type UtilityProcess } from 'electron';
import { extname, join } from 'node:path';
import type { ExtractedDocument } from '../shared/source-files';
/** Document parsing runs away from the UI and from retrieval inference. */
export class FileExtraction {
  private worker?: UtilityProcess;
  private ready?: Promise<void>;
  private counter = 0;
  private bytes = 0;
  private idle?: ReturnType<typeof setTimeout>;
  private pending = new Map<number, { resolve: (text: ExtractedDocument) => void; reject: (error: Error) => void; cleanup: () => void }>();
  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const env: Record<string, string> = {};
      for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name]!;
      const worker = utilityProcess.fork(join(__dirname, 'file-worker.js'), [], { env, stdio: 'ignore', serviceName: 'TinyGPT document reader' }); this.worker = worker;
      const timer = setTimeout(() => { reject(new Error('The document reader could not start.')); this.close(); }, 15000);
      worker.on('message', (input: { ready?: boolean; id?: number; text?: string; document?: ExtractedDocument; error?: string }) => {
        if (input.ready) { clearTimeout(timer); resolve(); return; }
        const request = this.pending.get(input.id!); if (!request) return;
        this.pending.delete(input.id!); request.cleanup();
        if (input.error) request.reject(new Error(input.error)); else request.resolve(input.document ?? { text: input.text ?? '', status: 'ready' });
        this.unloadLater();
      });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('The document reader stopped.')); if (this.worker === worker) this.close(); });
    }); return this.ready;
  }
  async extract(path: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
    const document = await this.extractDocument(path, bytes, signal);
    return document.notice ? `[Document coverage: ${document.notice}]\n\n${document.text}` : document.text;
  }
  async extractDocument(path: string, bytes: Buffer, signal?: AbortSignal): Promise<ExtractedDocument> {
    clearTimeout(this.idle);
    signal?.throwIfAborted(); await this.start(); signal?.throwIfAborted();
    if (this.pending.size >= 16 || this.bytes + bytes.length > 64 * 1024 * 1024) throw new Error('The document reader is busy. Try again shortly.');
    const id = ++this.counter; this.bytes += bytes.length;
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending.delete(id); this.worker?.postMessage({ id, cancel: true }); cleanup(); reject(new Error('Cancelled.')); this.unloadLater(); };
      const timer = setTimeout(() => { this.close(); }, 600000);
      const cleanup = () => { clearTimeout(timer); this.bytes -= bytes.length; signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve, reject, cleanup }); signal?.addEventListener('abort', abort, { once: true });
      // Only caller-supplied bytes and a format hint enter this process.
      this.worker!.postMessage({ id, name: `document${extname(path)}`, bytes });
    });
  }
  private unloadLater() { clearTimeout(this.idle); if (!this.pending.size) { this.idle = setTimeout(() => this.close(), 30000); this.idle.unref(); } }
  close(): void {
    clearTimeout(this.idle);
    const worker = this.worker; this.worker = undefined; this.ready = undefined;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error('The document reader stopped. Try again.')); }
    this.pending.clear(); worker?.kill();
  }
}
