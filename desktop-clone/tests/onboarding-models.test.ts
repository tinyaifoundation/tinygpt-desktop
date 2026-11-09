import { expect, it, vi } from 'vitest';
import { startWelcomePro } from '../src/renderer/lib/onboarding-models';
import { builtInModels } from '../src/shared/managed-local';
import { defaultSettings } from '../src/shared/config';
import type { AppSnapshot } from '../src/shared/contracts';

const snapshot = (route: 'local' | 'byok', model: string) => ({ settings: { ...structuredClone(defaultSettings), route, local: { ...defaultSettings.local, model } } }) as AppSnapshot;
it('restores included inference after an optional Pro download fails or is canceled', async () => {
  const included = snapshot('local', builtInModels.included.id), update = vi.fn();
  const startBuiltInModel = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Setup canceled.' }).mockResolvedValueOnce({ ok: true, value: included });
  await expect(startWelcomePro({ startBuiltInModel, snapshot: vi.fn(async () => ({ ok: true as const, value: included })) }, update)).rejects.toThrow('Setup canceled.');
  expect(startBuiltInModel.mock.calls).toEqual([['pro'], ['included']]);
  expect(update).toHaveBeenCalledWith(included);
});
it('preserves a cloud selection made while Pro was downloading', async () => {
  const startBuiltInModel = vi.fn(async () => ({ ok: false as const, error: 'Network unavailable.' })), update = vi.fn();
  await expect(startWelcomePro({ startBuiltInModel, snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot('byok', builtInModels.included.id) })) }, update)).rejects.toThrow('Network unavailable.');
  expect(startBuiltInModel).toHaveBeenCalledTimes(1); expect(update).not.toHaveBeenCalled();
});
it('does not start the included model after successful Pro setup', async () => {
  const pro = snapshot('local', builtInModels.pro.id), update = vi.fn(), read = vi.fn();
  const startBuiltInModel = vi.fn(async () => ({ ok: true as const, value: pro }));
  await startWelcomePro({ startBuiltInModel, snapshot: read }, update);
  expect(startBuiltInModel).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled(); expect(update).toHaveBeenCalledWith(pro);
});
