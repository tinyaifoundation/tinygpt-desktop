import { dialog, type BrowserWindow } from 'electron';
import { normalizeToolImage } from './image-tools';
import { basename, extname, join, relative } from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { extractFile, readLimited, scopedPath, textExtensions } from './files';
import type { SourceLibrary } from './sources';
import type { SourceSummary } from '../shared/tools';

export async function chooseAttachments(window: BrowserWindow, conversationId: string, sources: SourceLibrary): Promise<SourceSummary[]> {
  const selected = await dialog.showOpenDialog(window, { title: 'Attach files or images', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents, text, code, and images', extensions: ['docx', 'xlsx', 'pptx', 'odt', 'txt', 'md', 'pdf', 'csv', 'json', 'yaml', 'yml', 'html', 'ts', 'tsx', 'js', 'jsx', 'py', 'css', 'png', 'jpg', 'jpeg', 'webp'] }] });
  if (selected.canceled) return [];
  if (selected.filePaths.length > 8) throw new Error('Choose up to eight distinct attachments.');
  const drafts = sources.list(conversationId, false).filter(source => !source.messageId && ['attachment', 'image', 'conversation', 'folder'].includes(source.kind));
  if (drafts.length + selected.filePaths.length > 8) throw new Error('Choose up to eight distinct attachments.');
  const prepared: Parameters<SourceLibrary['add']>[1][] = [];
  const uploads: SourceSummary[] = [];
  for (const path of selected.filePaths) {
    const bytes = await readLimited(path);
    if (sources.ingestUpload) {
      const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase()) ? normalizeToolImage(bytes) : undefined;
      uploads.push(sources.ingestUpload(conversationId, basename(path), bytes, image)); continue;
    }
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase())) {
      const normalized = normalizeToolImage(bytes);
      prepared.push({ kind: 'image', title: basename(path), text: '', mime: normalized.mime, size: bytes.length, image: normalized.image, originalImage: bytes });
    } else prepared.push({ kind: 'attachment', title: basename(path), text: await extractFile(path, bytes), mime: extname(path).toLowerCase() === '.pdf' ? 'application/pdf' : 'text/plain', size: bytes.length });
  }
  return [...uploads, ...prepared.map(input => sources.add(conversationId, input))];
}

export async function folderSnapshot(directory: string): Promise<string> {
  const root = await realpath(directory);
  const queue = ['.']; const passages: string[] = [];
  const signal = AbortSignal.timeout(30000);
  let files = 0, characters = 0, visited = 0, omitted = false;
  while (queue.length && files < 80 && characters < 400000 && visited < 500) {
    if (signal.aborted) { omitted = true; break; }
    const requested = queue.shift()!; visited++;
    const current = await scopedPath(root, requested);
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries.slice(0, 500)) {
      if (signal.aborted) { omitted = true; break; }
      if (entry.isSymbolicLink() || ['node_modules', 'dist', 'out', 'build', '.git', '.ssh', '.aws', '.codex', '.agents'].includes(entry.name.toLowerCase())) continue;
      const path = relative(root, join(current, entry.name));
      let scoped: string;
      try { scoped = await scopedPath(root, path); } catch { continue; }
      if (entry.isDirectory()) { if (path.split(/[\\/]/).length <= 5 && queue.length < 500) queue.push(path); else omitted = true; continue; }
      if (!entry.isFile() || !textExtensions.has(extname(entry.name).toLowerCase()) && !['.pdf', '.docx', '.xlsx', '.pptx', '.odt'].includes(extname(entry.name).toLowerCase())) continue;
      if (files >= 80 || characters >= 400000) { omitted = true; break; }
      try {
        if ((await stat(scoped)).size > 2 * 1024 * 1024) { omitted = true; continue; }
        const text = await extractFile(scoped, await readLimited(scoped), signal);
        if (await scopedPath(root, path) !== scoped) throw new Error('The file changed while reading.');
        const header = `File: ${path}\n`, suffix = '\n[File excerpt truncated.]';
        const remaining = 400000 - characters - header.length - suffix.length - 2;
        if (remaining <= 0) { omitted = true; break; }
        const excerpt = text.slice(0, Math.min(24000, remaining));
        const passage = `${header}${excerpt}${excerpt.length < text.length ? suffix : ''}`;
        passages.push(passage);
        characters += passage.length + 2; files++;
        if (excerpt.length < text.length) omitted = true;
      } catch { omitted = true; }
    }
    if (entries.length > 500) omitted = true;
  }
  if (!passages.length) throw new Error('This folder has no supported readable files.');
  return `Folder: ${basename(root)}\nSnapshot of ${files} files.${omitted || queue.length ? ' Some files were omitted by the folder size limits.' : ''}\n\n${passages.join('\n\n')}`;
}

export async function chooseAttachmentFolder(window: BrowserWindow, conversationId: string, sources: SourceLibrary): Promise<void> {
  const selected = await dialog.showOpenDialog(window, { title: 'Attach a folder', properties: ['openDirectory'] });
  if (selected.canceled || !selected.filePaths[0]) return;
  if (sources.list(conversationId, false).filter(source => !source.messageId && ['attachment', 'image', 'conversation', 'folder'].includes(source.kind)).length >= 8) throw new Error('Choose up to eight distinct attachments.');
  const path = selected.filePaths[0];
  sources.add(conversationId, { kind: 'folder', title: basename(path), text: await folderSnapshot(path) });
}
