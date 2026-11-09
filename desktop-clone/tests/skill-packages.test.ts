import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SkillPackages, skillBlobHash } from '../src/main/skill-packages';
import { skillCatalog } from '../src/shared/skill-catalog';
import { skillSourceSchema } from '../src/shared/plugins';
import { PluginStore } from '../src/main/plugin-store';
import { PluginService } from '../src/main/plugin-service';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';
import { ToolBroker } from '../src/main/tool-broker';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-upstream-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const item = structuredClone(skillCatalog.find(item => item.id === 'github-coreyhaines31-copywriting')!);
  const body = 'Preserve this original upstream instruction exactly.\nRead references/guide.md before using scripts/helper.py.';
  const contents: Record<string, Buffer> = { 'SKILL.md': Buffer.from(`---\nname: ${item.skill.name}\ndescription: ${JSON.stringify(item.skill.description)}\nlicense: MIT\n---\n${body}\n`), 'references/guide.md': Buffer.from('Original supporting guidance.\n'), 'scripts/helper.py': Buffer.from('raise RuntimeError("Never execute during installation")\n'), 'assets/icon.png': Buffer.from([137, 80, 78, 71, 0, 255]), 'UPSTREAM-LICENSE.txt': Buffer.from('Original license text.\n') };
  item.source.files = Object.entries(contents).map(([path, bytes]) => ({ path, repositoryPath: `test-package/${path}`, sha: skillBlobHash(bytes), size: bytes.length, kind: path.endsWith('.png') ? 'asset' : 'text' }));
  const request = vi.fn(async (url: string | URL | Request) => { const path = new URL(String(url)).pathname.split('/').slice(4).map(decodeURIComponent).join('/').replace(/^test-package\//, ''); return contents[path] ? new Response(new Uint8Array(contents[path])) : new Response('', { status: 404 }); });
  const packages = new SkillPackages(join(root, 'cache'), request as typeof fetch); cleanup.push(() => packages.close());
  return { root, item, body, contents, request, packages };
}
async function serviceFixture() {
  const f = await fixture(); const history = new HistoryStore(join(f.root, 'history.sqlite')); cleanup.push(() => history.close());
  const project = history.createProject('Project', '', false, f.root), chat = history.createConversation(project.id, 'code');
  const store = new PluginStore(f.root, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() });
  const files = new ProjectFiles(history.sources), service = new PluginService(store, history, files, undefined, undefined, undefined, undefined, f.packages); await service.initialize(); cleanup.push(() => service.shutdown());
  const skill = await f.packages.install(f.item);
  const saved = await service.save({ manifest: { format: 1, id: f.item.id, name: f.item.title, version: '1.0.0', description: 'Upstream package', kind: 'skill', modes: ['chat', 'code'], skills: [skill], dependencies: [] }, config: { enabled: true, projectIds: [project.id], resources: [], rules: {} } });
  const entry = saved.entries.find(entry => entry.manifest.id === f.item.id)!;
  const settings = structuredClone(defaultSettings); const broker = new ToolBroker(history, () => settings, { partition: () => '', shutdown: () => {}, handoffs: () => [], tasks: () => [] } as unknown as BrowserController, files, () => {}, undefined, service);
  const runId = randomUUID(), skillId = `${entry.id}/${skill.name}`; service.prepare(chat.id, runId, project.id, 'code', `/skill ${skillId} Use the skill`);
  const execute = (destination = 'skills') => broker.execute({ conversationId: chat.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name: 'copy_skill_files', input: { skillId, destination } });
  return { ...f, service, history, store, files, project, chat, settings, broker, entry, skill, runId, skillId, execute };
}

describe('verified upstream skill packages', () => {
  it('contains forty real source entries and nine credited makers without bundled instructions', () => {
    expect(skillCatalog).toHaveLength(40); expect(new Set(skillCatalog.map(item => item.maker.id)).size).toBe(9);
    for (const item of skillCatalog) { expect(item.skill).not.toHaveProperty('instructions'); expect(item.source.files.some(file => file.path === 'SKILL.md')).toBe(true); expect(item.source.commit).toMatch(/^[a-f0-9]{40}$/); expect(item.source.url).toContain(item.source.commit); expect(item.popularity.repositoryStars).toBeGreaterThan(0); }
  });
  it('preserves original instructions, scripts, binary assets and licenses, then works offline', async () => {
    const f = await fixture(), skill = await f.packages.install(f.item); expect(skill.instructions).toBe(f.body); expect(skill.upstream?.modified).toBe(false);
    for (const file of f.item.source.files) expect(await f.packages.bytes(f.item.source, file)).toEqual(f.contents[file.path]);
    expect(await f.packages.reference(skill, 'scripts/helper.py')).toEqual({ path: 'scripts/helper.py', text: f.contents['scripts/helper.py'].toString() });
    await expect(f.packages.reference(skill, '../secret')).rejects.toThrow('not found'); await expect(f.packages.reference(skill, 'assets/icon.png')).rejects.toThrow('not found');
    f.request.mockImplementation(async () => { throw Error('Offline'); }); expect((await f.packages.install(f.item)).instructions).toBe(f.body);
  });
  it('rejects changed upstream bytes before returning an installable package', async () => {
    const f = await fixture(); f.contents['scripts/helper.py'] = Buffer.from('tampered'); await expect(f.packages.install(f.item)).rejects.toThrow(/changed|verified size/);
  });
  it('detects corrupt cached files and repairs only the pinned original bytes', async () => {
    const f = await fixture(), skill = await f.packages.install(f.item); const packetRoot = join(f.root, 'cache', (await readdir(join(f.root, 'cache')))[0]);
    await writeFile(join(packetRoot, 'references/guide.md'), 'changed'); await expect(f.packages.reference(skill, 'references/guide.md')).rejects.toThrow('changed');
    await f.packages.install(f.item); expect((await f.packages.reference(skill, 'references/guide.md')).text).toBe('Original supporting guidance.\n');
  });
  it('refuses escaped, duplicate and oversized paths in catalog metadata', async () => {
    const f = await fixture(); for (const path of ['../secret', '/absolute', 'scripts/./helper.py', 'NUL.txt', 'scripts//helper.py']) expect(skillSourceSchema.safeParse({ ...f.item.source, files: [{ ...f.item.source.files[0], path }] }).success).toBe(false);
    expect(skillSourceSchema.safeParse({ ...f.item.source, files: [f.item.source.files[0], f.item.source.files[0]] }).success).toBe(false);
    expect(skillSourceSchema.safeParse({ ...f.item.source, files: [{ ...f.item.source.files[0], size: 1024 * 1024 + 1 }] }).success).toBe(false);
  });
  it('refuses cache directory links before writing outside its package', async () => {
    const f = await fixture(); await f.packages.install(f.item); const packetRoot = join(f.root, 'cache', (await readdir(join(f.root, 'cache')))[0]), outside = join(f.root, 'outside'); await mkdir(outside);
    await rm(join(packetRoot, 'scripts'), { recursive: true }); await symlink(outside, join(packetRoot, 'scripts'), 'junction');
    await expect(f.packages.install(f.item)).rejects.toThrow('storage changed'); expect(await readdir(outside)).toEqual([]);
  });
  it('copies an intact package only after write approval and never replaces existing files', async () => {
    const f = await serviceFixture(); f.settings.toolPermissions.write = 'ask'; const pending = f.execute(); await vi.waitFor(() => expect(f.broker.approvals()).toHaveLength(1));
    await expect(readFile(join(f.root, 'skills', f.skill.name, 'SKILL.md'))).rejects.toThrow(); f.broker.respond(f.broker.approvals()[0].id, 'allow-once'); const result = JSON.parse(await pending); expect(result.files).toHaveLength(5); expect(result.error).toBeUndefined();
    for (const [path, bytes] of Object.entries(f.contents)) expect(await readFile(join(f.root, 'skills', f.skill.name, path))).toEqual(bytes);
    f.settings.toolPermissions.write = 'allow'; expect(JSON.parse(await f.execute()).error).toContain('new destination');
  });
  it('honors denied writes, skill read approval and Code-only availability', async () => {
    const f = await serviceFixture(); f.settings.toolPermissions.write = 'deny'; expect(JSON.parse(await f.execute()).error).toContain('blocked'); expect(f.broker.approvals()).toEqual([]);
    f.settings.toolPermissions.write = 'allow'; await f.service.save({ id: f.entry.id, manifest: f.entry.manifest, config: { ...f.entry.config, rules: { load_skill: 'ask' } } }); expect(JSON.parse(await f.execute()).error).toContain('Load and approve');
    f.history.setConversationMode(f.chat.id, 'chat'); expect(JSON.parse(await f.execute()).error).toContain('only in Work');
  });
  it('pages large original references without truncating the saved package', async () => {
    const f = await serviceFixture(), file = f.item.source.files.find(file => file.path === 'references/guide.md')!;
    const text = 'x'.repeat(20000); f.contents[file.path] = Buffer.from(text); file.size = 20000; file.sha = skillBlobHash(f.contents[file.path]);
    await f.packages.install(f.item); const manifest = { ...f.entry.manifest, skills: [{ ...f.skill, upstream: { ...f.skill.upstream!, source: f.item.source } }] };
    await f.service.save({ id: f.entry.id, manifest, config: f.entry.config }); f.service.prepare(f.chat.id, f.runId, f.project.id, 'code', `/skill ${f.skillId} Continue`);
    const first = await f.service.loadSkillReference(f.runId, f.chat.id, f.skillId, file.path), second = await f.service.loadSkillReference(f.runId, f.chat.id, f.skillId, file.path, first.nextOffset!);
    expect(first.text + second.text).toBe(text); expect(first.nextOffset).toBe(16000); expect(second.nextOffset).toBeNull();
  });
  it('retains attribution for custom updates and repairs resources without replacing the customization', async () => {
    const f = await serviceFixture(); const draft = await f.service.draftSkill(f.chat.id, { targetPluginId: f.entry.id, markdown: `---\nname: ${f.skill.name}\ndescription: Custom version\n---\nReviewed custom instructions`, references: {}, modes: ['code'] });
    await f.service.installDraftSkill(draft.draftId, f.entry.config); const updated = f.store.entry(f.entry.id); expect(updated.manifest.skills[0].upstream?.modified).toBe(true); expect(updated.manifest.skills[0].upstream?.maker).toEqual(f.item.maker);
    const originalInstall = f.packages.install.bind(f.packages); vi.spyOn(f.packages, 'install').mockImplementation(() => originalInstall(f.item));
    await f.service.installCatalogSkill(f.item.id, null); expect(f.store.entry(f.entry.id).manifest.skills[0].instructions).toBe('Reviewed custom instructions'); expect(f.store.entry(f.entry.id).config.projectIds).toEqual([f.project.id]);
  });
  it('stops a copy when permission is revoked and records the partial result as an error', async () => {
    const f = await serviceFixture(); f.settings.toolPermissions.write = 'allow'; const original = f.files.writeNewPackageFile.bind(f.files);
    vi.spyOn(f.files, 'writeNewPackageFile').mockImplementation(async (...args) => { const result = await original(...args); f.settings.toolPermissions.write = 'deny'; return result; });
    const result = JSON.parse(await f.execute()); expect(result.error).toContain('stopped'); expect(result.files).toHaveLength(1); expect(f.history.conversation(f.chat.id).tools.at(-1)?.status).toBe('error');
  });
});
