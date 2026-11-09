import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceChunks } from '../src/core/source-text';
import { HistoryStore } from '../src/main/history';
import { packVector } from '../src/main/memory-library';

it.each([1000, 1600])('indexes the complete accepted document with chunk size %s, including newline-heavy tails', size => {
  for (const text of ['a'.repeat(499970) + ' TAIL_SENTINEL_62891', ('x'.repeat(820) + '\n').repeat(600) + 'TAIL_SENTINEL_62891']) {
    const chunks = sourceChunks(text, size);
    expect(chunks.at(-1)?.text).toContain('TAIL_SENTINEL_62891');
    expect(chunks.every((chunk, position) => chunk.position === position && chunk.text.length <= size)).toBe(true);
  }
  expect(() => sourceChunks('text', 180)).toThrow('overlap');
});

it('repairs persisted truncated indexes once, preserves original vectors and queues the missing tails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-chunk-repair-'));
  const path = join(root, 'library.sqlite'); let history = new HistoryStore(path);
  try {
    const project = history.createProject('Large document', '', false, root), chat = history.createConversation(project.id);
    history.memory.configureIndex(project.id, true);
    const text = ('x'.repeat(820) + '\n').repeat(600) + 'TAIL_SENTINEL_62891';
    const knowledge = history.memory.upsert({ projectId: project.id, kind: 'indexed-file', title: 'large.md', path: 'large.md', rootPath: root, text, size: text.length });
    const source = history.sources.add(chat.id, { kind: 'page', title: 'Large source', text });
    expect(history.memory.lexical(project.id, 'TAIL_SENTINEL_62891')[0].sourceId).toBe(knowledge);
    expect(history.sources.lexical(chat.id, 'TAIL_SENTINEL_62891').some(hit => hit.sourceId === source.id)).toBe(true);
    const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
    const heads = history.memory.pendingVectors(10000).filter(row => row.kind === 'knowledge' ? row.id === Number(history.memory.db.prepare('SELECT min(id) AS id FROM knowledge_chunks WHERE document_id=?').get(knowledge)!.id) : row.id === Number(history.memory.db.prepare('SELECT min(id) AS id FROM source_chunks WHERE source_id=?').get(source.id)!.id));
    heads.forEach(row => history.memory.saveVector(row, vector));
    // Recreate the persisted state produced by the old capped chunker.
    history.memory.db.prepare('DELETE FROM knowledge_chunks WHERE document_id=? AND position>=500').run(knowledge);
    history.memory.db.prepare('DELETE FROM source_chunks WHERE source_id=? AND position>=500').run(source.id);
    history.memory.db.exec("DELETE FROM metadata WHERE key IN ('retrieval:complete-chunks:knowledge:v1','retrieval:complete-chunks:source:v1')");
    expect(history.sources.lexical(chat.id, 'TAIL_SENTINEL_62891')).toEqual([]);
    history.close(); history = new HistoryStore(path);
    expect(history.memory.lexical(project.id, 'TAIL_SENTINEL_62891')[0].sourceId).toBe(knowledge);
    expect(history.sources.lexical(chat.id, 'TAIL_SENTINEL_62891').some(hit => hit.sourceId === source.id)).toBe(true);
    const pending = history.memory.pendingVectors(10000);
    expect(pending.some(row => row.text.includes('TAIL_SENTINEL_62891') && row.kind === 'knowledge')).toBe(true);
    expect(pending.some(row => row.text.includes('TAIL_SENTINEL_62891') && row.kind === 'source')).toBe(true);
    for (const head of heads) {
      const saved = head.kind === 'knowledge' ? history.memory.db.prepare('SELECT vector FROM knowledge_chunks WHERE id=?').get(head.id) : history.memory.db.prepare('SELECT vector FROM source_vectors WHERE chunk_id=?').get(head.id);
      expect(Buffer.from(saved!.vector as Uint8Array)).toEqual(packVector(vector));
    }
    const counts = history.memory.vectorCounts();
    history.close(); history = new HistoryStore(path);
    expect(history.memory.vectorCounts()).toEqual(counts);
    expect(history.memory.db.prepare('SELECT count(*) AS n FROM knowledge_chunks WHERE document_id=?').get(knowledge)!.n).toBe(sourceChunks(text, 1000).length);
  } finally { history.close(); await rm(root, { recursive: true, force: true }); }
});
