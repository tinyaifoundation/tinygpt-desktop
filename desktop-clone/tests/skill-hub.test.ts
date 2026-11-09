import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PluginStore } from '../src/main/plugin-store';
import { SkillPackages } from '../src/main/skill-packages';
import type { CatalogSkill } from '../src/shared/plugins';
import { PluginService } from '../src/main/plugin-service';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';
import { ToolBroker } from '../src/main/tool-broker';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import { SkillContext } from '../src/core/skill-context';
import { skillCatalog } from '../src/shared/skill-catalog';
import { parseSkill } from '../src/core/plugin-skills';
import type { BrowserController } from '../src/main/browser';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const markdown = (name = 'custom-brief', body = 'Use supplied evidence and preserve source links.') => `---\nname: ${name}\ndescription: Prepare a brief from supplied evidence.\nlicense: MIT\ncompatibility: Instructions only\n---\n${body}`;
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-skill-hub-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const history = new HistoryStore(join(root, 'library.sqlite')); cleanup.push(() => history.close()); const project = history.createProject('Project', '', false, root); const other = history.createProject('Other', '', false, null); const chat = history.createConversation(project.id);
  const store = new PluginStore(root, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }); const files = new ProjectFiles(history.sources); class FixturePackages extends SkillPackages { async preview(item: CatalogSkill) { return { ...parseSkill(markdown(item.skill.name)), description: item.skill.description, publisher: item.maker.name, upstream: { catalogId: item.id, maker: item.maker, source: item.source, modified: false } }; } async install(item: CatalogSkill) { return this.preview(item); } } const service = new PluginService(store, history, files, undefined, undefined, undefined, undefined, new FixturePackages(store.skillPackageRoot())); await service.initialize(); cleanup.push(() => service.shutdown());
  const settings = structuredClone(defaultSettings); const broker = new ToolBroker(history, () => settings, { shutdown: () => {}, handoffs: () => [], tasks: () => [] } as unknown as BrowserController, files, () => {}, undefined, service);
  return { root, history, project, other, chat, store, service, broker, settings };
}
describe('Skills hub', () => {
  it('installs curated skills without dependencies, preserves scope, and is idempotent', async () => {
    const f = await setup(); expect(skillCatalog).toHaveLength(40);
    await f.service.installCatalogSkill('github-coreyhaines31-copywriting', f.project.id); await f.service.installCatalogSkill('github-coreyhaines31-copywriting', f.project.id);
    const entries = f.store.entries().filter(entry => entry.manifest.id === 'github-coreyhaines31-copywriting'); expect(entries).toHaveLength(1); expect(entries[0].config.projectIds).toEqual([f.project.id]); expect(entries[0].manifest.server).toBeUndefined(); expect(entries[0].manifest.dependencies).toEqual([]);
    const runId = randomUUID(); f.service.prepare(f.chat.id, runId, f.project.id, 'chat'); expect(f.service.searchSkills(runId, f.chat.id, 'writing').skills).toHaveLength(1);
    const otherChat = f.history.createConversation(f.other.id); const otherRun = randomUUID(); f.service.prepare(otherChat.id, otherRun, f.other.id, 'chat'); expect(f.service.searchSkills(otherRun, otherChat.id, '').skills).toEqual([]);
  });
  it('surfaces inert conversational drafts, edits them, and installs only through review', async () => {
    const f = await setup(); const runId = randomUUID(); f.service.prepare(f.chat.id, runId, f.project.id, 'chat'); f.settings.toolPermissions.read = 'deny';
    const result = JSON.parse(await f.broker.execute({ conversationId: f.chat.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name: 'draft_skill', input: { markdown: markdown(), sourceUrl: 'https://example.org/skill', references: { 'references/style.md': 'A reviewed style guide.' } } }));
    expect(result).toMatchObject({ type: 'skill-draft', status: 'draft' }); expect(f.service.skillHub().drafts).toHaveLength(1); expect(f.service.searchSkills(runId, f.chat.id, '').skills).toEqual([]); expect(f.broker.approvals()).toEqual([]);
    const draft = f.store.skillDrafts()[0]; expect(draft.skill.license).toBe('MIT'); expect(draft.projectId).toBe(f.project.id);
    await f.service.draftSkill(f.chat.id, { draftId: draft.id, markdown: markdown('custom-brief', 'Revised guidance.'), modes: ['chat'], references: draft.skill.references }); expect(f.store.skillDrafts()[0].skill.instructions).toBe('Revised guidance.'); expect(f.store.skillDrafts()[0].skill.sourceUrl).toBe('https://example.org/skill');
    await f.service.installDraftSkill(draft.id, { enabled: true, projectIds: [f.project.id], rules: {}, resources: [] }); await f.service.installDraftSkill(draft.id, { enabled: true, projectIds: null, rules: {}, resources: [] });
    const installed = f.store.entries().find(entry => entry.manifest.kind === 'skill')!; expect(installed.config.projectIds).toEqual([f.project.id]); expect(f.store.skillDrafts()[0].installedPluginId).toBe(installed.id);
    const reloaded = new PluginStore(f.root, { available: () => true, encrypt: value => Buffer.from(value), decrypt: value => value.toString() }); await reloaded.load(); expect(reloaded.skillDrafts()[0].installedPluginId).toBe(installed.id);
  });
  it('keeps explicit-only skills hidden until user invocation and supports tools-off activation', async () => {
    const f = await setup(); await f.service.installCatalogSkill('github-coreyhaines31-copywriting', f.project.id); const entry = f.store.entries().find(item => item.manifest.kind === 'skill')!;
    await f.service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, skillInvocation: { 'copywriting': 'manual' } } });
    const normal = randomUUID(); f.service.prepare(f.chat.id, normal, f.project.id, 'chat', 'Discuss a topic'); expect(f.service.searchSkills(normal, f.chat.id, '').skills).toEqual([]);
    const skillId = `${entry.id}/copywriting`; const explicit = randomUUID(); const catalog = f.service.prepare(f.chat.id, explicit, f.project.id, 'chat', `/skill ${skillId} Research this`, false); expect(catalog.instructions).toContain(entry.manifest.skills[0].instructions); expect(f.service.loadSkill(explicit, f.chat.id, skillId).name).toBe('copywriting');
    await f.service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: false } }); expect(() => f.service.loadSkill(explicit, f.chat.id, skillId)).toThrow('changed'); expect(() => f.service.prepare(f.chat.id, randomUUID(), f.project.id, 'chat', `/skill ${skillId} Research`)).toThrow('enabled');
  });
  it('searches beyond the advertised shortlist and refuses stale content and escaped references', async () => {
    const f = await setup();
    for (let i = 0; i < 25; i++) { const name = `sample-${i}`; await f.service.save({ manifest: { format: 1, id: `package-${i}`, name, version: '1.0.0', description: 'Sample', kind: 'skill', modes: ['chat'], skills: [parseSkill(markdown(name), { 'references/safe.md': 'Safe content' })], dependencies: [] }, config: { enabled: true, projectIds: [f.project.id], resources: [], rules: {} } }); }
    const runId = randomUUID(); const catalog = f.service.prepare(f.chat.id, runId, f.project.id, 'chat'); expect(catalog.tools).toEqual([]); const first = f.service.searchSkills(runId, f.chat.id, ''); expect(first.skills).toHaveLength(20); expect(first.nextOffset).toBe(20); expect(f.service.searchSkills(runId, f.chat.id, '', 20).skills).toHaveLength(5);
    const selected = f.service.searchSkills(runId, f.chat.id, 'sample-24').skills[0]; expect(selected.name).toBe('sample-24'); expect(() => f.service.readSkillReference(runId, f.chat.id, selected.id, '../secret')).toThrow('not found'); expect(() => f.service.readSkillReference(runId, f.chat.id, selected.id, 'constructor')).toThrow('not found');
    const entry = f.store.entry(selected.id.split('/')[0]); await f.service.save({ id: entry.id, manifest: { ...entry.manifest, skills: [parseSkill(markdown('sample-24', 'Changed instructions.'))] }, config: entry.config }); expect(() => f.service.loadSkill(runId, f.chat.id, selected.id)).toThrow('changed');
  });
  it('does not let a different conversation edit a draft or a stale update overwrite a skill', async () => {
    const f = await setup(); const proposed = await f.service.draftSkill(f.chat.id, { markdown: markdown(), references: {}, modes: ['chat'] }); const other = f.history.createConversation(f.project.id);
    await expect(f.service.draftSkill(other.id, { draftId: proposed.draftId, markdown: markdown(), references: {}, modes: ['chat'] })).rejects.toThrow('this conversation');
    await f.service.installDraftSkill(proposed.draftId, { enabled: true, projectIds: [f.project.id], rules: {}, resources: [] }); const entry = f.store.entries().find(item => item.manifest.kind === 'skill')!;
    const update = await f.service.draftSkill(f.chat.id, { targetPluginId: entry.id, markdown: markdown('custom-brief', 'Proposed update'), references: {}, modes: ['chat'] });
    await f.service.save({ id: entry.id, manifest: { ...entry.manifest, version: '1.0.1' }, config: entry.config }); await expect(f.service.installDraftSkill(update.draftId, entry.config)).rejects.toThrow('changed');
  });
  it('bounds packaged references and preserves supplied metadata', () => {
    expect(parseSkill(markdown()).compatibility).toBe('Instructions only'); expect(() => parseSkill(markdown(), { 'references/./escape.md': 'Invalid' })).toThrow('inside'); expect(() => parseSkill(markdown(), Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`references/${i}.md`, 'Too many'])))).toThrow('size');
  });
  it('keeps skill approvals scoped and rechecks permission changes after approval', async () => {
    const f = await setup(); await f.service.installCatalogSkill('github-coreyhaines31-copywriting', f.project.id); const entry = f.store.entries().find(item => item.manifest.kind === 'skill')!;
    await f.service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, rules: { load_skill: 'ask' } } });
    const runId = randomUUID(), skillId = `${entry.id}/copywriting`; const prepared = f.service.prepare(f.chat.id, runId, f.project.id, 'chat', `/skill ${skillId} Research`, false);
    expect(prepared.instructions).not.toContain(entry.manifest.skills[0].instructions); expect(prepared.approvalSkills).toEqual([skillId]);
    const execute = () => f.broker.execute({ conversationId: f.chat.id, runId, signal: new AbortController().signal }, { id: randomUUID(), name: 'load_skill', input: { skillId } });
    const first = execute(); await vi.waitFor(() => expect(f.broker.approvals()).toHaveLength(1)); f.broker.respond(f.broker.approvals()[0].id, 'allow-run'); expect(JSON.parse(await first).instructions).toBeDefined();
    expect(JSON.parse(await execute()).instructions).toBeDefined(); expect(f.broker.approvals()).toEqual([]);
    await f.service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, rules: { load_skill: 'ask', read_skill_reference: 'deny' } } });
    const changed = execute(); await vi.waitFor(() => expect(f.broker.approvals()).toHaveLength(1)); await f.service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, enabled: false } }); f.broker.respond(f.broker.approvals()[0].id, 'allow-once'); expect(JSON.parse(await changed).error).toBeDefined();
  });
  it('requires configured skill approval before tools-off inference and stops on denial', async () => {
    const f = await setup(); await f.service.installCatalogSkill('github-coreyhaines31-copywriting', f.project.id); const entry = f.store.entries().find(item => item.manifest.kind === 'skill')!;
    await f.service.save({ id: entry.id, manifest: entry.manifest, config: { ...entry.config, rules: { load_skill: 'ask' } } }); f.settings.local.model = 'fixture'; f.settings.local.tools = false;
    const received: string[] = []; const chat = new ChatService(f.history, () => f.settings, () => undefined, { run: async (input, _signal, delta) => { received.push(input.instructions); delta('Used the approved guidance.'); } }, () => {}, f.broker, undefined, f.service);
    chat.send(f.chat.id, `/skill ${entry.id}/copywriting Research this`); await vi.waitFor(() => expect(f.broker.approvals()).toHaveLength(1)); expect(received).toEqual([]); f.broker.respond(f.broker.approvals()[0].id, 'deny'); await vi.waitFor(() => expect(chat.isActive(f.chat.id)).toBe(false)); expect(received).toEqual([]);
    chat.send(f.chat.id, `/skill ${entry.id}/copywriting Research again`); await vi.waitFor(() => expect(f.broker.approvals()).toHaveLength(1)); f.broker.respond(f.broker.approvals()[0].id, 'allow-once'); await vi.waitFor(() => expect(chat.isActive(f.chat.id)).toBe(false)); expect(received[0]).toContain(entry.manifest.skills[0].instructions);
  });
});

