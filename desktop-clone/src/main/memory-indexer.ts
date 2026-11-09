import { readdir, lstat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { HistoryStore } from './history';
import { readLimited, extractFile, scopedPath, textExtensions } from './files';
import { contentHash } from './memory-library';

const excluded = new Set(['node_modules', '.git', '.ssh', '.aws', '.codex', '.agents', '.cache', 'dist', 'build', 'out', 'release', 'coverage', 'vendor', '.next', '.venv', '__pycache__']);
const protectedFile = /^(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(rsa|ed25519|dsa)|.*\.(pem|pfx|key|p12))$/i;
export class MemoryIndexer {
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private history: HistoryStore, private readAllowed: () => boolean, private changed: () => void) {}
  start(): void {
    this.timer = setInterval(() => this.refreshEnabled(), 15000); this.timer.unref(); this.refreshEnabled();
  }
  refreshEnabled(): void { if (!this.stopped) for (const index of this.history.memory.indexes()) if (index.enabled) void this.refresh(index.projectId); }
  async configure(projectId: string, action: 'enable' | 'disable' | 'refresh' | 'forget'): Promise<void> {
    if (action !== 'refresh') await this.cancel(projectId);
    if (action === 'forget') this.history.memory.forgetIndex(projectId);
    else if (action !== 'refresh') this.history.memory.configureIndex(projectId, action === 'enable');
    if (action === 'enable' || action === 'refresh') await this.refresh(projectId, true);
    this.changed();
  }
  refresh(projectId: string, force = false): Promise<void> {
    const running = this.active.get(projectId); if (running) return running.done;
    if (this.stopped) return Promise.resolve();
    const controller = new AbortController();
    const done = this.scan(projectId, controller.signal, force).finally(() => { this.active.delete(projectId); if (!this.stopped) this.changed(); });
    this.active.set(projectId, { controller, done }); return done;
  }
  private async scan(projectId: string, signal: AbortSignal, force: boolean): Promise<void> {
    const index = this.history.memory.indexes().find(item => item.projectId === projectId); if (!index?.enabled) return;
    if (!this.readAllowed()) { this.history.memory.indexState(projectId, 'paused', 'File reads are blocked in permissions.'); return; }
    const root = this.history.project(projectId).rootPath;
    if (!root || root !== index.rootPath) { this.history.memory.configureIndex(projectId, false); return; }
    const seen = new Set<string>(); let skipped = 0, files = 0, characters = 0, visited = 0; let truncated = false;
    this.history.memory.indexState(projectId, 'indexing'); this.changed();
    try {
      await scopedPath(root, '.');
      const walk = async (relative: string, rules: { base: string; filter: Ignore }[], depth: number): Promise<void> => {
        signal.throwIfAborted(); if (!this.readAllowed()) throw new Error('Reads blocked.');
        if (depth > 20 || visited > 10000 || files >= 500 || characters >= 5000000) { truncated = true; return; }
        const directory = await scopedPath(root, relative || '.');
        // Never follow directory links, including Windows junctions.
        if ((await lstat(join(root, relative))).isSymbolicLink()) return;
        let localRules = rules;
        try {
          const gitignore = await scopedPath(root, join(relative, '.gitignore'));
          const bytes = await readLimited(gitignore);
          if (bytes.length <= 100000) localRules = [...rules, { base: relative.replaceAll('\\', '/'), filter: ignore().add(bytes.toString('utf8')) }];
        } catch { /* A missing ignore file is normal; built-in exclusions still apply. */ }
        const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          signal.throwIfAborted(); if (!this.readAllowed()) throw new Error('Reads blocked.');
          if (++visited > 10000 || files >= 500 || characters >= 5000000) { truncated = true; return; }
          if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase()) || protectedFile.test(entry.name)) { skipped++; continue; }
          const path = join(relative, entry.name).replaceAll('\\', '/');
          let ignored = false;
          for (const rule of localRules) { const child = rule.base ? path.slice(rule.base.length + 1) : path; const result = rule.filter.test(child + (entry.isDirectory() ? '/' : '')); if (result.ignored) ignored = true; else if (result.unignored) ignored = false; }
          if (ignored) { skipped++; continue; }
          if (entry.isDirectory()) { await walk(path, localRules, depth + 1); continue; }
          if (!entry.isFile() || !(textExtensions.has(extname(path).toLowerCase()) || ['.pdf', '.docx', '.xlsx', '.pptx', '.odt'].includes(extname(path).toLowerCase()))) { skipped++; continue; }
          if (this.history.memory.excluded(projectId, root, path)) { seen.add(path); skipped++; continue; }
          try {
            const canonical = await scopedPath(root, path);
            const before = await lstat(canonical); if (!before.isFile() || before.isSymbolicLink() || before.size > 2000000) { skipped++; continue; }
            const fingerprint = `${before.size}:${before.mtimeMs}:${before.ctimeMs}:${before.ino}:${before.dev}`;
            const previous = this.history.memory.file(projectId, path);
            if (!force && previous?.fingerprint === fingerprint) { seen.add(path); files++; characters += previous.characters; continue; }
            const bytes = await readLimited(canonical); const text = await extractFile(canonical, bytes, signal);
            const after = await lstat(canonical);
            signal.throwIfAborted(); if (!this.readAllowed()) throw new Error('Reads blocked.');
            if (await scopedPath(root, path) !== canonical || before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino || this.history.project(projectId).rootPath !== root) throw new Error('File changed.');
            if (this.history.memory.excluded(projectId, root, path)) { skipped++; continue; }
            characters += text.length; files++; seen.add(path);
            if (previous?.hash === contentHash(text)) { this.history.memory.db.prepare('UPDATE knowledge_documents SET fingerprint=? WHERE id=?').run(fingerprint, previous.id); continue; }
            this.history.memory.upsert({ id: previous?.id, projectId, kind: 'indexed-file', title: path, path, rootPath: root, text, size: bytes.length, fingerprint });
            // Remove potentially stale explicitly read copies from every chat in this Project.
            this.history.memory.db.prepare("DELETE FROM sources WHERE project_id=? AND kind='project-file' AND url=?").run(projectId, `project-file:${path}`);
          } catch (error) { signal.throwIfAborted(); if (!this.readAllowed()) throw error; skipped++; }
        }
      };
      await walk('', [], 0); signal.throwIfAborted();
      // Prune only after a complete enumeration. Limited/failed scans cannot infer deletion.
      if (!truncated) this.history.memory.pruneFiles(projectId, seen);
      this.history.memory.indexState(projectId, 'ready', truncated ? 'Index limit reached: 500 files, 5 million characters, or 10,000 entries. Choose a smaller folder for complete coverage.' : 'Folder checked; changes will be refreshed while TinyGPT is open.', skipped);
    } catch (error) {
      this.history.memory.indexState(projectId, signal.aborted ? 'paused' : 'error', signal.aborted ? 'Indexing stopped.' : 'Folder could not be fully indexed. Check access and file-read permissions.', skipped);
    }
  }
  async cancel(projectId: string): Promise<void> { const task = this.active.get(projectId); if (task) { task.controller.abort(); await task.done; } }
  async shutdown(): Promise<void> { this.stopped = true; clearInterval(this.timer); await Promise.all([...this.active.keys()].map(id => this.cancel(id))); }
}
