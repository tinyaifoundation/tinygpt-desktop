import { dialog } from 'electron';
import { readFile, readdir, lstat, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pluginSaveSchema, pluginManifestSchema, pluginCredentialsSchema, pluginSelectionSchema, skillDraftInputSchema, pluginConfigSchema } from '../shared/plugins';
import { parseSkill } from '../core/plugin-skills';
import type { PluginService } from './plugin-service';
import type { HistoryStore } from './history';
import type { Settings } from '../shared/config';
import { insideRoot } from './files';
import { suggestedConnectorSchema } from '../shared/plugins';
import { googleDesktopClientSchema } from './connector-oauth';

export const pluginErrors = ['This connection request is no longer current.', 'This connector does not match the request.', 'Choose a Google Desktop app client JSON file.', 'Set up the connector app before signing in.', 'Plugin not found.', 'Enable the plugin before connecting.', 'This plugin is already connecting.', 'Authorize local server startup before connecting.', 'Local server startup is disabled in Settings.', 'Plugin not available in this Project.', 'Connect this plugin before browsing resources.', 'Reading is disabled in Settings.', 'Connect an enabled plugin available to this Project.', 'Browse resources before selecting one.', 'This resource has no readable text.', 'Connect the plugin and enable reading before refreshing.', 'Plugin access was revoked.', 'Built-in plugin contents cannot be replaced.', 'Built-in plugins can be disabled but not uninstalled.', 'A plugin with this package ID is already installed. Update the existing plugin.', 'Up to 100 plugins can be installed.', 'This package needs a different plugin entry. Import it as a new plugin.', 'Select a JSON plugin manifest or SKILL.md.', 'Plugin packages must be 512 KB or smaller.', 'Skill references must be regular files inside the selected package.', 'SKILL.md needs name and description in YAML frontmatter.', 'Skill metadata could not be read.', 'Skills must be 28,000 characters or fewer.', 'Plugin import expired. Choose the file again.', 'Imported packages cannot replace built-in code.'];
export function registerPluginIPC(handle: <T>(channel: string, action: (input: unknown) => T | Promise<T>) => void, plugins: PluginService, history: HistoryStore, settings: () => Settings): void {
  const imports = new Map<string, { source: string; expires: number }>();
  handle('tinygpt:plugins', () => plugins.snapshot());
  handle('tinygpt:skills', () => plugins.skillHub());
  handle('tinygpt:skill-catalog-preview', input => plugins.track(() => plugins.previewCatalogSkill(z.string().max(61).parse(input))));
  handle('tinygpt:skill-install', input => { const { id, projectId } = z.object({ id: z.string().max(120), projectId: z.uuid().nullable() }).strict().parse(input); return plugins.track(() => plugins.installCatalogSkill(id, projectId)); });
  handle('tinygpt:skill-draft', value => { const { input, projectId } = z.object({ input: skillDraftInputSchema, projectId: z.uuid().nullable() }).strict().parse(value); return plugins.track(async () => { await plugins.draftSkill(null, input, projectId); return plugins.skillHub(); }); });
  handle('tinygpt:skill-draft-install', input => { const { id, config } = z.object({ id: z.uuid(), config: pluginConfigSchema }).strict().parse(input); return plugins.track(() => plugins.installDraftSkill(id, config)); });
  handle('tinygpt:skill-draft-dismiss', input => plugins.track(() => plugins.dismissSkillDraft(z.uuid().parse(input))));
  handle('tinygpt:connector-install', input => plugins.track(() => plugins.installConnector(suggestedConnectorSchema.parse(input))));
  handle('tinygpt:connector-google-configure', input => {
    const { id, clientId, clientSecret } = z.object({ id: z.uuid(), clientId: googleDesktopClientSchema.shape.installed.shape.client_id, clientSecret: googleDesktopClientSchema.shape.installed.shape.client_secret }).strict().parse(input);
    if (!['google', 'gmail', 'gdrive', 'gcalendar'].includes(plugins.store.entry(id).manifest.connector ?? '')) throw new Error('This connector does not match the request.');
    return plugins.track(() => plugins.credentials(id, { connectorAuth: { provider: 'google', clientId, clientSecret } }));
  });
  handle('tinygpt:connector-signin', input => { const { id, allowSend } = z.object({ id: z.uuid(), allowSend: z.boolean() }).strict().parse(input); return plugins.track(() => plugins.signIn(id, allowSend)); });
  handle('tinygpt:connector-google-app', async input => {
    const id = z.uuid().parse(input); const entry = plugins.store.entry(id); if (!['google', 'gmail', 'gdrive', 'gcalendar'].includes(entry.manifest.connector ?? '')) throw new Error('This connector does not match the request.');
    const choice = await dialog.showOpenDialog({ title: 'Import Google Desktop OAuth client', properties: ['openFile'], filters: [{ name: 'Google client JSON', extensions: ['json'] }] }); if (choice.canceled || !choice.filePaths[0]) return plugins.snapshot();
    const info = await stat(choice.filePaths[0]); if (!info.isFile() || info.size > 32000) throw new Error('Choose a Google Desktop app client JSON file.');
    const parsed = googleDesktopClientSchema.safeParse(JSON.parse(await readFile(choice.filePaths[0], 'utf8'))); if (!parsed.success) throw new Error('Choose a Google Desktop app client JSON file.');
    return plugins.track(() => plugins.credentials(id, { connectorAuth: { provider: 'google', clientId: parsed.data.installed.client_id, clientSecret: parsed.data.installed.client_secret } }));
  });
  handle('tinygpt:connector-github-app', input => { const { id, clientId } = z.object({ id: z.uuid(), clientId: z.string().trim().regex(/^[A-Za-z0-9]{10,100}$/) }).strict().parse(input); if (plugins.store.entry(id).manifest.connector !== 'github') throw new Error('This connector does not match the request.'); return plugins.track(() => plugins.credentials(id, { connectorAuth: { provider: 'github', clientId } })); });
  handle('tinygpt:plugin-save', async input => {
    const { importId, ...draft } = pluginSaveSchema.extend({ importId: z.uuid().optional() }).parse(input);
    const grant = importId ? imports.get(importId) : undefined; if (importId && (!grant || grant.expires < Date.now())) throw new Error('Plugin import expired. Choose the file again.');
    if (draft.id && plugins.store.entry(draft.id).manifest.id !== draft.manifest.id) throw new Error('This package needs a different plugin entry. Import it as a new plugin.');
    const result = await plugins.track(() => plugins.save(draft, grant?.source)); if (importId) imports.delete(importId); return result;
  });
  handle('tinygpt:plugin-import', async () => {
    const choice = await dialog.showOpenDialog({ title: 'Import a plugin or skill', properties: ['openFile'], filters: [{ name: 'Plugin manifest or skill', extensions: ['json', 'md'] }] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const path = await realpath(choice.filePaths[0]); const info = await stat(path); if (!info.isFile() || info.size > 512 * 1024) throw new Error('Plugin packages must be 512 KB or smaller.');
    const content = await readFile(path, 'utf8'); let manifest;
    if (basename(path).toLowerCase() === 'skill.md') {
      const root = dirname(path); const references: Record<string, string> = {}; let total = 0;
      const referenceRoot = join(root, 'references');
      try {
        const listing = await readdir(referenceRoot, { withFileTypes: true });
        if ((await lstat(referenceRoot)).isSymbolicLink()) throw new Error('Skill references must be regular files inside the selected package.');
        for (const file of listing.slice(0, 8)) {
          if (file.isSymbolicLink()) throw new Error('Skill references must be regular files inside the selected package.');
          if (!file.isFile() || !/\.(md|txt|json)$/i.test(file.name)) continue;
          const referencePath = await realpath(join(referenceRoot, file.name)); if (!insideRoot(root, referencePath)) throw new Error('Skill references must be regular files inside the selected package.');
          const info = await stat(referencePath); if (info.size > 32000 || total + info.size > 100000) continue; total += info.size; references[`references/${file.name}`] = await readFile(referencePath, 'utf8');
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const skill = parseSkill(content, references); const slug = skill.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 45);
      manifest = pluginManifestSchema.parse({ format: 1, id: `skill-${slug || randomUUID().slice(0, 8)}`, name: skill.name, version: '1.0.0', description: skill.description, kind: 'skill', skills: [skill] });
    } else if (/\.json$/i.test(path)) { manifest = pluginManifestSchema.parse(JSON.parse(content)); if (manifest.kind === 'builtin') throw new Error('Imported packages cannot replace built-in code.'); }
    else throw new Error('Select a JSON plugin manifest or SKILL.md.');
    if (imports.size >= 20) imports.clear(); const importId = randomUUID(); imports.set(importId, { source: path, expires: Date.now() + 10 * 60000 }); return { manifest, importId };
  });
  handle('tinygpt:plugin-export', async input => { const entry = plugins.store.entry(z.uuid().parse(input)); const choice = await dialog.showSaveDialog({ title: 'Export plugin manifest', defaultPath: `${entry.manifest.id}.json`, filters: [{ name: 'Plugin manifest', extensions: ['json'] }] }); if (!choice.canceled && choice.filePath) { await writeFile(choice.filePath, JSON.stringify(entry.manifest, null, 2), { mode: 0o600 }); return true; } return false; });
  handle('tinygpt:plugin-connect', async input => {
    const id = z.uuid().parse(input); const entry = plugins.store.entry(id);
    if (entry.manifest.server?.transport === 'stdio') {
      if (settings().toolPermissions.execute === 'deny') throw new Error('Local server startup is disabled in Settings.');
      if (!plugins.store.trusted(id)) {
        const server = entry.manifest.server; const answer = await dialog.showMessageBox({ type: 'warning', title: `Run ${entry.manifest.name}?`, message: 'Allow this local MCP server to run on your computer?', detail: `Executable: ${server.command}\nArguments: ${JSON.stringify(server.args)}\nEnvironment names: ${server.environment.join(', ') || 'None'}\n\nThis server runs with your OS permissions, including possible file and network access. TinyGPT approvals control calls from the assistant; they do not sandbox the server itself. No dependencies are installed automatically. Startup consent is remembered for this configuration.`, buttons: ['Cancel', 'Allow server startup'], defaultId: 0, cancelId: 0, noLink: true });
        if (answer.response !== 1) return plugins.snapshot();
        // Consent belongs to the configuration that was displayed.
        if (JSON.stringify(plugins.store.entry(id).manifest) !== JSON.stringify(entry.manifest)) throw new Error('Plugin access was revoked.');
        await plugins.store.trust(id);
      }
    }
    return plugins.track(() => plugins.connect(id));
  });
  handle('tinygpt:plugin-disconnect', input => { const { id, forget } = z.object({ id: z.uuid(), forget: z.boolean() }).strict().parse(input); return plugins.track(() => plugins.disconnect(id, forget)); });
  handle('tinygpt:plugin-remove', input => plugins.track(() => plugins.remove(z.uuid().parse(input))));
  handle('tinygpt:plugin-credentials', input => { const { id, credentials } = z.object({ id: z.uuid(), credentials: pluginCredentialsSchema }).strict().parse(input); return plugins.track(() => plugins.credentials(id, credentials)); });
  handle('tinygpt:plugin-browse', input => { const { id, query } = z.object({ id: z.uuid(), query: z.string().max(500) }).strict().parse(input); return plugins.track(() => plugins.browse(id, query)); });
  handle('tinygpt:plugin-resource', input => { const { id, uri, projectId } = z.object({ id: z.uuid(), uri: z.string().max(2048), projectId: z.uuid() }).strict().parse(input); return plugins.track(() => plugins.importResource(id, uri, projectId)); });
  handle('tinygpt:plugin-resource-refresh', input => plugins.track(() => plugins.refreshResources(z.uuid().parse(input))));
  handle('tinygpt:plugin-resource-forget', input => { const { id, uri, projectId } = z.object({ id: z.uuid(), uri: z.string().max(2048), projectId: z.uuid() }).strict().parse(input); return plugins.track(() => plugins.forgetResource(id, uri, projectId)); });
  const context = z.object({ conversationId: z.uuid().nullable(), projectId: z.uuid().nullable() }).strict();
  handle('tinygpt:plugin-selection', input => { const value = context.parse(input); if (value.conversationId && history.conversation(value.conversationId).projectId !== value.projectId) throw new Error('Plugin not available in this Project.'); if (value.projectId) history.project(value.projectId); return plugins.store.selection(value.conversationId, value.projectId); });
  handle('tinygpt:plugin-select', async input => { const value = pluginSelectionSchema.parse(input); if (value.conversationId && history.conversation(value.conversationId).projectId !== value.projectId) throw new Error('Plugin not available in this Project.'); if (value.projectId) history.project(value.projectId); await plugins.store.select(value.conversationId, value.projectId, value.ids); plugins.notifyChanged(); return plugins.store.selection(value.conversationId, value.projectId); });
}
