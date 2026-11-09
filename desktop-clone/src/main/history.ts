import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { libraryOutputs, type OutputActivity } from '../core/library-outputs';
import type { ChatMessage, ChatProject, ContextCheckpoint, Conversation, ConversationSummary, ConversationOrganization, ProfileUsage, ConversationUsage, MessageStatus, TurnAction } from '../shared/chat';
import type { InferenceRoute } from '../shared/config';
import { capitalizeConversationTitle } from '../shared/conversation-title';
import { isComputerTool } from '../shared/computer';
import { SourceLibrary } from './sources';
import { MemoryLibrary } from './memory-library';
import { WorkTaskStore } from './work-tasks';
import { RequestQueue } from './request-queue';
import { LiveHistory } from './live-history';
import type { ToolActivity, ToolName, ToolStatus } from '../shared/tools';

export class HistoryStore {
  private db: DatabaseSync;
  readonly sources: SourceLibrary;
  readonly memory: MemoryLibrary;
  readonly queue: RequestQueue;
  readonly workTasks: WorkTaskStore;
  private live!: LiveHistory;
  linkConversation(conversationId: string, targetId: string) {
    if (conversationId === targetId) throw new Error('Choose another conversation to link.');
    const target = this.conversation(targetId);
    const drafts = this.sources.list(conversationId, false).filter(source => !source.messageId && ['attachment', 'image', 'conversation', 'folder'].includes(source.kind));
    const existing = drafts.find(source => source.kind === 'conversation' && source.url === `tinygpt-conversation:${targetId}`);
    if (existing) return existing;
    if (drafts.length >= 8) throw new Error('Choose up to eight distinct attachments.');
    const messages = target.messages.filter(message => message.status !== 'streaming' && message.text.trim());
    if (!messages.length) throw new Error('This conversation has no messages to link yet.');
    const transcript = messages.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.text}`).join('\n\n');
    const latest = messages.slice(-2).map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.slice(0, 700)}`).join('\n');
    const text = `Linked conversation: ${target.title}\nSnapshot saved: ${new Date().toISOString()}\n${target.summary ? `Summary: ${target.summary.slice(0, 1000)}\n` : ''}Latest exchange:\n${latest}\n\nConversation transcript${transcript.length > 480000 ? ' (earlier messages omitted)' : ''}:\n${transcript.slice(-480000)}`;
    return this.sources.add(conversationId, { kind: 'conversation', title: target.title, url: `tinygpt-conversation:${targetId}`, text });
  }
  readonly generatedFilesRoot: string;
  constructor(readonly databasePath: string, generatedFilesRoot?: string) {
    this.generatedFilesRoot = generatedFilesRoot ?? (databasePath === ':memory:' ? join(tmpdir(), 'tinygpt-generated-' + randomUUID()) : join(dirname(databasePath), 'generated-files'));
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 21) throw new Error('This library requires a newer version of TinyGPT.');
    this.db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT, instructions TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, run_id TEXT, route TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT) STRICT;
      COMMIT;
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'mode')) this.db.exec("ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat' CHECK(mode IN ('chat','code'))");
      if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'bot')) this.db.exec('ALTER TABLE conversations ADD COLUMN bot INTEGER NOT NULL DEFAULT 0 CHECK(bot IN (0,1))');
      if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'scheduled')) this.db.exec('ALTER TABLE conversations ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0 CHECK(scheduled IN (0,1))');
      if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'pinned')) this.db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0; ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;');
      if (!this.db.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'browser_isolated')) this.db.exec('ALTER TABLE projects ADD COLUMN browser_isolated INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(projects)').all().some(column => column.name === 'favorite')) this.db.exec('ALTER TABLE projects ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
      if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'reasoning')) this.db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''");
      if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'work_duration_ms')) this.db.exec('ALTER TABLE messages ADD COLUMN work_duration_ms INTEGER');
      if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'work_activity')) this.db.exec("ALTER TABLE messages ADD COLUMN work_activity TEXT NOT NULL DEFAULT '[]'");
      if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'presentations')) this.db.exec("ALTER TABLE messages ADD COLUMN presentations TEXT NOT NULL DEFAULT '[]'");
      if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'response_duration_ms')) this.db.exec('ALTER TABLE messages ADD COLUMN response_duration_ms INTEGER');
      if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'read_message_seq')) { this.db.exec("ALTER TABLE conversations ADD COLUMN read_message_seq INTEGER NOT NULL DEFAULT 0; UPDATE conversations SET read_message_seq=COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id=conversations.id AND role='assistant' AND status!='streaming'),0);"); }
      if (!this.db.prepare('PRAGMA table_info(messages)').all().some(column => column.name === 'parent_id')) {
        this.db.exec('ALTER TABLE messages ADD COLUMN parent_id TEXT; ALTER TABLE messages ADD COLUMN continuation_of TEXT; ALTER TABLE conversations ADD COLUMN active_leaf TEXT;');
        this.db.exec(`UPDATE messages SET parent_id=(SELECT prior.id FROM messages prior WHERE prior.conversation_id=messages.conversation_id AND prior.seq<messages.seq ORDER BY prior.seq DESC LIMIT 1);
          UPDATE conversations SET active_leaf=(SELECT id FROM messages WHERE conversation_id=conversations.id ORDER BY seq DESC LIMIT 1);`);
      }
      this.sources = new SourceLibrary(this.db);
      this.memory = new MemoryLibrary(this.db);
      this.sources.connectMemory(this.memory);
      this.db.exec('CREATE TABLE IF NOT EXISTS tool_calls (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, run_id TEXT NOT NULL, name TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL) STRICT;');
      const columns = this.db.prepare('PRAGMA table_info(tool_calls)').all();
      if (!columns.some(column => column.name === 'display_text')) this.db.exec('ALTER TABLE tool_calls ADD COLUMN display_text TEXT');
      if (!columns.some(column => column.name === 'target')) this.db.exec('ALTER TABLE tool_calls ADD COLUMN target TEXT');
      this.db.exec(`CREATE TABLE IF NOT EXISTS context_checkpoints (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        through_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, text TEXT NOT NULL,
        PRIMARY KEY(conversation_id,through_message_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS context_activities (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS context_usage (
        run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversation_tool_grants (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, scope TEXT NOT NULL,
        PRIMARY KEY(conversation_id,scope)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS code_changes (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,run_id TEXT NOT NULL,project_id TEXT REFERENCES projects(id),root_path TEXT NOT NULL,path TEXT NOT NULL,before_text TEXT,after_text TEXT NOT NULL,created_at INTEGER NOT NULL,reverted INTEGER NOT NULL DEFAULT 0) STRICT;
      `);
      if (!this.db.prepare('PRAGMA table_info(code_changes)').all().some(column => column.name === 'state')) this.db.exec("ALTER TABLE code_changes ADD COLUMN state TEXT NOT NULL DEFAULT 'applied'");
      if (this.db.prepare('PRAGMA table_info(code_changes)').all().some(column => column.name === 'project_id' && column.notnull === 1)) this.db.exec(`CREATE TABLE code_changes_v19 (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,run_id TEXT NOT NULL,project_id TEXT REFERENCES projects(id),root_path TEXT NOT NULL,path TEXT NOT NULL,before_text TEXT,after_text TEXT NOT NULL,created_at INTEGER NOT NULL,reverted INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'applied') STRICT;
        INSERT INTO code_changes_v19 SELECT id,conversation_id,run_id,project_id,root_path,path,before_text,after_text,created_at,reverted,state FROM code_changes;
        DROP TABLE code_changes; ALTER TABLE code_changes_v19 RENAME TO code_changes;`);
      if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(column => column.name === 'title_source')) {
        this.db.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'fallback' CHECK(title_source IN ('fallback','generated','manual')); ALTER TABLE conversations ADD COLUMN description_revision INTEGER NOT NULL DEFAULT 0;");
        // Older releases did not record manual renames. Preserve any title that
        // differs from the known first-prompt fallback, including empty chats.
        for (const row of this.db.prepare("SELECT id,title,(SELECT text FROM messages WHERE conversation_id=conversations.id AND role='user' ORDER BY seq LIMIT 1) AS first_text FROM conversations").all()) {
          const fallback = typeof row.first_text === 'string' ? row.first_text.replace(/\s+/g, ' ').slice(0, 70) : 'New chat';
          if (row.title !== fallback) this.db.prepare("UPDATE conversations SET title_source='manual' WHERE id=?").run(row.id);
        }
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS conversation_descriptions (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        summary TEXT NOT NULL, through_message_id TEXT NOT NULL, completed_turns INTEGER NOT NULL,
        title_turns INTEGER NOT NULL DEFAULT 0
        ) STRICT; CREATE TABLE IF NOT EXISTS message_reactions (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,actor TEXT NOT NULL CHECK(actor IN ('user','bot')),emoji TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(message_id,actor)) STRICT; PRAGMA user_version = 21; COMMIT;`);
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    // Backfill automatic labels once so Activity and other SQL-backed views
    // agree with the sidebar, without changing chat order or manual names.
    if (!this.db.prepare("SELECT value FROM metadata WHERE key='capitalized-conversation-titles-v1'").get()) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const update = this.db.prepare('UPDATE conversations SET title=? WHERE id=?');
        for (const row of this.db.prepare("SELECT id,title FROM conversations WHERE title_source!='manual'").all()) {
          const title = capitalizeConversationTitle(String(row.title));
          if (title !== row.title) update.run(title, row.id);
        }
        this.db.prepare("INSERT INTO metadata(key,value) VALUES('capitalized-conversation-titles-v1','1')").run();
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    }
    this.queue = new RequestQueue(this.db);
    this.workTasks = new WorkTaskStore(this.db);
    this.db.prepare("UPDATE tool_calls SET status='interrupted' WHERE status IN ('pending','running')").run();
    this.db.prepare("UPDATE context_activities SET status='interrupted' WHERE status='running'").run();
    // An unclean shutdown cannot leave a response pretending to still stream.
    this.db.prepare("UPDATE messages SET status='interrupted', error='TinyGPT closed before this reply finished. You can retry it.' WHERE status='streaming'").run();
    this.db.exec(`CREATE INDEX IF NOT EXISTS tools_conversation_order ON tool_calls(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS tools_connection ON tool_calls(conversation_id,name,status,run_id);
      CREATE INDEX IF NOT EXISTS tools_run ON tool_calls(run_id);
      CREATE INDEX IF NOT EXISTS context_conversation_order ON context_activities(conversation_id,created_at);
      CREATE INDEX IF NOT EXISTS context_run ON context_activities(run_id);
      CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id);
      CREATE INDEX IF NOT EXISTS reactions_created ON message_reactions(created_at);`);
    this.live = new LiveHistory(this.db, id => this.conversation(id), id => this.sources.list(id));
  }
  hasConversation(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM conversations WHERE id=?').get(id); }
  watchConversation(id: string, initial: Conversation) { this.live.watch(id, initial); }
  unwatchConversation(id: string) { this.live.forget(id); }
  liveConversation(id: string): Conversation { return this.live.read(id); }
  outputsRevision(): number { return this.live.outputsRevision(); }
  close(): void { this.db.close(); }
  projects(): ChatProject[] {
    return (this.db.prepare('SELECT id, name, root_path AS rootPath, instructions,browser_isolated AS browserIsolated,favorite FROM projects ORDER BY favorite DESC,name COLLATE NOCASE').all() as unknown as ChatProject[]).map(row => ({ ...row, browserIsolated: !!row.browserIsolated, favorite: !!row.favorite }));
  }
  project(id: string): ChatProject {
    const project = this.db.prepare('SELECT id, name, root_path AS rootPath, instructions,browser_isolated AS browserIsolated,favorite FROM projects WHERE id=?').get(id);
    if (!project) throw new Error('Project not found.');
    const value = project as unknown as ChatProject; return { ...value, browserIsolated: !!value.browserIsolated, favorite: !!value.favorite };
  }
  createProject(name: string, instructions: string, browserIsolated = false, rootPath: string | null = null): ChatProject {
    const id = randomUUID();
    this.db.prepare('INSERT INTO projects(id,name,instructions,browser_isolated,root_path) VALUES(?,?,?,?,?)').run(id, name, instructions, Number(browserIsolated), rootPath);
    this.memory.ensureDefaultIndexes();
    return this.project(id);
  }
  updateProject(id: string, name: string, instructions: string, browserIsolated = false, rootPath?: string | null): void {
    this.project(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (rootPath !== undefined && rootPath !== this.project(id).rootPath) this.setProjectFolder(id, rootPath);
      this.db.prepare('UPDATE projects SET name=?,instructions=?,browser_isolated=? WHERE id=?').run(name, instructions, Number(browserIsolated), id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setProjectFolder(id: string, canonicalPath: string | null): ChatProject {
    const previous = this.project(id);
    if (previous.rootPath === canonicalPath) return previous;
    this.memory.forgetIndex(id);
    this.sources.removeProjectFiles(id);
    this.db.prepare('UPDATE projects SET root_path=? WHERE id=?').run(canonicalPath, id);
    if (canonicalPath) this.memory.configureIndex(id, true);
    return this.project(id);
  }
  organizeProject(action: import('../shared/chat').ProjectOrganization): void {
    this.project(action.id);
    if (action.action === 'favorite') { this.db.prepare('UPDATE projects SET favorite=? WHERE id=?').run(Number(action.value), action.id); return; }
    if (action.action === 'archive-chats') { this.db.prepare('UPDATE conversations SET archived=1 WHERE project_id=?').run(action.id); return; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Remove the local grouping, retaining chats and their attached evidence.
      this.memory.forgetIndex(action.id);
      this.db.prepare('DELETE FROM project_indexes WHERE project_id=?').run(action.id);
      this.db.prepare('DELETE FROM knowledge_documents WHERE project_id=?').run(action.id);
      this.db.prepare('DELETE FROM knowledge_exclusions WHERE project_id=?').run(action.id);
      this.db.prepare('UPDATE sources SET project_id=NULL WHERE project_id=?').run(action.id);
      this.db.prepare('UPDATE conversations SET project_id=NULL WHERE project_id=?').run(action.id);
      this.db.prepare('DELETE FROM code_changes WHERE project_id=?').run(action.id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(action.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  markScheduledConversations(ids: string[]) {
    if (!ids.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const mark = this.db.prepare('UPDATE conversations SET scheduled=1 WHERE id=? AND bot=0 AND scheduled=0');
      for (const id of ids) mark.run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  conversations(): ConversationSummary[] {
    return (this.db.prepare(`SELECT id,CASE WHEN bot=1 THEN 'bot' ELSE mode END AS mode,project_id AS projectId,title,title_source AS titleSource,(SELECT summary FROM conversation_descriptions WHERE conversation_id=conversations.id) AS summary,created_at AS createdAt,updated_at AS updatedAt,pinned,archived,scheduled,
      EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id AND m.role='assistant' AND m.status IN ('complete','error','interrupted') AND m.seq>conversations.read_message_seq) AS unread,
      EXISTS(SELECT 1 FROM tool_calls t JOIN messages m ON m.id=conversations.active_leaf AND m.run_id=t.run_id WHERE t.conversation_id=conversations.id AND t.name='request_plugin_connection' AND t.status='success' AND CASE WHEN json_valid(t.result) THEN json_extract(t.result,'$.status')='pending' ELSE 0 END) AS connectionPending
      FROM conversations ORDER BY updated_at DESC, rowid DESC`).all() as unknown as (ConversationSummary & { titleSource: string })[]).map(({ titleSource, ...row }) => ({ ...row, title: titleSource === 'manual' ? row.title : capitalizeConversationTitle(row.title), pinned: !!row.pinned, archived: !!row.archived, unread: !!row.unread, connectionPending: !!row.connectionPending, scheduled: !!row.scheduled }));
  }
  scheduleSuggestionContext(route: InferenceRoute, personalBotId: string | null): { title: string; summary: string }[] {
    // Titles/blurbs only. Read route metadata for privacy without hydrating any
    // message text, attachments, tool results, or complete conversations.
    return this.db.prepare(`SELECT c.title,COALESCE(d.summary,'') AS summary FROM conversations c
      LEFT JOIN conversation_descriptions d ON d.conversation_id=c.id
      WHERE c.archived=0 AND (c.bot=0 OR c.id=?) AND
      (SELECT m.route FROM messages m WHERE m.conversation_id=c.id AND m.role='assistant' AND m.status='complete' ORDER BY m.seq DESC LIMIT 1)=?
      ORDER BY c.updated_at DESC LIMIT 8`).all(personalBotId,route).map(row => ({ title:String(row.title).slice(0,120),summary:String(row.summary).slice(0,700) }));
  }
  markConversationRead(id: string, messageId: string): void { this.db.prepare("UPDATE conversations SET read_message_seq=MAX(read_message_seq,(SELECT seq FROM messages WHERE id=? AND conversation_id=? AND role='assistant' AND status!='streaming')) WHERE id=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND role='assistant' AND status!='streaming')").run(messageId, id, id, messageId, id); }
  hasConversationGrant(id: string, scope: string): boolean { return !!this.db.prepare('SELECT 1 FROM conversation_tool_grants WHERE conversation_id=? AND scope=?').get(id, scope); }
  grantConversationTool(id: string, scope: string): void { this.db.prepare('INSERT OR IGNORE INTO conversation_tool_grants(conversation_id,scope) VALUES(?,?)').run(id, scope); }
  clearConversationGrants(): void { this.db.exec('DELETE FROM conversation_tool_grants'); }
  revokeConversationGrants(id: string, prefix: string): void { this.db.prepare('DELETE FROM conversation_tool_grants WHERE conversation_id=? AND substr(scope,1,?)=?').run(id,prefix.length,prefix); }
  conversation(id: string): Conversation {
    const storedSummary = this.db.prepare("SELECT id,CASE WHEN bot=1 THEN 'bot' ELSE mode END AS mode,project_id AS projectId,title,title_source AS titleSource,(SELECT summary FROM conversation_descriptions WHERE conversation_id=conversations.id) AS summary,created_at AS createdAt,updated_at AS updatedAt,active_leaf AS headId,pinned,archived,scheduled FROM conversations WHERE id=?").get(id);
    if (!storedSummary) throw new Error('Conversation not found.');
    const { titleSource, ...summary } = storedSummary;
    if (titleSource !== 'manual') summary.title = capitalizeConversationTitle(String(summary.title));
    const reactions = this.db.prepare('SELECT r.message_id AS messageId,r.actor,r.emoji,r.created_at AS createdAt FROM message_reactions r JOIN messages m ON m.id=r.message_id WHERE m.conversation_id=? ORDER BY r.created_at').all(id) as unknown as (import('../shared/bot-reactions').MessageReaction & { messageId: string })[];
    const attachments = this.sources.messageAttachments(id);
    const storedMessages = (this.db.prepare('SELECT id,role,text,reasoning,status,error,created_at AS createdAt,run_id AS runId,route,work_duration_ms AS workDurationMs,parent_id AS parentId,continuation_of AS continuationOf,work_activity AS workActivityJson,presentations AS presentationsJson FROM messages WHERE conversation_id=? ORDER BY seq').all(id) as unknown as (ChatMessage & { workActivityJson: string; presentationsJson: string })[]).map(({ workActivityJson, presentationsJson, ...message }) => ({ ...message, ...(reactions.some(reaction => reaction.messageId === message.id) ? { reactions: reactions.filter(reaction => reaction.messageId === message.id).map(({ messageId, ...reaction }) => reaction) } : {}), ...(workActivityJson !== '[]' ? { workActivity: JSON.parse(workActivityJson) as import('../shared/chat').WorkActivity[] } : {}), ...(presentationsJson !== '[]' ? { presentations: JSON.parse(presentationsJson) as ChatMessage['presentations'] } : {}), attachmentIds: attachments.get(message.id) ?? [] }));
    const allMessages = this.parentFirst(storedMessages).map(message => ({ ...message, workTask: this.workTasks.forMessage(message.id) }));
    const messages = this.path(allMessages, summary.headId as string | null);
    const tools = this.db.prepare('SELECT id,conversation_id AS conversationId,run_id AS runId,name,summary,status,result,created_at AS createdAt,display_text AS displayText,target FROM tool_calls WHERE conversation_id=? ORDER BY created_at,rowid').all(id) as unknown as ToolActivity[];
    const contextActivities = this.db.prepare('SELECT id,run_id AS runId,status,created_at AS createdAt FROM context_activities WHERE conversation_id=? ORDER BY created_at,rowid').all(id) as unknown as NonNullable<Conversation['contextActivities']>;
    return { ...(summary as unknown as ConversationSummary), queuedRequests: this.queue.list(id), queuePaused: this.queue.paused(id), pinned: !!summary.pinned, archived: !!summary.archived, scheduled: !!summary.scheduled, headId: summary.headId as string | null, messages, allMessages, sources: this.sources.list(id), tools, contextActivities };
  }
  reactToMessage(id: string, messageId: string, emoji: import('../shared/bot-reactions').MessageReaction['emoji'] | null, actor: 'user' | 'bot' = 'user'): void {
    const conversation = this.conversation(id); const message = conversation.messages.find(item => item.id === messageId);
    if (conversation.mode !== 'bot' || !message || message.status === 'streaming' || actor === 'bot' && message.role !== 'user') throw new Error('This message cannot be reacted to.');
    if (emoji === null) this.db.prepare('DELETE FROM message_reactions WHERE message_id=? AND actor=?').run(messageId, actor);
    else this.db.prepare('INSERT INTO message_reactions(message_id,actor,emoji,created_at) VALUES(?,?,?,?) ON CONFLICT(message_id,actor) DO UPDATE SET emoji=excluded.emoji,created_at=excluded.created_at').run(messageId, actor, emoji, Date.now());
  }
  organizeConversation(input: ConversationOrganization): void {
    this.conversation(input.id);
    if (input.action === 'move') {
      if (input.projectId) this.project(input.projectId);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('UPDATE conversations SET project_id=?,updated_at=? WHERE id=?').run(input.projectId, Date.now(), input.id);
        // Explicitly moving a chat also moves only its own saved sources.
        this.db.prepare('UPDATE sources SET project_id=? WHERE conversation_id=?').run(input.projectId, input.id);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } else this.db.prepare(`UPDATE conversations SET ${input.action === 'pin' ? 'pinned' : 'archived'}=? WHERE id=?`).run(Number(input.value), input.id);
  }
  conversationUsage(id: string): ConversationUsage {
    if (!this.db.prepare('SELECT id FROM conversations WHERE id=?').get(id)) throw new Error('Conversation not found.');
    const tokens = this.db.prepare('SELECT COUNT(*) AS reported,SUM(input_tokens+output_tokens) AS total FROM context_usage WHERE conversation_id=?').get(id)!;
    const messages = this.db.prepare("SELECT COUNT(*) AS messages,SUM(role='assistant' AND status='complete') AS responses FROM messages WHERE conversation_id=?").get(id)!;
    const missing = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=? AND role='assistant' AND status<>'streaming' AND run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM context_usage WHERE run_id=messages.run_id)").get(id)!;
    // Use only completed runs with measured duration and provider-reported output.
    // The speed includes tools/approval waits, rather than claiming decode speed.
    const speed = this.db.prepare(`SELECT SUM(u.output_tokens) AS output,SUM(m.duration) AS duration FROM context_usage u JOIN (
      SELECT run_id,MAX(created_at+response_duration_ms)-MIN(created_at) AS duration FROM messages
      WHERE role='assistant' AND status='complete' AND response_duration_ms>0 GROUP BY run_id
    ) m ON m.run_id=u.run_id WHERE u.conversation_id=?`).get(id)!;
    return { totalTokens: Number(tokens.reported) ? Number(tokens.total) : null, missingUsage: Number(missing.count) > 0,
      tokensPerSecond: Number(speed.duration) > 0 ? Number(speed.output) * 1000 / Number(speed.duration) : null,
      messages: Number(messages.messages), responses: Number(messages.responses ?? 0),
      toolCalls: Number(this.db.prepare('SELECT COUNT(*) AS count FROM tool_calls WHERE conversation_id=?').get(id)!.count) };
  }
  outputs() {
    const activities = this.db.prepare(`SELECT t.id,t.conversation_id AS conversationId,t.run_id AS runId,t.name,t.summary,t.status,t.result,t.created_at AS createdAt,
      c.title AS conversationTitle,c.project_id AS conversationProjectId FROM tool_calls t JOIN conversations c ON c.id=t.conversation_id
      WHERE t.status='success' AND t.result IS NOT NULL ORDER BY t.created_at,t.rowid`).all() as unknown as OutputActivity[];
    const projects = this.db.prepare('SELECT id,name FROM projects').all() as unknown as { id: string; name: string }[];
    const images = this.db.prepare("SELECT s.id,s.title,s.created_at AS createdAt,s.conversation_id AS conversationId,c.title AS conversationTitle,c.project_id AS projectId FROM sources s JOIN conversations c ON c.id=s.conversation_id WHERE s.kind='generated-image' ORDER BY s.created_at DESC").all();
    const inputs = this.db.prepare("SELECT s.id,s.title,s.kind,s.mime,s.created_at AS updatedAt,s.conversation_id AS conversationId,s.project_id AS projectId,c.title AS conversationTitle FROM sources s JOIN conversations c ON c.id=s.conversation_id WHERE s.kind IN ('attachment','image','folder','conversation','page','project-file')").all().map(row => ({ id: String(row.id), sourceId: String(row.id), path: String(row.title), name: String(row.title), type: String(row.mime), category: row.kind === 'image' ? 'images' as const : 'files' as const, conversationId: String(row.conversationId), conversationTitle: String(row.conversationTitle), projectId: row.projectId ? String(row.projectId) : undefined, projectName: projects.find(project => project.id === row.projectId)?.name, updatedAt: Number(row.updatedAt), origin: ['attachment','image','folder','conversation'].includes(String(row.kind)) ? 'upload' as const : 'source' as const, excluded: this.sources.isExcluded(String(row.id)), processing: this.sources.fileStatus(String(row.id)) }));
    const indexed = this.memory.documents().map(document => ({ id: document.id, sourceId: document.id, path: document.title, name: document.title, type: 'text/plain', category: 'files' as const, projectId: document.projectId, projectName: projects.find(project => project.id === document.projectId)?.name, conversationId: '', conversationTitle: 'Project file', updatedAt: document.updatedAt, excluded: document.excluded, origin: 'project' as const }));
    return [...libraryOutputs(activities, projects).map(row => ({ ...row, origin: 'created' as const })), ...inputs, ...indexed, ...images.map(row => ({id:String(row.id),sourceId:String(row.id),path:String(row.title)+'.png',name:String(row.title),type:'image',category:'images' as const,conversationId:String(row.conversationId),conversationTitle:String(row.conversationTitle),projectId:row.projectId?String(row.projectId):undefined,projectName:projects.find(project=>project.id===row.projectId)?.name,updatedAt:Number(row.createdAt),origin:'created' as const}))].sort((a,b)=>b.updatedAt-a.updatedAt);
  }
  profileUsage(now = new Date()): ProfileUsage {
    // Join usage once per run, rather than once per message (which doubles tokens).
    // Use the saved reply's local day for historical runs, including saved branches.
    const daily = this.db.prepare(`WITH run_days AS (
        SELECT run_id,MIN(created_at) AS created_at FROM messages WHERE role='assistant' AND run_id IS NOT NULL GROUP BY run_id
      ), daily_tokens AS (
        SELECT strftime('%Y-%m-%d',r.created_at/1000,'unixepoch','localtime') AS day,SUM(u.input_tokens+u.output_tokens) AS tokens
        FROM context_usage u JOIN run_days r ON r.run_id=u.run_id GROUP BY day
      ), daily_tools AS (
        SELECT strftime('%Y-%m-%d',r.created_at/1000,'unixepoch','localtime') AS day,COUNT(*) AS tools
        FROM tool_calls t JOIN run_days r ON r.run_id=t.run_id WHERE t.status='success' GROUP BY day
      ), daily_messages AS (
        SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch','localtime') AS day,COUNT(*) AS messages,
          SUM(role='assistant' AND status='complete') AS responses,COUNT(DISTINCT conversation_id) AS chats FROM messages GROUP BY day
      ) SELECT d.*,u.tokens,COALESCE(t.tools,0) AS tools FROM daily_messages d
        LEFT JOIN daily_tokens u ON u.day=d.day LEFT JOIN daily_tools t ON t.day=d.day ORDER BY d.day`).all() as unknown as ProfileUsage['daily'];
    const serial = (day: string) => { const [year, month, date] = day.split('-').map(Number); return Date.UTC(year, month - 1, date) / 86400000; };
    let longestStreak = 0; let streak = 0; let last = -Infinity;
    for (const item of daily) { const day = serial(item.day); streak = day === last + 1 ? streak + 1 : 1; longestStreak = Math.max(longestStreak, streak); last = day; }
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000;
    const tokens = this.db.prepare('SELECT COUNT(*) AS reported,SUM(input_tokens+output_tokens) AS total,MAX(input_tokens+output_tokens) AS peak FROM context_usage').get()!;
    const missing = this.db.prepare("SELECT COUNT(DISTINCT run_id) AS missing FROM messages WHERE role='assistant' AND status<>'streaming' AND run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM context_usage u WHERE u.run_id=messages.run_id)").get()!;
    return { daily, totalTokens: Number(tokens.reported) ? Number(tokens.total) : null, peakTokens: Number(tokens.reported) ? Number(tokens.peak) : null, missingUsage: Number(missing.missing) > 0,
      currentStreak: last >= today - 1 ? streak : 0, longestStreak,
      longestChat: Number(this.db.prepare("SELECT MAX(turns) AS value FROM (SELECT COUNT(*) AS turns FROM messages WHERE role='user' GROUP BY conversation_id)").get()?.value ?? 0),
      conversationCount: Number(this.db.prepare('SELECT COUNT(*) AS value FROM conversations').get()!.value), responseCount: Number(this.db.prepare("SELECT COUNT(*) AS value FROM messages WHERE role='assistant' AND status='complete'").get()!.value),
      toolCalls: Number(this.db.prepare("SELECT COUNT(*) AS value FROM tool_calls WHERE status='success'").get()!.value), topTools: this.db.prepare("SELECT name,COUNT(*) AS count FROM tool_calls WHERE status='success' GROUP BY name ORDER BY count DESC,name LIMIT 5").all() as unknown as ProfileUsage['topTools'] };
  }
  contextCheckpoint(id: string, path: ChatMessage[]): ContextCheckpoint | undefined {
    const checkpoints = new Map(this.db.prepare('SELECT through_message_id,text FROM context_checkpoints WHERE conversation_id=?').all(id).map(row => [String(row.through_message_id), String(row.text)]));
    for (const message of [...path].reverse()) { const text = checkpoints.get(message.id); if (text) return { throughMessageId: message.id, text }; }
    return undefined;
  }
  saveContextCheckpoint(id: string, checkpoint: ContextCheckpoint): void {
    const message = this.db.prepare('SELECT id FROM messages WHERE conversation_id=? AND id=?').get(id, checkpoint.throughMessageId);
    if (!message || !checkpoint.text.trim() || checkpoint.text.length > 32000) throw new Error('Invalid conversation checkpoint.');
    this.db.prepare('INSERT INTO context_checkpoints VALUES(?,?,?) ON CONFLICT(conversation_id,through_message_id) DO UPDATE SET text=excluded.text').run(id, checkpoint.throughMessageId, checkpoint.text);
  }
  contextActivity(id: string, conversationId: string, runId: string, status: 'running' | 'complete' | 'error'): void {
    this.db.prepare('INSERT INTO context_activities VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status WHERE context_activities.conversation_id=excluded.conversation_id AND context_activities.run_id=excluded.run_id').run(id, conversationId, runId, status, Date.now());
  }
  finishContextActivities(runId: string): void { this.db.prepare("UPDATE context_activities SET status='interrupted' WHERE run_id=? AND status='running'").run(runId); }
  recordContextUsage(conversationId: string, runId: string, inputTokens: number, outputTokens: number): void {
    this.db.prepare('INSERT INTO context_usage VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET input_tokens=context_usage.input_tokens+excluded.input_tokens,output_tokens=context_usage.output_tokens+excluded.output_tokens').run(runId, conversationId, inputTokens, outputTokens);
  }
  private parentFirst(messages: ChatMessage[]): ChatMessage[] {
    // Steering is inserted after the active assistant was created. The UI's
    // branch repository requires parents before children, regardless of seq.
    const byId = new Map(messages.map(message => [message.id, message]));
    const ordered: ChatMessage[] = []; const added = new Set<string>();
    for (const message of messages) {
      const chain: ChatMessage[] = []; const seen = new Set<string>(); let current: ChatMessage | undefined = message;
      while (current && !added.has(current.id)) {
        if (seen.has(current.id)) throw new Error('Invalid conversation branch.');
        seen.add(current.id); chain.push(current);
        const parentId: string | null | undefined = current.parentId;
        current = parentId ? byId.get(parentId) : undefined;
        if (parentId && !current) throw new Error('Invalid conversation branch.');
      }
      for (const item of chain.reverse()) { ordered.push(item); added.add(item.id); }
    }
    return ordered;
  }
  private path(messages: ChatMessage[], headId: string | null): ChatMessage[] {
    const byId = new Map(messages.map(message => [message.id, message])); const path: ChatMessage[] = []; const seen = new Set<string>();
    while (headId) {
      const message = byId.get(headId);
      if (!message || seen.has(headId)) throw new Error('Message not found in this conversation.');
      seen.add(headId); path.unshift(message); headId = message.parentId ?? null;
    }
    return path;
  }
  planTurn(id: string, text: string | null, action?: TurnAction): { context: ChatMessage[]; parentId: string | null; edited?: ChatMessage; continued?: ChatMessage; resumed?: ChatMessage } {
    const conversation = this.conversation(id);
    if (conversation.mode === 'bot' && (action && action.type !== 'resume-plugin' || text === null && !action)) throw new Error('Bot messages cannot be edited, regenerated, or versioned. Send a new message instead.');
    if (action) {
      const target = conversation.messages.find(message => message.id === action.messageId);
      if (!target || target.status === 'streaming' || (action.type === 'edit') !== (target.role === 'user')) throw new Error('Message not found in this conversation.');
      const resumableWork = conversation.mode === 'code' && target.status === 'complete' && ['blocked', 'waiting'].includes(target.workTask?.status ?? '');
      if (action.type === 'continue' && !['cancelled', 'interrupted', 'error'].includes(target.status) && !resumableWork) throw new Error('This reply cannot be continued.');
      const path = this.path(conversation.allMessages!, target.id);
      if (action.type === 'resume-plugin') { if (target.id !== conversation.messages.at(-1)?.id) throw new Error('This connection request is no longer current.'); return { context: path, parentId: target.id, resumed: target }; }
      return { context: action.type === 'continue' && target.text ? path : path.slice(0, -1), parentId: target.parentId ?? null, ...(action.type === 'edit' ? { edited: target } : action.type === 'continue' ? { continued: target } : {}) };
    }
    if (text !== null) return { context: conversation.messages, parentId: conversation.headId ?? null };
    const last = conversation.messages.at(-1);
    if (!last || last.role !== 'assistant') throw new Error('There is no reply to retry.');
    return { context: conversation.messages.slice(0, -1), parentId: last.parentId ?? null };
  }
  selectBranch(id: string, messageId: string): Conversation {
    const conversation = this.conversation(id);
    if (conversation.mode === 'bot') throw new Error('Bot conversations do not have response versions.');
    if (!conversation.allMessages!.some(message => message.id === messageId)) throw new Error('Message not found in this conversation.');
    this.db.prepare('UPDATE conversations SET active_leaf=?,description_revision=description_revision+1 WHERE id=?').run(messageId, id);
    this.clearOffBranchDescription(id);
    return this.conversation(id);
  }
  discardReply(id: string, messageId: string): Conversation {
    const conversation = this.conversation(id); const message = conversation.messages.find(item => item.id === messageId);
    if (!message || message.role !== 'assistant' || !['cancelled', 'error', 'interrupted'].includes(message.status) || conversation.allMessages!.some(item => item.parentId === messageId || item.continuationOf === messageId)) throw new Error('Only an unfinished reply without follow-ups can be discarded.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE conversations SET active_leaf=?,description_revision=description_revision+1 WHERE id=?').run(message.parentId ?? null, id);
      this.clearOffBranchDescription(id);
      this.db.prepare('DELETE FROM tool_calls WHERE conversation_id=? AND run_id=?').run(id, message.runId);
      this.db.prepare('DELETE FROM context_activities WHERE conversation_id=? AND run_id=?').run(id, message.runId);
      this.db.prepare('DELETE FROM context_usage WHERE conversation_id=? AND run_id=?').run(id, message.runId);
      this.db.prepare('DELETE FROM messages WHERE conversation_id=? AND id=?').run(id, messageId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.conversation(id);
  }
  lastConversationId(): string | null {
    const value = this.db.prepare("SELECT value FROM metadata WHERE key='lastConversationId'").get()?.value;
    return typeof value === 'string' && this.conversations().some(item => item.id === value) ? value : null;
  }
  selectConversation(id: string): Conversation {
    const conversation = this.conversation(id);
    this.db.prepare("INSERT INTO metadata(key,value) VALUES('lastConversationId',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
    return conversation;
  }
  createConversation(projectId: string | null, mode: 'chat' | 'code' | 'bot' = 'chat'): Conversation {
    if (projectId) this.project(projectId);
    const id = randomUUID(); const now = Date.now();
    this.db.prepare("INSERT INTO conversations(id,project_id,title,created_at,updated_at,mode,bot) VALUES(?,?,'New chat',?,?,?,?)").run(id, projectId, now, now, mode === 'bot' ? 'chat' : mode, Number(mode === 'bot'));
    return this.selectConversation(id);
  }
  setConversationMode(id: string, mode: 'chat' | 'code' | 'bot'): void {
    if (this.conversation(id).messages.length) return;
    this.db.prepare('UPDATE conversations SET mode=?,bot=? WHERE id=?').run(mode === 'bot' ? 'chat' : mode, Number(mode === 'bot'), id);
  }
  codeChanges(id: string): import('../shared/code').CodeChange[] {
    this.conversation(id);
    return (this.db.prepare('SELECT id,conversation_id AS conversationId,run_id AS runId,project_id AS projectId,path,before_text AS before,after_text AS after,created_at AS createdAt,reverted,state FROM code_changes WHERE conversation_id=? ORDER BY created_at,rowid').all(id) as unknown as import('../shared/code').CodeChange[]).map(row => ({ ...row, reverted: !!row.reverted }));
  }
  codeChangeRoot(id: string): string { return String(this.db.prepare('SELECT root_path FROM code_changes WHERE id=?').get(id)?.root_path ?? ''); }
  saveCodeChange(conversationId: string, runId: string, projectId: string | null, root: string, path: string, before: string | null, after: string): string {
    const id = randomUUID(); this.db.prepare("INSERT INTO code_changes(id,conversation_id,run_id,project_id,root_path,path,before_text,after_text,created_at,state) VALUES(?,?,?,?,?,?,?,?,?,'pending')").run(id,conversationId,runId,projectId,root,path,before,after,Date.now()); return id;
  }
  updateCodeChangeAfter(id: string, after: string): void { this.db.prepare('UPDATE code_changes SET after_text=? WHERE id=? AND state=\'pending\'').run(after,id); }
  setCodeChangeState(id: string, state: NonNullable<import('../shared/code').CodeChange['state']>): void { this.db.prepare('UPDATE code_changes SET state=?,reverted=? WHERE id=?').run(state,Number(state === 'reverted'),id); }
  pendingCodeChanges(): import('../shared/code').CodeChange[] { return this.conversations().flatMap(conversation => this.codeChanges(conversation.id).filter(change => ['pending','undo-pending'].includes(change.state!))); }
  renameConversation(id: string, title: string): void {
    this.conversation(id);
    this.db.prepare("UPDATE conversations SET title=?,title_source='manual',description_revision=description_revision+1,updated_at=? WHERE id=?").run(title, Date.now(), id);
  }
  descriptionState(id: string): { headId: string | null; revision: number; titleSource: 'fallback' | 'generated' | 'manual'; summary: string; throughId: string | null; completedTurns: number; titleTurns: number } | undefined {
    return this.db.prepare(`SELECT active_leaf AS headId,description_revision AS revision,title_source AS titleSource,
      COALESCE(d.summary,'') AS summary,d.through_message_id AS throughId,COALESCE(d.completed_turns,0) AS completedTurns,COALESCE(d.title_turns,0) AS titleTurns
      FROM conversations c LEFT JOIN conversation_descriptions d ON d.conversation_id=c.id WHERE c.id=?`).get(id) as ReturnType<HistoryStore['descriptionState']>;
  }
  saveDescription(id: string, expected: { headId: string; revision: number }, description: { title: string; summary: string }, completedTurns: number, replaceTitle: boolean): boolean {
    const current = this.descriptionState(id);
    if (!current || current.headId !== expected.headId || current.revision !== expected.revision) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updateTitle = replaceTitle && current.titleSource !== 'manual';
      if (updateTitle) this.db.prepare("UPDATE conversations SET title=?,title_source='generated' WHERE id=?").run(capitalizeConversationTitle(description.title), id);
      this.db.prepare(`INSERT INTO conversation_descriptions(conversation_id,summary,through_message_id,completed_turns,title_turns) VALUES(?,?,?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET summary=excluded.summary,through_message_id=excluded.through_message_id,completed_turns=excluded.completed_turns,title_turns=excluded.title_turns`).run(id, description.summary, expected.headId, completedTurns, updateTitle ? completedTurns : current.titleTurns);
      // Metadata must not reorder chats or alter unread/read receipts.
      this.db.prepare('UPDATE conversations SET description_revision=description_revision+1 WHERE id=?').run(id);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private clearOffBranchDescription(id: string): void {
    const state = this.descriptionState(id);
    if (state?.throughId && !this.conversation(id).messages.some(message => message.id === state.throughId)) this.db.prepare('DELETE FROM conversation_descriptions WHERE conversation_id=?').run(id);
  }
  clearBotConversation(id: string): Conversation {
    const conversation = this.conversation(id);
    if (conversation.mode !== 'bot') throw new Error('Only bot conversations can be cleared here.');
    if ((conversation.allMessages ?? conversation.messages).some(message => message.status === 'streaming')) throw new Error('Stop your bot before clearing its conversation.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Clear conversation context and permissions, leaving workspace files and
      // independently saved memory untouched. Delete attachments before messages
      // so ON DELETE SET NULL cannot turn old attachments into fresh drafts.
      this.db.prepare("DELETE FROM sources WHERE conversation_id=? AND kind!='generated-image'").run(id);
      for (const table of ['tool_calls', 'context_checkpoints', 'context_activities', 'context_usage', 'conversation_tool_grants', 'conversation_descriptions', 'code_changes', 'queued_requests', 'request_queue_state', 'messages']) this.db.prepare('DELETE FROM ' + table + ' WHERE conversation_id=?').run(id);
      this.db.prepare('UPDATE conversations SET active_leaf=NULL, read_message_seq=0, updated_at=?, description_revision=description_revision+1 WHERE id=?').run(Date.now(), id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.conversation(id);
  }
  deleteConversation(id: string): void {
    this.conversation(id);
    this.db.prepare('DELETE FROM conversations WHERE id=?').run(id);
  }
  startTurn(id: string, text: string | null, route: InferenceRoute, attachmentIds: string[] = [], action?: TurnAction): { conversation: Conversation; assistantId: string; runId: string } {
    const previous = this.conversation(id);
    const plan = this.planTurn(id, text, action); let parentId = plan.parentId;
    const runId = randomUUID(); const assistantId = randomUUID(); const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (text !== null) {
        const userId = randomUUID();
        if (!plan.edited) this.sources.attachable(id, attachmentIds);
        this.db.prepare("INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route,parent_id) VALUES(?,?,'user',?,'complete',?,NULL,?,?)").run(userId, id, text, now, route, parentId);
        this.sources.link(plan.edited ? this.sources.attachmentIds(plan.edited.id) : attachmentIds, userId);
        parentId = userId;
        if (previous.messages.length === 0) this.db.prepare("UPDATE conversations SET title=? WHERE id=? AND title_source='fallback'").run(capitalizeConversationTitle(text.replace(/\s+/g, ' ').slice(0, 70)), id);
      }
      this.db.prepare("INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route,parent_id,continuation_of) VALUES(?,?,'assistant',?,'streaming',?,?,?,?,?)").run(assistantId, id, plan.continued?.text ?? '', now, runId, route, parentId, plan.continued?.id ?? null);
      if (plan.continued?.presentations) this.db.prepare('UPDATE messages SET presentations=? WHERE id=?').run(JSON.stringify(plan.continued.presentations), assistantId);
      this.db.prepare('UPDATE conversations SET updated_at=?,active_leaf=?,description_revision=description_revision+1 WHERE id=?').run(now, assistantId, id);
      this.clearOffBranchDescription(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { conversation: this.conversation(id), assistantId, runId };
  }
  appendBotReply(id: string, previousId: string, runId: string, route: InferenceRoute): string {
    const conversation = this.conversation(id);
    const previous = conversation.messages.at(-1);
    if (conversation.mode !== 'bot' || conversation.headId !== previousId || previous?.id !== previousId || previous.runId !== runId || previous.role !== 'assistant') throw new Error('The bot conversation changed during its reply.');
    const assistantId = randomUUID(); const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route,parent_id) VALUES(?,?,'assistant','','streaming',?,?,?,?)").run(assistantId, id, now, runId, route, previousId);
      this.db.prepare('UPDATE conversations SET updated_at=?,active_leaf=? WHERE id=?').run(now, assistantId, id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return assistantId;
  }
  appendProactiveMessage(id: string, text: string, runId: string, route: InferenceRoute): void {
    const conversation = this.conversation(id);
    if (conversation.mode !== 'bot' || conversation.messages.at(-1)?.status === 'streaming') throw Error('Your bot is busy.');
    if (conversation.messages.some(message => message.runId === runId)) return;
    const now = Date.now(), messageId = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route,parent_id) VALUES(?,?,'assistant',?,'complete',?,?,?,?)").run(messageId,id,text,now,runId,route,conversation.headId ?? null);
      this.db.prepare('UPDATE conversations SET updated_at=?,active_leaf=? WHERE id=?').run(now,messageId,id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finishBotPlaceholder(id: string, assistantId: string, runId: string): string {
    const conversation = this.conversation(id), tail = conversation.messages.at(-1), previous = conversation.messages.at(-2);
    if (conversation.mode !== 'bot' || conversation.headId !== assistantId || tail?.id !== assistantId || tail.runId !== runId || tail.role !== 'assistant' || tail.text || tail.status !== 'streaming' || previous?.role !== 'assistant' || previous.runId !== runId || previous.status !== 'complete' || tail.parentId !== previous.id) throw Error('The bot conversation changed during its reply.');
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE conversations SET active_leaf=? WHERE id=?').run(previous.id, id); this.db.prepare('DELETE FROM messages WHERE id=? AND conversation_id=?').run(assistantId, id); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return previous.id;
  }
  saveReply(assistantId: string, text: string, status: MessageStatus, error: string | null = null, reasoning = '', workDurationMs: number | null = null, workActivity?: import('../shared/chat').WorkActivity[], presentations?: ChatMessage['presentations']): void {
    this.db.prepare('UPDATE messages SET text=?,status=?,error=?,reasoning=?,work_duration_ms=?,work_activity=COALESCE(?,work_activity),presentations=COALESCE(?,presentations) WHERE id=? AND role=\'assistant\'').run(text, status, error, reasoning, workDurationMs, workActivity ? JSON.stringify(workActivity) : null, presentations ? JSON.stringify(presentations) : null, assistantId);
    if (status !== 'streaming') this.db.prepare('UPDATE messages SET response_duration_ms=COALESCE(response_duration_ms,MAX(1,?-created_at)) WHERE id=?').run(Date.now(), assistantId);
  }
  recordSteering(conversationId: string, assistantId: string, ids: string[]): import('../shared/chat').QueuedRequest[] {
    const assistant = this.conversation(conversationId).messages.find(message => message.id === assistantId);
    if (!assistant || assistant.status !== 'streaming') return [];
    const items = ids.map(id => this.queue.get(conversationId, id)).filter(item => item.lane === 'steer');
    for (const item of items) this.sources.attachable(conversationId, item.attachmentIds);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let parentId = assistant.parentId ?? null;
      for (const item of items) {
        this.db.prepare("INSERT INTO messages(id,conversation_id,role,text,status,created_at,run_id,route,parent_id) VALUES(?,?,'user',?,'complete',?,NULL,?,?)").run(item.id, conversationId, item.text, item.createdAt, assistant.route, parentId);
        this.sources.link(item.attachmentIds, item.id); this.queue.remove(conversationId, item.id); parentId = item.id;
      }
      this.db.prepare('UPDATE messages SET parent_id=? WHERE id=?').run(parentId, assistantId);
      this.db.prepare('UPDATE conversations SET updated_at=?,description_revision=description_revision+1 WHERE id=?').run(Date.now(), conversationId);
      this.db.exec('COMMIT'); return items;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  discardSilentBackgroundTurn(id: string, assistantId: string, runId: string): boolean {
    const conversation = this.conversation(id); const assistant = conversation.messages.at(-1);
    if (conversation.headId !== assistantId || assistant?.id !== assistantId || assistant.runId !== runId || assistant.role !== 'assistant' || assistant.text || assistant.status !== 'complete' || conversation.tools.some(tool => tool.runId === runId)) return false;
    const user = conversation.messages.at(-2);
    if (!user || user.id !== assistant.parentId || user.role !== 'user' || user.text !== 'Bot background task' || user.attachmentIds?.length) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE conversations SET active_leaf=?,description_revision=description_revision+1 WHERE id=?').run(user.parentId ?? null, id); this.db.prepare('DELETE FROM messages WHERE id=?').run(assistantId); this.db.prepare('DELETE FROM messages WHERE id=?').run(user.id); this.db.exec('COMMIT'); return true; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  addTool(id: string, conversationId: string, runId: string, name: ToolName, summary: string, displayText?: string, target?: string): void {
    this.db.prepare("INSERT INTO tool_calls(id,conversation_id,run_id,name,summary,status,result,created_at,display_text,target) VALUES(?,?,?,?,?,'pending',NULL,?,?,?)").run(id, conversationId, runId, name, summary.slice(0, 1500), Date.now(), displayText ?? null, target?.slice(0, 2048) ?? null);
  }
  finishTool(id: string, status: ToolStatus, result: string | null = null): void {
    const tool = this.db.prepare('SELECT name FROM tool_calls WHERE id=?').get(id);
    // Present is already size-bounded by its validator. Never truncate a JSON
    // interface: a successful receipt must correspond to a restorable result.
    // Computer results are already bounded, structured pages. Cutting their
    // serialized JSON (especially an error plus exact manual draft) corrupts it.
    this.db.prepare('UPDATE tool_calls SET status=?,result=? WHERE id=?').run(status, tool?.name === 'present' || isComputerTool(String(tool?.name ?? '')) ? result : result?.slice(0, 40000) ?? null, id);
  }
}

