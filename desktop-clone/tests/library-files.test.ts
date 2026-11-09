import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { LibraryFiles } from '../src/main/library-files';
import { FileIngestion } from '../src/main/file-ingestion';
import { RagIndex } from '../src/main/rag-index';
it('keeps pending uploads across restart and resumes them without changing their source IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-ingestion-restart-')), path = join(root, 'library.sqlite');
  let history = new HistoryStore(path); let ingestion: FileIngestion | undefined;
  try {
    const chat = history.createConversation(null);
    ingestion = new FileIngestion(history.sources, async (_name, _bytes, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('closed')), { once: true })), () => {});
    const source = ingestion.upload(chat.id, 'report.txt', Buffer.from('Original restart document')); await new Promise(resolve => setImmediate(resolve));
    await ingestion.close(); history.close(); history = new HistoryStore(path);
    expect(history.sources.fileStatus(source.id)?.status).toBe('preparing');
    ingestion = new FileIngestion(history.sources, async (_name, bytes) => ({ text: bytes.toString(), status: 'ready' }), () => {});
    await ingestion.wait([source.id], new AbortController().signal);
    const files = new LibraryFiles(history); expect(files.detail(source.id).processing?.status).toBe('ready'); expect((await files.bytes(source.id)).toString()).toBe('Original restart document');
    expect(files.search('restart')).toContain(source.id);
  } finally { await ingestion?.close(); history.close(); await rm(root, { recursive: true, force: true }); }
});
it('keeps Project originals as granted links, allows reversible retrieval exclusion, and rejects changed grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-library-files-')), history = new HistoryStore(':memory:');
  try {
    await writeFile(join(root, 'budget.md'), 'Original project budget'); const project = history.createProject('Project', '', false, root), chat = history.createConversation(project.id);
    const id = history.memory.upsert({ projectId: project.id, kind: 'indexed-file', title: 'budget.md', path: 'budget.md', rootPath: root, text: 'Original project budget', size: 23 });
    const files = new LibraryFiles(history); expect(files.detail(id).linkedFile).toBe(true); expect((await files.bytes(id)).toString()).toBe('Original project budget');
    expect(history.outputs().find(row => row.sourceId === id)?.origin).toBe('project'); files.exclude(id, true);
    expect(history.memory.excluded(project.id, root, 'budget.md')).toBe(true); expect(history.sources.search(chat.id, 'budget')).toEqual([]); expect(files.detail(id).excluded).toBe(true);
    expect((await files.bytes(id)).toString()).toBe('Original project budget'); files.exclude(id, false); expect(history.sources.search(chat.id, 'budget')).toHaveLength(1);
    history.memory.db.prepare('UPDATE knowledge_documents SET path=? WHERE id=?').run('../escape.md', id); await expect(files.bytes(id)).rejects.toThrow('outside');
  } finally { history.close(); await rm(root, { recursive: true, force: true }); }
});
it('applies targeted source filtering before semantic top-K and rechecks exclusion after inference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-targeted-rag-')), path = join(root, 'library.sqlite'), history = new HistoryStore(path); let index: RagIndex | undefined;
  try {
    const chat = history.createConversation(null), vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
    for (let i = 0; i < 40; i++) history.sources.add(chat.id, { kind: 'page', title: `Distractor ${i}`, text: `common irrelevant ${i}` });
    const source = history.sources.add(chat.id, { kind: 'attachment', title: 'Target', text: 'common needle finding' });
    index = new RagIndex(path, join(root, 'index.sqlite'));
    for (const chunk of index.pending(1000)) index.save(chunk, vector);
    const hits = index.candidates({ conversationId: chat.id, sourceIds: [source.id] }, 'unmatched semantic request', vector);
    expect(hits.map(hit => hit.sourceId)).toEqual([source.id]);
    history.sources.setExcluded(chat.id, source.id, true);
    expect(index.eligible({ conversationId: chat.id }, hits)).toEqual([]);
    expect(index.candidates({ conversationId: chat.id, sourceIds: [source.id] }, 'needle', vector)).toEqual([]);
  } finally { index?.close(); history.close(); await rm(root, { recursive: true, force: true }); }
});
