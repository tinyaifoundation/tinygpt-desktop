import { createdFiles } from './created-files';
import type { ToolActivity } from '../shared/tools';
import type { LibraryOutput, OutputCategory } from '../shared/outputs';

export type OutputActivity = ToolActivity & { conversationTitle: string; conversationProjectId: string | null };
export function outputCategory(path: string): OutputCategory {
  const extension = path.split('.').at(-1)?.toLowerCase();
  if (/^(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/.test(extension ?? '')) return 'images';
  if (/^(html?|xhtml)$/.test(extension ?? '')) return 'sites';
  if (/^(mdx?|txt|pdf|docx|odt|rtf)$/.test(extension ?? '')) return 'pages';
  return 'files';
}
export function libraryOutputs(activities: OutputActivity[], projects: { id: string; name: string }[]): LibraryOutput[] {
  const outputs = new Map<string, LibraryOutput>();
  // Activities arrive oldest first so the latest successful write owns the row.
  for (const activity of activities) for (const file of createdFiles([activity])) {
    const projectId = file.generated ? undefined : file.projectId ?? activity.conversationProjectId ?? undefined;
    const path = file.path.replace(/\\/g, '/');
    const id = `${projectId ?? activity.conversationId}:${path}`;
    outputs.set(id, { ...file, id, path, category: outputCategory(path), projectId,
      projectName: projects.find(project => project.id === projectId)?.name,
      conversationId: activity.conversationId, conversationTitle: activity.conversationTitle, updatedAt: activity.createdAt });
  }
  return [...outputs.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}
