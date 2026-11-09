import { SessionCache, type SessionBacking } from '../../core/session-cache';
import type { FilePreview } from '../../shared/workspace';
import type { SourceDetail } from '../../shared/tools';

export type FileTab = { file: FilePreview; draft: string; raw: boolean };
export type WorkspaceSelection = { kind: 'home' | 'files' | 'sources' | 'changes' } | { kind: 'image' | 'browser' | 'file' | 'terminal'; id: string };
type Session = { files: FileTab[]; selected: WorkspaceSelection; images?: SourceDetail[]; route?: string };
let database: Promise<IDBDatabase> | undefined;
function open() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tinygpt-workspace-sessions', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result); request.onerror = () => { database = undefined; reject(Error('Workspace drafts could not be stored locally.')); };
  });
}
const backing: SessionBacking<Session> = {
  async get(key) { const db = await open(); return new Promise((resolve, reject) => { const request = db.transaction('sessions').objectStore('sessions').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Saved workspace drafts could not be read.')); }); },
  async put(key, value) { const db = await open(); return new Promise((resolve, reject) => { const transaction = db.transaction('sessions', 'readwrite'); transaction.objectStore('sessions').put(value, key); transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(Error('Workspace drafts could not be stored locally. Your open edits are kept.')); }); },
  async remove(key) { const db = await open(); return new Promise((resolve, reject) => { const transaction = db.transaction('sessions', 'readwrite'); transaction.objectStore('sessions').delete(key); transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(Error('Workspace drafts could not be updated locally.')); }); },
};
export const fileSessions = new SessionCache<Session>(backing, session => session.files.reduce((size, tab) => size + ((tab.file.text?.length ?? 0) + tab.draft.length) * 2 + 1024, 1024));
