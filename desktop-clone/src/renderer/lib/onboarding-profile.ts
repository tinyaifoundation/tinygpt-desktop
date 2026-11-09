import type { DesktopBridge } from '../../shared/contracts';
import { profileNames, profileSchema, type Profile } from './appearance';

/** An empty optional field skips this choice; removal stays in Profile settings. */
export async function saveWelcomeProfile(bridge: Pick<DesktopBridge, 'saveProfileName'>, profile: Profile, firstName: string): Promise<Profile> {
  const name = firstName.trim(), previous = profileNames(profile);
  if (!name || name === previous.firstName) return profile;
  const next = profileSchema.parse({ ...profile, firstName: name, lastName: previous.lastName, name: [name, previous.lastName].filter(Boolean).join(' ') });
  const result = await bridge.saveProfileName({ firstName: name, lastName: previous.lastName });
  if (!result.ok) throw new Error(result.error);
  return next;
}
