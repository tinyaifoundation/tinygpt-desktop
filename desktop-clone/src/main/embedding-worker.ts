import { setPriority, constants } from 'node:os';
import { join } from 'node:path';
import { RagModels } from './rag-model-runtime';
import { RagIndex, type RagScope } from './rag-index';
import { fusePassages } from '../core/hybrid-retrieval';

const port = process.parentPort!;
const models = new RagModels();
let index: RagIndex | undefined;
type Request = { id: number; type: 'load' | 'embed' | 'index' | 'search' | 'cancel'; cacheDir: string; libraryPath: string; modelRoot: string; texts?: string[]; scope?: RagScope; query?: string; limit?: number; semantic?: boolean; deadline?: number };
const queue: Request[] = []; const cancelled = new Set<number>(); let running = false;
let activeId: number | undefined; let lastCleanup = 0;
try { setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Host may restrict priority changes. */ }
async function drain() {
  if (running) return; running = true;
  while (queue.length) {
    const input = queue.shift()!;
    activeId = input.id;
    try {
      if (cancelled.has(input.id)) continue;
      index ??= new RagIndex(input.libraryPath, join(input.cacheDir, 'vectors.sqlite'));
      let value: unknown;
      if (input.type === 'load') await models.load(input.modelRoot);
      else if (input.type === 'embed') value = await models.embed(input.texts!);
      else if (input.type === 'index') {
        if (Date.now() - lastCleanup > 10000) { index.cleanup(); lastCleanup = Date.now(); }
        const rows = index.pending();
        for (const kind of ['knowledge', 'source']) {
          const batch = rows.filter(row => row.kind === kind); if (!batch.length) continue;
          const vectors = await models.embed(batch.map(row => row.text)); batch.forEach((row, i) => index!.save(row, vectors[i]));
        }
        value = rows.length;
      } else if (input.type === 'search') {
        const deadline = Math.min(input.deadline ?? Date.now() + 4500, Date.now() + 4500);
        const vector = input.semantic ? (await models.embed([input.query!.slice(0, 1500)], true))[0] : undefined;
        const hits = index.candidates(input.scope!, input.query!, vector);
        let ranked = hits;
        if (input.semantic) {
          try { ranked = await models.rerank(input.query!.slice(0, 1500), hits, deadline, () => cancelled.has(input.id)); }
          catch {
            if (cancelled.has(input.id)) throw new Error('Retrieval cancelled.');
            ranked = index.candidates(input.scope!, input.query!);
          }
        }
        value = index.eligible(input.scope!, fusePassages(ranked.map((hit, i) => ({ ...hit, score: i })), [], input.limit ?? 8));
      }
      if (!cancelled.has(input.id)) port.postMessage({ id: input.id, ok: true, value });
    } catch (error) { port.postMessage({ id: input.id, ok: false, diagnostic: error instanceof Error ? error.message : 'Local retrieval failed.' }); }
    finally { cancelled.delete(input.id); activeId = undefined; }
  }
  running = false;
}
port.on('message', event => {
  const input = event.data as Request;
  if (input.type === 'cancel') { if (activeId === input.id || queue.some(item => item.id === input.id)) cancelled.add(input.id); return; }
  if (input.type === 'index') queue.push(input); else {
    const position = queue.findIndex(item => item.type === 'index');
    if (position < 0) queue.push(input); else queue.splice(position, 0, input);
  }
  void drain();
});
port.postMessage({ ready: true });
