import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, unlink, mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { codeShellEnvironment } from './code-shell';
import { workRuntimes, workCommand, workRuntimeState } from './work-runtimes';
import { scopedPath, readLimited, type ProjectFiles } from './files';
import type { HistoryStore } from './history';
import { fileDestination, prepareFileDestination } from './file-destination';
import { acquireFileWrites } from './file-write-locks';

export const CODE_STALE_FILE = 'The file changed on disk. Read it again before editing or undoing.';
export const CODE_EDIT_GUARD_REQUIRED = 'This file already exists. Read it with read_project_file, then pass its returned sha256 as expectedSha256. Nothing was written.';
export class CodeFiles {
  constructor(private history: HistoryStore, private files: ProjectFiles) {}
  async write(conversationId: string, runId: string, path: string, content: string, signal: AbortSignal) {
    const destination = await prepareFileDestination(this.history, conversationId, signal);
    let target: string;
    try { target = await scopedPath(destination.root, path, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.files.createDirectory(destination.root, dirname(path), signal);
      target = await scopedPath(destination.root, path, true);
    }
    let before: string | null = null;
    try { before = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(await readLimited(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return this.edit(conversationId, runId, path, before, content, signal);
  }
  async edit(conversationId: string, runId: string, path: string, expected: string | null | undefined, content: string, signal: AbortSignal, expectedSha256?: string | null, maxLength = 100000) {
    const destination = await prepareFileDestination(this.history, conversationId, signal);
    // An omitted guard is create-only, never permission to overwrite an unread file.
    const missingGuard = expected === undefined && expectedSha256 === undefined;
    const createOnly = missingGuard || expected === null || expectedSha256 === null;
    signal.throwIfAborted();
    let target: string;
    try { target = await scopedPath(destination.root, path, true); }
    catch (error) {
      if (!createOnly || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.files.createDirectory(destination.root, dirname(path), signal);
      target = await scopedPath(destination.root, path, true);
    }
    let before: string | null = null;
    try { before = new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(await readLimited(target)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (before !== null && before.length > maxLength) throw new Error(`Code edits support files up to ${maxLength.toLocaleString('en-US')} characters.`);
    const hash = before === null ? null : createHash('sha256').update(before).digest('hex');
    if (missingGuard && before !== null) throw new Error(CODE_EDIT_GUARD_REQUIRED);
    if (expected !== undefined && before !== expected || expectedSha256 !== undefined && hash !== expectedSha256) throw new Error(CODE_STALE_FILE);
    const artifact = destination.generated ? { kind: 'generated-file', path, conversationId } : { kind: 'project-file', path, projectId: destination.projectId };
    if (before === content) return { path, unchanged: true, changeId: undefined, artifact };
    signal.throwIfAborted();
    // This saved diff belongs to this action, not to unrelated pre-existing edits.
    const changeId = this.history.saveCodeChange(conversationId, runId, destination.projectId, destination.root, path, before, content);
    let written: { path: string; bytes: number };
    try { written = await this.files.write(destination.root, path, content, signal, before); this.history.setCodeChangeState(changeId,'applied'); }
    catch (error) { await this.recover(changeId).catch(() => {}); throw error; }
    this.history.sources.recordWrittenFile(conversationId, path, content);
    return { ...written, changeId, artifact };
  }
  private changeRoot(change: import('../shared/code').CodeChange, checkScope = true): string {
    const chat = this.history.conversation(change.conversationId);
    const project = change.projectId ? this.history.project(change.projectId) : null;
    const root = project ? project.rootPath : fileDestination(this.history, chat.id, true).root;
    if (!root || root !== this.history.codeChangeRoot(change.id) || checkScope && project && chat.projectId !== project.id) throw new Error('The Project folder changed. Select it again.');
    return root;
  }
  async undo(conversationId: string, changeId: string): Promise<void> {
    const change = this.history.codeChanges(conversationId).find(item => item.id === changeId);
    if (!change || change.reverted || change.state !== 'applied') throw new Error('This change is no longer available to undo.');
    const root = this.changeRoot(change);
    const path = await scopedPath(root, change.path);
    if (await readFile(path, 'utf8') !== change.after) throw new Error(CODE_STALE_FILE);
    this.history.setCodeChangeState(change.id,'undo-pending');
    try { if (change.before === null) { const release = acquireFileWrites([path]); try { if (await readFile(path, 'utf8') !== change.after) throw new Error(CODE_STALE_FILE); await unlink(path); } finally { release(); } }
      else await this.files.write(root, change.path, change.before, new AbortController().signal,change.after);
      this.history.setCodeChangeState(change.id,'reverted'); if (change.projectId) this.history.sources.removeProjectFiles(change.projectId); else this.history.sources.removeConversationFiles(change.conversationId);
    } catch (error) { await this.recover(change.id).catch(() => {}); throw error; }
  }
  async undoRuns(conversationId: string, runIds: Set<string>): Promise<void> {
    const changes = this.history.codeChanges(conversationId).filter(change => runIds.has(change.runId) && !change.reverted && change.state !== 'failed').reverse();
    // Check the complete reverse chain before writing any file. Repeated edits
    // to the same file must join exactly, including changes from later turns.
    const expected = new Map<string, string | null>();
    for (const change of changes) {
      if (change.state !== 'applied') throw new Error('Some file changes need review before this message can be edited.');
      const path = await scopedPath(this.changeRoot(change), change.path, true);
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (!expected.has(key)) {
        let current: string | null = null;
        try { current = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(await readLimited(path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        expected.set(key, current);
      }
      if (expected.get(key) !== change.after) throw new Error(`Cannot undo changes to ${change.path}: the file changed independently. Your edit was not sent.`);
      expected.set(key, change.before);
    }
    for (const change of changes) await this.undo(conversationId, change.id);
  }
  async recover(changeId?: string): Promise<void> {
    for (const change of this.history.pendingCodeChanges()) {
      if (changeId && change.id !== changeId) continue;
      let state: NonNullable<typeof change.state> = 'conflict';
      try {
        const root = this.changeRoot(change, false);
        if (root === this.history.codeChangeRoot(change.id)) {
          const path = await scopedPath(root,change.path,true); let current: string | null = null;
          try { current = await readFile(path,'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          state = current === change.after ? 'applied' : current === change.before ? change.state === 'undo-pending' ? 'reverted' : 'failed' : 'conflict';
          if (change.projectId) this.history.sources.removeProjectFiles(change.projectId); else this.history.sources.removeConversationFiles(change.conversationId);
        }
      } catch { /* A changed/unavailable folder is never written during recovery. */ }
      this.history.setCodeChangeState(change.id,state);
    }
  }
  async command(root: string | null, executable: string, args: string[], cwd: string, timeoutSeconds: number, signal: AbortSignal, onOutput?: (text: string) => void) {
    const directory = await scopedPath(root, cwd);
    signal.throwIfAborted();
    // Never put inference/connector secrets in a project process environment.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','LANG','LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    if (!/^[a-zA-Z0-9_.-]+$/.test(executable) || /^(cmd|powershell|pwsh|sh|bash)(\.exe)?$/i.test(executable)) throw new Error('Use a program name and separate arguments; shell programs are not available.');
    const runtime=await workRuntimes();
    Object.assign(env,await codeShellEnvironment(workRuntimeState(directory),env));delete env.Path;
    const command=workCommand(executable,args,runtime);
    signal.throwIfAborted();
    return new Promise<{ exitCode: number | null; output: string; truncated: boolean; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(command.executable, command.args, { cwd: directory, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore','pipe','pipe'] });
      let output = ''; let truncated = false; let timedOut = false;
      const collect = (bytes: Buffer) => { const text = bytes.toString('utf8'); if (output.length + text.length > 24000) truncated = true; output = (output + text).slice(0,24000); onOutput?.(output); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const kill = () => { if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill()); else { try { if (child.pid) process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
      const abort = () => kill(); signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSeconds * 1000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.once('error', () => { cleanup(); reject(new Error('The program could not start. Check that it is installed and available on your PATH.')); });
      child.once('close', exitCode => { cleanup(); if (signal.aborted) reject(new Error('Cancelled.')); else resolve({ exitCode, output, truncated, timedOut }); });
      if (signal.aborted) kill();
    });
  }
}
