import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundledDictationModel } from '../src/main/dictation-model';
import { dictationModel } from '../src/shared/dictation';

const folders: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
it('never downloads a model at runtime, including when the bundled resources are absent', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tinygpt-dictation-model-')); folders.push(folder);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(bundledDictationModel(folder)).rejects.toThrow('bundled dictation model is missing');
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects a model prepared from a different revision or an incomplete bundled file', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tinygpt-dictation-model-')); folders.push(folder);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await writeFile(join(folder, 'model-prepared.json'), JSON.stringify({ ...dictationModel, revision: 'different' }));
  await expect(bundledDictationModel(folder)).rejects.toThrow('incomplete');
  await writeFile(join(folder, 'model-prepared.json'), JSON.stringify(dictationModel));
  await mkdir(join(folder, 'models'));
  await writeFile(join(folder, 'models', dictationModel.file), 'truncated');
  await expect(bundledDictationModel(folder)).rejects.toThrow('incomplete');
  expect(fetch).not.toHaveBeenCalled();
});
