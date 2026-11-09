import type { DatabaseSync } from 'node:sqlite';
import { sourceChunks } from '../core/source-text';

/** Repair the old 500-chunk cutoff once, retaining existing chunk IDs/vectors. */
export function completeSourceChunks(db: DatabaseSync, kind: 'knowledge' | 'source') {
  const key = `retrieval:complete-chunks:${kind}:v1`;
  if (db.prepare('SELECT value FROM metadata WHERE key=?').get(key)) return;
  const parent = kind === 'knowledge' ? 'knowledge_documents' : 'sources';
  const column = kind === 'knowledge' ? 'document_id' : 'source_id';
  const size = kind === 'knowledge' ? 1000 : 1600;
  // SAVEPOINT also works inside HistoryStore's existing schema transaction.
  db.exec('SAVEPOINT complete_source_chunks');
  try {
    const candidates = db.prepare(`SELECT ${column} AS id FROM ${kind}_chunks GROUP BY ${column} HAVING count(*)=500`).all();
    const document = db.prepare(`SELECT text FROM ${parent} WHERE id=?`);
    const insert = db.prepare(`INSERT INTO ${kind}_chunks(${column},position,text) VALUES(?,?,?)`);
    for (const { id } of candidates) {
      const row = document.get(id);
      if (!row) continue;
      for (const chunk of sourceChunks(String(row.text), size).slice(500)) insert.run(id, chunk.position, chunk.text);
    }
    db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, '1');
    db.exec('RELEASE complete_source_chunks');
  } catch (error) { db.exec('ROLLBACK TO complete_source_chunks; RELEASE complete_source_chunks'); throw error; }
}
