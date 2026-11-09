import type { DatabaseSync } from 'node:sqlite';
import type { Conversation, ChatMessage } from '../shared/chat';
import type { ToolActivity } from '../shared/tools';

/** Watch only active conversations. TEMP triggers also catch writes by sources,
 * queues and memory services sharing this connection; no persisted journal. */
export class LiveHistory {
  private snapshots = new Map<string, Conversation>();
  constructor(private db: DatabaseSync, private full: (id: string) => Conversation, private sources: (id: string) => Conversation['sources']) {
    db.exec(`CREATE TEMP TABLE ui_watches(id TEXT PRIMARY KEY);
      CREATE TEMP TABLE ui_dirty(conversation_id TEXT,kind TEXT,key TEXT,PRIMARY KEY(conversation_id,kind,key));
      CREATE TEMP TABLE ui_outputs_revision(value INTEGER); INSERT INTO ui_outputs_revision VALUES(0);`);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      db.exec(`CREATE TEMP TRIGGER ui_outputs_tool_${operation} AFTER ${operation} ON main.tool_calls
        WHEN ${row}.status='success' AND (${row}.name='write_project_file' OR instr(${row}.result,'"artifact"')>0 OR instr(${row}.result,'"artifacts"')>0)
        BEGIN UPDATE ui_outputs_revision SET value=value+1; END;
        CREATE TEMP TRIGGER ui_outputs_image_${operation} AFTER ${operation} ON main.sources WHEN ${row}.kind='generated-image'
        BEGIN UPDATE ui_outputs_revision SET value=value+1; END;`);
    }
    db.exec(`CREATE TEMP TRIGGER ui_outputs_retract AFTER UPDATE ON main.tool_calls
      WHEN OLD.status='success' AND (NEW.status IS NOT OLD.status OR NEW.result IS NOT OLD.result)
      AND (OLD.name='write_project_file' OR instr(OLD.result,'"artifact"')>0 OR instr(OLD.result,'"artifacts"')>0)
      BEGIN UPDATE ui_outputs_revision SET value=value+1; END;`);
    for (const table of ['conversations', 'projects']) for (const operation of ['UPDATE', 'DELETE']) {
      const condition = operation === 'UPDATE' ? table === 'projects' ? 'NEW.name IS NOT OLD.name' : 'NEW.title IS NOT OLD.title OR NEW.project_id IS NOT OLD.project_id' : '1';
      db.exec(`CREATE TEMP TRIGGER ui_outputs_${table}_${operation} AFTER ${operation} ON main.${table} WHEN ${condition}
        BEGIN UPDATE ui_outputs_revision SET value=value+1; END;`);
    }
    for (const [table, kind] of [['messages', 'message'], ['tool_calls', 'tool'], ['context_activities', 'context']] as const) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        const type = operation === 'DELETE' || table === 'messages' && operation === 'INSERT' ? 'full' : kind;
        db.exec(`CREATE TEMP TRIGGER ui_${table}_${operation} AFTER ${operation} ON main.${table}
          WHEN EXISTS(SELECT 1 FROM ui_watches WHERE id=${row}.conversation_id) BEGIN
          INSERT OR IGNORE INTO ui_dirty VALUES(${row}.conversation_id,'${type}',${row}.id); END;`);
      }
    }
    db.exec(`CREATE TEMP TRIGGER ui_message_structure AFTER UPDATE ON main.messages
      WHEN NEW.parent_id IS NOT OLD.parent_id OR NEW.continuation_of IS NOT OLD.continuation_of BEGIN
      INSERT OR IGNORE INTO ui_dirty SELECT id,'full',NEW.id FROM ui_watches WHERE id=NEW.conversation_id; END;`);
    for (const table of ['conversations', 'conversation_descriptions', 'queued_requests', 'request_queue_state']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW', column = table === 'conversations' ? 'id' : 'conversation_id';
        db.exec(`CREATE TEMP TRIGGER ui_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN
          INSERT OR IGNORE INTO ui_dirty SELECT id,'full','' FROM ui_watches WHERE id=${row}.${column}; END;`);
      }
    }
    // Evidence can be shared between project conversations. These less frequent
    // changes invalidate watched snapshots together instead of retaining stale cards.
    for (const table of ['sources', 'source_files', 'source_exclusions', 'message_sources', 'message_reactions', 'knowledge_documents', 'projects']) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const kind = ['sources', 'source_files', 'source_exclusions', 'knowledge_documents'].includes(table) ? 'sources' : 'full';
      db.exec(`CREATE TEMP TRIGGER ui_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN
        INSERT OR IGNORE INTO ui_dirty SELECT id,'${kind}','' FROM ui_watches; END;`);
      if (['sources', 'source_files', 'source_exclusions', 'knowledge_documents'].includes(table)) db.exec(`CREATE TEMP TRIGGER ui_library_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN UPDATE ui_outputs_revision SET value=value+1; END;`);
    }
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = operation === 'DELETE' ? 'OLD' : 'NEW';
      db.exec(`CREATE TEMP TRIGGER ui_personal_${operation} AFTER ${operation} ON main.metadata WHEN ${row}.key='memory:personal' BEGIN
        INSERT OR IGNORE INTO ui_dirty SELECT id,'sources','' FROM ui_watches; END;
        CREATE TEMP TRIGGER ui_plugin_scope_${operation} AFTER ${operation} ON main.plugin_conversation_access BEGIN
        INSERT OR IGNORE INTO ui_dirty SELECT id,'sources','' FROM ui_watches WHERE id=${row}.conversation_id; END;`);
    }
  }
  outputsRevision(): number { return Number(this.db.prepare('SELECT value FROM ui_outputs_revision').get()!.value); }
  watch(id: string, initial: Conversation) {
    this.snapshots.set(id, initial); this.db.prepare('INSERT OR IGNORE INTO ui_watches VALUES(?)').run(id);
    this.db.prepare('DELETE FROM ui_dirty WHERE conversation_id=?').run(id);
  }
  forget(id: string) { this.snapshots.delete(id); this.db.prepare('DELETE FROM ui_watches WHERE id=?').run(id); this.db.prepare('DELETE FROM ui_dirty WHERE conversation_id=?').run(id); }
  read(id: string): Conversation {
    const previous = this.snapshots.get(id); if (!previous) return this.full(id);
    const dirty = this.db.prepare('SELECT kind,key FROM ui_dirty WHERE conversation_id=?').all(id);
    if (!dirty.length) return previous;
    let next: Conversation;
    if (dirty.some(row => row.kind === 'full')) next = this.full(id);
    else {
      const messages = new Map<string, ChatMessage>();
      const tools = new Map<string, ToolActivity>();
      const toolOrder = new Map<string, number>();
      for (const row of dirty) {
        if (row.kind === 'message') {
          const original = previous.allMessages?.find(message => message.id === row.key) ?? previous.messages.find(message => message.id === row.key);
          const saved = this.db.prepare('SELECT text,reasoning,status,error,work_duration_ms AS workDurationMs,work_activity AS activity,presentations AS presentationJson FROM messages WHERE id=?').get(row.key);
          if (original && saved) { const { activity, presentationJson, ...fields } = saved; messages.set(original.id, { ...original, ...fields, workActivity: activity === '[]' ? undefined : JSON.parse(String(activity)), presentations: presentationJson === '[]' ? undefined : JSON.parse(String(presentationJson)) } as ChatMessage); }
        } else if (row.kind === 'tool') {
          const saved = this.db.prepare('SELECT rowid AS position,id,conversation_id AS conversationId,run_id AS runId,name,summary,status,result,created_at AS createdAt,display_text AS displayText,target FROM tool_calls WHERE id=?').get(row.key);
          if (saved) { const { position, ...tool } = saved; toolOrder.set(String(tool.id), Number(position)); tools.set(String(tool.id), tool as unknown as ToolActivity); }
        }
      }
      const existingTools = new Set(previous.tools.map(tool => tool.id));
      next = { ...previous,
        messages: messages.size ? previous.messages.map(message => messages.get(message.id) ?? message) : previous.messages,
        allMessages: messages.size ? previous.allMessages?.map(message => messages.get(message.id) ?? message) : previous.allMessages,
        tools: tools.size ? [...previous.tools.map(tool => tools.get(tool.id) ?? tool), ...[...tools.values()].filter(tool => !existingTools.has(tool.id)).sort((a, b) => a.createdAt - b.createdAt || toolOrder.get(a.id)! - toolOrder.get(b.id)!)].sort((a, b) => a.createdAt - b.createdAt) : previous.tools,
        sources: dirty.some(row => row.kind === 'sources') ? this.sources(id) : previous.sources,
        contextActivities: dirty.some(row => row.kind === 'context') ? this.db.prepare('SELECT id,run_id AS runId,status,created_at AS createdAt FROM context_activities WHERE conversation_id=? ORDER BY created_at,rowid').all(id) as unknown as Conversation['contextActivities'] : previous.contextActivities,
      };
    }
    this.db.prepare('DELETE FROM ui_dirty WHERE conversation_id=?').run(id); this.snapshots.set(id, next); return next;
  }
}
