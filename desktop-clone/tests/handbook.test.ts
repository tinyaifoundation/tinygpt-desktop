import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { defaultSettings } from '../src/shared/config';
import { handbookArticles, handbookSourceId, searchHandbook, readHandbook, handbookContext } from '../src/core/handbook';
import { settingsSearchEntries } from '../src/renderer/lib/settings-search';
import { toolDefinitions, toolArguments } from '../src/shared/tools';
import { WorkToolCatalog } from '../src/core/work-tool-catalog';
import { RagIndex } from '../src/main/rag-index';
import { MemoryService } from '../src/main/memory-service';
import { ChatService } from '../src/main/chat-service';
import type { ChatExecution } from '../src/shared/chat';

const stores: HistoryStore[] = [], folders: string[] = [];
function store(path = ':memory:') { const h = new HistoryStore(path); h.memory.syncHandbook(); stores.push(h); return h; }
afterEach(() => { for (const h of stores.splice(0)) h.close(); for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true }); });

it('covers every settings-search entry and uses unique stable citation IDs', () => {
  expect(new Set(handbookArticles.map(a => handbookSourceId(a.id))).size).toBe(handbookArticles.length);
  for (const entry of settingsSearchEntries) {
    const article = handbookArticles.find(a => a.title === `Settings: ${entry.section}`);
    expect(article?.text).toContain(`## ${entry.title}\n`);
  }
  expect(handbookArticles.length).toBeGreaterThanOrEqual(29);
});

