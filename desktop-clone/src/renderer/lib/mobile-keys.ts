import { keyContext } from '../../shared/remote-crypto';
type PairingKey = { desktopId: string; grantId: string; deviceId: string; key: CryptoKey };
export async function forgetPairingKey(desktopId:string){const db=await database();try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction(['keys','pending'],'readwrite');for(const name of ['keys','pending'])tx.objectStore(name).delete(desktopId);tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(Error('Pairing could not be removed.'));});}finally{db.close();}}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tinygpt-remote-keys-v2', 2);
    request.onupgradeneeded = () => { for (const name of ['keys', 'pending']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'desktopId' }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Secure pairing storage is unavailable.'));
  });
}
async function record<T>(db: IDBDatabase, store: string, id: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Private recovery could not be opened.')); });
}
async function recoveryKey(saved: PairingKey) {
  const bytes = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('tinygpt-private-recovery-v1'), info: new TextEncoder().encode(`${saved.desktopId}:${saved.grantId}:${saved.deviceId}`) }, saved.key, 256));
  try { return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); } finally { bytes.fill(0); }
}
export async function savePrivateRecovery(desktopId: string, commands: unknown[]) {
  const db = await database();
  try {
    const saved = await record<PairingKey>(db, 'keys', desktopId); if (!saved) throw Error('Pair this computer before saving private recovery.');
    const text = JSON.stringify(commands); if (text.length > 400000) throw Error('Too many pending requests. Wait before sending more.');
    const iv = crypto.getRandomValues(new Uint8Array(12)), additionalData = new TextEncoder().encode(`${desktopId}:${saved.grantId}:${saved.deviceId}`);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await recoveryKey(saved), new TextEncoder().encode(text));
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put({ desktopId, iv, ciphertext }); tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(Error('Private recovery could not be saved.')); });
  } finally { db.close(); }
}
export async function loadPrivateRecovery(desktopId: string): Promise<unknown[]> {
  const db = await database();
  try {
    const [saved, pending] = await Promise.all([record<PairingKey>(db, 'keys', desktopId), record<{ iv: Uint8Array; ciphertext: ArrayBuffer }>(db, 'pending', desktopId)]);
    if (!saved || !pending) return [];
    if (pending.iv?.byteLength !== 12 || pending.ciphertext?.byteLength > 500000) throw Error('Private recovery is invalid.');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(pending.iv), additionalData: new TextEncoder().encode(`${desktopId}:${saved.grantId}:${saved.deviceId}`) }, await recoveryKey(saved), pending.ciphertext);
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes)); if (!Array.isArray(result)) throw Error('Private recovery is invalid.'); return result.slice(0, 8);
  } finally { db.close(); }
}
export async function savePairingKey(desktopId: string, grantId: string, deviceId: string, secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error('Scan a new encrypted connection code.');
  const raw = Uint8Array.from(secret.match(/../g)!, value => parseInt(value, 16));
  const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']); raw.fill(0);
  const db = await database();
  try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put({ desktopId, grantId, deviceId, key }); tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(Error('Secure pairing could not be saved.')); }); } finally { db.close(); }
}
export async function pairingKey(desktopId: string): Promise<(Omit<PairingKey, 'key'> & { psk: string }) | undefined> {
  const db = await database(); let saved: PairingKey | undefined;
  try { saved = await new Promise((resolve, reject) => { const request = db.transaction('keys').objectStore('keys').get(desktopId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Secure pairing could not be opened.')); }); } finally { db.close(); }
  if (!saved) return;
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('tinygpt-remote-v2'), info: new TextEncoder().encode(keyContext(desktopId, saved.grantId)) }, saved.key, 256));
  const psk = [...bits].map(value => value.toString(16).padStart(2, '0')).join(''); bits.fill(0);
  return { desktopId, grantId: saved.grantId, deviceId: saved.deviceId, psk };
}
