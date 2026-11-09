import { describe, expect, it } from 'vitest';
import { canRetrieve } from '../src/core/retrieval';
import type { MemorySource, RetrievalContext } from '../src/shared/projects';

const context: RetrievalContext = { projectId: 'project-a', linkedProjectIds: [], includeGlobalMemory: true };
const source: MemorySource = { id: 'source', scope: { type: 'project', projectId: 'project-a' }, origin: 'file', enabled: true, deleted: false };

describe('shared memory project boundaries', () => {
  it('allows sources inside the current project', () => expect(canRetrieve(source, context)).toBe(true));
  it('excludes another project before ranking', () => expect(canRetrieve({ ...source, scope: { type: 'project', projectId: 'project-b' } }, context)).toBe(false));
  it('permits an explicitly linked project', () => expect(canRetrieve(source, { ...context, projectId: 'project-b', linkedProjectIds: ['project-a'] })).toBe(true));
  it('does not expose project memories in an unscoped session', () => expect(canRetrieve(source, { ...context, projectId: null })).toBe(false));
  it('can include shared global memory in a project', () => expect(canRetrieve({ ...source, scope: { type: 'global' } }, context)).toBe(true));
  it('honors disabling global memory for a context', () => expect(canRetrieve({ ...source, scope: { type: 'global' } }, { ...context, includeGlobalMemory: false })).toBe(false));
  it('excludes a deleted source even from an explicitly linked project', () => expect(canRetrieve({ ...source, deleted: true }, context)).toBe(false));
  it('excludes sources disabled by the user', () => expect(canRetrieve({ ...source, enabled: false }, context)).toBe(false));
});
