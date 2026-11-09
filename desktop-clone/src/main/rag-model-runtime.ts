import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyRagModel } from './embedding-model';
import type { PreTrainedModel, PreTrainedTokenizer } from '@huggingface/transformers';
import type { SourceExcerpt } from '../shared/tools';

/** Small published classification head; no Python or executable model code. */
async function weights(path: string): Promise<Record<string, Float32Array>> {
  const bytes = await readFile(path); const length = Number(bytes.readBigUInt64LE());
  if (length > bytes.length - 8) throw new Error('Invalid model head.');
  const header = JSON.parse(bytes.subarray(8, 8 + length).toString('utf8'));
  const result: Record<string, Float32Array> = {};
  for (const [name, value] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const tensor = value as { dtype: string; shape: number[]; data_offsets: number[] };
    if (tensor.dtype !== 'F32') throw new Error('Unsupported model head precision.');
    const [start, end] = tensor.data_offsets; const count = tensor.shape.reduce((n, dim) => n * dim, 1);
    if (end - start !== count * 4 || 8 + length + end > bytes.length) throw new Error('Invalid model head tensor.');
    result[name] = Float32Array.from({ length: count }, (_, i) => bytes.readFloatLE(8 + length + start + i * 4));
  }
  return result;
}
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
export class RagModels {
  private embedding?: { tokenizer: PreTrainedTokenizer; model: PreTrainedModel };
  private ranking?: { tokenizer: PreTrainedTokenizer; model: PreTrainedModel };
  private dense?: Float32Array;
  private norm?: Record<string, Float32Array>;
  private output?: Record<string, Float32Array>;
  async load(root: string): Promise<void> {
    if (this.embedding && this.ranking) return;
    const specifier = '@huggingface/transformers';
    const { env, AutoTokenizer, AutoModel } = await import(/* @vite-ignore */ specifier) as typeof import('@huggingface/transformers');
    env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = ''; env.useBrowserCache = false; env.useFSCache = false;
    const options = { device: 'cpu' as const, local_files_only: true, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } };
    const embedding = await verifyRagModel(root, 'embedding'); const ranking = await verifyRagModel(root, 'reranker');
    this.embedding = { tokenizer: await AutoTokenizer.from_pretrained(embedding, options), model: await AutoModel.from_pretrained(embedding, { ...options, dtype: 'q8' }) };
    // Published int8 exports flipped a relevant/contradictory pair in our fixture.
    // The 17M fp32 backbone is still small and keeps the original ranking quality.
    this.ranking = { tokenizer: await AutoTokenizer.from_pretrained(ranking, options), model: await AutoModel.from_pretrained(ranking, { ...options, dtype: 'fp32' }) };
    this.dense = (await weights(join(ranking, '2_Dense/model.safetensors')))['linear.weight'];
    this.norm = await weights(join(ranking, '3_LayerNorm/model.safetensors'));
    this.output = await weights(join(ranking, '4_Dense/model.safetensors'));
    if (this.dense?.length !== 256 * 256 || this.norm['norm.weight']?.length !== 256 || this.norm['norm.bias']?.length !== 256 || this.output['linear.weight']?.length !== 256) throw new Error('Invalid reranking head.');
  }
  async embed(texts: string[], query = false): Promise<number[][]> {
    if (!this.embedding) throw new Error('Retrieval model not loaded.');
    const { tokenizer, model } = this.embedding;
    const input = await tokenizer(texts.map(text => query ? `Represent this sentence for searching relevant passages: ${text}` : text), { padding: true, truncation: true, max_length: 512 });
    const result = await model(input); const tensor = result.last_hidden_state;
    // BGE uses normalized CLS pooling, not MiniLM's mean pooling.
    const vectors: number[][] = [];
    for (let b = 0; b < texts.length; b++) {
      const start = b * tensor.dims[1] * 384; const vector = Array.from(tensor.data.slice(start, start + 384)) as number[];
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      if (!norm || !Number.isFinite(norm)) throw new Error('Invalid embedding.');
      vectors.push(vector.map(value => value / norm));
    }
    return vectors;
  }
  private score(cls: ArrayLike<number>): number {
    const hidden = new Float64Array(256);
    for (let i = 0; i < 256; i++) {
      let value = 0; for (let j = 0; j < 256; j++) value += this.dense![i * 256 + j] * cls[j];
      hidden[i] = value * 0.5 * (1 + erf(value / Math.SQRT2));
    }
    const mean = hidden.reduce((sum, value) => sum + value, 0) / 256;
    const deviation = Math.sqrt(hidden.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 256 + 1e-5);
    let score = this.output!['linear.bias']?.[0] ?? 0;
    for (let i = 0; i < 256; i++) score += ((hidden[i] - mean) / deviation * this.norm!['norm.weight'][i] + this.norm!['norm.bias'][i]) * this.output!['linear.weight'][i];
    if (!Number.isFinite(score)) throw new Error('Invalid reranking score.'); return score;
  }
  async rerank(query: string, hits: SourceExcerpt[], deadline: number, cancelled: () => boolean): Promise<SourceExcerpt[]> {
    if (!this.ranking || !hits.length) return hits;
    const ranked: { hit: SourceExcerpt; score: number; order: number }[] = [];
    for (let i = 0; i < hits.length; i += 2) {
      if (cancelled()) throw new Error('Retrieval cancelled.');
      if (Date.now() >= deadline) throw new Error('Reranking timed out.');
      const batch = hits.slice(i, i + 2);
      const input = await this.ranking.tokenizer(batch.map(() => query), { text_pair: batch.map(hit => hit.text), padding: true, truncation: true, max_length: 512 });
      const result = await this.ranking.model(input); const tensor = result.last_hidden_state;
      batch.forEach((hit, b) => ranked.push({ hit, score: this.score(tensor.data.slice(b * tensor.dims[1] * 256, b * tensor.dims[1] * 256 + 256)), order: i + b }));
    }
    // Initial signed-score relevance floor, checked on positive/negative fixtures.
    // Raw scores are not calibrated probabilities; broader quality evaluation is
    // still needed. KNN alone would always return unrelated nearest neighbors.
    return ranked.filter(row => row.score >= 0).sort((a, b) => b.score - a.score || a.order - b.order).map(row => row.hit);
  }
  async close(): Promise<void> { await this.embedding?.model.dispose(); await this.ranking?.model.dispose(); this.embedding = undefined; this.ranking = undefined; }
}
