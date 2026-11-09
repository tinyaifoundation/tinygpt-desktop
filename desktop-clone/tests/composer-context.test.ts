import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import type { ChatWorkerInput } from '../src/shared/chat';
vi.mock('electron', () => ({ dialog: {}, nativeImage: {} }));
import { folderSnapshot } from '../src/main/attachments';
const stores: HistoryStore[] = [], folders: string[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });
function library() { const history = new HistoryStore(':memory:'); stores.push(history); return history; }
async function folder() { const path = await mkdtemp(join(tmpdir(), 'tinygpt-context-')); folders.push(path); return path; }

describe('linked conversations', () => {
  it('sends the linked transcript as context and saves a stable snapshot with the user message', async () => {
    const history = library(), original = history.createConversation(null), destination = history.createConversation(null);
    const originalTurn = history.startTurn(original.id, 'The budget is BLUEBIRD 42.', 'local');
    history.saveReply(originalTurn.assistantId, 'Use the BLUEBIRD budget for the report.', 'complete', null, 'PRIVATE_REASONING');
    const source = history.linkConversation(destination.id, original.id);
    expect(history.linkConversation(destination.id, original.id).id).toBe(source.id);
    let input: ChatWorkerInput | undefined;
    const chat = new ChatService(history, () => ({ ...defaultSettings, route: 'local', local: { ...defaultSettings.local, model: 'fixture' } }), () => undefined, { async run(value, _signal, delta) { input = value; delta('Done.'); } }, () => {});
    chat.start(destination.id, 'Use the linked budget.', [source.id]);
    for (let i = 0; i < 100 && chat.isActive(destination.id); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(input?.messages.at(-1)?.text).toContain('BLUEBIRD 42');
    expect(input?.messages.at(-1)?.text).not.toContain('PRIVATE_REASONING');
    expect(input?.messages.at(-1)?.text).toContain(`tinygpt-source:${source.id}`);
    const sent = history.conversation(destination.id).messages[0];
    expect(sent.attachmentIds).toEqual([source.id]);
    history.saveReply(originalTurn.assistantId, 'Changed later.', 'complete'); history.deleteConversation(original.id);
    expect(history.sources.detail(destination.id, source.id).text).toContain('Use the BLUEBIRD budget');
    expect(history.sources.search(destination.id, 'BLUEBIRD')).not.toHaveLength(0);
    expect(() => history.sources.attachable(destination.id, [source.id])).toThrow('unavailable');
  });
  it('keeps unsubmitted references private to their draft and enforces shared attachment limits', () => {
    const history = library(), project = history.createProject('Project', ''), original = history.createConversation(null), draft = history.createConversation(project.id), sibling = history.createConversation(project.id);
    const turn = history.startTurn(original.id, 'SECRET_DRAFT_REFERENCE', 'local'); history.saveReply(turn.assistantId, 'Reference answer.', 'complete');
    const linked = history.linkConversation(draft.id, original.id);
    expect(history.sources.list(sibling.id).some(source => source.id === linked.id)).toBe(false);
    expect(history.sources.search(sibling.id, 'SECRET_DRAFT_REFERENCE')).toEqual([]);
    expect(() => history.sources.detail(sibling.id, linked.id)).toThrow('not found');
    for (let i = 0; i < 7; i++) history.sources.add(draft.id, { kind: 'attachment', title: `File ${i}`, text: 'File.' });
    const other = history.createConversation(null); const otherTurn = history.startTurn(other.id, 'Other.', 'local'); history.saveReply(otherTurn.assistantId, 'Answer.', 'complete');
    expect(() => history.linkConversation(draft.id, other.id)).toThrow('eight');
    expect(() => history.linkConversation(draft.id, draft.id)).toThrow('another conversation');
    expect(() => history.linkConversation(sibling.id, history.createConversation(null).id)).toThrow('no messages');
  });
  it('copies only the visible branch, with recent exchanges near the beginning for inference', () => {
    const history = library(), original = history.createConversation(null), draft = history.createConversation(null);
    const first = history.startTurn(original.id, 'Original topic.', 'local'); history.saveReply(first.assistantId, 'Old response.', 'complete');
    const old = history.startTurn(original.id, 'Hidden branch.', 'local'); history.saveReply(old.assistantId, 'HIDDEN_BRANCH_SECRET', 'complete');
    const edited = history.startTurn(original.id, 'VISIBLE_BRANCH_TOPIC', 'local', [], { type: 'edit', messageId: old.conversation.messages.at(-2)!.id }); history.saveReply(edited.assistantId, 'Visible branch reply.', 'complete');
    const source = history.linkConversation(draft.id, original.id), text = history.sources.detail(draft.id, source.id).text;
    expect(text).not.toContain('HIDDEN_BRANCH_SECRET'); expect(text.slice(0, 2000)).toContain('VISIBLE_BRANCH_TOPIC');
  });
});

describe('folder attachments', () => {
  it('captures readable files and skips protected directories, credentials and escaping links', async () => {
    const root = await folder(), outside = await folder();
    await mkdir(join(root, 'docs')); await mkdir(join(root, '.git')); await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'docs', 'brief.md'), 'VISIBLE_FOLDER_CONTENT'); await writeFile(join(root, '.env'), 'SECRET_ENV');
    await writeFile(join(root, '.git', 'config.txt'), 'SECRET_GIT'); await writeFile(join(root, 'node_modules', 'dependency.txt'), 'DEPENDENCY_TEXT');
    await writeFile(join(outside, 'outside.txt'), 'OUTSIDE_SECRET'); await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const text = await folderSnapshot(root);
    expect(text).toContain('VISIBLE_FOLDER_CONTENT'); expect(text).not.toMatch(/SECRET_ENV|SECRET_GIT|OUTSIDE_SECRET|DEPENDENCY_TEXT/);
    const history = library(), chat = history.createConversation(null); const source = history.sources.add(chat.id, { kind: 'folder', title: 'Documents', text });
    expect(history.sources.attachable(chat.id, [source.id])[0].text).toContain('VISIBLE_FOLDER_CONTENT');
  });
  it('bounds large folders and reports omissions instead of claiming every file was captured', async () => {
    const root = await folder(); await Promise.all(Array.from({ length: 90 }, (_, i) => writeFile(join(root, `file-${String(i).padStart(3, '0')}.md`), 'Folder content.')));
    const text = await folderSnapshot(root); expect(text).toContain('Snapshot of 80 files.'); expect(text).toContain('Some files were omitted');
  });
});
