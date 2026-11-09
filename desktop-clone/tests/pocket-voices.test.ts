import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { PocketTTS } from '../src/main/pocket-tts';
const folders: string[] = [];
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });
it('preserves existing user voice files without exposing the removed exporter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pocket-voices-')); folders.push(root);
  const profile = join(root, 'profile'), folder = join(profile, 'pocket-voices'); await mkdir(folder, { recursive: true });
  const voice = { id: '2a141997-129f-4d11-bc78-8235f1562123', name: 'Existing voice', createdAt: '2026-11-01T00:00:00.000Z' };
  await writeFile(join(folder, voice.id+'.json'), JSON.stringify(voice)); await writeFile(join(folder, voice.id+'.safetensors'), 'existing original');
  const local = new PocketTTS(join(root, 'runtime'), profile);
  expect(await local.listVoices()).toEqual([voice]);
  expect(local).not.toHaveProperty('createVoice'); expect(local).not.toHaveProperty('prepareCloning');
  local.close(); expect(await readFile(join(folder, voice.id+'.safetensors'), 'utf8')).toBe('existing original');
});
