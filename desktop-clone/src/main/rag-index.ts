import { DatabaseSync } from 'node:sqlite';
import { getLoadablePath } from 'sqlite-vec';
import { MemoryLibrary, packVector, vectorModel } from './memory-library';
import { SourceLibrary } from './sources';
import { fusePassages, type RankedPassage } from '../core/hybrid-retrieval';
import type { SourceExcerpt } from '../shared/tools';

export interface RagScope { conversationId?: string; projectId?: string | null; sourceIds?: string[]; handbookOnly?: boolean }
export interface RagChunk { kind: 'knowledge' | 'source'; id: number; text: string; sourceId: string; version: string }
const knowledgeScope = `d.enabled=1 AND (d.kind='handbook' OR d.project_id=? OR (?=1 AND d.project_id IS NULL AND d.kind='memory'))
  AND (d.kind IN ('memory','plugin-resource','handbook') OR EXISTS(SELECT 1 FROM library.project_indexes i JOIN library.projects p ON p.id=i.project_id
    WHERE i.project_id=d.project_id AND i.enabled=1 AND i.root_path=d.root_path AND p.root_path=i.root_path))`;
const sourceScope = `NOT EXISTS(SELECT 1 FROM library.source_exclusions e WHERE e.source_id=s.id) AND NOT EXISTS(SELECT 1 FROM library.source_images si WHERE si.source_id=s.id AND si.conversation_only=1 AND s.conversation_id<>?) AND (s.conversation_id=? OR (? IS NOT NULL AND s.project_id=? AND (s.kind NOT IN ('attachment','image','conversation','folder') OR s.message_id IS NOT NULL)))`;