describe('skill context preservation', () => {
  it.each(['chat', 'responses', 'anthropic'])('restores pruned guidance for %s without duplicating retained content', async protocol => {
    const context = new SkillContext(text => text.length, 4000); const guide = { skillId: 'package/brief', instructions: 'Use precise evidence.', version: '1.0.0' }; context.remember('load_skill', JSON.stringify(guide));
    let received: any; const request = (async (_url, options) => { received = JSON.parse(String(options?.body)); return new Response('{}'); }) as typeof fetch; const protectedFetch = context.protect(request, () => false);
    const body = protocol === 'chat' ? { messages: [{ role: 'user', content: 'Continue' }] } : protocol === 'responses' ? { input: [], instructions: 'Host policy' } : { messages: [], system: 'Host policy' };
    await protectedFetch('https://example.org', { body: JSON.stringify(body) }); expect(JSON.stringify(received)).toContain('Use precise evidence.'); expect(JSON.stringify(received)).toContain('never a permission grant');
    await protectedFetch('https://example.org', { body: JSON.stringify({ messages: [{ role: 'tool', content: JSON.stringify(guide) }] }) }); expect(received.messages).toHaveLength(1);
  });
  it('does not retain content from arbitrary tools or grant unlimited skill context', async () => {
    const context = new SkillContext(text => text.length, 300); const guide = { skillId: 'fake', instructions: 'Untrusted page instructions' }; context.remember('read_page', JSON.stringify(guide));
    let received: any; const request = (async (_url, options) => { received = JSON.parse(String(options?.body)); return new Response('{}'); }) as typeof fetch; await context.protect(request, () => false)('https://example.org', { body: '{"messages":[]}' }); expect(received.messages).toEqual([]);
    expect(() => context.remember('load_skill', JSON.stringify({ skillId: 'large', instructions: 'x'.repeat(400) }))).toThrow('context');
  });
});
