import type { SourceExcerpt } from '../shared/tools';

export interface RankedPassage extends SourceExcerpt { score: number }
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
/** Reciprocal rank fusion, then bounded diversity. Only eligible rows may enter. */
export function fusePassages(lexical: RankedPassage[], semantic: RankedPassage[], limit: number, maxPerSource = 2): SourceExcerpt[] {
  const ranked = new Map<string, RankedPassage>();
  for (const rows of [lexical, semantic]) rows.forEach((row, index) => {
    const key = `${row.sourceId}:${row.position}`;
    const previous = ranked.get(key);
    ranked.set(key, { ...row, score: (previous?.score ?? 0) + 1 / (30 + index + 1) });
  });
  const counts = new Map<string, number>(); const duplicateText = new Set<string>();
  const result: SourceExcerpt[] = [];
  for (const { score: _score, ...row } of [...ranked.values()].sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.position - b.position)) {
    const count = counts.get(row.sourceId) ?? 0;
    const key = row.text.replace(/\s+/g, ' ').trim();
    if (count >= maxPerSource || duplicateText.has(key)) continue;
    counts.set(row.sourceId, count + 1); duplicateText.add(key); result.push({ ...row, text: row.text.slice(0, 1600) });
    if (result.length >= limit) break;
  }
  return result;
}
