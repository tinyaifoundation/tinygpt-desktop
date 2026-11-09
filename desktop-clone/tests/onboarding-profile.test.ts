import { expect, it, vi } from 'vitest';
import { saveWelcomeProfile } from '../src/renderer/lib/onboarding-profile';

const personal = { name: 'Personal', handle: '', avatar: '' };
it('skips blank names without opting into memory or erasing an existing profile', async () => {
  const saveProfileName = vi.fn();
  expect(await saveWelcomeProfile({ saveProfileName }, personal, '  ')).toBe(personal);
  const existing = { name: 'Alex Smith', firstName: 'Alex', lastName: 'Smith', handle: 'alex', avatar: '' };
  expect(await saveWelcomeProfile({ saveProfileName }, existing, '')).toBe(existing);
  expect(await saveWelcomeProfile({ saveProfileName }, existing, ' Alex ')).toBe(existing);
  expect(saveProfileName).not.toHaveBeenCalled();
});
it('saves the optional first name through the existing profile-memory service and preserves other fields', async () => {
  const saveProfileName = vi.fn(async () => ({ ok: true as const, value: {} as any }));
  const existing = { name: 'Alex Smith', firstName: 'Alex', lastName: 'Smith', handle: 'alex', avatar: '' };
  const saved = await saveWelcomeProfile({ saveProfileName }, existing, ' Jamie ');
  expect(saveProfileName).toHaveBeenCalledWith({ firstName: 'Jamie', lastName: 'Smith' });
  expect(saved).toEqual({ ...existing, name: 'Jamie Smith', firstName: 'Jamie' });
  expect(existing.firstName).toBe('Alex');
});
it('does not report a profile change when the memory write fails or validation fails', async () => {
  const saveProfileName = vi.fn(async () => ({ ok: false as const, error: 'The name could not be saved.' }));
  await expect(saveWelcomeProfile({ saveProfileName }, personal, 'Alex')).rejects.toThrow('could not be saved');
  await expect(saveWelcomeProfile({ saveProfileName }, personal, 'A'.repeat(61))).rejects.toThrow();
  expect(saveProfileName).toHaveBeenCalledTimes(1);
  expect(personal.name).toBe('Personal');
});