it.each([
  ['How do I skip first-launch onboarding and reopen Welcome to TinyGPT in General settings?', 'overview'],
  ['Can I choose Light or Dark immediately on the first welcome screen?', 'overview'],
  ['Can I use Add later for optional TinyGPT Pro and OpenRouter without selecting the included local model?', 'overview'],
  ['Does Meet your Bot let me skip Bot setup without enabling proactive checks or changing permissions?', 'overview'],
  ['Does onboarding offer TinyGPT Pro downloads only after checking device compatibility?', 'overview'],
  ['Does leaving my optional first name blank in Tailored to you erase my existing name or enable memory sharing?', 'overview'],
  ['Does 100% local memory storage mean cloud models never receive relevant memories?', 'overview'],
  ['Does free forever include paid OpenRouter usage or only the included on-device model?', 'overview'],
  ['Does first launch download local model data once, verify its SHA-256, and keep those models across app updates?', 'updates'],
  ['Does the welcome starter send a message automatically or enable microphone and computer access?', 'overview'],
  ['Does the current Mac pre-beta offer automatic updating?', 'updates'],
  ['Where is Update available above my sidebar profile, and do I choose Download update and Restart to update?', 'updates'],
  ['Will TinyGPT install an update automatically when I quit or restart during active Work tasks and terminals?', 'updates'],
  ['Can a missing updater cache require the complete app package without downloading unchanged models again?', 'updates'],
  ['Does an unsigned build accept updates without a configured publisher signature?', 'updates'],
  ['Does Forget in Personalization clear the local model weights or only personal memories?', 'updates'],
  ['Where is Remote Control on the website downloads page, and can its mobile web app run without my paired desktop?', 'remote'],
  ['Where do I change quiet hours notifications?', 'settings-notifications'],
  ['How do per-message Bot notification events obey away-only preferences?', 'personal-settings'],
  ['Does local storage mean cloud prompts stay on my computer?', 'privacy'],
  ['How do I pair my phone with a QR code?', 'remote'],
  ['How do I pause folder indexing and forget memories?', 'memory'],
  ['Can TinyGPT work offline?', 'models'],
  ['How can I revoke plugin account access?', 'plugins'],
  ['How do I stop desktop computer control?', 'browser-computer'],
  ['How do I save passwords with Windows Hello and private sign-in?', 'browser-computer'],
  ['How does the mobile companion show Coding agent work?', 'remote'],
  ['Why are browser clicks missing during a Bot proactive read-only watch but available in foreground?', 'bot-scheduled'],
  ['What does a Bot rejected conversation format error mean and are earlier messages saved?', 'bot-scheduled'],
  ['How does OCR column recovery preserve uncertain prices for visual verification?', 'projects-files'],
  ['Does updating OCR reprocess existing saved image attachments automatically?', 'projects-files'],
  ['Can generated UI tables charts and follow-up questions appear on mobile?', 'remote'],
  ['Why does a new Chat progress message replace the previous prose?', 'chat'],
  ['Why did Work pause after repeated output limits and how does Continue reuse the Coding agent session?', 'work'],
  ['Can Work build larger files through small 16 KiB edits?', 'work'],
  ['Are Python Node npm and npx bundled across Work Coding agent and workspace terminals without a system installation?', 'work'],
  ['How do I install Python packages with venv and pip without changing the shared bundled runtime?', 'work'],
  ['Can bundled npm npx and Python install every package offline and are native compilers included?', 'work'],
  ['Why is a browser control covered by a modal dialog and how do I inspect its screenshot?', 'browser-computer'],
  ['Can I use the workspace browser while a question or browser sign-in handoff waits?', 'browser-computer'],
  ['How do compact question options and a single-line custom answer work?', 'work'],
  ['Why is reply-start date time held stable for prompt cache reuse during tools?', 'work'],
  ['Does a search-only Gmail selection mean it cannot read mail or create filters?', 'plugins'],
  ['Why are existing Work input tokens processed again instead of reused from the prompt cache?', 'work'],
  ['How do stable Work tool definitions and invoke_tool avoid replacing browser and plugin schemas?', 'work'],
  ['Does history cleanup wait for context pressure instead of trimming a healthy prompt cache?', 'work'],
  ['Does Work preserve the middle of file reads and continue with a 1-based line offset rather than character offsets?', 'work'],
  ['How does Work repair old write edit history placeholders and archive successful actions without fake file contents?', 'work'],
  ['How are GPU clocks power memory and output speed telemetry recorded during local runs?', 'work'],
  ['Does vision preserve my checkbox question and provide original-coordinate OCR textRegions?', 'browser-computer'],
  ['Why can the Pro prompt snapshot budget exceed four GiB of host memory?', 'models'],
  ['How do I refresh latest tools in the Tool Icon Auditor and review pending Solar icon changes?', 'icon-auditor'],
  ['Where is the floating Bot avatar and wide right-side browser card with Watch and recent activity?', 'bot-scheduled'],
  ['Can my Bot delegate user-facing Work chats or run shell commands, and does it share Chat effort?', 'bot-scheduled'],
  ['Does saving an identical Bot watch postpone the next check or resume a paused watch?', 'bot-scheduled'],
  ['Can my Bot remove its completed verification watches with initiative off, and do 30-minute watches expire automatically?', 'bot-scheduled'],
  ['Can a private proactive check remove another Bot watch, my user Scheduled tasks or the general Personal check-in?', 'bot-scheduled'],
  ['Why do repeated unchanged watch and memory saves stop for one Bot reply, and does a watch perform its task?', 'bot-scheduled'],
  ['Do Bot browser tools carry forward into the next foreground reply and obey current access settings?', 'bot-scheduled'],
  ['How do I snooze my Bot until I wake it, and does sleeping stop Scheduled tasks?', 'bot-scheduled'],
  ['Can I talk to my personal Bot on the mobile companion with its animated avatar and snooze wake controls?', 'remote'],
  ['Does a paired phone see private internal Bot watch conversations or control its workspace browser?', 'remote'],
  ['Why are only five recent Bot tool chips visible, with hover menus and icons?', 'bot-scheduled'],
  ['Where is the next-check time for single-line Bot watch rows and how do I pause them from the menu?', 'bot-scheduled'],
  ['Can Check now run a paused Bot watch once without changing its schedule, and does sleep block it?', 'bot-scheduled'],
  ['Does the source-checkout icon auditor query live remote MCP account catalogs?', 'icon-auditor'],
  ['Do explicit per-tool browser icon mappings take precedence over family defaults in the Tool Icon Auditor?', 'icon-auditor'],
])('retrieves useful help for %s', (query, id) => {
  expect(searchHandbook(query, 8).map(hit => hit.articleId)).toContain(id);
});

it('explains optional welcome setup without retaining the removed included-model selection instructions', () => {
  const text = readHandbook('overview')[0].text;
  for (const term of ['five-step', 'Light', 'Dark', 'no included-model selection card', 'only when the actual device check confirms Pro compatibility', 'Add later does not prepare or configure a Bot', 'Skip this step']) expect(text).toContain(term);
  expect(text).not.toContain('Select its card to start it.');
});

it('explains saved-password isolation, native-auth requirements and security limits',()=>{
  const text=readHandbook('browser-computer')[0].text;
  for(const term of ['Windows Credential Manager','Hello approval for every fill','exact HTTPS origin','user presence','cryptographically Hello-bound vault','private page','does not automatically capture'])expect(text).toContain(term);
  expect(text).toContain('Clearing browsing data signs sites out but does not delete saved passwords');
  expect(text).toContain('website receives a filled password');
});

it('explains incomplete-call safety, bounded recovery and larger files through small changes', () => {
  const text = readHandbook('work')[0].text;
  for (const term of ['16 KiB', 'finished files can be larger', 'Incomplete tool calls are never executed', 'selected conversation branch', 'Directory listings do not reset', 'total output allowance is unchanged']) expect(text).toContain(term);
});

