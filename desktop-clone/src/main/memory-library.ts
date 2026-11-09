import { handbookArticles, handbookSourceId } from '../core/handbook';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { sourceChunks, retrievalQuery } from '../core/source-text';
import { completeSourceChunks } from './complete-source-chunks';
import type { RankedPassage } from '../core/hybrid-retrieval';
import type { IndexedDocument, MemoryInput, SavedMemory, ProjectIndexStatus, StoredEvidence, ProfileName } from '../shared/memory';
import type { SourceDetail, SourceSummary } from '../shared/tools';

export const vectorModel = 'bge-small-en-v1.5-q8-cls-v1';
export function contentHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function packVector(values: number[]): Buffer {
  if (values.length !== 384 || values.some(value => !Number.isFinite(value))) throw new Error('Invalid embedding.');
  const buffer = Buffer.alloc(values.length * 4); values.forEach((value, i) => buffer.writeFloatLE(value, i * 4)); return buffer;
}
export function unpackVector(value: unknown): number[] {
  if (!(value instanceof Uint8Array) || value.byteLength !== 384 * 4) return [];
  const bytes = Buffer.from(value); return Array.from({ length: 384 }, (_, i) => bytes.readFloatLE(i * 4));
}

export class MemoryLibrary {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), kind TEXT NOT NULL,
        title TEXT NOT NULL, path TEXT, root_path TEXT, text TEXT NOT NULL, hash TEXT NOT NULL,
        size INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
        UNIQUE(project_id,kind,path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id INTEGER PRIMARY KEY, document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, text TEXT NOT NULL, vector BLOB, model TEXT
      ) STRICT;
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(text,content='knowledge_chunks',content_rowid='id',tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN INSERT INTO knowledge_fts(rowid,text) VALUES(new.id,new.text); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN INSERT INTO knowledge_fts(knowledge_fts,rowid,text) VALUES('delete',old.id,old.text); END;
      CREATE TABLE IF NOT EXISTS project_indexes (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), root_path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'idle', skipped INTEGER NOT NULL DEFAULT 0, last_scan INTEGER, message TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE TABLE IF NOT EXISTS knowledge_exclusions (project_id TEXT NOT NULL REFERENCES projects(id), root_path TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(project_id,root_path,path)) STRICT;
      CREATE TABLE IF NOT EXISTS source_vectors (chunk_id INTEGER PRIMARY KEY REFERENCES source_chunks(id) ON DELETE CASCADE, vector BLOB NOT NULL, model TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS knowledge_scope ON knowledge_documents(project_id,kind,enabled);
      CREATE INDEX IF NOT EXISTS knowledge_chunk_parent ON knowledge_chunks(document_id,position);
      CREATE INDEX IF NOT EXISTS knowledge_vector_model ON knowledge_chunks(model);
      CREATE INDEX IF NOT EXISTS source_vector_model ON source_vectors(model);
      CREATE TABLE IF NOT EXISTS plugin_conversation_access (plugin_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, PRIMARY KEY(plugin_id,conversation_id)) STRICT;
    `);
    if (!db.prepare('PRAGMA table_info(knowledge_documents)').all().some(column => column.name === 'fingerprint')) db.exec('ALTER TABLE knowledge_documents ADD COLUMN fingerprint TEXT');
    completeSourceChunks(db, 'knowledge');
    this.ensureDefaultIndexes();
  }
  syncHandbook(): void {
    const live = new Set(handbookArticles.map(article => handbookSourceId(article.id)));
    for (const row of this.db.prepare("SELECT id FROM knowledge_documents WHERE kind='handbook'").all()) {
      if (!live.has(String(row.id))) { this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(row.id); this.clearDerivedContext(null); }
    }
    for (const article of handbookArticles) {
      const id = handbookSourceId(article.id);
      if (this.db.prepare('SELECT hash FROM knowledge_documents WHERE id=?').get(id)?.hash === contentHash(article.text)) continue;
      this.upsert({ id, projectId: null, kind: 'handbook', title: 'TinyGPT Help: ' + article.title, text: article.text, size: Buffer.byteLength(article.text) });
    }
  }
  preference(key: string): boolean { const value = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(`memory:${key}`)?.value; return value === '1' || (['semantic', 'personal'].includes(key) && value === undefined); }
  setPreference(key: string, value: boolean): void { if (key === 'personal' && this.preference(key) !== value) this.clearDerivedContext(null); this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`memory:${key}`, value ? '1' : '0'); }
  private checkProject(id: string | null): void { if (id && !this.db.prepare('SELECT id FROM projects WHERE id=?').get(id)) throw new Error('Project not found.'); }
  private scope(projectId: string | null): [string | null, number] { this.checkProject(projectId); return [projectId, this.preference('personal') ? 1 : 0]; }
  memories(): SavedMemory[] { return this.db.prepare("SELECT id,project_id AS projectId,title,text,enabled,updated_at AS updatedAt FROM knowledge_documents WHERE kind='memory' ORDER BY updated_at DESC LIMIT 500").all().map(row => ({ ...row, enabled: !!row.enabled })) as unknown as SavedMemory[]; }
  evidence(id: string): StoredEvidence { const row = this.db.prepare('SELECT id,project_id AS projectId,title,text,updated_at AS updatedAt FROM knowledge_documents WHERE id=?').get(id); if (!row) throw new Error('Memory not found.'); return row as unknown as StoredEvidence; }
  saveMemory(input: MemoryInput): SavedMemory {
    this.checkProject(input.projectId);
    if (!input.id && Number(this.db.prepare("SELECT count(*) AS n FROM knowledge_documents WHERE kind='memory'").get()!.n) >= 500) throw new Error('Save up to 500 memories. Remove a memory before adding another.');
    if (input.id && !this.db.prepare("SELECT id FROM knowledge_documents WHERE id=? AND kind='memory'").get(input.id)) throw new Error('Memory not found.');
    const id = this.upsert({ id: input.id, projectId: input.projectId, kind: 'memory', title: input.title, text: input.text, size: Buffer.byteLength(input.text), enabled: input.enabled });
    return this.memories().find(memory => memory.id === id)!;
  }
  saveProfileName(input: ProfileName): void {
    const name = [input.firstName.trim(), input.lastName.trim()].filter(Boolean).join(' ');
    const key = 'memory:profile-name';
    const previous = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    const memory = previous ? this.memories().find(item => item.id === previous && item.projectId === null) : undefined;
    if (!name || name.toLowerCase() === 'personal') {
      if (memory) this.remove(memory.id);
      this.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
      return;
    }
    const text = `The user's name is ${name}.`;
    if (memory?.text === text) return;
    const saved = this.saveMemory({ id: memory?.id, projectId: null, title: 'Your name', text, enabled: memory?.enabled ?? true });
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, saved.id);
    // Providing a profile name opts into memory on a new profile. Preserve an
    // existing explicit sharing choice, including a previous opt-out.
    if (!this.db.prepare("SELECT value FROM metadata WHERE key='memory:personal'").get()) this.setPreference('personal', true);
  }
  profileNameMemory(): SavedMemory | undefined {
    if (!this.preference('personal')) return;
    const id = this.db.prepare("SELECT value FROM metadata WHERE key='memory:profile-name'").get()?.value;
    return id ? this.memories().find(memory => memory.id === id && memory.projectId === null && memory.enabled) : undefined;
  }
  upsert(input: { id?: string; projectId: string | null; kind: 'memory' | 'indexed-file' | 'plugin-resource' | 'handbook'; title: string; text: string; size: number; enabled?: boolean; path?: string; rootPath?: string; fingerprint?: string }): string {
    const id = input.id ?? randomUUID(); const hash = contentHash(input.text);
    const existing = this.db.prepare('SELECT hash,enabled,project_id FROM knowledge_documents WHERE id=?').get(id);
    const nested = input.kind === 'handbook';
    this.db.exec(nested ? 'SAVEPOINT handbook_upsert' : 'BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO knowledge_documents(id,project_id,kind,title,path,root_path,text,hash,size,enabled,updated_at,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,title=excluded.title,text=excluded.text,hash=excluded.hash,size=excluded.size,enabled=excluded.enabled,updated_at=excluded.updated_at,root_path=excluded.root_path,fingerprint=excluded.fingerprint`).run(id, input.projectId, input.kind, input.title, input.path ?? null, input.rootPath ?? null, input.text, hash, input.size, input.enabled === false ? 0 : 1, Date.now(), input.fingerprint ?? null);
      if (existing?.hash !== hash) {
        this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id=?').run(id);
        const insert = this.db.prepare('INSERT INTO knowledge_chunks(document_id,position,text) VALUES(?,?,?)');
        for (const chunk of sourceChunks(input.text, 1000)) insert.run(id, chunk.position, chunk.text);
      }
      if (existing && (existing.hash !== hash || existing.project_id !== input.projectId || !!existing.enabled !== (input.enabled !== false))) { this.clearDerivedContext(existing.project_id as string | null); this.clearDerivedContext(input.projectId); }
      this.db.exec(nested ? 'RELEASE handbook_upsert' : 'COMMIT');
    } catch (error) { this.db.exec(nested ? 'ROLLBACK TO handbook_upsert; RELEASE handbook_upsert' : 'ROLLBACK'); throw error; }
    return id;
  }
  remove(id: string): void {
    const row = this.db.prepare('SELECT project_id,root_path,path,kind FROM knowledge_documents WHERE id=?').get(id);
    if (!row) throw new Error('Memory not found.');
    if (row.kind === 'handbook') throw new Error('Bundled help is read-only.');
    // A forgotten file must not return on the next scan.
    if (row.kind === 'indexed-file') this.db.prepare('INSERT OR IGNORE INTO knowledge_exclusions(project_id,root_path,path) VALUES(?,?,?)').run(String(row.project_id), String(row.root_path), String(row.path));
    this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(id);
    this.clearDerivedContext(row.project_id as string | null);
    if (row.kind === 'indexed-file') this.db.prepare("DELETE FROM sources WHERE project_id=? AND kind='project-file' AND url=?").run(String(row.project_id), `project-file:${row.path}`);
  }
  pluginResource(pluginId: string, projectId: string, uri: string, title: string, text: string): string {
    this.checkProject(projectId);
    const rootPath = `plugin:${pluginId}`; const path = `plugin-resource:${pluginId}:${uri}`;
    const previous = this.db.prepare("SELECT id FROM knowledge_documents WHERE project_id=? AND kind='plugin-resource' AND path=?").get(projectId, path);
    return this.upsert({ id: previous ? String(previous.id) : undefined, projectId, kind: 'plugin-resource', title, text, size: Buffer.byteLength(text), path, rootPath });
  }
  pluginResources(pluginId: string): { id: string; projectId: string; uri: string; title: string; updatedAt: number }[] { return this.db.prepare("SELECT id,project_id AS projectId,path,title,updated_at AS updatedAt FROM knowledge_documents WHERE kind='plugin-resource' AND root_path=?").all(`plugin:${pluginId}`).map(row => ({ id: String(row.id), projectId: String(row.projectId), uri: String(row.path).slice(`plugin-resource:${pluginId}:`.length), title: String(row.title), updatedAt: Number(row.updatedAt) })); }
  recordPluginAccess(pluginId: string, conversationId: string): void { this.db.prepare('INSERT OR IGNORE INTO plugin_conversation_access(plugin_id,conversation_id) VALUES(?,?)').run(pluginId, conversationId); }
  revokePlugin(pluginId: string): void {
    const projects = this.db.prepare("SELECT DISTINCT project_id FROM knowledge_documents WHERE kind='plugin-resource' AND root_path=?").all(`plugin:${pluginId}`);
    this.db.prepare("DELETE FROM knowledge_documents WHERE kind='plugin-resource' AND root_path=?").run(`plugin:${pluginId}`);
    for (const project of projects) this.clearDerivedContext(String(project.project_id));
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_checkpoints'").get()) this.db.prepare('DELETE FROM context_checkpoints WHERE conversation_id IN (SELECT conversation_id FROM plugin_conversation_access WHERE plugin_id=?)').run(pluginId);
  }
  summaries(conversationId: string, projectId: string | null): SourceSummary[] {
    const [project, personal] = this.scope(projectId);
    return this.db.prepare(`SELECT id,title,project_id AS projectId,kind,size,updated_at AS createdAt,path FROM knowledge_documents WHERE enabled=1 AND (kind='handbook' OR project_id=? OR (?=1 AND project_id IS NULL AND kind='memory')) AND (kind IN ('memory','plugin-resource','handbook') OR EXISTS(SELECT 1 FROM project_indexes i JOIN projects p ON p.id=i.project_id WHERE i.project_id=knowledge_documents.project_id AND i.enabled=1 AND i.root_path=knowledge_documents.root_path AND p.root_path=i.root_path)) ORDER BY updated_at DESC LIMIT 1200`).all(project, personal).map(row => ({ id: String(row.id), conversationId, projectId: row.projectId as string | null, kind: row.kind === 'indexed-file' ? 'project-file' : 'memory', title: String(row.title), url: row.path ? (String(row.path).startsWith('plugin-resource:') ? null : `project-file:${row.path}`) : null, mime: 'text/plain', size: Number(row.size), createdAt: Number(row.createdAt), messageId: null }));
  }
  detail(conversationId: string, projectId: string | null, id: string): SourceDetail | null {
    const [project, personal] = this.scope(projectId);
    const row = this.db.prepare(`SELECT * FROM knowledge_documents d WHERE d.id=? AND d.enabled=1 AND (d.kind='handbook' OR d.project_id=? OR (?=1 AND d.project_id IS NULL AND d.kind='memory')) AND (d.kind IN ('memory','plugin-resource','handbook') OR EXISTS(SELECT 1 FROM project_indexes i JOIN projects p ON p.id=i.project_id WHERE i.project_id=d.project_id AND i.enabled=1 AND i.root_path=d.root_path AND p.root_path=i.root_path))`).get(id, project, personal);
    if (!row) return null;
    return { id, conversationId, projectId: row.project_id as string | null, kind: row.kind === 'indexed-file' ? 'project-file' : 'memory', title: String(row.title), url: row.path && !String(row.path).startsWith('plugin-resource:') ? `project-file:${row.path}` : null, mime: 'text/plain', size: Number(row.size), createdAt: Number(row.updated_at), messageId: null, text: String(row.text), image: null };
  }
  lexical(projectId: string | null, query: string, handbookOnly = false): RankedPassage[] {
    const expression = retrievalQuery(query); if (!expression) return [];
    const [project, personal] = this.scope(projectId);
    return this.db.prepare(`SELECT d.id AS sourceId,d.title,d.path,d.updated_at AS updatedAt,d.hash AS version,c.position,c.text,bm25(knowledge_fts) AS score FROM knowledge_fts JOIN knowledge_chunks c ON c.id=knowledge_fts.rowid JOIN knowledge_documents d ON d.id=c.document_id WHERE knowledge_fts MATCH ? AND d.kind${handbookOnly ? '=' : '<>'}'handbook' AND d.enabled=1 AND (d.kind='handbook' OR d.project_id=? OR (?=1 AND d.project_id IS NULL AND d.kind='memory')) AND (d.kind IN ('memory','plugin-resource','handbook') OR EXISTS(SELECT 1 FROM project_indexes i JOIN projects p ON p.id=i.project_id WHERE i.project_id=d.project_id AND i.enabled=1 AND i.root_path=d.root_path AND p.root_path=i.root_path)) ORDER BY score,d.updated_at DESC LIMIT 40`).all(expression, project, personal).map(row => this.passage(row));
  }
  private passage(row: Record<string, unknown>): RankedPassage { return { sourceId: String(row.sourceId), title: String(row.title), url: row.path ? (String(row.path).startsWith('plugin-resource:') ? null : `project-file:${row.path}`) : null, position: Number(row.position), text: String(row.text), citation: `[${String(row.title).replace(/[\[\]]/g, '')}](tinygpt-source:${row.sourceId})`, score: Number(row.score), updatedAt: Number(row.updatedAt), version: String(row.version) }; }
  documents(): IndexedDocument[] { return this.db.prepare("SELECT id,project_id AS projectId,title,size,enabled,updated_at AS updatedAt FROM knowledge_documents WHERE kind='indexed-file' ORDER BY title").all().map(({ enabled, ...row }) => ({ ...row, excluded: !enabled })) as unknown as IndexedDocument[]; }
  indexes(): ProjectIndexStatus[] { return this.db.prepare(`SELECT p.id AS projectId,p.root_path AS rootPath,i.enabled,i.status,i.skipped,i.last_scan AS lastScan,i.message,(SELECT count(*) FROM knowledge_documents d WHERE d.project_id=p.id AND d.kind='indexed-file') AS files FROM projects p LEFT JOIN project_indexes i ON i.project_id=p.id ORDER BY p.name`).all().map(row => ({ ...row, enabled: !!row.enabled, status: row.status ?? 'idle', skipped: row.skipped ?? 0, message: row.message ?? '' })) as unknown as ProjectIndexStatus[]; }
  ensureDefaultIndexes(): void {
    // An existing row represents an explicit pause/forget or an active index.
    // Initialize only granted folders that have never been configured.
    this.db.exec(`INSERT INTO project_indexes(project_id,root_path,enabled)
      SELECT id,root_path,1 FROM projects WHERE root_path IS NOT NULL AND root_path<>''
      ON CONFLICT(project_id) DO NOTHING`);
  }
  configureIndex(projectId: string, enabled: boolean): void {
    this.checkProject(projectId); const root = this.db.prepare('SELECT root_path FROM projects WHERE id=?').get(projectId)?.root_path;
    if (!root && enabled) throw new Error('Select a Project folder before indexing.');
    this.db.prepare(`INSERT INTO project_indexes(project_id,root_path,enabled,status) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET root_path=excluded.root_path,enabled=excluded.enabled,status=excluded.status`).run(projectId, String(root ?? ''), enabled ? 1 : 0, enabled ? 'idle' : 'paused');
    if (!enabled) this.clearDerivedContext(projectId);
    this.db.prepare("DELETE FROM knowledge_documents WHERE project_id=? AND kind='indexed-file' AND root_path<>?").run(projectId, String(root ?? ''));
  }
  forgetIndex(projectId: string): void { this.configureIndex(projectId, false); this.db.prepare("DELETE FROM knowledge_documents WHERE project_id=? AND kind='indexed-file'").run(projectId); this.db.prepare('DELETE FROM knowledge_exclusions WHERE project_id=?').run(projectId); this.db.prepare("DELETE FROM sources WHERE project_id=? AND kind='project-file'").run(projectId); this.clearDerivedContext(projectId); }
  excluded(projectId: string, root: string, path: string): boolean { return !!this.db.prepare('SELECT 1 FROM knowledge_exclusions WHERE project_id=? AND root_path=? AND path=?').get(projectId, root, path); }
  indexState(projectId: string, status: ProjectIndexStatus['status'], message = '', skipped = 0): void { this.db.prepare('UPDATE project_indexes SET status=?,message=?,skipped=?,last_scan=? WHERE project_id=?').run(status, message, skipped, Date.now(), projectId); }
  file(projectId: string, path: string): { id: string; hash: string; fingerprint: string | null; characters: number } | undefined { return this.db.prepare("SELECT id,hash,fingerprint,length(text) AS characters FROM knowledge_documents WHERE project_id=? AND kind='indexed-file' AND path=?").get(projectId, path) as unknown as { id: string; hash: string; fingerprint: string | null; characters: number } | undefined; }
  pruneFiles(projectId: string, seen: Set<string>): void { for (const row of this.db.prepare("SELECT id,path FROM knowledge_documents WHERE project_id=? AND kind='indexed-file'").all(projectId)) if (!seen.has(String(row.path))) { this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(String(row.id)); this.db.prepare("DELETE FROM sources WHERE project_id=? AND kind='project-file' AND url=?").run(projectId, `project-file:${row.path}`); this.clearDerivedContext(projectId); } }
  clearDerivedContext(projectId: string | null): void { if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_checkpoints'").get()) this.db.prepare('DELETE FROM context_checkpoints WHERE ? IS NULL OR conversation_id IN (SELECT id FROM conversations WHERE project_id=?)').run(projectId, projectId); }
  pendingVectors(limit = 4): { kind: 'knowledge' | 'source'; id: number; text: string }[] {
    const knowledge = this.db.prepare('SELECT c.id,c.text FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.enabled=1 AND (c.vector IS NULL OR c.model<>?) LIMIT ?').all(vectorModel, limit).map(row => ({ kind: 'knowledge' as const, id: Number(row.id), text: String(row.text) }));
    return [...knowledge, ...this.db.prepare('SELECT c.id,c.text FROM source_chunks c LEFT JOIN source_vectors v ON v.chunk_id=c.id WHERE NOT EXISTS(SELECT 1 FROM source_exclusions e WHERE e.source_id=c.source_id) AND (v.chunk_id IS NULL OR v.model<>?) LIMIT ?').all(vectorModel, limit - knowledge.length).map(row => ({ kind: 'source' as const, id: Number(row.id), text: String(row.text) }))];
  }
  saveVector(row: { kind: 'knowledge' | 'source'; id: number; text: string }, vector: number[]): void {
    const current = this.db.prepare(`SELECT text FROM ${row.kind === 'knowledge' ? 'knowledge_chunks' : 'source_chunks'} WHERE id=?`).get(row.id);
    if (current?.text !== row.text) return;
    if (row.kind === 'knowledge') this.db.prepare('UPDATE knowledge_chunks SET vector=?,model=? WHERE id=? AND text=?').run(packVector(vector), vectorModel, row.id, row.text);
    else this.db.prepare('INSERT INTO source_vectors(chunk_id,vector,model) VALUES(?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET vector=excluded.vector,model=excluded.model').run(row.id, packVector(vector), vectorModel);
  }
  vectorCounts(): { embedded: number; pending: number } {
    const total = Number(this.db.prepare('SELECT (SELECT count(*) FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.enabled=1)+(SELECT count(*) FROM source_chunks c WHERE NOT EXISTS(SELECT 1 FROM source_exclusions e WHERE e.source_id=c.source_id)) AS n').get()!.n);
    const embedded = Number(this.db.prepare('SELECT (SELECT count(*) FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE d.enabled=1 AND c.model=? AND c.vector IS NOT NULL)+(SELECT count(*) FROM source_vectors v JOIN source_chunks c ON c.id=v.chunk_id WHERE v.model=? AND NOT EXISTS(SELECT 1 FROM source_exclusions e WHERE e.source_id=c.source_id)) AS n').get(vectorModel, vectorModel)!.n);
    return { embedded, pending: total - embedded };
  }
}
