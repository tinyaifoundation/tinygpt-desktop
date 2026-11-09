import { describe, expect, it } from 'vitest';
import { citationIndex, collectCitations } from '../src/core/citations';
import { separateToolDisplay, toolDisplayText, toolApprovalText, toolProgressText } from '../src/shared/tool-display';
import { toolArguments } from '../src/shared/tools';
import { formatWorkDuration } from '../src/core/work-duration';
import type { SourceSummary, ToolActivity } from '../src/shared/tools';

function tool(name: ToolActivity['name'], value: unknown, status: ToolActivity['status'] = 'success'): ToolActivity {
  return { id: 'tool', conversationId: 'chat', runId: 'run', name, summary: '', status, result: JSON.stringify(value), createdAt: 1 };
}
const source: SourceSummary = { id: 'saved-source', conversationId: 'chat', projectId: null, kind: 'page', title: 'Read article', url: 'https://example.org/article', mime: 'text/html', size: 200, createdAt: 1, messageId: null };

describe('model display metadata', () => {
  it('keeps the latest status from narrated metadata and never renders its permission questions as progress', () => {
    const screenshot = 'Status: Fetching DevTools MCP tool list\n\nPermission: May I read the chrome-devtools-mcp README to catalog its concrete debugging tool categories?\n\nStatus: Extracting tool-design principles\n\nPermission: May I search the saved Anthropic article for its detailed guidance on tool responses and\nevaluations?';
    expect(toolProgressText(screenshot)).toBe('Extracting tool-design principles');
    expect(toolProgressText('Permission: May I read the file?')).toBe(''); expect(toolProgressText('May I read the file?')).toBe('');
    expect(toolProgressText('Comparing the two sources before writing the summary.')).toBe('Comparing the two sources before writing the summary.');
    expect(toolProgressText('**Status**: Reviewing the evidence\n**Permission**: May I read the brief?')).toBe('Reviewing the evidence');
    expect(toolProgressText('__tinygpt_status: Checking the inbox\n__tinygpt_approval: May I check your email?')).toBe('Checking the inbox');
  });
  it.each([[0, '0s'], [350, '0.4s'], [5200, '5.2s'], [12900, '13s'], [59999, '1m'], [62500, '1m 3s'], [120000, '2m']] as const)('formats %i ms as %s', (duration, label) => {
    expect(formatWorkDuration(duration)).toBe(label);
  });
  it('strips UI status before strict execution while preserving extra argument rejection', () => {
    const value = separateToolDisplay({ status: 'Reviewing the evidence', query: 'evidence' });
    expect(value).toEqual({ displayText: 'Reviewing the evidence', input: { query: 'evidence' } });
    expect(toolArguments.search_web.safeParse(value.input).success).toBe(true);
    expect(toolArguments.search_web.safeParse(separateToolDisplay({ status: 'Reading', query: 'test', bypass: true }).input).success).toBe(false);
  });
  it('uses plain short labels and falls back for invalid metadata', () => {
    expect(toolDisplayText('  Reviewing\n the evidence ')).toBe('Reviewing the evidence');
    for (const value of ['<script>', '**Reading**', 'x'.repeat(49), '', 123]) expect(toolDisplayText(value)).toBeUndefined();
    expect(separateToolDisplay({ query: 'test' }).input).toEqual({ query: 'test' });
  });
});
describe('citation sources', () => {
  it('includes search-only hits, deduplicates page reads, and preserves source numbering', () => {
    const tools = [tool('search_web', { results: [{ url: source.url, title: 'Search article', snippet: 'A searched snippet.' }, { url: 'https://second.org/', title: 'Second article' }] }), tool('read_page', { url: source.url, sourceId: source.id, text: 'Extracted evidence' })];
    const sources = collectCitations(tools, [source]);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ sourceId: source.id, domain: 'example.org', title: 'Read article', snippet: 'Extracted evidence' });
    expect(citationIndex(sources, source.url!)).toBe(0);
    expect(citationIndex(sources, `tinygpt-source:${source.id}`)).toBe(0);
    expect(citationIndex(sources, undefined, '[2]')).toBe(1);
    expect(citationIndex(sources, undefined, '99')).toBe(-1);
  });
  it('ignores denied results, malformed links, credentials, and unknown source IDs', () => {
    // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- Synthetic credential-bearing URL rejection fixture; no real credentials.
    const sources = collectCitations([tool('search_web', { results: [{ url: 'javascript:alert(1)' }, { url: 'https://key:secret@example.com' }, { sourceId: 'unknown' }, { url: 'https://valid.org' }] }), tool('read_page', { url: 'https://denied.org' }, 'denied')], []);
    expect(sources.map(item => item.url)).toEqual(['https://valid.org/']);
  });
  it('keeps local files local and resolves retrieved/attached source links', () => {
    const local = { ...source, kind: 'project-file' as const, url: 'project-file:brief.md', title: 'brief.md' };
    const sources = collectCitations([tool('search_sources', { passages: [{ sourceId: source.id, text: 'Local excerpt.' }] })], [local], `See [brief](tinygpt-source:${source.id})`);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ sourceId: local.id, url: undefined, domain: '', snippet: 'Local excerpt.' });
    expect(collectCitations([tool('read_project_file', { source: local, text: 'Read file evidence.' })], [local])[0]).toMatchObject({ sourceId: local.id, snippet: 'Read file evidence.' });
  });
});
it('separates model-authored permission questions from strict tool input', () => {
  expect(separateToolDisplay({ status: 'Saving the brief', permission: 'May I save your brief?', path: 'brief.md' })).toEqual({ displayText: 'Saving the brief', approvalText: 'May I save your brief?', input: { path: 'brief.md' } });
  expect(toolApprovalText('Allow all tools')).toBeUndefined(); expect(toolApprovalText('May I <script>change this</script>?')).toBeUndefined(); expect(toolApprovalText('May I ' + 'x'.repeat(250))).toBeUndefined();
});
