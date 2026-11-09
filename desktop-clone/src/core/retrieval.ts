import type { MemorySource, RetrievalContext } from '../shared/projects';

// Apply scope eligibility before lexical/vector scoring so another project's
// data cannot enter prompts through a highly ranked retrieval result.
// This is an eligibility gate, not an implemented retrieval/search engine.
export function canRetrieve(source: MemorySource, context: RetrievalContext): boolean {
  if (source.deleted || !source.enabled) return false;
  if (source.scope.type === 'global') return context.includeGlobalMemory;
  return source.scope.projectId === context.projectId
    || context.linkedProjectIds.includes(source.scope.projectId);
}
