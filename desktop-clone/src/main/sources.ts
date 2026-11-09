import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { retrievalQuery, sourceChunks } from '../core/source-text';
import { completeSourceChunks } from './complete-source-chunks';
import type { FileProcessing } from '../shared/source-files';
import type { SourceDetail, SourceExcerpt, SourceSummary } from '../shared/tools';
import type { MemoryLibrary } from './memory-library';
import { fusePassages, type RankedPassage } from '../core/hybrid-retrieval';

export class SourceLibrary {
  ingestUpload?: (conversationId: string, name: string, bytes: Buffer, image?: { image: string; mime: string }) => SourceSummary;
  get database() { return this.db; }
  private memory?: MemoryLibrary;
  connectMemory(memory: MemoryLibrary): void { this.memory = memory; }
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        project_id TEXT REFERENCES projects(id), kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
        mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        text TEXT NOT NULL, image TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_chunks (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE, position INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS source_chunk_parent ON source_chunks(source_id,position);
      CREATE TABLE IF NOT EXISTS source_images (source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE, original BLOB NOT NULL, conversation_only INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS source_exclusions(source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE) STRICT;
      CREATE TABLE IF NOT EXISTS source_files(source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,original BLOB NOT NULL,sha256 TEXT NOT NULL,status TEXT NOT NULL,notice TEXT) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(text, content='source_chunks', content_rowid='id', tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS source_chunks_ai AFTER INSERT ON source_chunks BEGIN INSERT INTO source_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS source_chunks_ad AFTER DELETE ON source_chunks BEGIN INSERT INTO source_fts(source_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE INDEX IF NOT EXISTS sources_scope ON sources(project_id, conversation_id);
      CREATE TABLE IF NOT EXISTS message_sources (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        PRIMARY KEY(message_id,source_id)
      ) STRICT;
      INSERT OR IGNORE INTO message_sources SELECT message_id,id FROM sources WHERE message_id IS NOT NULL;
    `);
    if (!db.prepare('PRAGMA table_info(source_images)').all().some(row => row.name === 'conversation_only')) db.exec('ALTER TABLE source_images ADD COLUMN conversation_only INTEGER NOT NULL DEFAULT 0');
    if (!db.prepare('PRAGMA table_info(source_files)').all().some(row => row.name === 'diagnostic')) db.exec('ALTER TABLE source_files ADD COLUMN diagnostic TEXT');
    completeSourceChunks(db, 'source');
  }
  private context(conversationId: string): { project_id: string | null } {
    const row = this.db.prepare('SELECT project_id FROM conversations WHERE id=?').get(conversationId);
    if (!row) throw new Error('Conversation not found.');
    return row as unknown as { project_id: string | null };
  }
  private summaries(rows: Record<string, unknown>[]): SourceSummary[] { return rows.map(row => ({ ...row, excluded: this.isExcluded(String(row.id)), processing: this.fileStatus(String(row.id)) })) as unknown as SourceSummary[]; }
  isExcluded(id: string) { return !!this.db.prepare('SELECT source_id FROM source_exclusions WHERE source_id=?').get(id); }
  setExcluded(conversationId: string, id: string, excluded: boolean) { this.detail(conversationId, id); if (excluded) this.db.prepare('INSERT OR IGNORE INTO source_exclusions VALUES(?)').run(id); else this.db.prepare('DELETE FROM source_exclusions WHERE source_id=?').run(id); const project = this.context(conversationId).project_id; this.memory?.clearDerivedContext(project); }
  fileStatus(id: string): FileProcessing | undefined { return this.db.prepare('SELECT status,notice,sha256 FROM source_files WHERE source_id=?').get(id) as unknown as FileProcessing | undefined; }
  targetedLexical(conversationId: string, sourceIds: string[], query: string): RankedPassage[] {
    const expression = retrievalQuery(query); if (!expression) return [];
    return sourceIds.flatMap(id => {
      const source = this.detail(conversationId, id);
      if (source.excluded) return [];
      const knowledge = !!this.db.prepare('SELECT id FROM knowledge_documents WHERE id=?').get(id);
      const prefix = knowledge ? 'knowledge' : 'source', column = knowledge ? 'document_id' : 'source_id';
      return this.db.prepare(`SELECT c.position,c.text,bm25(${prefix}_fts) AS score FROM ${prefix}_fts JOIN ${prefix}_chunks c ON c.id=${prefix}_fts.rowid WHERE ${prefix}_fts MATCH ? AND c.${column}=? ORDER BY score LIMIT 40`).all(expression, id).map(row => ({ sourceId: id, title: source.title, url: source.url, position: Number(row.position), text: String(row.text), score: Number(row.score), citation: `[${source.title.replace(/[\[\]]/g, '')}](tinygpt-source:${id})` }));
    }).sort((a, b) => a.score - b.score).slice(0, 40);
  }
  originalFile(conversationId: string, id: string) { const source = this.detail(conversationId, id); const row = this.db.prepare('SELECT original FROM source_files WHERE source_id=?').get(id); return { source, bytes: row ? Buffer.from(row.original as Uint8Array) : this.originalImage(conversationId, id) ?? Buffer.from(source.text) }; }
  setExtractedText(id: string, text: string) {
    if (!this.db.prepare('SELECT id FROM sources WHERE id=?').get(id)) return;
    if (text.length > 500000) throw Error('Extracted document exceeds its text limit.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM source_chunks WHERE source_id=?').run(id);
      this.db.prepare('UPDATE sources SET text=?,created_at=MAX(created_at+1,?) WHERE id=?').run(text, Date.now(), id);
      const insert = this.db.prepare('INSERT INTO source_chunks(source_id,position,text) VALUES(?,?,?)');
      for (const chunk of sourceChunks(text)) insert.run(id, chunk.position, chunk.text);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(conversationId: string, project = true): SourceSummary[] {
    const scope = this.context(conversationId);
    return [...this.summaries(this.db.prepare(`SELECT id,conversation_id AS conversationId,project_id AS projectId,kind,title,url,mime,size,created_at AS createdAt,message_id AS messageId FROM sources WHERE conversation_id=? OR (? IS NOT NULL AND project_id=? AND (kind NOT IN ('attachment','image','conversation','folder') OR message_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM source_images si WHERE si.source_id=sources.id AND si.conversation_only=1)) ORDER BY created_at DESC LIMIT 100`).all(conversationId, project ? scope.project_id : null, project ? scope.project_id : null) as Record<string, unknown>[]), ...(project ? this.memory?.summaries(conversationId, scope.project_id) ?? [] : [])];
  }
  detail(conversationId: string, sourceId: string): SourceDetail {
    const scope = this.context(conversationId);
    const row = this.db.prepare(`SELECT id,conversation_id AS conversationId,project_id AS projectId,kind,title,url,mime,size,created_at AS createdAt,message_id AS messageId,text,image FROM sources WHERE id=? AND (conversation_id=? OR (? IS NOT NULL AND project_id=? AND (kind NOT IN ('attachment','image','conversation','folder') OR message_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM source_images si WHERE si.source_id=sources.id AND si.conversation_only=1)))`).get(sourceId, conversationId, scope.project_id, scope.project_id);
    if (!row) { const memory = this.memory?.detail(conversationId, scope.project_id, sourceId); if (memory) return memory; throw new Error('Source not found in this conversation or Project.'); }
    return { ...row, excluded: this.isExcluded(sourceId), processing: this.fileStatus(sourceId) } as unknown as SourceDetail;
  }
  originalImage(conversationId: string, sourceId: string): Buffer | undefined { const source = this.detail(conversationId, sourceId); const row = this.db.prepare('SELECT original FROM source_images WHERE source_id=?').get(sourceId) ?? (source.image ? this.db.prepare('SELECT original FROM source_files WHERE source_id=?').get(sourceId) : undefined); return row ? Buffer.from(row.original as Uint8Array) : undefined; }
  add(conversationId: string, input: { kind: SourceSummary['kind']; title: string; text: string; url?: string | null; mime?: string; size?: number; image?: string | null; originalImage?: Buffer; privateImage?: boolean }): SourceSummary {
    const scope = this.context(conversationId); const id = randomUUID(); const text = input.text.slice(0, 500000);
    this.db.exec('SAVEPOINT add_source');
    try {
      // Refresh previously read pages/files so retrieval does not prefer stale copies.
      if (input.url && ['page', 'project-file'].includes(input.kind)) this.db.prepare('DELETE FROM sources WHERE conversation_id=? AND kind=? AND url=?').run(conversationId, input.kind, input.url);
      this.db.prepare('INSERT INTO sources(id,conversation_id,project_id,kind,title,url,mime,size,created_at,message_id,text,image) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?)').run(id, conversationId, scope.project_id, input.kind, input.title.slice(0, 200), input.url ?? null, input.mime ?? 'text/plain', input.size ?? Buffer.byteLength(text), Date.now(), text, input.image ?? null);
      if (input.originalImage) { if (input.originalImage.length > 15 * 1024 * 1024) throw new Error('Files must be 15 MB or smaller.'); this.db.prepare('INSERT INTO source_images(source_id,original,conversation_only) VALUES(?,?,?)').run(id, input.originalImage, input.privateImage ? 1 : 0); }
      const insert = this.db.prepare('INSERT INTO source_chunks(source_id,position,text) VALUES(?,?,?)');
      for (const chunk of sourceChunks(text)) insert.run(id, chunk.position, chunk.text);
      this.db.exec('RELEASE add_source');
    } catch (error) { this.db.exec('ROLLBACK TO add_source; RELEASE add_source'); throw error; }
    const { text: _text, image: _image, ...summary } = this.detail(conversationId, id); return summary;
  }
  remove(conversationId: string, id: string): void { this.detail(conversationId, id); if (this.db.prepare('SELECT id FROM knowledge_documents WHERE id=?').get(id)) this.memory!.remove(id); else this.db.prepare('DELETE FROM sources WHERE id=?').run(id); }
  removeConversationFiles(conversationId: string): void { this.db.prepare("DELETE FROM sources WHERE conversation_id=? AND kind='project-file' AND image IS NULL").run(conversationId); }
  recordWrittenFile(conversationId: string, path: string, text: string) {
    const scope = this.context(conversationId), url = `project-file:${path}`;
    this.db.prepare("DELETE FROM sources WHERE kind='project-file' AND url=? AND (conversation_id=? OR (? IS NOT NULL AND project_id=?))").run(url, conversationId, scope.project_id, scope.project_id);
    return this.add(conversationId, { kind: 'project-file', title: path, url, text });
  }
  removeProjectFiles(projectId: string): void { this.db.prepare("DELETE FROM sources WHERE project_id=? AND kind='project-file' AND image IS NULL").run(projectId); }
  attachable(conversationId: string, ids: string[]): SourceDetail[] {
    if (ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('Choose up to eight distinct attachments.');
    return ids.map(id => {
      const source = this.detail(conversationId, id);
      if (source.conversationId !== conversationId || !['attachment', 'image', 'conversation', 'folder'].includes(source.kind) || source.messageId) throw new Error('This attachment is unavailable for the current message.');
      return source;
    });
  }
  link(ids: string[], messageId: string): void {
    for (const id of ids) {
      this.db.prepare('UPDATE sources SET message_id=COALESCE(message_id,?) WHERE id=?').run(messageId, id);
      this.db.prepare('INSERT OR IGNORE INTO message_sources(message_id,source_id) VALUES(?,?)').run(messageId, id);
    }
  }
  attachmentIds(messageId: string): string[] { return this.db.prepare('SELECT source_id FROM message_sources WHERE message_id=?').all(messageId).map(row => String(row.source_id)); }
  messageAttachments(conversationId: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const row of this.db.prepare('SELECT ms.message_id,ms.source_id FROM message_sources ms JOIN messages m ON m.id=ms.message_id WHERE m.conversation_id=?').all(conversationId)) {
      const id = String(row.message_id); const ids = result.get(id) ?? []; ids.push(String(row.source_id)); result.set(id, ids);
    }
    return result;
  }
  messageSources(conversationId: string, messageId: string): SourceDetail[] {
    this.context(conversationId);
    return this.summaries(this.db.prepare('SELECT s.id,conversation_id AS conversationId,project_id AS projectId,kind,title,url,mime,size,created_at AS createdAt,s.message_id AS messageId,text,image FROM sources s JOIN message_sources ms ON ms.source_id=s.id WHERE conversation_id=? AND ms.message_id=?').all(conversationId, messageId) as Record<string, unknown>[]) as SourceDetail[];
  }
  lexical(conversationId: string, query: string): RankedPassage[] {
    const scope = this.context(conversationId); const expression = retrievalQuery(query); if (!expression) return [];
    const rows = this.db.prepare(`SELECT s.id AS sourceId,s.title,s.url,s.created_at AS updatedAt,c.text,c.position,bm25(source_fts) AS score FROM source_fts JOIN source_chunks c ON c.id=source_fts.rowid JOIN sources s ON s.id=c.source_id WHERE source_fts MATCH ? AND NOT EXISTS (SELECT 1 FROM source_exclusions e WHERE e.source_id=s.id) AND (s.conversation_id=? OR (? IS NOT NULL AND s.project_id=? AND NOT EXISTS (SELECT 1 FROM source_images si WHERE si.source_id=s.id AND si.conversation_only=1) AND (s.kind NOT IN ('attachment','image','conversation','folder') OR s.message_id IS NOT NULL))) ORDER BY score LIMIT 40`).all(expression, conversationId, scope.project_id, scope.project_id) as unknown as (SourceExcerpt & { score: number })[];
    const lexical: RankedPassage[] = [...rows.map(row => ({ ...row, citation: `[${row.title.replace(/[\[\]]/g, '')}](tinygpt-source:${row.sourceId})` })), ...(this.memory?.lexical(scope.project_id, query) ?? [])].sort((a, b) => a.score - b.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return lexical;
  }
  search(conversationId: string, query: string, limit = 8): SourceExcerpt[] {
    return fusePassages(this.lexical(conversationId, query), [], Math.max(1, Math.min(20, limit)));
  }
}
