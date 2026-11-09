import type { UpdateInfo } from 'builder-util-runtime';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import type { AppUpdater } from 'electron-updater';
import { UPDATE_FEED } from '../shared/updates';
import key from '../shared/update-key.json';
import { verifyReleaseEnvelope } from './update-auth';

/** Authenticate the complete metadata before electron-updater sees artifact hashes/URLs. */
export class AuthenticatedUpdateProvider extends GenericProvider {
  constructor(_options: unknown, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
    super({ provider: 'generic', url: UPDATE_FEED, channel: 'prebeta', useMultipleRangeRequest: false }, updater, { ...runtime, isUseMultipleRangeRequest: false });
  }
  override async getLatestVersion(): Promise<UpdateInfo> {
    const text = await this.httpRequest(new URL('prebeta.json', UPDATE_FEED));
    if (!text) throw Error('No authenticated TinyGPT update feed is available.');
    return verifyReleaseEnvelope(text, key.publicKey);
  }
}
