import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles, extractFile, scopedPath } from '../src/main/files';
import { ToolBroker } from '../src/main/tool-broker';
import type { BrowserController } from '../src/main/browser';
import { defaultSettings } from '../src/shared/config';
import { toolArguments, type ToolName } from '../src/shared/tools';
import { cleanSearchResults, searchAddress } from '../src/core/browser-pages';

const stores = new Set<HistoryStore>(); const folders: string[] = [];
function setup() { const store = new HistoryStore(':memory:'); stores.add(store); return store; }
async function folder() { const path = await mkdtemp(join(tmpdir(), 'tinygpt-tools-')); folders.push(path); return path; }
afterEach(async () => {
  for (const store of stores) store.close(); stores.clear();
  for (const path of folders.splice(0)) {
    if (dirname(resolve(path)).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(path).startsWith('tinygpt-tools-')) throw new Error('Unexpected fixture folder.');
    await rm(path, { force: true, recursive: true });
  }
});
describe('local source boundaries and migrations', () => {
  it('shares sent Project sources while keeping drafts, other Projects and personal chats separate', () => {
    const store = setup(); const project = store.createProject('Work', '', true);
    const a = store.createConversation(project.id); const b = store.createConversation(project.id);
    const other = store.createConversation(store.createProject('Other', '').id); const personal = store.createConversation(null);
    const source = store.sources.add(a.id, { kind: 'attachment', title: 'brief.md', text: 'BLUEBIRD secret roadmap' });
    expect(store.sources.search(b.id, 'BLUEBIRD')).toEqual([]);
    expect(() => store.sources.detail(b.id, source.id)).toThrow('Source not found');
    const turn = store.startTurn(a.id, 'Use this brief', 'local', [source.id]);
    expect(store.sources.messageSources(a.id, turn.conversation.messages[0].id)[0].id).toBe(source.id);
    expect(store.sources.search(b.id, 'BLUEBIRD')[0]).toMatchObject({ sourceId: source.id, citation: `[brief.md](tinygpt-source:${source.id})` });
    expect(store.sources.search(other.id, 'BLUEBIRD')).toEqual([]); expect(store.sources.search(personal.id, 'BLUEBIRD')).toEqual([]);
    expect(() => store.startTurn(b.id, 'Steal the attachment', 'local', [source.id])).toThrow('unavailable');
    expect(store.conversation(b.id).messages).toEqual([]);
    expect(store.project(project.id).browserIsolated).toBe(true);
  });
  it('escapes FTS input, refreshes sources, removes deleted chunks and invalidates folder-derived memory', () => {
    const store = setup(); const project = store.createProject('Work', ''); const a = store.createConversation(project.id);
    const source = store.sources.add(a.id, { kind: 'page', title: 'Original', url: 'https://example.com', text: 'BLUEBIRD revision alpha' });
    expect(() => store.sources.search(a.id, 'BLUEBIRD " OR * ) NEAR(')).not.toThrow();
    store.sources.add(a.id, { kind: 'page', title: 'Updated', url: 'https://example.com', text: 'BLUEBIRD revision beta' });
    expect(() => store.sources.detail(a.id, source.id)).toThrow();
    store.sources.add(a.id, { kind: 'project-file', title: 'code.ts', url: 'project-file:code.ts', text: 'WORKFILE constant' });
    store.setProjectFolder(project.id, 'C:\\new-folder');
    expect(store.sources.search(a.id, 'WORKFILE')).toEqual([]); expect(store.sources.search(a.id, 'BLUEBIRD')[0].title).toBe('Updated');
    store.deleteConversation(a.id); const fresh = store.createConversation(project.id);
    expect(store.sources.search(fresh.id, 'BLUEBIRD')).toEqual([]);
  });
  it('upgrades a version-one database without losing existing history', async () => {
    const path = join(await folder(), 'old.sqlite'); const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT,instructions TEXT NOT NULL DEFAULT '') STRICT;
      CREATE TABLE conversations(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,role TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,run_id TEXT,route TEXT NOT NULL) STRICT;
      INSERT INTO projects VALUES('p','Old Project',NULL,'Remember me'); INSERT INTO conversations VALUES('c','p','Old chat',1,1);
      INSERT INTO messages(id,conversation_id,role,text,status,created_at,route) VALUES('m','c','user','Saved prompt','complete',1,'local');
      INSERT INTO messages(id,conversation_id,role,text,status,created_at,route) VALUES('a','c','assistant','Saved reply','complete',2,'local'); PRAGMA user_version=1;`);
    db.close(); const store = new HistoryStore(path); stores.add(store);
    expect(store.conversation('c').messages[0].text).toBe('Saved prompt'); expect(store.project('p').browserIsolated).toBe(false); expect(store.conversations()[0].unread).toBe(false);
    store.sources.add('c', { kind: 'page', title: 'Upgrade', text: 'MIGRATED source' });
    store.addTool(randomUUID(), 'c', randomUUID(), 'read_page', 'In progress', 'Checking the reference', 'https://example.org/');
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.sources.search('c', 'MIGRATED')).toHaveLength(1); expect(reopened.conversation('c').tools[0].status).toBe('interrupted');
    expect(reopened.conversation('c').tools[0]).toMatchObject({ displayText: 'Checking the reference', target: 'https://example.org/' });
  });
});
describe('Project file grants', () => {
  it('reads and writes supported files, truncates replacements and indexes readable content', async () => {
    const root = await folder(); const store = setup(); const conversation = store.createConversation(null); const files = new ProjectFiles(store.sources); const signal = new AbortController().signal;
    await writeFile(join(root, 'brief.md'), 'BLUEBIRD long original content'); await writeFile(join(root, '.env'), 'secret');
    expect((await files.list(root, '.', signal)).entries.map(e => e.name)).toEqual(['brief.md']);
    expect((await files.read(conversation.id, root, 'brief.md', signal)).text).toContain('BLUEBIRD');
    await files.write(root, 'brief.md', 'short', signal); expect(await readFile(join(root, 'brief.md'), 'utf8')).toBe('short');
    await files.write(root, 'new.ts', 'export const value = 1;', signal); expect(await readFile(join(root, 'new.ts'), 'utf8')).toContain('value');
    await expect(files.write(root, 'binary.exe', 'bad', signal)).rejects.toThrow('text/code');
    const controller = new AbortController(); controller.abort();
    await expect(files.write(root, 'brief.md', 'cancelled', controller.signal)).rejects.toThrow(); expect(await readFile(join(root, 'brief.md'), 'utf8')).toBe('short');
  });
  it('blocks traversal, drive paths, sensitive paths and junction escapes for reads and writes', async () => {
    const root = await folder(); const outside = await folder(); await writeFile(join(outside, 'outside.md'), 'PRIVATE');
    await mkdir(join(root, '.ssh')); await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(join(root, '.ssh'), join(root, 'hidden'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['../outside.md', 'C:\\elsewhere\\a.txt', 'file:secret', '.env', '.ssh/key.md']) await expect(scopedPath(root, path, true)).rejects.toThrow();
    await expect(scopedPath(root, 'escape/outside.md')).rejects.toThrow('outside');
    await expect(scopedPath(root, 'escape/new.md', true)).rejects.toThrow('outside');
    await expect(scopedPath(root, 'hidden/new.md', true)).rejects.toThrow('Sensitive');
    await expect(scopedPath(null, 'a.md')).rejects.toThrow('Select a Project');
  });
  it('rejects binary/invalid text and enforces text limits', async () => {
    await expect(extractFile('a.md', Buffer.from([0, 1]))).rejects.toThrow('UTF-8');
    await expect(extractFile('a.md', Buffer.from([0xff]))).rejects.toThrow();
    await expect(extractFile('a.md', Buffer.from('x'.repeat(500001)))).rejects.toThrow('500,000');
    expect(await extractFile('a.md', Buffer.from('Hello café'))).toBe('Hello café');
  });
});
describe('user-controlled tool execution', () => {
  it('cancels manual browser work only in the selected conversation', async () => {
    const history = setup(); const a = history.createConversation(null), b = history.createConversation(null);
    const pending = new Map<string, { signal: AbortSignal; finish: (page: unknown) => void }>();
    const browser = { partition: () => 'fixture', page: (id: string, _partition: string, _url: string, signal: AbortSignal) => new Promise((resolve, reject) => { pending.set(id, { signal, finish: resolve }); signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true }); }), shutdown: () => {} } as unknown as BrowserController;
    const settings = structuredClone(defaultSettings); settings.toolPermissions.browser = 'allow';
    const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
    const first = broker.userPage(a.id, 'https://example.com/a'); const cancelled = expect(first).rejects.toThrow('Cancelled');
    const second = broker.userPage(b.id, 'https://example.com/b');
    await vi.waitFor(() => expect(pending.size).toBe(2)); broker.cancelManual(a.id); await cancelled;
    expect(pending.get(b.id)!.signal.aborted).toBe(false);
    pending.get(b.id)!.finish({ title: 'Beta', url: 'https://example.com/b', text: 'Beta evidence.' });
    expect((await second).page.title).toBe('Beta'); await broker.shutdown();
  });
  function brokerSetup(databasePath?: string) {
    const history = databasePath ? new HistoryStore(databasePath) : setup(); if (databasePath) stores.add(history); const project = history.createProject('Tool fixture', '', false, 'fixture-folder'); const conversation = history.createConversation(project.id); const settings = structuredClone(defaultSettings);
    const files = { list: vi.fn(async () => ({ entries: [] })), write: vi.fn(async () => ({ bytes: 1 })) } as unknown as ProjectFiles;
    const browser = { partition: () => 'fixture', shutdown: vi.fn() } as unknown as BrowserController;
    const broker = new ToolBroker(history, () => settings, browser, files, () => undefined);
    const controller = new AbortController(); const context = { conversationId: conversation.id, runId: randomUUID(), signal: controller.signal };
    const run = (name: ToolName = 'list_project_files', input: unknown = { path: '.' }, runId = context.runId) => broker.execute({ ...context, runId }, { id: randomUUID(), name, input });
    return { history, conversation, settings, files, broker, controller, context, run };
  }
  it('allows long Chat and Code turns to use shared tools without an action cap', async () => {
    const { broker, settings, run, history, conversation } = brokerSetup(); settings.toolPermissions.read = 'allow';
    for(let index=0;index<45;index++)expect(JSON.parse(await run()).error).toBeUndefined();
    expect(history.conversation(conversation.id).tools).toHaveLength(45);
    const project=history.createProject('Code','',false,'code-fixture-folder');const code=history.createConversation(project.id,'code');const ctx={conversationId:code.id,runId:randomUUID(),signal:new AbortController().signal};
    for(let index=0;index<45;index++)expect(JSON.parse(await broker.execute(ctx,{id:randomUUID(),name:'list_project_files',input:{path:'.'}})).error).toBeUndefined();
    expect(history.conversation(code.id).tools).toHaveLength(45); expect(conversation.mode).toBe('chat');
  });
  it('keeps approval queues independent and cancellation scoped to the original run', async () => {
    const { broker, settings, run, history, conversation, controller, context, files } = brokerSetup(); settings.toolPermissions.read = 'ask';
    const first = run(); const cancelled = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1));
    const b = history.createConversation(conversation.projectId); const other = { conversationId: b.id, runId: randomUUID(), signal: new AbortController().signal };
    const second = broker.execute(other, { id: randomUUID(), name: 'list_project_files', input: { path: '.' } });
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(2));
    const approvalB = broker.approvals().find(approval => approval.conversationId === b.id)!;
    broker.respond(approvalB.id, 'allow-run'); expect(JSON.parse(await second).error).toBeUndefined();
    expect(broker.approvals().map(approval => approval.runId)).toEqual([context.runId]); expect(files.list).toHaveBeenCalledOnce();
    controller.abort(); await cancelled; expect(broker.approvals()).toHaveLength(0);
    expect(history.conversation(b.id).tools[0].status).toBe('success'); broker.endRun(context.runId); broker.endRun(other.runId);
  });
  it('keeps a conversation grant across replies, scoped to the tool and Project', async () => {
    const { broker, settings, files, run, history, conversation, context } = brokerSetup(); settings.toolPermissions.read = 'ask';
    const first = run(); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'allow-conversation'); await first;
    broker.endRun(context.runId); await run('list_project_files', { path: '.' }, randomUUID()); expect(files.list).toHaveBeenCalledTimes(2);
    const differentTool = run('search_sources', { query: 'Evidence' }, randomUUID()); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'deny'); await differentTool;
    const other = history.createConversation(conversation.projectId); const otherCall = broker.execute({ ...context, conversationId: other.id, runId: randomUUID() }, { id: randomUUID(), name: 'list_project_files', input: { path: '.' } }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'deny'); await otherCall;
    const project = history.createProject('Moved', '', false, 'moved-fixture-folder'); history.organizeConversation({ id: conversation.id, action: 'move', projectId: project.id });
    const moved = run('list_project_files', { path: '.' }, randomUUID()); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'deny'); await moved;
    settings.toolPermissions.read = 'deny'; expect(JSON.parse(await run('list_project_files', { path: '.' }, randomUUID())).error).toContain('blocked'); expect(files.list).toHaveBeenCalledTimes(2);
  });
  it('renders valid model permission text while preserving the factual action and refusing revoked grants', async () => {
    const { broker, settings, context, history, conversation, files } = brokerSetup();
    const task = broker.execute(context, { id: randomUUID(), name: 'write_project_file', input: { path: 'brief.md', content: 'Approved evidence' }, approvalText: 'May I save the brief in your Project?', displayText: 'Saving the brief' });
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); expect(broker.approvals()[0]).toMatchObject({ prompt: 'May I save the brief in your Project?', summary: expect.stringContaining('Write brief.md') });
    settings.toolPermissions.write = 'deny'; broker.respond(broker.approvals()[0].id, 'allow-conversation'); expect(JSON.parse(await task).error).toContain('denied'); expect(files.write).not.toHaveBeenCalled();
    settings.toolPermissions.write = 'ask'; const next = broker.execute({ ...context, runId: randomUUID() }, { id: randomUUID(), name: 'write_project_file', input: { path: 'brief.md', content: 'Evidence' }, approvalText: '<script>unsafe</script>' });
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); expect(broker.approvals()[0].prompt).toBeUndefined(); broker.respond(broker.approvals()[0].id, 'deny'); await next; expect(history.conversation(conversation.id).tools).toHaveLength(2);
  });
  it('returns fresh accessibility references for stale actions only within a page-read grant', async () => {
    const { broker, settings, run } = brokerSetup(); settings.toolPermissions.interact = 'allow'; settings.toolPermissions.browser = 'allow';
    const browser = broker.browser;
    browser.describe = vi.fn(async () => { throw new Error('The element changed. Read a new browser snapshot.'); });
    browser.click = vi.fn();
    const snapshot = { tabId: randomUUID(), url: 'https://example.org/', title: 'Current page', text: 'Read-only evidence', elements: [{ id: 't20', role: 'button', label: 'Current action' }], challenge: false, snapshotKind: 'accessibility' as const };
    browser.snapshot = vi.fn(async () => snapshot);
    const result = JSON.parse(await run('browser_click', { tabId: snapshot.tabId, elementId: 't1' }));
    expect(result).toMatchObject({ code: 'BROWSER_TARGET_STALE', retryable: true, snapshot }); expect(browser.click).not.toHaveBeenCalled();
    expect(browser.snapshot).toHaveBeenCalledOnce();
    settings.toolPermissions.browser = 'ask';
    const unapprovedRead = JSON.parse(await run('browser_click', { tabId: snapshot.tabId, elementId: 't1' }));
    expect(unapprovedRead.snapshot).toBeUndefined(); expect(unapprovedRead.nextAction).toContain('browser_snapshot'); expect(browser.snapshot).toHaveBeenCalledOnce(); expect(broker.approvals()).toEqual([]);
    settings.toolPermissions.browser = 'deny';
    expect(JSON.parse(await run('browser_click', { tabId: snapshot.tabId, elementId: 't1' })).snapshot).toBeUndefined(); expect(browser.snapshot).toHaveBeenCalledOnce();
  });
  it('explains expired tab recovery without reopening a page or bypassing permission', async () => {
    const { broker, settings, run } = brokerSetup(); settings.toolPermissions.browser = 'allow'; settings.toolPermissions.interact = 'allow';
    broker.browser.snapshot = vi.fn(async () => { throw new Error('This browser tab is not available to the conversation.'); });
    broker.browser.describe = vi.fn(async () => { throw new Error('This browser tab is not available to the conversation.'); });
    broker.browser.page = vi.fn(); const tabId = randomUUID();
    expect(JSON.parse(await run('browser_snapshot', { tabId }))).toMatchObject({ code: 'BROWSER_TAB_UNAVAILABLE', retryable: true, nextAction: expect.stringContaining('browser_open') });
    expect(JSON.parse(await run('browser_click', { tabId, elementId: 't1' }))).toMatchObject({ code: 'BROWSER_TAB_UNAVAILABLE' });
    expect(broker.browser.page).not.toHaveBeenCalled(); expect(broker.approvals()).toEqual([]);
    settings.toolPermissions.browser = 'deny';
    expect(JSON.parse(await run('browser_snapshot', { tabId })).error).toContain('blocked by the user'); expect(broker.browser.snapshot).toHaveBeenCalledOnce();
  });
  it('keeps research source evidence after run cleanup and routes browser leases', async () => {
    const { broker, settings, run, context, history, conversation, controller } = brokerSetup(); settings.toolPermissions.browser = 'allow';
    const snapshot = { tabId: randomUUID(), url: 'https://example.org/', title: 'Evidence', text: 'Saved research evidence.', elements: [], challenge: false };
    broker.browser.page = vi.fn(async () => snapshot); broker.browser.snapshot = vi.fn(async () => snapshot); broker.browser.prepareInteraction = vi.fn(); broker.browser.search = vi.fn(async () => ({ engine: 'duckduckgo' as const, query: 'Evidence', results: [] })); broker.browser.endRun = vi.fn();
    const read = JSON.parse(await run('read_page', { url: snapshot.url }));
    expect(broker.browser.page).toHaveBeenCalledWith(conversation.id, 'fixture', snapshot.url, expect.any(AbortSignal), context.runId);
    await run('browser_snapshot', { tabId: snapshot.tabId }); expect(broker.browser.prepareInteraction).toHaveBeenCalledWith(conversation.id, snapshot.tabId, context.runId, false);
    await run('search_web', { query: 'Evidence' }); expect(broker.browser.search).toHaveBeenCalledWith(conversation.id, 'fixture', settings.browser.engine, 'Evidence', expect.any(AbortSignal), context.runId);
    const readSignal = vi.mocked(broker.browser.page).mock.calls[0][3];
    const searchSignal = vi.mocked(broker.browser.search).mock.calls[0][4];
    expect(readSignal.aborted).toBe(false); expect(searchSignal.aborted).toBe(false);
    controller.abort(); expect(readSignal.aborted).toBe(true); expect(searchSignal.aborted).toBe(true);
    broker.endRun(context.runId); expect(broker.browser.endRun).toHaveBeenCalledWith(context.runId, expect.any(Function));
    expect(vi.mocked(broker.browser.endRun).mock.calls[0][1]!(conversation.id)).toBe(false);
    expect(history.sources.search(conversation.id, 'research')[0]).toMatchObject({ sourceId: read.sourceId, citation: read.citation });
  });
  it('keeps browser targets when a large read_page observation is archived', async () => {
    const { broker, settings, run } = brokerSetup(join(await folder(), 'library.sqlite')); settings.toolPermissions.browser = 'allow';
    const snapshot = JSON.parse(readFileSync(new URL('./fixtures/openrouter-browser-snapshot.json', import.meta.url), 'utf8'));
    broker.browser.page = vi.fn(async () => snapshot);
    const result = await run('read_page', { url: snapshot.url });
    expect(result.length).toBeLessThanOrEqual(6000);
    const read = JSON.parse(result);
    expect(read.elements).toContainEqual({ id: 't23', role: 'tab', label: 'Image' });
    expect(read.observationId).toBeDefined(); expect(read.sourceId).toBeDefined();
    expect(read.targets.nextOffset).toBeGreaterThan(0);
  });
  it('passes snapshot filters to the browser without filtering wait evidence', async () => {
    const { broker, settings, run, context, conversation } = brokerSetup(); settings.toolPermissions.browser = 'allow';
    const snapshot = { tabId: randomUUID(), url: 'https://example.org/', title: 'Fixture', text: 'Finished', elements: [], challenge: false };
    broker.browser.snapshot = vi.fn(async () => snapshot);
    await run('browser_snapshot', { tabId: snapshot.tabId, query: 'Image', role: 'tab', offset: 40, limit: 10 });
    expect(broker.browser.snapshot).toHaveBeenCalledWith(conversation.id, snapshot.tabId, expect.any(AbortSignal), expect.objectContaining({ query: 'Image', role: 'tab', offset: 40, limit: 10, scope: 'active', tabId: snapshot.tabId }));
    const waited = JSON.parse(await run('browser_snapshot', { tabId: snapshot.tabId, query: 'Image', role: 'tab', waitUntil: { text: 'Finished', state: 'present', match: 'exact', timeoutMs: 1000 } }));
    expect(waited.wait.matched).toBe(true); expect(waited.elements).toEqual([]);
  });
  it('requires interaction permission before scrolling and closing, and reuses an owned tab', async () => {
    const { broker, settings, run, context, conversation } = brokerSetup(); settings.toolPermissions.browser = 'allow'; settings.toolPermissions.interact = 'ask';
    const tabId = randomUUID(); const snapshot = { tabId, url: 'https://example.org/', title: 'Browser', text: 'Visible evidence', elements: [], challenge: false };
    broker.browser.open = vi.fn(async () => snapshot); broker.browser.prepareInteraction = vi.fn(); broker.browser.scrollAgent = vi.fn(async () => ({ ...snapshot, scroll: { top: 600, height: 2000, viewport: 600 } } as any)); broker.browser.closeTab = vi.fn(); broker.browser.navigateAgent = vi.fn(async () => ({ ...snapshot, navigation: { performed: true, notice: 'Navigated' } }));
    await run('browser_open', { url: snapshot.url }); expect(broker.browser.open).toHaveBeenCalledWith(conversation.id, 'fixture', snapshot.url, expect.any(AbortSignal), context.runId);
    const scroll = run('browser_scroll', { tabId, direction: 'down' }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1));
    expect(broker.browser.prepareInteraction).not.toHaveBeenCalled(); expect(broker.browser.scrollAgent).not.toHaveBeenCalled(); broker.respond(broker.approvals()[0].id, 'deny'); await scroll;
    settings.toolPermissions.interact = 'allow'; await run('browser_scroll', { tabId, direction: 'down' });
    expect(broker.browser.prepareInteraction).toHaveBeenCalledWith(conversation.id, tabId, context.runId); expect(broker.browser.scrollAgent).toHaveBeenCalledWith(conversation.id, tabId, 'down', 600, expect.any(AbortSignal));
    await run('browser_navigate', { tabId, url: 'https://example.org/next' }); expect(broker.browser.navigateAgent).toHaveBeenCalledWith(conversation.id, tabId, 'https://example.org/next', expect.any(AbortSignal), false);
    settings.toolPermissions.interact = 'deny'; await run('browser_close', { tabId }); expect(broker.browser.closeTab).not.toHaveBeenCalled();
    settings.toolPermissions.interact = 'allow'; expect(JSON.parse(await run('browser_close', { tabId }))).toEqual({ closed: true }); expect(broker.browser.closeTab).toHaveBeenCalledWith(conversation.id, tabId);
  });
  it('lists only through browser read permission and leaves tabs untouched', async () => {
    const { broker, settings, run, context, conversation } = brokerSetup();
    broker.browser.listTabs = vi.fn(()=>({tabs:[{tabId:randomUUID(),title:'Existing page',url:'https://example.org/',loading:false,active:false,waitingForUser:false}],total:1,note:'Use a fresh snapshot.'}));
    settings.toolPermissions.browser = 'deny';
    await run('browser_tabs',{}); expect(broker.browser.listTabs).not.toHaveBeenCalled();
    settings.toolPermissions.browser = 'allow';
    const listed=JSON.parse(await run('browser_tabs',{offset:0,limit:4}));
    expect(listed.tabs[0].title).toBe('Existing page');
    expect(broker.browser.listTabs).toHaveBeenCalledWith(conversation.id,'fixture',{offset:0,limit:4});
    expect(toolArguments.browser_tabs.safeParse({conversationId:randomUUID()}).success).toBe(false);
    expect(toolArguments.browser_tabs.safeParse({limit:25}).success).toBe(false);
  });
  it('bounds browser scroll/key arguments and rejects selectors or arbitrary scripts', () => {
    const tabId = randomUUID(); expect(toolArguments.browser_scroll.parse({ tabId, direction: 'up' }).pixels).toBe(600);
    for (const pixels of [0, -1, 3001, 0.5]) expect(toolArguments.browser_scroll.safeParse({ tabId, direction: 'down', pixels }).success).toBe(false);
    expect(toolArguments.browser_press_key.safeParse({ tabId, key: 'Control+A' }).success).toBe(false);
    expect(toolArguments.browser_hover.safeParse({ tabId, elementId: '#submit' }).success).toBe(false);
    expect(toolArguments.browser_open.safeParse({ url: 'javascript:alert(1)' }).success).toBe(false);
    expect(toolArguments.browser_navigate.safeParse({ tabId, url: 'https://example.org', script: 'arbitrary' }).success).toBe(false);
  });
  it('clicks once and waits for a result URL rather than treating live progress text as completion', async () => {
    const { broker, settings, run } = brokerSetup(); settings.toolPermissions.browser = 'allow'; settings.toolPermissions.interact = 'allow';
    const tabId = randomUUID(), pending = { tabId, url: 'https://example.org/run', title: 'Task', text: '96.94 Mbps — fifty percent complete', elements: [], challenge: false };
    broker.browser.describe = vi.fn(async () => ({ url: pending.url, label: 'Start', role: 'button' } as any)); broker.browser.prepareInteraction = vi.fn();
    broker.browser.click = vi.fn(async () => pending); broker.browser.snapshot = vi.fn(async () => ({ ...pending, url: 'https://example.org/result/123', text: 'Complete' }));
    const result = JSON.parse(await run('browser_click', { tabId, elementId: 't0', waitUntil: { url: '/result/', match: 'contains', timeoutMs: 5000 } }));
    expect(result).toMatchObject({ actionDispatched: true, pending: false, url: 'https://example.org/result/123', wait: { matched: true, polls: 2 } });
    expect(broker.browser.click).toHaveBeenCalledTimes(1); expect(broker.browser.snapshot).toHaveBeenCalledTimes(1);
  });
  it('uses an existing reply read grant for refresh but never silently retries the stale interaction', async () => {
    const { broker, settings, run } = brokerSetup(); settings.toolPermissions.interact = 'allow'; settings.toolPermissions.browser = 'ask';
    const browser = broker.browser; const tabId = randomUUID();
    browser.snapshot = vi.fn(async () => ({ tabId, url: 'https://example.org/', title: 'Page', text: 'Evidence', elements: [], challenge: false }));
    browser.describe = vi.fn(async () => { throw new Error('The element changed. Read a new browser snapshot.'); }); browser.click = vi.fn();
    const reading = run('browser_snapshot', { tabId }); await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'allow-run'); await reading;
    const result = JSON.parse(await run('browser_click', { tabId, elementId: 't1' }));
    expect(result.snapshot.tabId).toBe(tabId); expect(browser.snapshot).toHaveBeenCalledTimes(2); expect(browser.click).not.toHaveBeenCalled(); expect(broker.approvals()).toEqual([]);
  });
  it('holds execution until approval and exposes the complete write for review', async () => {
    const { broker, files, run, history, conversation } = brokerSetup();
    const root = await folder(); const project = history.createProject('Write fixture', '', false, root);
    history.organizeConversation({ action: 'move', id: conversation.id, projectId: project.id });
    const native = new ProjectFiles(history.sources); files.write = vi.fn(native.write.bind(native));
    const content = 'x'.repeat(9000); const result = run('write_project_file', { path: 'a.md', content });
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1));
    expect(files.write).not.toHaveBeenCalled(); expect(broker.approvals()[0].details).toContain(content);
    broker.respond(broker.approvals()[0].id, 'allow-once'); await result; expect(files.write).toHaveBeenCalledOnce();
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(content);
    expect(history.codeChanges(conversation.id)[0]).toMatchObject({ before: null, after: content, state: 'applied' });
  });
  it('keeps model display text separate from factual approval and permission decisions', async () => {
    const { broker, history, conversation, settings, context, files } = brokerSetup(); settings.toolPermissions.write = 'ask';
    const result = broker.execute(context, { id: randomUUID(), name: 'write_project_file', input: { path: 'important.md', content: 'Replacement' }, displayText: 'Reviewing the evidence' });
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1));
    expect(broker.approvals()[0].summary).toContain('Write important.md');
    expect(history.conversation(conversation.id).tools[0]).toMatchObject({ displayText: 'Reviewing the evidence', target: 'important.md', status: 'pending' });
    broker.respond(broker.approvals()[0].id, 'deny'); await result;
    expect(files.write).not.toHaveBeenCalled();
  });
  it('respects explicit denial even if preferences change while waiting', async () => {
    const { broker, files, settings, run } = brokerSetup(); settings.toolPermissions.read = 'ask'; const result = run();
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); settings.toolPermissions.read = 'allow';
    broker.respond(broker.approvals()[0].id, 'deny'); expect(JSON.parse(await result).error).toContain('denied'); expect(files.list).not.toHaveBeenCalled();
  });
  it('rechecks a newly blocked preference after approval and clears cancelled prompts', async () => {
    const { broker, files, settings, controller, run } = brokerSetup(); settings.toolPermissions.read = 'ask'; const result = run();
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); settings.toolPermissions.read = 'deny'; broker.respond(broker.approvals()[0].id, 'allow-once');
    expect(JSON.parse(await result).error).toContain('denied'); expect(files.list).not.toHaveBeenCalled();
    settings.toolPermissions.read = 'ask'; const cancelled = run(); const rejection = expect(cancelled).rejects.toThrow('Cancelled');
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); controller.abort(); await rejection; expect(broker.approvals()).toEqual([]);
  });
  it('limits allow-for-reply grants to that run without limiting successful actions', async () => {
    const { broker, files, settings, context, run } = brokerSetup(); settings.toolPermissions.read = 'ask'; const first = run();
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'allow-run'); await first;
    await run(); expect(files.list).toHaveBeenCalledTimes(2);
    for (let i = 2; i < 25; i++) expect(JSON.parse(await run()).error).toBeUndefined();
    broker.endRun(context.runId); const next = run('list_project_files', { path: '.' }, randomUUID());
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1)); broker.respond(broker.approvals()[0].id, 'deny'); await next;
    expect(files.list).toHaveBeenCalledTimes(25);
  });
});
describe('search engine addresses and result normalization', () => {
  it('encodes queries and unwraps engine redirect links without admitting local or executable URLs', () => {
    for (const engine of ['google', 'bing', 'brave', 'duckduckgo'] as const) expect(new URL(searchAddress(engine, 'café & tools')).searchParams.get('q')).toBe('café & tools');
    const target = 'https://example.org/article';
    const raw = (url: string) => ({ url, title: 'Article', snippet: 'Rendered snippet' });
    expect(cleanSearchResults('google', [raw(`https://www.google.com/url?q=${encodeURIComponent(target)}`), raw(target), raw('javascript:alert(1)'), raw('file:///secret')])).toEqual([raw(target)]);
    expect(cleanSearchResults('bing', [raw(`https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}`)])[0].url).toBe(target);
    expect(cleanSearchResults('duckduckgo', [raw(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`)])[0].url).toBe(target);
  });
});
