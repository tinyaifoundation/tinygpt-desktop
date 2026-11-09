import type { SourceSummary, ToolActivity } from '../shared/tools';

import type { CitationSource } from '../shared/citations';
export type { CitationSource } from '../shared/citations';

export function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function sourceDomain(url?: string): string {
  try { return new URL(url!).hostname.replace(/^www\./, ''); } catch { return ''; }
}
export function toolResult(tool: ToolActivity): Record<string, unknown> {
  try { const value: unknown = JSON.parse(tool.result ?? ''); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}
function text(value: unknown, max: number): string { return typeof value === 'string' ? value.slice(0, max) : ''; }

/** Only actual tool results and saved, scoped sources become citation targets. */
export function collectCitations(tools: readonly ToolActivity[], sources: readonly SourceSummary[], answer = ''): CitationSource[] {
  const found = new Map<string, CitationSource>();
  const saved = new Map(sources.map(source => [source.id, source]));
  function add(row: Record<string, unknown>) {
    const source = typeof row.sourceId === 'string' ? saved.get(row.sourceId) : undefined;
    const url = sourceUrl(row.url) ?? sourceUrl(source?.url);
    if (!source && !url) return;
    const key = url ?? `tinygpt-source:${source!.id}`;
    const previous = found.get(key);
    found.set(key, {
      key, sourceId: source?.id ?? previous?.sourceId, url, domain: sourceDomain(url),
      title: source?.title || text(row.title, 500) || previous?.title || sourceDomain(url),
      snippet: text(row.snippet, 600) || text(row.text, 600) || previous?.snippet || '',
    });
  }
  for (const tool of tools) {
    if (tool.status !== 'success') continue;
    const result = toolResult(tool);
    for (const key of ['results', 'passages']) {
      const rows = result[key];
      if (Array.isArray(rows)) for (const row of rows.slice(0, 50)) if (row && typeof row === 'object' && !Array.isArray(row)) add(row as Record<string, unknown>);
    }
    if (tool.name === 'read_page' || tool.name === 'read_project_file') {
      add(result);
      if (result.source && typeof result.source === 'object') {
        const nested = result.source as Record<string, unknown>;
        add({ ...nested, sourceId: nested.id, text: result.text });
      }
      // Older display logs can be truncated JSON; scoped saved sources remain usable.
      for (const source of sources) if (tool.result?.includes(source.id) || (tool.name === 'read_page' && source.url === tool.target)) add({ sourceId: source.id });
    }
  }
  for (const source of sources) if (answer.includes(`tinygpt-source:${source.id}`)) add({ sourceId: source.id });
  return [...found.values()];
}

export function citationIndex(sources: readonly CitationSource[], href?: string, label?: string): number {
  const byLink = sources.findIndex(source => href === source.key || (source.sourceId && href === `tinygpt-source:${source.sourceId}`) || (source.url && sourceUrl(href) === source.url));
  if (byLink >= 0) return byLink;
  const number = (label ?? '').trim().match(/^\[?(\d+)\]?$/);
  const index = number ? Number(number[1]) - 1 : -1;
  return index >= 0 && index < sources.length ? index : -1;
}
