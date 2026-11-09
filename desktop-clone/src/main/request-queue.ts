import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { QueuedRequest } from '../shared/chat';

/** Pending requests are durable, conversation-scoped and never model history until dispatched. */
export class RequestQueue {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS queued_requests (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      text TEXT NOT NULL, attachments TEXT NOT NULL, created_at INTEGER NOT NULL, position INTEGER NOT NULL,
      lane TEXT NOT NULL CHECK(lane IN ('queue','steer'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS queued_requests_order ON queued_requests(conversation_id,position,id);
    CREATE TABLE IF NOT EXISTS request_queue_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, paused INTEGER NOT NULL
    ) STRICT;
    UPDATE queued_requests SET lane='queue';
    INSERT OR REPLACE INTO request_queue_state SELECT DISTINCT conversation_id,1 FROM queued_requests;`);
  }
  list(conversationId: string): QueuedRequest[] {
    return this.db.prepare('SELECT id,text,attachments,created_at AS createdAt,lane FROM queued_requests WHERE conversation_id=? ORDER BY position,id').all(conversationId).map(row => ({ id: String(row.id), text: String(row.text), attachmentIds: JSON.parse(String(row.attachments)), createdAt: Number(row.createdAt), lane: row.lane as QueuedRequest['lane'] }));
  }
  get(conversationId: string, id: string): QueuedRequest {
    const item = this.list(conversationId).find(item => item.id === id); if (!item) throw new Error('Queued request is no longer available.'); return item;
  }
  add(conversationId: string, text: string, attachmentIds: string[]): QueuedRequest {
    const rows = this.list(conversationId); if (rows.length >= 20) throw new Error('The queue is full. Send or remove a request first.');
    if (rows.some(item => item.attachmentIds.some(id => attachmentIds.includes(id)))) throw new Error('This attachment already belongs to a queued request.');
    const id = randomUUID(); const position = Number(this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM queued_requests WHERE conversation_id=?').get(conversationId)!.n);
    this.db.prepare("INSERT INTO queued_requests VALUES(?,?,?,?,?,?,'queue')").run(id, conversationId, text, JSON.stringify(attachmentIds), Date.now(), position);
    return this.get(conversationId, id);
  }
  remove(conversationId: string, id: string): void { this.db.prepare('DELETE FROM queued_requests WHERE conversation_id=? AND id=?').run(conversationId, id); }
  steer(conversationId: string, id: string): void { this.db.prepare("UPDATE queued_requests SET lane='steer' WHERE conversation_id=? AND id=?").run(conversationId, id); }
  restore(conversationId: string): void { this.db.prepare("UPDATE queued_requests SET lane='queue' WHERE conversation_id=?").run(conversationId); }
  reorder(conversationId: string, ids: string[]): void {
    const current = this.list(conversationId); if (new Set(ids).size !== current.length || ids.length !== current.length || current.some(item => !ids.includes(item.id))) throw new Error('The queue changed. Try reordering it again.');
    this.db.exec('BEGIN IMMEDIATE');
    try { ids.forEach((id, position) => this.db.prepare('UPDATE queued_requests SET position=? WHERE conversation_id=? AND id=?').run(position, conversationId, id)); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  replace(conversationId: string, id: string, text: string, attachmentIds: string[]): void {
    if (this.list(conversationId).some(item => item.id !== id && item.attachmentIds.some(id => attachmentIds.includes(id)))) throw new Error('This attachment already belongs to a queued request.');
    this.db.prepare('UPDATE queued_requests SET text=?,attachments=? WHERE conversation_id=? AND id=?').run(text, JSON.stringify(attachmentIds), conversationId, id);
  }
  paused(conversationId: string): boolean { return this.db.prepare('SELECT paused FROM request_queue_state WHERE conversation_id=?').get(conversationId)?.paused === 1; }
  pause(conversationId: string, value: boolean): void { this.db.prepare('INSERT OR REPLACE INTO request_queue_state VALUES(?,?)').run(conversationId, Number(value)); }
}
