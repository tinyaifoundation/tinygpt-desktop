import { resolve } from 'node:path';

export const FILE_WRITE_CONFLICT = 'Another edit is still writing this file. Wait for it to finish, then read the file again.';
const writes = new Set<string>();
export function acquireFileWrites(paths: string[]): () => void {
  const keys = [...new Set(paths.map(path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)))];
  if (keys.some(key => writes.has(key))) throw new Error(FILE_WRITE_CONFLICT);
  for (const key of keys) writes.add(key);
  let released = false;
  return () => { if (released) return; released = true; for (const key of keys) writes.delete(key); };
}
