import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { DatabaseSync } from 'node:sqlite';
const stores = new Set<HistoryStore>(); const directories: string[] = [];
it('keeps scheduled provenance on chat summaries after reopening without changing chat order or private bot chats', async () => {
  const { store,path } = await setup();
  const scheduled = store.createConversation(null,'chat'), normal = store.createConversation(null,'chat'), bot = store.createConversation(null,'bot');
  const before = store.conversations().map(chat=>({id:chat.id,updatedAt:chat.updatedAt}));
  store.markScheduledConversations([scheduled.id,bot.id]);
  expect(store.conversation(scheduled.id).scheduled).toBe(true);
  expect(store.conversation(normal.id).scheduled).toBe(false);
  expect(store.conversation(bot.id).scheduled).toBe(false);
  expect(store.conversations().map(chat=>({id:chat.id,updatedAt:chat.updatedAt}))).toEqual(before);
  store.close();stores.delete(store);
  const reopened = new HistoryStore(path);stores.add(reopened);
  expect(reopened.conversations().find(chat=>chat.id===scheduled.id)?.scheduled).toBe(true);
  expect(reopened.conversation(scheduled.id).scheduled).toBe(true);
});
it('persists project favorites and archives only the chosen project chats', async () => {
  const { store, path } = await setup();
  const first = store.createProject('Alpha', ''); const second = store.createProject('Zulu', '');
  const chat = store.createConversation(second.id); const other = store.createConversation(first.id);
  store.organizeProject({ id: second.id, action: 'favorite', value: true });
  store.organizeProject({ id: second.id, action: 'archive-chats' });
  expect(store.conversation(chat.id).archived).toBe(true); expect(store.conversation(other.id).archived).toBe(false);
  store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
  expect(reopened.projects()[0]).toMatchObject({ id: second.id, favorite: true });
  reopened.organizeProject({ id: second.id, action: 'favorite', value: false }); expect(reopened.projects()[0].id).toBe(first.id);
});
it('removes a project while retaining its chats and attachments without expanding memory scope', async () => {
  const { store } = await setup(); const project = store.createProject('Remove me', '', false, dirname(store.databasePath));
  const chat = store.createConversation(project.id); const turn = store.startTurn(chat.id, 'Keep my chat', 'local'); store.saveReply(turn.assistantId, 'Keep my answer', 'complete');
  const attachment = store.sources.add(chat.id, { kind: 'attachment', title: 'Notes', text: 'Keep my evidence' });
  store.memory.saveMemory({ projectId: project.id, title: 'Private project memory', text: 'Do not make this global', enabled: true });
  store.memory.configureIndex(project.id, true); store.saveCodeChange(chat.id, turn.runId, project.id, project.rootPath!, 'notes.md', null, 'text');
  store.organizeProject({ id: project.id, action: 'remove' });
  expect(store.projects()).toEqual([]); expect(store.conversation(chat.id).projectId).toBeNull();
  expect(store.conversation(chat.id).messages.map(message => message.text)).toEqual(['Keep my chat', 'Keep my answer']);
  expect(store.sources.detail(chat.id, attachment.id)).toMatchObject({ projectId: null, text: 'Keep my evidence' });
  expect(store.memory.memories()).toEqual([]); expect(store.memory.indexes()).toEqual([]);
});
it('saves folder removal together with project fields and preserves existing settings', async () => {
  const { store } = await setup(); const project = store.createProject('Old name', 'Retained instructions', true, dirname(store.databasePath));
  store.memory.configureIndex(project.id, true);
  store.updateProject(project.id, 'New name', project.instructions, project.browserIsolated, null);
  expect(store.project(project.id)).toMatchObject({ name: 'New name', rootPath: null, instructions: 'Retained instructions', browserIsolated: true });
  expect(store.memory.indexes()[0].enabled).toBe(false);
});
it('persists Bot mode alongside existing Chat and Work conversations across restart', async () => {
  const { store, path } = await setup();
  const bot = store.createConversation(null, 'bot'); const chat = store.createConversation(null, 'chat'); const code = store.createConversation(null, 'code');
  store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
  expect(reopened.conversation(bot.id).mode).toBe('bot'); expect(reopened.conversation(chat.id).mode).toBe('chat'); expect(reopened.conversation(code.id).mode).toBe('code');
  expect(reopened.conversations().find(item => item.id === bot.id)?.mode).toBe('bot');
});
it('persists multiple Bot replies and counts run usage once', async () => {
  const { store, path } = await setup(); const bot = store.createConversation(null, 'bot');
  const turn = store.startTurn(bot.id, 'Check that.', 'local');
  store.saveReply(turn.assistantId, 'Checking.', 'complete');
  const second = store.appendBotReply(bot.id, turn.assistantId, turn.runId, 'local'); store.saveReply(second, 'Finished.', 'complete');
  store.recordContextUsage(bot.id, turn.runId, 100, 20);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE messages SET created_at=10000,response_duration_ms=5000 WHERE id=?').run(turn.assistantId);
  db.prepare('UPDATE messages SET created_at=13000,response_duration_ms=2000 WHERE id=?').run(second); db.close();
  expect(store.conversationUsage(bot.id)).toMatchObject({ totalTokens: 120, tokensPerSecond: 4, responses: 2 });
  store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
  expect(reopened.conversation(bot.id).messages.map(message => message.text)).toEqual(['Check that.', 'Checking.', 'Finished.']);
  expect(reopened.conversation(bot.id).headId).toBe(second);
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'tinygpt-history-')); directories.push(directory);
  const path = join(directory, 'library.sqlite'); const store = new HistoryStore(path); stores.add(store);
  return { store, path };
}
afterEach(async () => {
  for (const store of stores) store.close(); stores.clear();
  for (const directory of directories.splice(0)) {
    const path = resolve(directory);
    if (dirname(path).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(path).startsWith('tinygpt-history-')) throw new Error('Unexpected test folder.');
    await rm(path, { recursive: true, force: true });
  }
});
describe('durable conversation library', () => {
  it('migrates v18 Project diffs intact and persists managed diffs across reopening', async () => {
    const { store, path } = await setup(); const project = store.createProject('Existing', '', false, dirname(path)); const chat = store.createConversation(project.id);
    const oldId = store.saveCodeChange(chat.id, 'old-run', project.id, project.rootPath!, 'old.md', 'before', 'after'); store.setCodeChangeState(oldId, 'applied');
    store.close(); stores.delete(store);
    const legacy = new DatabaseSync(path);
    legacy.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE old_code_changes (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,run_id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id),root_path TEXT NOT NULL,path TEXT NOT NULL,before_text TEXT,after_text TEXT NOT NULL,created_at INTEGER NOT NULL,reverted INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'applied') STRICT; INSERT INTO old_code_changes SELECT * FROM code_changes; DROP TABLE code_changes; ALTER TABLE old_code_changes RENAME TO code_changes; PRAGMA user_version=18;`); legacy.close();
    const migrated = new HistoryStore(path); stores.add(migrated);
    expect(migrated.codeChanges(chat.id)[0]).toMatchObject({ id: oldId, projectId: project.id, before: 'before', after: 'after', state: 'applied' });
    const standalone = migrated.createConversation(null); const managedId = migrated.saveCodeChange(standalone.id, 'new-run', null, join(migrated.generatedFilesRoot, standalone.id), 'new.md', null, 'new'); migrated.setCodeChangeState(managedId, 'applied');
    migrated.close(); stores.delete(migrated); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.codeChanges(standalone.id)[0]).toMatchObject({ id: managedId, projectId: null, state: 'applied' });
    expect(reopened.generatedFilesRoot).toBe(migrated.generatedFilesRoot);
    expect(reopened.codeChangeRoot(oldId)).toBe(project.rootPath);
  });
  it('removes only an empty completed background heartbeat at the current head', async () => {
    const { store } = await setup(); const chat = store.createConversation(null, 'bot');
    const first = store.startTurn(chat.id, 'Hello', 'local'); store.saveReply(first.assistantId, 'Hello back', 'complete');
    const silent = store.startTurn(chat.id, 'Bot background task', 'local'); store.saveReply(silent.assistantId, '', 'complete');
    expect(store.discardSilentBackgroundTurn(chat.id, silent.assistantId, silent.runId)).toBe(true);
    expect(store.conversation(chat.id).messages.map(message => message.text)).toEqual(['Hello', 'Hello back']);
    const active = store.startTurn(chat.id, 'Bot background task', 'local'); store.saveReply(active.assistantId, '', 'complete'); store.addTool(randomUUID(), chat.id, active.runId, 'bot_read', 'Read notes');
    expect(store.discardSilentBackgroundTurn(chat.id, active.assistantId, active.runId)).toBe(false);
    const user = store.startTurn(chat.id, 'Actual user message', 'local'); store.saveReply(user.assistantId, '', 'complete');
    expect(store.discardSilentBackgroundTurn(chat.id, user.assistantId, user.runId)).toBe(false);
    expect(store.discardSilentBackgroundTurn(chat.id, active.assistantId, active.runId)).toBe(false);
  });
  it('loads generated outputs from persisted tool history, including archived chats', async () => {
    const { store, path } = await setup(); const project = store.createProject('Outputs', ''); const chat = store.createConversation(project.id);
    const turn = store.startTurn(chat.id, 'Create a page', 'local');
    const id = randomUUID(); store.addTool(id, chat.id, turn.runId, 'write_project_file', 'Create page'); store.finishTool(id, 'success', JSON.stringify({ path: 'plan.md' }));
    store.organizeConversation({ id: chat.id, action: 'archive', value: true });
    expect(store.outputs()).toEqual([expect.objectContaining({ name: 'plan.md', category: 'pages', conversationId: chat.id, projectId: project.id, projectName: 'Outputs' })]);
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.outputs()).toHaveLength(1); reopened.deleteConversation(chat.id); expect(reopened.outputs()).toEqual([]);
  });
  it('persists read receipts and scoped conversation grants without marking future replies read', async () => {
    const { store, path } = await setup(); const chat = store.createConversation(null); const other = store.createConversation(null);
    const unread = () => store.conversations().find(item => item.id === chat.id)!.unread;
    const first = store.startTurn(chat.id, 'First', 'local'); expect(unread()).toBe(false); store.markConversationRead(chat.id, first.assistantId); store.saveReply(first.assistantId, 'First reply', 'complete'); expect(unread()).toBe(true);
    store.markConversationRead(other.id, first.assistantId); expect(unread()).toBe(true); store.markConversationRead(chat.id, first.assistantId); expect(unread()).toBe(false);
    const next = store.startTurn(chat.id, 'Second', 'local'); store.saveReply(next.assistantId, 'Second reply', 'complete'); store.markConversationRead(chat.id, first.assistantId); expect(unread()).toBe(true);
    store.grantConversationTool(chat.id, 'scoped-tool'); expect(store.hasConversationGrant(other.id, 'scoped-tool')).toBe(false);
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened); expect(reopened.hasConversationGrant(chat.id, 'scoped-tool')).toBe(true); expect(reopened.conversations().find(item => item.id === chat.id)?.unread).toBe(true);
    reopened.markConversationRead(chat.id, next.assistantId); expect(reopened.conversations().find(item => item.id === chat.id)?.unread).toBe(false); reopened.deleteConversation(chat.id); expect(reopened.hasConversationGrant(chat.id, 'scoped-tool')).toBe(false);
  });
  it('reports scoped conversation stats without estimating missing usage or legacy speed', async () => {
    const { store, path } = await setup(); const chat = store.createConversation(null); const other = store.createConversation(null);
    expect(store.conversationUsage(chat.id)).toEqual({ totalTokens: null, missingUsage: false, tokensPerSecond: null, messages: 0, responses: 0, toolCalls: 0 });
    const turn = store.startTurn(chat.id, 'Question', 'local'); store.recordContextUsage(chat.id, turn.runId, 100, 20); store.saveReply(turn.assistantId, 'Answer', 'complete');
    const db = new DatabaseSync(path);
    expect(Number(db.prepare('SELECT response_duration_ms AS value FROM messages WHERE id=?').get(turn.assistantId)!.value)).toBeGreaterThan(0);
    db.prepare('UPDATE messages SET response_duration_ms=5000 WHERE id=?').run(turn.assistantId);
    const legacy = store.startTurn(chat.id, 'Older run', 'local'); store.recordContextUsage(chat.id, legacy.runId, 60, 10); store.saveReply(legacy.assistantId, 'Older answer', 'complete');
    db.prepare('UPDATE messages SET response_duration_ms=NULL WHERE id=?').run(legacy.assistantId); db.close();
    const missing = store.startTurn(chat.id, 'No provider usage', 'local'); store.saveReply(missing.assistantId, 'Partial', 'cancelled');
    const sibling = store.startTurn(other.id, 'Separate chat', 'local'); store.recordContextUsage(other.id, sibling.runId, 9000, 1000); store.saveReply(sibling.assistantId, 'Other', 'complete');
    store.addTool(randomUUID(), chat.id, turn.runId, 'read_page', 'Read a page');
    expect(store.conversationUsage(chat.id)).toEqual({ totalTokens: 190, missingUsage: true, tokensPerSecond: 4, messages: 6, responses: 2, toolCalls: 1 });
    expect(() => store.conversationUsage(randomUUID())).toThrow('Conversation not found');
  });
  it('migrates existing libraries without inventing timings for old responses', async () => {
    const { store, path } = await setup(); const chat = store.createConversation(null);
    const turn = store.startTurn(chat.id, 'Existing question', 'local'); store.saveReply(turn.assistantId, 'Existing answer', 'complete'); store.recordContextUsage(chat.id, turn.runId, 10, 5);
    store.close(); stores.delete(store); const db = new DatabaseSync(path);
    db.exec('ALTER TABLE messages DROP COLUMN response_duration_ms; PRAGMA user_version=8'); db.close();
    const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.conversationUsage(chat.id)).toMatchObject({ totalTokens: 15, tokensPerSecond: null, messages: 2 });
    expect(reopened.conversation(chat.id).messages.at(-1)?.text).toBe('Existing answer');
  });
  it('persists favorites and recoverable archives, and moves only the chat’s own sources across Project boundaries', async () => {
    const { store, path } = await setup();
    const first = store.createProject('First', '', false, 'C:\\workspace-a'); const second = store.createProject('Second', '');
    const chat = store.createConversation(first.id); const sibling = store.createConversation(first.id);
    const owned = store.sources.add(chat.id, { kind: 'page', title: 'Owned page', text: 'Owned evidence' });
    const inherited = store.sources.add(sibling.id, { kind: 'page', title: 'Other chat page', text: 'Private old Project evidence' });
    expect(store.sources.list(chat.id).map(source => source.id)).toContain(inherited.id);
    store.organizeConversation({ id: chat.id, action: 'pin', value: true }); store.organizeConversation({ id: chat.id, action: 'archive', value: true });
    expect(() => store.organizeConversation({ id: chat.id, action: 'move', projectId: randomUUID() })).toThrow('Project not found');
    expect(store.conversation(chat.id).projectId).toBe(first.id);
    store.organizeConversation({ id: chat.id, action: 'move', projectId: second.id });
    expect(store.sources.detail(chat.id, owned.id).projectId).toBe(second.id);
    expect(() => store.sources.detail(chat.id, inherited.id)).toThrow();
    expect(store.sources.detail(sibling.id, inherited.id).projectId).toBe(first.id);
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.conversations().find(item => item.id === chat.id)).toMatchObject({ pinned: true, archived: true, projectId: second.id });
    expect(reopened.project(first.id).rootPath).toBe('C:\\workspace-a');
    reopened.organizeConversation({ id: chat.id, action: 'archive', value: false }); reopened.organizeConversation({ id: chat.id, action: 'move', projectId: null });
    expect(reopened.conversation(chat.id)).toMatchObject({ archived: false, pinned: true, projectId: null });
    expect(reopened.sources.detail(chat.id, owned.id).projectId).toBeNull();
  });
  it('reports actual usage and local-calendar activity across daylight-saving changes without fabricating missing tokens', async () => {
    const { store, path } = await setup(); const chat = store.createConversation(null);
    expect(store.profileUsage()).toMatchObject({ totalTokens: null, peakTokens: null, currentStreak: 0, longestStreak: 0 });
    const turns = [0, 1, 2].map(index => { const turn = store.startTurn(chat.id, `Question ${index}`, 'local'); store.saveReply(turn.assistantId, 'Answer', 'complete'); return turn; });
    store.recordContextUsage(chat.id, turns[0].runId, 100, 20); store.recordContextUsage(chat.id, turns[0].runId, 50, 10);
    store.recordContextUsage(chat.id, turns[1].runId, 200, 30);
    const successfulTool = randomUUID(); const failedTool = randomUUID(); store.addTool(successfulTool, chat.id, turns[0].runId, 'read_page', 'Read a page'); store.finishTool(successfulTool, 'success'); store.addTool(failedTool, chat.id, turns[0].runId, 'read_page', 'Failed page'); store.finishTool(failedTool, 'error');
    expect(store.profileUsage()).toMatchObject({ toolCalls: 1, topTools: [{ name: 'read_page', count: 1 }] });
    const db = new DatabaseSync(path);
    turns.forEach((turn, index) => db.prepare('UPDATE messages SET created_at=? WHERE run_id=? OR id=(SELECT parent_id FROM messages WHERE run_id=?)').run(new Date(2026, 2, 7 + index, 12).getTime(), turn.runId, turn.runId)); db.close();
    store.organizeConversation({ id: chat.id, action: 'archive', value: true });
    expect(store.profileUsage(new Date(2026, 2, 9, 15))).toMatchObject({ totalTokens: 410, peakTokens: 230, missingUsage: true, currentStreak: 3, longestStreak: 3, longestChat: 3, conversationCount: 1, responseCount: 3 });
    expect(store.profileUsage(new Date(2026, 2, 10, 15)).currentStreak).toBe(3);
    expect(store.profileUsage(new Date(2026, 2, 11, 15)).currentStreak).toBe(0);
    expect(store.profileUsage().daily).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'].map((day, index) => ({ day, messages: 2, responses: 1, chats: 1, tokens: [180, 230, null][index], tools: index === 0 ? 1 : 0 })));
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.profileUsage().daily.map(day => day.tokens)).toEqual([180, 230, null]);
    // Further provider calls on a saved run update its day without counting messages twice.
    reopened.recordContextUsage(chat.id, turns[0].runId, 10, 5);
    expect(reopened.profileUsage().daily.map(day => day.tokens)).toEqual([195, 230, null]);
    expect(reopened.profileUsage().totalTokens).toBe(425);
  });
  it('counts saved branch usage once and distinguishes missing usage from reported zero', async () => {
    const { store, path } = await setup(); const chat = store.createConversation(null);
    const original = store.startTurn(chat.id, 'Original', 'local'); store.saveReply(original.assistantId, 'Answer', 'complete'); store.recordContextUsage(chat.id, original.runId, 100, 20);
    const branch = store.startTurn(chat.id, '', 'local', [], { type: 'regenerate', messageId: original.assistantId }); store.saveReply(branch.assistantId, 'Alternative', 'complete'); store.recordContextUsage(chat.id, branch.runId, 50, 10);
    const zero = store.startTurn(chat.id, 'Zero usage', 'local'); store.saveReply(zero.assistantId, 'Answer', 'complete'); store.recordContextUsage(chat.id, zero.runId, 0, 0);
    const missing = store.startTurn(chat.id, 'Unknown usage', 'local'); store.saveReply(missing.assistantId, 'Partial', 'cancelled');
    const db = new DatabaseSync(path);
    try {
      [original, branch, zero, missing].forEach((turn, index) => db.prepare('UPDATE messages SET created_at=? WHERE run_id=? OR id=(SELECT parent_id FROM messages WHERE run_id=?)').run(new Date(2026, 9, [5, 5, 6, 7][index], 12).getTime(), turn.runId, turn.runId));
    } finally { db.close(); }
    expect(store.profileUsage().daily).toMatchObject([
      { day: '2026-10-05', tokens: 180, responses: 2 },
      { day: '2026-10-06', tokens: 0, responses: 1 },
      { day: '2026-10-07', tokens: null, responses: 0 },
    ]);
    expect(store.profileUsage()).toMatchObject({ totalTokens: 180, peakTokens: 120, missingUsage: true });
  });
  it('restores checkpoints only on the ancestry they cover and recovers unfinished optimization', async () => {
    const { store, path } = await setup(); const conversation = store.createConversation(null);
    const first = store.startTurn(conversation.id, 'Original', 'local'); store.saveReply(first.assistantId, 'First answer', 'complete');
    store.saveContextCheckpoint(conversation.id, { throughMessageId: first.assistantId, text: 'Original branch checkpoint' });
    const next = store.startTurn(conversation.id, 'Next', 'local'); store.saveReply(next.assistantId, 'Next answer', 'complete');
    const activity = '11111111-1111-4111-8111-111111111111'; store.contextActivity(activity, conversation.id, next.runId, 'running');
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.contextCheckpoint(conversation.id, reopened.conversation(conversation.id).messages)?.text).toBe('Original branch checkpoint');
    expect(reopened.conversation(conversation.id).contextActivities?.[0].status).toBe('interrupted');
    const originalUser = reopened.conversation(conversation.id).messages[0];
    const edit = reopened.startTurn(conversation.id, 'Edited', 'local', [], { type: 'edit', messageId: originalUser.id }); reopened.saveReply(edit.assistantId, 'Edited answer', 'complete');
    expect(reopened.contextCheckpoint(conversation.id, reopened.conversation(conversation.id).messages)).toBeUndefined();
    expect(reopened.conversation(conversation.id).allMessages).toHaveLength(6);
  });
  it('preserves frozen toolchain duration when a saved answer is reopened', async () => {
    const { store, path } = await setup(); const conversation = store.createConversation(null);
    const turn = store.startTurn(conversation.id, 'Question', 'local');
    store.saveReply(turn.assistantId, 'Final answer', 'complete', null, '', 12345);
    store.close(); stores.delete(store);
    const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.conversation(conversation.id).messages.at(-1)).toMatchObject({ text: 'Final answer', workDurationMs: 12345 });
  });
  it('preserves provider reasoning when reopening an interrupted reply', async () => {
    const { store, path } = await setup();
    const conversation = store.createConversation(null); const turn = store.startTurn(conversation.id, 'Question', 'local');
    store.saveReply(turn.assistantId, 'Partial answer', 'streaming', null, 'Provider summary');
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.conversation(conversation.id).messages.at(-1)).toMatchObject({ status: 'interrupted', text: 'Partial answer', reasoning: 'Provider summary' });
  });
  it('keeps Projects distinct, including duplicate names, and persists folder/instructions', async () => {
    const { store, path } = await setup();
    const first = store.createProject('Work', 'First scope'); const second = store.createProject('Work', 'Second scope');
    store.setProjectFolder(first.id, 'C:\\fixture\\one');
    const a = store.createConversation(first.id); const b = store.createConversation(second.id); const personal = store.createConversation(null);
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.project(first.id)).toMatchObject({ instructions: 'First scope', rootPath: 'C:\\fixture\\one' });
    expect(reopened.conversation(a.id).projectId).toBe(first.id); expect(reopened.conversation(b.id).projectId).toBe(second.id);
    expect(reopened.conversation(personal.id).projectId).toBeNull(); expect(reopened.lastConversationId()).toBe(personal.id);
  });
  it('recovers partial replies after an unclean shutdown', async () => {
    const { store, path } = await setup(); const conversation = store.createConversation(null);
    const turn = store.startTurn(conversation.id, 'Hello', 'local'); store.saveReply(turn.assistantId, 'Partial text', 'streaming');
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.conversation(conversation.id).messages).toHaveLength(2);
    expect(reopened.conversation(conversation.id).messages[1]).toMatchObject({ text: 'Partial text', status: 'interrupted', error: expect.stringContaining('retry') });
  });
  it('retry selects a new answer branch and preserves the original with its follow-ups', async () => {
    const { store } = await setup(); const conversation = store.createConversation(null);
    const first = store.startTurn(conversation.id, 'First question', 'local'); store.saveReply(first.assistantId, 'First answer', 'complete');
    const second = store.startTurn(conversation.id, 'Next question', 'byok'); store.saveReply(second.assistantId, 'Bad answer', 'error');
    const retry = store.startTurn(conversation.id, null, 'byok'); store.saveReply(retry.assistantId, 'Better answer', 'complete');
    expect(store.conversation(conversation.id).messages.map(message => message.text)).toEqual(['First question', 'First answer', 'Next question', 'Better answer']);
    expect(store.conversation(conversation.id).messages[1].id).toBe(first.assistantId);
    expect(store.conversation(conversation.id).allMessages?.find(message => message.id === second.assistantId)?.text).toBe('Bad answer');
    store.selectBranch(conversation.id, second.assistantId);
    expect(store.conversation(conversation.id).messages.at(-1)?.text).toBe('Bad answer');
  });
  it('edits an earlier turn without deleting its descendants or moving its attachments', async () => {
    const { store, path } = await setup(); const conversation = store.createConversation(null);
    const source = store.sources.add(conversation.id, { kind: 'attachment', title: 'Scope.md', text: 'Branch evidence.' });
    const first = store.startTurn(conversation.id, 'Original', 'local', [source.id]); store.saveReply(first.assistantId, 'Original answer', 'complete');
    const originalUser = first.conversation.messages[0].id;
    const followup = store.startTurn(conversation.id, 'Follow-up', 'local'); store.saveReply(followup.assistantId, 'Follow-up answer', 'complete');
    const edited = store.startTurn(conversation.id, 'Edited', 'local', [], { type: 'edit', messageId: originalUser }); store.saveReply(edited.assistantId, 'Edited answer', 'complete');
    const selected = store.conversation(conversation.id);
    expect(selected.messages.map(message => message.text)).toEqual(['Edited', 'Edited answer']);
    expect(store.sources.messageSources(conversation.id, originalUser).map(item => item.id)).toEqual([source.id]);
    expect(store.sources.messageSources(conversation.id, selected.messages[0].id).map(item => item.id)).toEqual([source.id]);
    expect(store.sources.detail(conversation.id, source.id).messageId).toBe(originalUser);
    store.selectBranch(conversation.id, followup.assistantId);
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.conversation(conversation.id).messages.map(message => message.text)).toEqual(['Original', 'Original answer', 'Follow-up', 'Follow-up answer']);
    expect(reopened.conversation(conversation.id).allMessages).toHaveLength(6);
    expect(() => reopened.selectBranch(reopened.createConversation(null).id, edited.assistantId)).toThrow('Message not found');
  });
  it('migrates a linear v5 library without changing message identities or losing history', async () => {
    const { store, path } = await setup(); store.close(); stores.delete(store);
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE messages DROP COLUMN parent_id; ALTER TABLE messages DROP COLUMN continuation_of; ALTER TABLE conversations DROP COLUMN active_leaf; PRAGMA user_version=5;");
    db.prepare('INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)').run('old-chat', 'Original', 1, 1);
    const insert = db.prepare('INSERT INTO messages(id,conversation_id,role,text,status,created_at,route) VALUES(?,?,?,?,?,?,?)');
    insert.run('old-user', 'old-chat', 'user', 'Original question', 'complete', 1, 'local'); insert.run('old-answer', 'old-chat', 'assistant', 'Original answer', 'complete', 2, 'local'); db.close();
    const migrated = new HistoryStore(path); stores.add(migrated);
    expect(migrated.conversation('old-chat')).toMatchObject({ headId: 'old-answer', messages: [{ id: 'old-user', parentId: null }, { id: 'old-answer', parentId: 'old-user' }] });
  });
  it('discards only an unfinished leaf and rejects complete replies or replies with descendants', async () => {
    const { store } = await setup(); const conversation = store.createConversation(null);
    const first = store.startTurn(conversation.id, 'Question', 'local'); store.saveReply(first.assistantId, 'Partial', 'cancelled');
    const continued = store.startTurn(conversation.id, null, 'local', [], { type: 'continue', messageId: first.assistantId }); store.saveReply(continued.assistantId, 'Partial tail', 'complete');
    store.selectBranch(conversation.id, first.assistantId);
    expect(() => store.discardReply(conversation.id, first.assistantId)).toThrow('without follow-ups');
    store.selectBranch(conversation.id, continued.assistantId); expect(() => store.discardReply(conversation.id, continued.assistantId)).toThrow('unfinished');
    const failed = store.startTurn(conversation.id, 'Next', 'local'); store.saveReply(failed.assistantId, '', 'error');
    store.contextActivity(randomUUID(), conversation.id, failed.runId, 'error');
    expect(store.discardReply(conversation.id, failed.assistantId).messages.at(-1)?.role).toBe('user');
    expect(store.conversation(conversation.id).contextActivities).toEqual([]);
    expect(store.conversation(conversation.id).allMessages?.some(message => message.id === failed.assistantId)).toBe(false);
  });
  it('rolls back invalid retries without losing conversation state', async () => {
    const { store } = await setup(); const conversation = store.createConversation(null);
    expect(() => store.startTurn(conversation.id, null, 'local')).toThrow('no reply');
    expect(store.conversation(conversation.id).messages).toEqual([]);
    expect(() => store.createConversation('missing-project')).toThrow('Project not found');
    expect(store.conversations()).toHaveLength(1);
  });
  it('renames and deletes chats durably, including their messages', async () => {
    const { store, path } = await setup(); const conversation = store.createConversation(null);
    store.startTurn(conversation.id, 'Original title', 'local'); store.renameConversation(conversation.id, 'Renamed');
    expect(store.conversation(conversation.id).title).toBe('Renamed'); store.deleteConversation(conversation.id);
    store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
    expect(reopened.conversations()).toEqual([]); expect(reopened.lastConversationId()).toBeNull();
    expect(() => reopened.conversation(conversation.id)).toThrow('not found');
  });
});

it('Bot messages are append-only, with durable user and bot reactions', async () => {
  const { store } = await setup(); const bot = store.createConversation(null, 'bot');
  const turn = store.startTurn(bot.id, 'Hello', 'local');
  store.saveReply(turn.assistantId, 'Hi', 'complete', null);
  const message = store.conversation(bot.id).messages[0];
  for (const type of ['edit', 'regenerate', 'continue'] as const) expect(() => store.planTurn(bot.id, 'Replacement', { type, messageId: message.id })).toThrow(/cannot be edited/);
  expect(() => store.planTurn(bot.id, null)).toThrow(/cannot be edited/);
  expect(() => store.selectBranch(bot.id, message.id)).toThrow(/versions/);
  store.reactToMessage(bot.id, message.id, '👍', 'bot'); store.reactToMessage(bot.id, message.id, '❤️');
  expect(store.conversation(bot.id).messages[0].reactions?.map(item => item.emoji)).toEqual(expect.arrayContaining(['👍', '❤️']));
  store.reactToMessage(bot.id, message.id, '😂');
  expect(store.conversation(bot.id).messages[0].reactions).toHaveLength(2);
  store.reactToMessage(bot.id, message.id, null);
  expect(store.conversation(bot.id).messages[0].reactions?.map(item => item.actor)).toEqual(['bot']);
  const ordinary = store.createConversation(null); const other = store.startTurn(ordinary.id, 'Hello', 'local');
  expect(() => store.reactToMessage(bot.id, other.assistantId, '👍')).toThrow(/cannot be reacted/);
  expect(() => store.reactToMessage(bot.id, turn.assistantId, '👍', 'bot')).toThrow(/cannot be reacted/);
});


it('clears all Bot turn context and draft attachments without affecting setup, memory, or other chats', async () => {
  const { store, path } = await setup(); const bot = store.createConversation(null, 'bot'); store.renameConversation(bot.id, 'Milo');
  const other = store.createConversation(null); const otherTurn = store.startTurn(other.id, 'Keep this', 'local'); store.saveReply(otherTurn.assistantId, 'Keep answer', 'complete');
  const attachment = store.sources.add(bot.id, { kind: 'attachment', title: 'Old attachment', text: 'Private evidence' });
  const generatedImage = store.sources.add(bot.id, { kind: 'generated-image', title: 'Saved image', text: '{}', image: 'data:image/png;base64,cHJlc2VydmU=', mime: 'image/png' });
  const turn = store.startTurn(bot.id, 'Old context', 'local', [attachment.id]);
  expect(() => store.clearBotConversation(bot.id)).toThrow('Stop your bot');
  store.saveReply(turn.assistantId, 'Old answer', 'complete'); store.reactToMessage(bot.id, turn.assistantId, '❤️');
  store.saveContextCheckpoint(bot.id, { throughMessageId: turn.assistantId, text: 'Old checkpoint' });
  store.grantConversationTool(bot.id, 'old-grant'); const toolId = randomUUID(); store.addTool(toolId, bot.id, turn.runId, 'read_page', 'Read page'); store.finishTool(toolId, 'success', 'Old results');
  store.memory.saveMemory({ projectId: null, title: 'Keep memory', text: 'Keep personal memory', enabled: true });
  const fresh = store.clearBotConversation(bot.id);
  expect(fresh).toMatchObject({ id: bot.id, mode: 'bot', title: 'Milo', messages: [], allMessages: [], tools: [] });
  expect(store.sources.list(bot.id, false).map(source => source.id)).toEqual([generatedImage.id]); expect(store.sources.detail(bot.id, generatedImage.id).image).toBe('data:image/png;base64,cHJlc2VydmU='); expect(store.contextCheckpoint(bot.id, fresh.messages)).toBeUndefined(); expect(store.hasConversationGrant(bot.id, 'old-grant')).toBe(false);
  expect(store.memory.memories().some(item => item.title === 'Keep memory')).toBe(true);
  expect(store.conversation(other.id).messages).toHaveLength(2); expect(() => store.clearBotConversation(other.id)).toThrow('Only bot');
  store.close(); stores.delete(store); const reopened = new HistoryStore(path); stores.add(reopened);
  expect(reopened.conversation(bot.id).messages).toEqual([]); expect(reopened.conversation(bot.id).title).toBe('Milo');
  const next = reopened.startTurn(bot.id, 'Fresh context', 'local'); expect(next.conversation.messages.map(message => message.text)).toEqual(['Fresh context', '']);
});
