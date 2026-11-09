import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { SourceLibrary } from './sources';
import type { ExtractedDocument } from '../shared/source-files';

/** Original bytes are committed before returning. Extraction resumes after restart. */
export class FileIngestion {
  private jobs = new Map<string, Promise<void>>();
  private queue = Promise.resolve();
  private closing = new AbortController();
  private publish(conversationId: string) {
    if (this.closing.signal.aborted || !this.sources.database.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId)) return;
    try { this.changed(conversationId); } catch { /* A closed view cannot fail or strand background ingestion. */ }
  }
  constructor(private sources: SourceLibrary, private extract: (name: string, bytes: Buffer, signal: AbortSignal) => Promise<ExtractedDocument>, private changed: (conversationId: string) => void) {
    sources.ingestUpload = (conversationId, name, bytes, image) => this.upload(conversationId, name, bytes, image);
    for (const row of sources.database.prepare("SELECT source_id AS id FROM source_files WHERE status='preparing'").all()) this.enqueue(String(row.id));
  }
  upload(conversationId: string, name: string, bytes: Buffer, image?: { image: string; mime: string }) {
    if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw Error('Files must be 15 MB or smaller.');
    let source: ReturnType<SourceLibrary['add']>;
    this.sources.database.exec('BEGIN IMMEDIATE');
    try {
      const mimes: Record<string, string> = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.odt': 'application/vnd.oasis.opendocument.text' };
      source = this.sources.add(conversationId, { kind: image ? 'image' : 'attachment', title: name, text: '', size: bytes.length, mime: image?.mime ?? mimes[extname(name).toLowerCase()] ?? 'text/plain', image: image?.image });
      this.sources.database.prepare('INSERT INTO source_files(source_id,original,sha256,status) VALUES(?,?,?,?)').run(source.id, bytes, createHash('sha256').update(bytes).digest('hex'), 'preparing');
      this.sources.database.exec('COMMIT');
    } catch (error) { this.sources.database.exec('ROLLBACK'); throw error; }
    this.enqueue(source.id); this.publish(conversationId);
    return this.sources.detail(conversationId, source.id);
  }
  private enqueue(id: string) {
    if (this.jobs.has(id)) return;
    const task = this.queue.catch(() => {}).then(async () => {
      if (this.closing.signal.aborted) return;
      const row = this.sources.database.prepare('SELECT s.title,s.conversation_id AS conversationId,f.original FROM source_files f JOIN sources s ON s.id=f.source_id WHERE f.source_id=?').get(id);
      if (!row) return;
      try {
        const result = await this.extract(String(row.title), Buffer.from(row.original as Uint8Array), this.closing.signal);
        if (this.closing.signal.aborted) return;
        this.sources.setExtractedText(id, result.text);
        this.sources.database.prepare('UPDATE source_files SET status=?,notice=? WHERE source_id=?').run(result.status, result.notice ?? null, id);
      } catch (error) {
        if (this.closing.signal.aborted) return;
        this.sources.database.prepare("UPDATE source_files SET status='failed',notice='This file could not be read. Download the original or retry with a supported, readable document.',diagnostic=? WHERE source_id=?").run((error instanceof Error ? error.message : 'Unknown extraction failure.').slice(0, 2000), id);
      } finally { this.publish(String(row.conversationId)); }
    }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, task); this.queue = task;
  }
  async wait(ids: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    try { await Promise.race([Promise.all(ids.map(id => this.jobs.get(id))), new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  retry(conversationId: string, id: string) { this.sources.detail(conversationId, id); this.sources.database.prepare("UPDATE source_files SET status='preparing',notice=NULL,diagnostic=NULL WHERE source_id=?").run(id); this.enqueue(id); this.publish(conversationId); }
  async close() { this.closing.abort(); await this.queue.catch(() => {}); }
}