it('distinguishes modal scope, error pages, image references and measured cache reuse', () => {
  const browser = readHandbook('browser-computer')[0].text, work = readHandbook('work')[0].text;
  for (const term of ['open modal dialog', 'HTTP status', 'source ID', 'image-reader call', 'not prove every DOM node']) expect(browser).toContain(term);
  for (const term of ['saved conversation history is separate', 'newly processed tokens', 'Older long completed reasoning', 'does not guarantee cache reuse', 'invoke_tool', 'context capacity is healthy', 'measured context pressure']) expect(work).toContain(term);
});

it('bounds fallback context, rejects empty searches and supports full-topic reads', () => {
  expect(searchHandbook('the a how')).toEqual([]);
  expect(searchHandbook('What is TinyGPT?')[0].articleId).toBe('overview');
  expect(readHandbook('../privacy')).toEqual([]);
  expect(readHandbook('privacy')[0].text).toContain('does not recall');
  expect(handbookContext('Write a sonnet about the moon')).toBe('');
  expect(handbookContext('TinyGPT privacy settings').length).toBeLessThan(8500);
  expect(toolArguments.search_help.safeParse({}).success).toBe(false);
  expect(toolArguments.search_help.safeParse({ query: '' }).success).toBe(false);
});

it('keeps public help available without personal sharing and preserves private Project scopes', () => {
  const h = store(), a = h.createProject('A', ''), b = h.createProject('B', '');
  const ca = h.createConversation(a.id), cb = h.createConversation(b.id);
  h.memory.setPreference('personal', false);
  const privateMemory = h.memory.saveMemory({ projectId: a.id, title: 'secret', text: 'PRIVATE_CANARY', enabled: true });
  const helpId = handbookSourceId('privacy');
  expect(h.sources.detail(cb.id, helpId).text).toContain('Privacy');
  expect(() => h.sources.detail(cb.id, privateMemory.id)).toThrow();
  expect(h.sources.detail(ca.id, privateMemory.id).text).toContain('PRIVATE_CANARY');
  expect(h.memory.memories().map(m => m.id)).not.toContain(helpId);
  expect(() => h.memory.remove(helpId)).toThrow('read-only');
  expect(h.memory.pendingVectors(1000).length).toBeGreaterThan(0);
});

it('offers help in both catalogs and executes without file read permission', async () => {
  for (const mode of ['chat', 'work'] as const) expect(new WorkToolCatalog(toolDefinitions, mode).has('search_help')).toBe(true);
  const h = store(), chat = h.createConversation(null);
  const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'deny';
  const broker = new ToolBroker(h, () => settings, {} as any, {} as any, () => {});
  const output = JSON.parse(await broker.execute({ conversationId: chat.id, runId: randomUUID(), signal: new AbortController().signal }, { id: randomUUID(), name: 'search_help', input: { query: 'article:privacy' } }));
  expect(output.articles[0].text).toContain('cloud');
  expect(broker.approvals()).toEqual([]);
});

it('synchronizes changed and retired articles on restart and keeps source IDs stable', () => {
  const root = mkdtempSync(join(tmpdir(), 'tinygpt-handbook-')); folders.push(root);
  const path = join(root, 'history.sqlite'), first = store(path), id = handbookSourceId('privacy');
  first.memory.db.prepare("UPDATE knowledge_documents SET text='STALE',hash='stale' WHERE id=?").run(id);
  first.memory.upsert({ id: randomUUID(), projectId: null, kind: 'handbook', title: 'Retired help', text: 'RETIRED_CANARY', size: 14 });
  first.close(); stores.splice(stores.indexOf(first), 1);
  const second = store(path), chat = second.createConversation(null);
  expect(second.sources.detail(chat.id, id).text).toBe(readHandbook('privacy')[0].text);
  expect(second.memory.db.prepare("SELECT id FROM knowledge_documents WHERE title='Retired help'").get()).toBeUndefined();
});

