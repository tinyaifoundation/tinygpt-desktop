import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HistoryStore } from '../src/main/history';
import { MemoryIndexer } from '../src/main/memory-indexer';
import { MemoryService } from '../src/main/memory-service';
import { RagIndex } from '../src/main/rag-index';
import { fusePassages } from '../src/core/hybrid-retrieval';
import type { EmbeddingRuntime } from '../src/main/embeddings';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';

const stores = new Set<HistoryStore>(); const folders: string[] = []; const indexers: MemoryIndexer[] = [];
async function folder() { const path = await mkdtemp(join(tmpdir(), 'tinygpt-memory-')); folders.push(path); return path; }
function store(path = ':memory:') { const value = new HistoryStore(path); stores.add(value); return value; }
const vector = (axis = 0) => Array.from({ length: 384 }, (_, i) => i === axis ? 1 : 0);
afterEach(async () => { for (const index of indexers.splice(0)) await index.shutdown(); for (const value of stores) value.close(); stores.clear(); for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('durable scoped memory and hybrid retrieval', () => {
  it('migrates v9 without losing history, persists memories and keeps Projects/personal opt-in separate', async () => {
    const path = join(await folder(), 'library.sqlite'); const history = store(path);
    const a = history.createProject('A', ''); const b = history.createProject('B', '');
    const chat = history.createConversation(a.id); const sibling = history.createConversation(a.id); const unrelated = history.createConversation(b.id); const personal = history.createConversation(null);
    const turn = history.startTurn(chat.id, 'Question', 'local'); history.saveReply(turn.assistantId, 'Answer', 'complete');
    const saved = history.memory.saveMemory({ projectId: a.id, title: 'Launch', text: 'BLUEBIRD launch is Friday', enabled: true });
    const global = history.memory.saveMemory({ projectId: null, title: 'Preference', text: 'BLUEBIRD prefers short answers', enabled: true });
    history.memory.setPreference('personal', false);
    expect(history.sources.search(sibling.id, 'BLUEBIRD').map(hit => hit.sourceId)).toEqual([saved.id]);
    expect(history.sources.search(unrelated.id, 'BLUEBIRD')).toEqual([]); expect(history.sources.search(personal.id, 'BLUEBIRD')).toEqual([]);
    expect(() => history.sources.detail(unrelated.id, saved.id)).toThrow('Source not found');
    history.memory.setPreference('personal', true);
    expect(history.sources.search(unrelated.id, 'BLUEBIRD').map(hit => hit.sourceId)).toEqual([global.id]);
    history.close(); stores.delete(history);
    const db = new DatabaseSync(path); db.exec('PRAGMA user_version=9'); db.close(); const reopened = store(path);
    expect(reopened.conversation(chat.id).messages.map(message => message.text)).toEqual(['Question', 'Answer']);
    expect(reopened.memory.memories()).toHaveLength(2); expect(reopened.memory.preference('personal')).toBe(true);
    expect(reopened.memory.db.prepare('PRAGMA user_version').get()?.user_version).toBe(21);
    expect(reopened.memory.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message_reactions'").get()?.name).toBe('message_reactions');
    expect(reopened.projects().every(project => project.favorite === false)).toBe(true);
  });
  it('retrieves paraphrases through the native index, excluding drafts and wrong scopes before scoring', async () => {
    const root = await folder(); const history = store(join(root, 'library.sqlite')); const project = history.createProject('A', ''); const other = history.createProject('B', ''); const chat = history.createConversation(project.id); const sibling = history.createConversation(project.id);
    const memory = history.memory.saveMemory({ projectId: project.id, title: 'Deployment', text: 'Release requires two maintainers to authorize production.', enabled: true });
    history.memory.saveMemory({ projectId: other.id, title: 'Hidden', text: 'This must never cross the boundary.', enabled: true });
    const attachment = history.sources.add(chat.id, { kind: 'attachment', title: 'Draft', text: 'Unsent private material' });
    const index = new RagIndex(history.databasePath, join(root, 'vectors.sqlite'));
    try {
      for (const row of index.pending(40)) index.save(row, vector());
      expect(index.candidates({ conversationId: sibling.id }, 'Who approves shipping?', vector()).map(hit => hit.sourceId)).toEqual([memory.id]);
      expect(() => history.sources.detail(sibling.id, attachment.id)).toThrow('Source not found');
      history.memory.saveMemory({ ...memory, enabled: false });
      expect(index.candidates({ conversationId: sibling.id }, 'Who approves shipping?', vector())).toEqual([]);
    } finally { index.close(); }
  });
  it('correction and forgetting remove old FTS/vector facts and derived checkpoints, preserving original messages', () => {
    const history = store(); const project = history.createProject('A', ''); const chat = history.createConversation(project.id);
    const turn = history.startTurn(chat.id, 'Keep the original question', 'local'); history.saveReply(turn.assistantId, 'Original answer', 'complete');
    const id = history.memory.saveMemory({ projectId: project.id, title: 'Budget', text: 'OLDVALUE budget is 100', enabled: true }).id;
    history.saveContextCheckpoint(chat.id, { throughMessageId: turn.conversation.messages[0].id, text: 'Old derived fact' });
    const pending = history.memory.pendingVectors()[0]; history.memory.saveVector(pending, vector());
    history.memory.saveMemory({ id, projectId: project.id, title: 'Budget', text: 'NEWVALUE budget is 200', enabled: true });
    history.memory.saveVector(pending, vector()); // late old inference cannot repopulate a corrected chunk
    expect(history.sources.search(chat.id, 'OLDVALUE')).toEqual([]); expect(history.sources.search(chat.id, 'NEWVALUE')[0].sourceId).toBe(id);
    expect(history.memory.vectorCounts().embedded).toBe(0); expect(history.contextCheckpoint(chat.id, history.conversation(chat.id).messages)).toBeUndefined();
    history.memory.remove(id); expect(history.sources.search(chat.id, 'NEWVALUE')).toEqual([]);
    expect(history.memory.db.prepare('SELECT count(*) AS n FROM knowledge_chunks').get()?.n).toBe(0);
    expect(history.conversation(chat.id).messages[0].text).toBe('Keep the original question');
  });
  it('diversifies and deduplicates combined ranks without returning irrelevant extra copies', () => {
    const passage = (sourceId: string, position: number, text: string) => ({ sourceId, position, text, title: sourceId, url: null, citation: sourceId, score: 1 });
    const rows = [passage('a', 0, 'same text'), passage('a', 1, 'second'), passage('a', 2, 'third'), passage('b', 0, 'same text'), passage('c', 0, 'different')];
    expect(fusePassages(rows, [rows[4]], 8).map(row => row.sourceId)).toEqual(['c', 'a', 'a']);
  });
  it('preserves independent contradictory evidence with attribution and versions rather than silently merging it', () => {
    const history = store(); const project = history.createProject('A', ''); const chat = history.createConversation(project.id);
    const first = history.memory.saveMemory({ projectId: project.id, title: 'Finance draft', text: 'BLUEBIRD budget is 100 dollars.', enabled: true });
    const second = history.memory.saveMemory({ projectId: project.id, title: 'Engineering proposal', text: 'BLUEBIRD budget is 200 dollars.', enabled: true });
    const hits = history.sources.search(chat.id, 'BLUEBIRD budget');
    expect(new Set(hits.map(hit => hit.sourceId))).toEqual(new Set([first.id, second.id]));
    expect(hits.every(hit => hit.updatedAt && hit.version && hit.citation.includes(hit.sourceId))).toBe(true);
    expect(new Set(hits.map(hit => hit.version)).size).toBe(2);
  });
});

describe('incremental Project indexing', () => {
  it('indexes granted folders without setup, uses saved memories by default and preserves explicit opt-outs on restart', async () => {
    const root = await folder(); await writeFile(join(root, 'policy.md'), 'AUTOMATIC_POLICY_62891');
    const path = join(root, 'library.sqlite'), history = store(path);
    const project = history.createProject('Automatic', '', false, root), chat = history.createConversation(project.id);
    expect(history.memory.preference('personal')).toBe(true);
    const personal = history.memory.saveMemory({ projectId: null, title: 'Preference', text: 'AUTOMATIC_PREFERENCE_3827', enabled: true });
    expect(history.sources.search(chat.id, 'AUTOMATIC_PREFERENCE_3827')[0].sourceId).toBe(personal.id);
    expect(history.memory.indexes().find(index => index.projectId === project.id)?.enabled).toBe(true);
    const index = new MemoryIndexer(history, () => true, () => {}); indexers.push(index); index.start();
    await vi.waitFor(() => expect(history.sources.search(chat.id, 'AUTOMATIC_POLICY_62891')[0]?.text).toContain('AUTOMATIC_POLICY_62891'));
    await index.configure(project.id, 'disable'); history.memory.setPreference('personal', false);
    history.setProjectFolder(project.id, root); // Selecting the same folder must not reset a pause.
    expect(history.memory.indexes().find(index => index.projectId === project.id)?.enabled).toBe(false);
    await index.configure(project.id, 'forget'); await index.shutdown();
    history.close(); stores.delete(history);
    const reopened = store(path);
    expect(reopened.memory.preference('personal')).toBe(false);
    expect(reopened.memory.indexes().find(index => index.projectId === project.id)?.enabled).toBe(false);
    expect(reopened.memory.documents()).toEqual([]);
    expect(reopened.sources.search(chat.id, 'AUTOMATIC_PREFERENCE_3827')).toEqual([]);
  });
  it('initializes previously unconfigured granted folders and starts new folder grants automatically', async () => {
    const root = await folder(), path = join(root, 'library.sqlite'), history = store(path);
    const project = history.createProject('Existing', '', false, root);
    history.memory.db.prepare('DELETE FROM project_indexes WHERE project_id=?').run(project.id); // Previous release: no setup performed.
    history.close(); stores.delete(history);
    const reopened = store(path);
    expect(reopened.memory.indexes().find(index => index.projectId === project.id)?.enabled).toBe(true);
    const empty = reopened.createProject('No folder', '');
    expect(reopened.memory.indexes().find(index => index.projectId === empty.id)?.enabled).toBe(false);
    reopened.setProjectFolder(empty.id, root);
    expect(reopened.memory.indexes().find(index => index.projectId === empty.id)?.enabled).toBe(true);
    reopened.setProjectFolder(empty.id, null);
    expect(reopened.memory.indexes().find(index => index.projectId === empty.id)?.enabled).toBe(false);
  });
  it('handles edits, moves, deletes, ignored/sensitive/generated files, links, pause and durable forgetting', async () => {
    const root = await folder(); const outside = await folder();
    await mkdir(join(root, 'node_modules')); await mkdir(join(root, 'private')); await writeFile(join(root, '.gitignore'), 'private/\nignored.md\n');
    await writeFile(join(root, 'brief.md'), '# Brief\nBLUEBIRD old release Friday'); await writeFile(join(root, '.env'), 'BLUEBIRD password'); await writeFile(join(root, 'node_modules', 'dependency.md'), 'BLUEBIRD dependency'); await writeFile(join(root, 'ignored.md'), 'BLUEBIRD ignored'); await writeFile(join(root, 'private', 'hidden.md'), 'BLUEBIRD private');
    await writeFile(join(outside, 'escape.md'), 'BLUEBIRD outside'); await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const history = store(); const project = history.createProject('A', '', false, root); const chat = history.createConversation(project.id);
    const index = new MemoryIndexer(history, () => true, () => {}); indexers.push(index);
    await index.configure(project.id, 'enable');
    expect(history.memory.documents().map(doc => doc.title)).toEqual(['brief.md']); const id = history.memory.documents()[0].id;
    expect(history.sources.search(chat.id, 'BLUEBIRD')[0].sourceId).toBe(id);
    await writeFile(join(root, 'brief.md'), '# Brief\nBLUEBIRD new release Monday'); await index.refresh(project.id);
    expect(history.memory.documents()[0].id).toBe(id); expect(history.sources.detail(chat.id, id).text).toContain('Monday');
    await rename(join(root, 'brief.md'), join(root, 'renamed.md')); await index.refresh(project.id);
    expect(history.memory.documents().map(doc => doc.title)).toEqual(['renamed.md']); expect(() => history.sources.detail(chat.id, id)).toThrow('Source not found');
    const renamed = history.memory.documents()[0].id; history.memory.remove(renamed); await index.refresh(project.id);
    expect(history.memory.documents()).toEqual([]); expect(history.sources.search(chat.id, 'BLUEBIRD')).toEqual([]);
    await index.configure(project.id, 'forget'); await index.configure(project.id, 'enable'); expect(history.memory.documents()).toHaveLength(1);
    await index.configure(project.id, 'disable'); expect(history.sources.search(chat.id, 'BLUEBIRD')).toEqual([]);
    await index.configure(project.id, 'enable'); await rm(join(root, 'renamed.md')); await index.refresh(project.id); expect(history.memory.documents()).toEqual([]);
  });
  it('indexes a newly granted replacement folder automatically and pauses when reads are blocked', async () => {
    const root = await folder(); const replacement = await folder(); await writeFile(join(root, 'brief.md'), 'ALPHA secret'); await writeFile(join(replacement, 'brief.md'), 'BETA secret');
    const history = store(); const project = history.createProject('A', '', false, root); const chat = history.createConversation(project.id); let allowed = false;
    const index = new MemoryIndexer(history, () => allowed, () => {}); indexers.push(index); await index.configure(project.id, 'enable');
    expect(history.memory.documents()).toEqual([]); expect(history.memory.indexes()[0].status).toBe('paused'); allowed = true; await index.refresh(project.id); expect(history.memory.documents()).toHaveLength(1);
    history.setProjectFolder(project.id, replacement); await index.refresh(project.id);
    expect(history.memory.documents()).toHaveLength(1); expect(history.sources.search(chat.id, 'ALPHA')).toEqual([]); expect(history.sources.search(chat.id, 'BETA')[0].text).toContain('BETA'); expect(history.memory.indexes()[0].enabled).toBe(true);
  });
});

describe('retrieval integration and lifecycle', () => {
  it('starts bundled retrieval despite an old opt-out and automatically recovers a failed worker', async () => {
    vi.useFakeTimers();
    const history = store(); history.memory.setPreference('semantic', false);
    let fail = true;
    const load = vi.fn(async () => { if (fail) throw new Error('Worker unavailable'); });
    const index = vi.fn(async () => 0);
    const runtime: EmbeddingRuntime = { load, index, embed: vi.fn(), close: vi.fn() };
    const service = new MemoryService(history, runtime, () => true, () => {});
    try {
      service.start(); service.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledExactlyOnceWith(false);
      expect(service.snapshot().semantic).toMatchObject({ enabled: true, status: 'error' });
      fail = false;
      await vi.advanceTimersByTimeAsync(30000);
      expect(load).toHaveBeenCalledTimes(2);
      expect(service.snapshot().semantic.status).toBe('ready');
      expect(index).toHaveBeenCalled();
      await service.shutdown();
      await vi.advanceTimersByTimeAsync(60000);
      expect(load).toHaveBeenCalledTimes(2);
    } finally { await service.shutdown(); vi.useRealTimers(); }
  });
  it('continues lexical retrieval when the local model fails to load, without downloading implicitly', async () => {
    const history = store(); const chat = history.createConversation(null); const source = history.sources.add(chat.id, { kind: 'page', title: 'Evidence', text: 'BLUEBIRD source remains available.' });
    const load = vi.fn(async () => { throw new Error('Offline'); });
    const runtime: EmbeddingRuntime = { load, embed: vi.fn(), close: vi.fn() }; const service = new MemoryService(history, runtime, () => true, () => {});
    await service.initialize(); expect(load).toHaveBeenCalledWith(false); expect(service.snapshot().semantic.status).toBe('error');
    expect((await service.search(chat.id, 'BLUEBIRD'))[0].sourceId).toBe(source.id); await service.shutdown();
  });
  it('injects eligible memories into the real Chat input and honors read denial', async () => {
    const history = store(); const project = history.createProject('A', ''); const chat = history.createConversation(project.id);
    const memory = history.memory.saveMemory({ projectId: project.id, title: 'Launch', text: 'BLUEBIRD release Monday.', enabled: true });
    let settings = { ...defaultSettings, route: 'local' as const, local: { ...defaultSettings.local, model: 'fixture' } }; const inputs: string[] = [];
    const runtime: EmbeddingRuntime = { load: async () => {}, embed: async () => [vector()], close() {} };
    const retrieval = new MemoryService(history, runtime, () => settings.toolPermissions.read !== 'deny', () => {});
    const service = new ChatService(history, () => settings, () => undefined, { async run(input, _signal, delta) { inputs.push(input.instructions); delta('Answer'); } }, () => {}, undefined, retrieval);
    service.start(chat.id, 'When is BLUEBIRD released?'); await vi.waitFor(() => expect(service.isActive(chat.id)).toBe(false)); expect(inputs[0]).toContain(`tinygpt-source:${memory.id}`);
    settings = { ...settings, toolPermissions: { ...settings.toolPermissions, read: 'deny' } }; service.start(chat.id, 'When is BLUEBIRD released?'); await vi.waitFor(() => expect(service.isActive(chat.id)).toBe(false)); expect(inputs[1]).not.toContain(`tinygpt-source:${memory.id}`); await retrieval.shutdown();
  });
  it('falls back after model failure, rechecks permissions after an async query and shuts down without touching a closed database', async () => {
    const history = store(); const chat = history.createConversation(null); history.memory.setPreference('personal', true); history.memory.saveMemory({ projectId: null, title: 'Fact', text: 'BLUEBIRD release Monday', enabled: true });
    let allowed = true; let finish!: (vectors: number[][]) => void;
    const runtime: EmbeddingRuntime = { load: async () => {}, embed: texts => texts[0].includes('release Monday') ? Promise.resolve([vector()]) : new Promise(resolve => { finish = resolve; }), close: vi.fn() };
    const service = new MemoryService(history, runtime, () => allowed, () => {}); await service.initialize();
    const search = service.search(chat.id, 'BLUEBIRD'); await Promise.resolve(); allowed = false; finish([vector()]); expect(await search).toEqual([]);
    await service.shutdown(); history.close(); stores.delete(history); expect(await service.search(chat.id, 'BLUEBIRD')).toEqual([]);
  });
});
