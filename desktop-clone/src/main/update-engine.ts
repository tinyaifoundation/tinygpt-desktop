import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { UPDATE_FEED } from '../shared/updates';
import type { UpdateEngine } from './app-updates';

export async function signedUpdateEngine(resources: string): Promise<UpdateEngine | undefined> {
  try {
    const config = parse(await readFile(join(resources, 'app-update.yml'), 'utf8'));
    const names = typeof config.publisherName === 'string' ? [config.publisherName] : config.publisherName;
    // electron-updater otherwise accepts unsigned updates when publisherName is absent.
    if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !name.trim())) return;
    const { NsisUpdater } = await import('electron-updater');
    const updater = new NsisUpdater({ provider: 'generic', url: UPDATE_FEED, useMultipleRangeRequest: false, channel: 'prebeta' });
    // No per-installation identifier is needed for this single pre-beta channel.
    updater.requestHeaders = { 'x-user-staging-id': '' };
    updater.logger = { info() {}, warn() {}, error() {} };
    return updater;
  } catch { return; }
}
