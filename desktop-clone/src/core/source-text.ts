export function sourceChunks(text: string, size = 1600): { position: number; text: string }[] {
  if (!Number.isInteger(size) || size <= 180) throw new RangeError('Chunk size must exceed the 180-character overlap.');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  const chunks: { position: number; text: string }[] = [];
  // Ingestion bounds document size. A second chunk-count cap silently loses
  // accepted document tails, particularly with overlap and newline boundaries.
  for (let start = 0; start < normalized.length; ) {
    let end = Math.min(start + size, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf('\n', end);
      if (boundary > start + size / 2) end = boundary;
    }
    chunks.push({ position: chunks.length, text: normalized.slice(start, end).trim() });
    if (end === normalized.length) break;
    start = Math.max(start + 1, end - 180);
  }
  return chunks;
}
export function retrievalQuery(query: string): string {
  const stop = new Set(['the', 'this', 'that', 'what', 'when', 'where', 'with', 'from', 'about', 'please', 'could', 'would', 'should', 'have', 'does', 'which', 'into', 'your', 'their', 'there', 'these']);
  const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter(term => !stop.has(term)))].slice(0, 16);
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}
