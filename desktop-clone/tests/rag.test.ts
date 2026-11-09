import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { RagIndex } from '../src/main/rag-index';
import { RagModels } from '../src/main/rag-model-runtime';

const vector = (axis = 0) => Array.from({ length: 384 }, (_, i) => i === axis ? 1 : 0);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-rag-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close());
  const index = new RagIndex(history.databasePath, join(root, 'vectors.sqlite')); cleanup.push(() => index.close());
  return { root, history, index };
}
describe('worker-owned native retrieval index', () => {
  it('keeps more than two chunks from a long source available to the reranker', async () => {
    const { history, index } = await fixture(); const chat = history.createConversation(null);
    const text = Array.from({ length: 8 }, (_, i) => `SHIPMENT ${i} ${String(i).repeat(1000)}`).join('\n');
    history.sources.add(chat.id, { kind: 'page', title: 'Long policy', text });
    expect(index.candidates({ conversationId: chat.id }, 'SHIPMENT').length).toBeGreaterThan(2);
  });
  it('filters scope before top K even when hundreds of out-of-scope vectors are closer', async () => {
    const { history, index } = await fixture(); const a = history.createProject('A', ''); const b = history.createProject('B', '');
    const eligible = history.memory.saveMemory({ projectId: a.id, title: 'Allowed', text: 'Production needs an approval.', enabled: true });
    for (let i = 0; i < 100; i++) history.memory.saveMemory({ projectId: b.id, title: 'Private', text: `Unrelated private fact ${i}`, enabled: true });
    for (const row of index.pending(200)) index.save(row, vector());
    expect(index.candidates({ projectId: a.id }, 'Who authorizes shipment?', vector()).map(hit => hit.sourceId)).toEqual([eligible.id]);
  });
  it('rejects stale inference, reused chunk IDs, edited results and forgotten data, and survives reopening', async () => {
    const { root, history, index } = await fixture(); const project = history.createProject('A', '');
    const saved = history.memory.saveMemory({ projectId: project.id, title: 'Fact', text: 'Original material.', enabled: true });
    const row = index.pending()[0]; index.save(row, vector()); const hits = index.candidates({ projectId: project.id }, 'Original', vector());
    history.memory.saveMemory({ ...saved, text: 'Corrected material.' }); index.save(row, vector());
    expect(index.eligible({ projectId: project.id }, hits)).toEqual([]);
    expect(index.candidates({ projectId: project.id }, 'Unmatched old question', vector())).toEqual([]);
    for (const pending of index.pending()) index.save(pending, vector());
    const reopened = new RagIndex(history.databasePath, join(root, 'vectors.sqlite'));
    try { expect(reopened.pending()).toEqual([]); expect(reopened.candidates({ projectId: project.id }, 'Paraphrase', vector())[0].text).toContain('Corrected'); } finally { reopened.close(); }
    history.memory.remove(saved.id); index.cleanup();
    expect(index.db.prepare('SELECT count(*) AS n FROM knowledge_vectors').get()!.n).toBe(0);
    expect(index.candidates({ projectId: project.id }, 'Paraphrase', vector())).toEqual([]);
  });
  it('rechecks personal opt-in and index pause after retrieval', async () => {
    const { history, index } = await fixture(); history.memory.setPreference('personal', true);
    history.memory.saveMemory({ projectId: null, title: 'Preference', text: 'Prefer short answers.', enabled: true });
    for (const row of index.pending()) index.save(row, vector());
    const hits = index.candidates({ projectId: null }, 'Concise replies', vector()); expect(hits).toHaveLength(1);
    history.memory.setPreference('personal', false);
    expect(index.eligible({ projectId: null }, hits)).toEqual([]);
  });
});
describe('bundled CPU models', () => {
  it('embeds paraphrases and applies the complete Ettin classification head offline', async () => {
    const models = new RagModels(); cleanup.push(() => models.close());
    await models.load(join(process.cwd(), 'runtimes', 'rag'));
    const vectors = await models.embed(['Release requires two maintainers to authorize production.', 'The office is open on Tuesday and Thursday.']);
    expect(vectors).toHaveLength(2); expect(vectors[0]).toHaveLength(384);
    const query = (await models.embed(['Who approves shipping?'], true))[0];
    const dot = (values: number[]) => values.reduce((sum, value, i) => sum + value * query[i], 0);
    expect(dot(vectors[0])).toBeGreaterThan(dot(vectors[1]));
    const passages = ["Venus is often called Earth's twin because of its similar size and proximity.", 'Mars, known for its reddish appearance, is often referred to as the Red Planet.', 'Jupiter, the largest planet in our solar system, has a prominent red spot.', 'Saturn, famous for its rings, is sometimes mistaken for the Red Planet.'].map((text, position) => ({ sourceId: String(position), title: 'Planet', text, position, url: null, citation: 'Planet' }));
    const hits = await models.rerank('Which planet is known as the Red Planet?', passages, Date.now() + 30000, () => false);
    expect(hits[0].sourceId).toBe('1');
    const office = ['Two maintainers must authorize production deployment.', 'The office opens at nine and closes at five.', 'Rail travel is reimbursed when employees submit a receipt.'].map((text, position) => ({ sourceId: String(position), title: 'Policy', text, position, url: null, citation: 'Policy' }));
    expect(await models.rerank('How do I bake sourdough bread?', office, Date.now() + 30000, () => false)).toEqual([]);
  }, 60000);
});
