import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseSkill } from '../core/plugin-skills';
import { skillSourceSchema, type CatalogSkill, type PluginSkill, type SkillSource, type SkillPackageFile } from '../shared/plugins';
import { insideRoot } from './files';

export function skillBlobHash(bytes: Uint8Array): string { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
export class SkillPackages {
  private controller = new AbortController();
  private pending = new Map<string, Promise<void>>();
  constructor(private directory: string, private request: typeof fetch = fetch) { this.directory = resolve(directory); }
  close(): void { this.controller.abort(); }
  private root(source: SkillSource): string { return join(this.directory, createHash('sha256').update(JSON.stringify([source.repository, source.commit, source.directory])).digest('hex')); }
  private async path(source: SkillSource, file: SkillPackageFile, create = false): Promise<string> {
    const root = this.root(source), target = resolve(root, file.path);
    if (!insideRoot(root, target)) throw Error('Skill resource is outside its package.');
    if (create) {
      const base = await realpath(this.directory); if (!insideRoot(this.directory, base) || !insideRoot(base, this.directory)) throw Error('Skill package storage changed.'); let parent = this.directory;
      for (const part of [root.slice(this.directory.length + 1), ...file.path.split('/').slice(0, -1)]) { parent = join(parent, part); try { const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Skill package storage changed.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; try { await mkdir(parent); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; } } const info = await lstat(parent); if (!info.isDirectory() || info.isSymbolicLink() || !insideRoot(base, await realpath(parent))) throw Error('Skill package storage changed.'); }
    }
    const base = await realpath(this.directory), parent = await realpath(dirname(target)); if (!insideRoot(this.directory, base) || !insideRoot(base, this.directory) || !insideRoot(base, parent)) throw Error('Skill package storage changed.');
    try { if ((await lstat(target)).isSymbolicLink()) throw Error('Skill resources must be regular files.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return target;
  }
  async bytes(source: SkillSource, file: SkillPackageFile): Promise<Buffer> {
    const path = await this.path(source, file), info = await lstat(path);
    if (!info.isFile() || info.size !== file.size) throw Error('Skill package file changed. Re-add the skill to repair its files.');
    const handle = await open(path, 'r'); let bytes: Buffer;
    try { if ((await handle.stat()).size !== file.size) throw Error('Skill package file changed.'); bytes = Buffer.alloc(file.size); let offset = 0; while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw Error('Skill package file changed.'); offset += result.bytesRead; } if ((await handle.stat()).size !== file.size) throw Error('Skill package file changed.'); } finally { await handle.close(); }
    if (skillBlobHash(bytes) !== file.sha) throw Error('Skill package file changed. Re-add the skill to repair its files.'); return bytes;
  }
  private async fetchFile(source: SkillSource, file: SkillPackageFile): Promise<Buffer> {
    const path = file.repositoryPath.split('/').map(encodeURIComponent).join('/');
    const response = await this.request(`https://raw.githubusercontent.com/${source.repository}/${source.commit}/${path}`, { redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]), headers: { Accept: 'application/octet-stream' } });
    if (!response.ok) throw Error('The upstream skill could not be downloaded. Check your connection and try again.');
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { if (reader) while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > file.size || size > 1024 * 1024) throw Error('The upstream package does not match its verified size.'); chunks.push(chunk.value); } } finally { await reader?.cancel().catch(() => {}); }
    const bytes = Buffer.concat(chunks); if (bytes.length !== file.size || skillBlobHash(bytes) !== file.sha) throw Error('The upstream package changed. Installation stopped before enabling the skill.'); return bytes;
  }
  async preview(item: CatalogSkill): Promise<PluginSkill> {
    skillSourceSchema.parse(item.source);
    const main = item.source.files.find(file => file.path === 'SKILL.md'); if (!main) throw Error('This catalog entry has no original SKILL.md.');
    let bytes: Buffer; try { bytes = await this.bytes(item.source, main); } catch { bytes = await this.fetchFile(item.source, main); }
    const skill = parseSkill(utf8(bytes)); if (skill.name !== item.skill.name || skill.description !== item.skill.description) throw Error('The original skill does not match its catalog metadata.');
    return { ...skill, publisher: item.maker.name, sourceUrl: item.source.url, requirements: item.skill.requirements, upstream: { catalogId: item.id, maker: item.maker, source: item.source, modified: false } };
  }
  async install(item: CatalogSkill): Promise<PluginSkill> {
    const skill = await this.preview(item); const key = this.root(item.source);
    if (!this.pending.has(key)) {
      const work = (async () => {
        await mkdir(this.directory, { recursive: true }); let index = 0;
        const outcomes = await Promise.allSettled(Array.from({ length: Math.min(6, item.source.files.length) }, async () => {
          while (index < item.source.files.length) { const file = item.source.files[index++]; try { await this.bytes(item.source, file); continue; } catch { /* Download/repair only this pinned public file. */ }
            const bytes = await this.fetchFile(item.source, file); const path = await this.path(item.source, file, true), temporary = `${path}.${randomUUID()}.tmp`; this.controller.signal.throwIfAborted(); await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, path);
          }
        }));
        const failed = outcomes.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
      })(); this.pending.set(key, work); void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); }).catch(() => {});
    }
    await this.pending.get(key); this.controller.signal.throwIfAborted(); return skill;
  }
  async reference(skill: PluginSkill, path: string): Promise<{ text: string; path: string }> {
    const source = skill.upstream?.source, file = source?.files.find(file => file.path === path && file.kind === 'text');
    if (!source || !file) throw Error('Skill reference not found or unavailable as text.');
    return { path, text: utf8(await this.bytes(source, file)) };
  }
}
