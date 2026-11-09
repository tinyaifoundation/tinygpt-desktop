import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PasswordVault, passwordOrigin, type PasswordEncryption } from '../src/main/password-vault';
import { PasswordPrivacy } from '../src/main/password-privacy';
import type { PasswordSecret, PasswordStore } from '../src/main/password-native';

const folders: string[] = [];
afterEach(async()=>{await Promise.all(folders.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'tinygpt-passwords-'));folders.push(root);
  const items=new Map<string,PasswordSecret>();const key=randomBytes(32);
  const store: PasswordStore={available:async()=>true,put:vi.fn(async(target,secret)=>{items.set(target,{...secret});}),fill:vi.fn(async(target,_window,consume)=>{const secret=items.get(target);if(!secret)throw Error('Unavailable');await consume({...secret});}),remove:vi.fn(async target=>{items.delete(target);})};
  const encryption: PasswordEncryption={available:()=>true,encrypt:text=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(text),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);},decrypt:bytes=>{const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString();}};
  return {root,items,store,encryption,vault:new PasswordVault(root,store,encryption)};
}
const profile='persist:tinygpt-browser',origin='https://example.com',secret={username:'synthetic-user',password:'CANARY_PASSWORD_NOT_FOR_A_MODEL_83!'};

it('stores only encrypted account metadata on disk and exposes no password in account lists',async()=>{
  const f=await fixture(),saved=await f.vault.save(profile,origin,secret);
  expect(saved).toEqual({id:expect.any(String),username:secret.username});
  expect(await f.vault.list(profile,origin)).toEqual([saved]);
  expect(JSON.stringify(await f.vault.list(profile,origin))).not.toContain(secret.password);
  const bytes=await readFile(join(f.root,'browser-passwords/accounts.enc'));
  for(const text of [secret.password,secret.username,origin])expect(bytes.includes(Buffer.from(text))).toBe(false);
  expect(f.encryption.decrypt(bytes)).not.toContain(secret.password);
  const restarted=new PasswordVault(f.root,f.store,f.encryption);
  let consumed=false;
  expect(await restarted.fill(profile,origin,saved.id,Buffer.alloc(8),async value=>{expect(value).toEqual(secret);consumed=true;})).toBeUndefined();
  expect(consumed).toBe(true);
});

it('binds credentials to exact HTTPS origins, ports, browser profiles and app profiles',async()=>{
  const f=await fixture(),saved=await f.vault.save(profile,origin,secret);
  for(const [p,o] of [[profile,'https://evil.example.com'],[profile,'https://example.com:444'],[profile+'-isolated',origin],[profile,'https://examp1e.com']]){
    expect(await f.vault.list(p,o)).toEqual([]);await expect(f.vault.fill(p,o,saved.id,Buffer.alloc(8),vi.fn())).rejects.toThrow('not available');
    await expect(f.vault.remove(p,o,saved.id)).rejects.toThrow('not available');
  }
  const other=await fixture();await other.vault.save(profile,origin,secret);
  expect([...f.items.keys()][0]).not.toEqual([...other.items.keys()][0]);
  expect(f.store.fill).not.toHaveBeenCalled();
});

// secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- Synthetic credential-bearing URL rejection fixture; no real credentials.
it.each(['http://example.com','https://user:pass@example.com','file:///tmp/login','javascript:alert(1)','https://localhost','https://127.0.0.1'])('rejects insecure or credential-bearing addresses: %s',address=>{expect(()=>passwordOrigin(address)).toThrow();});

it('updates an exact account without duplicating it and deletes only the chosen account',async()=>{
  const f=await fixture(),saved=await f.vault.save(profile,origin,secret);
  const other=await f.vault.save(profile,origin,{username:'other',password:'different'});
  expect((await f.vault.save(profile,origin,{...secret,password:'updated'})).id).toBe(saved.id);
  expect(f.items.size).toBe(2);await f.vault.remove(profile,origin,saved.id);
  expect(await new PasswordVault(f.root,f.store,f.encryption).list(profile,origin)).toEqual([other]);
  expect([...f.items.values()]).toEqual([{username:'other',password:'different'}]);
});

it('does not release or fill a password when native authentication is canceled',async()=>{
  const f=await fixture(),saved=await f.vault.save(profile,origin,secret),consume=vi.fn();
  f.store.fill=vi.fn(async()=>{throw Error('Password access was canceled or could not be verified.');});
  await expect(f.vault.fill(profile,origin,saved.id,Buffer.alloc(8),consume)).rejects.toThrow('canceled');expect(consume).not.toHaveBeenCalled();
});

it('fails closed on missing OS encryption or a corrupt index without overwriting it',async()=>{
  const f=await fixture();await f.vault.save(profile,origin,secret);
  const before=await readFile(join(f.root,'browser-passwords/accounts.enc'));
  const unavailable=new PasswordVault(f.root,f.store,{...f.encryption,available:()=>false});
  await expect(unavailable.save(profile,origin,secret)).rejects.toThrow('unavailable');
  await writeFile(join(f.root,'browser-passwords/accounts.enc'),'CORRUPTED');
  const corrupt=new PasswordVault(f.root,f.store,f.encryption);await expect(corrupt.list(profile,origin)).rejects.toThrow('could not be opened');
  expect(await readFile(join(f.root,'browser-passwords/accounts.enc'),'utf8')).toBe('CORRUPTED');expect(before.length).toBeGreaterThan(0);
});

it('rolls back a new OS entry when the metadata index cannot be committed',async()=>{
  const f=await fixture();await f.vault.list(profile,origin);await mkdir(join(f.root,'browser-passwords/accounts.enc'),{recursive:true});
  await expect(f.vault.save(profile,origin,secret)).rejects.toThrow('could not be saved');
  expect(f.items.size).toBe(0);expect(await f.vault.list(profile,origin)).toEqual([]);
  for(const file of await readdir(join(f.root,'browser-passwords')))if(file.endsWith('.tmp'))expect((await readFile(join(f.root,'browser-passwords',file))).includes(Buffer.from(secret.password))).toBe(false);
});

it('rejects oversized credentials before writing to the OS',async()=>{
  const f=await fixture();await expect(f.vault.save(profile,origin,{username:'u',password:'X'.repeat(1025)})).rejects.toThrow('supported length');expect(f.store.put).not.toHaveBeenCalled();
});

it('blocks tools during private sign-in and invalidates results that cross either boundary',()=>{
  const privacy=new PasswordPrivacy(),before=privacy.epoch;privacy.assert();privacy.enter();
  expect(privacy.active).toBe(true);expect(()=>privacy.assert()).toThrow('Private sign-in');expect(()=>privacy.enter()).toThrow();
  privacy.leave();expect(privacy.active).toBe(false);privacy.assert();expect(()=>privacy.assert(before)).toThrow('Private sign-in');
});
