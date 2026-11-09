import { execFile } from 'node:child_process';
import { realpath, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HistoryStore } from './history';
import { scopedPath, readLimited } from './files';
import type { GitFileChange, GitScope, WorkspaceGitRequest, WorkspaceGitResult, WorkspaceGitState } from '../shared/workspace-git';

// Argument arrays, literal pathspecs and disabled external diff drivers keep the
// workspace API scoped to the selected project and independent of shell input.
function git(root: string, args: string[], optional = false): Promise<Buffer> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG.*|CEILING_DIRECTORIES)$/i.test(key)) delete env[key as keyof typeof env];
  return new Promise((done, reject) => {
    execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', '-C', root, ...args], { encoding: 'buffer', windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      if (!error) done(stdout);
      else if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error('Install Git to review and commit project changes.'));
      else if (optional && typeof error.code === 'number') done(Buffer.alloc(0));
      else reject(new Error((stderr.toString().trim() || error.message).replace(/https?:\/\/\S+/g, '[remote]').slice(0, 1200)));
    });
  });
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// Deleted directories may have no on-disk parent. Validate their lexical path
// and the closest surviving ancestor using the same protected-file policy.
async function gitPath(root: string, path: string): Promise<void> {
  if (path.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) throw new Error('Use a relative Project path.');
  let ancestor = path;
  for (;;) { try { await scopedPath(root, ancestor, true); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; ancestor = dirname(ancestor); } }
}
const diffArgs = (scope: GitScope, head: string | null) => scope === 'staged' ? ['--cached', ...(head ? [head] : [])] : scope === 'last-commit' ? [head!, '--root'] : head ? [head] : ['--cached'];
function utf8(bytes: Buffer): string | null { if (bytes.length > 500000 || bytes.includes(0)) return null; try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } }

