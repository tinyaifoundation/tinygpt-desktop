import { clipboard, dialog, shell, nativeImage, type BrowserWindow } from 'electron';
import { randomUUID, createHash } from 'node:crypto';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { open, realpath, stat, lstat, mkdir, readdir, rename, cp } from 'node:fs/promises';
import { extractFile, insideRoot, ProjectFiles, readLimited, scopedPath } from './files';
import type { HistoryStore } from './history';
import type { FilePreview, WorkspaceFileRequest, WorkspaceFileResult } from '../shared/workspace';
import { searchWorkspaceFiles } from './workspace-file-search';
import { fileDestination, prepareFileDestination } from './file-destination';
import { acquireFileWrites } from './file-write-locks';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
interface Grant { id: string; conversationId: string; path: string; relativePath?: string; root?: string; projectId?: string; generated?: boolean }
const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
export class WorkspaceFiles {
  private grants = new Map<string, Grant>(); private writes = new Map<string, Promise<unknown>>();
  private fileClipboard?: { conversationId: string; root: string; path: string; cut: boolean };
  constructor(private history: HistoryStore, private owner: () => BrowserWindow) {}
  private async path(grant: Grant): Promise<string> {
    this.history.conversation(grant.conversationId);
    if (grant.root) { const destination = fileDestination(this.history, grant.conversationId, !!grant.generated); if ((destination.projectId ?? undefined) !== grant.projectId || destination.root !== grant.root || await scopedPath(destination.root, grant.relativePath!) !== grant.path) throw new Error('This workspace file is no longer available. Open it again.'); }
    if (await realpath(grant.path) !== grant.path) throw new Error('The file changed while it was being read. Try again.');
    return grant.path;
  }
  private owned(conversationId: string, id: string): Grant { const grant = this.grants.get(id); if (!grant || grant.conversationId !== conversationId) throw new Error('This workspace file is no longer available. Open it again.'); return grant; }
  private async preview(grant: Grant): Promise<FilePreview> {
    const bytes = await readLimited(await this.path(grant)); const extension = extname(grant.path).toLowerCase(); const mime = mimeTypes[extension] ?? 'text/plain';
    let kind: FilePreview['kind'] = extension === '.pdf' ? 'pdf' : mime.startsWith('image/') ? 'image' : ['.docx', '.xlsx', '.pptx'].includes(extension) ? extension.slice(1) as 'docx' | 'xlsx' | 'pptx' : 'binary'; let text: string | undefined;
    if (kind === 'binary' && !bytes.subarray(0, 8192).includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.length <= 500000) kind = 'text'; else text = undefined; } catch { /* Unsupported binary remains downloadable. */ } }
    await this.path(grant);
    return { id: grant.id, name: basename(grant.path), path: grant.relativePath ?? grant.path, kind, mime, size: bytes.length, sha256: hash(bytes), writable: kind === 'text', ...(text !== undefined ? { text } : { bytesBase64: bytes.toString('base64') }) };
  }
  private add(grant: Omit<Grant, 'id'>): Grant { const previous = [...this.grants.values()].find(item => item.conversationId === grant.conversationId && item.path === grant.path && item.root === grant.root); if (previous) return previous; if (this.grants.size >= 200) this.grants.delete(this.grants.keys().next().value!); const value = { ...grant, id: randomUUID() }; this.grants.set(value.id, value); return value; }
  private async entry(root: string, requested: string) {
    const path = await scopedPath(root, requested);
    if ((await lstat(resolve(root, requested))).isSymbolicLink()) throw new Error('File actions are not available for symbolic links.');
    return path;
  }
  private async treePaths(root: string, requested: string, paths: string[] = []): Promise<string[]> {
    const path = await this.entry(root, requested); paths.push(path);
    if (paths.length > 2000) throw new Error('Choose a smaller folder (up to 2,000 items).');
    if ((await lstat(path)).isDirectory()) for (const name of await readdir(path)) await this.treePaths(root, join(requested, name), paths);
    return paths;
  }
  private async vacant(path: string) {
    try { await lstat(path); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
    throw new Error('An item with that name already exists. Choose a different name.');
  }
  private moveGrants(from: string, to?: string) {
    for (const [id, grant] of this.grants) if (insideRoot(from, grant.path)) {
      if (!to) this.grants.delete(id);
      else { grant.path = join(to, relative(from, grant.path)); if (grant.root) grant.relativePath = relative(grant.root, grant.path).replaceAll('\\', '/'); }
    }
  }
  private async entryAction(input: WorkspaceFileRequest): Promise<WorkspaceFileResult> {
    const destination = await prepareFileDestination(this.history, input.conversationId, new AbortController().signal);
    if (input.action === 'clipboard-state') return { canPaste: !!this.fileClipboard };
    if (!('path' in input)) throw new Error('Unknown workspace action.');
    const path = await this.entry(destination.root, input.path);
    if (input.action === 'reveal-entry') { shell.showItemInFolder(path); return {}; }
    if (input.action === 'copy-path' || input.action === 'copy-relative-path') { clipboard.writeText(input.action === 'copy-path' ? path : input.path.replaceAll('\\', '/')); return {}; }
    if (input.action === 'paste') {
      const copied = this.fileClipboard; if (!copied) throw new Error('Copy or cut a workspace item first.');
      if (!(await stat(path)).isDirectory()) throw new Error('Paste into a folder.');
      const original = fileDestination(this.history, copied.conversationId);
      if (original.root !== copied.root) throw new Error('The original Project changed. Copy the item again.');
      const source = await this.entry(copied.root, copied.path);
      let targetRelative = join(input.path, basename(source)).replaceAll('\\', '/');
      let target = await scopedPath(destination.root, targetRelative, true);
      if (target === source) {
        if (copied.cut) { this.fileClipboard = undefined; return { canPaste: false }; }
        const extension = (await stat(source)).isDirectory() ? '' : extname(source);
        const stem = basename(source).slice(0, basename(source).length - extension.length);
        for (let number = 1; ; number++) {
          if (number > 100) throw new Error('Too many copies of this item. Rename a copy first.');
          targetRelative = join(input.path, `${stem} copy${number === 1 ? '' : ' ' + number}${extension}`).replaceAll('\\', '/');
          target = await scopedPath(destination.root, targetRelative, true);
          try { await lstat(target); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') break; throw cause; }
        }
      }
      if (insideRoot(source, target)) throw new Error('An item cannot be pasted into itself.');
      const sourcePaths = await this.treePaths(copied.root, copied.path);
      const release = acquireFileWrites([...sourcePaths, target]);
      try {
        await this.vacant(target);
        if (await this.entry(copied.root, copied.path) !== source || await this.entry(destination.root, input.path) !== path) throw new Error('The folder changed. Try again.');
        if (copied.cut) {
          if (copied.root !== destination.root) throw new Error('Move items within the same Project. Use Copy for another Project.');
          await rename(source, target); this.moveGrants(source, target); this.fileClipboard = undefined;
          return { moved: { from: copied.path.replaceAll('\\', '/'), to: targetRelative }, canPaste: false };
        }
        await cp(source, target, { recursive: true, force: false, errorOnExist: true, dereference: false, filter: async sourcePath => { await this.entry(copied.root, relative(copied.root, sourcePath)); return true; } });
        return { createdPath: targetRelative, canPaste: true };
      } finally { release(); }
    }
    if (path === await realpath(destination.root)) throw new Error('The workspace root cannot be changed.');
    if (input.action === 'cut' || input.action === 'copy') { this.fileClipboard = { conversationId: input.conversationId, root: destination.root, path: input.path, cut: input.action === 'cut' }; return { canPaste: true }; }
    if (input.action === 'rename') {
      if (!input.name.trim() || /[\\/:\0]/.test(input.name) || ['.', '..'].includes(input.name) || /[. ]$/.test(input.name)) throw new Error('Enter a valid file or folder name.');
      const nextRelative = join(dirname(input.path), input.name).replaceAll('\\', '/');
      const target = await scopedPath(destination.root, nextRelative, true);
      if (target === path) return {};
      const release = acquireFileWrites([...(await this.treePaths(destination.root, input.path)), target]);
      try { await this.vacant(target); await this.entry(destination.root, input.path); await rename(path, target); this.moveGrants(path, target); }
      finally { release(); }
      if (this.fileClipboard?.root === destination.root && insideRoot(path, resolve(destination.root, this.fileClipboard.path))) this.fileClipboard.path = relative(destination.root, join(target, relative(path, resolve(destination.root, this.fileClipboard.path))));
      return { moved: { from: input.path.replaceAll('\\', '/'), to: nextRelative } };
    }
    if (input.action === 'delete') {
      const release = acquireFileWrites(await this.treePaths(destination.root, input.path));
      try { await this.entry(destination.root, input.path); await shell.trashItem(path); this.moveGrants(path); }
      finally { release(); }
      if (this.fileClipboard?.root === destination.root && insideRoot(path, resolve(destination.root, this.fileClipboard.path))) this.fileClipboard = undefined;
      return { removedPath: input.path.replaceAll('\\', '/') };
    }
    throw new Error('Unknown workspace action.');
  }
  async run(input: WorkspaceFileRequest): Promise<WorkspaceFileResult> {
    if (['clipboard-state', 'reveal-entry', 'copy-path', 'copy-relative-path', 'cut', 'copy', 'paste', 'rename', 'delete'].includes(input.action)) return this.entryAction(input);
    const chat = this.history.conversation(input.conversationId); const project = chat.projectId ? this.history.project(chat.projectId) : null;
    const destination = ['find', 'list', 'read', 'create-file', 'create-folder'].includes(input.action) ? await prepareFileDestination(this.history, chat.id, new AbortController().signal, input.action === 'read' && !!input.generated) : null;
    if (input.action === 'find') return searchWorkspaceFiles(new ProjectFiles(this.history.sources),destination!.root,input.query);
    if (input.action === 'list') { const result = await new ProjectFiles(this.history.sources).list(destination!.root, input.path, new AbortController().signal); return { entries: result.entries.map(entry => ({ name: entry.name, path: input.path === '.' ? entry.name : `${input.path}/${entry.name}`, kind: entry.directory ? 'directory' : 'file', size: null })), truncated: result.truncated }; }
    if (input.action === 'choose') {
      const choice = await dialog.showOpenDialog(this.owner(), { title: 'Open files in workspace', properties: ['openFile', 'multiSelections'] }); if (choice.canceled) return { files: [] }; if (choice.filePaths.length > 12) throw new Error('Open up to twelve workspace files at once.');
      const files = []; for (const selected of choice.filePaths) { const path = await realpath(selected); files.push(await this.preview(this.add({ conversationId: chat.id, path }))); } return { files };
    }
    if (input.action === 'read') { if (input.projectId && input.projectId !== project?.id) throw new Error('This file belongs to the original Project. Move the conversation back to that Project to open it.'); const path = await scopedPath(destination!.root, input.path); const grant = this.add({ conversationId: chat.id, path, root: destination!.root, projectId: destination!.projectId ?? undefined, generated: destination!.generated, relativePath: input.path }); return { file: await this.preview(grant) }; }
    if (input.action === 'create-file' || input.action === 'create-folder') {
      if (input.path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Enter a name inside the Project folder.');
      const path = await scopedPath(destination!.root, input.path, true); const release = acquireFileWrites([path]);
      try {
        if (input.action === 'create-folder') { await mkdir(path); return {}; }
        const handle = await open(path, 'wx'); try { await handle.sync(); } finally { await handle.close(); }
        const grant = this.add({ conversationId: chat.id, path, root: destination!.root, projectId: destination!.projectId ?? undefined, generated: destination!.generated, relativePath: input.path });
        return { file: await this.preview(grant) };
      } finally { release(); }
    }
    if (!('id' in input)) throw new Error('Unknown workspace action.');
    const grant = this.owned(chat.id, input.id); const path = await this.path(grant);
    if (input.action === 'refresh') return { file: await this.preview(grant) };
    if (input.action === 'reveal') { shell.showItemInFolder(path); return {}; }
    if (input.action === 'export') { const bytes = await readLimited(path); const choice = await dialog.showSaveDialog(this.owner(), { title: 'Save a copy', defaultPath: basename(path) }); if (!choice.canceled && choice.filePath) { const { writeFile } = await import('node:fs/promises'); await writeFile(choice.filePath, bytes); } return {}; }
    if (input.action === 'add-source') { const file = await this.preview(grant); let source;
      if (file.kind === 'image') { let image = nativeImage.createFromBuffer(Buffer.from(file.bytesBase64!, 'base64')); if (image.isEmpty()) throw new Error('The selected image could not be read.'); const size = image.getSize(); if (size.width > 1600 || size.height > 1600) image = image.resize(size.width >= size.height ? { width: 1600 } : { height: 1600 }); source = this.history.sources.add(chat.id, { kind: 'image', title: file.name, text: '', mime: 'image/jpeg', image: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`, size: file.size }); }
      else { const text = file.text ?? await extractFile(path, await readLimited(path)); source = this.history.sources.add(chat.id, { kind: 'attachment', title: file.name, text, mime: file.mime, size: file.size }); }
      return { sourceId: source.id };
    }
    if (input.action !== 'save') throw new Error('Unknown workspace action.');
    const operation = async () => {
      const release = acquireFileWrites([await this.path(grant)]);
      try {
      const before = await this.preview(grant); if (!before.writable) throw new Error('This file cannot be edited as text.');
      if ((await lstat(path)).isSymbolicLink()) throw new Error('The file changed before writing. Try again.');
      const handle = await open(path, 'r+'); try { const bytes = await handle.readFile(); const info = await handle.stat(); const current = await stat(await this.path(grant)); if (hash(bytes) !== input.sha256 || info.ino !== current.ino || info.dev !== current.dev) throw new Error('The file changed on disk. Reload it before saving.'); const next = Buffer.from(input.text); let written = 0; while (written < next.length) { const result = await handle.write(next, written, next.length - written, written); if (!result.bytesWritten) throw new Error('The file could not be saved.'); written += result.bytesWritten; } await handle.truncate(next.length); await handle.sync(); } finally { await handle.close(); }
      return { file: await this.preview(grant) };
      } finally { release(); }
    };
    const previous = this.writes.get(path) ?? Promise.resolve(); const next = previous.catch(() => {}).then(operation); this.writes.set(path, next); try { return await next; } finally { if (this.writes.get(path) === next) this.writes.delete(path); }
  }
  closeConversation(id: string) { for (const [key, grant] of this.grants) if (grant.conversationId === id) this.grants.delete(key); if (this.fileClipboard?.conversationId === id) this.fileClipboard = undefined; }
}
