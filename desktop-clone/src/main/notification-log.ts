import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { ActivityNotification } from '../shared/notifications';

/** Activity/read receipts are durable. Toast delivery is never the source of truth. */
export class NotificationLog {
  private db: DatabaseSync;
  revision = 0;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS notifications (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event_key TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,message_id TEXT,kind TEXT NOT NULL,mode TEXT NOT NULL,title TEXT NOT NULL,
        detail TEXT NOT NULL,created_at INTEGER NOT NULL,read INTEGER NOT NULL,resolved INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS notifications_conversation ON notifications(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS notifications_unread ON notifications(read,sequence);
      CREATE TABLE IF NOT EXISTS notification_events(event_key TEXT PRIMARY KEY,conversation_id TEXT NOT NULL) STRICT;
      INSERT OR IGNORE INTO notification_events SELECT event_key,conversation_id FROM notifications;
      UPDATE notifications SET resolved=1,read=1 WHERE kind='attention';`);
  }
  private rows(sql: string, ...values: (string | number)[]): ActivityNotification[] {
    return this.db.prepare(sql).all(...values).map(row => ({ id: String(row.id), sequence: Number(row.sequence), conversationId: String(row.conversation_id), messageId: row.message_id === null ? null : String(row.message_id), kind: row.kind as ActivityNotification['kind'], mode: row.mode as ActivityNotification['mode'], title: String(row.title), detail: String(row.detail), createdAt: Number(row.created_at), read: !!row.read, resolved: !!row.resolved }));
  }
  hasEvent(key:string):boolean { return !!this.db.prepare('SELECT 1 FROM notification_events WHERE event_key=?').get(key); }
  remember(keys:readonly string[],conversationId:string):void {
    if(!keys.length)return;
    this.db.exec('BEGIN IMMEDIATE');
    try { const insert=this.db.prepare('INSERT OR IGNORE INTO notification_events VALUES(?,?)');for(const key of keys)insert.run(key,conversationId);this.db.exec('COMMIT'); }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  add(key: string, entry: Omit<ActivityNotification, 'id' | 'sequence' | 'resolved'>): ActivityNotification | null {
    if (this.db.prepare('SELECT 1 FROM notification_events WHERE event_key=?').get(key)) return null;
    this.db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      this.db.prepare('INSERT INTO notification_events VALUES(?,?)').run(key, entry.conversationId);
      result = this.db.prepare('INSERT OR IGNORE INTO notifications(id,event_key,conversation_id,message_id,kind,mode,title,detail,created_at,read) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), key, entry.conversationId, entry.messageId, entry.kind, entry.mode, entry.title.slice(0, 100), entry.detail.slice(0, 240), entry.createdAt, Number(entry.read));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (!result.changes) return null;
    this.revision++;
    this.db.exec('DELETE FROM notifications WHERE sequence NOT IN (SELECT sequence FROM notifications ORDER BY sequence DESC LIMIT 500)');
    return this.rows('SELECT * FROM notifications WHERE sequence=?', Number(result.lastInsertRowid))[0];
  }
  get(id: string): ActivityNotification { const entry = this.rows('SELECT * FROM notifications WHERE id=?', id)[0]; if (!entry) throw new Error('This notification is no longer available.'); return entry; }
  list(limit = 100): ActivityNotification[] { return this.rows('SELECT * FROM notifications ORDER BY sequence DESC LIMIT ?', Math.min(500, Math.max(1, limit))); }
  unreadCount(): number { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read=0').get()!.n); }
  unreadCounts(): Record<string, number> { return Object.fromEntries(this.db.prepare('SELECT conversation_id,COUNT(*) AS n FROM notifications WHERE read=0 GROUP BY conversation_id').all().map(row => [String(row.conversation_id),Number(row.n)])); }
  unreadConversations(): string[] { return this.db.prepare('SELECT DISTINCT conversation_id FROM notifications WHERE read=0').all().map(row => String(row.conversation_id)); }
  read(id: string): void { this.db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(id); }
  dismiss(id: string): void { this.db.prepare('DELETE FROM notifications WHERE id=?').run(id); }
  readThrough(sequence: number): void { this.db.prepare('UPDATE notifications SET read=1 WHERE sequence<=?').run(sequence); }
  clearRead(): void { this.db.prepare('DELETE FROM notifications WHERE read=1').run(); }
  readConversation(id: string, messageIds: string[]): void {
    let through = 0;
    const find = this.db.prepare('SELECT sequence FROM notifications WHERE conversation_id=? AND message_id=?');
    for (const messageId of messageIds) through = Math.max(through, Number(find.get(id, messageId)?.sequence ?? 0));
    this.db.prepare("UPDATE notifications SET read=1 WHERE conversation_id=? AND (kind='attention' OR sequence<=?)").run(id, through);
  }
  resolveAttention(id: string, keys: string[]): boolean {
    const pending = this.db.prepare("SELECT id,event_key FROM notifications WHERE conversation_id=? AND kind='attention' AND resolved=0").all(id);
    let changed = false;
    for (const row of pending) if (!keys.includes(String(row.event_key))) { this.db.prepare('UPDATE notifications SET read=1,resolved=1 WHERE id=?').run(String(row.id)); changed = true; }
    if (changed) this.revision++;
    return changed;
  }
  forgetConversation(id: string): void { this.db.prepare('DELETE FROM notifications WHERE conversation_id=?').run(id); this.db.prepare('DELETE FROM notification_events WHERE conversation_id=?').run(id); }
  close(): void { this.db.close(); }
}
