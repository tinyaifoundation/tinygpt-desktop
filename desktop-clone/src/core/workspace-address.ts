import { searchAddress } from './browser-pages';
import type { SearchEngine } from '../shared/tools';
export function workspaceAddress(input: string, engine: SearchEngine): string | null {
  const value = input.trim(); if (!value) return null;
  if (/^https?:\/\//i.test(value)) { try { const url = new URL(value); return url.username || url.password ? null : url.href; } catch { return null; } }
  if (!/\s/.test(value) && /^(localhost|\[[a-f\d:]+\]|[\w.-]+\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3})(?::\d+)?([/?#]|$)/i.test(value)) {
    try { return new URL(`${/^(localhost|127\.|\[::1\])/.test(value) ? 'http' : 'https'}://${value}`).href; } catch { return null; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  return searchAddress(engine, value);
}
