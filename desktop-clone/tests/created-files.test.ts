import { describe, expect, it } from 'vitest';
import { createdFiles } from '../src/core/created-files';
import type { ToolActivity } from '../src/shared/tools';
const tool = (result: unknown, status: ToolActivity['status'] = 'success', name: ToolActivity['name'] = 'write_project_file'): ToolActivity => ({ id: 'tool', conversationId: 'chat', runId: 'run', name, status, result: JSON.stringify(result), createdAt: 0, summary: '' });
describe('generated file outcomes', () => {
  it('keeps managed artifacts distinct and rejects ownership belonging to another chat', () => {
    const artifact = { kind: 'generated-file', path: 'overview.md', conversationId: 'chat' };
    const rows = createdFiles([tool({ artifact }), tool({ artifact }), tool({ artifact: { ...artifact, conversationId: 'other' } }), tool({ artifact: { kind: 'project-file', path: 'overview.md', projectId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' } })]);
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ generated: true, path: 'overview.md', projectId: undefined });
    expect(rows[1].projectId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
  });
  it('shows every file in a native multi-file patch without duplicate cards', () => {
    const artifact = {kind:'project-file',path:'a.js'};
    expect(createdFiles([tool({artifact,artifacts:[artifact,{kind:'project-file',path:'b.css'}]},'success','code_apply_patch')]).map(file=>file.path)).toEqual(['a.js','b.css']);
  });
  it('shows successful historical writes and explicit plugin artifacts, deduplicating repeated writes', () => {
    expect(createdFiles([tool({ path: 'docs/TOOL_IDEAS.md', bytes: 100 }), tool({ path: 'docs/TOOL_IDEAS.md', bytes: 101 }), tool({ artifact: { kind: 'project-file', path: 'plan.xlsx', projectId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' } }, 'success', 'ext_fixture')])).toEqual([
      { path: 'docs/TOOL_IDEAS.md', name: 'TOOL_IDEAS.md', type: 'Markdown', projectId: undefined },
      { path: 'plan.xlsx', name: 'plan.xlsx', type: 'Excel', projectId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
    ]);
  });
  it('does not turn failed writes, read results, malformed paths, or remote connector files into local file cards', () => {
    expect(createdFiles([tool({ path: 'a.md' }, 'error'), tool({ path: 'b.md' }, 'success', 'read_project_file'), tool({ path: '../secret.txt' }), tool({ path: 'C:\\secret.txt' }), tool({ path: 'https://example.org/file' }), tool({ path: 'remote.md' }, 'success', 'ext_fixture')])).toEqual([]);
  });
});
