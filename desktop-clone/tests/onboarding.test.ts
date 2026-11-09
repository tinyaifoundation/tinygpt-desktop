import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OnboardingStore } from '../src/main/onboarding';
const folders: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'tinygpt-welcome-')); folders.push(path); return path; }
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('resumes new-user progress and remembers skipping and completion across restarts', async () => {
  const path = await directory(), first = new OnboardingStore(path); await first.load(true);
  expect(first.snapshot()).toMatchObject({ step: 0, status: 'in-progress' });
  await first.save({ version: 1, step: 2, status: 'in-progress' });
  const resumed = new OnboardingStore(path); await resumed.load(false); expect(resumed.snapshot().step).toBe(2);
  for (const status of ['skipped', 'completed'] as const) {
    await resumed.save({ version: 1, step: 3, status });
    const reopened = new OnboardingStore(path); await reopened.load(false); expect(reopened.snapshot().status).toBe(status);
  }
});
it('preserves existing profiles and allows an explicit welcome replay', async () => {
  const path = await directory(), store = new OnboardingStore(path);
  await writeFile(join(path, 'settings.json'), 'EXISTING_SETTINGS_CANARY');
  await store.load(false); expect(store.snapshot().status).toBe('completed');
  await store.save({ version: 1, step: 0, status: 'in-progress' });
  expect(await readFile(join(path, 'settings.json'), 'utf8')).toBe('EXISTING_SETTINGS_CANARY');
});
it('rejects untrusted state and preserves corrupt progress instead of silently replacing it', async () => {
  const path = await directory(), store = new OnboardingStore(path); await store.load(true);
  expect(() => store.save({ version: 1, step: 4, status: 'completed' })).toThrow();
  await writeFile(join(path, 'onboarding.json'), 'INVALID_CANARY');
  await expect(new OnboardingStore(path).load(false)).rejects.toThrow('preserved');
  expect(await readFile(join(path, 'onboarding.json'), 'utf8')).toBe('INVALID_CANARY');
});
