import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { HistoryStore } from '../src/main/history';
import { WorkspaceGit } from '../src/main/workspace-git';

let directory: string | undefined; let history: HistoryStore | undefined;
async function setup() { directory = await realpath(await mkdtemp(join(tmpdir(), 'tinygpt-git-'))); const root = join(directory, 'project'); await mkdir(root); history = new HistoryStore(join(directory, 'history.sqlite')); const project = history.createProject('Git fixture', '', false, root); const chat = history.createConversation(project.id, 'code'); const service = new WorkspaceGit(history); const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' }); return { root, history, chat, project, service, git }; }
afterEach(async () => { history?.close(); history = undefined; if (directory) { const path = resolve(directory); if (dirname(path).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(path).startsWith('tinygpt-git-')) throw new Error('Unexpected fixture path'); await rm(path, { recursive: true, force: true }); directory = undefined; } });
describe('Git-backed workspace changes', () => {
  it('does not initialize on read, then reviews unborn files without staging implicitly', async () => {
    const { root, chat, service, git } = await setup();
    expect((await service.run({ action: 'state', conversationId: chat.id, scope: 'working' })).state?.initialized).toBe(false);
    await service.run({ action: 'init', conversationId: chat.id }); await writeFile(join(root, 'new.ts'), 'export const result = 42;\n');
    const state = (await service.run({ action: 'state', conversationId: chat.id, scope: 'working' })).state!;
    expect(state.files).toMatchObject([{ path: 'new.ts', additions: 1, deletions: 0, staged: false }]);
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'working', path: 'new.ts' })).diff).toMatchObject({ before: '', after: 'export const result = 42;\n' });
    expect(git('diff', '--cached', '--name-only')).toBe('');
    await service.run({ action: 'stage', conversationId: chat.id, path: 'new.ts' });
    expect((await service.run({ action: 'state', conversationId: chat.id, scope: 'staged' })).state?.files).toHaveLength(1);
    await service.run({ action: 'unstage', conversationId: chat.id, path: 'new.ts' }); expect(await readFile(join(root, 'new.ts'), 'utf8')).toContain('42'); expect(git('diff', '--cached', '--name-only')).toBe('');
  }, 30000);
  it('uses actual Git contents for combined, staged and last-commit diffs, including deleted directories and binary files', async () => {
    const { root, chat, service, git } = await setup();
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    await writeFile(join(root, 'edit.ts'), 'old\n'); await mkdir(join(root, 'gone')); await writeFile(join(root, 'gone', 'file.txt'), 'delete me\n'); await writeFile(join(root, 'rename.txt'), 'move me\n'); git('add', '.'); git('commit', '-m', 'Initial');
    await writeFile(join(root, 'edit.ts'), 'staged\n'); git('add', 'edit.ts'); await writeFile(join(root, 'edit.ts'), 'final\nextra\n');
    await rm(join(root, 'gone'), { recursive: true }); await rename(join(root, 'rename.txt'), join(root, 'renamed.txt')); git('add', 'rename.txt', 'renamed.txt'); await writeFile(join(root, 'binary.png'), Buffer.from([0, 1, 2]));
    const state = (await service.run({ action: 'state', conversationId: chat.id, scope: 'working' })).state!;
    expect(state.files.find(file => file.path === 'edit.ts')).toMatchObject({ additions: 2, deletions: 1, staged: true, unstaged: true });
    expect(state.files.find(file => file.path === 'gone/file.txt')).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(state.files.find(file => file.path === 'binary.png')).toMatchObject({ binary: true });
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'working', path: 'edit.ts' })).diff).toMatchObject({ before: 'old\n', after: 'final\nextra\n' });
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'staged', path: 'edit.ts' })).diff).toMatchObject({ before: 'old\n', after: 'staged\n' });
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'working', path: 'gone/file.txt' })).diff).toMatchObject({ before: 'delete me\n', after: '' });
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'working', path: 'renamed.txt' })).diff).toMatchObject({ before: 'move me\n', after: 'move me\n' });
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'working', path: 'binary.png' })).diff?.binary).toBe(true);
    await service.run({ action: 'stage', conversationId: chat.id, path: 'edit.ts' }); await service.run({ action: 'commit', conversationId: chat.id, message: 'Actual edit' });
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'last-commit', path: 'edit.ts' })).diff).toMatchObject({ before: 'old\n', after: 'final\nextra\n' });
  }, 30000);
  it('protects sensitive files and project boundaries, rejects active-project mutations, and does not manage the parent repository', async () => {
    const { root, chat, project, service, git } = await setup(); git('init');
    await writeFile(join(root, '.env'), 'SECRET=fixture'); await writeFile(join(root, 'visible.txt'), 'visible');
    expect((await service.run({ action: 'state', conversationId: chat.id, scope: 'working' })).state?.files.map(file => file.path)).toEqual(['visible.txt']);
    for (const path of ['.env', '.git/config', '../outside.txt', 'C:/outside.txt']) await expect(service.run({ action: 'stage', conversationId: chat.id, path })).rejects.toThrow();
    const guarded = new WorkspaceGit(history!, id => { expect(id).toBe(project.id); throw new Error('Project is running'); });
    await expect(guarded.run({ action: 'stage', conversationId: chat.id, path: 'visible.txt' })).rejects.toThrow('Project is running');
    expect((await guarded.run({ action: 'state', conversationId: chat.id, scope: 'working' })).state?.initialized).toBe(true);
    const nested = join(root, 'nested'); await mkdir(nested); const nestedProject = history!.createProject('Nested', '', false, nested); const nestedChat = history!.createConversation(nestedProject.id, 'code');
    expect((await service.run({ action: 'state', conversationId: nestedChat.id, scope: 'working' })).state).toMatchObject({ initialized: false, parentRepository: true });
    await expect(service.run({ action: 'commit', conversationId: nestedChat.id, message: 'Forbidden parent commit' })).rejects.toThrow('Initialize Git');
  }, 30000);
  it('shows the net working diff even when staged and unstaged edits cancel each other', async () => {
    const { root, chat, service, git } = await setup(); git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('config', 'core.autocrlf', 'false');
    await writeFile(join(root, 'same.txt'), 'original\n'); git('add', 'same.txt'); git('commit', '-m', 'Initial');
    await writeFile(join(root, 'same.txt'), 'staged edit\n'); git('add', 'same.txt'); await writeFile(join(root, 'same.txt'), 'original\n');
    expect((await service.run({ action: 'state', conversationId: chat.id, scope: 'working' })).state?.files).toHaveLength(0);
    expect((await service.run({ action: 'diff', conversationId: chat.id, scope: 'staged', path: 'same.txt' })).diff).toMatchObject({ before: 'original\n', after: 'staged edit\n' });
    await service.run({ action: 'unstage', conversationId: chat.id, path: 'same.txt' });
    expect((await service.run({ action: 'state', conversationId: chat.id, scope: 'staged' })).state?.files).toHaveLength(0);
  }, 30000);
});
