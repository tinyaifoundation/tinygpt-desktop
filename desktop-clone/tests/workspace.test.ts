import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { CodeFiles } from '../src/main/code-files';
import { ProjectFiles } from '../src/main/files';
import { WorkspaceFiles } from '../src/main/workspace-files';
import { acquireFileWrites } from '../src/main/file-write-locks';
import { browserRequestSchema, browserLayoutSchema, browserScrollRequestSchema } from '../src/shared/workspace';
import { workspaceAddress } from '../src/core/workspace-address';
const { picker, clipboardText, trash } = vi.hoisted(() => ({ picker: vi.fn(), clipboardText: vi.fn(), trash: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showOpenDialog: picker }, clipboard: { writeText: clipboardText }, shell: { showItemInFolder: vi.fn(), trashItem: trash } }));
let store: HistoryStore | undefined; let directory: string | undefined;
async function setup() { directory = await realpath(await mkdtemp(join(tmpdir(), 'tinygpt-workspace-'))); store = new HistoryStore(join(directory, 'library.sqlite')); const project = store.createProject('Files', '', false, directory); const chat = store.createConversation(project.id); const files = new WorkspaceFiles(store, () => ({}) as never); await writeFile(join(directory, 'note.md'), '# Original\n'); return { directory, store, chat, files }; }
afterEach(async () => { store?.close(); store = undefined; picker.mockReset(); if (directory) { const path = resolve(directory); if (dirname(path).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(path).startsWith('tinygpt-workspace-')) throw new Error('Unexpected fixture directory'); await rm(path, { recursive: true, force: true }); directory = undefined; } });
describe('workspace boundaries and editing', () => {
  it('copies paths, duplicates and moves files, and keeps open editor grants after rename', async () => {
    const { files, chat, directory } = await setup();
    const opened = (await files.run({ action: 'read', conversationId: chat.id, path: 'note.md' })).file!;
    await files.run({ action: 'copy-path', conversationId: chat.id, path: 'note.md' });
    expect(clipboardText).toHaveBeenLastCalledWith(join(directory, 'note.md'));
    await files.run({ action: 'copy-relative-path', conversationId: chat.id, path: 'note.md' });
    expect(clipboardText).toHaveBeenLastCalledWith('note.md');
    await files.run({ action: 'copy', conversationId: chat.id, path: 'note.md' });
    expect((await files.run({ action: 'paste', conversationId: chat.id, path: '.' })).createdPath).toBe('note copy.md');
    expect(await readFile(join(directory, 'note copy.md'), 'utf8')).toBe('# Original\n');
    await files.run({ action: 'create-folder', conversationId: chat.id, path: 'destination' });
    await files.run({ action: 'cut', conversationId: chat.id, path: 'note.md' });
    expect((await files.run({ action: 'paste', conversationId: chat.id, path: 'destination' })).moved).toEqual({from:'note.md',to:'destination/note.md'});
    expect((await files.run({ action: 'clipboard-state', conversationId: chat.id })).canPaste).toBe(false);
    expect((await files.run({ action: 'refresh', conversationId: chat.id, id: opened.id })).file?.path).toBe('destination/note.md');
    await files.run({ action: 'rename', conversationId: chat.id, path: 'destination', name: 'renamed' });
    expect((await files.run({ action: 'refresh', conversationId: chat.id, id: opened.id })).file?.path).toBe('renamed/note.md');
    await files.run({ action: 'save', conversationId: chat.id, id: opened.id, text: 'Unsaved draft', sha256: opened.sha256 });
    expect(await readFile(join(directory, 'renamed/note.md'), 'utf8')).toBe('Unsaved draft');
  });
  it('rejects destructive collisions, root changes, protected descendants, traversal and active writes', async () => {
    const { files, chat, directory } = await setup();
    await writeFile(join(directory, 'other.md'), 'Keep');
    await expect(files.run({ action: 'rename', conversationId: chat.id, path: 'note.md', name: 'other.md' })).rejects.toThrow('already exists');
    for (const name of ['../outside', '.env', '.git', 'trailing.']) await expect(files.run({ action: 'rename', conversationId: chat.id, path: 'note.md', name })).rejects.toThrow();
    await expect(files.run({ action: 'delete', conversationId: chat.id, path: '.' })).rejects.toThrow('root');
    await expect(files.run({ action: 'copy', conversationId: chat.id, path: '../outside' })).rejects.toThrow();
    await files.run({ action: 'create-folder', conversationId: chat.id, path: 'nested' });
    await writeFile(join(directory, 'nested/.env'), 'secret');
    await expect(files.run({ action: 'delete', conversationId: chat.id, path: 'nested' })).rejects.toThrow('Sensitive');
    const release = acquireFileWrites([join(directory, 'note.md')]);
    try { await expect(files.run({ action: 'rename', conversationId: chat.id, path: 'note.md', name: 'new.md' })).rejects.toThrow('Another edit'); }
    finally { release(); }
    expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('# Original\n');
    expect(await readFile(join(directory, 'other.md'), 'utf8')).toBe('Keep');
  });
  it('uses the Recycle Bin and invalidates deleted grants only after trash succeeds', async () => {
    const { files, chat, directory } = await setup();
    const opened = (await files.run({ action: 'read', conversationId: chat.id, path: 'note.md' })).file!;
    trash.mockRejectedValueOnce(new Error('Cannot trash'));
    await expect(files.run({ action: 'delete', conversationId: chat.id, path: 'note.md' })).rejects.toThrow('Cannot trash');
    expect((await files.run({ action: 'refresh', conversationId: chat.id, id: opened.id })).file?.text).toContain('Original');
    trash.mockImplementationOnce(path => rm(path));
    expect((await files.run({ action: 'delete', conversationId: chat.id, path: 'note.md' })).removedPath).toBe('note.md');
    expect(trash).toHaveBeenLastCalledWith(join(directory, 'note.md'));
    await expect(files.run({ action: 'refresh', conversationId: chat.id, id: opened.id })).rejects.toThrow('no longer available');
  });
  it('opens durable managed artifacts after a chat moves to a Project, without confusing matching paths', async () => {
    const { files, store, directory, chat: projectChat } = await setup();
    const chat = store.createConversation(null);
    const code = new CodeFiles(store, new ProjectFiles(store.sources));
    await code.write(chat.id, 'run', 'note.md', '# Managed note', new AbortController().signal);
    const opened = (await files.run({ action: 'read', conversationId: chat.id, path: 'note.md', generated: true })).file!;
    expect(opened.text).toBe('# Managed note');
    expect((await files.run({ action: 'find', conversationId: chat.id, query: 'note' })).entries?.[0].name).toBe('note.md');
    store.organizeConversation({ id: chat.id, action: 'move', projectId: projectChat.projectId });
    expect((await files.run({ action: 'refresh', conversationId: chat.id, id: opened.id })).file?.text).toBe('# Managed note');
    expect((await files.run({ action: 'read', conversationId: chat.id, path: 'note.md' })).file?.text).toBe('# Original\n');
    const fresh = new WorkspaceFiles(store, () => ({}) as never);
    const reopened = (await fresh.run({ action: 'read', conversationId: chat.id, path: 'note.md', generated: true })).file!;
    await fresh.run({ action: 'save', conversationId: chat.id, id: reopened.id, sha256: reopened.sha256, text: '# Edited managed note' });
    expect(await readFile(join(store.generatedFilesRoot, chat.id, 'note.md'), 'utf8')).toBe('# Edited managed note');
    expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('# Original\n');
  });
  it('creates files and folders exclusively within the Project without replacing existing or protected files', async () => {
    const { files, chat, directory } = await setup();
    await files.run({ action: 'create-folder', conversationId: chat.id, path: 'new-folder' });
    const created = await files.run({ action: 'create-file', conversationId: chat.id, path: 'new-folder/example.ts' });
    expect(created.file).toMatchObject({ text: '', writable: true, path: 'new-folder/example.ts' });
    await expect(files.run({ action: 'create-file', conversationId: chat.id, path: 'note.md' })).rejects.toThrow();
    expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('# Original\n');
    for (const path of ['../outside.txt', '.git/config', '.env', '/absolute.txt', 'new-folder/../wrong.ts']) await expect(files.run({ action: 'create-file', conversationId: chat.id, path })).rejects.toThrow();
    await expect(files.run({ action: 'create-folder', conversationId: chat.id, path: 'new-folder' })).rejects.toThrow();
  });
  it('preserves editor drafts while another task owns the file and saves after release', async () => {
    const { files, chat, directory } = await setup();
    const opened = (await files.run({ action: 'read', conversationId: chat.id, path: 'note.md' })).file!;
    const release = acquireFileWrites([join(directory, 'note.md')]);
    try { await expect(files.run({ action: 'save', conversationId: chat.id, id: opened.id, text: 'User draft', sha256: opened.sha256 })).rejects.toThrow('Another edit'); }
    finally { release(); }
    expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('# Original\n');
    await files.run({ action: 'save', conversationId: chat.id, id: opened.id, text: 'User draft', sha256: opened.sha256 });
    expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('User draft');
  });
  it('views files without sharing them, saves with conflict checks, and explicitly adds saved contents to sources', async () => {
    const { files, chat, store, directory } = await setup(); const opened = (await files.run({ action: 'read', conversationId: chat.id, path: 'note.md' })).file!;
    expect(opened).toMatchObject({ kind: 'text', text: '# Original\n', writable: true }); expect(store.conversation(chat.id).sources).toHaveLength(0);
    const saved = (await files.run({ action: 'save', conversationId: chat.id, id: opened.id, text: '# Changed\n', sha256: opened.sha256 })).file!; expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('# Changed\n');
    await expect(files.run({ action: 'save', conversationId: chat.id, id: opened.id, text: 'stale overwrite', sha256: opened.sha256 })).rejects.toThrow('changed on disk'); expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('# Changed\n');
    const source = await files.run({ action: 'add-source', conversationId: chat.id, id: saved.id }); expect(store.sources.detail(chat.id, source.sourceId!).text).toBe('# Changed\n');
  });
  it('rejects another conversation’s file grants, path traversal, protected files, and grants after a Project move', async () => {
    const { files, chat, store, directory } = await setup(); const opened = (await files.run({ action: 'read', conversationId: chat.id, path: 'note.md' })).file!;
    const other = store.createConversation(null); await expect(files.run({ action: 'refresh', conversationId: other.id, id: opened.id })).rejects.toThrow('no longer available');
    await expect(files.run({ action: 'read', conversationId: chat.id, path: '../outside.txt' })).rejects.toThrow('outside'); await writeFile(join(directory, '.env'), 'secret'); await expect(files.run({ action: 'read', conversationId: chat.id, path: '.env' })).rejects.toThrow('Sensitive');
    store.organizeConversation({ id: chat.id, action: 'move', projectId: null }); await expect(files.run({ action: 'save', conversationId: chat.id, id: opened.id, sha256: opened.sha256, text: 'changed' })).rejects.toThrow('no longer available');
  });
  it('allows personal files only after a native picker grant and returns previews without uploading them', async () => {
    const { files, store, directory } = await setup(); const chat = store.createConversation(null); picker.mockResolvedValue({ canceled: false, filePaths: [join(directory, 'note.md')] });
    const chosen = await files.run({ action: 'choose', conversationId: chat.id }); expect(chosen.files?.[0].text).toContain('Original'); expect(store.conversation(chat.id).sources).toHaveLength(0);
    await expect(files.run({ action: 'read', conversationId: chat.id, path: 'note.md' })).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('opens a generated card only in its original Project', async () => {
    const { files, chat, store } = await setup();
    expect((await files.run({ action: 'read', conversationId: chat.id, path: 'note.md', projectId: chat.projectId! })).file?.name).toBe('note.md');
    const other = store.createProject('Other', '', false, directory!); store.organizeConversation({ id: chat.id, action: 'move', projectId: other.id });
    await expect(files.run({ action: 'read', conversationId: chat.id, path: 'note.md', projectId: chat.projectId! })).rejects.toThrow('original Project');
  });
  it('accepts URL/search navigation while refusing privileged protocols and unbounded viewport requests', () => {
    expect(workspaceAddress('localhost:3000/a', 'google')).toBe('http://localhost:3000/a'); expect(workspaceAddress('example.com', 'bing')).toBe('https://example.com/'); expect(workspaceAddress('a lovely search', 'duckduckgo')).toContain('q=a+lovely+search');
    // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- Synthetic credential-bearing URL rejection fixture; no real credentials.
    expect(workspaceAddress('javascript:alert(1)', 'google')).toBeNull(); expect(workspaceAddress('file:///C:/secrets', 'google')).toBeNull(); expect(workspaceAddress('https://user:secret@example.com', 'bing')).toBeNull();
    const conversationId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; expect(browserRequestSchema.safeParse({ action: 'new', conversationId, url: 'file:///C:/secrets' }).success).toBe(false); expect(browserLayoutSchema.safeParse({ conversationId, tabId: null, bounds: { x: 0, y: 0, width: Infinity, height: 1 } }).success).toBe(false);
    const scroll = { conversationId, tabId: conversationId };
    const layout = { ...scroll, bounds: { x: 20, y: 90, width: 400, height: 500 } };
    expect(browserLayoutSchema.safeParse({ ...layout, cornerRadius: 13, rightInset: 10 }).success).toBe(true);
    for (const cornerRadius of [-1, 101, Infinity]) expect(browserLayoutSchema.safeParse({ ...layout, cornerRadius }).success).toBe(false);
    for (const rightInset of [-1, 65, NaN]) expect(browserLayoutSchema.safeParse({ ...layout, rightInset }).success).toBe(false);
    expect(browserScrollRequestSchema.safeParse(scroll).success).toBe(true);
    for (const position of [0, .5, 1]) expect(browserScrollRequestSchema.safeParse({ ...scroll, position }).success).toBe(true);
    for (const position of [-1, 2, Infinity, NaN, '0.5']) expect(browserScrollRequestSchema.safeParse({ ...scroll, position }).success).toBe(false);
  });
});
