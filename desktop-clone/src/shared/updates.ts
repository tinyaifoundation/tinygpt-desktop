import { z } from 'zod';

export const UPDATE_FEED = 'https://downloads.tinygpt.org/updates/prebeta/win-x64/';
export const updateActionSchema = z.enum(['check', 'download', 'install']);
export type UpdateAction = z.infer<typeof updateActionSchema>;
export type UpdateState = {
  phase: 'unavailable' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
  currentVersion: string;
  version?: string;
  notes?: string;
  percent?: number;
  message?: string;
};

export function trustedUpdateFile(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://downloads.tinygpt.org' && /^\/releases\/[^/]+\/[\w.-]+$/.test(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
  } catch { return /^[\w.-]+\.(exe|7z|blockmap)$/.test(value) && !value.includes('..'); }
}
