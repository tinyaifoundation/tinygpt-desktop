import type { HistoryStore } from './history';
import type { EmbeddingRuntime } from './embeddings';
import type { MemorySnapshot } from '../shared/memory';
import type { SourceExcerpt } from '../shared/tools';
import { fusePassages } from '../core/hybrid-retrieval';
import { handbookArticles, handbookSourceId, searchHandbook } from '../core/handbook';

export class MemoryService {
  private status: MemorySnapshot['semantic']['status'] = 'off';
  private message = 'Preparing local retrieval…';
  private timer?: ReturnType<typeof setInterval>;
  private processing?: Promise<void>;
  private loading?: Promise<void>;
  private stopped = false;
  private generation = 0;
  private retryAt = 0;
  private failures = 0;
  private lastUsed = Date.now();
  constructor(private history: HistoryStore, private runtime: EmbeddingRuntime, private readAllowed: () => boolean, private changed: () => void, private foregroundAudio: () => boolean = () => false, private residency: () => { keepLoaded?: boolean; idleMinutes?: number } = () => ({})) {}
  warm() { if (!this.readAllowed() || this.stopped) return; this.lastUsed = Date.now(); if (this.status === 'off') void this.initialize(); }
  start(): void { if (this.timer || this.stopped) return; this.timer = setInterval(() => this.kick(), 500); this.timer.unref(); void this.initialize(); }
  snapshot(): MemorySnapshot { return { includePersonal: this.history.memory.preference('personal'), memories: this.history.memory.memories(), indexes: this.history.memory.indexes(), documents: this.history.memory.documents(), semantic: { enabled: true, status: this.status, message: this.message, ...this.history.memory.vectorCounts() } }; }
  initialize(): Promise<void> {
    if (this.stopped || !this.readAllowed()) return Promise.resolve();
    if (this.loading) return this.loading;
    const generation = ++this.generation; this.status = 'loading'; this.message = 'Preparing local retrieval…'; this.changed();
    this.lastUsed = Date.now();
    this.loading = this.runtime.load(false).then(() => {
      if (this.stopped || generation !== this.generation) return;
      this.status = 'ready'; this.message = 'Search and relevance ranking run on this computer. New content is indexed in the background.'; this.kick();
    }).catch(() => {
      if (this.stopped || generation !== this.generation) return;
      this.failed('Local retrieval could not start. Text search still works while it recovers.');
    }).finally(() => { this.loading = undefined; if (!this.stopped && generation === this.generation) this.changed(); });
    return this.loading;
  }
  private failed(message: string): void {
    this.status = 'error'; this.message = message; this.runtime.close();
    this.retryAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(this.failures++, 4));
  }
  kick(): void {
    if (!this.stopped && this.status === 'off' && this.readAllowed() && this.history.memory.vectorCounts().pending > 0 && !this.foregroundAudio()) { void this.initialize(); return; }
    if (!this.stopped && this.status === 'ready' && !this.processing && !this.loading && !this.residency().keepLoaded && Date.now() - this.lastUsed >= (this.residency().idleMinutes ?? 10) * 60000 && (!this.readAllowed() || this.history.memory.vectorCounts().pending === 0)) {
      this.runtime.close(); this.status = 'off'; this.message = 'Retrieval is ready to reload when needed. Keyword search remains available.'; this.changed(); return;
    }
    if (!this.stopped && this.status === 'error' && !this.processing && !this.loading && Date.now() >= this.retryAt && !this.foregroundAudio()) { void this.initialize(); return; }
    if (this.stopped || this.status !== 'ready' || this.processing || !this.readAllowed() || this.foregroundAudio()) return;
    if (this.runtime.index) {
      const generation = this.generation;
      let changed = false;
      this.processing = this.runtime.index().then(count => { changed = count > 0; if (count) this.lastUsed = Date.now(); this.failures = 0; }).catch(() => {
        if (this.stopped || generation !== this.generation) return;
        changed = true;
        this.failed('Local indexing stopped. Text search remains available while it recovers.');
      }).finally(() => { this.processing = undefined; if (changed && !this.stopped && generation === this.generation) this.changed(); });
      return;
    }
    const rows = this.history.memory.pendingVectors(); if (!rows.length) return;
    const generation = this.generation;
    this.processing = this.runtime.embed(rows.map(row => row.text)).then(vectors => {
      if (this.stopped || generation !== this.generation || !this.readAllowed()) return;
      if (vectors.length !== rows.length) throw new Error('Invalid embeddings.');
      rows.forEach((row, i) => this.history.memory.saveVector(row, vectors[i]));
      this.failures = 0;
    }).catch(() => {
      if (this.stopped || generation !== this.generation) return;
      this.failed('Local indexing stopped. Text search remains available while it recovers.');
    }).finally(() => { this.processing = undefined; if (!this.stopped) this.changed(); });
  }
  private async vector(query: string, signal?: AbortSignal): Promise<number[] | undefined> {
    if (this.status !== 'ready' || !this.readAllowed() || this.stopped) return undefined;
    signal?.throwIfAborted(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Retrieval must not stall Chat behind a background inference batch.
      const vectors = await Promise.race([this.runtime.embed([query.slice(0, 1500)]), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2000); })]);
      signal?.throwIfAborted(); return this.status === 'ready' ? vectors?.[0] : undefined;
    } catch { signal?.throwIfAborted(); return undefined; }
    finally { clearTimeout(timer); }
  }
  async search(conversationId: string, query: string, limit = 8, signal?: AbortSignal, sourceIds?: string[]): Promise<SourceExcerpt[]> {
    this.warm();
    if (!this.readAllowed() || this.stopped) return [];
    limit = Math.max(1, Math.min(20, Math.floor(limit)));
    if (this.runtime.search) {
      try {
        const hits = await this.runtime.search({ conversationId, ...(sourceIds?.length ? { sourceIds } : {}) }, query, limit, this.status === 'ready', signal);
        signal?.throwIfAborted(); if (!this.readAllowed() || this.stopped) return [];
        return hits.filter(hit => { try { const source = this.history.sources.detail(conversationId, hit.sourceId); return !source.excluded && source.text.includes(hit.text); } catch { return false; } });
      } catch { signal?.throwIfAborted(); }
    } else await this.vector(query, signal);
    signal?.throwIfAborted();
    if (!this.readAllowed() || this.stopped) return [];
    return sourceIds?.length ? fusePassages(this.history.sources.targetedLexical(conversationId, sourceIds, query), [], limit) : this.history.sources.search(conversationId, query, limit);
  }
  /** Only bundled application knowledge can cross this permission-independent
   * path. Never mix personal, Project, attachment or account evidence here. */
  async searchHelp(query: string, signal?: AbortSignal): Promise<SourceExcerpt[]> {
    signal?.throwIfAborted();
    if (this.runtime.search && !this.stopped) {
      try {
        const hits = await this.runtime.search({ handbookOnly: true }, query, 4, this.status === 'ready', signal);
        signal?.throwIfAborted();
        const safe = hits.filter(hit => handbookArticles.some(article => handbookSourceId(article.id) === hit.sourceId && article.text.includes(hit.text)));
        if (safe.length) return safe;
      } catch { signal?.throwIfAborted(); }
    }
    return searchHandbook(query).map(hit => ({ ...hit, sourceId: handbookSourceId(hit.articleId), url: null, position: 0 }));
  }
  async preview(projectId: string | null, query: string): Promise<SourceExcerpt[]> {
    this.warm();
    if (!this.readAllowed() || this.stopped) return [];
    if (this.runtime.search) {
      try {
        const hits = await this.runtime.search({ projectId }, query, 8, this.status === 'ready');
        if (!this.readAllowed() || this.stopped) return [];
        return hits.filter(hit => this.history.memory.detail('', projectId, hit.sourceId)?.text.includes(hit.text));
      } catch { /* Text search remains useful when inference is unavailable. */ }
    } else await this.vector(query);
    if (!this.readAllowed() || this.stopped) return [];
    return fusePassages(this.history.memory.lexical(projectId, query), [], 8);
  }
  async shutdown(): Promise<void> { this.stopped = true; this.generation++; clearInterval(this.timer); this.runtime.close(); await Promise.allSettled([this.processing, this.loading].filter(Boolean)); }
}
