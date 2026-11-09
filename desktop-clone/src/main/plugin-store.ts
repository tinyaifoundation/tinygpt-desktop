import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Encryption } from './store';
import { pluginConfigSchema, pluginManifestSchema, skillDraftSchema, type SkillDraft, type PluginRecord, type PluginCredentials } from '../shared/plugins';

const recordSchema = z.object({ id: z.uuid(), manifest: pluginManifestSchema, config: pluginConfigSchema, source: z.string().max(4096), installedAt: z.number(), updatedAt: z.number() }).strict();
const stateSchema = z.object({ version: z.literal(1), entries: z.array(recordSchema).max(100), trusted: z.record(z.string(), z.string()), selections: z.record(z.string(), z.array(z.uuid()).max(100)), skillDrafts: z.array(skillDraftSchema).max(100).optional(), useRevisions: z.record(z.string(), z.uuid()).optional() }).strict();
export function startupFingerprint(entry: PluginRecord): string { return createHash('sha256').update(JSON.stringify({ server: entry.manifest.server, version: entry.manifest.version })).digest('hex'); }
export function pluginVisible(entry: PluginRecord, projectId: string | null): boolean { return entry.config.enabled && (entry.config.projectIds === null || projectId !== null && entry.config.projectIds.includes(projectId)); }
export class PluginStore {
  private state: z.infer<typeof stateSchema> = { version: 1, entries: [], trusted: {}, selections: {} };
  private vault: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private encryption: Encryption) {}
  skillPackageRoot(): string { return join(this.directory, 'skill-packages'); }
  async load(): Promise<void> {
    try { this.state = stateSchema.parse(JSON.parse(await readFile(join(this.directory, 'plugins.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved plugins could not be read. Files have been preserved.'); }
    try { this.vault = z.record(z.uuid(), z.string()).parse(JSON.parse(await readFile(join(this.directory, 'plugin-credentials.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved plugin credentials could not be read. Files have been preserved.'); }
  }
  entries(): PluginRecord[] { return structuredClone(this.state.entries); }
  useRevision(id: string): string { this.entry(id); return this.state.useRevisions?.[id] ?? 'initial'; }
  resetUseConsent(id: string): Promise<void> { return this.enqueue(async () => { this.entry(id); const next = structuredClone(this.state); next.useRevisions = { ...next.useRevisions, [id]: randomUUID() }; await this.commit(next); }); }
  skillDrafts(): SkillDraft[] { return structuredClone(this.state.skillDrafts ?? []); }
  saveSkillDraft(draft: SkillDraft): Promise<void> { return this.enqueue(async () => { const next = structuredClone(this.state); const drafts = next.skillDrafts ?? []; next.skillDrafts = [...drafts.filter(item => item.id !== draft.id), skillDraftSchema.parse(draft)]; await this.commit(next); }); }
  removeSkillDraft(id: string): Promise<void> { return this.enqueue(async () => { const next = structuredClone(this.state); next.skillDrafts = (next.skillDrafts ?? []).filter(item => item.id !== id); await this.commit(next); }); }
  entry(id: string): PluginRecord { const entry = this.state.entries.find(item => item.id === id); if (!entry) throw new Error('Plugin not found.'); return structuredClone(entry); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next; }
  private async atomic(filename: string, value: unknown): Promise<void> { await mkdir(this.directory, { recursive: true }); const temporary = join(this.directory, `${filename}.${randomUUID()}.tmp`); await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, join(this.directory, filename)); }
  private async commit(state: typeof this.state): Promise<void> { await this.atomic('plugins.json', stateSchema.parse(state)); this.state = state; }
  save(input: { id?: string; manifest: PluginRecord['manifest']; config: PluginRecord['config'] }, source = 'Configured in TinyGPT'): Promise<PluginRecord> {
    return this.enqueue(async () => {
      const next = structuredClone(this.state); const previous = input.id ? this.entry(input.id) : undefined;
      if (!previous && next.entries.length >= 100) throw new Error('Up to 100 plugins can be installed.');
      if (next.entries.some(entry => entry.id !== input.id && entry.manifest.id === input.manifest.id)) throw new Error('A plugin with this package ID is already installed. Update the existing plugin.');
      const entry = recordSchema.parse({ ...input, id: previous?.id ?? randomUUID(), source: previous?.source ?? source, installedAt: previous?.installedAt ?? Date.now(), updatedAt: Date.now() });
      // Changed identity/endpoint/executable must never inherit credentials or startup consent.
      if (previous && (startupFingerprint(entry) !== startupFingerprint(previous) || entry.manifest.connector !== previous.manifest.connector)) {
        const vault = { ...this.vault }; delete vault[entry.id]; await this.atomic('plugin-credentials.json', vault); this.vault = vault; delete next.trusted[entry.id];
      }
      next.entries = [...next.entries.filter(item => item.id !== entry.id), entry]; await this.commit(next); return entry;
    });
  }
  remove(id: string): Promise<void> { return this.enqueue(async () => { this.entry(id); const next = structuredClone(this.state); next.entries = next.entries.filter(entry => entry.id !== id); delete next.trusted[id]; if (next.useRevisions) delete next.useRevisions[id]; for (const key of Object.keys(next.selections)) next.selections[key] = next.selections[key].filter(item => item !== id); const vault = { ...this.vault }; delete vault[id]; await this.atomic('plugin-credentials.json', vault); this.vault = vault; await this.commit(next); }); }
  trusted(id: string): boolean { return this.state.trusted[id] === startupFingerprint(this.entry(id)); }
  trust(id: string): Promise<void> { return this.enqueue(async () => { const next = structuredClone(this.state); next.trusted[id] = startupFingerprint(this.entry(id)); await this.commit(next); }); }
  hasCredentials(id: string): boolean { return !!this.vault[id]; }
  credentials<T = PluginCredentials>(id: string): T | undefined { if (!this.vault[id]) return; if (!this.encryption.available()) throw new Error('Secure credential storage is unavailable.'); return JSON.parse(this.encryption.decrypt(Buffer.from(this.vault[id], 'base64'))) as T; }
  saveCredentials(id: string, value: unknown | null, expected?: PluginCredentials): Promise<void> { return this.enqueue(async () => {
    if (expected && JSON.stringify(this.credentials(id)) !== JSON.stringify(expected)) throw new Error('Plugin access was revoked.');
    const entry = this.entry(id); const next = { ...this.vault };
    if (entry.manifest.server?.transport === 'stdio' && JSON.stringify(this.credentials(id)?.environment ?? {}) !== JSON.stringify((value as PluginCredentials | null)?.environment ?? {})) { const state = structuredClone(this.state); delete state.trusted[id]; await this.commit(state); }
    if (value === null) delete next[id]; else { if (!this.encryption.available()) throw new Error('Secure credential storage is unavailable.'); next[id] = this.encryption.encrypt(JSON.stringify(value)).toString('base64'); }
    await this.atomic('plugin-credentials.json', next); this.vault = next;
  }); }
  selection(conversationId: string | null, projectId: string | null): string[] { const ids = this.state.selections[conversationId ?? `draft:${projectId ?? 'personal'}`] ?? this.state.selections[`draft:${projectId ?? 'personal'}`]; return this.entries().filter(entry => pluginVisible(entry, projectId) && (!ids || ids.includes(entry.id))).map(entry => entry.id); }
  select(conversationId: string | null, projectId: string | null, ids: string[]): Promise<void> { return this.enqueue(async () => { if (ids.some(id => !pluginVisible(this.entry(id), projectId))) throw new Error('Plugin not available in this Project.'); const next = structuredClone(this.state); next.selections[conversationId ?? `draft:${projectId ?? 'personal'}`] = [...new Set(ids)]; await this.commit(next); }); }
  captureSelection(conversationId: string, projectId: string | null): Promise<void> { return this.select(conversationId, projectId, this.selection(null, projectId)); }
  async flush(): Promise<void> { await this.queue; }
}
