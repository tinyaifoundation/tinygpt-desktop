import { savePairingKey } from './mobile-keys';
export type Computer = { desktop: string; name: string; status: 'paired' | 'pending'; online: boolean; expiresAt?: number };
export type PairingEntry = { desktop: string; invitation?: string; token?: string; key?: string; handoff?: string };
const desktopPattern = /^[a-f0-9]{64}$/;
let pendingEntry: PairingEntry | null = null;
export function rememberPairingEntry(entry: PairingEntry | null) { pendingEntry = entry; try { sessionStorage.removeItem('tinygpt-pairing'); } catch {} }
export function parsePairingLink(text: string): PairingEntry {
  const url = new URL(text.trim(),location.origin), params = new URLSearchParams(url.hash.slice(1)), desktop = params.get('desktop'), invitation = params.get('invitation'), token = params.get('token'), handoff = params.get('handoff'), key = params.get('key');
  if (params.get('v') !== '2' || !key || !desktopPattern.test(key) || url.origin !== location.origin || !desktop || !desktopPattern.test(desktop) || !(handoff && desktopPattern.test(handoff) || invitation && /^[a-f0-9-]{36}$/.test(invitation) && token && desktopPattern.test(token))) throw Error('Scan the TinyGPT code on your computer.');
  return { desktop, key, invitation: invitation ?? undefined,token: token ?? undefined,handoff: handoff ?? undefined };
}
export function entryFromURL(): PairingEntry | null {
  try {
    if (location.hash.includes('token=') || location.hash.includes('handoff=')) {
      const entry = parsePairingLink(location.href); history.replaceState(null,'',location.pathname);
      rememberPairingEntry(entry); return entry;
    }
    const saved = JSON.parse(sessionStorage.getItem('tinygpt-pairing') || 'null'); sessionStorage.removeItem('tinygpt-pairing'); if (saved?.desktop && saved?.key && desktopPattern.test(saved.desktop) && desktopPattern.test(saved.key)) pendingEntry = saved;
    return pendingEntry;
  } catch { history.replaceState(null,'',location.pathname); }
  return null;
}
export function cachedComputers(): Computer[] {
  try { const saved = JSON.parse(localStorage.getItem('tinygpt-computers') || '[]'); if (Array.isArray(saved)) return saved.filter(item => desktopPattern.test(item.desktop) && typeof item.name === 'string').slice(0,20).map(item => ({ ...item,online: false })); } catch {} return [];
}
export function saveComputers(computers: Computer[]) { try { localStorage.setItem('tinygpt-computers',JSON.stringify(computers)); } catch {} }
export function selectedComputer() { try { return localStorage.getItem('tinygpt-remote-desktop') || new URLSearchParams(location.hash.slice(1)).get('desktop'); } catch { return null; } }
export async function pairingRequest(path: string,body?: unknown) {
  const response = await fetch(path,{ ...(body === undefined ? {} : { method: 'POST',headers: { 'Content-Type': 'application/json' },body: JSON.stringify(body) }),signal: AbortSignal.timeout(12000) });
  const value = await response.json(); if (!response.ok) throw Error(value.error || 'Connection interrupted. Try again.'); return value;
}
const claims = new Map<string,Promise<Computer>>();
export function claimPairing(entry: PairingEntry): Promise<Computer> {
  const key = JSON.stringify(entry); if (claims.has(key)) return claims.get(key)!;
  const promise = (async () => {
    const path = '/api/d/' + entry.desktop;
    if (!entry.invitation || !entry.key) throw Error('Scan a new encrypted connection code.');
    const result = await pairingRequest(path + '/pair', { id: entry.invitation, token: entry.token, name: /iPad/.test(navigator.userAgent) ? 'iPad' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Mobile companion' });
    if (typeof result.deviceId !== 'string') throw Error('Scan a fresh connection code.');
    await savePairingKey(entry.desktop, entry.invitation, result.deviceId, entry.key);
    return await pairingRequest(path + '/session') as Computer;
  })();
  if (claims.size >= 4) claims.delete(claims.keys().next().value!); claims.set(key,promise);
  void promise.catch(() => claims.delete(key)); return promise;
}
