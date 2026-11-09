import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import key from '../shared/update-key.json';
import { updatePublicKey } from './update-auth';
import { AuthenticatedUpdateProvider } from './update-provider';
import type { UpdateEngine } from './app-updates';

export async function releaseUpdateEngine(resources: string): Promise<UpdateEngine | undefined> {
  try {
    const config = parse(await readFile(join(resources, 'app-update.yml'), 'utf8'));
    const names = typeof config.publisherName === 'string' ? [config.publisherName] : config.publisherName;
    // All builds require the pinned release key. Configured Windows publishers add Authenticode verification.
    updatePublicKey(key.publicKey);
    if (names !== undefined && (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name.trim()))) return;
    const { NsisUpdater } = await import('electron-updater');
    const updater = new NsisUpdater({ provider: 'custom', updateProvider: AuthenticatedUpdateProvider });
    // No per-installation identifier is needed for this single pre-beta channel.
    updater.requestHeaders = { 'x-user-staging-id': '' };
    updater.logger = { info() {}, warn() {}, error() {} };
    return updater;
  } catch { return; }
}
