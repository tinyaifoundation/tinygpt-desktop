import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Serialize replacements of each artifact; Windows cannot rename competing writers. */
export class AuditArtifactWriter {
  private pending = new Map<string, Promise<void>>();
  constructor(private root: string) {}
  write(path: string, snapshot: string) {
    const next = (this.pending.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const target = join(this.root, path), temporary = target + '.' + randomUUID() + '.tmp';
      await mkdir(dirname(target), { recursive: true }); await writeFile(temporary, snapshot);
      for (let attempt = 0;; attempt++) {
        try { await rename(temporary, target); break; }
        catch (error) {
          if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
    });
    this.pending.set(path, next);
    return next.finally(() => { if (this.pending.get(path) === next) this.pending.delete(path); });
  }
}
