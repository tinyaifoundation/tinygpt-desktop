import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { PasswordStore, PasswordSecret } from './password-native';

const entrySchema = z.object({ id: z.uuid(), profile: z.string().min(1).max(256), origin: z.url().max(2048), username: z.string().max(254) }).strict();
type Entry = z.infer<typeof entrySchema>;
export interface PasswordMetadata { id: string; username: string }
export interface PasswordEncryption { available(): boolean; encrypt(text: string): Buffer; decrypt(bytes: Buffer): string }
export function passwordOrigin(address: string): string {
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1' || url.hostname === '[::1]') throw Error('Saved passwords require a secure HTTPS website.');
  return url.origin;
}
/** The encrypted index contains account labels only. Passwords live exclusively
 * in the OS store, outside history, retrieval, Project files and plugin secrets. */
export class PasswordVault {
  private entries: Entry[] = [];
  private loaded = false;
  private namespace: string;
  constructor(private root: string, private store: PasswordStore, private encryption: PasswordEncryption) {
    this.namespace = createHash('sha256').update(root).digest('hex').slice(0,32);
  }
  private async load() {
    if (!this.encryption.available()) throw Error('OS-protected password storage is unavailable.');
    if (this.loaded) return;
    try {
      const decoded = this.encryption.decrypt(await readFile(join(this.root,'browser-passwords','accounts.enc')));
      this.entries = z.object({version:z.literal(1),entries:z.array(entrySchema).max(1000)}).strict().parse(JSON.parse(decoded)).entries;
      if (new Set(this.entries.map(entry=>entry.id)).size !== this.entries.length || this.entries.some(entry => passwordOrigin(entry.origin) !== entry.origin)) throw Error();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('The saved-password index could not be opened. No passwords were changed.'); }
    this.loaded = true;
  }
  private target(entry: Entry) { return `TinyGPT/BrowserPasswords/${this.namespace}/${createHash('sha256').update(JSON.stringify([entry.profile,entry.origin,entry.id])).digest('hex')}`; }
  private async persist(entries: Entry[]) {
    const directory = join(this.root,'browser-passwords'); await mkdir(directory,{recursive:true,mode:0o700});
    const bytes = this.encryption.encrypt(JSON.stringify({version:1,entries}));
    const temp = join(directory,`accounts-${randomUUID()}.tmp`);
    try{await writeFile(temp,bytes,{mode:0o600,flag:'wx'});await rename(temp,join(directory,'accounts.enc'));this.entries=entries;}
    finally{await rm(temp,{force:true}).catch(()=>{});}
  }
  async list(profile: string, origin: string): Promise<PasswordMetadata[]> {
    await this.load(); origin = passwordOrigin(origin);
    return this.entries.filter(entry=>entry.profile===profile&&entry.origin===origin).map(({id,username})=>({id,username}));
  }
  private async entry(profile: string, origin: string, id: string) {
    await this.load(); const item = this.entries.find(entry=>entry.id===id&&entry.profile===profile&&entry.origin===passwordOrigin(origin));
    if (!item) throw Error('This saved account is not available for this website and browser profile.'); return item;
  }
  async save(profile: string, origin: string, secret: PasswordSecret) {
    await this.load(); origin = passwordOrigin(origin);
    if (typeof secret.username !== 'string' || secret.username.length>254 || typeof secret.password !== 'string' || !secret.password || secret.password.length>1024 || Buffer.byteLength(JSON.stringify(secret))>2500) throw Error('Enter a username and a password of supported length.');
    const existing = this.entries.find(entry=>entry.profile===profile&&entry.origin===origin&&entry.username===secret.username);
    if (!existing && this.entries.length>=1000) throw Error('Remove an unused saved account before adding another.');
    const entry: Entry = existing ?? {id:randomUUID(),profile,origin,username:secret.username};
    await this.store.put(this.target(entry),secret);
    if (!existing) try { await this.persist([...this.entries,entry]); } catch { await this.store.remove(this.target(entry)).catch(()=>{}); throw Error('The password could not be saved.'); }
    return {id:entry.id,username:entry.username};
  }
  async fill(profile: string, origin: string, id: string, window: Buffer, consume: (secret: PasswordSecret)=>Promise<void>) {
    const entry = await this.entry(profile,origin,id); await this.store.fill(this.target(entry),window,consume);
  }
  async remove(profile: string, origin: string, id: string) {
    const entry = await this.entry(profile,origin,id); await this.store.remove(this.target(entry)); await this.persist(this.entries.filter(item=>item.id!==entry.id));
  }
}
