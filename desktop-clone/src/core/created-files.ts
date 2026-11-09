import type { ToolActivity } from '../shared/tools';
export interface CreatedFile { path: string; name: string; type: string; projectId?: string; generated?: boolean }
export function createdFiles(tools: ToolActivity[]): CreatedFile[] {
  const files = new Map<string, CreatedFile>();
  for (const tool of tools) {
    if (tool.status !== 'success' || !tool.result) continue;
    try {
      const result = JSON.parse(tool.result);
      // Recognize durable write outcomes, never links or file names invented in
      // prose. Extension tools may explicitly return a Project-file artifact.
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [result.artifact ?? (tool.name === 'write_project_file' ? {kind:'project-file',path:result.path} : null)];
      for (const artifact of artifacts) {
      if (!['project-file', 'generated-file'].includes(artifact?.kind)) continue;
      if (artifact.kind === 'generated-file' && artifact.conversationId !== tool.conversationId) continue;
      const path = artifact.path;
      if (typeof path !== 'string' || !path || path.length > 2048 || /:|^[\\/]|[\x00-\x1f]/i.test(path) || path.split(/[\\/]/).some(part => part === '..')) continue;
      const name = path.split(/[\\/]/).at(-1)!; const extension = name.split('.').at(-1)?.toLowerCase();
      const type = ({ md: 'Markdown', mdx: 'Markdown', txt: 'Text', pdf: 'PDF', xlsx: 'Excel', csv: 'CSV', docx: 'Word', pptx: 'PowerPoint', png: 'Image', jpg: 'Image', jpeg: 'Image', webp: 'Image' } as Record<string, string>)[extension ?? ''] ?? 'File';
      const projectId = typeof artifact?.projectId === 'string' && /^[a-f0-9-]{36}$/i.test(artifact.projectId) ? artifact.projectId : undefined;
      files.set((artifact.kind === 'generated-file' ? 'generated:' : 'project:') + (projectId ?? '') + ':' + path.replace(/\\/g, '/'), { path, name, type, projectId, ...(artifact.kind === 'generated-file' ? { generated: true } : {}) });
      }
    } catch { /* A failed/malformed result is not a created file. */ }
  }
  return [...files.values()];
}
