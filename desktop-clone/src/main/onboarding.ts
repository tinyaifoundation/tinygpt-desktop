import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { onboardingSchema, readOnboardingState, type OnboardingState } from '../shared/onboarding';

/** Kept outside settings so old app versions can still read the same profile. */
export class OnboardingStore {
  private state: OnboardingState = { version: 2, step: 0, status: 'completed' };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  async load(firstLaunch: boolean) {
    try { this.state = readOnboardingState(JSON.parse(await readFile(join(this.directory, 'onboarding.json'), 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Your welcome progress could not be read. Your files have been preserved.');
      await this.save({ version: 2, step: 0, status: firstLaunch ? 'in-progress' : 'completed' });
    }
  }
  snapshot(): OnboardingState { return { ...this.state }; }
  save(input: OnboardingState): Promise<void> {
    const next = onboardingSchema.parse(input);
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `onboarding.${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, join(this.directory, 'onboarding.json'));
      this.state = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