it('includes handbook vectors in native search while excluding other Project evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'tinygpt-handbook-rag-')); folders.push(root);
  const h = store(join(root, 'history.sqlite')), a = h.createProject('A', ''), b = h.createProject('B', ''), chat = h.createConversation(b.id);
  h.memory.setPreference('personal', false);
  const secret = h.memory.saveMemory({ projectId: a.id, title: 'secret', text: 'PRIVATE_VECTOR_CANARY', enabled: true });
  const index = new RagIndex(join(root, 'history.sqlite'), join(root, 'vectors.sqlite'));
  try {
    const rows = index.pending(1000);
    const help = rows.find(row => row.sourceId === handbookSourceId('privacy'))!;
    const privateRow = rows.find(row => row.sourceId === secret.id)!;
    const vector = Array.from({ length: 384 }, (_, i) => i === 0 ? 1 : 0);
    index.save(help, vector); index.save(privateRow, vector);
    const hits = index.candidates({ handbookOnly: true }, 'handbook', vector);
    expect(hits.map(hit => hit.sourceId)).toContain(help.sourceId);
    expect(hits.map(hit => hit.sourceId)).not.toContain(secret.id);
    expect(index.candidates({ conversationId: chat.id }, 'unrelated', vector).map(hit => hit.sourceId)).not.toContain(help.sourceId);
  } finally { index.close(); }
});

it('falls back when inference fails and rejects private evidence from help search', async () => {
  const h = store();
  const runtime = { load: async () => {}, embed: async () => [], close() {}, search: vi.fn(async () => [{ sourceId: randomUUID(), title: 'Private', text: 'PRIVATE_CANARY', url: null, position: 0, citation: '' }]) };
  const memory = new MemoryService(h, runtime, () => false, () => {});
  const hits = await memory.searchHelp('TinyGPT privacy');
  expect(runtime.search).toHaveBeenCalledWith({ handbookOnly: true }, 'TinyGPT privacy', 4, false, undefined);
  expect(JSON.stringify(hits)).not.toContain('PRIVATE_CANARY');
  expect(hits.length).toBeGreaterThan(0);
  runtime.search.mockRejectedValueOnce(new Error('Unavailable'));
  expect((await memory.searchHelp('quiet hours')).length).toBeGreaterThan(0);
  await memory.shutdown();
});

it.each(['chat', 'code', 'bot'] as const)('grounds %s with tools and personal sharing disabled', async mode => {
  const h = store(), chat = h.createConversation(null, mode);
  h.memory.setPreference('personal', false);
  const settings = structuredClone(defaultSettings); settings.route = 'local'; settings.local.model = 'fixture'; settings.local.tools = false; settings.toolPermissions.read = 'deny';
  const inputs: string[] = [];
  const execution: ChatExecution = { async run(input, _signal, delta) { inputs.push(input.instructions); delta('Fixture answer'); } };
  const service = new ChatService(h, () => settings, () => undefined, execution, () => {}, undefined, undefined, undefined, undefined, execution, false, execution);
  service.start(chat.id, 'How do I change TinyGPT privacy settings?');
  await vi.waitFor(() => expect(service.isActive(chat.id)).toBe(false));
  expect(inputs[0]).toContain('Installed TinyGPT');
  expect(inputs[0]).toContain('tinygpt-source:');
  expect(inputs[0]).toContain('not current authorization');
});

it('detects stale text, source changes, new files and build versions in isolated fixtures', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'tinygpt-handbook-check-')); folders.push(fixture);
  const root = join(fixture, 'desktop-clone'); mkdirSync(root);
  const sourceRoot = join(import.meta.dirname, '..');
  for (const item of ['src', 'knowledge', 'package.json']) cpSync(join(sourceRoot, item), join(root, item), { recursive: true, filter: path => !/[\\/](assets|vendor|public)([\\/]|$)/.test(path) });
  const manifest=JSON.parse(readFileSync(join(sourceRoot,'knowledge/manifest.json'),'utf8'));
  for(const file of manifest.articles.flatMap((article:{sources:string[]})=>article.sources))if(!existsSync(join(root,file))){mkdirSync(dirname(join(root,file)),{recursive:true});cpSync(join(sourceRoot,file),join(root,file));}
  const script = join(sourceRoot, 'scripts/handbook.cjs');
  const run = (check = true) => execFileSync(process.execPath, [script, '--root', root, ...(check ? ['--check'] : [])], { stdio: 'pipe' });
  expect(() => run()).not.toThrow();
  const article = join(root, 'knowledge/privacy.md'); writeFileSync(article, readFileSync(article, 'utf8') + '\nReviewed fixture text.\n');
  expect(() => run()).toThrow(); run(false); expect(() => run()).not.toThrow();
  const file = join(root, 'src/core/new-feature.ts'); writeFileSync(file, 'export const fixture = true;');
  expect(() => run()).toThrow(); run(false);
  writeFileSync(file, 'export const fixture = false;'); expect(() => run()).toThrow(); run(false);
  const pkg = join(root, 'package.json'), value = JSON.parse(readFileSync(pkg, 'utf8')); value.version = '999.0.0'; writeFileSync(pkg, JSON.stringify(value));
  expect(() => run()).toThrow();
}, 30000);
