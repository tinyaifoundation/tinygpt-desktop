import type { ChatMessage, ChatUpdate, Conversation, LibrarySnapshot, WorkActivity } from '../shared/chat';
import type { ToolActivity, SourceSummary } from '../shared/tools';

type Row = { id: string };
type Rows<T extends Row> = { changed: T[]; removed: string[]; order?: string[] };
type Append = { length: number; text: string };
type ActivityRow = WorkActivity & { appendText?: Append };
type MessagePatch = { id: string; value?: ChatMessage; fields?: Partial<ChatMessage>; text?: Append; reasoning?: Append; activity?: Rows<ActivityRow> };
type LibraryPatch = Partial<Omit<LibrarySnapshot, 'projects' | 'conversations' | 'activeRuns'>> & { projects?: Rows<LibrarySnapshot['projects'][number]>; conversations?: Rows<LibrarySnapshot['conversations'][number]>; activeRuns?: LibrarySnapshot['activeRuns'] };
type ConversationPatch = { fields: Partial<Conversation>; messages: MessagePatch[]; removed: string[]; order?: string[]; path?: string[]; tools?: Rows<ToolActivity>; sources?: Rows<SourceSummary>; contexts?: Rows<NonNullable<Conversation['contextActivities']>[number]> };
export type ChatPacket = { id: string; sequence: number; base: number; full?: Conversation; path?: string[]; patch?: ConversationPatch; library?: LibrarySnapshot; libraryPatch?: LibraryPatch };

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => left[key] === right[key] || typeof left[key] === 'object' && JSON.stringify(left[key]) === JSON.stringify(right[key]));
}
function rows<T extends Row>(old: readonly T[], next: readonly T[]): Rows<T> | undefined {
  if (old === next) return;
  const byId = new Map(old.map(row => [row.id, row]));
  const changed = next.filter(row => !equal(byId.get(row.id), row));
  const ids = new Set(next.map(row => row.id)), removed = old.filter(row => !ids.has(row.id)).map(row => row.id);
  const order = old.length !== next.length || old.some((row, index) => row.id !== next[index]?.id) ? next.map(row => row.id) : undefined;
  return changed.length || removed.length || order ? { changed, removed, order } : undefined;
}
function applyRows<T extends Row>(old: readonly T[], patch?: Rows<T>): T[] {
  if (!patch) return old as T[];
  const byId = new Map(old.map(row => [row.id, row]));
  for (const id of patch.removed) byId.delete(id); for (const row of patch.changed) byId.set(row.id, row);
  return (patch.order ?? [...byId.keys()]).map(id => byId.get(id)!);
}
function messagePatch(old: ChatMessage | undefined, next: ChatMessage): MessagePatch | undefined {
  if (old === next) return;
  if (!old) return { id: next.id, value: next };
  const fields: Partial<ChatMessage> = {}, result: MessagePatch = { id: next.id, fields };
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)]) as Set<keyof ChatMessage>) {
    if (key === 'workActivity') {
      if (next.workActivity === undefined || old.workActivity === undefined) { if (old.workActivity !== next.workActivity) fields.workActivity = next.workActivity; }
      else { const activity = rows(old.workActivity, next.workActivity), prior = new Map(old.workActivity.map(part => [part.id, part])); if (activity) result.activity = { ...activity, changed: activity.changed.map(part => { const before = prior.get(part.id); return before && part.text.startsWith(before.text) ? { ...part, text: '', appendText: { length: before.text.length, text: part.text.slice(before.text.length) } } : part; }) }; }
      continue;
    }
    const before = old[key], after = next[key]; if (equal(before, after)) continue;
    if ((key === 'text' || key === 'reasoning') && typeof before === 'string' && typeof after === 'string' && after.startsWith(before)) result[key] = { length: before.length, text: after.slice(before.length) };
    else (fields as Record<string, unknown>)[key] = after;
  }
  return Object.keys(fields).length || result.text || result.reasoning || result.activity ? result : undefined;
}
function patchConversation(old: Conversation, next: Conversation): ConversationPatch {
  const before = old.allMessages ?? old.messages, after = next.allMessages ?? next.messages, byId = new Map(before.map(row => [row.id, row]));
  const fields: Partial<Conversation> = {};
  for (const key of new Set([...Object.keys(old), ...Object.keys(next)]) as Set<keyof Conversation>) {
    if (['messages', 'allMessages', 'tools', 'sources', 'contextActivities'].includes(key)) continue;
    if (!equal(old[key], next[key])) (fields as Record<string, unknown>)[key] = next[key];
  }
  const ids = new Set(after.map(row => row.id));
  return { fields, messages: after.map(row => messagePatch(byId.get(row.id), row)).filter((row): row is MessagePatch => !!row), removed: before.filter(row => !ids.has(row.id)).map(row => row.id),
    order: before.length !== after.length || before.some((row, index) => row.id !== after[index]?.id) ? after.map(row => row.id) : undefined,
    path: old.messages.length !== next.messages.length || old.messages.some((row, index) => row.id !== next.messages[index]?.id) ? next.messages.map(row => row.id) : undefined,
    tools: rows(old.tools, next.tools), sources: rows(old.sources, next.sources), contexts: rows(old.contextActivities ?? [], next.contextActivities ?? []) };
}
function applyConversation(old: Conversation, patch: ConversationPatch): Conversation {
  const byId = new Map((old.allMessages ?? old.messages).map(row => [row.id, row]));
  for (const id of patch.removed) byId.delete(id);
  for (const change of patch.messages) {
    if (change.value) { byId.set(change.id, change.value); continue; }
    const before = byId.get(change.id); if (!before) throw Error('Missing chat update base.');
    const message = { ...before, ...change.fields };
    for (const key of ['text', 'reasoning'] as const) { const append = change[key]; if (append) { const text = before[key] ?? ''; if (text.length !== append.length) throw Error('Outdated chat update.'); message[key] = text + append.text; } }
    if (change.activity) {
      const prior = new Map((before.workActivity ?? []).map(part => [part.id, part]));
      const changed = change.activity.changed.map(part => { const { appendText, ...fields } = part; if (!appendText) return fields; const text = prior.get(part.id)?.text; if (text === undefined || text.length !== appendText.length) throw Error('Outdated activity update.'); return { ...fields, text: text + appendText.text }; });
      message.workActivity = applyRows(before.workActivity ?? [], { ...change.activity, changed });
    }
    byId.set(change.id, message);
  }
  const changed = patch.messages.length || patch.removed.length || patch.order;
  const allMessages = changed ? (patch.order ?? (old.allMessages ?? old.messages).map(row => row.id)).map(id => byId.get(id)!) : old.allMessages;
  return { ...old, ...patch.fields, allMessages,
    messages: changed || patch.path ? (patch.path ?? old.messages.map(row => row.id)).map(id => byId.get(id)!) : old.messages,
    tools: applyRows(old.tools, patch.tools), sources: applyRows(old.sources, patch.sources), contextActivities: patch.contexts ? applyRows(old.contextActivities ?? [], patch.contexts) : old.contextActivities };
}
function libraryPatch(old: LibrarySnapshot, next: LibrarySnapshot): LibraryPatch | undefined {
  const patch: LibraryPatch = {}, projects = rows(old.projects, next.projects), conversations = rows(old.conversations, next.conversations);
  if (projects) patch.projects = projects; if (conversations) patch.conversations = conversations;
  for (const key of ['lastConversationId', 'activeRuns', 'workQuestions', 'approvals', 'browserHandoffs', 'browserTasks', 'outputsRevision', 'notificationItems'] as const) if (!equal(old[key], next[key])) (patch as Record<string, unknown>)[key] = next[key];
  if (!equal(old.bot, next.bot)) patch.bot = next.bot ?? null;
  return Object.keys(patch).length ? patch : undefined;
}
function applyLibrary(old: LibrarySnapshot, patch?: LibraryPatch): LibrarySnapshot {
  if (!patch) return old;
  const { projects, conversations, activeRuns, ...fields } = patch;
  return { ...old, ...fields, projects: applyRows(old.projects, projects), conversations: applyRows(old.conversations, conversations),
    activeRuns: activeRuns ? activeRuns.map(run => old.activeRuns.find(prior => prior.runId === run.runId && equal(prior, run)) ?? run) : old.activeRuns };
}
function weight(chat: Conversation): number {
  return (chat.allMessages ?? chat.messages).reduce((size, row) => size + row.text.length * 2 + (row.reasoning?.length ?? 0) * 2 + (row.workActivity ?? []).reduce((sum, part) => sum + part.text.length * 2 + 160, 0) + 400, 0) + chat.tools.reduce((size, tool) => size + (tool.result?.length ?? 0) * 2 + 400, 0);
}
class Bases {
  protected bases = new Map<string, { chat: Conversation; sequence: number; bytes: number }>();
  private active = new Set<string>();
  protected pin(library: LibrarySnapshot) { this.active = new Set(library.activeRuns.map(run => run.conversationId)); }
  protected remember(id: string, chat: Conversation, sequence: number) {
    this.bases.delete(id); this.bases.set(id, { chat, sequence, bytes: weight(chat) });
    // Active bases are already working data. Evicting them cyclically would
    // resend entire histories whenever concurrent runs exceed the cache budget.
    const inactive = [...this.bases].filter(([key]) => !this.active.has(key));
    let total = inactive.reduce((sum, [, entry]) => sum + entry.bytes, 0), count = inactive.length;
    for (const [key, entry] of inactive) { if (count <= 16 && total <= 32 * 1024 * 1024) break; total -= entry.bytes; count--; this.bases.delete(key); }
  }
}
export class ChatUpdateEncoder extends Bases {
  private library?: LibrarySnapshot;
  private sequence = 0;
  encode(update: ChatUpdate): ChatPacket {
    const { conversation: chat, library } = update, base = this.bases.get(chat.id), sequence = ++this.sequence;
    this.pin(library);
    const packet: ChatPacket = { id: chat.id, sequence, base: base?.sequence ?? 0, ...(base ? { patch: patchConversation(base.chat, chat) } : { full: { ...chat, messages: [], allMessages: chat.allMessages ?? chat.messages }, path: chat.messages.map(row => row.id) }),
      ...(this.library ? { libraryPatch: libraryPatch(this.library, library) } : { library }) };
    this.library = library; this.remember(chat.id, chat, sequence); return packet;
  }
}
export class ChatUpdateDecoder extends Bases {
  private library?: LibrarySnapshot;
  checkpoints(): ChatPacket[] {
    return [...this.bases].map(([id, base]) => ({ id, sequence: base.sequence, base: 0, full: { ...base.chat, messages: [], allMessages: base.chat.allMessages ?? base.chat.messages }, path: base.chat.messages.map(message => message.id), library: this.library }));
  }
  decode(packet: ChatPacket): ChatUpdate {
    const base = this.bases.get(packet.id);
    if (!packet.full && (!base || base.sequence !== packet.base)) throw Error('Outdated chat update base.');
    let chat: Conversation;
    if (packet.full) { const allMessages = packet.full.allMessages ?? packet.full.messages, byId = new Map(allMessages.map(row => [row.id, row])); chat = { ...packet.full, allMessages, messages: (packet.path ?? allMessages.map(row => row.id)).map(id => byId.get(id)!) }; }
    else chat = applyConversation(base!.chat, packet.patch!);
    if (!packet.library && !this.library) throw Error('Missing chat library base.');
    const library = packet.library ?? applyLibrary(this.library!, packet.libraryPatch);
    this.library = library; this.pin(library); this.remember(packet.id, chat, packet.sequence); return { conversation: chat, library };
  }
}
