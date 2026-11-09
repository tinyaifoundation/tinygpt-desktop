import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { fileDestination, prepareFileDestination } from './file-destination';
import { scopedPath, readLimited, type ProjectFiles } from './files';
import type { HistoryStore } from './history';
import type { CodeFiles } from './code-files';

export class WorkspaceFileError extends Error {
  constructor(readonly code: string, message: string, readonly nextAction: string) { super(message); }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const writes = new Map<string, Promise<void>>();

/** Version checks belong to the host, never to model-supplied arguments.
 * Observations are run-scoped: another conversation/read cannot refresh them. */
export class WorkspaceFiles {
  private observed = new Map<string, Map<string, string | null>>();
  constructor(private history: HistoryStore, private files: ProjectFiles, private code: CodeFiles) {}
  endRun(runId: string) { this.observed.delete(runId); }
  private key(path: string) { return process.platform === 'win32' ? path.toLowerCase() : path; }
  private remember(runId: string, path: string, version: string | null) {
    const reads = this.observed.get(runId) ?? new Map<string, string | null>();
    reads.set(this.key(path), version); this.observed.set(runId, reads);
  }
  async read(conversationId: string, runId: string, path: string, offset: number, limit: number, signal: AbortSignal) {
    const destination = await prepareFileDestination(this.history, conversationId, signal);
    try {
      const result = await this.files.read(conversationId, destination.root, path, signal, 500000);
      const target = await scopedPath(destination.root, path);
      this.remember(runId, target, result.sha256);
      return { path, totalLength: result.text.length, offset, ...(offset + limit < result.text.length ? { nextOffset: offset + limit } : {}), text: result.text.slice(offset, offset + limit) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.remember(runId, resolve(destination.root, path), null);
      throw error;
    }
  }
  async write(conversationId: string, runId: string, path: string, content: string, signal: AbortSignal, replacement?: { oldText: string; newText: string }) {
    const destination = await prepareFileDestination(this.history, conversationId, signal);
    let target: string;
    try { target = await scopedPath(destination.root, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; target = resolve(destination.root, path); }
    const key = this.key(target), previous = writes.get(key) ?? Promise.resolve();
    const action = previous.then(() => { signal.throwIfAborted(); return this.applyWrite(conversationId, runId, path, content, signal, replacement); });
    const settled = action.then(() => {}, () => {}); writes.set(key, settled);
    try { return await action; } finally { if (writes.get(key) === settled) writes.delete(key); }
  }
  private async applyWrite(conversationId: string, runId: string, path: string, content: string, signal: AbortSignal, replacement?: { oldText: string; newText: string }) {
    const destination = await prepareFileDestination(this.history, conversationId, signal);
    let target: string, before: string | null = null;
    try { target = await scopedPath(destination.root, path); before = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(await readLimited(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; target = resolve(destination.root, path); }
    const version = before === null ? null : hash(before), observations = this.observed.get(runId), key = this.key(target);
    if (observations?.has(key) && observations.get(key) !== version) throw new WorkspaceFileError('FILE_CHANGED', 'This file changed since you read it. Nothing was written.', 'Read the file again, then apply your change to its current contents.');
    if (replacement) {
      const count = before === null ? 0 : before.split(replacement.oldText).length - 1;
      if (count !== 1) throw new WorkspaceFileError(count ? 'EDIT_AMBIGUOUS' : 'EDIT_NOT_FOUND', count ? 'The text matches more than once. Nothing was written.' : 'The text was not found. Nothing was written.', 'Read the file and use one specific, exact text match.');
      content = before!.replace(replacement.oldText, () => replacement.newText);
    }
    const result = await this.code.edit(conversationId, runId, path, before, content, signal, undefined, 500000);
    this.remember(runId, target, hash(content));
    return { action: result.unchanged ? 'unchanged' : before === null ? 'created' : 'updated', path, bytes: Buffer.byteLength(content), artifact: result.artifact };
  }
  async search(conversationId: string, query: string, path: string, signal: AbortSignal) {
    const root = fileDestination(this.history, conversationId).root;
    const pending = [path], matches: { path: string; line?: number; text?: string }[] = [];
    let visited = 0, truncated = false;
    while (pending.length && visited < 300 && matches.length < 60) {
      signal.throwIfAborted(); const directory = pending.shift()!;
      const list = await this.files.list(root, directory, signal); truncated ||= list.truncated;
      for (const entry of list.entries) {
        if (++visited > 300 || matches.length >= 60) { truncated = true; break; }
        const file = join(directory, entry.name).replaceAll('\\', '/');
        try { await scopedPath(root, file); } catch (error) { if (signal.aborted) throw error; continue; }
        if (entry.name.toLowerCase().includes(query.toLowerCase())) matches.push({ path: file });
        if (entry.directory) { if (!['dist', 'build', 'out', 'coverage', 'vendor', '.cache'].includes(entry.name)) pending.push(file); continue; }
        try {
          const checked = await scopedPath(root, file), bytes = await readLimited(checked);
          if (bytes.length > 250000 || bytes.includes(0)) continue;
          const lines = new TextDecoder('utf8', { fatal: true }).decode(bytes).split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < 60; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) matches.push({ path: relative(root, checked).replaceAll('\\', '/'), line: i + 1, text: lines[i].slice(0, 240) });
        } catch (error) { if (signal.aborted) throw error; /* Unsupported/protected files do not enter search results. */ }
      }
    }
    return { matches, truncated: truncated || pending.length > 0 || matches.length >= 60 };
  }
}