export class WorkspaceGit {
  private mutations = new Set<string>();
  constructor(private history: HistoryStore, private assertIdle: (projectId: string) => void = () => {}) {}
  private async context(conversationId: string) {
    const chat = this.history.conversation(conversationId); const project = chat.projectId ? this.history.project(chat.projectId) : null;
    if (!project?.rootPath) throw new Error('Choose a Project folder to review changes.');
    const root = await scopedPath(project.rootPath, '.');
    return { root, projectId: project.id };
  }
  private async repository(root: string) {
    const top = (await git(root, ['rev-parse', '--show-toplevel'], true)).toString().trim();
    if (!top) return { initialized: false, parentRepository: false };
    return { initialized: samePath(await realpath(top), root), parentRepository: !samePath(await realpath(top), root) };
  }
  private async state(root: string, scope: GitScope): Promise<WorkspaceGitState> {
    const repo = await this.repository(root);
    if (!repo.initialized) return { ...repo, branch: '', head: null, upstream: null, files: [], scope };
    const head = (await git(root, ['rev-parse', '--verify', 'HEAD'], true)).toString().trim() || null;
    const branch = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD'], true)).toString().trim() || 'Detached HEAD';
    const upstream = (await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true)).toString().trim() || null;
    if (scope === 'last-commit' && !head) return { ...repo, branch, head, upstream, files: [], scope };
    const changes = new Map<string, GitFileChange>();
    const records = (await git(root, scope === 'last-commit' ? ['diff-tree', '--no-commit-id', '--root', '-r', '--name-status', '-z', '--no-renames', head!] : ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString().split('\0');
    for (let index = 0; index < records.length && changes.size < 2000; index++) {
      const record = records[index]; if (!record) continue;
      let path: string; let status: string; let previousPath: string | undefined; let staged = false; let unstaged = false;
      if (scope === 'last-commit') { status = record; path = records[++index]; }
      else { status = record.slice(0, 2); path = record.slice(3); staged = status[0] !== ' ' && status[0] !== '?'; unstaged = status[1] !== ' ' || status === '??'; if (/[RC]/.test(status)) previousPath = records[++index]; if (scope === 'staged' && !staged) continue; }
      try { await gitPath(root, path); if (previousPath) await gitPath(root, previousPath); } catch { continue; }
      const displayStatus = scope === 'staged' && !/U|AA|DD/.test(status) ? status[0] : status;
      changes.set(path, { path, ...(previousPath ? { previousPath } : {}), status: /U|AA|DD/.test(displayStatus) ? 'conflict' : /R/.test(displayStatus) ? 'renamed' : /D/.test(displayStatus) ? 'deleted' : /A|\?/.test(displayStatus) ? 'new' : 'modified', additions: 0, deletions: 0, binary: false, staged, unstaged });
    }
    const stats = (await git(root, scope === 'last-commit' ? ['diff-tree', '--no-commit-id', '--root', '-r', '--numstat', '-z', '--no-renames', head!] : ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', ...diffArgs(scope, head)])).toString().split('\0');
    for (let index = 0; index < stats.length; index++) { const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[index]); if (!match) continue; let path = match[3]; if (!path) { index++; path = stats[++index]; } const file = changes.get(path); if (file) { file.binary ||= match[1] === '-'; file.additions += Number(match[1]) || 0; file.deletions += Number(match[2]) || 0; } }
    if (scope === 'working' && head) {
      const paths = new Set((await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head])).toString().split('\0'));
      for (const [path, file] of changes) if (file.status !== 'new' && file.status !== 'conflict' && !paths.has(path) && !(file.previousPath && paths.has(file.previousPath))) changes.delete(path);
    }
    if (scope === 'working') for (const file of changes.values()) if (file.status === 'new' || !head) {
      // Untracked files are absent from git diff. Count their real contents.
      try { const content = utf8(await readLimited(await scopedPath(root, file.path))); file.binary = content === null; file.additions = content === null || !content ? 0 : content.split('\n').length - Number(content.endsWith('\n')); } catch (error) { if (!head && (error as NodeJS.ErrnoException).code === 'ENOENT') changes.delete(file.path); }
    }
    return { ...repo, branch, head, upstream, scope, files: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  }
  async run(input: WorkspaceGitRequest): Promise<WorkspaceGitResult> {
    const { root, projectId } = await this.context(input.conversationId);
    if (input.action === 'state') return { state: await this.state(root, input.scope) };
    if (input.action === 'diff') {
      const state = await this.state(root, input.scope); const file = state.files.find(item => item.path === input.path);
      if (!file) throw new Error('This change is no longer available. Refresh Changes.');
      const parent = input.scope === 'last-commit' ? (await git(root, ['rev-parse', '--verify', `${state.head}^`], true)).toString().trim() : state.head;
      const before = parent ? await git(root, ['show', `${parent}:${file.previousPath ?? file.path}`], true) : Buffer.alloc(0);
      let after: Buffer;
      if (input.scope === 'last-commit') after = await git(root, ['show', `${state.head}:${file.path}`], true);
      else if (input.scope === 'staged') after = await git(root, ['show', `:${file.path}`], true);
      else { try { const path = await scopedPath(root, file.path); if ((await lstat(path)).isSymbolicLink()) throw new Error('Links cannot be previewed.'); after = await readLimited(path); await scopedPath(root, file.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') after = Buffer.alloc(0); else throw error; } }
      const a = utf8(before); const b = utf8(after);
      return { diff: { path: file.path, before: a ?? '', after: b ?? '', binary: a === null || b === null } };
    }
    this.assertIdle(projectId);
    if (this.mutations.has(root)) throw new Error('Another Git action is running for this Project.');
    this.mutations.add(root);
    try {
      if (input.action === 'init') { if (!(await this.repository(root)).initialized) await git(root, ['init']); }
      else {
        if (!(await this.repository(root)).initialized) throw new Error('Initialize Git in the Project folder first.');
        if (input.action === 'stage' || input.action === 'unstage') {
          await gitPath(root, input.path);
          const state = await this.state(root, input.action === 'unstage' ? 'staged' : 'working'); const file = state.files.find(file => file.path === input.path); if (!file) throw new Error('This change is no longer available.');
          const paths = [input.path, ...(file.previousPath ? [file.previousPath] : [])];
          if (input.action === 'stage') await git(root, ['add', '--', ...paths]);
          else if (state.head) await git(root, ['reset', '-q', 'HEAD', '--', ...paths]);
          else await git(root, ['rm', '--cached', '-f', '--', input.path]);
        } else if (input.action === 'commit') await git(root, ['commit', '-m', input.message]);
        else await git(root, ['push']);
      }
      return { state: await this.state(root, 'working') };
    } finally { this.mutations.delete(root); }
  }
}