/** Rebuildable, native vector index owned exclusively by the retrieval worker. */
export class RagIndex {
  readonly db: DatabaseSync;
  private library: DatabaseSync;
  readonly memory: MemoryLibrary;
  readonly sources: SourceLibrary;
  constructor(libraryPath: string, indexPath: string) {
    this.library = new DatabaseSync(libraryPath);
    this.library.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.memory = new MemoryLibrary(this.library); this.sources = new SourceLibrary(this.library); this.sources.connectMemory(this.memory);
    this.db = new DatabaseSync(indexPath, { allowExtension: true });
    this.db.loadExtension(getLoadablePath().replace('app.asar', 'app.asar.unpacked'));
    this.db.enableLoadExtension(false);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.prepare('ATTACH DATABASE ? AS library').run(libraryPath);
    for (const kind of ['knowledge', 'source']) this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${kind}_vectors USING vec0(id INTEGER PRIMARY KEY, embedding float[384] distance_metric=cosine);
      CREATE TABLE IF NOT EXISTS ${kind}_versions(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, version TEXT NOT NULL, model TEXT NOT NULL) STRICT;
    `);
    this.cleanup();
  }
  private scope(input: RagScope): [string | null, number] {
    const project = input.conversationId ? this.library.prepare('SELECT project_id FROM conversations WHERE id=?').get(input.conversationId) : undefined;
    if (input.conversationId && !project) throw new Error('Conversation not found.');
    return [input.conversationId ? project!.project_id as string | null : input.projectId ?? null, this.memory.preference('personal') ? 1 : 0];
  }
  pending(limit = 2): RagChunk[] {
    const rows: RagChunk[] = [];
    for (const kind of ['knowledge', 'source'] as const) {
      const knowledge = kind === 'knowledge';
      rows.push(...this.db.prepare(`SELECT c.id,c.text,${knowledge ? 'd.id' : 's.id'} AS sourceId,CAST(${knowledge ? 'd.hash' : 's.created_at'} AS TEXT) AS version
        FROM library.${kind === 'knowledge' ? 'knowledge_chunks c JOIN library.knowledge_documents d ON d.id=c.document_id' : 'source_chunks c JOIN library.sources s ON s.id=c.source_id'}
        LEFT JOIN ${kind}_versions v ON v.id=c.id
        WHERE (v.id IS NULL OR v.model<>? OR v.source_id<>${knowledge ? 'd.id' : 's.id'} OR v.version<>CAST(${knowledge ? 'd.hash' : 's.created_at'} AS TEXT))
        AND ${knowledge ? 'd.enabled=1' : 'NOT EXISTS(SELECT 1 FROM library.source_exclusions e WHERE e.source_id=s.id)'}
        LIMIT ?`).all(vectorModel, limit).map(row => ({ kind, id: Number(row.id), text: String(row.text), sourceId: String(row.sourceId), version: String(row.version) })));
    }
    return rows;
  }
  save(row: RagChunk, vector: number[]): void {
    // Recheck after inference: an edit, deletion or reused integer ID invalidates the result.
    const live = this.db.prepare(`SELECT c.text,${row.kind === 'knowledge' ? 'd.id AS sourceId,d.hash' : 's.id AS sourceId,CAST(s.created_at AS TEXT)'} AS version FROM library.${row.kind === 'knowledge' ? 'knowledge_chunks c JOIN library.knowledge_documents d ON d.id=c.document_id' : 'source_chunks c JOIN library.sources s ON s.id=c.source_id'} WHERE c.id=?`).get(row.id);
    if (!live || live.text !== row.text || live.sourceId !== row.sourceId || live.version !== row.version) return;
    const bytes = packVector(vector);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM ${row.kind}_vectors WHERE id=?`).run(BigInt(row.id));
      this.db.prepare(`INSERT INTO ${row.kind}_vectors(id,embedding) VALUES(?,?)`).run(BigInt(row.id), bytes);
      this.db.prepare(`INSERT INTO ${row.kind}_versions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,version=excluded.version,model=excluded.model`).run(row.id, row.sourceId, row.version, vectorModel);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.memory.saveVector(row, vector);
  }
  cleanup(): void {
    for (const kind of ['knowledge', 'source']) {
      const live = kind === 'knowledge' ? 'library.knowledge_chunks c JOIN library.knowledge_documents d ON d.id=c.document_id' : 'library.source_chunks c JOIN library.sources s ON s.id=c.source_id';
      const identity = kind === 'knowledge' ? 'd.id=v.source_id AND d.hash=v.version' : 's.id=v.source_id AND CAST(s.created_at AS TEXT)=v.version';
      this.db.exec(`BEGIN IMMEDIATE;
        DELETE FROM ${kind}_vectors WHERE id IN (SELECT v.id FROM ${kind}_versions v WHERE v.model<>'${vectorModel}' OR NOT EXISTS(SELECT 1 FROM ${live} WHERE c.id=v.id AND ${identity}));
        DELETE FROM ${kind}_versions WHERE model<>'${vectorModel}' OR NOT EXISTS(SELECT 1 FROM ${live} WHERE c.id=${kind}_versions.id AND ${identity.replaceAll('v.', `${kind}_versions.`)});
        COMMIT;`);
    }
  }
  candidates(input: RagScope, query: string, vector?: number[]): SourceExcerpt[] {
    const [project, personal] = this.scope(input);
    let lexical = input.handbookOnly ? this.memory.lexical(null, query, true) : input.conversationId ? this.sources.lexical(input.conversationId, query) : this.memory.lexical(project, query);
    const targets = input.sourceIds?.length ? [...new Set(input.sourceIds)].slice(0, 8) : undefined;
    if (targets) {
      for (const id of targets) { if (input.conversationId) this.sources.detail(input.conversationId, id); else if (!this.memory.detail('', project, id)) throw Error('Source unavailable.'); }
      lexical = input.conversationId ? this.sources.targetedLexical(input.conversationId, targets, query) : lexical.filter(hit => targets.includes(hit.sourceId));
    }
    const semantic: RankedPassage[] = [];
    if (vector) {
      const knowledge = this.db.prepare(`SELECT d.id AS sourceId,d.title,d.path,d.updated_at AS updatedAt,d.hash AS version,c.position,c.text,n.distance
        FROM (SELECT id,distance FROM knowledge_vectors WHERE embedding MATCH ? AND k=32 AND id IN
          (SELECT c.id FROM library.knowledge_chunks c JOIN library.knowledge_documents d ON d.id=c.document_id JOIN knowledge_versions v ON v.id=c.id
            WHERE v.model=? AND v.source_id=d.id AND v.version=d.hash AND d.kind${input.handbookOnly ? '=' : '<>'}'handbook' AND ${knowledgeScope}${targets ? ' AND d.id IN (SELECT value FROM json_each(?))' : ''})) n
        JOIN library.knowledge_chunks c ON c.id=n.id JOIN library.knowledge_documents d ON d.id=c.document_id`).all(packVector(vector), vectorModel, project, personal, ...(targets ? [JSON.stringify(targets)] : []));
      for (const row of knowledge) semantic.push(this.passage({ ...row, url: row.path ? String(row.path).startsWith('plugin-resource:') ? null : `project-file:${row.path}` : null }));
      if (input.conversationId && !input.handbookOnly) {
        const sources = this.db.prepare(`SELECT s.id AS sourceId,s.title,s.url,s.created_at AS updatedAt,c.position,c.text,n.distance
          FROM (SELECT id,distance FROM source_vectors WHERE embedding MATCH ? AND k=32 AND id IN
            (SELECT c.id FROM library.source_chunks c JOIN library.sources s ON s.id=c.source_id JOIN source_versions v ON v.id=c.id
              WHERE v.model=? AND v.source_id=s.id AND v.version=CAST(s.created_at AS TEXT) AND ${sourceScope}${targets ? ' AND s.id IN (SELECT value FROM json_each(?))' : ''})) n
          JOIN library.source_chunks c ON c.id=n.id JOIN library.sources s ON s.id=c.source_id`).all(packVector(vector), vectorModel, input.conversationId, input.conversationId, project, project, ...(targets ? [JSON.stringify(targets)] : []));
        for (const row of sources) semantic.push(this.passage(row));
      }
    }
    semantic.sort((a, b) => b.score - a.score);
    // Diversity belongs after reranking; keep multiple candidate chunks from a
    // long source so an answer in its third passage is still able to win.
    return fusePassages(lexical, semantic, 20, 20);
  }
  private passage(row: Record<string, unknown>): RankedPassage {
    return { sourceId: String(row.sourceId), title: String(row.title), url: row.url as string | null, position: Number(row.position), text: String(row.text), updatedAt: Number(row.updatedAt), version: row.version ? String(row.version) : undefined, score: 1 - Number(row.distance), citation: `[${String(row.title).replace(/[\[\]]/g, '')}](tinygpt-source:${row.sourceId})` };
  }
  /** Final freshness/eligibility check after reranking, including changed preferences. */
  eligible(input: RagScope, hits: SourceExcerpt[]): SourceExcerpt[] {
    const [project] = this.scope(input);
    return hits.filter(hit => {
      try {
        const detail = input.conversationId ? this.sources.detail(input.conversationId, hit.sourceId) : this.memory.detail('', project, hit.sourceId);
        const version = hit.version ? this.library.prepare('SELECT hash FROM knowledge_documents WHERE id=?').get(hit.sourceId)?.hash : undefined;
        const kind = this.library.prepare('SELECT kind FROM knowledge_documents WHERE id=?').get(hit.sourceId)?.kind;
        return (!input.handbookOnly || kind === 'handbook') && !!detail && !detail.excluded && detail.text.includes(hit.text) && (!hit.version || version === hit.version);
      } catch { return false; }
    });
  }
  close(): void { this.db.close(); this.library.close(); }
}
