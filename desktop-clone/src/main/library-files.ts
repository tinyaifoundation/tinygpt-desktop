import type { HistoryStore } from './history';
import { readLimited, scopedPath } from './files';
import { retrievalQuery } from '../core/source-text';
import type { SourceDetail } from '../shared/tools';

/** Native Library access is user initiated; model access still uses conversation scope. */
export class LibraryFiles {
  constructor(private history: HistoryStore) {}
  detail(id: string): SourceDetail & { originalAvailable: boolean; linkedFile: boolean } {
    const db = this.history.sources.database, row = db.prepare('SELECT conversation_id AS conversationId FROM sources WHERE id=?').get(id);
    if (row) return { ...this.history.sources.detail(String(row.conversationId), id), originalAvailable: !!db.prepare('SELECT source_id FROM source_files WHERE source_id=?').get(id) || !!this.history.sources.originalImage(String(row.conversationId), id), linkedFile: false };
    const memory = this.history.memory.evidence(id), file = db.prepare('SELECT kind,root_path,path,enabled FROM knowledge_documents WHERE id=?').get(id);
    const project = memory.projectId ? this.history.project(memory.projectId) : undefined;
    return { ...memory, excluded: !file?.enabled, conversationId: '', kind: 'memory' as const, mime: 'text/plain', size: Buffer.byteLength(memory.text), createdAt: memory.updatedAt, messageId: null, url: null, image: null, originalAvailable: false, linkedFile: file?.kind === 'indexed-file' && !!project?.rootPath && project.rootPath === file.root_path };
  }
  async bytes(id: string) {
    const source = this.detail(id);
    if (source.conversationId) return this.history.sources.originalFile(source.conversationId, id).bytes;
    if (source.linkedFile) {
      const row = this.history.sources.database.prepare('SELECT path,root_path FROM knowledge_documents WHERE id=?').get(id)!;
      return readLimited(await scopedPath(String(row.root_path), String(row.path)));
    }
    return Buffer.from(source.text);
  }
  exclude(id: string, excluded: boolean) {
    const source = this.detail(id), db = this.history.sources.database;
    if (source.conversationId) this.history.sources.setExcluded(source.conversationId, id, excluded);
    else {
      const row = db.prepare('SELECT kind,path,root_path FROM knowledge_documents WHERE id=?').get(id)!;
      db.prepare('UPDATE knowledge_documents SET enabled=? WHERE id=?').run(excluded ? 0 : 1, id);
      if (row.kind === 'indexed-file') {
        if (excluded) db.prepare('INSERT OR IGNORE INTO knowledge_exclusions(project_id,root_path,path) VALUES(?,?,?)').run(source.projectId!, String(row.root_path), String(row.path));
        else db.prepare('DELETE FROM knowledge_exclusions WHERE project_id=? AND root_path=? AND path=?').run(source.projectId!, String(row.root_path), String(row.path));
      }
      this.history.memory.clearDerivedContext(source.projectId);
    }
  }
  search(query: string): string[] {
    const expression = retrievalQuery(query); if (!expression) return [];
    const db = this.history.sources.database;
    return [...new Set(['source','knowledge'].flatMap(prefix => db.prepare(`SELECT DISTINCT c.${prefix === 'source' ? 'source_id' : 'document_id'} AS id FROM ${prefix}_fts JOIN ${prefix}_chunks c ON c.id=${prefix}_fts.rowid WHERE ${prefix}_fts MATCH ? LIMIT 2000`).all(expression).map(row => String(row.id))))];
  }
}
