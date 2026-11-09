import koffi from 'koffi';
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface PasswordSecret { username: string; password: string }
export interface PasswordStore {
  available(): Promise<boolean>;
  put(target: string, secret: PasswordSecret): Promise<void>;
  fill(target: string, window: Buffer, consume: (secret: PasswordSecret) => Promise<void>): Promise<void>;
  remove(target: string): Promise<void>;
}

/** No decrypt/read-password IPC. Only the main-process sign-in broker consumes a
 * secret; native retrieval itself requires OS user presence on every fill. */
export class NativePasswordStore implements PasswordStore {
  private api?: { available: koffi.KoffiFunc<() => number>; put: koffi.KoffiFunc<(target: string, bytes: Buffer, size: number) => number>; read: koffi.KoffiFunc<(target: string, window: Buffer, bytes: Buffer, size: number) => number>; remove: koffi.KoffiFunc<(target: string) => number> };
  private load() {
    if (this.api) return this.api;
    if (!['win32', 'darwin'].includes(process.platform)) throw Error('Password saving requires Windows Hello or macOS Keychain.');
    const root = app.isPackaged ? join(process.resourcesPath, 'passwords') : join(app.getAppPath(), 'runtimes/passwords');
    const path = join(root, process.platform === 'win32' ? 'tinygpt-passwords.dll' : 'libtinygpt-passwords.dylib');
    if (!existsSync(path)) throw Error('The native password service is unavailable on this build.');
    const manifest = JSON.parse(readFileSync(join(root,'prepared.json'),'utf8'));
    // Signing changes Mach-O bytes after preparation. Packaged builds rely on
    // their signed native resource; development builds also check this digest.
    if(manifest.version!==1||manifest.target!==`${process.platform}-${process.arch}`||!app.isPackaged&&manifest.sha256!==createHash('sha256').update(readFileSync(path)).digest('hex'))throw Error('The native password service could not be verified.');
    const lib = koffi.load(path);
    this.api = { available: lib.func('int tg_available()'), put: lib.func('int tg_put(const char *target, const uint8_t *bytes, uint32_t size)'), read: lib.func('int tg_read(const char *target, const uint8_t *window, uint8_t *bytes, uint32_t size)'), remove: lib.func('int tg_remove(const char *target)') };
    return this.api;
  }
  private async call(fn: koffi.KoffiFunc<any>, args: unknown[]): Promise<number> {
    return new Promise((resolve, reject) => fn.async(...args, (error: unknown, value: number) => error ? reject(Error('The native password service could not complete the request.')) : resolve(value)));
  }
  async available() { const api=this.load();try { return await this.call(api.available, []) === 1; } catch { return false; } }
  async put(target: string, secret: PasswordSecret) {
    const bytes = Buffer.from(JSON.stringify(secret), 'utf8');
    try { if (bytes.length > 2500) throw Error('This sign-in is too long to save.'); if (await this.call(this.load().put, [target, bytes, bytes.length]) !== 1) throw Error('The operating system could not save this password.'); }
    finally { bytes.fill(0); }
  }
  async fill(target: string, window: Buffer, consume: (secret: PasswordSecret) => Promise<void>) {
    const bytes = Buffer.alloc(4096);
    let secret: PasswordSecret | undefined;
    try {
      const size = await this.call(this.load().read, [target, window, bytes, bytes.length]);
      if (size === -2) throw Error('Password access was canceled or could not be verified.');
      if (size <= 0 || size > bytes.length) throw Error('The saved password is unavailable. Save it again.');
      try { secret = JSON.parse(bytes.subarray(0,size).toString('utf8')); } catch { throw Error('The saved password is unavailable. Save it again.'); }
      if (!secret || typeof secret.username !== 'string' || typeof secret.password !== 'string' || !secret.password || secret.password.length > 1024) throw Error('The saved password is unavailable. Save it again.');
      await consume(secret);
    } finally { bytes.fill(0); if (secret) { secret.username = ''; secret.password = ''; } }
  }
  async remove(target: string) { if (await this.call(this.load().remove, [target]) !== 1) throw Error('The operating system could not remove this password.'); }
}
