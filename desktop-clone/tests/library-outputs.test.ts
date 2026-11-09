import { describe, expect, it } from 'vitest';
import { libraryOutputs, outputCategory, type OutputActivity } from '../src/core/library-outputs';
const projectId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const activity = (path: string, overrides: Partial<OutputActivity> = {}): OutputActivity => ({ id: 'tool', conversationId: 'chat', conversationTitle: 'A saved chat', conversationProjectId: projectId, runId: 'run', name: 'write_project_file', status: 'success', result: JSON.stringify({ path }), summary: '', createdAt: 1, ...overrides });
describe('output library', () => {
  it('retains managed output scope after moving into a Project and isolates identical chat filenames', () => {
    const generated = (conversationId: string) => activity('overview.md', { conversationId, result: JSON.stringify({ artifact: { kind: 'generated-file', path: 'overview.md', conversationId } }) });
    const rows = libraryOutputs([generated('chat'), generated('other'), activity('overview.md')], [{ id: projectId, name: 'Design' }]);
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.generated)).toHaveLength(2);
    expect(rows.filter(row => row.generated).every(row => row.projectId === undefined && row.projectName === undefined)).toBe(true);
    expect(rows.find(row => !row.generated)?.projectId).toBe(projectId);
  });
  it('classifies documents, sites, images, and other outputs', () => {
    for (const path of ['plan.md', 'plan.DOCX', 'plan.pdf', 'notes.txt']) expect(outputCategory(path)).toBe('pages');
    for (const path of ['index.html', 'landing.HTM']) expect(outputCategory(path)).toBe('sites');
    for (const path of ['hero.PNG', 'icon.svg', 'animation.gif', 'photo.avif']) expect(outputCategory(path)).toBe('images');
    expect(outputCategory('budget.xlsx')).toBe('files');
  });
  it('keeps the latest successful write across chats in a project and separates other projects', () => {
    const rows = libraryOutputs([activity('docs\\plan.md'), activity('docs/plan.md', { conversationId: 'new-chat', createdAt: 4 }), activity('docs/plan.md', { status: 'error', createdAt: 5 }), activity('docs/plan.md', { conversationProjectId: 'other-project', createdAt: 2 })], [{ id: projectId, name: 'Design' }]);
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ path: 'docs/plan.md', conversationId: 'new-chat', updatedAt: 4, projectName: 'Design' });
  });
  it('ignores inputs, failed writes and escaping paths, and preserves explicit artifact ownership', () => {
    const rows = libraryOutputs([activity('input.md', { name: 'read_project_file' }), activity('../secret.md'), activity('fail.md', { status: 'denied' }), activity('ignored', { conversationProjectId: 'moved-project', name: 'code_write', result: JSON.stringify({ artifact: { kind: 'project-file', path: 'hero.svg', projectId } }) })], []);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ name: 'hero.svg', projectId, category: 'images' });
  });
});
